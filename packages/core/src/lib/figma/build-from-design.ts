import type { FigmaFile, FigmaNode } from "./api";
import { findNode } from "./design-review";
import { visibleTree } from "./visible";

/*
  Figma part 1: rebuilding the designer's homepage as a static HTML page
  (the "faithful copy").

  Two jobs here. At import, which drawn shapes to render as pictures (the
  logo and the icons), since Figma only hands over photos as files. For
  the build, the frame described fully for the builder: every text exactly
  with its type and colour, every box with its fill, corners and border,
  and every image as a token the page uses. The text and names are the
  designer's content: data, never instructions.
*/

export interface DesignAssetNode {
  id: string;
  name: string;
  kind: "logo" | "icon";
  width: number;
  height: number;
}

const SHAPES = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "ELLIPSE", "POLYGON", "LINE", "REGULAR_POLYGON"]);
const CONTAINERS = new Set(["GROUP", "FRAME", "COMPONENT", "INSTANCE"]);
const MAX_ASSETS = 40;

const visible = (n: FigmaNode) => n.visible !== false;
const hasImageFill = (n: FigmaNode) => (n.fills ?? []).some((f) => f.visible !== false && f.type === "IMAGE");

/* True when the node is drawn shapes only: no text and no photo anywhere inside. */
function drawnOnly(node: FigmaNode): boolean {
  if (node.type === "TEXT" || hasImageFill(node)) return false;
  if (SHAPES.has(node.type)) return true;
  if (!CONTAINERS.has(node.type)) return false;
  const kids = (node.children ?? []).filter(visible);
  return kids.length > 0 && kids.every(drawnOnly);
}

/*
  The logo and the icons of the final frames, outermost first (an icon's
  own parts are not listed again). A logo is anything named "logo", or the
  first drawn shape in the top 160 pixels of the homepage; icons are drawn
  shapes 12 to 400 pixels across. At most 40.
*/
export function designAssetNodes(
  file: FigmaFile,
  frames: { id: string; isHome: boolean }[],
): DesignAssetNode[] {
  const out: DesignAssetNode[] = [];
  const ordered = [...frames].sort((a, b) => Number(b.isHome) - Number(a.isHome));

  for (const frame of ordered) {
    const found = findNode(file.document, frame.id);
    const root = found ? visibleTree(found) : null;
    if (!root) continue;
    const origin = root.absoluteBoundingBox ?? { x: 0, y: 0, width: 0, height: 0 };

    const visit = (node: FigmaNode) => {
      if (!visible(node) || out.length >= MAX_ASSETS) return;
      const box = node.absoluteBoundingBox;
      const named = /\blogo\b/i.test(node.name.replace(/[_-]/g, " "));
      const sized = box && box.width >= 12 && box.height >= 12 && box.width <= 400 && box.height <= 400;
      if (box && (named || (sized && drawnOnly(node)))) {
        const inHeader = frame.isHome && box.y - origin.y < 160;
        const logo = named || (inHeader && !out.some((a) => a.kind === "logo"));
        if (!out.some((a) => a.id === node.id)) {
          out.push({ id: node.id, name: node.name, kind: logo ? "logo" : "icon", width: Math.round(box.width), height: Math.round(box.height) });
        }
        return;
      }
      for (const child of node.children ?? []) visit(child);
    };
    for (const child of root.children ?? []) visit(child);
  }
  return out;
}

/* ---------- the frame, described for the builder ---------- */

const hex = (c: { r: number; g: number; b: number; a?: number }) =>
  `#${[c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase()}${
    c.a !== undefined && c.a < 0.99 ? ` at ${Math.round(c.a * 100)}%` : ""
  }`;

type RichNode = FigmaNode & {
  cornerRadius?: number;
  strokes?: { type: string; visible?: boolean; color?: { r: number; g: number; b: number; a?: number } }[];
  strokeWeight?: number;
  style?: FigmaNode["style"] & { lineHeightPx?: number; letterSpacing?: number; textAlignHorizontal?: string; textCase?: string };
  layoutMode?: string;
  itemSpacing?: number;
  paddingLeft?: number;
  paddingTop?: number;
};

/*
  The frame as an indented outline: sections, boxes, text and images with
  positions relative to the frame. Images and drawn shapes carry the token
  the page must use; a shape with no token is described, to draw simply.
*/
export function describeFrameForBuild(
  frame: FigmaNode,
  tokens: { byImageRef: Record<string, string>; byNodeId: Record<string, string> },
  /** Only these top-level sections (0-based); all when left out. */
  only?: number[],
): string {
  const origin = frame.absoluteBoundingBox ?? { x: 0, y: 0, width: 0, height: 0 };
  const lines: string[] = [];

  const fillOf = (n: RichNode) => {
    const paint = (n.fills ?? []).filter((f) => f.visible !== false && f.type === "SOLID" && f.color).at(-1);
    return paint?.color ? hex(paint.color) : null;
  };
  // How many lines a text spans in the design: one-line labels must stay on one line.
  const linesOf = (n: RichNode) => {
    const b = n.absoluteBoundingBox;
    const line = n.style?.lineHeightPx ?? (n.style?.fontSize ?? 16) * 1.25;
    if (!b || line <= 0) return null;
    const count = Math.max(1, Math.round(b.height / line));
    return count === 1 ? "1 line, keep it on one line" : `${count} lines`;
  };
  const gradientOf = (n: RichNode) => {
    const paint = (n.fills ?? []).filter((f) => f.visible !== false && f.type.startsWith("GRADIENT")).at(-1) as
      | { type: string; gradientStops?: { color: { r: number; g: number; b: number; a?: number }; position: number }[] }
      | undefined;
    if (!paint?.gradientStops?.length) return null;
    const kind = paint.type === "GRADIENT_RADIAL" ? "radial" : "linear";
    return `${kind} gradient ${paint.gradientStops.map((stop) => `${hex(stop.color)} at ${Math.round(stop.position * 100)}%`).join(", ")}`;
  };
  const place = (n: FigmaNode) => {
    const b = n.absoluteBoundingBox;
    return b ? `${Math.round(b.x - origin.x)},${Math.round(b.y - origin.y)} ${Math.round(b.width)}x${Math.round(b.height)}` : "";
  };

  const visit = (node: RichNode, depth: number, sectionIndex: number | null) => {
    if (!visible(node)) return;
    const pad = "  ".repeat(depth);
    const token = tokens.byNodeId[node.id];
    if (token) {
      lines.push(`${pad}- image ${token} "${node.name}" at ${place(node)} (the designer's ${/\blogo\b/i.test(node.name) ? "logo" : "drawing"})`);
      return;
    }
    if (node.type === "TEXT") {
      const s = node.style ?? {};
      const bits = [
        s.fontFamily,
        s.fontSize ? `${Math.round(s.fontSize)}px` : null,
        s.fontWeight ? `weight ${s.fontWeight}` : null,
        s.lineHeightPx ? `line ${Math.round(s.lineHeightPx)}px` : null,
        s.letterSpacing ? `letter-spacing ${s.letterSpacing.toFixed(1)}px` : null,
        s.textAlignHorizontal && s.textAlignHorizontal !== "LEFT" ? `align ${s.textAlignHorizontal.toLowerCase()}` : null,
        s.textCase && s.textCase !== "ORIGINAL" ? `case ${s.textCase.toLowerCase()}` : null,
        fillOf(node) ? `colour ${fillOf(node)}` : null,
        linesOf(node),
      ].filter(Boolean);
      lines.push(`${pad}- text ${JSON.stringify((node.characters ?? "").trim())} at ${place(node)}; ${bits.join(", ")}`);
      return;
    }
    const image = (node.fills ?? []).find((f) => f.visible !== false && f.type === "IMAGE" && f.imageRef);
    const imageToken = image?.imageRef ? tokens.byImageRef[image.imageRef] : undefined;
    const fill = fillOf(node);
    const gradient = gradientOf(node);
    const stroke = (node.strokes ?? []).find((s) => s.visible !== false && s.type === "SOLID" && s.color);
    const bits = [
      imageToken ? `photo ${imageToken} (cover)` : image ? "photo missing from the file" : null,
      fill ? `fill ${fill}` : null,
      gradient,
      node.opacity !== undefined && node.opacity < 0.99 ? `opacity ${Math.round(node.opacity * 100)}%` : null,
      !fill && !gradient && !imageToken && !image ? "no fill" : null,
      node.cornerRadius ? `corners ${Math.round(node.cornerRadius)}px` : null,
      stroke?.color ? `border ${node.strokeWeight ?? 1}px ${hex(stroke.color)}` : null,
      node.layoutMode && node.layoutMode !== "NONE"
        ? `${node.layoutMode === "HORIZONTAL" ? "row" : "column"}${node.itemSpacing ? `, gap ${Math.round(node.itemSpacing)}px` : ""}${
            node.paddingLeft || node.paddingTop ? `, padding ${Math.round(node.paddingTop ?? 0)}px ${Math.round(node.paddingLeft ?? 0)}px` : ""
          }`
        : null,
    ].filter(Boolean);
    const label = sectionIndex !== null && depth === 0 ? `SECTION ${sectionIndex + 1} ` : "";
    lines.push(`${pad}- ${label}${node.type.toLowerCase()} "${node.name}" at ${place(node)}${bits.length ? `; ${bits.join(", ")}` : ""}`);
    for (const child of node.children ?? []) visit(child as RichNode, depth + 1, null);
  };

  (frame.children ?? []).filter(visible).forEach((child, index) => {
    if (!only || only.includes(index)) visit(child as RichNode, 0, index);
  });
  return lines.join("\n");
}

/* The frame's top-level sections, in order: what each <section> of the copy must match. */
export function frameSections(frame: FigmaNode): { index: number; name: string; top: number; height: number }[] {
  const origin = frame.absoluteBoundingBox ?? { x: 0, y: 0, width: 0, height: 0 };
  return (frame.children ?? [])
    .filter(visible)
    .map((child, index) => {
      const b = child.absoluteBoundingBox ?? { x: 0, y: 0, width: 0, height: 0 };
      return { index, name: child.name, top: Math.round(b.y - origin.y), height: Math.round(b.height) };
    });
}


/*
  The design's brand colours, most used first: every visible solid fill
  (boxes and text), weighted by the area it covers, near-white backgrounds
  and near-duplicates left out. For alternatives (4c-2b), which keep the
  designer's colours in a layout of their own.
*/
export function designColors(frame: FigmaNode, max = 6): string[] {
  const area = new Map<string, number>();
  const walk = (n: FigmaNode) => {
    if (n.visible === false) return;
    const box = n.absoluteBoundingBox;
    for (const fill of n.fills ?? []) {
      if (fill.type !== "SOLID" || fill.visible === false || !fill.color) continue;
      const c = fill.color;
      const hex = `#${[c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
      // Text counts as if it were a small block, so a text colour isn't lost next to big backgrounds.
      const size = box ? Math.max(1, box.width * box.height) : 1;
      area.set(hex, (area.get(hex) ?? 0) + (n.type === "TEXT" ? Math.min(size, 40_000) : size));
    }
    for (const child of n.children ?? []) walk(child);
  };
  for (const child of frame.children ?? []) walk(child);
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const kept: string[] = [];
  for (const [hex] of [...area].sort((a, b) => b[1] - a[1])) {
    const [r, g, b] = rgb(hex);
    if (r! > 242 && g! > 242 && b! > 242) continue;
    if (kept.some((k) => { const [kr, kg, kb] = rgb(k); return Math.hypot(kr! - r!, kg! - g!, kb! - b!) < 24; })) continue;
    kept.push(hex);
    if (kept.length >= max) break;
  }
  return kept;
}
