import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { concept, conceptVersion, mockupRun, loginAttempt } from "@tawd/core/schema";
import { saveIntakeSection } from "@tawd/core/intake/service";
import manifest from "@/app/manifest";
import { APP_TITLE, brandIcons } from "@/lib/brand";
import {
  describeLastActivity,
  formatActivityWhen,
  listProjectOverview,
  needsAttention,
} from "@/lib/project-overview";
import { createProject } from "@/lib/projects";
import { GENERIC_FAILURE, LOCKED_MESSAGE, MAX_FAILED_ATTEMPTS, signIn } from "@/lib/sign-in";
import { signInSchema } from "@/lib/validation";
import { createHarness, seedAdmin, type Harness } from "./harness";

/*
  The brand, the new Sign in rules, and what the Projects page works out.
*/

const publicDir = path.join(__dirname, "..", "..", "public");

describe("the brand files", () => {
  it("serves every icon the page and the manifest point at", () => {
    const icons = brandIcons as {
      icon: { url: string }[];
      apple: { url: string };
    };
    const urls = [
      ...icons.icon.map((i) => i.url),
      icons.apple.url,
      ...manifest().icons!.map((i) => i.src),
      "/brand/tawd-logo-compact.svg",
      "/brand/tawd-logo-dark-bg.svg",
    ];
    for (const url of urls) {
      expect(fs.existsSync(path.join(publicDir, url)), url).toBe(true);
    }
  });

  it("uses the new name", () => {
    expect(APP_TITLE).toBe("TAWD - Total Agentic Web Developer");
    expect(manifest()).toMatchObject({
      name: "TAWD - Total Agentic Web Developer",
      short_name: "TAWD",
    });
    const readme = fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "README.md"), "utf8");
    expect(readme).toContain("Total Agentic Web Developer");
    expect(readme).not.toContain("Todd's AI Web Dev");
  });

  it("keeps anything but the served files out of public", () => {
    expect(fs.existsSync(path.join(publicDir, "brand", "README.md"))).toBe(false);
  });
});

describe("what needs attention", () => {
  const run = (status: string, failing = 0, pm = 0) => ({
    status,
    conceptsFailingChecks: failing,
    conceptsNeedingPmReview: pm,
  });

  it.each([
    [{ status: "intake", missingRequired: 3, latestRun: null }, "warn", "3 required items missing"],
    [{ status: "intake", missingRequired: 1, latestRun: null }, "warn", "1 required item missing"],
    [{ status: "intake", missingRequired: 0, latestRun: null }, "go", "Ready for Design"],
    [{ status: "mockups", missingRequired: 0, latestRun: null }, "go", "Ready to generate concepts"],
    [{ status: "mockups", missingRequired: 0, latestRun: run("running") }, "go", "Generating concepts"],
    [{ status: "mockups", missingRequired: 0, latestRun: run("queued") }, "go", "Generating concepts"],
    [{ status: "mockups", missingRequired: 0, latestRun: run("checks_failed", 1) }, "warn", "Checks failed on 1 concept"],
    [{ status: "mockups", missingRequired: 0, latestRun: run("checks_failed", 2) }, "warn", "Checks failed on 2 concepts"],
    [{ status: "mockups", missingRequired: 0, latestRun: run("needs_pm_review", 0, 1) }, "warn", "Needs PM review"],
    [{ status: "mockups", missingRequired: 0, latestRun: run("needs_intake") }, "warn", "Needs intake info"],
    [{ status: "mockups", missingRequired: 0, latestRun: run("review_incomplete") }, "warn", "Creative Director review didn't finish"],
    [{ status: "mockups", missingRequired: 0, latestRun: run("failed") }, "warn", "Last run failed"],
    [{ status: "mockups", missingRequired: 0, latestRun: run("succeeded") }, "go", "Ready to send to client"],
    [{ status: "content", missingRequired: 0, latestRun: run("succeeded") }, "none", ""],
  ] as const)("%o is %s: %s", (input, tone, text) => {
    expect(needsAttention(input as Parameters<typeof needsAttention>[0])).toEqual({ tone, text });
  });
});

describe("the last-activity line", () => {
  it.each([
    [{ action: "mockups.run_started", actorName: "Jason Braganza", valueAfter: { concepts: [{}] } }, "Jason ran 1 concept"],
    [{ action: "mockups.run_started", actorName: "Priya", valueAfter: { concepts: [{}, {}] } }, "Priya ran 2 concepts"],
    [{ action: "mockups.review_finished", actorName: null, valueAfter: {} }, "Creative Director review done"],
    [{ action: "project.created", actorName: null, valueAfter: {} }, "Created the project"],
    [{ action: "project.status_changed", actorName: "Jason", valueAfter: { status: "mockups" } }, "Moved to Design"],
    [{ action: "intake.updated", actorName: "Jason Braganza", valueAfter: {} }, "Jason updated the intake"],
    [{ action: "mockups.concept_built", actorName: null, valueAfter: { concept: "B" } }, "Concept B built"],
  ])("%o reads %s", (entry, text) => {
    expect(describeLastActivity(entry)).toBe(text);
  });

  it("says when in Pacific time: today with the time, yesterday, a date, a year when needed", () => {
    const now = new Date("2026-09-24T22:00:00Z"); // 3pm in Los Angeles
    expect(formatActivityWhen(new Date("2026-09-24T19:10:00Z"), now)).toBe("Today, 12:10 PM PT");
    // 11pm the night before, Pacific, though already the 24th in UTC.
    expect(formatActivityWhen(new Date("2026-09-24T06:00:00Z"), now)).toBe("Yesterday");
    expect(formatActivityWhen(new Date("2026-09-22T18:00:00Z"), now)).toBe("Sep 22");
    expect(formatActivityWhen(new Date("2025-12-01T18:00:00Z"), now)).toBe("Dec 1, 2025");
  });
});

describe("signing in", () => {
  it("only takes velocitymedialab.com addresses, and says so", () => {
    const outside = signInSchema.safeParse({ email: "someone@gmail.com", password: "x" });
    expect(outside.success).toBe(false);
    expect(outside.error?.issues[0]?.message).toBe("Use your velocitymedialab.com address");
    expect(signInSchema.safeParse({ email: " Owner@VelocityMediaLab.com ", password: "x" }).success).toBe(true);
  });

  it("words the failure and the lockout as the design does", () => {
    expect(GENERIC_FAILURE).toBe(
      "Email or password is incorrect. After 5 tries, sign-in pauses for 15 minutes.",
    );
    expect(MAX_FAILED_ATTEMPTS).toBe(5);
    expect(LOCKED_MESSAGE).toMatch(/paused for 15 minutes/);
  });
});

/* ---------- with the database ---------- */

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.close();
});

describe("signing in, for real", () => {
  it("still pauses sign-in after five failures", async () => {
    await seedAdmin(h);
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      const result = await signIn(h.ctx, new Headers(), "admin@velocitymedialab.com", "wrong");
      expect(result).toEqual({ ok: false, message: GENERIC_FAILURE });
    }
    const locked = await signIn(h.ctx, new Headers(), "admin@velocitymedialab.com", "wrong");
    expect(locked).toEqual({ ok: false, message: LOCKED_MESSAGE });
    expect((await h.db.select().from(loginAttempt)).length).toBe(MAX_FAILED_ATTEMPTS);
  });

  it("still sends a temporary password to the forced change", async () => {
    const admin = await seedAdmin(h);
    const result = await signIn(h.ctx, new Headers(), "admin@velocitymedialab.com", admin.temporaryPassword);
    expect(result).toEqual({ ok: true, redirectTo: "/change-password" });
  });
});

describe("the Projects page's rows", () => {
  const base = {
    tier: "starter" as const,
    lane: "lane_1" as const,
    laneOption: null,
    conceptCount: 1,
    memberUserIds: [] as string[],
  };

  it("works out attention and the last activity from real state", async () => {
    const admin = await seedAdmin(h);

    const intakeId = await createProject(h.ctx, admin.viewer, {
      ...base,
      clientName: "Sample Law Office",
      trade: "legal",
      status: "intake",
      memberUserIds: [admin.viewer.id],
    });
    await saveIntakeSection(h.ctx, admin.viewer, intakeId, "business", { name: "Law Office" });

    const mockupsId = await createProject(h.ctx, admin.viewer, {
      ...base,
      clientName: "Dale Rowan",
      trade: "well_and_pump",
      status: "mockups",
    });
    const [run] = await h.db
      .insert(mockupRun)
      .values({ projectId: mockupsId, conceptCount: 2, status: "checks_failed", model: "m" })
      .returning();
    for (const [label, passed] of [["A", false], ["B", true]] as const) {
      const [c] = await h.db
        .insert(concept)
        .values({ runId: run!.id, projectId: mockupsId, label, direction: "rugged_craftsman", skillId: "impeccable", status: "ready" })
        .returning();
      await h.db.insert(conceptVersion).values([
        { conceptId: c!.id, version: 1, checks: { passed: true } },
        { conceptId: c!.id, version: 2, checks: { passed } },
      ]);
    }

    const rows = await listProjectOverview(h.db, admin.viewer, new Date());
    const law = rows.find((r) => r.id === intakeId)!;
    const pat = rows.find((r) => r.id === mockupsId)!;

    // Of the ten for a law firm (no license is asked of a legal practice; the
    // current website is one since 30 September 2026): the name is filled and
    // the trade is on the project.
    expect(law.attention).toEqual({ tone: "warn", text: "8 required items missing" });
    expect(law.lastActivity?.text).toBe("Test updated the intake");
    expect(law.members.map((m) => m.id)).toEqual([admin.viewer.id]);

    // Only the newest version counts: A still fails, B was fixed.
    expect(pat.attention).toEqual({ tone: "warn", text: "Checks failed on 1 concept" });
    expect(pat.lastActivity?.text).toBe("Test created the project");
    expect(pat.lastActivity?.when).toMatch(/^Today, /);
  });

  it("is empty with no projects", async () => {
    const admin = await seedAdmin(h);
    expect(await listProjectOverview(h.db, admin.viewer)).toEqual([]);
  });
});
