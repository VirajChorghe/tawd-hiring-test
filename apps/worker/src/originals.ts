import { and, asc, eq, inArray } from "drizzle-orm";
import type { Browser, Page } from "playwright-core";

import type { Database } from "@tawd/core/db";
import { intakeFile } from "@tawd/core/schema";
import { ownPageContext } from "./locked-context";

/*
  The client's originals before the design's crops (Jason, 29 September
  2026: "the build must always prefer the intake's original logo and
  photos"). A design PDF's photos are small crops of a flat page; the
  intake has the files themselves. So, by code:

  - the intake's logo replaces the logo cut from the design;
  - each photo cut from the design is looked for in the intake's photos
    (shapes and colours compared at several sizes and places); where one
    clearly holds it, the same part of the original is used, at full
    sharpness, so the right dog stays in the right spot. No match: the
    design's crop stays.
*/

const HOST = "https://tawd-originals.invalid/";

export interface DesignAsset {
  token: string;
  dataUri: string;
}

export interface OriginalFile {
  name: string;
  contentType: string;
  bytes: Buffer;
}

export async function loadOriginals(db: Database, storage: { get(key: string): Promise<Buffer | null> }, projectId: string): Promise<{ logo: OriginalFile | null; photos: OriginalFile[] }> {
  const rows = await db
    .select()
    .from(intakeFile)
    .where(and(eq(intakeFile.projectId, projectId), eq(intakeFile.status, "ready"), inArray(intakeFile.kind, ["logo", "photo"])))
    .orderBy(asc(intakeFile.createdAt));
  let logo: OriginalFile | null = null;
  const photos: OriginalFile[] = [];
  for (const row of rows) {
    if (!/^image\//.test(row.contentType)) continue;
    const bytes = await storage.get(row.storageKey).catch(() => null);
    if (!bytes) continue;
    const file = { name: row.fileName, contentType: row.contentType, bytes };
    if (row.kind === "logo" && !logo) logo = file;
    else if (row.kind === "photo") photos.push(file);
  }
  return { logo, photos };
}

/** Swaps design crops for the originals they came from; returns what was swapped, for the page's notes. */
export async function useOriginals(browser: Browser, originals: { logo: OriginalFile | null; photos: OriginalFile[] }, assets: DesignAsset[]): Promise<{ token: string; note: string }[]> {
  const done: { token: string; note: string }[] = [];
  if (originals.logo) {
    const uri = `data:${originals.logo.contentType};base64,${originals.logo.bytes.toString("base64")}`;
    for (const a of assets.filter((x) => /design-logo$/.test(x.token))) {
      a.dataUri = uri;
      done.push({ token: a.token, note: `The logo is the one from the intake (${originals.logo.name}).` });
    }
  }
  const photos = assets.filter((a) => /design-image-\d+$/.test(a.token));
  if (!originals.photos.length || !photos.length) return done;
  const context = await ownPageContext(browser);
  try {
    const page = await context.newPage();
    await page.route(`${HOST}**`, (route) => {
      const i = Number(route.request().url().slice(HOST.length));
      const file = originals.photos[i];
      return file ? route.fulfill({ status: 200, contentType: file.contentType, body: file.bytes }) : route.fulfill({ status: 404 });
    });
    await page.goto("about:blank", { waitUntil: "domcontentloaded" });
    await page.evaluate(prepare, { host: HOST, count: originals.photos.length });
    for (const photo of photos) {
      const found = await page.evaluate(match, photo.dataUri);
      if (!found) continue;
      const crop = await page.evaluate(cutOriginal, found);
      if (!crop) continue;
      photo.dataUri = crop;
      done.push({ token: photo.token, note: `A photo (${photo.token.replace(/^tawd-asset:/, "")}) is the original "${originals.photos[found.index]!.name}" from the intake, not the design's crop.` });
    }
  } finally {
    await context.close();
  }
  return done;
}

/* ---------- in the page ---------- */

declare global {
  interface Window {
    __originals?: { img: HTMLImageElement; small: ImageData; w: number; h: number }[];
  }
}

/* Each original, loaded once and kept small (320 wide) for the comparisons. */
async function prepare(input: { host: string; count: number }): Promise<void> {
  const list: { img: HTMLImageElement; small: ImageData; w: number; h: number }[] = [];
  for (let i = 0; i < input.count; i += 1) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = `${input.host}${i}`;
    try {
      await img.decode();
    } catch {
      continue;
    }
    const w = 320;
    const h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * w));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, w, h);
    list[i] = { img, small: ctx.getImageData(0, 0, w, h), w, h };
  }
  window.__originals = list;
}

/*
  The original and the part of it that holds this crop, or null. The crop's
  inner 70% (a design's round frame or edges don't count) against every
  place and size in the likeliest originals (shortlisted by colour), by
  normalised correlation on a small grid.
*/
async function match(dataUri: string): Promise<{ index: number; x: number; y: number; w: number; h: number; score: number } | null> {
  const originals = window.__originals ?? [];
  const img = new Image();
  img.src = dataUri;
  await img.decode();
  const aspect = img.naturalWidth / img.naturalHeight;
  const G = 18;
  const gw = aspect >= 1 ? G : Math.max(6, Math.round(G * aspect));
  const gh = aspect >= 1 ? Math.max(6, Math.round(G / aspect)) : G;
  const draw = (source: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, w: number, h: number) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  };
  const inner = draw(img, img.naturalWidth * 0.15, img.naturalHeight * 0.15, img.naturalWidth * 0.7, img.naturalHeight * 0.7, gw, gh).data;
  const n = gw * gh * 3;
  const t = new Float64Array(n);
  let mean = 0;
  for (let i = 0, k = 0; i < inner.length; i += 4) for (let c = 0; c < 3; c += 1, k += 1) mean += (t[k] = inner[i + c]!);
  mean /= n;
  let dev = 0;
  for (let k = 0; k < n; k += 1) dev += (t[k]! - mean) ** 2;
  dev = Math.sqrt(dev / n) || 1;
  for (let k = 0; k < n; k += 1) t[k] = (t[k]! - mean) / dev;

  // Colour shortlist: 4x4x4 histograms, the crop's against each original's.
  const hist = (d: Uint8ClampedArray) => {
    const hgram = new Float64Array(64);
    for (let i = 0; i < d.length; i += 4) hgram[(d[i]! >> 6) * 16 + (d[i + 1]! >> 6) * 4 + (d[i + 2]! >> 6)] += 1;
    const len = Math.hypot(...hgram) || 1;
    return hgram.map((x) => x / len);
  };
  const th = hist(inner);
  const ranked = originals
    .map((o, index) => (o ? { index, o, sim: hist(o.small.data).reduce((s2, x, i) => s2 + x * th[i]!, 0) } : null))
    .filter((x): x is { index: number; o: NonNullable<(typeof originals)[number]>; sim: number } => Boolean(x))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 6);

  let best: { index: number; x: number; y: number; w: number; h: number; score: number } | null = null;
  for (const { index, o } of ranked) {
    const small = document.createElement("canvas");
    small.width = o.w;
    small.height = o.h;
    small.getContext("2d")!.putImageData(o.small, 0, 0);
    for (let share = 1; share >= 0.18; share *= 0.87) {
      // The original scaled so that a window of this share has its inner 70% exactly gw wide.
      const fw = gw / 0.7; // the whole window, in grid pixels
      const W = Math.round(fw / share);
      const H = Math.round((W * o.h) / o.w);
      const fh = fw / aspect;
      if (fh > H + 0.5 || W < fw) continue;
      const data = draw(small, 0, 0, o.w, o.h, W, H).data;
      const ox = Math.round(fw * 0.15), oy = Math.round(fh * 0.15);
      for (let y = 0; y + fh <= H; y += 1) {
        for (let x = 0; x + fw <= W; x += 1) {
          let m = 0;
          for (let r = 0; r < gh; r += 1) for (let q = 0; q < gw; q += 1) {
            const i = ((y + oy + r) * W + (x + ox + q)) * 4;
            m += data[i]! + data[i + 1]! + data[i + 2]!;
          }
          m /= n;
          let d2 = 0, dot = 0, k = 0;
          for (let r = 0; r < gh; r += 1) for (let q = 0; q < gw; q += 1) {
            const i = ((y + oy + r) * W + (x + ox + q)) * 4;
            for (let c = 0; c < 3; c += 1, k += 1) {
              const v = data[i + c]! - m;
              d2 += v * v;
              dot += v * t[k]!;
            }
          }
          const score = dot / (Math.sqrt(d2 / n) || 1) / n;
          if (!best || score > best.score) best = { index, x: x / W, y: y / H, w: fw / W, h: fh / H, score };
        }
      }
    }
  }
  // Only a clear match: a different photo of a similar dog scores far lower.
  return best && best.score >= 0.82 ? best : null;
}

/* That part of the original, at its own sharpness (at most 2000px wide). */
function cutOriginal(found: { index: number; x: number; y: number; w: number; h: number }): string | null {
  const o = window.__originals?.[found.index];
  if (!o) return null;
  const W = o.img.naturalWidth, H = o.img.naturalHeight;
  const sw = found.w * W, sh = found.h * H;
  const k = Math.min(1, 2000 / sw);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(sw * k));
  c.height = Math.max(1, Math.round(sh * k));
  c.getContext("2d")!.drawImage(o.img, found.x * W, found.y * H, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.9);
}

export type { Page };
