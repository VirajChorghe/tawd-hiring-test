import type { Browser } from "playwright-core";
import { ownPageContext } from "./locked-context";
import { loadHtml } from "./page-load";

/*
  The fidelity check: how closely the faithful copy matches the designer's
  Figma frame. Free, no AI: both pictures are drawn at the same width in
  the browser and compared in small blocks of colour, section by section
  (each Figma section against the page section built for it), so one
  section coming out taller does not throw off every section below it.

  It measures whether the colours and the layout line up, not whether the
  text is pixel-identical; the score is a guide for the team, with the two
  pictures side by side to judge by eye.
*/

export interface FidelityResult {
  /** 0-100, weighted by each section's height. */
  overall: number;
  sections: { name: string; score: number }[];
  /** "sections" when each section was compared with its own, "page" when the page was compared whole. */
  method: "sections" | "page";
  designHeight: number;
  copyHeight: number;
}

const WIDTH = 360;
const BLOCK = 8;

export async function compareWithDesign(
  browser: Browser,
  input: {
    design: Buffer;
    copy: Buffer;
    /** The Figma frame's width, and its sections in frame pixels. */
    frameWidth: number;
    sections: { name: string; top: number; height: number }[];
    /** Where the copy's sections are, in percent of its full height (measureBands). */
    copyBands: { top: number; bottom: number }[];
  },
): Promise<FidelityResult> {
  const context = await ownPageContext(browser);
  try {
    const page = await context.newPage();
    await loadHtml(page, "<html><body></body></html>");
    return await page.evaluate(
      async ({ design, copy, frameWidth, sections, copyBands, width, block }) => {
        const load = async (src: string) => {
          const image = new Image();
          image.src = src;
          await image.decode();
          return image;
        };
        const [a, b] = await Promise.all([load(design), load(copy)]);
        const heightA = Math.round((a.naturalHeight * width) / a.naturalWidth);
        const heightB = Math.round((b.naturalHeight * width) / b.naturalWidth);

        /* The average colour of each block of a strip of the picture, drawn width x height. */
        const blocks = (image: HTMLImageElement, sy: number, sh: number, height: number) => {
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = Math.max(block, height);
          const ctx = canvas.getContext("2d")!;
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(image, 0, sy, image.naturalWidth, Math.max(1, sh), 0, 0, canvas.width, canvas.height);
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          const out: number[][] = [];
          for (let by = 0; by + block <= canvas.height; by += block) {
            for (let bx = 0; bx + block <= canvas.width; bx += block) {
              let r = 0, g = 0, bl = 0;
              for (let y = by; y < by + block; y += 1) {
                for (let x = bx; x < bx + block; x += 1) {
                  const i = (y * canvas.width + x) * 4;
                  r += data[i]!;
                  g += data[i + 1]!;
                  bl += data[i + 2]!;
                }
              }
              const n = block * block;
              out.push([r / n, g / n, bl / n]);
            }
          }
          return out;
        };
        /* The share of blocks whose colours are close, 0-100. */
        const score = (x: number[][], y: number[][]) => {
          const n = Math.min(x.length, y.length);
          if (n === 0) return 0;
          let close = 0;
          for (let i = 0; i < n; i += 1) {
            const d = Math.hypot(x[i]![0]! - y[i]![0]!, x[i]![1]! - y[i]![1]!, x[i]![2]! - y[i]![2]!) / (255 * Math.sqrt(3));
            if (d < 0.1) close += 1;
          }
          return Math.round((close / n) * 100);
        };

        const toA = a.naturalWidth / frameWidth;
        if (sections.length > 0 && sections.length === copyBands.length) {
          let total = 0;
          let weight = 0;
          const out = sections.map((section, i) => {
            const band = copyBands[i]!;
            const h = Math.max(block, Math.round((section.height * width) / frameWidth));
            const sa = blocks(a, section.top * toA, section.height * toA, h);
            const top = (band.top / 100) * b.naturalHeight;
            const bottom = (band.bottom / 100) * b.naturalHeight;
            const sb = blocks(b, top, bottom - top, h);
            const s = score(sa, sb);
            total += s * section.height;
            weight += section.height;
            return { name: section.name, score: s };
          });
          return { overall: Math.round(total / Math.max(1, weight)), sections: out, method: "sections" as const, designHeight: heightA, copyHeight: heightB };
        }

        // The sections could not be paired: the whole page, the copy drawn to the design's length.
        const whole = score(blocks(a, 0, a.naturalHeight, heightA), blocks(b, 0, b.naturalHeight, heightA));
        return { overall: whole, sections: [], method: "page" as const, designHeight: heightA, copyHeight: heightB };
      },
      {
        design: `data:image/png;base64,${input.design.toString("base64")}`,
        copy: `data:image/png;base64,${input.copy.toString("base64")}`,
        frameWidth: input.frameWidth,
        sections: input.sections,
        copyBands: input.copyBands,
        width: WIDTH,
        block: BLOCK,
      },
    );
  } finally {
    await context.close();
  }
}
