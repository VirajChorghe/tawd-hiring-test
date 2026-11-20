import { iconChoice } from "@tawd/core/mockups";
import type { Page } from "playwright-core";

import { wipeAndFill, type PatchRecord } from "./design-patch";
import { boxInside, colourAt, colourDistance, crop, hex, type Box, type Colour, type Rgba } from "./design-pixels";

/*
  The pictures cut from a client's design (E3, Lane 2 assets, 13 November 2026).

  Before a page is built, each picture the page needs is cut out of the
  design and treated according to what it is. Everything here is plain
  pixel work in Node, so every rule is tested without a browser; a browser
  is used only to turn a PNG or JPEG into pixels and back (readPixels and
  writePng at the bottom).

  Rules:
  - prepareAsset never throws. Anything it cannot do is said in `flags`, in
    plain English for a person: what is wrong and what would fix it.
  - A box that is not fully inside the design gives no picture (null) and a
    flag naming the picture. A box is never clamped: a clamped crop would be
    the wrong picture at the wrong size.
  - photo: the exact crop.
  - background: the crop, then each drawn-over box (text, cards and forms
    that sit on top of it in the design) is wiped and filled from what is
    around it, by wipeAndFill. A drawn-over box is first cut down to the part
    that touches the picture; one that does not touch it is flagged and
    skipped. Patches apply in order, each on the result of the one before.
    A patch that cannot be made leaves the picture as it was and says why.
    A patch made the "soft" way (a photo was behind the box) is flagged too:
    the smoothing is a guess, and the clean picture is better.
  - logo and cutout: the crop, with its plain background made see-through.
    If the background is not one plain colour the opaque crop is kept and
    a flag asks for the file to be uploaded.
  - Making a picture see-through (toTransparent): the background colour is
    the most common colour of the picture's one-pixel outer border (colours
    counted in buckets of 8 so noise does not split them, then a real pixel
    of the winning bucket is used). The border is plain when at least 90% of
    its pixels are within 24 (per colour channel) of that colour; if not, the
    picture is refused. Then, by each pixel's distance d to the background:
    - 24 or less: fully clear (0,0,0, alpha 0).
    - An edge: a pixel with a much stronger one (further from the
      background by more than 24) within 4 px, whose colour is a mix of
      the background and that neighbour (within 24). It is drawn in the
      neighbour's colour, as see-through as the mix says: a grey pixel at
      the edge of black text on white is black at half strength. Without
      this, an edge pixel far enough from the background counted as solid
      and the logo kept a pale fringe of the old background (on a navy
      footer, a black logo outlined in grey). A pale colour of the logo's
      own beside a strong one is not a mix of them, so it is the body.
    - The body (anything else): solid from 96 up, a straight line from 24
      to 96, the colour un-mixed (c = bg + (pixel - bg) / alpha). A logo's
      own colours stay exactly as drawn; only a faint area on its own (a
      soft shadow) goes see-through.
    A picture smaller than 3x3 is refused. The input is never changed.
    Known limits: an edge softer than 4 px (a glow, a blur) keeps some of
    the old background in its outer part; and a part of the logo in the
    background's own colour (white lettering in a navy badge on white)
    goes see-through with the background, as the holes in its letters
    must. Code can't tell those two apart; the asset sheet shows each logo
    on a contrasting colour so a person sees it.
  - silhouette: needs the band it sits in, inside the design and around
    the box. Without one it is a plain crop and flagged. Otherwise it is
    made see-through like a logo, with the background colour read only
    from the sides that lie inside the band (a figure standing on the
    band's edge touches the picture's border there), then faded to clear
    across those same sides: it keeps its edge where the band ends and
    melts into the band everywhere else. The fade is max(1, min(48, 25%
    of that dimension)) pixels wide; the edges faded are recorded.
  - icon: no picture. The word beside the icon is matched against TAWD's
    icon set (and, when the word tells nothing, the card's heading). No
    label is flagged; no match gets TAWD's plain dot and is flagged.
*/

export type PictureKind = "photo" | "background" | "cutout" | "logo" | "silhouette" | "icon";

export interface PictureRequest {
  id: string;
  kind: PictureKind;
  /** On the whole design. */
  box: Box;
  /** Background only: boxes on the whole design where text, cards or forms are drawn over it. */
  drawnOver?: Box[];
  /** Silhouette only: the band (on the whole design) it sits in. */
  band?: Box;
  /** Icon only: the word or words beside the icon. */
  label?: string;
  /** Icon only: the card's heading. */
  context?: string;
}

export type Edge = "left" | "right" | "top" | "bottom";

export interface PreparedAsset {
  id: string;
  kind: PictureKind;
  box: Box;
  /** Null for icons and for refused boxes. */
  picture: Rgba | null;
  icon: { name: string; by: string } | null;
  /** Boxes are relative to the cut picture, as wipeAndFill returns them. */
  patches: PatchRecord[];
  /** The colour made see-through (logo, cutout, silhouette). */
  transparentOn: string | null;
  /** Silhouette only. */
  fadedEdges: Edge[];
  /** Plain sentences for a person; each says what is wrong and what would fix it. */
  flags: string[];
}

const TOLERANCE = 24;
const FULL = 96;
const PLAIN_SHARE = 0.9;
/** How far (px) a pixel looks for a stronger neighbour that makes it an edge. */
const EDGE_REACH = 4;

/** The edges of a box that lie inside its band (not on the band's own edge). */
function edgesInside(box: Box, band: Box): Edge[] {
  const edges: Edge[] = [];
  if (box.x > band.x) edges.push("left");
  if (box.x + box.w < band.x + band.w) edges.push("right");
  if (box.y > band.y) edges.push("top");
  if (box.y + box.h < band.y + band.h) edges.push("bottom");
  return edges;
}

/**
  `sides`: which of the picture's edges to read the background colour from (all four when not given).
  A silhouette standing on its band's edge touches the picture's border there, so only its other sides are read.
*/
export function toTransparent(picture: Rgba, sides: Edge[] = ["left", "right", "top", "bottom"]): { picture: Rgba; colour: string } | { refused: string } {
  const { width, height, data } = picture;
  if (width < 3 || height < 3) return { refused: "the picture is too small (under 3x3) to find a background colour" };
  const border = new Set<number>();
  for (let x = 0; x < width; x += 1) {
    if (sides.includes("top")) border.add(x);
    if (sides.includes("bottom")) border.add((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    if (sides.includes("left")) border.add(y * width);
    if (sides.includes("right")) border.add(y * width + width - 1);
  }
  if (border.size === 0) return { refused: "it has no edge to read a background colour from" };
  const bucket = (p: number) => `${data[p * 4]! >> 3},${data[p * 4 + 1]! >> 3},${data[p * 4 + 2]! >> 3}`;
  const counts = new Map<string, number>();
  let best = "";
  let bestCount = 0;
  for (const p of border) {
    const key = bucket(p);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n > bestCount) {
      bestCount = n;
      best = key;
    }
  }
  const winner = [...border].find((p) => bucket(p) === best)!;
  const bg = colourAt(picture, winner % width, Math.floor(winner / width));
  const near = [...border].filter((p) => colourDistance(colourAt(picture, p % width, Math.floor(p / width)), bg) <= TOLERANCE).length;
  if (near < PLAIN_SHARE * border.size) return { refused: "its edge is not one plain colour" };

  const out = new Uint8ClampedArray(data.length);
  const distance = new Float32Array(width * height);
  for (let i = 0; i < width * height; i += 1) distance[i] = colourDistance([data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!], bg);
  for (let i = 0; i < width * height; i += 1) {
    const c: Colour = [data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!];
    const d = distance[i]!;
    if (d <= TOLERANCE) continue; // rgb 0,0,0 and alpha 0 already
    // The strongest pixel within EDGE_REACH: when it stands well clear of this one, this pixel is an edge of it.
    const x = i % width;
    const y = Math.floor(i / width);
    let strongest = i;
    for (let yy = Math.max(0, y - EDGE_REACH); yy <= Math.min(height - 1, y + EDGE_REACH); yy += 1) {
      for (let xx = Math.max(0, x - EDGE_REACH); xx <= Math.min(width - 1, x + EDGE_REACH); xx += 1) {
        if (distance[yy * width + xx]! > distance[strongest]!) strongest = yy * width + xx;
      }
    }
    let alpha = 0;
    let colour: Colour | null = null;
    if (distance[strongest]! > d + TOLERANCE) {
      // Perhaps an edge: the share of the neighbour's colour, measured along the line from the background to it.
      const q: Colour = [data[strongest * 4]!, data[strongest * 4 + 1]!, data[strongest * 4 + 2]!];
      let dot = 0;
      let length = 0;
      for (let k = 0; k < 3; k += 1) {
        dot += (c[k]! - bg[k]!) * (q[k]! - bg[k]!);
        length += (q[k]! - bg[k]!) ** 2;
      }
      const share = Math.min(1, Math.max(0, dot / length));
      // Only when this pixel really is that mix: a pale colour of the logo's own beside a strong one is not (it is the body).
      const mixed = bg.map((v, k) => v + (q[k]! - v) * share) as Colour;
      if (colourDistance(mixed, c) <= TOLERANCE) {
        alpha = share;
        colour = q;
      }
    }
    if (!colour) {
      // The body (or a faint area with nothing stronger near it): solid from FULL up, a straight line from TOLERANCE, un-mixed.
      alpha = Math.min(1, (d - TOLERANCE) / (FULL - TOLERANCE));
      colour = c.map((v, k) => Math.min(255, Math.max(0, bg[k]! + (v - bg[k]!) / alpha))) as Colour;
    }
    if (alpha === 0) continue;
    for (let k = 0; k < 3; k += 1) out[i * 4 + k] = Math.round(colour[k]!);
    // The picture's own alpha is kept in proportion (a design picture is opaque, so this is 255 * alpha).
    out[i * 4 + 3] = Math.round(alpha * data[i * 4 + 3]!);
  }
  return { picture: { width, height, data: out }, colour: hex(bg) };
}

function fadeEdges(picture: Rgba, box: Box, band: Box): { picture: Rgba; edges: Edge[] } {
  const edges = edgesInside(box, band);
  const fadeX = Math.max(1, Math.min(48, Math.floor(picture.width * 0.25)));
  const fadeY = Math.max(1, Math.min(48, Math.floor(picture.height * 0.25)));
  const data = new Uint8ClampedArray(picture.data);
  for (let y = 0; y < picture.height; y += 1) {
    for (let x = 0; x < picture.width; x += 1) {
      let f = 1;
      if (edges.includes("left")) f *= Math.min(1, x / fadeX);
      if (edges.includes("right")) f *= Math.min(1, (picture.width - 1 - x) / fadeX);
      if (edges.includes("top")) f *= Math.min(1, y / fadeY);
      if (edges.includes("bottom")) f *= Math.min(1, (picture.height - 1 - y) / fadeY);
      if (f < 1) {
        const i = (y * picture.width + x) * 4 + 3;
        data[i] = Math.round(data[i]! * f);
      }
    }
  }
  return { picture: { width: picture.width, height: picture.height, data }, edges };
}

function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return r > x && bottom > y ? { x, y, w: r - x, h: bottom - y } : null;
}

export function prepareAsset(design: Rgba, request: PictureRequest): PreparedAsset {
  const out: PreparedAsset = { id: request.id, kind: request.kind, box: request.box, picture: null, icon: null, patches: [], transparentOn: null, fadedEdges: [], flags: [] };
  try {
    if (request.kind === "icon") {
      const label = (request.label ?? "").trim();
      if (!label) {
        out.flags.push(`The icon ${request.id} has no word beside it, so no icon can be picked; add the word that says what it shows.`);
        return out;
      }
      const choice = iconChoice(label, { context: request.context ?? null });
      out.icon = { name: choice.name, by: choice.by };
      if (choice.by === "unknown") out.flags.push(`No icon in TAWD's set matches "${label}"; a person or the icon pick has to choose one.`);
      return out;
    }

    if (!boxInside(request.box, design)) {
      out.flags.push(`The box for ${request.id} is not fully inside the design, so it was not cut; correct the box.`);
      return out;
    }
    let picture = crop(design, request.box);

    if (request.kind === "background") {
      (request.drawnOver ?? []).forEach((over, n) => {
        const part = intersect(over, request.box);
        if (!part) {
          out.flags.push(`Drawn-over box ${n + 1} for ${request.id} does not touch it, so nothing was wiped; remove the box or move it onto the picture.`);
          return;
        }
        const result = wipeAndFill(picture, { x: part.x - request.box.x, y: part.y - request.box.y, w: part.w, h: part.h });
        if (result.ok) {
          picture = result.image;
          out.patches.push(result.record);
          if (result.record.method === "soft") {
            out.flags.push(`${request.id}: the picture behind drawn-over box ${n + 1} is not a plain colour or an even, straight-line gradient, so TAWD smoothed it over; what was under it can't be known, so upload the picture without the text for a clean copy.`);
          }
        } else {
          out.flags.push(`Drawn-over box ${n + 1} for ${request.id} was left in the picture (${result.reason}); upload the picture without it.`);
        }
      });
    } else if (request.kind === "logo" || request.kind === "cutout" || request.kind === "silhouette") {
      const band = request.band;
      if (request.kind === "silhouette" && (!band || !boxInside(band, design) || !boxInside(request.box, { width: band.x + band.w, height: band.y + band.h }) || request.box.x < band.x || request.box.y < band.y)) {
        out.flags.push(`The silhouette ${request.id} has no band around it inside the design, so it was cut as a plain picture; give the band it stands in.`);
      } else {
        // A silhouette's background is read from the sides that lie inside its band (all four if none do).
        const inside = request.kind === "silhouette" ? edgesInside(request.box, band!) : [];
        const t = toTransparent(picture, inside.length > 0 ? inside : undefined);
        if ("refused" in t) {
          out.flags.push(`${request.id} can't be made see-through (${t.refused}); upload the file.`);
        } else {
          picture = t.picture;
          out.transparentOn = t.colour;
          if (request.kind === "silhouette") {
            const faded = fadeEdges(picture, request.box, request.band!);
            picture = faded.picture;
            out.fadedEdges = faded.edges;
          }
        }
      }
    }
    out.picture = picture;
  } catch (e) {
    out.flags.push(`${request.id} could not be prepared (${e instanceof Error ? e.message : String(e)}); upload the file.`);
  }
  return out;
}

export function prepareAssets(design: Rgba, requests: PictureRequest[]): PreparedAsset[] {
  return requests.map((r) => prepareAsset(design, r));
}

/** PNG or JPEG bytes (base64) to pixels, drawn at the picture's natural size. */
export async function readPixels(page: Page, base64: string, mime: "image/png" | "image/jpeg"): Promise<Rgba> {
  const result = await page.evaluate(
    async ({ b64, type }) => {
      const im = new Image();
      im.src = `data:${type};base64,${b64}`;
      await im.decode();
      const canvas = document.createElement("canvas");
      canvas.width = im.naturalWidth;
      canvas.height = im.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(im, 0, 0);
      const bytes = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let text = "";
      for (let i = 0; i < bytes.length; i += 32768) {
        text += String.fromCharCode(...bytes.subarray(i, i + 32768));
      }
      return { width: canvas.width, height: canvas.height, b64: btoa(text) };
    },
    { b64: base64, type: mime },
  );
  return { width: result.width, height: result.height, data: new Uint8ClampedArray(Buffer.from(result.b64, "base64")) };
}

/** Pixels to a PNG, as base64. */
export async function writePng(page: Page, picture: Rgba): Promise<string> {
  const b64 = Buffer.from(picture.data.buffer, picture.data.byteOffset, picture.data.byteLength).toString("base64");
  const url = await page.evaluate(
    ({ raw, width, height }) => {
      const text = atob(raw);
      const bytes = new Uint8ClampedArray(text.length);
      for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")!.putImageData(new ImageData(bytes, width, height), 0, 0);
      return canvas.toDataURL("image/png");
    },
    { raw: b64, width: picture.width, height: picture.height },
  );
  return url.replace(/^data:image\/png;base64,/, "");
}
