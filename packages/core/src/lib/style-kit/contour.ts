import { colorDistance, rgbAt, type Box, type Pixels, type Rgb } from "./pixels";

/*
  Shapes to SVG, by code (style kit, 28 September 2026): a brush-stroke
  ribbon behind a name is traced from the picture into an SVG path, so the
  copy draws the same shape in vector instead of a plain rectangle.
*/

export interface Mask {
  w: number;
  h: number;
  on: Uint8Array;
}

/* Pixels of the box within `tolerance` of the colour, with anything they enclose (the text on a ribbon) filled in. */
export function colorMask(p: Pixels, box: Box, color: Rgb, tolerance = 48): Mask {
  const w = box.w, h = box.h;
  const on = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const px = box.x + x, py = box.y + y;
      if (px < 0 || py < 0 || px >= p.width || py >= p.height) continue;
      if (colorDistance(rgbAt(p, px, py), color) <= tolerance) on[y * w + x] = 1;
    }
  }
  return fillHoles({ w, h, on });
}

/* Everything not reachable from the edge without crossing the shape is part of it. */
export function fillHoles(mask: Mask): Mask {
  const { w, h, on } = mask;
  const outside = new Uint8Array(w * h);
  const queue: number[] = [];
  const seed = (i: number) => {
    if (!on[i] && !outside[i]) {
      outside[i] = 1;
      queue.push(i);
    }
  };
  for (let x = 0; x < w; x += 1) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y += 1) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (queue.length) {
    const i = queue.pop()!;
    const x = i % w, y = (i - x) / w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (y > 0) seed(i - w);
    if (y < h - 1) seed(i + w);
  }
  const filled = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) filled[i] = outside[i] ? 0 : 1;
  return { w, h, on: filled };
}

/* Keeps only the largest connected shape of the mask. */
export function largestShape(mask: Mask): Mask {
  const { w, h, on } = mask;
  const label = new Int32Array(w * h).fill(-1);
  let best = -1, bestSize = 0, id = 0;
  for (let s = 0; s < w * h; s += 1) {
    if (!on[s] || label[s] !== -1) continue;
    const queue = [s];
    label[s] = id;
    let size = 0;
    while (queue.length) {
      const i = queue.pop()!;
      size += 1;
      const x = i % w, y = (i - x) / w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && on[j] && label[j] === -1) {
          label[j] = id;
          queue.push(j);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = id;
    }
    id += 1;
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) out[i] = label[i] === best ? 1 : 0;
  return { w, h, on: out };
}

/*
  The outline of the shape (the largest one), as points around its edge:
  each row's left and right ends, down one side and up the other. Enough
  for the ribbons and badges the kit draws, which have no holes.
*/
export function outlinePoints(mask: Mask): [number, number][] {
  const { w, h, on } = mask;
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let y = 0; y < h; y += 1) {
    let a = -1, b = -1;
    for (let x = 0; x < w; x += 1) {
      if (on[y * w + x]) {
        if (a < 0) a = x;
        b = x;
      }
    }
    if (a >= 0) {
      left.push([a, y]);
      right.push([b + 1, y]);
    }
  }
  if (left.length === 0) return [];
  const first = left[0]!, last = left[left.length - 1]!;
  return [[first[0], first[1]], ...right.map(([x, y]) => [x, y] as [number, number]), [right[right.length - 1]![0], last[1] + 1], ...left.reverse().map(([x, y]) => [x, y + 1] as [number, number])];
}

/* Douglas-Peucker: drops points that lie within `tolerance` of the line through their neighbours. */
export function simplify(points: [number, number][], tolerance = 1.2): [number, number][] {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = points[a]!, [bx, by] = points[b]!;
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let far = -1, farDist = 0;
    for (let i = a + 1; i < b; i += 1) {
      const [px, py] = points[i]!;
      const d = Math.abs((by - ay) * px - (bx - ax) * py + bx * ay - by * ax) / len;
      if (d > farDist) {
        farDist = d;
        far = i;
      }
    }
    if (far > 0 && farDist > tolerance) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/* An SVG path for the points, closed. */
export function pathData(points: [number, number][]): string {
  if (points.length === 0) return "";
  return `M${points.map(([x, y]) => `${x} ${y}`).join("L")}Z`;
}

/* How ragged the shape's top and bottom edges are: 0 for a clean rectangle; a brush stroke is several pixels. */
export function edgeRoughness(mask: Mask): number {
  const { w, h, on } = mask;
  const tops: number[] = [];
  const bottoms: number[] = [];
  for (let x = Math.floor(w * 0.15); x < Math.ceil(w * 0.85); x += 1) {
    let t = -1, b = -1;
    for (let y = 0; y < h; y += 1) {
      if (on[y * w + x]) {
        if (t < 0) t = y;
        b = y;
      }
    }
    if (t >= 0) {
      tops.push(t);
      bottoms.push(b);
    }
  }
  const spread = (v: number[]) => {
    if (v.length < 3) return 0;
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    return Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  };
  return Math.max(spread(tops), spread(bottoms));
}

/* The rounding of a rectangle's corners, from how far in its top-left pixel row starts. */
export function cornerRadius(mask: Mask): number {
  const { w, h, on } = mask;
  for (let x = 0; x < Math.min(w, h); x += 1) {
    if (on[x * w + x]) return Math.round(x * 3.4);
  }
  return 0;
}

/*
  Smooth outlines of every shape in a field of 0..1 values (how much each
  pixel is ink), holes included, by marching squares with the edges placed
  between pixels where the value crosses `level`. Drawn with the even-odd
  rule, so the hole in an outlined heart stays open.
*/
export function traceField(field: Float32Array, w: number, h: number, level = 0.5): [number, number][][] {
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : field[y * w + x]!);
  const segments: [number, number, number, number][] = [];
  const lerp = (a: number, b: number) => (a === b ? 0.5 : (level - a) / (b - a));
  for (let y = -1; y < h; y += 1) {
    for (let x = -1; x < w; x += 1) {
      const tl = at(x, y), tr = at(x + 1, y), br = at(x + 1, y + 1), bl = at(x, y + 1);
      const code = (tl >= level ? 8 : 0) | (tr >= level ? 4 : 0) | (br >= level ? 2 : 0) | (bl >= level ? 1 : 0);
      if (code === 0 || code === 15) continue;
      // Points on each side of the square (pixel centres at +0.5).
      const top: [number, number] = [x + 0.5 + lerp(tl, tr), y + 0.5];
      const right: [number, number] = [x + 1.5, y + 0.5 + lerp(tr, br)];
      const bottom: [number, number] = [x + 0.5 + lerp(bl, br), y + 1.5];
      const left: [number, number] = [x + 0.5, y + 0.5 + lerp(tl, bl)];
      const add = (a: [number, number], b: [number, number]) => segments.push([a[0], a[1], b[0], b[1]]);
      switch (code) {
        case 1: case 14: add(left, bottom); break;
        case 2: case 13: add(bottom, right); break;
        case 3: case 12: add(left, right); break;
        case 4: case 11: add(top, right); break;
        case 5: add(left, top); add(bottom, right); break;
        case 6: case 9: add(top, bottom); break;
        case 7: case 8: add(left, top); break;
        case 10: add(top, right); add(left, bottom); break;
      }
    }
  }
  // Join the pieces end to end into closed loops.
  const key = (x: number, y: number) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
  const ends = new Map<string, number[]>();
  segments.forEach((s, i) => {
    for (const k of [key(s[0], s[1]), key(s[2], s[3])]) ends.set(k, [...(ends.get(k) ?? []), i]);
  });
  const used = new Uint8Array(segments.length);
  const loops: [number, number][][] = [];
  for (let i = 0; i < segments.length; i += 1) {
    if (used[i]) continue;
    used[i] = 1;
    const s = segments[i]!;
    const loop: [number, number][] = [[s[0], s[1]], [s[2], s[3]]];
    let tip = key(s[2], s[3]);
    for (;;) {
      const next = (ends.get(tip) ?? []).find((j) => !used[j]);
      if (next === undefined) break;
      used[next] = 1;
      const n = segments[next]!;
      const forward = key(n[0], n[1]) === tip;
      const p: [number, number] = forward ? [n[2], n[3]] : [n[0], n[1]];
      loop.push(p);
      tip = key(p[0], p[1]);
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

/* Loops as one SVG path, rounded to tenths, each simplified. */
export function loopsPath(loops: [number, number][][], tolerance = 0.35): string {
  return loops
    .map((l) => simplifyLoop(l, tolerance))
    .filter((l) => l.length >= 3)
    .map((l) => `M${l.map(([x, y]) => `${Math.round(x * 10) / 10} ${Math.round(y * 10) / 10}`).join("L")}Z`)
    .join("");
}

/* Simplifies a closed loop: split at the point farthest from its start, each half simplified. */
export function simplifyLoop(loop: [number, number][], tolerance: number): [number, number][] {
  if (loop.length < 4) return loop;
  const [sx, sy] = loop[0]!;
  let far = 1, farDist = -1;
  loop.forEach(([x, y], i) => {
    const d = Math.hypot(x - sx, y - sy);
    if (d > farDist) {
      farDist = d;
      far = i;
    }
  });
  const first = simplify(loop.slice(0, far + 1), tolerance);
  const second = simplify([...loop.slice(far), loop[0]!], tolerance);
  return [...first, ...second.slice(1, -1)];
}
