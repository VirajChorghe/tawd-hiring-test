import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setDbForTesting, type Database } from "@tawd/core/db";
import { concept, conceptComment, conceptVersion, mockupRun, project as projectTable } from "@tawd/core/schema";
import { commentsCsv, loadCommentRows } from "@/lib/comments-export";
import { createProject } from "@/lib/projects";

import { createHarness, seedAdmin, type Harness } from "./harness";

/*
  Comments and fixes (8 October 2026, run notes #24): every team comment on
  a concept, its section, and whether it was done and why, as a CSV.
*/

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
});

afterEach(async () => {
  setDbForTesting(null);
  await h.close();
});

describe("the Comments and fixes export", () => {
  it("lists each comment with its project, concept, section and outcome", async () => {
    const admin = await seedAdmin(h);
    const projectId = await createProject(h.ctx, admin.viewer, { clientName: "Sample Plumbing Co.", trade: "plumbing", tier: "growth", lane: "lane_1", laneOption: null, conceptCount: 1, status: "intake", memberUserIds: [] });
    await h.db.update(projectTable).set({ status: "mockups" }).where(eq(projectTable.id, projectId));
    const [run] = await h.db.insert(mockupRun).values({ projectId, conceptCount: 1, status: "succeeded", model: "claude-opus-5-5", startedByUserId: admin.viewer.id }).returning();
    const [c] = await h.db.insert(concept).values({ runId: run!.id, projectId, label: "A", direction: "modern_clean", skillId: "impeccable", status: "ready" }).returning();
    await h.db.insert(conceptVersion).values({
      conceptId: c!.id,
      version: 2,
      checks: { imageHeightPx: 2000, bands: [{ top: 0, bottom: 800, label: "Hero" }, { top: 800, bottom: 1600, label: "Services" }] },
    } as never);
    await h.db.insert(conceptComment).values([
      { projectId, conceptId: c!.id, version: 2, authorUserId: admin.viewer.id, body: "Two buttons, not three", pinX: 0.5, pinY: 0.2, band: 0, sentInVersion: 2, outcome: "done", outcomeVersion: 3, outcomeReason: "The hero has two buttons now." },
      { projectId, conceptId: c!.id, version: 2, authorUserId: admin.viewer.id, body: "=SUM(1) no drawn map", outcome: null },
    ]);

    const rows = await loadCommentRows(h.db as Database);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ project: "Sample Plumbing Co.", concept: "A", version: 2, section: "Hero", outcome: "Done", outcomeReason: "The hero has two buttons now.", reply: false });
    expect(rows[1]).toMatchObject({ section: "General", outcome: "Not sent" });

    const csv = commentsCsv(rows, () => "Oct 8");
    expect(csv.split("\r\n")[0]).toBe("Project,Test project,Concept,Direction,On version,Section,Reply,By,Comment,Sent in version,Done or not,Why,Resolved,When");
    expect(csv).toContain("Done,The hero has two buttons now.");
    // A spreadsheet never runs a comment as a formula.
    expect(csv).toContain("'=SUM(1) no drawn map");
  });
});
