import type { FontRole, KitElement, PageInventory, SectionInventory } from "./elements";
import { ROLE_FALLBACK } from "./fonts";
import { findIcon, iconSvg, type IconStyle } from "./icon-set";
import { iconFor, iconSvg as tablerIconSvg } from "../mockups/icons";
import type { Mask } from "./contour";
import { unpackMask } from "./elements";
import { edgeSimilarity, fitSquare } from "./matching";
import { colorDistance, fromHex, toHex } from "./pixels";

/*
  The site style kit (Jason, 28 September 2026): built once per design, by
  code, from the pages' inventories. Colours, fonts, panels, bordered
  boxes, buttons, ribbons, icons and dividers, each with a class name; the
  copy's builder uses the class names and the icon markers, and code fills
  in the exact styles and SVGs afterwards. Nothing here calls AI.
*/

export interface IconChoice {
  /** The inventory id of the icon (s4-icon-1). */
  id: string;
  /** A vector icon from the kit's set, or null to use the design's own traced shape. */
  name: string | null;
  style: IconStyle | null;
  score: number;
  /** Drawn inside a ring or on a disc in the design (CSS draws that part). */
  frame: "ring" | "disc" | null;
}

export interface FontChoice {
  role: FontRole;
  family: string;
  score: number;
  alternatives: { family: string; score: number }[];
  weights: number[];
  /** Where each weight's file is kept (set by the worker once the files are fetched), else null. */
  files: { weight: number; key: string }[];
}

export interface KitPart {
  /** The class the builder uses (kit-panel-1). */
  className: string;
  kind: "panel" | "card" | "box" | "button" | "ribbon" | "divider";
  css: string;
  /** Plain words for the builder and the team. */
  description: string;
  /** The inventory ids that use it. */
  uses: string[];
}

export interface KitIcon {
  /** The marker the builder writes: <span data-kit-icon="kit-icon-3"></span>. */
  ref: string;
  svg: string;
  label: string;
  frame: "ring" | "disc" | null;
  /** A disc's fill (the icon's ink in the design), or a ring's colour. */
  frameColor: string | null;
  /** The glyph's colour: the ink, or on a disc the colour cut out of it (what's behind). */
  color: string;
  uses: string[];
  /** A traced icon's shape, to spot the same icon used again (not kept with the kit). */
  mask?: Mask;
  ratio?: number;
}

export interface StyleKit {
  version: 1;
  colors: { token: string; hex: string; uses: string[] }[];
  fonts: FontChoice[];
  parts: KitPart[];
  icons: KitIcon[];
  /** For each inventory element id, the kit class or icon marker it maps to. */
  map: Record<string, string>;
  /** Anything the kit could not match (a brand icon with no official mark, a distressed font...). */
  notes: string[];
  /** Pages that share a layout (by frame id), the first to be built, with how closely they agree (0-100). */
  sharedLayouts?: { pages: string[]; agreement: number }[];
}

type Placed = KitElement & { id: string };

const px = (n: number) => `${Math.round(n)}px`;

/* Finds an existing colour token within a small distance, or adds one. */
function colorToken(colors: StyleKit["colors"], hex: string, use: string): string {
  const c = fromHex(hex);
  const found = colors.find((t) => colorDistance(fromHex(t.hex), c) <= 8);
  if (found) {
    if (!found.uses.includes(use)) found.uses.push(use);
    return `var(${found.token})`;
  }
  const token = `--kit-color-${colors.length + 1}`;
  colors.push({ token, hex: toHex(c), uses: [use] });
  return `var(${token})`;
}

/* The kit colour nearest to hex within `within`, for an icon whose average colour is blurred by anti-aliasing. */
function snapColor(colors: StyleKit["colors"], hex: string, within: number): string {
  const c = fromHex(hex);
  let best: { hex: string; d: number } | null = null;
  for (const t of colors) {
    if (!t.uses.some((u) => u !== "icon")) continue;
    const d = colorDistance(fromHex(t.hex), c);
    if (d <= within && (!best || d < best.d)) best = { hex: t.hex, d };
  }
  return best?.hex ?? hex;
}

/* A colour token's name without var(). */
function tokenName(ref: string): string {
  return ref.replace(/^var\((.*)\)$/, "$1");
}

/* Parts that look the same share one class. */
function samePart(parts: KitPart[], kind: KitPart["kind"], css: string): KitPart | undefined {
  return parts.find((p) => p.kind === kind && p.css === css);
}

function round(n: number, step: number): number {
  return Math.round(n / step) * step;
}

export function buildStyleKit(input: { pages: PageInventory[]; icons: IconChoice[]; fonts: FontChoice[] }): StyleKit {
  const kit: StyleKit = { version: 1, colors: [], fonts: input.fonts, parts: [], icons: [], map: {}, notes: [] };
  const font = (role: FontRole) => {
    const f = input.fonts.find((x) => x.role === role);
    return f ? `"${f.family}", ${ROLE_FALLBACK[role]}` : ROLE_FALLBACK[role];
  };
  const texts = (section: SectionInventory) => section.elements.filter((e): e is Extract<Placed, { kind: "text" }> => e.kind === "text");
  const add = (kind: KitPart["kind"], css: string, description: string, id: string) => {
    let part = samePart(kit.parts, kind, css);
    if (!part) {
      const n = kit.parts.filter((p) => p.kind === kind).length + 1;
      part = { className: `kit-${kind}-${n}`, kind, css, description, uses: [] };
      kit.parts.push(part);
    }
    part.uses.push(id);
    kit.map[id] = part.className;
  };

  // Texts first, so an icon's blurred colour snaps to a real one; icons last in each section.
  for (const page of input.pages) for (const section of page.sections) for (const e of section.elements) if (e.kind === "text") colorToken(kit.colors, e.color, "text");
  for (const page of input.pages) {
    for (const section of page.sections) {
      colorToken(kit.colors, section.background, "section background");
      const elements = [...section.elements].sort((a, b) => Number(a.kind === "icon") - Number(b.kind === "icon"));
      for (const e of elements) {
        switch (e.kind) {
          case "panel": {
            const fill = colorToken(kit.colors, e.fill, "panel");
            add("panel", `background:${fill};border-radius:${px(round(e.radius, 4))};`, `a panel filled ${tokenName(fill)}${e.radius ? `, corners rounded ${round(e.radius, 4)}px` : ""}`, e.id);
            break;
          }
          case "card": {
            const fill = colorToken(kit.colors, e.fill, "card");
            const border = e.border ? `border:1px solid ${colorToken(kit.colors, e.border, "card border")};` : "";
            add("card", `background:${fill};${border}border-radius:${px(round(e.radius, 4))};`, `a card filled ${tokenName(fill)}${e.border ? " with a border" : ""}`, e.id);
            break;
          }
          case "box": {
            const border = colorToken(kit.colors, e.border, "box border");
            const width = Math.min(2, e.borderWidth);
            const css = `border:${width}px solid ${border};border-radius:${px(round(e.radius, 4))};position:relative;`;
            add("box", css, `a box outlined ${width}px ${tokenName(border)}${e.titleGap ? ", with its title set into the top border (put the title in a kit-box-title element inside this box)" : ""}`, e.id);
            break;
          }
          case "button": {
            const role = texts(section).find((t) => t.text && e.text.includes(t.text))?.role ?? "sans";
            const fill = e.fill ? `background:${colorToken(kit.colors, e.fill, "button")};` : "background:transparent;";
            const border = e.border ? `border:${e.fill ? 0 : 2}px solid ${colorToken(kit.colors, e.border, "button border")};` : "border:0;";
            const color = `color:${colorToken(kit.colors, e.textColor, "button text")};`;
            // Tap targets stay at least 44px tall (Jason, Batch 2); sizes are rounded so near-identical buttons share a class.
            const css = `display:inline-flex;align-items:center;justify-content:center;gap:10px;white-space:nowrap;${fill}${border}${color}border-radius:${px(round(Math.min(e.radius, 8), 4))};min-height:44px;padding:0 ${px(round(Math.max(16, e.box.h * 0.5), 8))};font-family:${font(role)};text-decoration:none;`;
            add("button", css, e.fill ? `a button filled ${tokenName(fill.slice(11, -1))}` : "an outlined button", e.id);
            break;
          }
          case "ribbon": {
            const fill = colorToken(kit.colors, e.fill, "ribbon");
            const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${e.box.w} ${e.box.h}' preserveAspectRatio='none'><path d='${e.path}' fill='${e.fill}'/></svg>`;
            const css = `display:inline-block;white-space:nowrap;width:auto;background:url("data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, "%27")}") center/100% 100% no-repeat;color:${colorToken(kit.colors, e.textColor, "ribbon text")};font-family:${font("script")};padding:${px(e.box.h * 0.18)} ${px(e.box.w * 0.18)};min-width:${px(e.box.w * 0.8)};text-align:center;`;
            // One ribbon shape serves every ribbon of the same colour and about the same size.
            const same = kit.parts.find((p) => p.kind === "ribbon" && p.description === `a brush-stroke ribbon ${tokenName(fill)} about ${round(e.box.w, 20)}px wide`);
            if (same) {
              same.uses.push(e.id);
              kit.map[e.id] = same.className;
            } else {
              add("ribbon", css, `a brush-stroke ribbon ${tokenName(fill)} about ${round(e.box.w, 20)}px wide`, e.id);
            }
            break;
          }
          case "divider": {
            const color = colorToken(kit.colors, e.color, "divider");
            add("divider", e.upright ? `border-left:1px solid ${color};align-self:stretch;` : `border-top:1px solid ${color};`, `a thin ${e.upright ? "upright" : "horizontal"} ${tokenName(color)} line`, e.id);
            break;
          }
          case "icon": {
            const choice = input.icons.find((i) => i.id === e.id);
            const named = choice?.name ? findIcon(choice.name, choice.style ?? undefined) : undefined;
            const svg = named
              ? iconSvg(named, 'width="1em" height="1em" aria-hidden="true" focusable="false"')
              : e.path
                ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${e.box.w} ${e.box.h}" width="${(e.box.w / e.box.h).toFixed(3)}em" height="1em" fill="currentColor" fill-rule="evenodd" aria-hidden="true" focusable="false"><path d="${e.path}"/></svg>`
                : iconSvg(findIcon("player-play", "filled")!, 'width="1em" height="1em" aria-hidden="true" focusable="false"');
            const label = named ? named.name.replace(/^brand-/, "") : e.group === "play over a photo" ? "play button" : "icon from the design";
            const color = snapColor(kit.colors, e.color, 70);
            // The same icon used again (the paws either side of a title) is one kit icon.
            const mask = fitSquare(unpackMask(e.mask), 32);
            const ratio = e.box.w / e.box.h;
            const existing = kit.icons.find(
              (k) => (k.color === color || k.frameColor === color) && k.frame === (choice?.frame ?? null) && (k.svg === svg || (!named && k.mask !== undefined && Math.abs(Math.log(k.ratio! / ratio)) < 0.25 && edgeSimilarity(k.mask, mask) >= 0.75)),
            );
            if (existing) {
              existing.uses.push(e.id);
              kit.map[e.id] = existing.ref;
              break;
            }
            const ref = `kit-icon-${kit.icons.length + 1}`;
            colorToken(kit.colors, color, "icon");
            const frame = choice?.frame ?? null;
            const play = e.group === "play over a photo";
            // On a disc the glyph is the hole: it shows what's behind (a play button's disc is a soft white).
            const glyph = frame === "disc" && !play ? snapColor(kit.colors, e.background, 30) : color;
            const frameColor = play ? "rgba(255,255,255,0.85)" : frame ? color : null;
            kit.icons.push({ ref, svg, label, frame, frameColor, color: glyph, uses: [e.id], mask: named ? undefined : mask, ratio });
            kit.map[e.id] = ref;
            break;
          }
          case "text": {
            colorToken(kit.colors, e.color, "text");
            break;
          }
          default:
            break;
        }
      }
    }
  }
  for (const i of kit.icons) {
    delete i.mask;
    delete i.ratio;
  }
  for (const f of input.fonts) if (f.score < 0.6) kit.notes.push(`The ${f.role} lettering matched ${f.family} only loosely (${Math.round(f.score * 100)}%); the designer may prefer ${f.alternatives.map((a) => a.family).slice(0, 2).join(" or ")}.`);
  return kit;
}

/* The kit as CSS: colour tokens, the fonts, every part's class, and the icon helpers. */
export function kitCss(kit: StyleKit, fontUrl: (key: string) => string): string {
  const faces = kit.fonts.flatMap((f) => f.files.map((file) => `@font-face{font-family:"${f.family}";font-weight:${file.weight};font-style:normal;font-display:swap;src:url("${fontUrl(file.key)}") format("woff2");}`));
  const roles = kit.fonts.map((f) => `--kit-font-${f.role}:"${f.family}", ${ROLE_FALLBACK[f.role]};`);
  const root = `:root{${kit.colors.map((c) => `${c.token}:${c.hex};`).join("")}${roles.join("")}}`;
  const parts = kit.parts.map((p) => `.${p.className}{${p.css}}`);
  const helpers = [
    `.kit-box-title{position:absolute;left:50%;top:0;transform:translate(-50%,-50%);background:var(--kit-title-bg,#fff);padding:0 24px;white-space:nowrap;margin:0;width:max-content;max-width:90%;}`,
    `[data-kit-icon]{display:inline-flex;align-items:center;justify-content:center;line-height:1;vertical-align:middle;}`,
    `[data-kit-icon] svg{height:1em;width:auto;display:block;}`,
    `[data-kit-icon][data-kit-frame="ring"]{border:2px solid currentColor;border-radius:50%;width:2em;height:2em;}`,
    `[data-kit-icon][data-kit-frame="ring"] svg,[data-kit-icon][data-kit-frame="disc"] svg{height:1em;}`,
    `[data-kit-icon][data-kit-frame="disc"]{border-radius:50%;width:2em;height:2em;}`,
  ];
  const icons = kit.icons.map(
    (i) =>
      `[data-kit-icon="${i.ref}"]{color:${i.color};}` +
      (i.frame === "disc" ? `[data-kit-icon="${i.ref}"][data-kit-frame="disc"]{background:${i.frameColor};}` : "") +
      (i.frame === "ring" ? `[data-kit-icon="${i.ref}"][data-kit-frame="ring"]{border-color:${i.frameColor};}` : ""),
  );
  return [...faces, root, ...parts, ...helpers, ...icons].join("\n");
}

/*
  Fills the builder's markers with the kit: each <span data-kit-icon="ref">
  (or <i>) gets the icon's SVG and frame, and the kit's CSS goes into the
  head. The builder never writes SVG itself.
*/
export function applyKit(html: string, kit: StyleKit, css: string, options: { fillUnknown?: boolean } = {}): { html: string; unknownIcons: string[] } {
  const unknown: string[] = [];
  // Any element the builder marked (a <span>, or a <div> it styled as a circle: those were left empty before, 29 September 2026).
  let out = html.replace(/<(span|i|div|em|b|strong|figure)([^>]*?)data-kit-icon="([^"]+)"([^>]*)>([\s\S]*?)<\/\1>/g, (whole, tag: string, before: string, ref: string, after: string) => {
    const icon = kit.icons.find((i) => i.ref === ref);
    if (!icon) {
      unknown.push(ref);
      // Not in the design's kit (gap 9): fill from TAWD's own icon set by the word (never leave it empty or take it out), rather than dropping an icon the AI asked for.
      if (options.fillUnknown) {
        const attrs = `${before}${after}`;
        const aria = /aria-(label|hidden)=/.test(attrs) ? "" : ` aria-hidden="true"`;
        return `<${tag}${before}data-kit-icon="${ref}"${after}${aria} data-kit-fallback>${tablerIconSvg(iconFor(ref))}</${tag}>`;
      }
      return whole;
    }
    const attrs = `${before}${after}`;
    const frame = icon.frame && !/data-kit-frame=/.test(attrs) ? ` data-kit-frame="${icon.frame}"` : "";
    const aria = /aria-(label|hidden)=/.test(attrs) ? "" : ` aria-hidden="true"`;
    // An icon traced from the design itself (not one of the icon set): the finishing pass drops it where it stands alone.
    const traced = icon.label === "icon from the design" && !/data-kit-traced/.test(attrs) ? " data-kit-traced" : "";
    return `<${tag}${before}data-kit-icon="${ref}"${after}${frame}${aria}${traced}>${icon.svg}</${tag}>`;
  });
  const style = `<style data-kit>${css}</style>`;
  out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, `${style}</head>`) : `${style}${out}`;
  return { html: out, unknownIcons: [...new Set(unknown)] };
}

/* What the builder is told about the kit, and about one section's elements (by class and marker). */
export function describeKit(kit: StyleKit): string {
  const lines = [
    "The site's style kit (use these classes and markers; the exact styles, fonts and icons are filled in by code afterwards):",
    `Colours: ${kit.colors.map((c) => `${c.token} ${c.hex} (${c.uses.slice(0, 3).join(", ")})`).join("; ")}.`,
    `Fonts: ${kit.fonts.map((f) => `${f.role} lettering is var(--kit-font-${f.role}) (${f.family})`).join("; ")}. Set font-family with these variables only.`,
    ...kit.parts.map((p) => `.${p.className}: ${p.description}.`),
    `Icons: write <span data-kit-icon="REF"></span> where the design has the icon, sized with font-size (the icon is 1em tall); never draw icons yourself, and where the kit has an icon use its marker, not a picture cut from the design. ${kit.icons.map((i) => `${i.ref} = ${i.label}${i.frame ? ` in a ${i.frame}` : ""}`).join("; ")}.`,
    "A box whose title is set into its top border: put the title in an element with class kit-box-title inside the box. Use kit-box-title only inside a kit box, never for a plain heading (a footer column heading, a section title): elsewhere it jumps out of place.",
  ];
  return lines.join("\n");
}

export function describeSectionForKit(kit: StyleKit, section: SectionInventory): string {
  const items = section.elements
    .filter((e) => e.kind !== "text" && e.kind !== "picture")
    .map((e) => {
      const ref = kit.map[e.id];
      if (!ref) return null;
      const where = `at x ${Math.round(e.box.x)}, y ${Math.round(e.box.y - section.top)} (${Math.round(e.box.w)}x${Math.round(e.box.h)})`;
      if (e.kind === "icon") return `- icon ${ref} ${where}`;
      if (e.kind === "button" || e.kind === "ribbon") return `- ${e.kind} "${e.text}" uses .${ref} ${where}`;
      return `- ${e.kind} uses .${ref} ${where}`;
    })
    .filter(Boolean);
  return items.length ? `Section ${section.number} (${section.name}) has these kit elements, every one of which must be in your build:\n${items.join("\n")}` : "";
}
