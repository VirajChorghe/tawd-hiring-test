import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, designCopy, figmaDesign } from "@tawd/core/schema";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { DESIGN_MOBILE_JOB, FAITHFUL_COPY_JOB } from "@tawd/core/queue";
import { PermissionError } from "@tawd/core/permissions";
import { MobileCssError, baseName, checkPages, frameRole, insertMobileCss, proposePages, readMobileCss } from "@tawd/core/figma";
import { exactPage, homeParts, pageMeta, simpleExactPage } from "@tawd/core/site";
import { createProject } from "@/lib/projects";
import { setQueueForTesting } from "@/lib/mockups";
import { confirmDesignPages, decideMobile, loadExactDesign, startExactCopies, startMobileVersions } from "@/lib/exact-design";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

/*
  Lane 2, Option A, "build it exactly" (28 September 2026), part 3a: the
  design's pages, confirmed, and every page copied.
*/

let h: Harness;
let queued: { name: string; data: never }[];

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
  { id: "1:2", name: "About_Us", width: 1440, height: 2600, isHome: false, imageKey: "k/about.png", scale: 1 },
  { id: "1:3", name: "Home - Mobile", width: 390, height: 6200, isHome: false, imageKey: "k/home-m.png", scale: 1 },
  { id: "1:4", name: "Services & Pricing", width: 1440, height: 3000, isHome: false, imageKey: "k/services.png", scale: 1 },
];

describe("the design's pages", () => {
  it("tells mobile frames from desktop ones, pairs them by name, and proposes each page's address", () => {
    expect(frameRole(FRAMES[2]!)).toBe("mobile");
    // A phone screenshot uploaded at 3x is about 1170 pixels wide.
    expect(frameRole({ ...FRAMES[1]!, name: "About (phone)", width: 1170 })).toBe("mobile");
    expect(frameRole(FRAMES[1]!)).toBe("desktop");
    // At a desktop width the words are the page's name, not a phone version (13 October 2026).
    for (const name of ["Phone Repair", "Small Business Plans", "Mobile Detailing", "SM Plumbing"]) {
      expect(frameRole({ ...FRAMES[1]!, name }), name).toBe("desktop");
    }
    expect(proposePages([...FRAMES, { ...FRAMES[1]!, id: "1:5", name: "Phone Repair" }]).map((p) => p.name)).toContain("Phone Repair");
    expect(baseName("Home - Mobile")).toBe(baseName("Home"));

    const pages = proposePages(FRAMES);
    expect(pages.map((p) => [p.name, p.slug, p.isHome, p.mobileFrameId])).toEqual([
      ["Home", "", true, "1:3"],
      ["About Us", "about-us", false, null],
      ["Services & Pricing", "services-and-pricing", false, null],
    ]);
    expect(checkPages([{ name: "Home", slug: "", isHome: true }, { name: "About", slug: "About Us", isHome: false }])).toContain("lower-case");
    expect(checkPages([{ name: "Home", slug: "", isHome: true }, { name: "A", slug: "a", isHome: false }, { name: "B", slug: "a", isHome: false }])).toContain("same address");
  });
});

describe("building an Option A design exactly", () => {
  async function optionA(laneOption: "a" | "b" = "a") {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Nora Happy Beagle Lady", trade: "photography", tier: "growth", lane: "lane_2", laneOption, conceptCount: laneOption === "a" ? null : 1, status: "mockups", memberUserIds: [] });
    await h.db.insert(figmaDesign).values({ projectId: id, url: "upload", fileKey: "upload-1", source: "upload", importStatus: "done", importedVersion: "upload-1", frames: FRAMES });
    return { admin, id };
  }

  it("proposes the pages once, lets the PM rename them, and copies every page after they're confirmed", async () => {
    const { admin, id } = await optionA();
    let view = await loadExactDesign(h.db, id);
    expect(view.pages.map((p) => [p.name, p.mobileFrameName])).toEqual([
      ["Home", "Home - Mobile"],
      ["About Us", null],
      ["Services & Pricing", null],
    ]);
    expect(view.confirmed).toBe(false);
    expect(view.mobileFrames).toBe(1);
    await expect(startExactCopies(h.ctx, admin.viewer, id)).rejects.toThrow("Confirm the pages first");

    const [, about, services] = view.pages;
    await expect(confirmDesignPages(h.ctx, admin.viewer, id, [{ id: about!.id, name: "About", slug: "about me" }])).rejects.toThrow("lower-case");
    await confirmDesignPages(h.ctx, admin.viewer, id, [
      { id: about!.id, name: "About Nora", slug: "about" },
      { id: services!.id, name: "Services", slug: "services" },
    ]);
    view = await loadExactDesign(h.db, id);
    expect(view.confirmed).toBe(true);
    expect(view.pages.map((p) => p.slug)).toEqual(["", "about", "services"]);
    expect(view.toBuild).toBe(3);
    expect(view.estimate.label).toContain("for 3 pages");

    expect(await startExactCopies(h.ctx, admin.viewer, id)).toBe(3);
    expect(queued.map((q) => q.name)).toEqual([FAITHFUL_COPY_JOB, FAITHFUL_COPY_JOB, FAITHFUL_COPY_JOB]);
    const copies = await h.db.select().from(designCopy).where(eq(designCopy.projectId, id));
    expect(copies.map((c) => c.frameName).sort()).toEqual(["About_Us", "Home", "Services & Pricing"]);
    await expect(startExactCopies(h.ctx, admin.viewer, id)).rejects.toThrow("already being copied");

    // A page scored against its frame shows its match and its lowest section.
    await h.db.update(designCopy).set({ status: "done", fidelity: { overall: 93, sections: [{ name: "Hero", score: 97 }, { name: "Gallery", score: 84 }], method: "sections", designHeight: 4200, copyHeight: 4180 } }).where(eq(designCopy.frameId, "1:1"));
    view = await loadExactDesign(h.db, id);
    expect(view.pages[0]!.copy).toMatchObject({ overall: 93, lowest: { name: "Gallery", score: 84 } });
    const actions = (await h.db.select().from(activityLog).where(eq(activityLog.entityId, id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["design.pages_confirmed", "design.exact_copies_started"]));
  });

  it("is for Option A only", async () => {
    const { admin, id } = await optionA("b");
    const view = await loadExactDesign(h.db, id);
    await expect(confirmDesignPages(h.ctx, admin.viewer, id, [{ id: view.pages[0]!.id, name: "Home", slug: "" }])).rejects.toThrow("Option A");
  });
});

describe("the phone versions", () => {
  it("takes CSS for phones only, and never anything that loads or changes the desktop page", () => {
    const css = readMobileCss("```css\n@media (max-width: 767px) { .hero { display: block; } .nav a { min-height: 44px; } }\n```");
    expect(css).toContain(".hero");
    expect(() => readMobileCss(".hero { display: none; }")).toThrow(MobileCssError);
    expect(() => readMobileCss("@media (max-width: 767px) { .a { color: red; } } .b { color: blue; }")).toThrow("outside the phone");
    expect(() => readMobileCss("@media (max-width: 767px) { .a { background: url(https://x.example/a.png); } }")).toThrow("outside address");
    // Escaped or wrapped addresses are caught as the browser would read them (13 October 2026).
    expect(() => readMobileCss(String.raw`@media (max-width: 767px) { .a { background: u\72l(\68ttps://x.example/a.png); } }`)).toThrow("outside address");
    expect(() => readMobileCss('@media (max-width: 767px) { .a { background-image: image-set("https://x.example/a.png" 1x); } }')).toThrow("outside address");
    // A string continuation can't hide an address, and an impossible escape fails as a MobileCssError, not a crash (CodeRabbit, PR #13).
    expect(() => readMobileCss('@media (max-width: 767px) { .a { background: url("ht\\\ntps://x.example/a.png"); } }')).toThrow("outside address");
    expect(readMobileCss(String.raw`@media (max-width: 767px) { .q::before { content: "\FFFFFF"; } }`)).toContain("FFFFFF");
    // A harmless escape (a curly quote in content) still passes, unchanged.
    expect(readMobileCss(String.raw`@media (max-width: 767px) { .q::before { content: "\201C"; } }`)).toContain(String.raw`\201C`);
    const once = insertMobileCss("<html><head><style>.a{}</style></head><body></body></html>", css);
    const twice = insertMobileCss(once, css);
    expect(twice.match(/data-tawd-mobile/g)).toHaveLength(1);
    expect(twice).toContain("</style>\n</head>");
  });

  it("are made for copied pages, estimate first, and the designer decides on responsive ones", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Nora", trade: "photography", tier: "growth", lane: "lane_2", laneOption: "a", conceptCount: null, status: "mockups", memberUserIds: [] });
    await h.db.insert(figmaDesign).values({ projectId: id, url: "upload", fileKey: "upload-1", source: "upload", importStatus: "done", importedVersion: "upload-1", frames: FRAMES });
    const view = await loadExactDesign(h.db, id);
    await confirmDesignPages(h.ctx, admin.viewer, id, view.pages.map((p) => ({ id: p.id, name: p.name, slug: p.slug })));
    await startExactCopies(h.ctx, admin.viewer, id);
    await expect(startMobileVersions(h.ctx, admin.viewer, id)).rejects.toThrow("Copy the pages first");
    await h.db.update(designCopy).set({ status: "done", sourceKey: "k/source.html" }).where(eq(designCopy.projectId, id));
    queued = [];
    expect((await loadExactDesign(h.db, id)).mobileEstimate.label).toContain("for 3 pages");
    expect(await startMobileVersions(h.ctx, admin.viewer, id)).toBe(3);
    expect(queued.map((q) => q.name)).toEqual([DESIGN_MOBILE_JOB, DESIGN_MOBILE_JOB, DESIGN_MOBILE_JOB]);

    const [home, about] = (await loadExactDesign(h.db, id)).pages;
    await h.db.update(designCopy).set({ mobileStatus: "done", mobileFrom: "mobile frame" }).where(eq(designCopy.id, home!.copy!.id));
    await h.db.update(designCopy).set({ mobileStatus: "done", mobileFrom: "responsive" }).where(eq(designCopy.id, about!.copy!.id));
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    const designer = await seedUser(h, admin.viewer, { email: "designer@velocitymedialab.com", roles: ["web_designer"] });
    await expect(decideMobile(h.ctx, pm.viewer, id, about!.copy!.id, { decision: "accepted", note: "" })).rejects.toBeInstanceOf(PermissionError);
    await expect(decideMobile(h.ctx, designer.viewer, id, home!.copy!.id, { decision: "accepted", note: "" })).rejects.toThrow("mobile frame");
    await expect(decideMobile(h.ctx, designer.viewer, id, about!.copy!.id, { decision: "pushed_back", note: "" })).rejects.toThrow("what should change");
    await decideMobile(h.ctx, designer.viewer, id, about!.copy!.id, { decision: "pushed_back", note: "Stack the gallery in one column" });
    expect((await loadExactDesign(h.db, id)).pages[1]!.copy!.mobile.decision).toBe("pushed_back");
  });
});

describe("an exact page", () => {
  it("gets TAWD's title, description and head, the forms, the privacy links and the banner, and keeps the design", () => {
    const design = `<!doctype html><html><head><title>Old</title><meta name="description" content="Old"><style>.hero{}</style></head><body><header>Menu</header><section class="hero"><h1>Nora</h1><form><input name="email"></form></section><footer>Nora &copy; 2026</footer></body></html>`;
    expect(pageMeta(design)).toEqual({ title: "Old", description: "Old" });
    const page = exactPage({ html: design, title: "Nora | Photography", description: "Dogs in the snow.", head: '<link rel="canonical" href="https://nora.example/" />', footerEnd: '<p class="tawd-privacy">Privacy</p>', bodyEnd: '<div id="tawd-consent"></div>', transform: (h) => h.replace("<form>", '<form data-netlify="true">') });
    expect(page).toContain("<title>Nora | Photography</title>");
    expect(page).not.toContain("<title>Old</title>");
    expect(page).toContain('<meta name="description" content="Dogs in the snow." />');
    expect(page).toContain('<form data-netlify="true">');
    expect(page).toContain('<p class="tawd-privacy">Privacy</p></footer>');
    expect(page).toContain('<div id="tawd-consent"></div>\n</body>');
    expect(page).toContain('<section class="hero"><h1>Nora</h1>');
    const parts = homeParts(design);
    expect(parts.header).toBe("<header>Menu</header>");
    expect(parts.footer).toBe("<footer>Nora &copy; 2026</footer>");
    expect(simpleExactPage(parts, "<h1>Thank you</h1>", ".x{}")).toContain("<header>Menu</header>\n<main><h1>Thank you</h1></main>");
  });
});
