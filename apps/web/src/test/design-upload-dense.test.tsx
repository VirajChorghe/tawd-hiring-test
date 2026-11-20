import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignUploadJobData } from "@tawd/core/queue";

/*
  Dense design pages (27 September 2026). A client's 9-page PDF failed on page
  1: "The reply didn't describe the page's sections, text and pictures."
  A page is now read in overlapping slices, one call each, joined back up;
  the reader forgives what it can; the screen shows the progress and, on a
  failure, the reason. Stand-ins for Chromium and Claude, no AI spending.
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
import { aiCall, figmaDesign, intakeFile } from "@tawd/core/schema";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { VISION_LIMITS, joinVisionSlices, readVisionReply, salvageJson, toHex, visionSliceCount, visionSlices } from "@tawd/core/figma";
import { createProject } from "@/lib/projects";
import { setQueueForTesting } from "@/lib/mockups";
import { planDesignUpload, startDesignUpload } from "@/lib/design-upload";
import { figmaBadge, figmaSectionView, loadFigmaDesign } from "@/lib/figma";
import { FigmaSection } from "@/components/intake/figma-section";

import { markDesignUploadFailed, runDesignUploadJob } from "../../../worker/src/design-upload";
import type { WorkerConfig } from "../../../worker/src/config";

import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2, fakeClaude, messageText, turn } from "./worker-fakes";

let h: Harness;
let r2: FakeR2;
let queued: { name: string; data: never }[];

const config: WorkerConfig = {
  databaseUrl: "unused",
  redisUrl: "unused",
  anthropicApiKey: "unused",
  model: "claude-opus-5-5",
  skillsDir: path.resolve(__dirname, "../../../../skills"),
  effort: "high",
};

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  r2 = new FakeR2();
  setStorageForTesting(r2);
  queued = [];
  setQueueForTesting({ add: async (name, data) => void queued.push({ name, data: data as never }), getJob: async () => null });
});

afterEach(async () => {
  setQueueForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

const text = (words: string, y: number, extra: Record<string, unknown> = {}) => ({ text: words, x: 80, y, w: 400, h: 40, size: 32, weight: 700, color: "#111111", font: null, ...extra });

describe("the forgiving reader", () => {
  it("reads colours, numbers and weights in any common form, and skips (and counts) what has no position", () => {
    const reply = [
      "Here is the page:",
      "```json",
      JSON.stringify({
        page: {
          background: "#FFF",
          sections: [{ name: "Cards", top: "0", height: "1800px", background: "rgb(245, 240, 232)" }],
          texts: [text("Beagle portraits", 40, { color: "white", weight: "bold", size: "40px" }), { text: "no box" }, text("Book a session", 200, { color: "#11223344" })],
          images: [{ x: 10, y: 10, w: 300, h: 200, kind: "illustration" }, { x: 5, kind: "photo" }],
        },
      }),
      "```",
    ].join("\n");
    const read = readVisionReply(reply, { width: 1440, height: 1800 });
    expect(read.background).toBe("#ffffff");
    expect(read.sections).toEqual([{ name: "Cards", top: 0, height: 1800, background: "#f5f0e8" }]);
    expect(read.texts.map((t) => [t.text, t.color, t.weight, t.size])).toEqual([
      ["Beagle portraits", "#ffffff", 700, 40],
      ["Book a session", "#112233", 700, 32],
    ]);
    expect(read.images).toEqual([{ x: 10, y: 10, w: 300, h: 200, kind: "photo" }]);
    expect(read.notes).toEqual(["1 piece of text with no position was skipped.", "1 picture with no box was skipped."]);
    expect([toHex("#abc"), toHex("rgba(0,0,0,0.5)"), toHex("transparent"), toHex(12)]).toEqual(["#aabbcc", "#000000", null, null]);
  });

  it("keeps a dense page (the old limit was 400 pieces of text and 80 pictures)", () => {
    const texts = Array.from({ length: 450 }, (_, i) => text(`Card ${i + 1}`, i * 3));
    const images = Array.from({ length: 120 }, (_, i) => ({ x: 0, y: i * 10, w: 100, h: 80, kind: "photo" }));
    const read = readVisionReply(JSON.stringify({ background: "#ffffff", sections: [], texts, images }), { width: 1440, height: 1800 });
    expect(read.texts).toHaveLength(450);
    expect(read.images).toHaveLength(120);
    expect(read.notes).toEqual([]);
    const huge = readVisionReply(JSON.stringify({ background: "#ffffff", sections: [], texts: Array.from({ length: VISION_LIMITS.texts + 5 }, (_, i) => text(`T${i}`, 1)), images: [] }), { width: 1440, height: 1800 });
    expect(huge.texts).toHaveLength(VISION_LIMITS.texts);
    expect(huge.notes).toEqual([`Only the first ${VISION_LIMITS.texts} of ${VISION_LIMITS.texts + 5} pieces of text are kept.`]);
  });

  it("salvages a reply cut off at the output limit up to its last whole item", () => {
    const whole = JSON.stringify({ background: "#ffffff", sections: [{ name: "Hero", top: 0, height: 600, background: "#ffffff" }], texts: [text("One", 10), text("Two", 60), text("Three", 110)], images: [] });
    const cut = whole.slice(0, whole.indexOf('"Three"') + 4);
    expect(salvageJson(cut)).toMatchObject({ texts: [{ text: "One" }, { text: "Two" }] });
    const read = readVisionReply(cut, { width: 1440, height: 1800 });
    expect(read.texts.map((t) => t.text)).toEqual(["One", "Two"]);
    expect(read.notes).toEqual(["The reply was cut off at the output limit; what came before the cut is kept."]);
  });

  it("gives up only when there is nothing usable", () => {
    expect(() => readVisionReply("I can't see the picture clearly.", { width: 1, height: 1 })).toThrow("The reply had no JSON object.");
    expect(() => readVisionReply('{"description": "a page"}', { width: 1, height: 1 })).toThrow("didn't describe the page's sections, text and pictures");
    expect(() => readVisionReply('{"texts": [], "sections": [], "images": []}', { width: 1, height: 1 })).toThrow("didn't describe");
  });
});

describe("the four replies that failed on 27 September", () => {
  // Real replies (the client's words and section names replaced): page 1's picture kinds, page 9's section colours.
  const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, "fixtures/design-read", `${name}.json`), "utf8")) as { reply: string; stopReason: string };

  it("reads each of them now, keeping what the old rules threw away", () => {
    for (const name of ["page1-try1", "page1-try2"]) {
      const { reply, stopReason } = fixture(name);
      expect(stopReason).toBe("end_turn");
      const read = readVisionReply(reply, { width: 1440, height: 2100 });
      expect(read.texts).toHaveLength(86);
      expect(read.images).toHaveLength(19);
      expect(read.notes).toEqual([]);
    }
    // "social icons" was an icon, "illustration" a photo; the old reader failed the page on them.
    const first = JSON.parse(fixture("page1-try1").reply) as { images: { kind: string }[] };
    const read1 = readVisionReply(fixture("page1-try1").reply, { width: 1440, height: 2100 });
    first.images.forEach((img, i) => {
      if (img.kind === "social icons") expect(read1.images[i]!.kind).toBe("icon");
      if (img.kind === "illustration") expect(read1.images[i]!.kind).toBe("photo");
    });
    expect(first.images.some((i) => i.kind === "social icons")).toBe(true);

    for (const name of ["page9-try1", "page9-try2"]) {
      const raw = JSON.parse(fixture(name).reply) as { sections: { color: string }[] };
      const read = readVisionReply(fixture(name).reply, { width: 1440, height: 2200 });
      expect(read.texts).toHaveLength(105);
      expect(read.images).toHaveLength(33);
      // The sections' colours came as "color", not "background": kept, not lost.
      expect(read.sections.map((s) => s.background)).toEqual(raw.sections.map((s) => s.color.toLowerCase()));
      expect(new Set(read.sections.map((s) => s.background)).size).toBeGreaterThan(1);
    }
  });
});

describe("the compact reply (27 September 2026)", () => {
  const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, "fixtures/design-read", `${name}.json`), "utf8")) as { reply: string };

  /* A long reply as the compact form the prompt now asks for: colours and fonts listed once, rows, defaults left out. */
  function toCompact(reply: string): string {
    const o = JSON.parse(reply) as { background: string; sections: Record<string, unknown>[]; texts: Record<string, unknown>[]; images: Record<string, unknown>[] };
    const c: string[] = [];
    const f: string[] = [];
    const ci = (v: unknown) => {
      const hex = String(v ?? "#000000").toLowerCase();
      if (!c.includes(hex)) c.push(hex);
      return c.indexOf(hex);
    };
    const r = (v: unknown) => Math.round(Number(v));
    const kind = (k: unknown) => (String(k).includes("logo") ? "l" : /icon/.test(String(k)) ? "i" : "p");
    return JSON.stringify({
      c,
      f,
      b: ci(o.background),
      s: o.sections.map((s) => [s.name, r(s.top), r(s.height), ci(s.background ?? s.color)]),
      t: o.texts.map((t) => {
        const row: unknown[] = [t.text, r(t.x), r(t.y), r(t.w), r(t.h), r(t.size), ci(t.color)];
        const font = typeof t.font === "string" && t.font ? t.font : null;
        if (font && !f.includes(font)) f.push(font);
        if (r(t.weight ?? 400) !== 400 || font) row.push(r(t.weight ?? 400));
        if (font) row.push(f.indexOf(font));
        return row;
      }),
      i: o.images.map((img) => [r(img.x), r(img.y), r(img.w), r(img.h), kind(img.kind)]),
    });
  }

  it("reads a client's four replies the same from the compact form, at under half the size", () => {
    let long = 0;
    let compact = 0;
    for (const name of ["page1-try1", "page1-try2", "page9-try1", "page9-try2"]) {
      const { reply } = fixture(name);
      const small = toCompact(reply);
      long += reply.length;
      compact += small.length;
      const slice = { width: 1440, height: 2200 };
      const a = readVisionReply(reply, slice);
      const b = readVisionReply(small, slice);
      expect(b.texts).toEqual(a.texts);
      expect(b.images).toEqual(a.images);
      expect(b.sections).toEqual(a.sections);
      expect(b.background).toEqual(a.background);
      expect(b.notes).toEqual([]);
    }
    // Measured on the real replies (with a client's own words in them): 45%.
    expect(compact / long).toBeLessThan(0.5);
  });

  it("salvages a compact reply cut off in the middle of its texts", () => {
    const small = toCompact(fixture("page1-try1").reply);
    const cut = small.slice(0, Math.floor(small.length * 0.6));
    const read = readVisionReply(cut, { width: 1440, height: 2200 });
    expect(read.texts.length).toBeGreaterThan(10);
    expect(read.notes).toEqual(["The reply was cut off at the output limit; what came before the cut is kept."]);
  });
});

describe("slices", () => {
  it("cuts a long page into overlapping slices and joins them back without reading the overlap twice", () => {
    expect(visionSlices(1500)).toEqual([{ top: 0, height: 1500, keepFrom: 0, keepTo: 1500 }]);
    const slices = visionSlices(4000);
    expect(slices).toEqual([
      { top: 0, height: 1800, keepFrom: 0, keepTo: 1740 },
      { top: 1680, height: 1800, keepFrom: 1740, keepTo: 3420 },
      { top: 3360, height: 640, keepFrom: 3420, keepTo: 4000 },
    ]);
    // A US Letter page drawn 1440 wide is 1864 tall: two slices. A long web page, several.
    expect(visionSliceCount(612, 792)).toBe(2);
    expect(visionSliceCount(1440, 9000)).toBe(6);

    const first = readVisionReply(JSON.stringify({ background: "#ffffff", sections: [{ name: "Cards", top: 200, height: 1600, background: "#f5f0e8" }], texts: [text("Top", 100), text("Seam", 1700)], images: [] }), { width: 1440, height: 1800 });
    // The next slice sees the same line near its top (1700 - 1680 = 20) and the band carrying on.
    const second = readVisionReply(JSON.stringify({ background: "#f5f0e8", sections: [{ name: "Cards", top: 0, height: 900, background: "#f5f0e8" }, { name: "Footer", top: 900, height: 900, background: "#222222" }], texts: [text("Seam", 20), text("Below", 500)], images: [{ x: 0, y: 300, w: 200, h: 200, kind: "photo" }] }), { width: 1440, height: 1800 });
    const { page, notes } = joinVisionSlices({ number: 2, width: 1440, height: 3480 }, [
      { slice: slices[0]!, read: first },
      { slice: { ...slices[1]!, keepTo: 3480 }, read: second },
    ]);
    expect(page.texts.map((t) => [t.text, t.y])).toEqual([
      ["Top", 100],
      ["Seam", 1700],
      ["Below", 2180],
    ]);
    expect(page.sections.map((s) => [s.name, s.top, s.height])).toEqual([
      ["Cards", 200, 2380],
      ["Footer", 2580, 900],
    ]);
    expect(page.images).toEqual([{ ref: "p2-img1", x: 0, y: 1980, w: 200, h: 200, kind: "photo" }]);
    expect(notes).toEqual([]);
  });
});

describe("reading a client's kind of design", () => {
  async function tallImageProject(height: number) {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Nora Happy Beagle Lady", trade: "photography", tier: "growth", lane: "lane_2", laneOption: "b", conceptCount: 1, status: "intake", memberUserIds: [] });
    const key = `projects/${id}/intake/home.png`;
    await r2.put(key, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x70, 0x6e, 0x67]));
    await h.db.insert(intakeFile).values({ projectId: id, kind: "design_file", storageKey: key, fileName: "home.png", contentType: "image/png", status: "ready" });
    const page = {
      // The page cap listens for close (locked-context.ts); a fake page gives its slot back at once.
      once: (_event: string, give: () => void) => give(),
      route: async () => undefined,
      setContent: async () => undefined,
      evaluate: async (_fn: unknown, arg: Record<string, unknown>) => {
        if ("boxes" in arg) return (arg.boxes as unknown[]).map(() => "data:image/png;base64,iVBORw0KGgo=");
        return { width: 1440, height, png: "data:image/png;base64,iVBORw0KGgo=" };
      },
    };
    const browser = { newContext: async () => ({ once: (_event: string, give: () => void) => give(), route: async () => undefined, newPage: async () => page, close: async () => undefined }) } as never;
    return { admin, id, browser };
  }

  it("reads a tall page in slices, one call each, joined into one page, and says what it cost per slice", async () => {
    const { admin, id, browser } = await tallImageProject(4000);
    const plan = await planDesignUpload(h.db, id);
    expect(plan.estimate.label).toContain("in about 3 slices");
    await startDesignUpload(h.ctx, admin.viewer, id);

    const asked: string[] = [];
    const claude = fakeClaude(() => [], {
      builder: (params) => {
        const said = messageText((params.messages as { content: unknown }[])[0]!.content);
        asked.push(said);
        const part = Number(/part (\d) of 3/.exec(said)![1]);
        return turn(JSON.stringify({ background: "#ffffff", sections: [{ name: `Band ${part}`, top: 0, height: 900, background: part === 2 ? "#222222" : "#ffffff" }], texts: [text(`Card row ${part}`, 400)], images: [] }), "end_turn");
      },
    });
    await runDesignUploadJob(queued[0]!.data, config, claude.client as never, browser);

    expect(asked).toHaveLength(3);
    expect(asked[1]).toContain("Page 1, part 2 of 3 (from 1680px down the page). This picture is 1440 by 1800 pixels");
    const [row] = await h.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, id));
    expect(row).toMatchObject({ importStatus: "done", importProgress: null });
    const calls = await h.db.select().from(aiCall).where(eq(aiCall.step, "design_read"));
    expect(calls.map((c) => c.scope)).toEqual(["slice", "slice", "slice"]);
    const saved = JSON.parse(r2.objects.get(row!.fileJsonKey!)!.toString("utf8")) as { document: { children: { children: { children: { children?: { characters?: string; absoluteBoundingBox: { y: number } }[] }[] }[] }[] } };
    const texts = saved.document.children[0]!.children[0]!.children.flatMap((band) => band.children ?? []).filter((n) => n.characters);
    expect(texts.map((n) => [n.characters, n.absoluteBoundingBox.y])).toEqual([
      ["Card row 1", 400],
      ["Card row 2", 2080],
      ["Card row 3", 3760],
    ]);
  });

  it("keeps what came before the cut when a slice's reply hits the output limit, and says so", async () => {
    const { admin, id, browser } = await tallImageProject(1200);
    await startDesignUpload(h.ctx, admin.viewer, id);
    const whole = JSON.stringify({ background: "#ffffff", sections: [], texts: [text("One", 10), text("Two", 60), text("Three", 110)], images: [] });
    const claude = fakeClaude(() => [], { builder: () => turn(whole.slice(0, whole.indexOf('"Three"')), "max_tokens") });
    await runDesignUploadJob(queued[0]!.data, config, claude.client as never, browser);
    const [row] = await h.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, id));
    expect(row!.importStatus).toBe("done");
    expect(row!.importWarnings).toContain("Page 1: The reply was cut off at the output limit; what came before the cut is kept.");
    expect(claude.calls).toHaveLength(1);
  });

  it("fails with the page, the part and the reason after one retry, and the screen shows it (never Working)", async () => {
    const { admin, id, browser } = await tallImageProject(4000);
    await startDesignUpload(h.ctx, admin.viewer, id);
    const claude = fakeClaude(() => [], { builder: () => turn("Sorry, I can only see part of the page.", "end_turn") });
    const failure = await runDesignUploadJob(queued[0]!.data, config, claude.client as never, browser).catch((error: Error) => error);
    expect(String(failure)).toContain("Page 1, part 1 of 3, couldn't be read: The reply had no JSON object.");
    expect(claude.calls).toHaveLength(2);
    // The worker's handler does this with the message.
    await markDesignUploadFailed(id, (queued[0]!.data as DesignUploadJobData).version, (failure as Error).message);

    const view = (await loadFigmaDesign(h.db, id))!;
    expect(view).toMatchObject({ importStatus: "failed", importProgress: null });
    expect(figmaBadge(view)).toEqual({ text: "Can't read", kind: "missing" });
    const html = renderToStaticMarkup(
      <FigmaSection projectId={id} view={figmaSectionView(view)} readsThisMonth={0} canEdit upload={{ files: [], pages: 1, visionPages: 1, estimateLine: "About $0.30", figmaLinkAllowed: true }} />,
    );
    expect(html).toContain("The design couldn’t be read: Page 1, part 1 of 3, couldn&#x27;t be read: The reply had no JSON object.");
    expect(html).not.toContain("Working...");
  });

  it("keeps the pages read before a failure, reads only what's missing next time, or every page when asked", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Nora Happy Beagle Lady", trade: "photography", tier: "growth", lane: "lane_2", laneOption: "b", conceptCount: 1, status: "intake", memberUserIds: [] });
    for (const n of [1, 2]) {
      const key = `projects/${id}/intake/page${n}.png`;
      await r2.put(key, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x70, 0x6e, 0x67]));
      await h.db.insert(intakeFile).values({ projectId: id, kind: "design_file", storageKey: key, fileName: `page${n}.png`, contentType: "image/png", status: "ready", sizeBytes: 1000 + n, createdAt: new Date(Date.now() + n * 1000) });
    }
    const page = {
      // The page cap listens for close (locked-context.ts); a fake page gives its slot back at once.
      once: (_event: string, give: () => void) => give(),
      route: async () => undefined,
      setContent: async () => undefined,
      evaluate: async (_fn: unknown, arg: Record<string, unknown>) => ("boxes" in arg ? (arg.boxes as unknown[]).map(() => "data:image/png;base64,iVBORw0KGgo=") : { width: 1440, height: 1200, png: "data:image/png;base64,iVBORw0KGgo=" }),
    };
    const browser = { newContext: async () => ({ once: (_event: string, give: () => void) => give(), route: async () => undefined, newPage: async () => page, close: async () => undefined }) } as never;
    const good = (n: number) => JSON.stringify({ background: "#ffffff", sections: [{ name: `Page ${n}`, top: 0, height: 1200, background: "#ffffff" }], texts: [text(`Heading on page ${n}`, 100)], images: [] });
    let pageTwoWorks = false;
    const asked: number[] = [];
    const claude = fakeClaude(() => [], {
      builder: (params) => {
        const n = Number(/^Page (\d)/.exec(messageText((params.messages as { content: unknown }[])[0]!.content))![1]);
        asked.push(n);
        return turn(n === 2 && !pageTwoWorks ? "Sorry, no." : good(n), "end_turn");
      },
    });

    // Run 1: page 1 is read, page 2 fails twice. Page 1 is kept.
    await startDesignUpload(h.ctx, admin.viewer, id);
    await expect(runDesignUploadJob(queued[0]!.data, config, claude.client as never, browser)).rejects.toThrow("Page 2 couldn't be read");
    expect(asked).toEqual([1, 2, 2]);
    let [row] = await h.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, id));
    expect((row!.pagesRead as { pages: number[] }).pages).toEqual([1]);
    expect(r2.objects.has(`projects/${id}/design-upload/read-pages/page-1.json`)).toBe(true);
    await markDesignUploadFailed(id, (queued[0]!.data as DesignUploadJobData).version, "Page 2 couldn't be read");

    let plan = await planDesignUpload(h.db, id);
    expect(plan.keptPages).toEqual([1]);
    expect(plan.estimate.label).toContain("for 1 page read from the picture");
    expect(plan.estimateAll.label).toContain("for 2 pages read from the picture");
    const html = renderToStaticMarkup(
      <FigmaSection projectId={id} view={figmaSectionView((await loadFigmaDesign(h.db, id))!)} readsThisMonth={0} canEdit upload={{ files: [], pages: 2, visionPages: 2, estimateLine: plan.estimate.label, estimateAllLine: plan.estimateAll.label, keptPages: plan.keptPages, pageList: plan.pageList, perSlice: plan.perSlice, figmaLinkAllowed: true }} />,
    );
    expect(html).toContain("Page 1 was read before and is kept.");
    expect(html).toContain("Read the design again");

    // Run 2 (the default): only page 2 is read; the design has both pages.
    pageTwoWorks = true;
    asked.length = 0;
    await startDesignUpload(h.ctx, admin.viewer, id);
    await runDesignUploadJob(queued[1]!.data, config, claude.client as never, browser);
    expect(asked).toEqual([2]);
    [row] = await h.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, id));
    expect(row!.importStatus).toBe("done");
    expect((row!.frames as { name: string }[]).map((f) => f.name)).toEqual(["Home", "Heading on page 2"]);
    expect((row!.pagesRead as { pages: number[] }).pages).toEqual([1, 2]);
    plan = await planDesignUpload(h.db, id);
    expect(plan.estimate).toMatchObject({ cost: 0 });
    expect(plan.estimate.label).toContain("Free: every page was read before and is kept (2 pages)");

    // Every page again, when asked: both are read.
    asked.length = 0;
    await startDesignUpload(h.ctx, admin.viewer, id, { all: true });
    await runDesignUploadJob(queued[2]!.data, config, claude.client as never, browser);
    expect(asked).toEqual([1, 2]);

    // A changed upload doesn't reuse pages read from the old files.
    await h.db.update(intakeFile).set({ sizeBytes: 5000 }).where(eq(intakeFile.fileName, "page1.png"));
    expect((await planDesignUpload(h.db, id)).keptPages).toEqual([]);
  });

  it("shows how far the read has got while it runs", async () => {
    const { admin, id } = await tallImageProject(4000);
    await startDesignUpload(h.ctx, admin.viewer, id);
    await h.db.update(figmaDesign).set({ importStatus: "working", importProgress: { page: 3, pages: 9, part: 2, parts: 4, done: 10, total: 25 } }).where(eq(figmaDesign.projectId, id));
    const view = (await loadFigmaDesign(h.db, id))!;
    expect(figmaBadge(view)).toEqual({ text: "Reading", kind: "info" });
    const html = renderToStaticMarkup(
      <FigmaSection projectId={id} view={figmaSectionView(view)} readsThisMonth={0} canEdit upload={{ files: [], pages: 9, visionPages: 9, estimateLine: "About $3", figmaLinkAllowed: true }} />,
    );
    expect(html).toContain("Reading page 3 of 9, part 2 of 4…");
    expect(html).toContain('aria-valuenow="40"');
  });
});
