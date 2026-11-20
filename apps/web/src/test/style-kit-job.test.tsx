import fs from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
  The style kit, end to end in a real Chrome (Jason, 28 September 2026): a
  small uploaded design drawn here, its kit built by the job (no AI; fonts
  stood in), the kit sheet and the home page from the kit alone stored, the
  card that shows them, a font swapped by the designer, and the element
  check naming what a copy leaves out. Skipped where Chrome isn't installed.
*/

vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }) }));
vi.mock("@/app/actions", () => ({ startStyleKitAction: async () => ({ ok: true }), setKitFontAction: async () => ({ ok: true }), repairCopiesAction: async () => ({ ok: true }) }));

import { eq } from "drizzle-orm";
import { setDbForTesting, type Database } from "@tawd/core/db";
import { getStorage, projectStoragePrefix, setStorageForTesting } from "@tawd/core/intake/storage";
import { PermissionError } from "@tawd/core/permissions";
import { activityLog, designCopy, figmaDesign, styleKit } from "@tawd/core/schema";
import { describeMisses, planPage } from "@tawd/core/style-kit/element-check";
import { applyKit, type StyleKit } from "@tawd/core/style-kit/kit";
import { StyleKitCard } from "@/components/mockups/style-kit-card";
import { setQueueForTesting } from "@/lib/mockups";
import { createProject } from "@/lib/projects";
import { loadStyleKit, setKitFont, startStyleKit, StyleKitError } from "@/lib/style-kit";
import { fillFromTemplates, loadRepairSummary, repairCopies, sectionRebuildCost } from "@/lib/copy-repair";
import { checkReadiness, uploadToFigmaFile } from "@tawd/core/figma";
import { runCopyRepairJob } from "../../../worker/src/copy-repair-job";
import { runTemplateFillJob } from "../../../worker/src/template-fill-job";
import { phoneCheck, phoneRules, readShell } from "../../../worker/src/phone-by-code";
import { insertMobileCss } from "@tawd/core/figma";
import { phoneShellCss, phoneShellHtml } from "@tawd/core/site";

import { runElementCheck } from "../../../worker/src/element-check";
import { loadKitForCopy, runStyleKitJob } from "../../../worker/src/style-kit-job";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const hasChrome = fs.existsSync(CHROME);
const require = createRequire(import.meta.url);
type Browser = Parameters<typeof runElementCheck>[0];
let browser: Browser;
let h: Harness;
let queued: { name: string; data: unknown }[];

beforeAll(async () => {
  if (!hasChrome) return;
  const { chromium } = require("../../../worker/node_modules/playwright-core");
  browser = await chromium.launch({ executablePath: CHROME });
});
afterAll(async () => {
  await browser?.close();
});
beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setStorageForTesting(new FakeR2());
  queued = [];
  setQueueForTesting({ add: async (name, data) => void queued.push({ name, data }), getJob: async () => null });
});
afterEach(async () => {
  setQueueForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

/* The design: a navy top band, a beige panel with a navy button, an outlined box with its title in the border, a heart icon. */
const DESIGN = `<!doctype html><html><body style="margin:0;width:1440px;height:900px;background:#fff;font-family:Arial">
<div style="height:120px;background:#0b1a4a"></div>
<div style="position:absolute;left:80px;top:200px;width:600px;height:300px;background:#faf5ef;border-radius:8px"></div>
<div style="position:absolute;left:140px;top:400px;width:240px;height:48px;background:#0b1a4a;color:#fff;font:16px Arial;display:flex;align-items:center;justify-content:center">FOLLOW OUR PACK</div>
<div style="position:absolute;left:760px;top:220px;width:600px;height:480px;border:1px solid #d9d9dc;border-radius:6px"></div>
<div style="position:absolute;left:960px;top:205px;width:200px;height:30px;background:#fff;font:22px Arial;color:#0b1a4a;text-align:center">MEET THE PACK</div>
<svg style="position:absolute;left:280px;top:240px" width="44" height="40" viewBox="0 0 24 22"><path fill="#0b1a4a" d="M12 21l-1.5-1.4C5 14.6 2 11.8 2 8.4 2 5.6 4.2 3.4 7 3.4c1.6 0 3.1.7 4 1.9.9-1.2 2.4-1.9 4-1.9 2.8 0 5 2.2 5 5 0 3.4-3 6.2-8.5 11.2z"/></svg>
</body></html>`;

const READ = {
  number: 1,
  width: 1440,
  height: 900,
  background: "#ffffff",
  readBy: "vision",
  sections: [
    { name: "Top", top: 0, height: 120, background: "#0b1a4a" },
    { name: "Main", top: 120, height: 780, background: "#ffffff" },
  ],
  texts: [
    { text: "FOLLOW OUR PACK", x: 188, y: 414, w: 144, h: 20, size: 16, weight: 400, color: "#ffffff", font: null },
    { text: "MEET THE PACK", x: 980, y: 208, w: 160, h: 26, size: 22, weight: 400, color: "#0b1a4a", font: null },
  ],
  images: [],
};

async function drawDesign(): Promise<Buffer> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.setContent(DESIGN);
  const png = await page.screenshot();
  await context.close();
  return png;
}

async function uploadedDesign() {
  const admin = await seedAdmin(h);
  const id = await createProject(h.ctx, admin.viewer, { clientName: "Nora Happy Beagle Lady", trade: "photography", tier: "growth", lane: "lane_2", laneOption: "a", conceptCount: null, status: "mockups", memberUserIds: [] });
  const imageKey = `${projectStoragePrefix(id)}design-upload/v1/frames/page-1.png`;
  await getStorage().put(imageKey, await drawDesign(), "image/png");
  await getStorage().put(`${projectStoragePrefix(id)}design-upload/read-pages/page-1.json`, Buffer.from(JSON.stringify({ page: READ, notes: [] })), "application/json");
  // The design file the upload makes from its reads (the repair needs its sections, as the copies do).
  const file = uploadToFigmaFile([READ as never], "Nora.pdf", "upload-1");
  const frameId = file.document.children![0]!.children![0]!.id;
  const fileJsonKey = `${projectStoragePrefix(id)}design-upload/v1/design.json`;
  await getStorage().put(fileJsonKey, Buffer.from(JSON.stringify(file)), "application/json");
  await h.db.insert(figmaDesign).values({
    projectId: id,
    url: "upload",
    fileKey: "upload-1",
    source: "upload",
    importStatus: "done",
    importedVersion: "upload-1",
    fileJsonKey,
    readiness: checkReadiness(file),
    frames: [{ id: frameId, name: "Home", width: 1440, height: 900, isHome: true, imageKey, scale: 1 }],
  });
  return { admin, id, frameId };
}

const standInFonts = async () => [{ role: "sans" as const, family: "Arial", score: 0.9, alternatives: [{ family: "Lato", score: 0.85 }], weights: [400], files: [] }];

describe.skipIf(!hasChrome)("the style kit job, in a real browser", () => {
  it("builds the kit from the uploaded page for $0, stores its sheet and the page from the kit alone, and shows them", async () => {
    const { admin, id } = await uploadedDesign();
    const kitId = await startStyleKit(h.ctx, admin.viewer, id);
    expect(queued).toEqual([{ name: "style-kit", data: { kitId, projectId: id } }]);
    await expect(startStyleKit(h.ctx, admin.viewer, id)).rejects.toThrow("already being built");

    await runStyleKitJob(h.db as never, browser, { kitId, projectId: id }, { chooseFonts: standInFonts, fetchFont: async () => null });
    const [row] = await h.db.select().from(styleKit).where(eq(styleKit.id, kitId));
    expect(row!.status).toBe("done");
    const kit = row!.kit as StyleKit;
    expect(kit.parts.map((p) => p.kind).sort()).toEqual(expect.arrayContaining(["box", "button", "panel"]));
    expect(kit.icons.length).toBeGreaterThanOrEqual(1);
    expect(kit.notes.join(" ")).toContain("Arial (400) couldn't be fetched");
    expect(row!.previewFidelity).toBeGreaterThan(85);
    expect(await getStorage().get(row!.sheetKey!)).not.toBeNull();
    expect((await h.db.select().from(activityLog).where(eq(activityLog.action, "design.style_kit_built"))).length).toBe(1);

    const view = (await loadStyleKit(h.db, id, admin.viewer))!;
    expect(view).toMatchObject({ status: "done", outOfDate: false, canBuild: true });
    expect(view.fonts[0]).toMatchObject({ family: "Arial", alternatives: ["Lato"], fetched: false });
    const card = renderToStaticMarkup(<StyleKitCard projectId={id} view={view} />);
    expect(card).toContain("Style kit");
    expect(card).toContain("Build it again ($0)");
    expect(card).toContain("The home page put together from the kit alone: matches the design");
    expect(card).toContain("Its file couldn’t be fetched");

    // The copy's builder gets the kit and the page's inventory.
    const forCopy = (await loadKitForCopy(h.db as never, { projectId: id, designVersion: "upload-1", frameId: ((await h.db.select().from(figmaDesign))[0]!.frames as { id: string }[])[0]!.id }))!;
    expect(forCopy.inventory.sections).toHaveLength(2);
    expect(await loadKitForCopy(h.db as never, { projectId: id, designVersion: "upload-2", frameId: "x" })).toBeNull();

    // A copy that leaves out the panel and draws the words in the wrong font fails the check, by name.
    const plans = planPage(forCopy.kit, forCopy.inventory);
    const button = forCopy.kit.map[forCopy.inventory.sections[1]!.elements.find((e) => e.kind === "button")!.id];
    const box = forCopy.kit.map[forCopy.inventory.sections[1]!.elements.find((e) => e.kind === "box")!.id];
    const html = applyKit(
      `<html><head></head><body><section data-figma-section="1" style="height:120px;background:#0b1a4a"></section><section data-figma-section="2" style="font-family:'Times New Roman'"><div class="${box}"><p class="kit-box-title">MEET THE PACK</p></div><a class="${button}">FOLLOW OUR PACK</a></section></body></html>`,
      forCopy.kit,
      forCopy.css,
    ).html;
    const misses = describeMisses(await runElementCheck(browser, html, plans));
    expect(misses.some((m) => /^Main: the coloured panel \(kit-panel-1\) is missing\.$/.test(m))).toBe(true);
    expect(misses.some((m) => m.startsWith("Main: the icon") && m.endsWith("is missing."))).toBe(true);
    expect(misses).toContain('Main: the text "MEET THE PACK" is in the wrong font (Times New Roman instead of Arial).');
  }, 120_000);

  it("lets the designer swap a font for a matched one (building the kit again), not for any font, and not for Content", async () => {
    const { admin, id } = await uploadedDesign();
    const first = await startStyleKit(h.ctx, admin.viewer, id);
    await runStyleKitJob(h.db as never, browser, { kitId: first, projectId: id }, { chooseFonts: standInFonts, fetchFont: async () => null });
    const designer = await seedUser(h, admin.viewer, { email: "designer@velocitymedialab.com", roles: ["web_designer"] });
    const content = await seedUser(h, admin.viewer, { email: "content@velocitymedialab.com", roles: ["content"] });
    await expect(setKitFont(h.ctx, content.viewer, id, "sans", "Lato")).rejects.toBeInstanceOf(PermissionError);
    await expect(setKitFont(h.ctx, designer.viewer, id, "sans", "Comic Sans MS")).rejects.toBeInstanceOf(StyleKitError);
    const second = await setKitFont(h.ctx, designer.viewer, id, "sans", "Lato");
    const [row] = await h.db.select().from(styleKit).where(eq(styleKit.id, second));
    expect(row).toMatchObject({ status: "queued", fontOverrides: { sans: "Lato" } });
    const [logged] = await h.db.select().from(activityLog).where(eq(activityLog.action, "design.style_kit_font_changed"));
    expect(logged).toMatchObject({ valueBefore: { role: "sans", family: "Arial" }, valueAfter: { role: "sans", family: "Lato" } });
  }, 120_000);
});

describe.skipIf(!hasChrome)("the kit repair, in a real browser", () => {
  it("puts the kit's panel, box, button and icon into a plain copy for $0, checks it again, and lists what's left with its price", async () => {
    const { admin, id, frameId } = await uploadedDesign();
    const kitId = await startStyleKit(h.ctx, admin.viewer, id);
    await runStyleKitJob(h.db as never, browser, { kitId, projectId: id }, { chooseFonts: standInFonts, fetchFont: async () => null });
    await expect(repairCopies(h.ctx, admin.viewer, id)).rejects.toThrow("no finished copies");

    // A plain copy: the words and layout, no panel, no box, a plain button, no icon, the title in another font.
    const plain = `<!doctype html><html><head><style>body{margin:0;min-width:1440px;font-family:Arial}</style></head><body>
<header data-figma-section="1" style="height:120px;background:#0b1a4a"></header>
<main data-figma-section="2" style="height:780px;position:relative">
<div style="position:absolute;left:80px;top:80px;width:600px;height:300px"><p style="margin:60px 0 0 60px">&nbsp;</p><a style="position:absolute;left:60px;top:200px;width:240px;height:48px;background:#0b1a4a;color:#fff;display:flex;align-items:center;justify-content:center">FOLLOW OUR PACK</a></div>
<div style="position:absolute;left:760px;top:100px;width:600px;height:480px"><h2 style="font:22px 'Times New Roman';color:#0b1a4a;text-align:center;margin:0">MEET THE PACK</h2></div>
</main></body></html>`;
    const base = `${projectStoragePrefix(id)}figma/copies/original/`;
    await getStorage().put(`${base}source.html`, Buffer.from(plain), "text/html");
    const [original] = await h.db
      .insert(designCopy)
      .values({ projectId: id, figmaVersion: "upload-1", frameId, frameName: "Home", status: "done", sourceKey: `${base}source.html`, htmlKey: `${base}page.html` })
      .returning();
    expect(await repairCopies(h.ctx, admin.viewer, id)).toBe(1);
    const job = queued.find((q) => q.name === "copy-repair")!;
    const repairId = (job.data as { copyId: string }).copyId;
    await expect(repairCopies(h.ctx, admin.viewer, id)).rejects.toThrow("still being built or repaired");

    await runCopyRepairJob(h.db as never, browser, job.data as never);
    const [row] = await h.db.select().from(designCopy).where(eq(designCopy.id, repairId));
    expect(row!.repairOf).toBe(original!.id);
    expect(["done", "needs_cleanup"]).toContain(row!.status);
    const page = (await getStorage().get(row!.sourceKey!))!.toString("utf8");
    const kit = (await h.db.select().from(styleKit))[0]!.kit as StyleKit;
    const panel = kit.parts.find((p) => p.kind === "panel")!.className;
    const button = kit.parts.find((p) => p.kind === "button")!.className;
    expect(page).toContain(panel);
    expect(page).toContain(button);
    expect(page).toContain("data-kit-icon=");
    expect(page).toContain("var(--kit-font-sans)");
    expect(page).not.toContain("tawd-asset.invalid");
    const checks = row!.checks as { repair: { before: number; after: number; report: { placed: unknown[] }; paid: { name: string }[] }; elements: unknown };
    expect(checks.repair.report.placed.length).toBeGreaterThanOrEqual(3);
    expect(checks.elements).toBeTruthy();

    const summary = (await loadRepairSummary(h.db, id))!;
    expect(summary.repaired).toHaveLength(1);
    expect(summary.perSection).toMatchObject({ measured: false });
    expect(summary.paid.length).toBe(checks.repair.paid.length);
    expect(summary.total).toBeCloseTo(summary.paid.length * (await sectionRebuildCost(h.db)).cost, 5);
    const card = renderToStaticMarkup(<StyleKitCard projectId={id} view={(await loadStyleKit(h.db, id, admin.viewer))!} repair={summary} hasCopies />);
    expect(card).toContain("Repair the copies with the kit");
    expect(card).toContain("Repair them again ($0)");
    expect(card).toMatch(summary.paid.length ? /needs? a paid rebuild, about \$[0-9.]+ each/ : /nothing needs a paid rebuild/);
    const content = await seedUser(h, admin.viewer, { email: "content2@velocitymedialab.com", roles: ["content"] });
    await expect(repairCopies(h.ctx, content.viewer, id)).rejects.toBeInstanceOf(PermissionError);
  }, 180_000);
});

describe.skipIf(!hasChrome)("filling a page from one that shares its layout, in a real browser", () => {
  it("puts the second page's words and photo into the first page's copy for $0, and keeps it only if it is no worse", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Nora", trade: "photography", tier: "growth", lane: "lane_2", laneOption: "a", conceptCount: null, status: "mockups", memberUserIds: [] });
    const page = (n: number, name: string, photo: string) => ({
      ...READ,
      number: n,
      texts: [
        { text: `MEET ${name}`, x: 188, y: 414, w: 144, h: 20, size: 16, weight: 400, color: "#ffffff", font: null },
        { text: `${name} is part of the pack`, x: 980, y: 208, w: 260, h: 26, size: 22, weight: 400, color: "#0b1a4a", font: null },
      ],
      images: [{ ref: photo, x: 760, y: 300, w: 300, h: 200, kind: "photo" as const }],
    });
    const pages = [page(1, "POPPY", "poppy-photo"), page(2, "SCOUT", "scout-photo")];
    const file = uploadToFigmaFile(pages as never, "Nora.pdf", "upload-1");
    const frames = file.document.children![0]!.children!.map((f, i) => ({ id: f.id, name: i === 0 ? "Poppy" : "Scout", width: 1440, height: 900, isHome: i === 0, imageKey: `${projectStoragePrefix(id)}frames/page-${i + 1}.png`, scale: 1 }));
    const png = await drawDesign();
    for (const f of frames) await getStorage().put(f.imageKey, png, "image/png");
    const imageFiles: Record<string, string> = {};
    for (const ref of ["poppy-photo", "scout-photo"]) {
      imageFiles[ref] = `${projectStoragePrefix(id)}images/${ref}.png`;
      await getStorage().put(imageFiles[ref]!, png, "image/png");
    }
    const fileJsonKey = `${projectStoragePrefix(id)}design.json`;
    await getStorage().put(fileJsonKey, Buffer.from(JSON.stringify(file)), "application/json");
    await h.db.insert(figmaDesign).values({ projectId: id, url: "upload", fileKey: "u", source: "upload", importStatus: "done", importedVersion: "upload-1", fileJsonKey, readiness: checkReadiness(file), frames, imageFiles });
    await h.db.insert(styleKit).values({ projectId: id, designVersion: "upload-1", status: "done", kit: { version: 1, colors: [], fonts: [], parts: [], icons: [], map: {}, notes: [], sharedLayouts: [{ pages: frames.map((f) => f.id), agreement: 90 }] } });

    await expect(fillFromTemplates(h.ctx, admin.viewer, id)).rejects.toThrow("needs a finished copy");
    const base = `${projectStoragePrefix(id)}figma/copies/poppy/`;
    const miaCopy = `<!doctype html><html><head></head><body style="margin:0;min-width:1440px"><header data-figma-section="1" style="height:120px;background:#0b1a4a"></header><main data-figma-section="2" style="height:780px;position:relative"><a style="position:absolute;left:140px;top:280px">MEET POPPY</a><h2 style="position:absolute;left:900px;top:80px;margin:0">POPPY is part of the pack</h2><img src="tawd-asset:design-image-1" alt="Poppy" style="position:absolute;left:760px;top:180px;width:300px;height:200px"></main></body></html>`;
    await getStorage().put(`${base}source.html`, Buffer.from(miaCopy), "text/html");
    await h.db.insert(designCopy).values({ projectId: id, figmaVersion: "upload-1", frameId: frames[0]!.id, frameName: "Poppy", status: "done", sourceKey: `${base}source.html`, htmlKey: `${base}page.html` });

    expect(await fillFromTemplates(h.ctx, admin.viewer, id)).toBe(1);
    const job = queued.find((q) => q.name === "template-fill")!;
    await runTemplateFillJob(h.db as never, browser, job.data as never);
    const [filled] = await h.db.select().from(designCopy).where(eq(designCopy.id, (job.data as { copyId: string }).copyId));
    expect(filled).toMatchObject({ frameName: "Scout", status: "done" });
    const source = (await getStorage().get(filled!.sourceKey!))!.toString("utf8");
    expect(source).toContain("MEET SCOUT");
    expect(source).toContain("SCOUT is part of the pack");
    expect(source).not.toContain("POPPY");
    expect(source).toContain("tawd-asset:design-image-1");
    const summary = (await loadRepairSummary(h.db, id))!;
    expect(summary.repaired[0]).toMatchObject({ page: "Scout", filledFrom: "Poppy", placed: 2 });
    expect((await h.db.select().from(activityLog).where(eq(activityLog.action, "design.copy_filled"))).length).toBe(1);

    // A second fill no better than the page's copy now is dropped, and the page keeps its copy.
    const dakotaNow = filled!.id;
    await h.db.update(designCopy).set({ fidelity: { overall: 100, sections: [], method: "page", designHeight: 1, copyHeight: 1 } }).where(eq(designCopy.id, dakotaNow));
    queued = [];
    await fillFromTemplates(h.ctx, admin.viewer, id);
    await runTemplateFillJob(h.db as never, browser, queued[0]!.data as never);
    expect((await h.db.select().from(designCopy).where(eq(designCopy.frameId, frames[1]!.id))).map((c) => c.id)).toEqual([dakotaNow]);
    expect((await h.db.select().from(activityLog).where(eq(activityLog.action, "design.copy_fill_dropped"))).length).toBe(1);
  }, 180_000);
});

describe.skipIf(!hasChrome)("phone versions by code, in a real browser", () => {
  const SITE = `<!doctype html><html><head><title>Nora: Home</title><style>body{margin:0;min-width:1440px;font-family:Arial}</style></head><body>
<header data-figma-section="1" style="height:120px;background:#0b1a4a;color:#fff;display:flex;align-items:center;gap:40px;padding:0 30px"><p style="margin:0;font-size:28px">Real life with five Beagles.</p></header>
<nav data-figma-section="2" style="height:72px;display:flex;align-items:center;gap:60px;padding:0 40px"><span>HOME</span><span>MEET THE PACK</span><span>BEAGLE TALK</span><span>ABOUT</span></nav>
<section data-figma-section="3" style="height:600px;display:flex;gap:30px;padding:40px">${["Biscuit", "Poppy", "Scout", "Maple"].map((d) => `<div style="width:300px"><div style="height:200px;background:#ccc"></div><p style="font-size:44px;margin:10px 0">${d}</p><a href="#" style="background:#0b1a4a;color:#fff;padding:4px 10px;font-size:14px">MEET ${d.toUpperCase()}</a></div>`).join("")}</section>
<footer data-figma-section="4" style="height:260px;background:#00153a;color:#fff;display:flex;gap:80px;padding:30px 60px"><div><p style="font-weight:700">EXPLORE</p><p>Home<br>Beagle Talk<br>About</p></div><div><p style="font-weight:700">MEET THE PACK</p><p>Biscuit<br>Poppy<br>Scout<br>Maple</p></div><p>\u00a9 2026 NoraHappyBeagleLady.</p></footer>
</body></html>`;

  it("reads the shared phone header and footer from the home page, turns the layout into phone rules, and checks it at 390px", async () => {
    const pages = [{ name: "Home", slug: "" }, { name: "Meet the Pack", slug: "meet-the-pack" }, { name: "Biscuit", slug: "biscuit" }, { name: "Poppy", slug: "poppy" }, { name: "Beagle Talk", slug: "beagle-talk" }, { name: "About", slug: "about" }];
    const shell = await readShell(browser, SITE, pages, [{ label: "Privacy policy", href: "/privacy/" }]);
    expect(shell.headerSections).toEqual([1, 2]);
    expect(shell.footerSections).toEqual([4]);
    expect(shell.tagline).toBe("Real life with five Beagles.");
    expect(shell.menu.map((m) => [m.label, m.href])).toEqual([["HOME", "/"], ["MEET THE PACK", "/meet-the-pack/"], ["BEAGLE TALK", "/beagle-talk/"], ["ABOUT", "/about/"]]);
    expect(shell.menu[1]!.children!.map((c) => c.href)).toEqual(["/biscuit/", "/poppy/", "#", "#"]);
    expect(shell.footerColumns.map((c) => c.title)).toEqual(["EXPLORE", "MEET THE PACK"]);
    expect(shell.footerNote).toContain("2026 NoraHappyBeagleLady");

    const rules = await phoneRules(browser, SITE);
    expect(rules.css).toContain("@media (max-width:767px)");
    expect(rules.css).toContain("grid-template-columns:repeat(2,minmax(0,1fr))");
    const { header, footer } = phoneShellHtml(shell, "/poppy/");
    expect(header).toContain('<a href="/poppy/" aria-current="page">Poppy</a>');
    expect(header).toContain('<details class="tawd-m-sub" open>');
    const phone = insertMobileCss(rules.html, rules.css).replace(/<body([^>]*)>/i, `<body$1>${header}`).replace(/<\/body>/i, `${footer}</body>`).replace(/<\/head>/i, `<style>${phoneShellCss(shell)}</style></head>`);
    const check = await phoneCheck(browser, phone);
    expect(check.problems.filter((p) => p.kind === "sideways scrolling")).toEqual([]);
    expect(check.problems.filter((p) => p.kind === "small tap target")).toEqual([]);
    // The unfixed page, drawn on a phone, scrolls sideways and has small buttons: the check says so.
    const before = await phoneCheck(browser, SITE);
    expect(before.problems.map((p) => p.kind)).toEqual(expect.arrayContaining(["sideways scrolling", "small tap target"]));
  }, 120_000);
});

describe("the style kit before a design is read", () => {
  it("says to upload and read the design first", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Nora", trade: "photography", tier: "growth", lane: "lane_2", laneOption: "a", conceptCount: null, status: "mockups", memberUserIds: [] });
    await expect(startStyleKit(h.ctx, admin.viewer, id)).rejects.toThrow("Upload and read the design first");
    expect(await loadStyleKit(h.db, id, admin.viewer)).toBeNull();
  });
});
