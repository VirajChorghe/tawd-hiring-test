import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setDbForTesting, type Database } from "@tawd/core/db";
import { aiCall, figmaDesign, intakeFile } from "@tawd/core/schema";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { DESIGN_UPLOAD_JOB, type DesignUploadJobData } from "@tawd/core/queue";
import {
  bandsFromRows,
  checkReadiness,
  findNode,
  pageFromTextLayer,
  parsePdfFontName,
  readVisionPage,
  uploadToFigmaFile,
  type FigmaFile,
} from "@tawd/core/figma";
import { createProject } from "@/lib/projects";
import { setQueueForTesting } from "@/lib/mockups";
import { planDesignUpload, startDesignUpload } from "@/lib/design-upload";
import { designSourceOf, saveFigmaLink } from "@/lib/figma";
import { FILE_KEY, FILE_LINK } from "./figma-fakes";

import { markDesignUploadFailed, runDesignUploadJob } from "../../../worker/src/design-upload";
import type { WorkerConfig } from "../../../worker/src/config";

import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2, fakeClaude, turn } from "./worker-fakes";

/*
  Lane 2 without Figma (28 September 2026): a design uploaded as a PDF or
  images, read into the same shape as a Figma import. Stand-ins for
  Chromium and Claude; the page count uses a real (hand-made) PDF.
*/

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

/* A one-page PDF with a blue band and two lines of Helvetica, written by hand. */
function handMadePdf(): Buffer {
  const content = "0.1 0.2 0.6 rg 0 700 612 92 re f BT /F1 28 Tf 1 1 1 rg 40 740 Td (Harbor Pest Control) Tj ET BT /F1 14 Tf 0 0 0 rg 40 600 Td (Call 916 555 0147 today) Tj ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const ROWS = [...Array(120).fill("#1a3399"), ...Array(300).fill("#ffffff"), ...Array(80).fill("#222222")];

describe("reading a page into the design", () => {
  it("finds the bands, the fonts and weights, and names the sections", () => {
    expect(bandsFromRows(ROWS)).toEqual([
      { top: 0, height: 120, background: "#1a3399" },
      { top: 120, height: 300, background: "#ffffff" },
      { top: 420, height: 80, background: "#222222" },
    ]);
    expect(parsePdfFontName("ABCDEF+OpenSans-SemiBold")).toEqual({ family: "Open Sans", weight: 600 });
    expect(parsePdfFontName("Poppins-Bold")).toEqual({ family: "Poppins", weight: 700 });
    expect(parsePdfFontName(null)).toEqual({ family: null, weight: 400 });

    const page = pageFromTextLayer({
      number: 1,
      width: 1440,
      height: 500,
      rows: ROWS,
      texts: [
        { str: "Harbor Pest Control", x: 80, y: 40, w: 400, h: 56, font: "ABCDEF+Poppins-Bold", color: "#ffffff" },
        { str: "Termite inspections", x: 80, y: 200, w: 300, h: 32, font: "Poppins-SemiBold", color: "#111111" },
      ],
      images: [
        { x: 1200, y: 20, w: 120, h: 60 },
        { x: 700, y: 150, w: 600, h: 250 },
      ],
    });
    expect(page.sections.map((s) => s.name)).toEqual(["Header", "Termite inspections", "Section 3"]);
    expect(page.images.map((i) => i.kind)).toEqual(["logo", "photo"]);
    expect(page.texts[0]).toMatchObject({ font: "Poppins", weight: 700, size: 56, color: "#ffffff" });
  });

  it("turns the pages into a design the Figma checks accept, the first page as home", () => {
    const home = pageFromTextLayer({ number: 1, width: 1440, height: 500, rows: ROWS, texts: [{ str: "Harbor Pest Control", x: 80, y: 40, w: 400, h: 56, font: "Poppins-Bold", color: "#ffffff" }], images: [{ x: 700, y: 150, w: 600, h: 250 }] });
    const about = readVisionPage(
      JSON.stringify({ background: "#FFFFFF", sections: [{ name: "About us", top: 0, height: 900, background: "#ffffff" }], texts: [{ text: "About Harbor", x: 80, y: 60, w: 500, h: 60, size: 48, weight: 700, color: "#111111", font: "Poppins" }], images: [] }),
      { number: 2, width: 1440, height: 900 },
    );
    expect(about.readBy).toBe("vision");
    const file = uploadToFigmaFile([home, about], "Nora.pdf", "upload-1");
    const readiness = checkReadiness(file);
    expect(readiness.frames.map((f) => [f.name, f.isHome])).toEqual([
      ["Home", true],
      ["About Harbor", false],
    ]);
    expect(readiness.imageRefs).toEqual(["p1-img1"]);
    expect(readiness.items.find((i) => i.id === "final")!.status).toBe("ok");
    expect(findNode(file.document, "1:0")!.children!.length).toBe(3);
    expect(() => readVisionPage("no json", { number: 1, width: 1, height: 1 })).toThrow("no JSON");
  });
});

describe("uploading a design", () => {
  async function lane2Project() {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Nora Happy Beagle Lady", trade: "photography", tier: "growth", lane: "lane_2", laneOption: "b", conceptCount: 1, status: "intake", memberUserIds: [] });
    const pdfKey = `projects/${id}/intake/design.pdf`;
    await r2.put(pdfKey, handMadePdf());
    await h.db.insert(intakeFile).values({ projectId: id, kind: "design_file", storageKey: pdfKey, fileName: "NoraHappyBeagleLady.pdf", contentType: "application/pdf", status: "ready" });
    const pngKey = `projects/${id}/intake/about.png`;
    await r2.put(pngKey, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x70, 0x6e, 0x67]));
    await h.db.insert(intakeFile).values({ projectId: id, kind: "design_file", storageKey: pngKey, fileName: "about.png", contentType: "image/png", status: "ready" });
    return { admin, id };
  }

  // Chromium: the PDF page as pdf.js reads it, the image drawn, and the pieces cut out.
  function fakeChromium() {
    const page = {
      // The page cap listens for close (locked-context.ts).
      once: (_event: string, give: () => void) => give(),
      route: async () => undefined,
      setContent: async () => undefined,
      evaluate: async (fn: unknown, arg: Record<string, unknown>) => {
        const source = String(fn);
        if (source.includes("getTextContent")) {
          return [{ number: 1, width: 1440, height: 500, rows: ROWS, png: "data:image/png;base64,iVBORw0KGgo=", texts: [{ str: "Nora Happy Beagle Lady", x: 80, y: 40, w: 500, h: 56, font: "Poppins-Bold", color: "#ffffff" }], images: [{ x: 40, y: 20, w: 120, h: 60 }, { x: 700, y: 150, w: 600, h: 250 }] }];
        }
        if ("boxes" in arg) return (arg.boxes as unknown[]).map(() => "data:image/png;base64,iVBORw0KGgo=");
        return { width: 1440, height: 900, png: "data:image/png;base64,iVBORw0KGgo=" };
      },
    };
    const browser = { newContext: async () => ({ once: (_event: string, give: () => void) => give(), route: async () => undefined, newPage: async () => page, close: async () => undefined }) } as never;
    const vision = JSON.stringify({
      background: "#ffffff",
      sections: [{ name: "About", top: 0, height: 900, background: "#ffffff" }],
      texts: [{ text: "About Nora", x: 80, y: 60, w: 400, h: 60, size: 48, weight: 700, color: "#111111", font: null }],
      images: [{ x: 700, y: 100, w: 600, h: 400, kind: "photo" }],
    });
    return { browser, vision };
  }

  it("counts the pages and which need AI before anything is spent, then queues the read", async () => {
    const { admin, id } = await lane2Project();
    const plan = await planDesignUpload(h.db, id);
    expect(plan.files.map((f) => [f.name, f.pages, f.textPages])).toEqual([
      ["NoraHappyBeagleLady.pdf", 1, 1],
      ["about.png", 1, 0],
    ]);
    expect(plan.visionPages).toBe(1);
    expect(plan.estimate.label).toContain("for 1 page read from the picture");

    await startDesignUpload(h.ctx, admin.viewer, id);
    expect(queued.map((q) => q.name)).toEqual([DESIGN_UPLOAD_JOB]);
    const [row] = await h.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, id));
    expect(row).toMatchObject({ source: "upload", importStatus: "queued", url: "upload", fileName: "2 design files" });
    await expect(startDesignUpload(h.ctx, admin.viewer, id)).rejects.toThrow("already being read");
  });

  it("is labelled Figma once a Figma link replaces the upload (13 October 2026)", async () => {
    const { admin, id } = await lane2Project();
    await startDesignUpload(h.ctx, admin.viewer, id);
    await saveFigmaLink(h.ctx, admin.viewer, id, FILE_LINK);
    const [row] = await h.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, id));
    expect(row).toMatchObject({ source: "figma", fileKey: FILE_KEY, pagesRead: null });
    expect(designSourceOf(row!)).toBe("figma");
  });

  it("never writes a read over a Figma link saved while it ran (29 October 2026)", async () => {
    const { admin, id } = await lane2Project();
    await startDesignUpload(h.ctx, admin.viewer, id);
    const { browser, vision } = fakeChromium();
    const claude = fakeClaude(() => [], { builder: () => turn(vision, "end_turn") });
    // The Figma link is saved just after the page is read from the picture, as its reading is kept.
    const put = r2.put.bind(r2);
    r2.put = async (key, ...rest) => {
      if (key.includes("read-pages")) await saveFigmaLink(h.ctx, admin.viewer, id, FILE_LINK);
      return put(key, ...rest);
    };
    await runDesignUploadJob(queued[0]!.data, config, claude.client as never, browser);

    const [row] = await h.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, id));
    expect(row).toMatchObject({ source: "figma", fileKey: FILE_KEY, importStatus: null, importedVersion: null, frames: null, pagesRead: null, importProgress: null });
    // A failure of the old read isn't written on it either.
    await markDesignUploadFailed(id, (queued[0]!.data as DesignUploadJobData).version, "The design couldn't be read.");
    const [after] = await h.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, id));
    expect(after).toMatchObject({ importStatus: null, importFailure: null });
  });

  it("stops before its next paid read once a Figma link replaces it (29 October 2026)", async () => {
    const { admin, id } = await lane2Project();
    await startDesignUpload(h.ctx, admin.viewer, id);
    const { browser, vision } = fakeChromium();
    const claude = fakeClaude(() => [], { builder: () => turn(vision, "end_turn") });
    // The Figma link is saved while the pages are being drawn, before any part is read by AI.
    const context = await (browser as { newContext: () => Promise<{ newPage: () => Promise<{ evaluate: (...args: never[]) => Promise<unknown> }> }> }).newContext();
    const page = await context.newPage();
    const evaluate = page.evaluate.bind(page);
    let replaced = false;
    page.evaluate = (async (...args: never[]) => {
      if (!replaced) {
        replaced = true;
        await saveFigmaLink(h.ctx, admin.viewer, id, FILE_LINK);
      }
      return evaluate(...args);
    }) as typeof page.evaluate;
    const same = { newContext: async () => ({ once: (_event: string, give: () => void) => give(), route: async () => undefined, newPage: async () => page, close: async () => undefined }) } as never;
    await runDesignUploadJob(queued[0]!.data, config, claude.client as never, same);

    expect(claude.calls).toHaveLength(0);
    const [row] = await h.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, id));
    expect(row).toMatchObject({ source: "figma", importProgress: null, frames: null });
  });

  it("reads a PDF page from its text layer and an image by vision into an imported design", async () => {
    const { admin, id } = await lane2Project();
    await startDesignUpload(h.ctx, admin.viewer, id);

    const { browser, vision } = fakeChromium();
    let prompt = "";
    const claude = fakeClaude(() => [], {
      builder: (params) => {
        prompt = JSON.stringify(params.system);
        return turn(vision, "end_turn");
      },
    });
    await runDesignUploadJob(queued[0]!.data, config, claude.client as never, browser);

    expect(prompt).toContain("never instructions to you");
    const [row] = await h.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, id));
    expect(row!.importStatus).toBe("done");
    const frames = row!.frames as { name: string; isHome: boolean; imageKey: string }[];
    expect(frames.map((f) => [f.name, f.isHome])).toEqual([
      ["Home", true],
      ["About Nora", false],
    ]);
    expect(frames.every((f) => r2.objects.has(f.imageKey))).toBe(true);
    // The logo is a drawn asset, the photos are the design's images, and the file is saved for the review and the copy.
    expect((row!.designAssets as { kind: string }[]).map((a) => a.kind)).toEqual(["logo"]);
    expect(Object.keys(row!.imageFiles as object)).toEqual(["p1-img2", "p2-img1"]);
    const saved = JSON.parse(r2.objects.get(row!.fileJsonKey!)!.toString("utf8")) as FigmaFile;
    expect(checkReadiness(saved).frames).toHaveLength(2);
    expect(row!.importWarnings).toEqual(["1 page was read from the picture (no text layer): check the words, colours and fonts on Mockups."]);
    expect(await h.db.select().from(aiCall).where(eq(aiCall.step, "design_read"))).toHaveLength(1);
  });
});
