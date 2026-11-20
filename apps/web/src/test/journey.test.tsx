import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  The project's steps and the Next step card (Jason, 29 September 2026):
  one lane-aware step bar with no QA, and a project page that says what
  happens next and whose job it is.
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
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { buildFeePayment, clientDecision, concept, figmaDesign, mockupRun, pageDraft, pagePlanPage, previewDecision, project as projectTable, siteBuild, siteDeploy } from "@tawd/core/schema";
import ProjectPage from "@/app/(app)/projects/[id]/page";
import ProjectsPage from "@/app/(app)/projects/page";
import { journeySteps, loadJourneyFacts, type JourneyFacts } from "@/lib/journey";
import { loadProjectNext } from "@/lib/next-step";
import { createProject } from "@/lib/projects";
import { makePagePlan } from "@/lib/seo-data";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setStorageForTesting(new FakeR2());
});
afterEach(async () => {
  state.user = null;
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

const ID = "0b0c1f8e-2f5b-4a55-9a1d-2d8f0a6c3e11";
const facts = (over: Partial<JourneyFacts>): JourneyFacts => ({ lane: "lane_1", status: "intake", intakeComplete: false, previewApproved: false, designReady: false, ...over });
const bar = (over: Partial<JourneyFacts>) => journeySteps(ID, facts(over)).map((s) => `${s.label}:${s.state}`);

describe("the step bar", () => {
  it("Lane 1 has six steps (Updates last) and no QA", () => {
    expect(bar({})).toEqual(["Intake:current", "Design:locked", "Content:locked", "Build & preview:locked", "Go live:locked", "Updates:locked"]);
    expect(bar({ intakeComplete: true })).toEqual(["Intake:done", "Design:available", "Content:locked", "Build & preview:locked", "Go live:locked", "Updates:locked"]);
  });

  it("at Design, Content can start early (keywords and the page plan)", () => {
    const steps = journeySteps(ID, facts({ status: "mockups" }));
    expect(steps.map((s) => `${s.label}:${s.state}:${s.note}`)).toEqual(["Intake:done:Done", "Design:current:Now", "Content:available:Can start early", "Build & preview:locked:", "Go live:locked:", "Updates:locked:"]);
    expect(steps[2]!.href).toBe(`/projects/${ID}/content`);
  });

  it("Build & preview until the client approves the preview, then Go live", () => {
    expect(bar({ status: "build" })).toEqual(["Intake:done", "Design:done", "Content:done", "Build & preview:current", "Go live:locked", "Updates:locked"]);
    expect(bar({ status: "build", previewApproved: true })).toEqual(["Intake:done", "Design:done", "Content:done", "Build & preview:done", "Go live:current", "Updates:locked"]);
    // A project someone once put at QA counts as Build.
    expect(bar({ status: "qa" })).toEqual(bar({ status: "build" }));
    // Live: every step done, and Updates is the work now (1 October 2026).
    expect(bar({ status: "live" })).toEqual(["Intake:done", "Design:done", "Content:done", "Build & preview:done", "Go live:done", "Updates:current"]);
  });

  it("Lane 2 has five steps: the client's design, then building and previewing on the Design page", () => {
    expect(bar({ lane: "lane_2", status: "mockups" })).toEqual(["Intake:done", "Client's design:current", "Build & preview:locked", "Go live:locked", "Updates:locked"]);
    const building = journeySteps(ID, facts({ lane: "lane_2", status: "mockups", designReady: true }));
    expect(building.map((s) => `${s.label}:${s.state}`)).toEqual(["Intake:done", "Client's design:done", "Build & preview:current", "Go live:locked", "Updates:locked"]);
    expect(building[2]!.href).toBe(`/projects/${ID}/mockups#build`);
    expect(bar({ lane: "lane_2", status: "build" })).toEqual(["Intake:done", "Client's design:done", "Build & preview:done", "Go live:current", "Updates:locked"]);
  });

  it("a paused project keeps Intake and Design open to read", () => {
    const steps = journeySteps(ID, facts({ status: "paused" }));
    expect(steps.map((s) => s.state)).toEqual(["done", "done", "locked", "locked", "locked", "locked"]);
    expect(steps[2]!.lockedReason).toBe("This project is paused");
  });
});

async function seed(options: { lane?: "lane_1" | "lane_2"; laneOption?: "a" | "b" | null; status?: string } = {}) {
  const admin = await seedAdmin(h);
  state.user = admin.viewer;
  const pm = await seedUser(h, admin.viewer, { email: "priya@velocitymedialab.com", name: "Priya Nair", roles: ["pm"] });
  const designer = await seedUser(h, admin.viewer, { email: "dan@velocitymedialab.com", name: "Dan Ortiz", roles: ["web_designer"] });
  const writer = await seedUser(h, admin.viewer, { email: "mei@velocitymedialab.com", name: "Mei Chen", roles: ["content"] });
  const lane = options.lane ?? "lane_1";
  const id = await createProject(h.ctx, admin.viewer, {
    clientName: "Valley Air",
    trade: "hvac",
    tier: "starter",
    lane,
    laneOption: lane === "lane_2" ? (options.laneOption ?? "b") : null,
    conceptCount: lane === "lane_2" ? null : 3,
    status: "intake",
    memberUserIds: [pm.viewer.id, designer.viewer.id, writer.viewer.id],
  });
  await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Valley Air", state: "CA" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "services", { items: [{ id: "s1", name: "AC repair", description: "" }], mainServiceId: "s1" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "serviceAreas", { scope: "cities", cities: ["Sacramento"] });
  if (options.status) await h.db.update(projectTable).set({ status: options.status }).where(eq(projectTable.id, id));
  return { admin, id, pm, designer };
}

async function next(id: string) {
  const [row] = await h.db.select().from(projectTable).where(eq(projectTable.id, id));
  const f = (await loadJourneyFacts(h.db as Database, id))!;
  const members = [
    { id: "p", name: "Priya Nair", roles: ["pm" as const] },
    { id: "d", name: "Dan Ortiz", roles: ["web_designer" as const] },
    { id: "m", name: "Mei Chen", roles: ["content" as const] },
  ];
  return loadProjectNext(h.db as Database, { projectId: id, facts: f, laneOption: row!.laneOption, members, missing: ["License number", "Logo"] });
}

describe("the Next step card", () => {
  it("in an unfinished intake: finish it, the PM's job, with what is missing", async () => {
    const { id } = await seed();
    const view = await next(id);
    expect(view.next.title).toBe("Finish the intake");
    expect(view.next.line).toBe("2 required answers missing: License number, Logo.");
    expect(view.next.who.people.map((p) => p.name)).toEqual(["Priya Nair"]);
    expect(view.next.action).toEqual({ label: "Open the intake", href: `/projects/${id}/intake` });
    expect(view.standing.map((r) => r.label)).toEqual(["Intake", "Design", "Content", "Build & preview", "Go live", "Updates"]);
  });

  it("at Design: generate the concepts, then the client's decision once they are ready", async () => {
    const { admin, id } = await seed({ status: "mockups" });
    expect((await next(id)).next.title).toBe("Generate the concepts");
    const [run] = await h.db.insert(mockupRun).values({ projectId: id, conceptCount: 1, status: "running", model: "m", startedByUserId: admin.viewer.id }).returning();
    const busy = await next(id);
    expect(busy.next.who).toMatchObject({ label: "Waiting on", people: [], text: "TAWD" });
    await h.db.update(mockupRun).set({ status: "succeeded" }).where(eq(mockupRun.id, run!.id));
    const ready = await next(id);
    expect(ready.next.title).toBe("Get the client's decision on the concepts");
    expect(ready.standing.find((r) => r.key === "design")).toEqual({ key: "design", label: "Design", text: "Concepts ready: waiting on the client's decision", tone: "wait" });
    expect(ready.standing.find((r) => r.key === "content")!.text).toBe("Can start now (keywords and the page plan)");
    const [c] = await h.db.insert(concept).values({ runId: run!.id, projectId: id, label: "A", direction: "modern_clean", skillId: "impeccable", status: "ready" }).returning();
    await h.db.insert(clientDecision).values({ projectId: id, conceptId: c!.id, version: 1, channel: "email", changesRequested: true, clientSaid: "Bigger phone", recordedByUserId: admin.viewer.id });
    expect((await next(id)).next.title).toBe("Make the client's changes");
  });

  it("at Content: the drafts waiting on the content team", async () => {
    const { admin, id } = await seed({ status: "content" });
    // One starting button (8 October 2026): Prepare the content, where it shows.
    const first = await next(id);
    expect(first.next.title).toBe("Prepare the content");
    expect(first.next.action?.href).toMatch(/\/content#prepare$/);
    await makePagePlan(h.ctx, admin.viewer, id);
    const pages = await h.db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, id));
    for (const p of pages) await h.db.insert(pageDraft).values({ projectId: id, pageId: p.id, version: 1, source: "draft", status: "done", body: "# Page\n" });
    const view = await next(id);
    expect(view.next.title).toBe(`Approve ${pages.length} page drafts`);
    expect(view.next.who.people.map((p) => p.name)).toEqual(["Mei Chen"]);
  });

  it("at Go live, without the build fee: waiting on an admin or a founder", async () => {
    const { admin, id } = await seed({ status: "build" });
    const [build] = await h.db.insert(siteBuild).values({ projectId: id, version: 1, status: "done" } as never).returning();
    const [deploy] = await h.db.insert(siteDeploy).values({ projectId: id, buildId: build!.id, version: 1, kind: "preview", state: "ready" } as never).returning();
    await h.db.insert(previewDecision).values({ projectId: id, deployId: deploy!.id, outcome: "approved", channel: "email", clientSaid: "Looks great", recordedByUserId: admin.viewer.id });
    const view = await next(id);
    expect(view.next.title).toBe("Record the build fee");
    expect(view.next.who).toMatchObject({ label: "Waiting on", people: [], text: "an admin or a founder, to record the build fee", adminOrFounder: true });
    expect(view.standing.find((r) => r.key === "build")!.text).toBe("Done");
    await h.db.insert(buildFeePayment).values({ projectId: id, paidOn: "2026-09-29", method: "card", recordedByUserId: admin.viewer.id } as never);
    const after = await next(id);
    expect(after.next.title).toBe("Confirm the domain is in the client's name");
    expect(after.next.action!.href).toBe(`/projects/${id}/build?part=golive#go-live`);
  });

  it("Lane 2 without a design: add it in the intake's Design section (a PM or the designer)", async () => {
    const { id } = await seed({ lane: "lane_2", status: "mockups" });
    const view = await next(id);
    expect(view.next.title).toBe("Add the client's design");
    expect(view.next.action!.href).toBe(`/projects/${id}/intake?section=figma`);
    expect(view.next.who.people.map((p) => p.name)).toEqual(["Priya Nair", "Dan Ortiz"]);
    expect(view.standing.map((r) => r.label)).toEqual(["Intake", "Client's design", "Build & preview", "Go live", "Updates"]);
    await h.db.insert(figmaDesign).values({ projectId: id, url: "upload", fileKey: "u", source: "upload", importStatus: "done", importedVersion: "upload-1" } as never);
    expect((await next(id)).next.title).toBe("Review the design, or skip the review");
  });
});

describe("the project page", () => {
  const render = async (id: string, tab?: string) =>
    renderToStaticMarkup((await ProjectPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(tab ? { tab } : {}) })) as React.ReactElement);

  it("Overview: the Next step card and Where things stand; no Intake or Mockups buttons in the header", async () => {
    const { id } = await seed({ status: "mockups" });
    const html = await render(id);
    expect(html).toContain("Next step");
    expect(html).toContain("Generate the concepts");
    expect(html).toContain("Where things stand");
    expect(html).toContain("Can start early");
    expect(html).not.toContain(">QA<");
    expect(html).not.toContain(">Mockups</a>");
    expect(html).not.toContain("Tracking");
    expect(html).not.toContain("History</h2>");
  });

  it("Settings and History have their own tabs", async () => {
    const { id } = await seed();
    const settings = await render(id, "settings");
    expect(settings).toContain("Tracking");
    expect(settings).toContain('id="slack"');
    expect(settings).not.toContain("Next step");
    const history = await render(id, "history");
    expect(history).toContain("History");
    expect(history).toContain("Project created");
    expect(history).not.toContain("Tracking");
  });
});

describe("the Projects board", () => {
  it("has no QA tile, names the Design and Build steps, and gives each lane its own bar", async () => {
    const { admin } = await seed({ status: "mockups" });
    await createProject(h.ctx, admin.viewer, { clientName: "Nora", trade: "photography", tier: "starter", lane: "lane_2", laneOption: "a", conceptCount: null, status: "intake", memberUserIds: [] });
    const html = renderToStaticMarkup((await ProjectsPage({ searchParams: Promise.resolve({}) })) as React.ReactElement);
    expect(html).not.toContain(">QA<");
    expect(html).toContain("Build &amp; go live");
    expect(html).toContain(">Design<");
    // Lane 1: five segments; Lane 2: four.
    const bars = [...html.matchAll(/<div class="stage-bar"[^>]*>(.*?)<\/div>/g)].map((m) => (m[1]!.match(/<span/g) ?? []).length);
    expect(bars.sort()).toEqual([5, 6]);
  });
});
