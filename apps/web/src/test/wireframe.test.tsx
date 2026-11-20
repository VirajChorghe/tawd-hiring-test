import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  The wireframe (Jason, 3 October 2026): on Growth and Pro, before the
  concepts, the site map and the home page's sections in order, made by
  code from the intake (free); edited and approved by a PM, the Web
  Designer or an admin; Generate waits for it; the concepts follow its
  order and the Home page words its sections.
*/

const state: { user: unknown } = { user: null };
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/projects",
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("@/lib/session", () => ({ requireUser: async () => state.user }));

import { eq } from "drizzle-orm";
import { setDbForTesting, type Database } from "@tawd/core/db";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { emptyIntake } from "@tawd/core/intake";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { PermissionError } from "@tawd/core/permissions";
import {
  buildHomeWordsUserText,
  checkWireframeSections,
  draftWireframeSections,
  listIntakeFacts,
  wireframeApplies,
  wireframeBlock,
  wireframeWordSections,
  type WireframeSection,
} from "@tawd/core/mockups";
import { activityLog, wireframe } from "@tawd/core/schema";
import MockupsPage from "@/app/(app)/projects/[id]/mockups/page";
import { approveHomeWords, startHomeWords } from "@/lib/home-words";
import { planRun, setQueueForTesting, startRun } from "@/lib/mockups";
import { loadNextStepFor } from "@/lib/next-step";
import { deleteProject } from "@/lib/project-deletion";
import { createProject } from "@/lib/projects";
import { approveWireframe, loadWireframe, resetWireframe, saveWireframe, setWireframeEnabled, wireframeBlocked } from "@/lib/wireframe";
import { approvedWireframeFor } from "../../../worker/src/pipeline";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setStorageForTesting(new FakeR2());
  setQueueForTesting({ add: async () => undefined, getJob: async () => null });
});

afterEach(async () => {
  state.user = null;
  setQueueForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

async function seed(tier: "starter" | "growth" | "pro" = "growth", withAreas = true) {
  const admin = await seedAdmin(h);
  const designer = await seedUser(h, admin.viewer, { email: "design@velocitymedialab.com", name: "Dana Lee", roles: ["web_designer"] });
  const content = await seedUser(h, admin.viewer, { email: "content@velocitymedialab.com", roles: ["content"] });
  const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", name: "Sam Park", roles: ["pm"] });
  const id = await createProject(h.ctx, admin.viewer, { clientName: "Rio Glass", trade: "glass_and_windows", tier, lane: "lane_1", laneOption: null, conceptCount: 1, status: "mockups", memberUserIds: [] });
  await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Rio Glass", phone: "916-555-0147", yearFounded: 2001, state: "CA", city: "Sacramento" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "services", {
    items: [
      { id: "s1", name: "Shower doors", description: "" },
      { id: "s2", name: "Mirrors", description: "" },
    ],
    mainServiceId: "s1",
  });
  if (withAreas) await saveIntakeSection(h.ctx, admin.viewer, id, "serviceAreas", { scope: "cities", cities: ["Sacramento", "Folsom"] });
  await saveIntakeSection(h.ctx, admin.viewer, id, "website", { currentWebsiteUrl: "https://rioglass.example" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "content", { mode: "manual", suppliedCopy: "Welcome\nWe install shower doors." });
  return { admin, designer, content, pm, id };
}

describe("the draft from the intake (code, free)", () => {
  it("shows only what the intake has: a trust band only with real credentials, service areas only when listed", async () => {
    const { id } = await seed();
    const view = await loadWireframe(h.db as Database, id);
    expect(view).toMatchObject({ applies: true, drafted: true, approved: null });
    // 8 October 2026: no Reviews box, and Why choose us and the FAQ only with facts (one reason and one answer here: neither).
    expect(view.sections.map((s) => s.kind)).toEqual(["header", "hero", "trust", "services", "areas", "contact", "footer"]);
    const byKind = new Map(view.sections.map((s) => [s.kind, s]));
    expect(byKind.get("hero")!.lines[0]).toBe("Shower doors in Sacramento");
    expect(byKind.get("trust")!.lines).toEqual(["In business since 2001"]);
    expect(byKind.get("contact")!.lines.some((l) => l.startsWith("Hours"))).toBe(false);
    // The site map is the plan Content would draft now.
    expect(view.sitemap.source).toBe("draft");
    expect(view.sitemap.pages.map((p) => p.name)).toContain("Home");

    // No credentials, no areas: no trust band and no service-area section, never a made-up one.
    const empty = emptyIntake();
    const bare = draftWireframeSections(listIntakeFacts({ ...empty, business: { ...empty.business, name: "Bare Co", phone: "916-555-0100" } }, []));
    expect(bare.map((s) => s.kind)).not.toContain("trust");
    expect(bare.map((s) => s.kind)).not.toContain("areas");
  });

  it("checks an edited list: the header first and the footer last, once each, every section named", () => {
    const s = (kind: WireframeSection["kind"], id = kind): WireframeSection => ({ id, kind, name: kind, lines: [], note: "" });
    expect(checkWireframeSections([s("header"), s("hero"), s("footer")])).toBeNull();
    expect(checkWireframeSections([s("hero"), s("header"), s("footer")])).toMatch(/header comes first/);
    expect(checkWireframeSections([s("header"), s("footer"), s("hero")])).toMatch(/footer comes last/);
    expect(checkWireframeSections([s("header"), { ...s("hero"), name: " " }, s("footer")])).toMatch(/name/);
    expect(checkWireframeSections([s("header"), s("footer")])).toMatch(/at least/);
  });

  it("applies on Growth and Pro, not Starter or Lane 2, unless a PM switched it", () => {
    expect(wireframeApplies({ lane: "lane_1", tier: "growth", enabled: null })).toBe(true);
    expect(wireframeApplies({ lane: "lane_1", tier: "pro", enabled: false })).toBe(false);
    expect(wireframeApplies({ lane: "lane_1", tier: "starter", enabled: null })).toBe(false);
    expect(wireframeApplies({ lane: "lane_1", tier: "starter", enabled: true })).toBe(true);
    expect(wireframeApplies({ lane: "lane_2", tier: "pro", enabled: true })).toBe(false);
  });
});

describe("editing and approving", () => {
  it("lets a PM or the Web Designer edit and approve, never Content; a change after approval asks again", async () => {
    const { designer, content, pm, id } = await seed();
    const view = await loadWireframe(h.db as Database, id);
    const edited = [...view.sections];
    // Move Service areas above Services, drop the trust band, add a note on the hero.
    const areas = edited.findIndex((s) => s.kind === "areas");
    const [areasSection] = edited.splice(areas, 1);
    edited.splice(edited.findIndex((s) => s.kind === "services"), 0, areasSection!);
    const trimmed = edited.filter((s) => s.kind !== "trust").map((s) => (s.kind === "hero" ? { ...s, note: "Big photo of a frameless shower" } : s));

    await expect(saveWireframe(h.ctx, content.viewer, id, trimmed)).rejects.toBeInstanceOf(PermissionError);
    await saveWireframe(h.ctx, pm.viewer, id, trimmed);
    await expect(saveWireframe(h.ctx, pm.viewer, id, [trimmed[1], ...trimmed.slice(2)])).rejects.toThrow(/header comes first/);

    expect(await wireframeBlocked(h.db as Database, id)).toMatch(/Approve the wireframe first/);
    await approveWireframe(h.ctx, designer.viewer, id, trimmed);
    let saved = await loadWireframe(h.db as Database, id);
    expect(saved.approved).toMatchObject({ byUserId: designer.viewer.id });
    expect(saved.sections.map((s) => s.kind)).toEqual(["header", "hero", "areas", "services", "contact", "footer"]);
    expect(await wireframeBlocked(h.db as Database, id)).toBeNull();
    const [row] = await h.db.select().from(wireframe).where(eq(wireframe.projectId, id));
    expect((row!.sitemap as { name: string }[]).map((p) => p.name)).toContain("Home");

    // A change after approval: approve again.
    await saveWireframe(h.ctx, pm.viewer, id, trimmed.map((s) => (s.kind === "areas" ? { ...s, name: "Where we work" } : s)));
    saved = await loadWireframe(h.db as Database, id);
    expect(saved.approved).toBeNull();

    // Start again from the intake.
    await resetWireframe(h.ctx, pm.viewer, id);
    expect((await loadWireframe(h.db as Database, id)).drafted).toBe(true);

    const actions = (await h.db.select().from(activityLog)).map((a) => a.action).filter((a) => a.startsWith("mockups.wireframe"));
    expect(actions).toEqual(["mockups.wireframe_saved", "mockups.wireframe_approved", "mockups.wireframe_saved", "mockups.wireframe_reset"]);
  });

  it("a PM switches it on for Starter or off for Growth; the Web Designer can't switch it", async () => {
    const starter = await seed("starter");
    expect(await wireframeBlocked(h.db as Database, starter.id)).toBeNull();
    await expect(setWireframeEnabled(h.ctx, starter.designer.viewer, starter.id, true)).rejects.toBeInstanceOf(PermissionError);
    await setWireframeEnabled(h.ctx, starter.pm.viewer, starter.id, true);
    expect(await wireframeBlocked(h.db as Database, starter.id)).toMatch(/Approve the wireframe/);
    await setWireframeEnabled(h.ctx, starter.pm.viewer, starter.id, false);
    expect(await wireframeBlocked(h.db as Database, starter.id)).toBeNull();
  });
});

describe("what it changes", () => {
  it("Generate waits for it, and the Next step says so, whose job it is", async () => {
    const { admin, pm, id } = await seed();
    await startHomeWords(h.ctx, admin.viewer, id, "client_copy");
    await approveHomeWords(h.ctx, admin.viewer, id, { sections: [{ name: "Welcome", words: "We install shower doors." }], testimonials: [] });
    const plan = await planRun(admin.viewer, id, 1);
    expect(plan.wireframeBlocked).toMatch(/Approve the wireframe/);
    await expect(startRun(h.ctx, admin.viewer, { projectId: id, concepts: plan.plan.concepts.slice(0, 1) })).rejects.toThrow(/Approve the wireframe/);
    expect(await loadNextStepFor(h.db as Database, pm.viewer, id)).toMatchObject({ title: "Approve the wireframe" });

    await approveWireframe(h.ctx, pm.viewer, id, (await loadWireframe(h.db as Database, id)).sections);
    expect((await planRun(admin.viewer, id, 1)).wireframeBlocked).toBeNull();
  });

  it("the concepts get its order, and the Home page words its sections", async () => {
    const { pm, id } = await seed("pro");
    const sections = (await loadWireframe(h.db as Database, id)).sections;
    expect(await approvedWireframeFor(h.db as never, { id, lane: "lane_1", tier: "pro" })).toBeNull();
    await approveWireframe(h.ctx, pm.viewer, id, sections);
    const approved = await approvedWireframeFor(h.db as never, { id, lane: "lane_1", tier: "pro" });
    expect(approved!.map((s) => s.kind)).toEqual(sections.map((s) => s.kind));
    // Not for a project it doesn't apply to.
    expect(await approvedWireframeFor(h.db as never, { id, lane: "lane_1", tier: "starter" })).toBeNull();

    const block = wireframeBlock(approved);
    expect(block).toContain("Build the home page's bands in this order");
    expect(block).toContain("The house rules come first");
    expect(block).toMatch(/1\. Header[\s\S]*2\. Hero[\s\S]*Footer/);
    const text = buildHomeWordsUserText({ clientName: "Rio Glass", tradeLabel: "glass", factsKnown: "-", currentSiteWords: null, tone: "", sectionNames: wireframeWordSections(approved) });
    expect(text).toContain('Write exactly these sections, in this order, with these names: "Hero", "Trust band", "Services"');
    expect(text).not.toContain('"Header"');
  });

  it("the Design page shows the card, and goes with the project when it is deleted", async () => {
    const { admin, id } = await seed();
    state.user = admin.viewer;
    const html = renderToStaticMarkup((await MockupsPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })) as React.ReactElement);
    expect(html).toContain('id="wireframe"');
    expect(html).toContain("Home page, top to bottom");
    expect(html).toContain("Approve the wireframe first");

    await approveWireframe(h.ctx, admin.viewer, id, (await loadWireframe(h.db as Database, id)).sections);
    await deleteProject(h.ctx, admin.viewer, id, { confirmName: "Rio Glass", reason: "A test project, done with." });
    expect(await h.db.select().from(wireframe)).toHaveLength(0);
  });
});

