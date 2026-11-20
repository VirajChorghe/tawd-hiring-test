import { elementAt } from "./sections";
import { paletteFamily } from "./directions";

/*
  Shutterstock previews in mockups (26 September 2026).

  Where no photo the client uploaded fits, the builder draws a labeled
  placeholder frame. It now also marks the frame with a short search
  phrase:

      <div class="photo-frame" data-tawd-photo="plumber repairing kitchen sink">
        Photo: plumber at work under a kitchen sink
      </div>

  The worker looks each phrase up on Shutterstock once per project and,
  when a picture is found, fills the frame with its watermarked preview
  and a visible "Shutterstock preview" label. Nothing is licensed: that
  comes later, for the pictures the client keeps. The page's source keeps
  the plain frame, so fix rounds and edits see what the builder wrote, and
  the client's own photos always come first (the builder only draws a frame
  where none of theirs fits).

  Frames for the client's own people, premises, vehicles or work carry no
  phrase and stay labeled boxes: a stranger in their place would be an
  invented fact.
*/

export const STOCK_FRAME_ATTR = "data-tawd-photo";
export const STOCK_LABEL = "Shutterstock preview";

export interface StockPicture {
  /** The picture itself, inlined like the client's photos. */
  dataUri: string;
  /** Shutterstock's id, kept on the page for when it is licensed. */
  id: string;
}

const FRAME = /<([a-zA-Z][\w-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*?\sdata-tawd-photo\s*=\s*(["'])([^"']*)\2(?:[^>"']|"[^"]*"|'[^']*')*?>/g;
const VOID = new Set(["img", "input", "br", "hr", "source", "embed", "area", "col", "wbr", "meta", "link"]);

/** The search phrase as it is looked up and stored: trimmed, lower case, one space, at most 80 characters. */
export function normalizeStockQuery(phrase: string): string {
  return phrase
    .replace(/&amp;/g, "&")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .toLowerCase()
    .replace(/[^a-z0-9&' -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
}

interface Frame {
  start: number;
  openEnd: number;
  tag: string;
  openTag: string;
  query: string;
}

function framesIn(html: string): Frame[] {
  const out: Frame[] = [];
  FRAME.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FRAME.exec(html)) !== null) {
    const query = normalizeStockQuery(match[3] ?? "");
    const tag = match[1]!.toLowerCase();
    if (!query || VOID.has(tag)) continue;
    out.push({ start: match.index, openEnd: FRAME.lastIndex, tag, openTag: match[0], query });
  }
  return out;
}

/** The phrases the page's frames ask for, once each, top to bottom. */
export function stockQueries(html: string): string[] {
  return [...new Set(framesIn(html).map((f) => f.query))];
}

/* The attribute a page carries to say which picture it took for a phrase. */
export const STOCK_PICK_ATTR = "data-tawd-stock-id";
// String.raw, so the backslashes reach the pattern; the only thing interpolated is TAWD's own constant.
const PICK_IN_TAG = new RegExp(String.raw`\s${STOCK_PICK_ATTR}\s*=\s*["']([^"']+)["']`, "i");

/*
  Which picture this page took, by phrase (F28, 9 November 2026).

  Two concepts in one project asking the same phrase used to be handed the
  same photograph: the search is saved per project and only its winner was
  kept, so the page had no say. Now the concept's own pick is written into
  its frame when the version is stored, and every later render - the review,
  a polish pass, a changes run - reads it from the page instead of asking
  again. The page carries what was decided about it; nothing downstream has
  to know which concept it is looking at.
*/
export function stockPicks(html: string): Record<string, string> {
  const picks: Record<string, string> = {};
  for (const frame of framesIn(html)) {
    const id = PICK_IN_TAG.exec(frame.openTag)?.[1];
    if (id && !picks[frame.query]) picks[frame.query] = id;
  }
  return picks;
}

/*
  The page with each frame told which picture it took. Only frames whose
  phrase has a pick are touched, an id already there is replaced (a rebuild
  may take a different one), and nothing else in the tag moves.
*/
export function stampStockPicks(html: string, picks: Record<string, string>): string {
  if (Object.keys(picks).length === 0) return html;
  let out = html;
  // Last frame first, so earlier offsets stay valid.
  for (const frame of framesIn(html).reverse()) {
    const id = picks[frame.query];
    if (!id || !/^[\w-]{1,64}$/.test(id)) continue;
    const bare = frame.openTag.replace(PICK_IN_TAG, "");
    const stamped = bare.replace(/\s*(\/?>)$/, ` ${STOCK_PICK_ATTR}="${escapeAttr(id)}"$1`);
    out = out.slice(0, frame.start) + stamped + out.slice(frame.openEnd);
  }
  return out;
}

const escapeAttr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/* Keeps the frame's own size and shape (not its placeholder border); the picture covers it and the label sits in a corner. */
const FRAME_STYLE = "position:relative;overflow:hidden;min-height:200px;border:0;";
const IMG_STYLE = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;margin:0;border:0;";
const LABEL_STYLE =
  "position:absolute;left:10px;bottom:10px;z-index:1;padding:4px 8px;border-radius:4px;background:rgba(17,17,17,0.78);color:#ffffff;font:600 12px/1.3 system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:0.02em;";

function withFrameStyle(openTag: string, id: string): string {
  const marked = openTag.replace(/\s*\/?>$/, (end) => ` data-tawd-stock="${escapeAttr(id)}"${end}`);
  const style = /\sstyle\s*=\s*(["'])([\s\S]*?)\1/i.exec(marked);
  if (style) {
    const current = style[2]!.trim();
    const joined = `${current}${current && !current.endsWith(";") ? ";" : ""}${FRAME_STYLE}`;
    return marked.slice(0, style.index) + ` style=${style[1]}${joined}${style[1]}` + marked.slice(style.index + style[0].length);
  }
  return marked.replace(/\s*>$/, ` style="${FRAME_STYLE}">`);
}

/*
  At most 8 stock pictures per mockup (27 September 2026): the client's own
  photos come first, stock only fills the gaps. Frames past the eighth
  stay labeled boxes.
*/
export const MAX_STOCK_PER_PAGE = 8;

/*
  One colour treatment for every stock picture on a page, so pictures from
  different photographers look like one set: slightly calmer colour and a
  light wash of the brand's main colour.
*/
export interface StockTreatment {
  /** The brand's main colour, as #rrggbb. */
  tint: string | null;
}

const TREATED_IMG = "filter:saturate(0.85) contrast(1.05);";
const toneStyle = (tint: string) => `position:absolute;inset:0;z-index:0;background:${tint};mix-blend-mode:color;opacity:0.18;pointer-events:none;`;

/**
 * Fills each frame that has a picture with it and the label; frames with
 * none stay as the builder drew them. Last first, so positions stay valid.
 */
export function applyStockPictures(html: string, pictures: Record<string, StockPicture | null | undefined>, treatment: StockTreatment = { tint: null }): string {
  let out = html;
  // The first eight frames with a picture, top to bottom.
  const allowed = new Set(
    framesIn(html)
      .filter((frame) => pictures[frame.query])
      .slice(0, MAX_STOCK_PER_PAGE)
      .map((frame) => frame.start),
  );
  const tint = treatment.tint && /^#[0-9a-f]{6}$/i.test(treatment.tint) ? treatment.tint : null;
  for (const frame of framesIn(html).reverse()) {
    const picture = pictures[frame.query];
    if (!picture || !allowed.has(frame.start)) continue;
    // Measured on the page as filled so far: only frames further down have changed.
    const element = elementAt(out, frame.start);
    if (!element) continue;
    const alt = `${frame.query} (${STOCK_LABEL.toLowerCase()}, not the client's photo)`;
    const inner =
      `<img src="${picture.dataUri}" alt="${escapeAttr(alt)}" style="${IMG_STYLE}${TREATED_IMG}">` +
      (tint ? `<span class="tawd-stock-tone" aria-hidden="true" style="${toneStyle(tint)}"></span>` : "") +
      `<span class="tawd-stock-label" style="${LABEL_STYLE}">${STOCK_LABEL}</span>`;
    out = out.slice(0, frame.start) + withFrameStyle(frame.openTag, picture.id) + inner + out.slice(element.innerEnd);
  }
  return out;
}

/*
  A frame Shutterstock couldn't fill (0.103.5, the official run's "Photo is
  missing" card): one of the client's own photos not shown elsewhere on the
  page, top to bottom, each used once. Without one the frame stays a
  labeled box (the checks name it). Frames already holding stock are left.
*/
export function fillFramesWithClientPhotos(html: string, photos: string[]): { html: string; filled: number } {
  const unused = [...new Set(photos)].filter((uri) => uri && !html.includes(uri));
  const frames = framesIn(html).filter((frame) => !/\sdata-tawd-stock\s*=/.test(frame.openTag));
  const plan = frames.slice(0, unused.length).map((frame, i) => ({ frame, uri: unused[i]! }));
  let out = html;
  for (const { frame, uri } of [...plan].reverse()) {
    const element = elementAt(out, frame.start);
    if (!element) continue;
    const open = frame.openTag.replace(/\s*\/?>$/, (end) => ` data-tawd-client-photo${end}`);
    const style = /\sstyle\s*=\s*(["'])([\s\S]*?)\1/i.exec(open);
    const styled = style
      ? open.slice(0, style.index) + ` style=${style[1]}${style[2]!.trim()}${style[2]!.trim() && !style[2]!.trim().endsWith(";") ? ";" : ""}${FRAME_STYLE}${style[1]}` + open.slice(style.index + style[0].length)
      : open.replace(/\s*>$/, ` style="${FRAME_STYLE}">`);
    out = out.slice(0, frame.start) + styled + `<img src="${uri}" alt="${escapeAttr(frame.query)}" style="${IMG_STYLE}">` + out.slice(element.innerEnd);
  }
  return { html: out, filled: plan.length };
}

/*
  Stock that clashes with the brand (27 September 2026): a picture whose
  description shows uniforms, vans or logos in a colour that isn't the
  client's reads as another company, and a named competitor is never used.
  Read from Shutterstock's own description, with no AI.
*/
const BRANDED_THING = /\b(uniforms?|shirts?|polo|overalls?|coveralls?|jackets?|vests?|hats?|caps?|vans?|trucks?|vehicles?|logo|branded|company car)\b/i;
const COLOUR_WORDS: Record<string, string> = {
  red: "red", orange: "orange", yellow: "yellow", green: "green", teal: "teal", blue: "blue", navy: "blue", purple: "purple", pink: "pink",
};

export function stockClash(description: string | null | undefined, brandColors: string[], competitors: string[] = []): string | null {
  const text = (description ?? "").toLowerCase();
  if (!text) return null;
  for (const name of competitors) {
    const clean = name.trim().toLowerCase();
    if (clean.length > 2 && text.includes(clean)) return `Shows ${name.trim()}, a competitor the client named.`;
  }
  if (!BRANDED_THING.test(text)) return null;
  const families = new Set(brandColors.map((c) => paletteFamily(c)).filter(Boolean));
  if (families.size === 0) return null;
  for (const [word, family] of Object.entries(COLOUR_WORDS)) {
    const near = new RegExp(`\\b${word}\\b[^.,;]{0,24}${BRANDED_THING.source}|${BRANDED_THING.source}[^.,;]{0,12}\\b${word}\\b`, "i");
    if (near.test(text) && !families.has(family)) return `May show another company's uniforms or vehicles in ${word}, which isn't a brand colour.`;
  }
  return null;
}

/** The rule for the builder, added to the images rule in the system prompt. */
export const STOCK_FRAME_RULE = `- On every placeholder frame for a general scene (the trade at work, a finished job of that kind, tools, a happy homeowner), add ${STOCK_FRAME_ATTR}="a short stock photo search phrase", 3 to 6 plain words, for example <div class="photo-frame" ${STOCK_FRAME_ATTR}="plumber repairing kitchen sink">Photo: plumber at work under a sink</div>. TAWD may fill that frame with a labeled stock preview. Choose each phrase for its own band's subject (the service that band describes, the kind of home it names), use at most one stock frame per band and at most 8 on the page, and never ask for people in another company's uniform. Use it only on a div or figure, never on an img. Leave it off any frame that must show the client's own people, premises, vehicles or finished work (the team, the owner, the shop front, their trucks, their projects): those frames wait for the client's real photos.`;
