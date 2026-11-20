import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  The concept detail screen: which version is shown, the pins and their
  Not sent / Sending / Sent tags, the placeholders still needed, and when
  Request changes can and cannot be used.
*/

const state: { user: unknown } = { user: null };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/projects",
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("@/lib/session", () => ({ requireUser: async () => state.user }));
vi.mock("@/app/actions", () => {
  const f = async () => ({ ok: true });
  return new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : f), has: () => true });
});

import { eq } from "drizzle-orm";
import { setDbForTesting, type Database } from "@tawd/core/db";
import {
  aiCall,
  concept,
  conceptChangeRequest,
  conceptComment,
  conceptVersion,
  mockupRun,
  project as projectTable,
} from "@tawd/core/schema";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import ConceptPage from "@/app/(app)/projects/[id]/mockups/[conceptId]/page";
import { loadConceptDetail } from "@/lib/concept-detail";
import { createProject } from "@/lib/projects";
import { setMonthlyLimit } from "@/lib/spend";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

let h: Harness;
let r2: FakeR2;

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  r2 = new FakeR2();
  setStorageForTesting(r2);
});

afterEach(async () => {
  setDbForTesting(null);
  setStorageForTesting(null);
  await h.close();
});

const review = (pass: string, average: number) => ({
  pass,
  average,
  lowest: Math.floor(average),
  questions: [{ question: 1, title: "5-second test", score: Math.round(average), notApplicable: false, reason: `Scored ${average}`, notes: [] }],
  summary: "",
  safetyAdvice: [],
  earlierNotes: [],
  reviewedAt: "",
});

async function seed() {
  const admin = await seedAdmin(h);
  state.user = admin.viewer;
  const projectId = await createProject(h.ctx, admin.viewer, {
    clientName: "Test Plumbing",
    trade: "plumbing",
    tier: "growth",
    lane: "lane_1",
    laneOption: null,
    conceptCount: 1,
    status: "intake",
    memberUserIds: [],
  });
  await h.db.update(projectTable).set({ status: "mockups" }).where(eq(projectTable.id, projectId));
  const [run] = await h.db
    .insert(mockupRun)
    .values({ projectId, conceptCount: 1, status: "succeeded", model: "m", startedByUserId: admin.viewer.id })
    .returning();
  const [row] = await h.db
    .insert(concept)
    .values({ runId: run!.id, projectId, label: "B", direction: "modern_clean", skillId: "impeccable", status: "ready" })
    .returning();
  const conceptId = row!.id;
  for (const [version, stage, avg] of [[1, "build", 4.1], [2, "cd_improve", 4.7]] as const) {
    const base = `projects/${projectId}/concepts/${conceptId}/v${version}`;
    await h.db.insert(conceptVersion).values({
      conceptId,
      version,
      htmlKey: `${base}/page.html`,
      pngKey: `${base}/full.png`,
      placeholderCount: 2,
      checks: { passed: true, issues: [{ id: "seo.description.long", severity: "warn", message: "Description is long." }], stage },
      review: { passes: [review(version === 1 ? "first" : "after", avg)] },
    });
    await r2.put(
      `${base}/source.html`,
      Buffer.from("<p>[PLACEHOLDER: CA license number]</p><p>[PLACEHOLDER: Google rating]</p><p>[PLACEHOLDER: Google rating]</p>"),
    );
  }
  return { admin, projectId, conceptId, runId: run!.id };
}

describe("the concept detail", () => {
  it("shows the newest version by default, scored before and after, with its placeholders", async () => {
    const { admin, projectId, conceptId } = await seed();
    const detail = (await loadConceptDetail(h.db, admin.viewer, projectId, conceptId, {}))!;

    expect(detail.selected.label).toBe("v2, after review");
    expect(detail.versions.map((v) => v.label)).toEqual(["v2, after review", "v1, as built"]);
    expect(detail.review.before!.average).toBe(4.1);
    expect(detail.review.after!.average).toBe(4.7);
    expect(detail.placeholders).toEqual(["CA license number", "Google rating"]);
    expect(detail.changesBlocked).toBeNull();
  });

  it("looks at an earlier version, and compares two", async () => {
    const { admin, projectId, conceptId } = await seed();
    const detail = (await loadConceptDetail(h.db, admin.viewer, projectId, conceptId, { version: 1, compare: 2 }))!;
    expect(detail.selected.version).toBe(1);
    expect(detail.compare!.version).toBe(2);
    // On v1, the "after" score is v1's own.
    expect(detail.review.after!.average).toBe(4.1);
  });

  it("numbers comments, and tags them Not sent, Sending in vN or Sent in vN", async () => {
    const { admin, projectId, conceptId } = await seed();
    const [request] = await h.db
      .insert(conceptChangeRequest)
      .values({ projectId, conceptId, source: "team", notes: "x", requestedByUserId: admin.viewer.id, baseVersion: 2, status: "queued" })
      .returning();
    await h.db.insert(conceptComment).values([
      { projectId, conceptId, version: 1, authorUserId: admin.viewer.id, body: "Old", sentInVersion: 2 },
      { projectId, conceptId, version: 2, authorUserId: admin.viewer.id, body: "Going now", pinX: 10, pinY: 10, changeRequestId: request!.id },
      { projectId, conceptId, version: 2, authorUserId: admin.viewer.id, body: "Fresh", pinX: 50, pinY: 50 },
    ]);

    const detail = (await loadConceptDetail(h.db, admin.viewer, projectId, conceptId, {}))!;
    expect(detail.comments.map((c) => [c.number, c.body, c.tag.kind, c.tag.version])).toEqual([
      [1, "Old", "sent", 2],
      [2, "Going now", "sending", 3],
      [3, "Fresh", "not_sent", null],
    ]);
    // A version is being made, so Request changes waits.
    expect(detail.changesBlocked).toMatch(/v3 is being made/);
    expect(detail.pending!.nextVersion).toBe(3);
  });

  it("blocks Request changes at the monthly limit, and hides it from people who cannot use it", async () => {
    const { admin, projectId, conceptId, runId } = await seed();
    await setMonthlyLimit(h.ctx, admin.viewer, 1);
    await h.db.insert(aiCall).values({ projectId, runId, conceptId, step: "build", model: "claude-opus-5-5", inputTokens: 0, outputTokens: 50_000 });
    const detail = (await loadConceptDetail(h.db, admin.viewer, projectId, conceptId, {}))!;
    expect(detail.changesBlocked).toMatch(/Spend page/);

    const seo = await seedUser(h, admin.viewer, { email: "seo@velocitymedialab.com", roles: ["seo"] });
    const forSeo = (await loadConceptDetail(h.db, seo.viewer, projectId, conceptId, {}))!;
    expect(forSeo.canAct).toBe(false);
  });

  it("is not found from another project's address", async () => {
    const { admin, conceptId } = await seed();
    expect(
      await loadConceptDetail(h.db, admin.viewer, "00000000-0000-0000-0000-000000000000", conceptId, {}),
    ).toBeNull();
  });
});

describe("the concept page", () => {
  const render = async (projectId: string, conceptId: string, query: Record<string, string> = {}) =>
    renderToStaticMarkup(
      (await ConceptPage({ params: Promise.resolve({ id: projectId, conceptId }), searchParams: Promise.resolve(query) })) as React.ReactElement,
    );

  /*
    F33, and Jason's run of 10 November 2026: the review said "4 of 8
    earlier notes and requests were addressed" and named none of the four
    it had not made, so the team had to read eight notes against the page
    to find them - while the Creative Director's own reason for each was
    already stored on the version, unread.
  */
  it("names the earlier notes that were not done, with the reviewer's reason", async () => {
    const { projectId, conceptId } = await seed();
    const [newest] = await h.db
      .select()
      .from(conceptVersion)
      .where(eq(conceptVersion.conceptId, conceptId))
      .then((rows) => rows.filter((r) => r.version === 2));
    const stored = (newest!.review as { passes: Record<string, unknown>[] }).passes;
    await h.db
      .update(conceptVersion)
      .set({
        review: {
          passes: stored.map((pass) => ({
            ...pass,
            earlierNotes: [
              { ref: "Comment 1", note: "Tighten the headline", addressed: true },
              { ref: "Comment 2", note: "Move the phone number into the hero", addressed: false, reason: "The hero has no room for it at this size." },
              { ref: "Polish", note: "Set the step titles in the heading colour", addressed: false },
            ],
          })),
        },
      })
      .where(eq(conceptVersion.id, newest!.id));

    const html = await render(projectId, conceptId, { tab: "review" });
    expect(html).toContain("1 of 3 earlier");
    expect(html).toContain("Not done in this version");
    expect(html).toContain("Move the phone number into the hero");
    expect(html).toContain("The hero has no room for it at this size.");
    expect(html).toContain("Set the step titles in the heading colour");
    // The one that WAS done is not listed as outstanding.
    expect(html.split("Not done in this version")[1]).not.toContain("Tighten the headline");

    /*
      CodeRabbit on PR #75 (12 November 2026): when a newer version was
      made but never scored (a polish whose scoring failed), the tab shows
      the last score there was - and must say which version that score and
      its notes are about, not "this version".
    */
    await h.db.insert(conceptVersion).values({
      conceptId,
      version: 3,
      htmlKey: `projects/${projectId}/concepts/${conceptId}/v3/page.html`,
      pngKey: `projects/${projectId}/concepts/${conceptId}/v3/full.png`,
      checks: { passed: true, issues: [], stage: "polish" },
    });
    const unscored = await render(projectId, conceptId, { tab: "review" });
    expect(unscored).not.toContain("Not done in this version");
    expect(unscored).toContain("Not done in v2");
    expect(unscored).toContain("This score and its notes are for v2; v3 has not been scored.");
  });

  it("opens on the team comments, with the pins and the note that comments stay with the team", async () => {
    const { admin, projectId, conceptId } = await seed();
    await h.db.insert(conceptComment).values({ projectId, conceptId, version: 2, authorUserId: admin.viewer.id, body: "Tighten the headline", pinX: 12, pinY: 7 });
    const html = await render(projectId, conceptId);
    expect(html).toContain("Concept B: Modern Clean");
    expect(html).toContain("Team comments (1)");
    expect(html).toContain("Comments stay with the team.");
    expect(html).toContain("1 pin");
    expect(html).toContain("left:12%;top:7%");
    expect(html).toContain("Not sent");
    expect(html).toContain("Request changes");
  });

  it("opens a tab or Request changes from the link", async () => {
    const { projectId, conceptId } = await seed();
    expect(await render(projectId, conceptId, { tab: "review" })).toContain("Creative Director review");
    const checks = await render(projectId, conceptId, { tab: "checks" });
    expect(checks).toContain("2 placeholders still needed");
    expect(checks).toContain("Description is long.");
    expect(await render(projectId, conceptId, { tab: "versions" })).toContain("Compare with v2");
    expect(await render(projectId, conceptId, { request: "1" })).toContain("Create v3");
  });

  it("treats a malformed id as not found", async () => {
    const { projectId } = await seed();
    await expect(render(projectId, "not-an-id")).rejects.toThrow("notFound");
  });
});
