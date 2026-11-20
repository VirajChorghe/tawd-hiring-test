import { and, eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  27 September 2026 (Jason): the exact copies on Sonnet first with the
  low-scoring sections rebuilt on Opus, chosen a page at a time (the home
  page first), and the "Client-supplied design" add-on, per page, added by
  itself when a design is read or imported.
*/

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
vi.mock("@/app/actions", () => {
  const f = async () => ({ ok: true });
  return new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : f), has: () => true });
});

import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, aiCall, designCopy, figmaDesign, project, projectAddon, stopRequest } from "@tawd/core/schema";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { CLIENT_DESIGN_ADDON, syncDesignAddon } from "@tawd/core/addons";
import { defaultModelFor } from "@tawd/core/mockups";
import { createProject } from "@/lib/projects";
import { setQueueForTesting } from "@/lib/mockups";
import { acceptCopy, confirmDesignPages, loadExactDesign, renameDesignPages, startExactCopies } from "@/lib/exact-design";
import { PermissionError } from "@tawd/core/permissions";
import { stopWork } from "@/lib/stops";
import { projectCapState, setProjectCap } from "@/lib/spend";
import { checkStop, runJobWithStops } from "../../../worker/src/stop";
import { designCopyPage, loadDesignCopy, replayCopy } from "@/lib/design-copy";
import { getStorage } from "@tawd/core/intake/storage";
import { listAddons, loadProjectMoney, loadRevenue, saveAddonPrice } from "@/lib/pricing";
import { loadStepModelRows } from "@/lib/step-models";
import { CopyProgress, ExactCopiesButton, ExactDesignCard } from "@/components/mockups/exact-design-card";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

let h: Harness;
let queued: { name: string; data: { copyId: string } }[];

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setStorageForTesting(new FakeR2());
  queued = [];
  setQueueForTesting({ add: async (name, data) => void queued.push({ name, data: data as never }), getJob: async () => null });
});

afterEach(async () => {
  setQueueForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

const FRAMES = [
  { id: "1:1", name: "Home", width: 1440, height: 4200, isHome: true, imageKey: "k/home.png", scale: 1 },
  { id: "1:2", name: "About", width: 1440, height: 2600, isHome: false, imageKey: "k/about.png", scale: 1 },
  { id: "1:3", name: "Home - Mobile", width: 390, height: 6200, isHome: false, imageKey: "k/home-m.png", scale: 1 },
  { id: "1:4", name: "Services", width: 1440, height: 3000, isHome: false, imageKey: "k/services.png", scale: 1 },
];

async function optionA() {
  const admin = await seedAdmin(h);
  const id = await createProject(h.ctx, admin.viewer, { clientName: "Nora Happy Beagle Lady", trade: "photography", tier: "growth", lane: "lane_2", laneOption: "a", conceptCount: null, status: "mockups", memberUserIds: [] });
  await h.db.insert(figmaDesign).values({ projectId: id, url: "upload", fileKey: "upload-1", source: "upload", importStatus: "done", importedVersion: "upload-1", frames: FRAMES });
  const view = await loadExactDesign(h.db, id);
  await confirmDesignPages(h.ctx, admin.viewer, id, view.pages.map((p) => ({ id: p.id, name: p.name, slug: p.slug })));
  return { admin, id };
}

describe("the exact copies", () => {
  it("run on Sonnet first, with the low-scoring sections rebuilt on Opus, both on the model card", async () => {
    expect(defaultModelFor("faithful_copy")).toBe("claude-sonnet-5");
    expect(defaultModelFor("faithful_copy_retry")).toBe("claude-opus-5-5");
    const rows = await loadStepModelRows(h.db);
    expect(rows.filter((r) => r.step.startsWith("faithful_copy")).map((r) => [r.label, r.model])).toEqual([
      ["Exact and faithful copies, first build", "claude-sonnet-5"],
      ["Copy sections rebuilt after a low score", "claude-opus-5-5"],
    ]);
  });

  it("copy only the chosen pages: the home page first, then the rest", async () => {
    const { admin, id } = await optionA();
    let view = await loadExactDesign(h.db, id);
    expect(view.toBuild).toBe(3);
    expect(view.perPage.label).toContain("on Sonnet 5, sections rebuilt after a low score on Opus 5.5");

    const html = renderToStaticMarkup(<ExactCopiesButton projectId={id} view={view} startOpen />);
    expect(html).toContain("Copy the design’s pages?");
    expect(html).toContain("Only the home page");
    expect(html).toContain("for 3 pages");
    expect(html).toContain("Copy 3 pages");

    const home = view.pages.find((p) => p.isHome)!;
    await expect(startExactCopies(h.ctx, admin.viewer, id, [])).rejects.toThrow("Choose at least one page");
    expect(await startExactCopies(h.ctx, admin.viewer, id, [home.frameId])).toBe(1);
    let copies = await h.db.select().from(designCopy).where(eq(designCopy.projectId, id));
    expect(copies.map((c) => c.frameName)).toEqual(["Home"]);
    const [logged] = await h.db.select().from(activityLog).where(and(eq(activityLog.entityId, id), eq(activityLog.action, "design.exact_copies_started")));
    expect((logged!.valueAfter as { pages: string[]; estimate: string }).pages).toEqual(["Home"]);
    expect((logged!.valueAfter as { estimate: string }).estimate).toContain("for 1 page");

    // The home page copied; the other two next.
    await h.db.update(designCopy).set({ status: "done" });
    view = await loadExactDesign(h.db, id);
    expect(view.toBuild).toBe(2);
    expect(await startExactCopies(h.ctx, admin.viewer, id)).toBe(2);
    copies = await h.db.select().from(designCopy).where(eq(designCopy.projectId, id));
    expect(copies.map((c) => c.frameName).sort()).toEqual(["About", "Home", "Services"]);
  });
});

describe("the client-supplied design add-on", () => {
  it("is on the price list per page, unpriced until an admin sets it", async () => {
    const addon = (await listAddons(h.db)).find((a) => a.key === CLIENT_DESIGN_ADDON)!;
    expect(addon).toMatchObject({ name: "Client-supplied design (per page)", priceCents: null, perPage: true, monthly: false });
  });

  it("is added by itself with the design's page count, follows the count, and charges each page", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Nora Happy Beagle Lady", trade: "photography", tier: "growth", lane: "lane_2", laneOption: "a", conceptCount: null, status: "mockups", memberUserIds: [] });

    // Pro is exempt, as from WordPress hosting.
    const pro = await createProject(h.ctx, admin.viewer, { clientName: "Keller Law", trade: "legal", tier: "pro", lane: "lane_2", laneOption: "a", conceptCount: null, status: "mockups", memberUserIds: [] });
    await syncDesignAddon(h.db, pro, 9);
    expect(await h.db.select().from(projectAddon).where(eq(projectAddon.projectId, pro))).toHaveLength(0);

    await syncDesignAddon(h.db, id, 9);
    let [row] = await h.db.select().from(projectAddon).where(eq(projectAddon.projectId, id));
    expect(row).toMatchObject({ addonKey: CLIENT_DESIGN_ADDON, quantity: 9, priceCents: null, removedAt: null });
    await syncDesignAddon(h.db, id, 9);
    await syncDesignAddon(h.db, id, 8);
    [row] = await h.db.select().from(projectAddon).where(eq(projectAddon.projectId, id));
    expect(row!.quantity).toBe(8);
    const log = await h.db.select().from(activityLog).where(eq(activityLog.entityId, id));
    expect(log.filter((l) => l.action === "project.addon_added")).toHaveLength(1);
    expect(log.filter((l) => l.action === "project.addon_quantity_changed").map((l) => l.valueAfter)).toEqual([{ addon: "Client-supplied design (per page)", quantity: 8, reason: "The design's page count changed." }]);

    // The first price set reaches it, charged per page.
    await saveAddonPrice(h.ctx, admin.viewer, CLIENT_DESIGN_ADDON, "20");
    const money = (await loadProjectMoney(h.db, id))!;
    expect(money.addons).toEqual([{ name: "Client-supplied design (per page)", priceCents: 2000, monthly: false, quantity: 8 }]);
    await h.db.update(project).set({ liveAt: new Date(), buildFeeCents: 19900, monthlyFeeCents: 9900 }).where(eq(project.id, id));
    const revenue = await loadRevenue(h.db);
    expect(revenue.thisMonth.buildFees).toBe(19900 + 8 * 2000);
  });
});

describe("the copies list (28 September 2026)", () => {
  it("says where each waiting page is in line, from the queue when it can say, else in the order queued", async () => {
    const { admin, id } = await optionA();
    await startExactCopies(h.ctx, admin.viewer, id);
    let view = await loadExactDesign(h.db, id);
    // The stand-in queue can't be asked: counted from the database.
    expect(view.pages.map((p) => p.copy?.inLine)).toEqual([1, 2, 3]);

    // The real queue: another job ahead of them, and the first page already being copied.
    const copies = await h.db.select().from(designCopy).where(eq(designCopy.projectId, id));
    const byFrame = (name: string) => copies.find((c) => c.frameName === name)!;
    await h.db.update(designCopy).set({ status: "working", progress: { stage: "building", done: 4, total: 12 } }).where(eq(designCopy.id, byFrame("Home").id));
    setQueueForTesting({
      add: async () => undefined,
      getJob: async () => null,
      getJobs: async () => [{ name: "concept", data: {} }, { name: "faithful-copy", data: { copyId: byFrame("About").id } }, { name: "faithful-copy", data: { copyId: byFrame("Services").id } }],
    });
    view = await loadExactDesign(h.db, id);
    expect(view.pages.map((p) => [p.name, p.copy?.status, p.copy?.inLine, p.copy?.progress])).toEqual([
      ["Home", "working", null, { stage: "building", done: 4, total: 12 }],
      ["About", "queued", 2, null],
      ["Services", "queued", 3, null],
    ]);

    const html = (copy: NonNullable<(typeof view.pages)[number]["copy"]>) => renderToStaticMarkup(<CopyProgress copy={copy} />);
    expect(html(view.pages[1]!.copy!)).toContain("Waiting (2nd in line)");
    expect(html(view.pages[0]!.copy!)).toContain("Copying: 4 of 12 sections built");
    expect(html({ ...view.pages[0]!.copy!, progress: { stage: "checking", done: 12, total: 12 } })).toContain("Checking all 12 sections against the design");
    expect(html({ ...view.pages[0]!.copy!, progress: { stage: "rebuilding", done: 1, total: 2 } })).toContain("Rebuilding 2 low-scoring sections: 1 of 2 done");
  });
});

describe("opening a copied page (28 September 2026)", () => {
  it("opens each page's own copy from the list, with its section scores and which model rebuilt what", async () => {
    const { admin, id } = await optionA();
    await startExactCopies(h.ctx, admin.viewer, id);
    const copies = await h.db.select().from(designCopy).where(eq(designCopy.projectId, id));
    const byFrame = (name: string) => copies.find((c) => c.frameName === name)!;
    const fidelity = (overall: number) => ({ method: "sections", overall, sections: [{ name: "Hero", score: overall }, { name: "Gallery", score: 71 }] });
    for (const name of ["Home", "About", "Services"]) {
      const key = `projects/${id}/copies/${name}.html`;
      await getStorage().put(key, Buffer.from(`<html><body>${name} page</body></html>`), "text/html");
      await h.db.update(designCopy).set({ status: "done", htmlKey: key, fidelity: fidelity(name === "About" ? 88 : 83), checks: { rebuilt: [2] }, finishedAt: new Date() }).where(eq(designCopy.id, byFrame(name).id));
    }
    // The About page was built on Sonnet and its weak section rebuilt on Opus.
    await h.db.insert(aiCall).values([
      { projectId: id, runId: byFrame("About").id, step: "faithful_copy", round: 1, model: "claude-sonnet-5", outputTokens: 1000 },
      { projectId: id, runId: byFrame("About").id, step: "faithful_copy", round: 2, model: "claude-opus-5-5", outputTokens: 1000 },
    ]);

    const about = (await loadDesignCopy(h.db, id, byFrame("About").id))!;
    expect(about).toMatchObject({ frameName: "About", firstModel: "Sonnet 5", rebuiltModel: "Opus 5.5", rebuiltCount: 1 });
    expect(about.sections.map((s) => [s.name, s.score, s.rebuilt])).toEqual([
      ["Hero", 88, false],
      ["Gallery", 71, true],
    ]);
    // Without an id: the homepage, as before. The live page is the one asked for (it used to be the newest of any page).
    expect((await loadDesignCopy(h.db, id))!.frameName).toBe("Home");
    expect(await designCopyPage(h.db, id, byFrame("Services").id)).toContain("Services page");
    expect(await designCopyPage(h.db, id)).toContain("Home page");
    // Another project's copy id opens nothing.
    const other = await createProject(h.ctx, admin.viewer, { clientName: "Other", trade: "photography", tier: "growth", lane: "lane_2", laneOption: "a", conceptCount: null, status: "mockups", memberUserIds: [] });
    expect(await loadDesignCopy(h.db, other, byFrame("About").id)).toBeNull();

    const html = renderToStaticMarkup(<ExactDesignCard projectId={id} view={await loadExactDesign(h.db, id)} canEdit />);
    for (const name of ["Home", "About", "Services"]) expect(html).toContain(`/projects/${id}/mockups/design/copy?copy=${byFrame(name).id}`);
    expect(html).toContain("Matches 88%");
  });
});

describe("accepting a copy as it is (28 September 2026)", () => {
  it("unblocks a page whose sections still differ, with a note, by the PM, the designer or an admin; a PDF design never gets the Figma advice", async () => {
    const { admin, id } = await optionA();
    await startExactCopies(h.ctx, admin.viewer, id);
    const copies = await h.db.select().from(designCopy).where(eq(designCopy.projectId, id));
    const home = copies.find((c) => c.frameName === "Home")!;
    await h.db
      .update(designCopy)
      .set({ status: "needs_cleanup", failureReason: 'This design file has overlapping or leftover content. Clean the frame in Figma, then re-import. Still different after a rebuild: "Gallery".' })
      .where(eq(designCopy.id, home.id));

    // The design was uploaded (a PDF): the advice is to compare and accept or copy again, never Figma.
    let view = await loadExactDesign(h.db, id);
    const page = view.pages.find((p) => p.name === "Home")!;
    expect(page.copy!.failureReason).toBe('Some sections still differ from the design after a rebuild. Compare them side by side, then accept the copy as it is or build it again. Still different after a rebuild: "Gallery".');
    expect(view.approvalProblems).toContain("Home: some sections still differ from the design; compare them, then accept the copy as it is or copy it again.");
    expect(JSON.stringify(view)).not.toContain("Figma");
    const card = renderToStaticMarkup(<ExactDesignCard projectId={id} view={view} canEdit />);
    expect(card).toContain("Accept this copy as it is");
    expect(card).not.toContain("Figma");
    expect((await loadDesignCopy(h.db, id, home.id))!.failureReason).not.toContain("Figma");

    const content = await seedUser(h, admin.viewer, { email: "content@velocitymedialab.com", roles: ["content"] });
    const designer = await seedUser(h, admin.viewer, { email: "designer@velocitymedialab.com", roles: ["web_designer"] });
    await expect(acceptCopy(h.ctx, content.viewer, id, home.id, "Fine")).rejects.toBeInstanceOf(PermissionError);
    await acceptCopy(h.ctx, designer.viewer, id, home.id, "The gallery gap is in the PDF too; the client has seen it.");

    const [row] = await h.db.select().from(designCopy).where(eq(designCopy.id, home.id));
    expect(row).toMatchObject({ status: "done", acceptedByUserId: designer.viewer.id, acceptedNote: "The gallery gap is in the PDF too; the client has seen it." });
    const [logged] = await h.db.select().from(activityLog).where(eq(activityLog.action, "design.copy_accepted"));
    expect(logged!.valueAfter).toMatchObject({ page: "Home", status: "done" });
    view = await loadExactDesign(h.db, id);
    expect(view.approvalProblems.some((p) => p.startsWith("Home: some sections"))).toBe(false);
    expect(view.pages.find((p) => p.name === "Home")!.copy!.accepted).toMatchObject({ note: "The gallery gap is in the PDF too; the client has seen it." });
  });
});

describe("replay on saved answers (28 September 2026)", () => {
  it("lets an admin rebuild a finished copy from its saved AI answers for $0, marked as a replay, and refuses one with nothing saved", async () => {
    const { admin, id } = await optionA();
    await startExactCopies(h.ctx, admin.viewer, id);
    const home = (await h.db.select().from(designCopy).where(eq(designCopy.projectId, id))).find((c) => c.frameName === "Home")!;
    await h.db.update(designCopy).set({ status: "done" }).where(eq(designCopy.id, home.id));
    queued = [];
    await expect(replayCopy(h.ctx, admin.viewer, id, home.id)).rejects.toThrow("no saved AI answers");
    await h.db.insert(aiCall).values({ projectId: id, runId: home.id, step: "faithful_copy", round: 1, model: "claude-sonnet-5", inputTokens: 1000, outputTokens: 900, responseKey: `projects/${id}/ai-responses/one.json` });
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    await expect(replayCopy(h.ctx, pm.viewer, id, home.id)).rejects.toBeInstanceOf(PermissionError);

    const replayId = await replayCopy(h.ctx, admin.viewer, id, home.id);
    expect(queued).toEqual([{ name: "faithful-copy", data: { copyId: replayId, projectId: id, replay: { fromRunIds: [home.id] } } }]);
    const [row] = await h.db.select().from(designCopy).where(eq(designCopy.id, replayId));
    expect(row).toMatchObject({ status: "queued", frameName: "Home", replayOf: home.id, startedByUserId: admin.viewer.id });
    await expect(replayCopy(h.ctx, admin.viewer, id, replayId)).rejects.toThrow("still being built");
    // A replay of a replay uses the first copy's answers.
    await h.db.update(designCopy).set({ status: "done", fidelity: { overall: 90, sections: [], method: "page", designHeight: 1, copyHeight: 1 } }).where(eq(designCopy.id, replayId));
    queued = [];
    await replayCopy(h.ctx, admin.viewer, id, replayId);
    expect(queued[0]!.data).toMatchObject({ replay: { fromRunIds: [home.id] } });
    const [logged] = await h.db.select().from(activityLog).where(eq(activityLog.action, "design.copy_replayed"));
    expect(logged!.valueAfter).toMatchObject({ page: "Home", from: home.id, answers: 1 });
    expect((await loadDesignCopy(h.db, id, replayId))!.replayOf).toMatchObject({ id: home.id });
  });
});

describe("page names and addresses after confirming (29 September 2026)", () => {
  it("change, with only what changed logged before and after, and the rules on addresses still apply", async () => {
    const { admin, id } = await optionA();
    const view = await loadExactDesign(h.db, id);
    const about = view.pages.find((p) => !p.isHome)!;
    expect(await renameDesignPages(h.ctx, admin.viewer, id, [{ id: about.id, name: "Meet the Pack", slug: "meet-the-pack" }])).toBe(1);
    const renamed = (await loadExactDesign(h.db, id)).pages.find((p) => p.id === about.id)!;
    expect(renamed).toMatchObject({ name: "Meet the Pack", slug: "meet-the-pack" });
    const [logged] = await h.db.select().from(activityLog).where(eq(activityLog.action, "design.pages_renamed"));
    expect(logged!.valueBefore).toEqual({ pages: [`${about.name} (/${about.slug})`] });
    expect(logged!.valueAfter).toEqual({ pages: ["Meet the Pack (/meet-the-pack)"] });
    expect(await renameDesignPages(h.ctx, admin.viewer, id, [{ id: about.id, name: "Meet the Pack", slug: "meet-the-pack" }])).toBe(0);
    const other = view.pages.find((p) => !p.isHome && p.id !== about.id)!;
    await expect(renameDesignPages(h.ctx, admin.viewer, id, [{ id: other.id, name: "Twin", slug: "meet-the-pack" }])).rejects.toThrow();
  });
});

describe("Stop (28 September 2026)", () => {
  it("marks waiting copies stopped, ends a running one before its next AI call, keeps finished work, and doesn't touch work started later", async () => {
    const { admin, id } = await optionA();
    await startExactCopies(h.ctx, admin.viewer, id);
    const copies = await h.db.select().from(designCopy).where(eq(designCopy.projectId, id));
    const running = copies.find((c) => c.frameName === "Home")!;
    const finished = copies.find((c) => c.frameName === "About")!;
    await h.db.update(designCopy).set({ status: "working" }).where(eq(designCopy.id, running.id));
    await h.db.update(designCopy).set({ status: "done" }).where(eq(designCopy.id, finished.id));
    const queuedAt = Date.now() - 60_000;

    const content = await seedUser(h, admin.viewer, { email: "content@velocitymedialab.com", roles: ["content"] });
    await expect(stopWork(h.ctx, content.viewer, id, "copies")).rejects.toBeInstanceOf(PermissionError);
    await expect(stopWork(h.ctx, admin.viewer, id, "everything")).rejects.toThrow("isn't work TAWD can stop");
    expect(await stopWork(h.ctx, admin.viewer, id, "copies")).toEqual({ waiting: 1 });

    const after = await h.db.select().from(designCopy).where(eq(designCopy.projectId, id));
    const by = (name: string) => after.find((c) => c.frameName === name)!;
    expect(by("Services")).toMatchObject({ status: "failed", failureReason: "Stopped by Test Admin before it started." });
    expect(by("About").status).toBe("done");
    expect(by("Home").status).toBe("working");
    const [logged] = await h.db.select().from(activityLog).where(eq(activityLog.action, "work.stopped"));
    expect(logged!.valueAfter).toMatchObject({ what: "the copies", waitingStopped: 1 });

    // The running copy's worker ends at its next AI call, before anything is paid for.
    const stopped = await runJobWithStops({ name: "faithful-copy", data: { copyId: running.id, projectId: id }, timestamp: queuedAt }, () => checkStop(h.db as never)).catch((e: Error) => e);
    expect(String(stopped)).toContain("Stopped by Test Admin before the next AI call; what was finished is kept.");
    // A job queued after the stop runs normally.
    await expect(runJobWithStops({ name: "faithful-copy", data: { copyId: running.id, projectId: id }, timestamp: Date.now() + 1000 }, () => checkStop(h.db as never))).resolves.toBeUndefined();
    // Another project's work isn't touched.
    const other = await createProject(h.ctx, admin.viewer, { clientName: "Other", trade: "photography", tier: "growth", lane: "lane_2", laneOption: "a", conceptCount: null, status: "mockups", memberUserIds: [] });
    await expect(runJobWithStops({ name: "faithful-copy", data: { copyId: "x", projectId: other }, timestamp: queuedAt }, () => checkStop(h.db as never))).resolves.toBeUndefined();

    // One page stopped on its own.
    await stopWork(h.ctx, admin.viewer, id, "copies", finished.id);
    expect((await h.db.select().from(stopRequest).where(eq(stopRequest.projectId, id))).map((s) => s.key).sort()).toEqual([`copies:${id}`, `copy:${finished.id}`].sort());
  });
});

describe("a test project's AI cap (28 September 2026)", () => {
  it("blocks a run that would pass the cap ($5 by default), until an admin raises it; set by admins only, logged", async () => {
    const { admin, id } = await optionA();
    // $4.50 already spent: 225,000 output tokens on Opus 5.5 at $20 a million.
    await h.db.insert(aiCall).values({ projectId: id, runId: id, step: "design_read", model: "claude-opus-5-5", outputTokens: 225_000 });
    // A normal project has no cap: the copies may start.
    expect((await projectCapState(h.db, id)).capDollars).toBeNull();

    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    await expect(setProjectCap(h.ctx, pm.viewer, id, { isTest: true, capDollars: "" })).rejects.toBeInstanceOf(PermissionError);
    await setProjectCap(h.ctx, admin.viewer, id, { isTest: true, capDollars: "" });
    expect(await projectCapState(h.db, id)).toMatchObject({ capDollars: 5, isTest: true, savedCapCents: null });
    expect((await projectCapState(h.db, id)).spentDollars).toBeCloseTo(4.5);

    await expect(startExactCopies(h.ctx, admin.viewer, id)).rejects.toThrow(/^This test project has used \$4\.50 of its \$5\.00 AI cap, and this run \(about \$\d+\.\d\d\) would pass it\. An admin can raise the cap on the project's page, or try fewer pages\.$/);
    expect(await h.db.select().from(designCopy).where(eq(designCopy.projectId, id))).toHaveLength(0);

    await expect(setProjectCap(h.ctx, admin.viewer, id, { isTest: true, capDollars: "lots" })).rejects.toThrow("dollar amount");
    await setProjectCap(h.ctx, admin.viewer, id, { isTest: true, capDollars: "25" });
    expect(await startExactCopies(h.ctx, admin.viewer, id)).toBe(3);
    const logged = await h.db.select().from(activityLog).where(eq(activityLog.action, "project.ai_cap_changed"));
    expect(logged.map((l) => l.valueAfter)).toEqual([{ isTest: true, aiCapCents: null }, { isTest: true, aiCapCents: 2500 }]);
  });
});
