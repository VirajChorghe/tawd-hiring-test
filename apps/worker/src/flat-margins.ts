/*
  Flat-colour margins around an uploaded design picture (E1, 13 November 2026).

  A client's design is often a picture placed in the middle of a taller or
  wider canvas, with flat black (or white) either side. Everything after
  the read measures the picture, so the margin is cut off first.

  Rules, so it never cuts into the design:
  - Walking in from an edge, the margin is a run of clean lines: at most
    max(2, 0.2% of the line) of the pixels further than 24 (per colour
    channel) from the margin colour. A thin feature (a 20px logo, a 40px
    nav bar) makes a line unclean and stops the run; unclean lines after
    the run are never cut.
  - The run may sit behind a short band of stray lines (more than that but
    at most 2% off, no more than 5% of the lines, and the run behind it at
    least three times as long): a mark inside the margin. The Pat Rivera
    picture has one, 50 columns wide, in its right margin.
  - A margin of 3 lines or fewer is left alone.
  - Both sides must be margin, in the same colour, and within max(8px, 2%
    of the width) of each other in size, or neither is trimmed. One flat
    edge on its own is the design's own breathing room, and a different
    amount each side is a mark or a widget, not a centred canvas.
  - Known limit: a design whose own side gutters are nearly the margin
    colour (within 24 per channel, and with nothing in them) can lose them.
    The read's note says how much was trimmed.
  - Colour noise up to 24 per channel is allowed. Heavier noise (a JPEG with
    strong artefacts) leaves a line unclean: nothing is trimmed and the page
    is drawn the usual way, 1440 wide.
  - Rows (top and bottom) are never trimmed. A frame's colour can't be told
    from a design's own band of that colour above or below it (a black
    header's padding above its logo): trimming rows would cut the design,
    and a frame left on top or bottom costs only blank space (review of
    E1, 13 November 2026). Side margins are the case that matters: a design
    centred on a wider canvas, like the Pat Rivera picture.

  This function is self-contained on purpose: the worker also hands its
  source to the browser page that reads the PDF, so it must not use
  anything defined outside it.
*/
export interface FlatMargins {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** The margin colour per axis, when that axis was trimmed. */
  colourX: string | null;
  colourY: string | null;
}

export function findFlatMargins(pixels: Uint8ClampedArray | Uint8Array, width: number, height: number): FlatMargins {
  const TOLERANCE = 24;
  // Off-colour pixels allowed in a clean line, and in a stray one.
  const STRICT = 0.002;
  const LENIENT = 0.02;
  // The most common colour of one line (quantised to 8 so noise does not split it), as three numbers.
  const dominant = (start: number, step: number, count: number): number[] => {
    const counts: Record<string, number> = {};
    let best = "";
    let bestCount = 0;
    for (let k = 0; k < count; k += 1) {
      const i = (start + k * step) * 4;
      const key = `${pixels[i]! >> 3},${pixels[i + 1]! >> 3},${pixels[i + 2]! >> 3}`;
      counts[key] = (counts[key] ?? 0) + 1;
      if (counts[key]! > bestCount) {
        bestCount = counts[key]!;
        best = key;
      }
    }
    // Back from the bucket to a real pixel of that colour: the first one in the line that falls in it.
    for (let k = 0; k < count; k += 1) {
      const i = (start + k * step) * 4;
      if (`${pixels[i]! >> 3},${pixels[i + 1]! >> 3},${pixels[i + 2]! >> 3}` === best) return [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!];
    }
    return [0, 0, 0];
  };
  // How many pixels of a line are off the reference colour.
  const off = (start: number, step: number, count: number, reference: number[]): number => {
    let n = 0;
    for (let k = 0; k < count; k += 1) {
      const i = (start + k * step) * 4;
      if (Math.abs(pixels[i]! - reference[0]!) > TOLERANCE || Math.abs(pixels[i + 1]! - reference[1]!) > TOLERANCE || Math.abs(pixels[i + 2]! - reference[2]!) > TOLERANCE) n += 1;
    }
    return n;
  };
  /*
    Walking in from an edge: how many lines are margin. A line is clean when
    at most max(2, 0.2%) of it is off the margin colour, stray when it has
    more than that but at most 2%, and anything else is design. The margin
    is a clean run from the edge, optionally behind a short stray band (a
    mark that sits in the margin, like the one in Pat Rivera's picture
    that is 50 columns wide and 44 rows tall). Stray lines after the clean
    run are the design's and are never cut. The stray band counts only if
    it is no more than 5% of the lines and the clean run behind it is at
    least three times as long. A margin of 3 lines or fewer is left alone.
  */
  const walk = (lineStart: (k: number) => number, step: number, count: number, lines: number, reference: number[]): number => {
    const strict = Math.max(2, Math.floor(count * STRICT));
    const lenient = Math.floor(count * LENIENT);
    const offAt = (k: number) => off(lineStart(k), step, count, reference);
    let n = 0;
    while (n < lines - 1 && offAt(n) > strict && offAt(n) <= lenient) n += 1;
    const stray = n;
    while (n < lines - 1 && offAt(n) <= strict) n += 1;
    const clean = n - stray;
    if (clean === 0) return 0;
    if (stray > 0 && (stray > Math.max(3, Math.floor(lines * 0.05)) || clean < Math.max(16, 3 * stray))) return 0;
    return n > 3 ? n : 0;
  };
  const same = (a: number[], b: number[]) => Math.abs(a[0]! - b[0]!) <= TOLERANCE && Math.abs(a[1]! - b[1]!) <= TOLERANCE && Math.abs(a[2]! - b[2]!) <= TOLERANCE;
  const hex = (c: number[]) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  const none: FlatMargins = { left: 0, right: 0, top: 0, bottom: 0, colourX: null, colourY: null };
  if (width < 3 || height < 3) return none;

  // Columns first, over the full height.
  let left = 0;
  let right = 0;
  let colourX: string | null = null;
  const leftColour = dominant(0, width, height);
  const rightColour = dominant(width - 1, width, height);
  if (same(leftColour, rightColour)) {
    left = walk((k) => k, width, height, width, leftColour);
    right = walk((k) => width - 1 - k, width, height, width, rightColour);
    // Both sides or neither: one flat edge on its own is the design's own.
    // Sides that differ by more than a few pixels are not a centred canvas: a mark or widget in one margin, or a design that is not centred. Nothing is trimmed.
    if (left === 0 || right === 0 || Math.abs(left - right) > Math.max(8, Math.floor(width * 0.02)) || width - left - right < 16) {
      left = 0;
      right = 0;
    } else colourX = hex(leftColour);
  }

  // Rows are never trimmed (see above): the design's own top and bottom are kept whole.
  return { left, right, top: 0, bottom: 0, colourX, colourY: null };
}
