import { dropDoubledText, tidySpacedCapitals } from "@tawd/core/figma/text-tidy";
import type { DesignPicture, DesignSpec, DesignWord } from "./design-checks";
import type { PictureRequest } from "./design-assets";
import { hex, type Colour, type Rgba } from "./design-pixels";
import type { BandRole, ColourPoint, DesignRead, MeasuredColour, ReadBand, ReadWords } from "./design-read-types";

/*
  The code half of the design read (E4a-1, Lane 2, 14 November 2026; spec 15
  section 6 stage 2). No AI and no browser: the AI's small look at the whole
  page names the bands roughly; everything here checks and corrects what it
  said, in plain pixels, so a wrong guess shows up as a plain problem or is
  fixed from the picture itself.

  Rules, in the order the read uses them:
  - parseBandList: an AI reply { bands: [{ name, role, top, bottom }] } is
    checked band by band. Numbers must be finite and are rounded to whole
    pixels; top must be above bottom and both inside 0..page height; the
    role must be header, band or footer (any other role becomes "band" and
    a problem says so); a name is trimmed, and an empty one becomes
    "Band N" (N = its place in the reply). A band that fails is left out
    with a problem naming it. It never throws; anything that is not the
    expected shape gives an empty list and one problem.
  - checkCoverage: bands are sorted by top. A gap or overlap of 8 pixels or
    less between neighbours is closed (both edges move to the midpoint); a
    first top within 8 of the page's top becomes 0 and a last bottom within
    8 of the page's bottom becomes the page height. Anything bigger, a page
    not covered at the top or bottom, a header that is not first, a footer
    that is not last, two headers or two footers, or no bands at all, is
    returned as a problem for the caller to ask again once and then show a
    person. A band is never invented, merged or deleted.
  - snapEdges: the AI looks at a shrunk page, so its edges are a few pixels
    off. Each boundary between two bands moves to the row, within 16 pixels
    either way, where the picture changes most from the row above (per
    pixel, the biggest difference over the three colour channels, added up
    along the row). The page's own top and bottom never move; every band
    stays at least 8 pixels tall; and a boundary whose best row changes by
    less than 8 on average per pixel (out of 255: the noise in a photo or a
    soft gradient is around 2 to 5, a real colour change between two bands
    is 20 or more) stays where the AI put it, because there is no edge there
    to find. Known limit: a line of text just inside the reach can change
    more than a faint boundary; the strongest row wins.
  - measureColours: a point's colour is the middle value of each channel over
    the 5 by 5 pixels around it (fewer at the picture's edge), so one stray
    pixel (a text edge) does not matter. A point outside the picture is a
    problem and is skipped.
  - tidyWords: spaced capitals are rejoined and doubled text is dropped
    (rules in core's figma/text-tidy.ts, shared with the PDF text route).
    Other words are not changed.
  - toDesignSpec and toPictureRequests: shape the read for the checks (E2)
    and the pictures step (E3).
*/

const TOUCH_PX = 8;
const SNAP_REACH = 16;
/** The least average per-pixel change (0..255) that counts as an edge. */
const EDGE_MIN = 8;
const MIN_BAND_PX = 8;

const ROLES: BandRole[] = ["header", "band", "footer"];

export function parseBandList(json: unknown, height: number): { bands: ReadBand[]; problems: string[] } {
  const problems: string[] = [];
  const bands: ReadBand[] = [];
  const list = typeof json === "object" && json !== null ? (json as { bands?: unknown }).bands : undefined;
  if (!Array.isArray(list)) return { bands, problems: ["The band list is not in the expected shape: no list of bands was found."] };
  list.forEach((raw, i) => {
    const n = i + 1;
    if (typeof raw !== "object" || raw === null) {
      problems.push(`Band ${n} is not an object, so it was left out.`);
      return;
    }
    const r = raw as Record<string, unknown>;
    // Kept short: a name goes into the next prompt and on the screen.
    const name = typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 80) : `Band ${n}`;
    if (typeof r.top !== "number" || typeof r.bottom !== "number" || !Number.isFinite(r.top) || !Number.isFinite(r.bottom)) {
      problems.push(`"${name}" has no usable top and bottom, so it was left out.`);
      return;
    }
    const top = Math.round(r.top);
    const bottom = Math.round(r.bottom);
    if (!(top < bottom)) {
      problems.push(`"${name}" does not have its top above its bottom (${top} and ${bottom}), so it was left out.`);
      return;
    }
    if (top < 0 || bottom > height) {
      problems.push(`"${name}" runs from ${top} to ${bottom}, outside the page (0 to ${height}), so it was left out.`);
      return;
    }
    let role: BandRole = "band";
    if (typeof r.role === "string" && ROLES.includes(r.role as BandRole)) role = r.role as BandRole;
    else problems.push(`"${name}" has the role ${JSON.stringify(r.role) ?? "none"}, which is not header, band or footer; it is treated as a band.`);
    bands.push({ name, role, top, bottom });
  });
  return { bands, problems };
}

export function checkCoverage(bands: ReadBand[], height: number): { bands: ReadBand[]; problems: string[] } {
  const problems: string[] = [];
  if (bands.length === 0) return { bands: [], problems: ["No bands were found, so the page is not covered."] };
  const out = bands.map((b) => ({ ...b })).sort((a, b) => a.top - b.top);

  if (out[0]!.top <= TOUCH_PX) out[0]!.top = 0;
  else problems.push(`Nothing covers the top of the page: the first band, "${out[0]!.name}", starts at ${out[0]!.top}.`);

  for (let i = 0; i + 1 < out.length; i += 1) {
    const a = out[i]!;
    const b = out[i + 1]!;
    const gap = b.top - a.bottom;
    if (gap === 0) continue;
    if (Math.abs(gap) <= TOUCH_PX) {
      const mid = Math.round((a.bottom + b.top) / 2);
      a.bottom = mid;
      b.top = mid;
    } else if (gap > 0) {
      problems.push(`A gap of ${gap} pixels (${a.bottom} to ${b.top}) sits between "${a.name}" and "${b.name}".`);
    } else {
      problems.push(`"${a.name}" and "${b.name}" overlap by ${-gap} pixels (${b.top} to ${a.bottom}).`);
    }
  }

  const last = out[out.length - 1]!;
  if (Math.abs(height - last.bottom) <= TOUCH_PX) last.bottom = height;
  else problems.push(`Nothing covers the bottom of the page: the last band, "${last.name}", ends at ${last.bottom} of ${height}.`);

  for (const b of out) if (!(b.top < b.bottom)) problems.push(`"${b.name}" has no height left once its neighbours' edges meet.`);

  const headers = out.filter((b) => b.role === "header");
  const footers = out.filter((b) => b.role === "footer");
  if (headers.length > 1) problems.push(`There are ${headers.length} headers; a page has one.`);
  if (footers.length > 1) problems.push(`There are ${footers.length} footers; a page has one.`);
  if (headers.length > 0 && out[0]!.role !== "header") problems.push(`The header, "${headers[0]!.name}", is not the first band.`);
  if (footers.length > 0 && last.role !== "footer") problems.push(`The footer, "${footers[footers.length - 1]!.name}", is not the last band.`);

  return { bands: out, problems };
}

/** How much the picture changes between row y-1 and row y: the per-pixel biggest channel difference, averaged along the row. */
function rowChange(design: Rgba, y: number): number {
  const w = design.width;
  const d = design.data;
  let sum = 0;
  for (let x = 0; x < w; x += 1) {
    const a = ((y - 1) * w + x) * 4;
    const b = (y * w + x) * 4;
    sum += Math.max(Math.abs(d[a]! - d[b]!), Math.abs(d[a + 1]! - d[b + 1]!), Math.abs(d[a + 2]! - d[b + 2]!));
  }
  return sum / w;
}

/** The row in lo..hi with the strongest change; the nearest to `from` on a tie; `from` itself when no row reaches the edge minimum. */
function bestRow(design: Rgba, from: number, lo: number, hi: number): number {
  let best = from;
  let bestScore = EDGE_MIN;
  for (let y = Math.max(lo, 1); y <= Math.min(hi, design.height - 1); y += 1) {
    const s = rowChange(design, y);
    if (s > bestScore || (s === bestScore && best !== from && Math.abs(y - from) < Math.abs(best - from))) {
      best = y;
      bestScore = s;
    }
  }
  return best;
}

export function snapEdges(design: Rgba, bands: ReadBand[], reach = SNAP_REACH): ReadBand[] {
  const out = bands.map((b) => ({ ...b }));
  for (let i = 0; i + 1 < out.length; i += 1) {
    const a = out[i]!;
    const b = out[i + 1]!;
    if (a.bottom <= 0 || a.bottom >= design.height) continue;
    if (a.bottom === b.top) {
      const lo = Math.max(a.bottom - reach, a.top + MIN_BAND_PX);
      const hi = Math.min(a.bottom + reach, b.bottom - MIN_BAND_PX);
      const y = bestRow(design, a.bottom, lo, hi);
      a.bottom = y;
      b.top = y;
    } else {
      // Not touching (the caller has a coverage problem to deal with): each edge is snapped on its own.
      a.bottom = bestRow(design, a.bottom, Math.max(a.bottom - reach, a.top + MIN_BAND_PX), a.bottom + reach);
      b.top = bestRow(design, b.top, b.top - reach, Math.min(b.top + reach, b.bottom - MIN_BAND_PX));
    }
  }
  return out;
}

function median(values: number[]): number {
  const s = [...values].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

export function measureColours(design: Rgba, points: ColourPoint[]): { colours: MeasuredColour[]; problems: string[] } {
  const colours: MeasuredColour[] = [];
  const problems: string[] = [];
  for (const p of points) {
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= design.width || y >= design.height) {
      problems.push(`The colour point "${p.name}" (${p.x}, ${p.y}) is outside the ${design.width} by ${design.height} picture, so it was skipped.`);
      continue;
    }
    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    for (let yy = Math.max(0, y - 2); yy <= Math.min(design.height - 1, y + 2); yy += 1) {
      for (let xx = Math.max(0, x - 2); xx <= Math.min(design.width - 1, x + 2); xx += 1) {
        const i = (yy * design.width + xx) * 4;
        rs.push(design.data[i]!);
        gs.push(design.data[i + 1]!);
        bs.push(design.data[i + 2]!);
      }
    }
    const c: Colour = [median(rs), median(gs), median(bs)];
    colours.push({ ...p, hex: hex(c) });
  }
  return { colours, problems };
}

export function tidyWords(words: ReadWords[]): ReadWords[] {
  const rejoined = words.map((w) => {
    const text = tidySpacedCapitals(w.text);
    return text === w.text ? w : { ...w, text };
  });
  return dropDoubledText(rejoined, (w) => w.text, (w) => w.box);
}

export function toDesignSpec(read: DesignRead, picture: Buffer): DesignSpec {
  const bands = [...read.bands].sort((a, b) => a.band.top - b.band.top);
  const words: DesignWord[] = [];
  const pictures: DesignPicture[] = [];
  for (const b of bands) {
    const ordered = [...b.words].sort((p, q) => p.box.y - q.box.y || p.box.x - q.box.x);
    for (const w of ordered) {
      for (const part of w.text.split(/\s+/).filter(Boolean)) words.push(w.unsure ? { text: part, uncertain: true } : { text: part });
    }
    for (const p of b.pictures) if (p.kind !== "icon") pictures.push({ name: p.id, x: p.box.x, y: p.box.y, w: p.box.w, h: p.box.h });
  }
  return {
    width: read.width,
    height: read.height,
    bands: bands.map((b) => ({ name: b.band.name, top: b.band.top, height: b.band.bottom - b.band.top })),
    words,
    pictures,
    picture,
  };
}

export function toPictureRequests(read: DesignRead): PictureRequest[] {
  const counts = new Map<string, number>();
  for (const b of read.bands) for (const p of b.pictures) counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
  const used = new Set<string>();
  const requests: PictureRequest[] = [];
  read.bands.forEach((b, bi) => {
    for (const p of b.pictures) {
      let id = p.id;
      if ((counts.get(p.id) ?? 0) > 1 || used.has(id)) id = `b${bi + 1}-${p.id}`;
      while (used.has(id)) id = `${id}-x`;
      used.add(id);
      const req: PictureRequest = { id, kind: p.kind, box: p.box };
      if (p.drawnOver) req.drawnOver = p.drawnOver;
      if (p.kind === "silhouette") req.band = { x: 0, y: b.band.top, w: read.width, h: b.band.bottom - b.band.top };
      if (p.label !== undefined) req.label = p.label;
      if (p.context !== undefined) req.context = p.context;
      requests.push(req);
    }
  });
  return requests;
}
