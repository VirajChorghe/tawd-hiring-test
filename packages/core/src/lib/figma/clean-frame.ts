import type { FigmaNode } from "./api";
import { visibleTree } from "./visible";

/*
  The frame as the page should be built from it (Jason, 27 September 2026,
  after the Pat Rivera copy came back at 66% with repeated sections, an
  old set of reviews and a blurry leftover image). On top of what
  visibleTree leaves out, a designer's leftovers are often still "visible"
  in Figma but covered, not hidden:

  - a layer completely covered by solid layers painted above it (an old
    reviews block under a newer one, say) is left out;
  - two sections stacked in the same place: only the one on top is kept,
    once;
  - a large flattened picture with no live text (a screenshot of sections
    that also exist as real layers) is left out;
  - sections are read top to bottom as the page shows them, not in the
    order of Figma's layer list.

  Each one is reported, so the import can warn and the copy can say the
  design file needs cleaning.
*/

type Box = { x: number; y: number; width: number; height: number };

export interface FrameProblem {
  kind: "covered" | "stacked" | "flattened_image";
  name: string;
}

const intersect = (a: Box, b: Box): Box | null => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
};

/* Solid all over: a visible, fully opaque colour or picture fill on a box (never text). */
function isOpaque(n: FigmaNode): boolean {
  if (n.type === "TEXT" || (n.opacity ?? 1) < 0.99) return false;
  return (n.fills ?? []).some(
    (f) => f.visible !== false && ((f.type === "SOLID" && (f.color?.a ?? 1) >= 0.99 && ((f as { opacity?: number }).opacity ?? 1) >= 0.99) || f.type === "IMAGE"),
  );
}

const hasText = (n: FigmaNode): boolean => n.type === "TEXT" || (n.children ?? []).some(hasText);

/* The share of a box covered by the others, from a 12 x 12 grid of points. */
function coverage(box: Box, over: Box[]): number {
  if (over.length === 0 || box.width <= 0 || box.height <= 0) return 0;
  let hit = 0;
  const steps = 12;
  for (let i = 0; i < steps; i += 1) {
    for (let j = 0; j < steps; j += 1) {
      const px = box.x + ((i + 0.5) / steps) * box.width;
      const py = box.y + ((j + 0.5) / steps) * box.height;
      if (over.some((o) => px >= o.x && px <= o.x + o.width && py >= o.y && py <= o.y + o.height)) hit += 1;
    }
  }
  return hit / (steps * steps);
}

export function cleanFrame(frame: FigmaNode): { frame: FigmaNode; problems: FrameProblem[] } {
  const shown = visibleTree(frame);
  const problems: FrameProblem[] = [];
  const root = shown.absoluteBoundingBox ?? null;

  /* Paint order: a node is painted after its parent, siblings in list order. Each opaque box, clipped as it shows. */
  const order = new Map<FigmaNode, { index: number; last: number }>();
  const opaque: { index: number; box: Box }[] = [];
  let counter = 0;
  const walk = (node: FigmaNode, clip: Box | null) => {
    const index = counter++;
    const box = node.absoluteBoundingBox ?? null;
    const shownBox = box && clip ? intersect(box, clip) : box;
    if (node !== shown && shownBox && isOpaque(node)) opaque.push({ index, box: shownBox });
    const clips = node.type !== "GROUP" && node.type !== "SECTION" && node.clipsContent !== false && Boolean(box);
    const inner = clips && box ? (clip ? intersect(box, clip) : box) : clip;
    for (const child of node.children ?? []) walk(child, inner);
    order.set(node, { index, last: counter - 1 });
  };
  walk(shown, root);

  /* Covered: solid boxes painted later (and not inside it) cover it all. */
  const covered = (node: FigmaNode): boolean => {
    const place = order.get(node);
    const box = node.absoluteBoundingBox;
    if (!place || !box || box.width <= 0 || box.height <= 0) return false;
    const over = opaque.filter((o) => o.index > place.last && intersect(o.box, box)).map((o) => o.box);
    return coverage(box, over) >= 0.98;
  };
  const prune = (node: FigmaNode, depth: number): FigmaNode => {
    const kept: FigmaNode[] = [];
    for (const child of node.children ?? []) {
      if (covered(child)) {
        // Only what would have reached the page is worth naming.
        if (hasText(child) || depth === 0) problems.push({ kind: "covered", name: child.name });
        continue;
      }
      kept.push(prune(child, depth + 1));
    }
    return { ...node, children: node.children ? kept : undefined };
  };
  const pruned = prune(shown, 0);

  let sections = [...(pruned.children ?? [])];
  const frameWidth = root?.width ?? 0;

  /* A large flattened picture with no live text, while the page has real text elsewhere. */
  const flattened = (n: FigmaNode): boolean => {
    const box = n.absoluteBoundingBox;
    if (!box || hasText(n) || box.width < frameWidth * 0.8 || box.height < 900) return false;
    const pictures: Box[] = [];
    const find = (m: FigmaNode) => {
      if ((m.fills ?? []).some((f) => f.type === "IMAGE" && f.visible !== false) && m.absoluteBoundingBox) pictures.push(m.absoluteBoundingBox);
      (m.children ?? []).forEach(find);
    };
    find(n);
    return pictures.some((p) => p.width * p.height >= box.width * box.height * 0.9);
  };
  if (sections.some(hasText)) {
    sections = sections.filter((s) => {
      if (!flattened(s)) return true;
      problems.push({ kind: "flattened_image", name: s.name });
      return false;
    });
  }

  /* Stacked: two sections in the same place; the one on top (later in the list) is kept, once. */
  const overlap = (a: Box, b: Box) => {
    const both = intersect(a, b);
    if (!both) return 0;
    return Math.min(both.height / Math.min(a.height, b.height), both.width / Math.min(a.width, b.width));
  };
  const dropped = new Set<FigmaNode>();
  sections.forEach((lower, i) => {
    const a = lower.absoluteBoundingBox;
    if (!a) return;
    for (const upper of sections.slice(i + 1)) {
      const b = upper.absoluteBoundingBox;
      if (b && !dropped.has(upper) && overlap(a, b) >= 0.6) {
        dropped.add(lower);
        problems.push({ kind: "stacked", name: lower.name });
        return;
      }
    }
  });
  sections = sections.filter((s) => !dropped.has(s));

  /* Top to bottom as the page shows them. */
  sections.sort((a, b) => (a.absoluteBoundingBox?.y ?? 0) - (b.absoluteBoundingBox?.y ?? 0) || (a.absoluteBoundingBox?.x ?? 0) - (b.absoluteBoundingBox?.x ?? 0));

  return { frame: { ...pruned, children: pruned.children ? sections : undefined }, problems };
}

export const CLEAN_FRAME_MESSAGE = "This design file has overlapping or leftover content. Clean the frame in Figma, then re-import.";

/*
  A PDF or image design can't be cleaned in Figma (28 September 2026): the
  advice for it is to compare, then accept the copy as it is or build it
  again. Copies saved with the Figma advice read the same way.
*/
export const UPLOAD_STILL_OFF_MESSAGE = "Some sections still differ from the design after a rebuild. Compare them side by side, then accept the copy as it is or build it again.";

export function stillOffAdvice(source: string | null, reason: string | null): string | null {
  if (!reason) return reason;
  return source === "upload" && reason.startsWith(CLEAN_FRAME_MESSAGE) ? `${UPLOAD_STILL_OFF_MESSAGE}${reason.slice(CLEAN_FRAME_MESSAGE.length)}` : reason;
}

/* One warning for the import, naming a few of the layers. */
export function describeFrameProblems(frameName: string, problems: FrameProblem[]): string | null {
  if (problems.length === 0) return null;
  const names = (kind: FrameProblem["kind"]) => problems.filter((p) => p.kind === kind).map((p) => `"${p.name}"`);
  const parts = [
    names("covered").length ? `${names("covered").length} covered layer${names("covered").length === 1 ? "" : "s"} (${names("covered").slice(0, 3).join(", ")})` : null,
    names("stacked").length ? `${names("stacked").length} section${names("stacked").length === 1 ? "" : "s"} stacked under another (${names("stacked").slice(0, 3).join(", ")})` : null,
    names("flattened_image").length ? `a large flattened picture (${names("flattened_image").slice(0, 2).join(", ")})` : null,
  ].filter(Boolean);
  return `The frame "${frameName}" contains stacked or covered content: ${parts.join("; ")}. TAWD leaves these out, but it's safer to clean the frame in Figma and import again.`;
}
