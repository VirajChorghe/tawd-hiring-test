import { describe, expect, it } from "vitest";

import {
  BEFORE_AFTER,
  analyzeDraft,
  buildDraftUserPrompt,
  healthContextFrom,
  healthFlags,
  isHealthProject,
  type DraftPromptInput,
} from "@tawd/core/content";
import { parseIntake } from "@tawd/core/intake";

/*
  Health and beauty rules (26 September 2026): no promised results, titles
  only as the client gives them, before-and-after photos only with a
  recorded permission, testimonials only when supplied. Flagged for the PM.
*/

const medSpa = parseIntake({
  business: { name: "Glow Med Spa", certifications: ["Board-certified dermatologist"] },
  services: { items: [{ id: "s1", name: "Botox", description: "Treatments by our nurse practitioner." }] },
});

describe("which projects the rules cover", () => {
  it("covers med spas by trade, and dental, medical and wellness businesses by their words", () => {
    expect(isHealthProject("med_spa", parseIntake({}))).toBe(true);
    expect(isHealthProject("other", parseIntake({ business: { name: "Bright Smile Dental" } }))).toBe(true);
    expect(isHealthProject("other", parseIntake({ services: { items: [{ id: "a", name: "IV therapy", description: "" }] } }))).toBe(true);
    expect(isHealthProject("plumbing", parseIntake({ business: { name: "Sac Drain Pros" } }))).toBe(false);
  });
});

describe("the flags", () => {
  const ctx = healthContextFrom(medSpa);

  it("flags promised results", () => {
    const flags = healthFlags("Guaranteed results. Pain-free and permanent results in one visit.", ctx);
    expect(flags[0]).toMatchObject({ key: "promise" });
    expect(flags[0]!.found).toMatch(/Guaranteed results/);
    expect(flags[0]!.found).toMatch(/Pain-free/);
  });

  it("allows titles the client gave, and flags ones they didn't", () => {
    expect(healthFlags("Our board-certified dermatologist and nurse practitioner see every patient.", ctx)).toEqual([]);
    expect(healthFlags("Our registered nurses and Dr. Lee see every patient.", ctx)).toEqual([
      expect.objectContaining({ key: "credential", found: "registered nurses, Dr." }),
    ]);
  });

  it("flags before-and-after without the recorded permission, and not with it", () => {
    expect(healthFlags("See our before-and-after gallery.", ctx).map((f) => f.key)).toEqual(["before_after"]);
    expect(healthFlags("See our before-and-after gallery.", { ...ctx, beforeAfterPermission: true })).toEqual([]);
  });

  it("flags testimonials the client didn't supply", () => {
    expect(healthFlags("## What our patients say", ctx).map((f) => f.key)).toEqual(["testimonial"]);
  });

  it("recognises before-and-after captions", () => {
    expect(BEFORE_AFTER.test("Before & after, lip filler")).toBe(true);
    expect(BEFORE_AFTER.test("before-after-2.jpg")).toBe(true);
    expect(BEFORE_AFTER.test("Our front desk")).toBe(false);
  });
});

describe("the writers and the draft checks", () => {
  it("tells the copywriter the rules for a health business only", () => {
    const base: DraftPromptInput = {
      clientName: "Glow Med Spa",
      tradeLabel: "med spa",
      page: { name: "Botox", kind: "service", mainKeyword: "", supportingKeywords: [], h1: "", title: "" },
      otherPages: [],
      facts: { known: "", required: "", detail: "" },
      services: [],
      serviceArea: null,
      tone: "",
      approvedConcept: null,
      suppliedCopy: null,
      designerNotes: "",
      redraftNote: null,
      previousDraft: null,
    };
    expect(buildDraftUserPrompt({ ...base, healthRules: true })).toContain("# Health and beauty rules");
    expect(buildDraftUserPrompt(base)).not.toContain("# Health and beauty rules");
  });

  it("adds a 'Health and beauty rules' check to the draft for the PM", () => {
    const page = { mainKeyword: "", supportingKeywords: [], title: "Botox", metaDescription: "Botox at Glow." };
    const flagged = analyzeDraft("# Botox\n\nGuaranteed results every time.\n", page, healthContextFrom(medSpa));
    expect(flagged.checks.find((c) => c.key === "health")).toMatchObject({ ok: false, detail: expect.stringMatching(/^For the PM: No promises of results: Guaranteed results/) });
    expect(analyzeDraft("# Botox\n\nWhat to expect at your visit.\n", page, healthContextFrom(medSpa)).checks.find((c) => c.key === "health")!.ok).toBe(true);
    expect(analyzeDraft("# Drains\n\nGuaranteed.\n", page).checks.find((c) => c.key === "health")).toBeUndefined();
  });
});

describe("before-and-after photos without the client's permission", () => {
  it("never reach a mockup or a build, and do once the permission is recorded", async () => {
    const path = await import("node:path");
    const { createHarness, seedAdmin } = await import("./harness");
    const { FakeR2, fakeBrowser } = await import("./worker-fakes");
    const { setDbForTesting } = await import("@tawd/core/db");
    const { intakeFile } = await import("@tawd/core/schema");
    const { saveIntakeSection } = await import("@tawd/core/intake/service");
    const { setStorageForTesting } = await import("@tawd/core/intake/storage");
    const { createProject } = await import("@/lib/projects");
    const { loadProjectContext } = await import("../../../worker/src/pipeline");
    const h = await createHarness();
    setDbForTesting(h.db as never);
    const r2 = new FakeR2();
    setStorageForTesting(r2);
    try {
      const admin = await seedAdmin(h);
      const projectId = await createProject(h.ctx, admin.viewer, { clientName: "Glow Med Spa", trade: "med_spa", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 1, status: "mockups", memberUserIds: [] });
      for (const [name, caption] of [["room.jpg", "Our treatment room"], ["lips.jpg", "Before and after, lip filler"]] as const) {
        await h.db.insert(intakeFile).values({ projectId, kind: "photo", storageKey: `projects/${projectId}/${name}`, fileName: name, contentType: "image/jpeg", status: "ready", caption });
        r2.objects.set(`projects/${projectId}/${name}`, Buffer.from("jpeg-bytes"));
      }
      const config = { databaseUrl: "unused", redisUrl: "unused", anthropicApiKey: "unused", model: "claude-opus-5-5", skillsDir: path.resolve(__dirname, "../../../../skills"), effort: "high" } as const;
      const captions = async () => (await loadProjectContext(h.db as never, r2 as never, fakeBrowser() as never, config as never, { projectId, runId: projectId })).assets.map((a) => a.caption);
      expect(await captions()).toEqual(["Our treatment room"]);
      await saveIntakeSection(h.ctx, admin.viewer, projectId, "photos", { beforeAfterPermission: true, beforeAfterPermissionNote: "Email from the owner" });
      expect(await captions()).toEqual(["Our treatment room", "Before and after, lip filler"]);
    } finally {
      setStorageForTesting(null);
      setDbForTesting(null);
      await h.close();
    }
  }, 60_000);
});
