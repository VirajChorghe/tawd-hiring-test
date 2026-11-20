import fs from "node:fs";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bandWordsNotes, bandsShowWords, type BandWords } from "../../../worker/src/band-words";

/*
  E0(b), audit batch E: every band of a page built from a design shows its
  words, read in a real browser. Each case below is one way a band can look
  blank to a visitor while its words are in the markup.
*/

const require = createRequire(import.meta.url);
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const hasChrome = fs.existsSync(CHROME);
// The web app doesn't depend on playwright-core, so its type comes from the worker's copy (as the other Chrome tests do).
type Browser = import("../../../worker/node_modules/playwright-core").Browser;
let browser: Browser;

beforeAll(async () => {
  if (!hasChrome) return;
  const { chromium } = require("../../../worker/node_modules/playwright-core");
  browser = await chromium.launch({ executablePath: CHROME });
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

async function bands(body: string, css = ""): Promise<BandWords[]> {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await page.setContent(`<!doctype html><html><head><style>body{margin:0;font:16px/1.4 sans-serif}section{padding:40px;min-height:300px}${css}</style></head><body>${body}</body></html>`);
    return await bandsShowWords(page);
  } finally {
    await page.close();
  }
}
const byName = (list: BandWords[], name: string) => list.find((b) => b.name === name);

describe.skipIf(!hasChrome)("CodeRabbit's review of #83", () => {
  it("fails faint text: a nearly transparent colour, or a fading ancestor, judged as painted", async () => {
    for (const style of ["color:rgba(0,0,0,0.1)", "opacity:0.12"]) {
      const list = await bands(`<main><section><h2>Fine</h2></section><section style="${style}"><h2>Faint heading</h2><p>Words barely there.</p></section></main>`);
      expect(byName(list, "Faint heading")?.ok, style).toBe(false);
    }
  });

  it("fails words under a picture laid on top with pointer-events: none", async () => {
    const pixel = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'><rect width='10' height='10' fill='%23c00'/></svg>";
    const list = await bands(
      `<main><section style="position:relative"><h2>No water? Call us</h2><p>Day or night.</p><img src="${pixel}" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none"></section></main>`,
    );
    expect(list[0]!.ok, JSON.stringify(list)).toBe(false);
  });

  // CodeRabbit's second review: a layer that paints nothing never covers the words.
  it("passes words under a layer that paints nothing: a transparent overlay, or a link stretched over a card", async () => {
    for (const layer of [
      `<div style="position:absolute;inset:0;opacity:0;pointer-events:none;background:#c00"></div>`,
      `<a href="/services/" style="position:absolute;inset:0" aria-label="Water well drilling"></a>`,
    ]) {
      const list = await bands(`<main><section style="position:relative"><h2>Water Well Drilling</h2><p>New wells for homes and farms.</p>${layer}</section></main>`);
      expect(list[0]!.ok, layer).toBe(true);
    }
  });

  // CodeRabbit's third review: a solid inset shadow paints like a background; a thin highlight doesn't cover the middle.
  it("fails words under a layer painted solid by an inset shadow, but not under a thin inset highlight", async () => {
    const covered = await bands(
      `<main><section style="position:relative"><h2>No water? Call us</h2><p>Day or night.</p><div style="position:absolute;inset:0;z-index:10;box-shadow:inset 0 0 0 100vmax white"></div></section></main>`,
    );
    expect(covered[0]!.ok, JSON.stringify(covered)).toBe(false);
    const thin = await bands(
      `<main><section style="position:relative"><h2>No water? Call us</h2><p>Day or night.</p><a href="/" style="position:absolute;inset:0;box-shadow:inset 0 1px 0 rgba(255,255,255,0.8)"></a></section></main>`,
    );
    expect(thin[0]!.ok, JSON.stringify(thin)).toBe(true);
    // CodeRabbit's fourth review: a 20px spread paints only a 20px band inside the edges; words in the clear middle are seen.
    const framed = await bands(
      `<main><section style="position:relative;padding:80px"><h2>No water? Call us</h2><p>Day or night.</p><div style="position:absolute;inset:0;z-index:10;box-shadow:inset 0 0 0 20px white"></div></section></main>`,
    );
    expect(framed[0]!.ok, JSON.stringify(framed)).toBe(true);
  });

  it("gives up with an error when the pictures never finish loading, instead of waiting for ever", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<!doctype html><html><body><main><section><img alt="x" src="data:image/png;base64,iVBORw0KGgo="><h2>Hi</h2></section></main></body></html>`);
      await page.evaluate(() => {
        Object.defineProperty(HTMLImageElement.prototype, "complete", { get: () => false });
        HTMLImageElement.prototype.decode = () => new Promise<void>(() => undefined);
      });
      const started = Date.now();
      await expect(bandsShowWords(page, { prepareMs: 300 })).rejects.toThrow(/didn't load within/);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await page.close();
    }
  });
});

describe.skipIf(!hasChrome)("every band shows its words (E0(b))", () => {
  it("passes an ordinary page: header, bands and footer all readable", async () => {
    const list = await bands(
      `<header><a href="/">Pat Rivera</a><nav><a href="/">Home</a></nav></header><main><section><h2>Serving Northern Nevada</h2><p>Established in 1981.</p></section><section style="background:#0b2545;color:#fff"><h2>Five Reasons</h2><p>Same-day service.</p></section></main><footer><p>Reno, Bishop, Winnemucca</p></footer>`,
    );
    expect(list.length).toBe(4);
    expect(list.every((b) => b.ok), JSON.stringify(list)).toBe(true);
  });

  it("fails a band whose words are the same colour as its background", async () => {
    const list = await bands(`<main><section><h2>Fine</h2></section><section style="background:#0b2545;color:#0b2545"><h2>The Systems</h2><p>Installation and repair.</p></section></main>`);
    expect(byName(list, "Fine")!.ok).toBe(true);
    expect(byName(list, "The Systems")!.ok).toBe(false);
  });

  it("fails a band whose words are hidden (opacity, visibility, display)", async () => {
    for (const style of ["opacity:0", "visibility:hidden", "display:none"]) {
      const list = await bands(`<main><section><h2>Fine</h2></section><section><div style="${style}"><h2>Reviews</h2><p>Dan Wheeler, two years ago.</p></div></section></main>`);
      const hidden = list.find((b) => b.name !== "Fine");
      expect(hidden?.ok, style).toBe(false);
    }
  });

  it("fails a band whose words sit under a picture laid on top of them", async () => {
    const pixel = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'><rect width='10' height='10' fill='%23c00'/></svg>";
    const list = await bands(`<main><section style="position:relative"><h2>No water? Call us</h2><p>Day or night.</p><img src="${pixel}" style="position:absolute;inset:0;width:100%;height:100%"></section></main>`);
    expect(list[0]!.ok, JSON.stringify(list)).toBe(false);
  });

  it("passes bands the speed pass draws only when scrolled near (content-visibility), far below the first screen", async () => {
    const list = await bands(
      `<main><section style="height:3000px"><h2>Top</h2></section><section data-tawd-cv style="--tawd-h:300px"><h2>Testimonial</h2><p>They're there to fix the problem.</p></section></main>`,
      "[data-tawd-cv]{content-visibility:auto;contain-intrinsic-size:auto var(--tawd-h,800px)}",
    );
    expect(byName(list, "Testimonial")!.ok, JSON.stringify(list)).toBe(true);
  });

  it("counts words over a photo or gradient as shown (their colour can't be judged against a picture)", async () => {
    const list = await bands(`<main><section style="background:linear-gradient(#123,#456);color:#123"><h2>Pump and well service</h2></section></main>`);
    expect(list[0]!.ok).toBe(true);
  });

  // Found on the paid run's real pages: words not meant to be seen at this width are not counted against the band.
  it("leaves out a phone menu's hidden copy, an off-page skip link, a hidden form trap, and a <style> inside <main>", async () => {
    const list = await bands(
      `<header><a href="#main" style="position:absolute;left:-9999px">Skip to content</a><nav><a href="/">Home</a></nav><nav style="display:none"><a href="/">Home</a><a href="/">Reno (775) 346-6321</a></nav></header><main id="main"><style>.x{color:red}</style><section><h2>Request a quote</h2><form><p hidden><label>Leave this empty: <input name="bot-field"></label></p><label>Name <input></label></form></section></main>`,
    );
    expect(list.map((b) => b.name)).not.toContain("style");
    expect(list.every((b) => b.ok), JSON.stringify(list)).toBe(true);
    expect(list.find((b) => b.name.startsWith("header"))!.total).toBe("Home".length);
  });

  it("fails a band that takes up room while none of its words are laid out", async () => {
    const list = await bands(`<main><section><h2>Fine</h2></section><section style="min-height:400px"><div style="display:none"><h2>Reviews</h2><p>Dan Wheeler</p></div></section></main>`);
    const blank = list.find((b) => b.name !== "Fine");
    expect(blank?.ok, JSON.stringify(list)).toBe(false);
    expect(blank?.hidden).toEqual(["its words aren't laid out at this width"]);
  });

  it("names the failing band and some of its unseen words in the note", () => {
    const notes = bandWordsNotes([
      { name: "Fine", total: 10, shown: 10, hidden: [], ok: true },
      { name: "Reviews", total: 40, shown: 0, hidden: ["Dan Wheeler", "Barb B"], ok: false },
    ]);
    expect(notes).toEqual([`The band "Reviews" shows 0% of its words (not shown: "Dan Wheeler", "Barb B").`]);
  });
});
