import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  The project type (Jason, 6 October 2026, locked names; flow redesign
  Part B, 0.100.0): Design only / Design + content / Everything new / the
  client's own words. The type sets the steps: Design only has no wireframe
  and no Content step, its kept pages need no approval, and the client's
  pick takes it to Build. No network, no AI.
*/

vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }), usePathname: () => "/projects" }));

import { eq } from "drizzle-orm";
import { setDbForTesting, type Database } from "@tawd/core/db";
import { assessCompleteness, emptyIntake, parseIntake, projectTypeOf, PROJECT_TYPE_LABELS } from "@tawd/core/intake";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { draftWireframeFromSite, wireframeApplies } from "@tawd/core/mockups";
import { clientDecision, concept, conceptVersion, mockupRun, pageDraft, pagePlanPage, project as projectTable } from "@tawd/core/schema";
import { isKeptLineage, pageReadyForBuild, projectTypeFor } from "@tawd/core/site-read";
import { SectionBody } from "@/components/intake/section-body";
import { recordClientDecision } from "@/lib/concept-review";
import { currentStep, journeySteps, loadJourneyFacts, type JourneyFacts } from "@/lib/journey";
import { createProject } from "@/lib/projects";
import { typeChangeLine } from "@/lib/project-type-words";
import { siteReadiness } from "@/lib/site-builds";
import { lockedStage } from "@/lib/stages";
import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

describe("the project type, from the intake", () => {
  it("maps each content choice, with and without a current website, and Lane 2 has none", () => {
    const site = { lane: "lane_1", hasCurrentWebsite: true };
    expect(projectTypeOf({ ...site, mode: "keep" })).toBe("design_only");
    expect(projectTypeOf({ ...site, mode: "improve" })).toBe("design_content");
    expect(projectTypeOf({ ...site, mode: "auto" })).toBe("everything_new");
    expect(projectTypeOf({ ...site, mode: "manual" })).toBe("client_words");
    // A current website and no choice yet: the type is missing.
    expect(projectTypeOf({ ...site, mode: null })).toBeNull();
    // No current website: a blank choice means Everything new, as before; a kept choice with the site taken off too.
    expect(projectTypeOf({ lane: "lane_1", hasCurrentWebsite: false, mode: null })).toBe("everything_new");
    expect(projectTypeOf({ lane: "lane_1", hasCurrentWebsite: false, mode: "keep" })).toBe("everything_new");
    expect(projectTypeOf({ lane: "lane_2", hasCurrentWebsite: true, mode: "keep" })).toBeNull();
    expect(PROJECT_TYPE_LABELS.design_content).toBe("Design + content");
    expect(parseIntake({ content: { mode: "improve" } }).content.mode).toBe("improve");
  });

  it("is a blocking answer when there's a current website (Lane 1 only)", () => {
    const withSite = parseIntake({ website: { currentWebsiteUrl: "https://acme.example" } });
    const missing = (lane: string, intake = withSite) => assessCompleteness({ projectTrade: "plumbing", projectLane: lane, intake, files: [] }).missing.map((m) => m.key);
    expect(missing("lane_1")).toContain("content.projectType");
    expect(assessCompleteness({ projectTrade: "plumbing", projectLane: "lane_1", intake: withSite, files: [] }).requirements.find((r) => r.key === "content.projectType")?.blocking).toBe(true);
    expect(missing("lane_1", parseIntake({ website: { currentWebsiteUrl: "https://acme.example" }, content: { mode: "auto" } }))).not.toContain("content.projectType");
    expect(missing("lane_2")).not.toContain("content.projectType");
    expect(missing("lane_1", parseIntake({ website: { noCurrentWebsite: true } }))).not.toContain("content.projectType");
  });

  it("shows four choices with a current website, two without, and none on Lane 2", () => {
    const base = { section: "content", projectId: "p", onChange: () => {}, files: [], captions: {}, onCaptionChange: () => {}, completeness: { requirements: [], missing: [], isComplete: true, percent: 100, satisfiedCount: 1, totalCount: 1 }, tierWarning: null, canEdit: true, canChangeTier: true };
    const render = (extra: Record<string, unknown>) => renderToStaticMarkup(<SectionBody {...(Object.assign({}, base, { values: emptyIntake().content }, extra) as unknown as Parameters<typeof SectionBody>[0])} />);
    const withSite = render({ hasCurrentWebsite: true, lane: "lane_1" });
    for (const title of ["Design only", "Design + content", "Everything new", "The client is sending their own words"]) expect(withSite).toContain(title);
    const without = render({ hasCurrentWebsite: false, lane: "lane_1" });
    expect(without).toContain("Everything new");
    expect(without).not.toContain("Design only");
    expect(render({ hasCurrentWebsite: true, lane: "lane_2" })).toContain("Lane 2: the words come from the client");
    // Changing the type on a project with work: what happens, and that nothing is deleted by itself.
    const changed = render({ hasCurrentWebsite: true, lane: "lane_1", values: { ...emptyIntake().content, mode: "auto" }, savedMode: "keep", typeWork: { pages: 12, approved: 3, concepts: 2 } });
    expect(changed).toContain("This project has 12 planned pages (3 approved) and 2 concepts. Changing the type deletes nothing by itself.");
    expect(typeChangeLine({ pages: 0, approved: 0, concepts: 0 }, "keep")).toMatch(/^Changing the type deletes nothing by itself\. Once saved, the page plan follows the current site's pages/);
  });
});

describe("the steps follow the type", () => {
  const ID = "0b0c1f8e-2f5b-4a55-9a1d-2d8f0a6c3e11";
  const facts = (over: Partial<JourneyFacts>): JourneyFacts => ({ lane: "lane_1", status: "intake", intakeComplete: false, previewApproved: false, designReady: false, ...over });
  const bar = (over: Partial<JourneyFacts>) => journeySteps(ID, facts(over)).map((s) => `${s.label}:${s.state}`);

  it("Design only has no Content step; a project saved at Content is at Build", () => {
    expect(bar({ projectType: "design_only", status: "mockups" })).toEqual(["Intake:done", "Design:current", "Build & preview:locked", "Go live:locked", "Updates:locked"]);
    expect(journeySteps(ID, facts({ projectType: "design_only", status: "mockups" })).find((s) => s.key === "build")!.lockedReason).toBe("Unlocks after the client approves a concept");
    expect(currentStep(facts({ projectType: "design_only", status: "content" }))).toBe("build");
    expect(lockedStage({ projectId: ID, status: "content", lane: "lane_1", stage: "build", designOnly: true })).toBeNull();
    expect(lockedStage({ projectId: ID, status: "content", lane: "lane_1", stage: "build" })).not.toBeNull();
    // Every other type keeps the Content step.
    for (const type of ["design_content", "everything_new", "client_words", null] as const) expect(bar({ projectType: type, status: "mockups" })).toContain("Content:available");
  });

  it("Design only has no wireframe; Design + content's is drafted from the current home page", () => {
    expect(wireframeApplies({ lane: "lane_1", tier: "pro", enabled: true, designOnly: true })).toBe(false);
    expect(wireframeApplies({ lane: "lane_1", tier: "pro", enabled: null })).toBe(true);
    const draft = draftWireframeFromSite(
      [
        { kind: "hero", heading: "Sacramento's 24/7 plumbers" },
        { kind: "services", heading: "Our services" },
        { kind: "services", heading: "More services" },
        { kind: "other", heading: "Why homeowners call us" },
        { kind: "reviews", heading: "What customers say" },
        { kind: "other", heading: "" },
        { kind: "footer", heading: "" },
      ],
      [],
    );
    expect(draft.map((s) => s.kind)).toEqual(["header", "hero", "services", "custom", "reviews", "footer"]);
    expect(draft[3]!.name).toBe("Why homeowners call us");
    expect(draft[1]!.lines).toEqual(['On the current site: "Sacramento\'s 24/7 plumbers"']);
    expect(draft[4]!.lines[0]).toContain("confirmed with the client");
    expect(draftWireframeFromSite([], [])[0]!.kind).toBe("header");
  });
});

describe("kept words and the build", () => {
  const v = (version: number, source: string, approved = false) => ({ version, source, approvedAt: approved ? new Date() : null, body: "# Page\n\nWe fix pipes." });

  it("a page is kept only while its newest words are the current site's (hand edits included)", () => {
    expect(isKeptLineage([v(1, "kept")])).toBe(true);
    expect(isKeptLineage([v(1, "kept"), v(2, "edit")])).toBe(true);
    // Improved or redrafted by AI after being kept: no longer held to the kept words.
    expect(isKeptLineage([v(1, "kept"), v(2, "improved")])).toBe(false);
    expect(isKeptLineage([v(1, "kept"), v(2, "redraft"), v(3, "edit")])).toBe(false);
    // Put back to the current site's words: kept again.
    expect(isKeptLineage([v(1, "kept"), v(2, "improved"), v(3, "kept")])).toBe(true);
    expect(isKeptLineage([v(1, "draft")])).toBe(false);
  });

  it("on Design only kept words need no approval; everything else needs Content's", () => {
    expect(pageReadyForBuild([v(1, "kept")], true)).toBe(true);
    expect(pageReadyForBuild([v(1, "kept")], false)).toBe(false);
    expect(pageReadyForBuild([v(1, "kept"), v(2, "improved")], true)).toBe(false);
    expect(pageReadyForBuild([v(1, "kept"), v(2, "improved", true)], false)).toBe(true);
    expect(pageReadyForBuild([{ ...v(1, "kept"), body: null }], true)).toBe(false);
    // A page the read couldn't give (its heading and a placeholder only) needs its words first (Fable's review L6).
    expect(pageReadyForBuild([{ ...v(1, "kept"), body: "# Pricing\n\n[PLACEHOLDER: this page's words: the current site couldn't be read]\n" }], true)).toBe(false);
  });
});

describe("Design only, end to end on the database", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    setDbForTesting(h.db as Database);
    setStorageForTesting(new FakeR2());
  });
  afterEach(async () => {
    setStorageForTesting(null);
    setDbForTesting(null);
    await h.close();
  });

  it("the client's pick goes to Build, the kept pages are ready without approval, and the bar has no Content", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Preferred Plumbing", trade: "plumbing", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 1, status: "mockups", memberUserIds: [] });
    await saveIntakeSection(h.ctx, admin.viewer, id, "website", { currentWebsiteUrl: "https://preferred.example" });
    await saveIntakeSection(h.ctx, admin.viewer, id, "content", { mode: "keep" });
    expect(await projectTypeFor(h.db as never, id)).toBe("design_only");
    const [page] = await h.db.insert(pagePlanPage).values({ projectId: id, position: 0, kind: "home", name: "Home", slug: "", title: "Home", metaDescription: "Plumbers." }).returning();
    await h.db.insert(pageDraft).values({ projectId: id, pageId: page!.id, version: 1, source: "kept", status: "done", body: "# Home\n\nWe fix pipes.\n" });
    const [run] = await h.db.insert(mockupRun).values({ projectId: id, conceptCount: 1, status: "succeeded", model: "m", startedByUserId: admin.viewer.id }).returning();
    const [c] = await h.db.insert(concept).values({ runId: run!.id, projectId: id, label: "A", direction: "classic_trust", skillId: "impeccable", status: "ready" }).returning();
    await h.db.insert(conceptVersion).values({ conceptId: c!.id, version: 1, htmlKey: `projects/${id}/a.html` });

    await recordClientDecision(h.ctx, admin.viewer, { conceptId: c!.id, channel: "email", changesRequested: false, clientSaid: "Concept A, please." });
    const [proj] = await h.db.select().from(projectTable).where(eq(projectTable.id, id));
    expect(proj!.status).toBe("build");
    expect(await h.db.select().from(clientDecision).where(eq(clientDecision.projectId, id))).toHaveLength(1);

    const ready = await siteReadiness(h.db as never, id);
    expect(ready).toMatchObject({ mockupApproved: true, waiting: [], clientApprovedCopy: true, designOnly: true, ready: true });
    const facts = (await loadJourneyFacts(h.db as never, id))!;
    expect(facts.projectType).toBe("design_only");
    expect(journeySteps(id, facts).map((s) => s.key)).not.toContain("content");

    // Design + content: the same kept page now waits for Content's approval.
    await saveIntakeSection(h.ctx, admin.viewer, id, "content", { mode: "improve" });
    expect((await siteReadiness(h.db as never, id)).waiting).toEqual(["Home"]);
  });
});
