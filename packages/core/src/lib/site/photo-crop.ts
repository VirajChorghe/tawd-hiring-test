/*
  Photos cut from a design PDF often carry bits of the design with them: a
  tab bar across the bottom ("Photo Gallery / In Action"), a heart or a
  letter at an edge (Jason, 29 September 2026). The design's read knows
  where its words and drawn marks are, so a photo is trimmed to the largest
  part of it free of them. Only things near an edge are trimmed away (a
  heading set over the middle of a photo is part of the design); if the
  clean part would be under minShare of the photo, it is left as it is.
*/

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0;

/** The clean part of a photo, or null when nothing needs trimming (or too little would be left). */
export function clearArea(photo: Box, obstacles: Box[], options: { margin?: number; edgeBand?: number; minShare?: number } = {}): Box | null {
  const margin = options.margin ?? 16;
  const band = options.edgeBand ?? 0.28;
  const minShare = options.minShare ?? 0.45;
  // Only what sits along an edge of the photo.
  const near = obstacles
    .map((o) => ({ x: o.x - margin, y: o.y - margin, w: o.w + margin * 2, h: o.h + margin * 2 }))
    .filter((o) => overlaps(o, photo))
    .filter((o) => {
      const left = (o.x + o.w - photo.x) / photo.w;
      const right = (photo.x + photo.w - o.x) / photo.w;
      const top = (o.y + o.h - photo.y) / photo.h;
      const bottom = (photo.y + photo.h - o.y) / photo.h;
      return Math.min(left, right, top, bottom) <= band;
    });
  if (near.length === 0) return null;
  let area: Box = { ...photo };
  for (const o of near) {
    if (!overlaps(o, area)) continue;
    // Keep the biggest of the four sides of the obstacle.
    const options: Box[] = [
      { x: area.x, y: area.y, w: area.w, h: o.y - area.y },
      { x: area.x, y: o.y + o.h, w: area.w, h: area.y + area.h - (o.y + o.h) },
      { x: area.x, y: area.y, w: o.x - area.x, h: area.h },
      { x: o.x + o.w, y: area.y, w: area.x + area.w - (o.x + o.w), h: area.h },
    ].filter((b) => b.w > 0 && b.h > 0);
    const best = options.sort((a, b) => b.w * b.h - a.w * a.h)[0];
    if (!best) return null;
    area = best;
  }
  if (area.w * area.h < photo.w * photo.h * minShare) return null;
  return area;
}
