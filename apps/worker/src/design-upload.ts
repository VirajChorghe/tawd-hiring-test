import { prefillAfterDesignRead } from "@tawd/core/figma/design-prefill";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { and, asc, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import type { Browser, Page } from "playwright-core";

import { getDb } from "@tawd/core/db";
import { figmaDesign, intakeFile } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import { postProjectSlack } from "@tawd/core/slack";
import type { DesignUploadJobData } from "@tawd/core/queue";
import {
  DesignReadError,
  buildVisionSystemPrompt,
  checkReadiness,
  pageFromTextLayer,
  joinVisionSlices,
  readVisionReply,
  designFilesKey,
  keptPages,
  type PagesRead,
  uploadAssets,
  visionSlices,
  uploadToFigmaFile,
  type RawPdfPage,
  type ReadPage,
  type VisionRead,
  type VisionSlice,
} from "@tawd/core/figma";
import type { ImportedAsset, ImportedFrame } from "@tawd/core/figma/service";
import { CACHE_1H } from "@tawd/core/mockups";

import { imageBlock } from "./image-type";
import type { WorkerConfig } from "./config";
import { stepModel } from "./step-model";
import { syncDesignAddon } from "@tawd/core/addons";
import { requestSettings } from "@tawd/core/mockups";
import { recordCall } from "./pipeline";
import { usageOf } from "./review";
import { ownPageContext } from "./locked-context";
import { loadHtml } from "./page-load";
import { findFlatMargins, type FlatMargins } from "./flat-margins";

/*
  Lane 2 without Figma (28 September 2026): the uploaded PDF or images,
  read into the same shape a Figma import has (core figma/from-upload.ts).

  Each page is drawn in Chromium 1440px wide. A PDF page's text layer gives
  its text, positions and fonts for free (pdf.js, run in the page); its
  bands, text colours and pictures come from the page as drawn. An image,
  or a PDF page with no text layer, gets one vision call (the web app
  showed the estimate first). The pictures are cut out of the page and
  kept as the design's images; the logo and icons as its drawn assets.
*/

export const PAGE_WIDTH = 1440;
// Room for a dense slice's JSON (a slice rarely needs half of it).
const VISION_MAX_TOKENS = 32_000;

/* unpdf's single-file pdf.js: next to the bundle in the image, or from node_modules in development. */
async function pdfjsSource(): Promise<string> {
  try {
    return await readFile(fileURLToPath(new URL("./pdfjs.mjs", import.meta.url)), "utf8");
  } catch {
    return readFile(fileURLToPath(import.meta.resolve("unpdf/pdfjs")), "utf8");
  }
}

/*
  What the read did to a picture-only page (E1, 13 November 2026): it used the
  page's own embedded picture at the picture's own size, and cut flat-colour
  margins off it. Null for a page drawn the usual way (1440 wide).
*/
export interface PictureTakenIn {
  /** The embedded picture's own size, before the trim. */
  pictureWidth: number;
  pictureHeight: number;
  trimmed: FlatMargins;
}

/* The one sentence the team sees for a taken-in picture. */
export function pictureTakenInNote(number: number, taken: PictureTakenIn, width: number, height: number): string {
  const { left, right, top, bottom } = taken.trimmed;
  const sides = [left && `${left} px off the left`, right && `${right} px off the right`, top && `${top} px off the top`, bottom && `${bottom} px off the bottom`].filter(Boolean);
  const trim = sides.length === 0 ? "nothing was trimmed" : `trimmed flat ${taken.trimmed.colourX ?? taken.trimmed.colourY} margin (${sides.join(", ")})`;
  return `Page ${number}: the design’s own picture was used at ${width} × ${height} px (it is ${taken.pictureWidth} × ${taken.pictureHeight} px as embedded); ${trim}.`;
}

/*
  A kept read made before pictures were taken in was drawn 1440 wide (no
  native marker), and its page must be drawn that way again to match it. A
  kept read that has the marker was drawn natively: even when the trim left
  it exactly 1440 wide, it matches by being drawn natively again.
*/
export function keptReadWasDrawnTheOldWay(savedJson: string): boolean {
  const was = JSON.parse(savedJson) as { page?: { width?: number }; native?: boolean };
  return was.page?.width === PAGE_WIDTH && !was.native;
}

/* A PDF, page by page, drawn at 1440px wide: the picture, each row's main colour, the text layer with colours, the pictures' boxes. A page that is only one picture (no text layer) is the exception: that picture is used at its own size, with flat margins trimmed. */
/** The picture is used at its own size only when what is left after the trim is between these widths; anything else is drawn 1440 wide as before. */
export const NATIVE_MIN_WIDTH = 800;
export const NATIVE_MAX_WIDTH = 1920;
/** The most pixels a native canvas may hold: the usual path's biggest (1440 wide, 16000 tall). */
export const NATIVE_MAX_PIXELS = 24_000_000;

export async function readPdf(page: Page, pdf: Buffer, first: number, options: { drawnBefore?: number[] } = {}): Promise<{ raw: RawPdfPage; png: string; taken: PictureTakenIn | null }[]> {
  const lib = await pdfjsSource();
  /*
    pdf.js and the margin finder are put into the page first, as one plain
    script string: TAWD's own code only (the bundled pdf.js and the function
    in flat-margins.ts), so the page and the tests use one copy of the margin
    finder. A string, not a function, so a test runner's module rewriting
    can't reach the import, and no eval or new Function is needed.
  */
  await page.evaluate(
    `(async () => {
      const url = URL.createObjectURL(new Blob([${JSON.stringify(lib)}], { type: "text/javascript" }));
      globalThis.__tawdPdfjs = await import(url);
      globalThis.__tawdFlatMargins = ${String(findFlatMargins)};
    })()`,
  );
  const pages = await page.evaluate(
    async ({ data, width, drawnBefore, minWide, maxWide, maxPixels, firstNumber }) => {
      const loaded = globalThis as unknown as {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pdf.js is loaded in the page and untyped here
        __tawdPdfjs: any;
        __tawdFlatMargins: (pixels: Uint8ClampedArray, w: number, h: number) => { left: number; right: number; top: number; bottom: number; colourX: string | null; colourY: string | null };
      };
      const findFlatMargins = loaded.__tawdFlatMargins;
      const pdfjs = loaded.__tawdPdfjs;
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true }).promise;
      const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      const out = [];
      for (let n = 1; n <= Math.min(doc.numPages, 30); n += 1) {
        const p = await doc.getPage(n);
        // The pictures: every image the page paints, with the transform it's painted at and its own pixel size.
        const ops = await p.getOperatorList();
        const paintedImages = (vp: { convertToViewportPoint: (x: number, y: number) => number[] }) => {
          const found: { x: number; y: number; w: number; h: number; pixelsWide: number; pixelsHigh: number }[] = [];
          let ctm = [1, 0, 0, 1, 0, 0];
          const stack: number[][] = [];
          for (let k = 0; k < ops.fnArray.length; k += 1) {
            const fn = ops.fnArray[k];
            if (fn === pdfjs.OPS.save) stack.push(ctm.slice());
            else if (fn === pdfjs.OPS.restore) ctm = stack.pop() ?? ctm;
            else if (fn === pdfjs.OPS.transform) ctm = pdfjs.Util.transform(ctm, ops.argsArray[k]);
            else if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject || fn === pdfjs.OPS.paintImageXObjectRepeat) {
              const corners = [
                [0, 0],
                [1, 0],
                [0, 1],
                [1, 1],
              ].map(([u, v]) => vp.convertToViewportPoint(ctm[0]! * u! + ctm[2]! * v! + ctm[4]!, ctm[1]! * u! + ctm[3]! * v! + ctm[5]!));
              const xs = corners.map((c: number[]) => c[0]!);
              const ys = corners.map((c: number[]) => c[1]!);
              // An image XObject's args are [id, width, height]; an inline image carries its own size.
              const args = ops.argsArray[k] as unknown[];
              const inline = fn === pdfjs.OPS.paintInlineImageXObject ? (args[0] as { width?: number; height?: number }) : null;
              found.push({
                x: Math.min(...xs),
                y: Math.min(...ys),
                w: Math.max(...xs) - Math.min(...xs),
                h: Math.max(...ys) - Math.min(...ys),
                pixelsWide: Number(inline ? inline.width : args[1]) || 0,
                pixelsHigh: Number(inline ? inline.height : args[2]) || 0,
              });
            }
          }
          return found;
        };
        const unit = p.getViewport({ scale: 1 });
        const hasText = (await p.getTextContent()).items.some((i: { str?: string }) => typeof i.str === "string" && i.str.trim());
        // A page with no text layer that is one picture covering the page: that picture, at its own size.
        const only = paintedImages(unit);
        const cover = only.length === 1 ? (only[0]!.w * only[0]!.h) / (unit.width * unit.height) : 0;
        const ownScale =
          !hasText && only.length === 1 && cover >= 0.98 && cover <= 1.02 && only[0]!.pixelsWide > 0 && only[0]!.pixelsHigh > 0 && Math.abs(only[0]!.pixelsWide / only[0]!.pixelsHigh / (only[0]!.w / only[0]!.h) - 1) < 0.02
            ? only[0]!.pixelsWide / only[0]!.w
            : 0;
        // A page whose earlier read was made from the usual 1440 wide picture keeps being drawn that way, so the kept read still matches it.
        const drawnBeforeThisWay = drawnBefore.includes(firstNumber + n - 1);
        // Small enough for one canvas; anything bigger is drawn the usual way.
        const nativeWide = Math.round(unit.width * ownScale);
        const nativeHigh = Math.round(unit.height * ownScale);
        let native = ownScale > 0 && !drawnBeforeThisWay && nativeHigh <= 16000 && nativeWide * nativeHigh <= maxPixels;
        const drawAt = async (scale: number) => {
          const viewport = p.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(viewport.width);
          canvas.height = Math.min(16000, Math.round(viewport.height));
          const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
          await p.render({ canvasContext: ctx, viewport }).promise;
          return { viewport, canvas, ctx, scale };
        };
        let { viewport, canvas, ctx, scale } = await drawAt(native ? ownScale : width / unit.width);
        let taken: { pictureWidth: number; pictureHeight: number; trimmed: { left: number; right: number; top: number; bottom: number; colourX: string | null; colourY: string | null } } | null = null;
        let cropLeft = 0;
        let cropTop = 0;
        if (native) {
          const trimmed = findFlatMargins(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
          const keptWide = canvas.width - trimmed.left - trimmed.right;
          if (keptWide < minWide || keptWide > maxWide) {
            // Too small to be a desktop page or too big to be one at 1x (an @2x export): drawn the usual way.
            native = false;
            ({ viewport, canvas, ctx, scale } = await drawAt(width / unit.width));
          } else {
            taken = { pictureWidth: canvas.width, pictureHeight: canvas.height, trimmed };
            if (trimmed.left + trimmed.right + trimmed.top + trimmed.bottom > 0) {
              const cut = document.createElement("canvas");
              cut.width = keptWide;
              cut.height = canvas.height - trimmed.top - trimmed.bottom;
              const cutCtx = cut.getContext("2d", { willReadFrequently: true })!;
              cutCtx.drawImage(canvas, trimmed.left, trimmed.top, cut.width, cut.height, 0, 0, cut.width, cut.height);
              canvas = cut;
              ctx = cutCtx;
              cropLeft = trimmed.left;
              cropTop = trimmed.top;
            }
          }
        }
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const at = (x: number, y: number) => {
          const i = (Math.max(0, Math.min(canvas.height - 1, Math.round(y))) * canvas.width + Math.max(0, Math.min(canvas.width - 1, Math.round(x)))) * 4;
          return [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!] as const;
        };
        // Each row's most common colour, sampled every 8px.
        const rows: string[] = [];
        for (let y = 0; y < canvas.height; y += 1) {
          const counts = new Map<string, number>();
          for (let x = 0; x < canvas.width; x += 8) {
            const [r, g, b] = at(x, y);
            // Rounded to the nearest 8, so near-identical pixels count together without shifting the colour.
            const near = (v: number) => Math.min(255, Math.round(v / 8) * 8);
            const key = hex(near(r), near(g), near(b));
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          rows.push([...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0]);
        }
        const content = await p.getTextContent();
        const texts = content.items
          .filter((i: { str?: string }) => typeof i.str === "string" && i.str.trim())
          .map((i: { str: string; transform: number[]; width: number; height: number; fontName: string }) => {
            const [x, baseline] = viewport.convertToViewportPoint(i.transform[4], i.transform[5]);
            const h = i.height * scale;
            const w = i.width * scale;
            const y = baseline - h;
            // The text's colour: the pixel in its box furthest from the background.
            const bg = at(x - 4, y + h / 2);
            let best = bg;
            let far = -1;
            for (let sx = x; sx < x + w; sx += Math.max(1, w / 40)) {
              for (let sy = y; sy < y + h; sy += Math.max(1, h / 6)) {
                const c = at(sx, sy);
                const d = Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]);
                if (d > far) {
                  far = d;
                  best = c;
                }
              }
            }
            // The font's real name ("ABCDEF+Poppins-Bold") once drawn; else the family pdf.js gives.
            const font: string | null = (() => {
              try {
                return p.commonObjs.get(i.fontName)?.name ?? null;
              } catch {
                return content.styles?.[i.fontName]?.fontFamily ?? null;
              }
            })();
            return { str: i.str, x, y, w, h, font, color: hex(best[0], best[1], best[2]) };
          });
        // Boxes in the picture as returned: shifted by the trim, so they agree with it.
        const images = paintedImages(viewport).map((b) => {
          // A page drawn the usual way keeps its boxes exactly as before.
          if (!native) return { x: b.x, y: b.y, w: b.w, h: b.h };
          // A taken-in picture: shifted by the trim and cut to what is left, so no box reaches outside the picture.
          const x = Math.max(0, b.x - cropLeft);
          const y = Math.max(0, b.y - cropTop);
          return { x, y, w: Math.min(canvas.width, b.x - cropLeft + b.w) - x, h: Math.min(canvas.height, b.y - cropTop + b.h) - y };
        });
        out.push({ number: n, width: canvas.width, height: canvas.height, rows, texts, images, png: canvas.toDataURL("image/png"), taken });
      }
      return out;
    },
    { data: pdf.toString("base64"), width: PAGE_WIDTH, drawnBefore: options.drawnBefore ?? [], minWide: NATIVE_MIN_WIDTH, maxWide: NATIVE_MAX_WIDTH, maxPixels: NATIVE_MAX_PIXELS, firstNumber: first },
  );
  return pages.map((p: RawPdfPage & { png: string; taken: PictureTakenIn | null }, i: number) => ({ raw: { number: first + i, width: p.width, height: p.height, rows: p.rows, texts: p.texts, images: p.images }, png: p.png, taken: p.taken }));
}

/* An image, drawn at 1440px wide. */
async function readImage(page: Page, bytes: Buffer, type: string, number: number): Promise<{ width: number; height: number; png: string; number: number }> {
  const drawn = await page.evaluate(
    async ({ src, width }) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const scale = width / image.naturalWidth;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = Math.min(16000, Math.round(image.naturalHeight * scale));
      canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
      return { width: canvas.width, height: canvas.height, png: canvas.toDataURL("image/png") };
    },
    { src: `data:${type};base64,${bytes.toString("base64")}`, width: PAGE_WIDTH },
  );
  return { ...drawn, number };
}

/* The page cut into slices a vision call can read, and pieces of it (the pictures). */
async function cut(page: Page, png: string, boxes: { x: number; y: number; w: number; h: number }[]): Promise<string[]> {
  return page.evaluate(
    async ({ src, boxes }) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      return boxes.map((b) => {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(b.w));
        canvas.height = Math.max(1, Math.round(b.h));
        canvas.getContext("2d")!.drawImage(image, b.x, b.y, b.w, b.h, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/png");
      });
    },
    { src: png, boxes },
  );
}

const pngBytes = (dataUri: string) => Buffer.from(dataUri.replace(/^data:image\/png;base64,/, ""), "base64");

export async function runDesignUploadJob(job: DesignUploadJobData, config: WorkerConfig, client: Anthropic, browser: Browser): Promise<void> {
  const db = getDb();
  const storage = getStorage();
  const [row] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, job.projectId)).limit(1);
  if (!row || row.source !== "upload" || row.importStatus !== "queued" || row.fileKey !== job.version) return;
  // Every write is to this upload only: a Figma link or a new upload saved meanwhile is never written over (29 October 2026, CodeRabbit on PR #14).
  const thisUpload = uploadRow(job.projectId, job.version);
  const [started] = await db.update(figmaDesign).set({ importStatus: "working", importProgress: null }).where(thisUpload).returning({ projectId: figmaDesign.projectId });
  if (!started) return;

  const files = await db
    .select()
    .from(intakeFile)
    .where(and(eq(intakeFile.projectId, job.projectId), eq(intakeFile.kind, "design_file"), eq(intakeFile.status, "ready")))
    .orderBy(asc(intakeFile.createdAt));
  if (files.length === 0) throw new Error("There are no design files to read. Upload the PDF or images first.");

  // Pages read from the picture by an earlier read of these same files are kept (27 September 2026).
  const filesKey = designFilesKey(files);
  const kept = job.all ? [] : keptPages(row.pagesRead, filesKey);
  const pagesRead: PagesRead = { files: filesKey, pages: [...kept] };
  await db.update(figmaDesign).set({ pagesRead }).where(thisUpload);
  const keptKey = (n: number) => `${projectStoragePrefix(job.projectId)}design-upload/read-pages/page-${n}.json`;

  const prefix = `${projectStoragePrefix(job.projectId)}design-upload/${job.version}/`;
  const context = await ownPageContext(browser, { viewport: { width: PAGE_WIDTH, height: 900 }, deviceScaleFactor: 1 });
  const warnings: string[] = [];
  try {
    const page = await context.newPage();
    // Nothing here needs the network: the files arrive as data.
    await page.route("**/*", (route) => (/^(data|blob|about):/.test(route.request().url()) ? route.continue() : route.abort()));
    await loadHtml(page, "<!doctype html><html><body></body></html>");

    const drawn: { png: string; read: ReadPage | null; width: number; height: number; number: number; native: boolean }[] = [];
    // Pages kept from an earlier read (and not chosen to be read again) were made from the picture as drawn then. One read when the picture was always drawn 1440 wide is still matched by drawing it 1440 wide, so it is not thrown away (and paid for again) just because pictures are now taken in at their own size.
    const chosenAgain = job.pages ? new Set(job.pages) : null;
    const drawnBefore: number[] = [];
    for (const n of kept) {
      if (chosenAgain?.has(n)) continue;
      const saved = await storage.get(keptKey(n));
      if (!saved) continue;
      try {
        if (keptReadWasDrawnTheOldWay(saved.toString("utf8"))) drawnBefore.push(n);
      } catch {
        // Unreadable: the page is read again.
      }
    }
    for (const file of files) {
      const bytes = await storage.get(file.storageKey);
      if (!bytes) {
        warnings.push(`"${file.fileName}" is missing from storage; upload it again.`);
        continue;
      }
      if (file.contentType === "application/pdf") {
        for (const { raw, png, taken } of await readPdf(page, bytes, drawn.length + 1, { drawnBefore })) {
          if (taken) warnings.push(pictureTakenInNote(raw.number, taken, raw.width, raw.height));
          const read = raw.texts.length > 0 ? pageFromTextLayer(raw) : null;
          drawn.push({ png, read, width: raw.width, height: raw.height, number: raw.number, native: taken !== null });
        }
      } else {
        const image = await readImage(page, bytes, file.contentType, drawn.length + 1);
        drawn.push({ png: image.png, read: null, width: image.width, height: image.height, number: image.number, native: false });
      }
    }
    if (drawn.length === 0) throw new Error("None of the design files could be read.");

    /*
      Pages with no text layer: read from the picture in slices, one call
      per slice (27 September 2026: a dense page in one call failed). The
      screen shows "Reading page 3 of 9" as it goes.
    */
    const system: Anthropic.TextBlockParam[] = [{ type: "text", text: buildVisionSystemPrompt(), cache_control: CACHE_1H }];
    let reused = 0;
    const chosen = job.pages ? new Set(job.pages) : null;
    for (const d of drawn.filter((x) => !x.read && kept.includes(x.number) && !chosen?.has(x.number))) {
      const saved = await storage.get(keptKey(d.number));
      if (!saved) continue;
      try {
        const { page: read, notes } = JSON.parse(saved.toString("utf8")) as { page: ReadPage; notes: string[] };
        if (read.number !== d.number || read.width !== d.width || read.height !== d.height) continue;
        d.read = read;
        for (const note of notes) warnings.push(`Page ${d.number}: ${note}`);
        reused += 1;
      } catch {
        // Unreadable: read the page again.
      }
    }
    const toRead = drawn.filter((x) => !x.read && (!chosen || chosen.has(x.number)));
    const plan = toRead.map((d) => ({ d, slices: visionSlices(d.height) }));
    const total = plan.reduce((n, p) => n + p.slices.length, 0);
    let done = 0;
    for (const { d, slices } of plan) {
      const crops = await cut(page, d.png, slices.map((s) => ({ x: 0, y: s.top, w: d.width, h: s.height })));
      const parts: { slice: VisionSlice; read: VisionRead }[] = [];
      for (const [i, slice] of slices.entries()) {
        const [active] = await db
          .update(figmaDesign)
          .set({ importProgress: { page: d.number, pages: drawn.length, part: i + 1, parts: slices.length, done, total } })
          .where(thisUpload)
          .returning({ projectId: figmaDesign.projectId });
        // Replaced meanwhile: no further part is read (or paid for).
        if (!active) return;
        const messages: Anthropic.MessageParam[] = [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Page ${d.number}${slices.length > 1 ? `, part ${i + 1} of ${slices.length} (from ${slice.top}px down the page)` : ""}. This picture is ${d.width} by ${slice.height} pixels; give every position in its own pixels.`,
              },
              imageBlock(Buffer.from(crops[i]!.replace(/^data:image\/\w+;base64,/, ""), "base64")),
              { type: "text", text: "Reply with the JSON." },
            ],
          },
        ];
        let read: VisionRead | null = null;
        for (let attempt = 1; attempt <= 2 && !read; attempt += 1) {
          const model = await stepModel(db, "design_read");
          const response = await client.messages.stream({ model, max_tokens: VISION_MAX_TOKENS, system, messages, ...requestSettings(model, { effort: "low" }) }).finalMessage();
          await recordCall(db, {
            projectId: job.projectId,
            // The cost ledger wants an id; the read is the project's own.
            runId: job.projectId,
            conceptId: null,
            startedByUserId: job.startedByUserId,
            model,
            step: "design_read",
            round: attempt,
            label: `Page ${d.number}, part ${i + 1} of ${slices.length}`,
            // Slice calls are averaged apart from the old whole-page ones for the estimate.
            scope: "slice",
            usage: usageOf(response.usage),
            turns: [{ stopReason: response.stop_reason, content: response.content }],
          });
          const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
          try {
            read = readVisionReply(text, { width: d.width, height: slice.height });
            if (response.stop_reason === "max_tokens" && !read.notes.some((n) => n.includes("cut off"))) read.notes.push("The reply reached the output limit; the end of it may be missing.");
          } catch (error) {
            const where = `Page ${d.number}${slices.length > 1 ? `, part ${i + 1} of ${slices.length},` : ""}`;
            const reason = error instanceof Error ? error.message : "unknown";
            const cutOff = response.stop_reason === "max_tokens" ? " The reply was cut off at the output limit." : "";
            if (!(error instanceof DesignReadError) || attempt === 2) throw new Error(`${where} couldn't be read: ${reason}${cutOff}`, { cause: error });
            messages.push({ role: "assistant", content: response.content.filter((b) => b.type === "text") });
            messages.push({ role: "user", content: `That reply couldn't be used: ${reason}${cutOff} Reply again with only the compact JSON object.` });
          }
        }
        parts.push({ slice, read: read! });
        done += 1;
      }
      const joined = joinVisionSlices(d, parts);
      d.read = joined.page;
      for (const note of joined.notes) warnings.push(`Page ${d.number}: ${note}`);
      // Kept straight away: if a later page fails, this one isn't paid for again.
      await storage.put(keptKey(d.number), Buffer.from(JSON.stringify({ ...joined, native: d.native }), "utf8"), "application/json");
      pagesRead.pages = [...new Set([...pagesRead.pages, d.number])].sort((a, b) => a - b);
      await db.update(figmaDesign).set({ pagesRead }).where(thisUpload);
    }
    // Pages not chosen and never read are left out of the design until they are read.
    const left = drawn.filter((d) => !d.read).map((d) => d.number);
    const readDrawn = drawn.filter((d) => d.read);
    if (readDrawn.length === 0) throw new Error("No page was chosen to read. Choose at least one page.");
    if (left.length) warnings.push(`${left.length === 1 ? `Page ${left[0]} isn't` : `Pages ${left.join(", ")} aren't`} read yet, so the design has ${readDrawn.length} of ${drawn.length} pages. Read the rest from the intake's Design section.`);
    const pages = readDrawn.map((d) => d.read!);

    /* The pictures and pages, kept as the import keeps Figma's. */
    const imageFiles: Record<string, string | null> = {};
    const designAssets: ImportedAsset[] = [];
    const assets = uploadAssets(pages);
    const frames: ImportedFrame[] = [];
    const file = uploadToFigmaFile(pages, files.length === 1 ? files[0]!.fileName : `${files.length} design files`, job.version);
    const frameNodes = file.document.children![0]!.children!;
    for (const [i, d] of readDrawn.entries()) {
      const read = pages[i]!;
      const frameKey = `${prefix}frames/page-${read.number}.png`;
      await storage.put(frameKey, pngBytes(d.png), "image/png");
      frames.push({ id: frameNodes[i]!.id, name: frameNodes[i]!.name, width: read.width, height: read.height, isHome: i === 0, imageKey: frameKey, scale: 1 });
      if (read.images.length === 0) continue;
      const crops = await cut(page, d.png, read.images);
      for (const [k, img] of read.images.entries()) {
        const key = `${prefix}images/${img.ref}.png`;
        await storage.put(key, pngBytes(crops[k]!), "image/png");
        const asset = assets.find((a) => a.ref === img.ref);
        if (asset) designAssets.push({ id: asset.id, name: asset.name, kind: asset.kind, width: asset.width, height: asset.height, imageKey: key });
        else imageFiles[img.ref] = key;
      }
    }
    const fileJsonKey = `${prefix}design.json`;
    await storage.put(fileJsonKey, Buffer.from(JSON.stringify(file), "utf8"), "application/json");
    const readiness = checkReadiness(file);
    const vision = pages.filter((p) => p.readBy === "vision").length;
    if (vision > 0) warnings.push(`${vision} page${vision === 1 ? " was" : "s were"} read from the picture (no text layer): check the words, colours and fonts on Mockups.`);

    const [saved] = await db
      .update(figmaDesign)
      .set({
        fileName: file.name,
        figmaVersion: job.version,
        readiness,
        fileJsonKey,
        checkStatus: readiness.warnings > 0 ? "warnings" : "ok",
        checkedAt: new Date(),
        importStatus: "done",
        importFailure: null,
        importProgress: null,
        importedAt: new Date(),
        importedVersion: job.version,
        frames,
        imageFiles,
        designAssets,
        importWarnings: warnings,
      })
      .where(thisUpload)
      .returning({ projectId: figmaDesign.projectId });
    // Replaced while it was read: nothing of this read is kept, announced or charged as an add-on.
    if (!saved) return;
    // The client-supplied design add-on, one per page of the upload (27 September 2026).
    await syncDesignAddon(db, job.projectId, drawn.length);
    // E0(c): the design's facts go into the intake's empty answers, by code (never throws; a failure is logged). Straight after the read is done, so a failed log or Slack post can't skip it.
    await prefillAfterDesignRead(db, job.projectId);
    await recordActivity(db, {
      action: "figma.upload_read",
      entityType: "project",
      entityId: job.projectId,
      ...actorFields(SYSTEM_ACTOR),
      valueAfter: { files: files.length, pages: pages.length, byVision: vision, keptFromLastRead: reused, images: Object.keys(imageFiles).length, logos: designAssets.filter((a) => a.kind === "logo").length },
      ipAddress: null,
      userAgent: null,
    });
    await postProjectSlack(db, job.projectId, { kind: "design_imported", frames: frames.length, warnings: readiness.warnings + warnings.length });
  } finally {
    await context.close();
  }
}

export async function markDesignUploadFailed(projectId: string, version: string, message: string): Promise<void> {
  await getDb().update(figmaDesign).set({ importStatus: "failed", importFailure: message.slice(0, 1000), importProgress: null }).where(uploadRow(projectId, version));
}

/* The design row while it still holds this upload (its fileKey is the upload's version). */
const uploadRow = (projectId: string, version: string) => and(eq(figmaDesign.projectId, projectId), eq(figmaDesign.fileKey, version), eq(figmaDesign.source, "upload"));
