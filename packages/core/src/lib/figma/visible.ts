import type { FigmaNode } from "./api";

/*
  What is really in a frame: the layers a visitor would see. A layer is
  left out when it is hidden, fully transparent, or lies outside the
  frame's visible area or outside any clipping container above it (a
  designer's second version of a section parked off to the side, say, or
  scrolled out of a clipped box). The copy, the review, the logo and icon
  picker and the pre-fill all read the frame through this, so nothing
  hidden or parked outside it ever reaches the page (the Pat Rivera copy
  picked up a second version's reviews, 25 September 2026).
*/

type Box = { x: number; y: number; width: number; height: number };

const intersect = (a: Box, b: Box): Box | null => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
};

/* The frame with only its shown layers, as a new tree; the file itself is untouched. */
export function visibleTree(frame: FigmaNode): FigmaNode {
  const root = frame.absoluteBoundingBox ?? null;

  const prune = (node: FigmaNode, clip: Box | null): FigmaNode | null => {
    if (node.visible === false) return null;
    if (node.opacity !== undefined && node.opacity <= 0.01) return null;
    const box = node.absoluteBoundingBox ?? null;
    // A zero-size text or line still counts if it sits inside; a box outside the clip does not.
    if (box && clip && box.width > 0 && box.height > 0 && !intersect(box, clip)) return null;
    // Frames clip their content unless the designer turned it off; groups never clip.
    const clips = node.type !== "GROUP" && node.type !== "SECTION" && node.clipsContent !== false && Boolean(box);
    const inner = clips && box ? (clip ? intersect(box, clip) : box) : clip;
    const children = (node.children ?? [])
      .map((child) => prune(child, inner))
      .filter((child): child is FigmaNode => child !== null);
    return { ...node, children: node.children ? children : undefined };
  };

  return prune(frame, root) ?? { ...frame, children: [] };
}
