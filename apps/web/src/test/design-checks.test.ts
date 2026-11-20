import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkAgainstDesign, compareSpecWords, compareWords, pairBands, wordsOf, type DesignSpec } from "../../../worker/src/design-checks";

/*
  E2, audit batch E: the six checks of spec 15 section 5. A small design is
  drawn in real Chrome and photographed (the "design picture"); its bands,
  words and pictures are taken from its own markup. An exact copy must pass
  every check, and each broken copy must fail exactly the check it breaks:
  a band shifted, a word removed, a picture missing, the content hidden, a
  page that scrolls sideways on a phone. The fix round (reviewer, 13 November)
  adds the copies that must NOT fail: TAWD's own skip link, a divider, a
  wrapper div, a page that hides its sideways overflow, one band a little
  taller than the design's.
*/

const require = createRequire(import.meta.url);
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const hasChrome = fs.existsSync(CHROME);
type Browser = import("../../../worker/node_modules/playwright-core").Browser;
let browser: Browser;
let server: http.Server;
let origin = "";
const pages = new Map<string, string>();
const redirects = new Map<string, string>();
const statuses = new Map<string, number>();
let pathCount = 0;

beforeAll(async () => {
  if (!hasChrome) return;
  const { chromium } = require("../../../worker/node_modules/playwright-core");
  browser = await chromium.launch({ executablePath: CHROME });
  server = http.createServer((req, res) => {
    const to = redirects.get(req.url ?? "/");
    if (to) {
      res.statusCode = 301;
      res.setHeader("location", to);
      res.end();
      return;
    }
    const body = pages.get(req.url ?? "/");
    res.statusCode = statuses.get(req.url ?? "/") ?? (body ? 200 : 404);
    res.setHeader("content-type", "text/html");
    res.end(body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 60_000);
afterAll(async () => {
  await browser?.close();
  server?.close();
});

const svg = (fill: string) => `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'><rect width='10' height='10' fill='%23${fill}'/></svg>`;
const CSS = `*{margin:0;box-sizing:border-box}body{font:20px/1.4 sans-serif;max-width:1000px}img{max-width:30%}header{height:80px;background:#0b2545;color:#fff;padding:20px}
section{height:320px;padding:40px;position:relative}h2{font-size:56px;line-height:1.1}p{font-size:28px}img{position:absolute;right:40px;top:40px;width:240px;height:240px}
footer{height:120px;background:#13315c;color:#fff;padding:30px}.a{background:#eef4ed;color:#0b2545}.b{background:#8da9c4;color:#0b2545}.c{background:#134074;color:#fff}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}.skip{position:absolute;left:-9999px;top:0}
.ph{position:absolute;left:40px;bottom:20px;width:200px;height:30px;font:20px sans-serif;border:0;padding:0;background:transparent;color:#0b2545}
.bgp{position:absolute;right:40px;top:40px;width:240px;height:240px;background:url("${svg("c81d25")}") no-repeat 0 0/100% 100%}`;

interface Options {
  shift?: boolean;
  dropWord?: boolean;
  dropPicture?: boolean;
  hide?: boolean;
  wide?: boolean;
  /** TAWD's own off-screen skip link, a screen-reader-only span and an invisible span. */
  skip?: boolean;
  /** A form placeholder on the page; `designForm` is the same words drawn as text (the design). */
  form?: boolean;
  designForm?: boolean;
  /** Header and footer inside one <div id="app">. */
  app?: boolean;
  /** One wrapper div around main's sections, and an absolutely placed child of main. */
  wrap?: boolean;
  /** A 4 px divider as main's first child. */
  divider?: boolean;
  /** The first section 14 px taller. */
  tall?: boolean;
  /** A 2400 px wide strip in the footer, the colour of the footer. */
  strip?: boolean;
  /** Overflow hidden sideways, with a decoration placed past the right edge. */
  clipX?: boolean;
  /** "the" twice in the third section. */
  the?: boolean;
  /** The first picture as a CSS background. */
  bgPic?: boolean;
  /** The second section's words drawn with -webkit-text-fill-color. */
  fillText?: boolean;
  /** Every band a different height and colour. */
  scramble?: boolean;
  overlap?: boolean;
  swapWords?: boolean;
  /** A small drawing in the footer that isn't in the design. */
  extraPicture?: boolean;
  /** A 1 px block picture at the end of the body. */
  tracker?: boolean;
  /** Sections no wider than 800 px, centred. */
  boxed?: boolean;
  /** A heading with a wrapped inline span, and a row of three cards, in the third section. */
  order?: boolean;
  /** A three-slide carousel (one slide in view) in the third section. */
  carousel?: boolean;
  /** The header fixed to the top of the page. */
  fixedHeader?: boolean;
  /** The second section pushed down by this many px. */
  shiftBy?: number;
  /** The footer this many px shorter. */
  footerCut?: number;
}

function page(o: Options = {}) {
  const hidden = o.hide ? ` style="color:#8da9c4"` : "";
  const extraCss =
    (o.shift ? ".b{margin-top:60px}" : "") +
    (o.shiftBy ? `.b{margin-top:${o.shiftBy}px}` : "") +
    (o.footerCut ? `footer{height:${120 - o.footerCut}px}` : "") +
    (o.boxed ?"main>section{max-width:800px;margin:0 auto}" : "") +
    (o.order ? ".c{height:520px}.cards{display:flex}.cards>div{width:300px}" : "") +
    (o.fixedHeader ? "header{position:fixed;top:0;left:0;right:0}main{padding-top:80px}" : "") +
    (o.tall ? ".a{height:334px}" : "") +
    (o.clipX ? "body{overflow-x:hidden}" : "") +
    (o.fillText ? ".b{-webkit-text-fill-color:#0b2545}" : "") +
    (o.overlap ? ".b{margin-top:-40px;position:relative;z-index:1}" : "") +
    (o.scramble ? "header{height:200px !important;background:#d00 !important}.a,.b,.c{height:500px;background:#222 !important;color:#eee !important}footer{height:300px;background:#d00 !important}" : "");
  const header = `<header><strong>Pat Rivera Pump and Well</strong>${o.skip ? `<span class="sr">Opens in a new tab</span><span style="opacity:0">Invisible words</span>` : ""}</header>`;
  const formBit = o.form ? `<input class="ph" placeholder="Your name">` : o.designForm ? `<p class="ph">Your name</p>` : "";
  const sections = `${o.divider ? `<div style="height:4px;background:#8da9c4"></div>` : ""}
<section class="a"><h2>Serving Northern Nevada</h2><p>Family owned since 1981.</p>${formBit}${o.bgPic ? `<div class="bgp"></div>` : `<img alt="" src="${svg("c81d25")}">`}${o.clipX ? `<div style="position:absolute;right:-300px;top:0;width:200px;height:20px;background:#eef4ed"></div>` : ""}</section>
<section class="b"${hidden}><h2>Water Well Drilling</h2><p>New ${o.dropWord ? "" : "residential "}wells and repairs.</p>${o.dropPicture ? "" : `<img alt="" src="${svg("2a9d8f")}">`}</section>
<section class="c"><h2>Five Reasons</h2><p>${o.the ? "Same day service for the whole of the valley." : "Same day service."}</p>${o.order ? `<h3 style="width:260px;text-indent:80px">Fast <span>plumbing and heating repair</span> today</h3><div class="cards"><div><h3>Card one</h3><p>Alpha text here.</p></div><div><h3>Card two</h3><p>Beta text here.</p></div><div><h3>Card three</h3><p>Gamma text here.</p></div></div>` : ""}${o.carousel ? `<div style="overflow:hidden;width:300px;height:40px"><div style="display:flex;width:900px"><div style="width:300px">Slide one</div><div style="width:300px">Slide two</div><div style="width:300px">Slide three</div></div></div>` : ""}${o.wide ? `<div style="width:2400px;height:10px"></div>` : ""}</section>`;
  const main = `<main>${o.wrap ? `<div class="wrap">${sections}</div><div style="position:absolute;top:500px;left:0;width:100px;height:20px;background:#eef4ed"></div>` : sections}</main>`;
  const footer = `<footer>${o.extraPicture ? `<svg width="30" height="30" style="float:right"><rect width="30" height="30" fill="#13315c"/></svg>` : ""}<p>Reno, Bishop, Winnemucca</p>${o.strip ? `<div style="width:2400px;height:2px;background:#13315c"></div>` : ""}</footer>`;
  const swapped = (html: string) =>
    o.swapWords
      ? html
          .replace("Pat Rivera Pump and Well", "Acme Pipe and Drain Works")
          .replace("Serving Northern Nevada", "Helping Southern Oregon")
          .replace("Family owned since 1981.", "Locally run since 1990.")
          .replace("Water Well Drilling", "Sewer Line Clearing")
          .replace("wells and repairs.", "lines and fixing.")
          .replace("Five Reasons", "Nine Answers")
          .replace("Same day service.", "Next week visits.")
          .replace("Reno, Bishop, Winnemucca", "Bend, Salem, Medford")
      : html;
  return swapped(`<!doctype html><html><head><style>${CSS}${extraCss}</style></head><body>
${o.skip ? `<a class="skip" href="#main">Skip to content</a>` : ""}${o.app ? `<div id="app">${header}${main}${footer}</div>` : `${header}${main}${footer}`}${o.tracker ? `<img alt="" width="1" height="1" style="display:block;position:static;width:1px;height:1px;max-width:none" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">` : ""}</body></html>`);
}

/* The design, as the read would describe it: taken from the exact page's own markup and a photograph of it. */
async function designOf(html: string): Promise<DesignSpec> {
  pages.set("/design", html);
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 1 });
  const tab = await context.newPage();
  await tab.goto(`${origin}/design`);
  const shape = await tab.evaluate(() => {
    const bands = Array.from(document.querySelectorAll("body > header, main > section, body > footer")).map((el, i) => {
      const r = el.getBoundingClientRect();
      return { name: `band ${i + 1}`, top: Math.round(r.top + scrollY), height: Math.round(r.height) };
    });
    const pictures = Array.from(document.images).map((img, i) => {
      const r = img.getBoundingClientRect();
      return { name: `picture ${i + 1}`, x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
    });
    return { bands, pictures, words: document.body.innerText, height: document.documentElement.scrollHeight };
  });
  const picture = await tab.screenshot({ type: "png", fullPage: true });
  await context.close();
  return { width: 1000, height: shape.height, bands: shape.bands, pictures: shape.pictures, words: [{ text: shape.words }], picture };
}

async function check(html: string, spec: DesignSpec) {
  pathCount += 1;
  const path = `/built-${pathCount}`;
  pages.set(path, html);
  return checkAgainstDesign(browser, `${origin}${path}`, spec);
}

describe("comparing the words", () => {
  it("finds a missing word and an added one, and a moved word counts as both", () => {
    expect(compareWords(wordsOf("new residential wells"), wordsOf("New wells!"))).toEqual({ missing: ["residential"], added: [] });
    expect(compareWords(wordsOf("call us today"), wordsOf("call us now today"))).toEqual({ missing: [], added: ["now"] });
    const moved = compareWords(wordsOf("a b c d"), wordsOf("a c d b"));
    expect(moved.missing).toEqual(["b"]);
    expect(moved.added).toEqual(["b"]);
  });

  it("reads & as and", () => {
    expect(wordsOf("Pump & Well")).toEqual(["pump", "and", "well"]);
    expect(compareWords(wordsOf("Pump and Well"), wordsOf("Pump & Well"))).toEqual({ missing: [], added: [] });
  });

  it("an uncertain word forgives one added word of its spelling, and the certain words still line up", () => {
    const design = [{ text: "the cat" }, { text: "the", uncertain: true }, { text: "dog" }];
    const same = compareSpecWords(design, wordsOf("the cat the dog"));
    expect([same.missing, same.added]).toEqual([[], []]);
    // One uncertain "the" doesn't forgive two.
    expect(compareSpecWords(design, wordsOf("the cat the the dog")).added).toEqual(["the"]);
    expect(compareSpecWords(design, wordsOf("the cat dog")).missing).toEqual([]);
  });
});

describe("pairing the bands", () => {
  it("pairs by alignment: an extra built band or a missing one doesn't shift the rest", () => {
    const design = [
      { top: 0, height: 80 },
      { top: 80, height: 320 },
      { top: 400, height: 320 },
    ];
    expect(pairBands(design, [{ top: 0, height: 80 }, { top: 80, height: 4 }, { top: 84, height: 320 }, { top: 404, height: 320 }])).toEqual([0, 2, 3]);
    expect(pairBands(design, [{ top: 0, height: 80 }, { top: 400, height: 320 }])).toEqual([0, null, 1]);
  });

  // A page that has drifted: one band 800 px taller pushes everything below it down; each band still pairs with its own.
  it("pairs band for band on a page that has drifted far down, rather than calling the bands below missing", () => {
    const design = [
      { top: 0, height: 100 },
      { top: 100, height: 400 },
      { top: 500, height: 300 },
      { top: 800, height: 200 },
    ];
    const built = [
      { top: 0, height: 100 },
      { top: 100, height: 1200 },
      { top: 1300, height: 300 },
      { top: 1600, height: 200 },
    ];
    expect(pairBands(design, built)).toEqual([0, 1, 2, 3]);
  });
});

describe.skipIf(!hasChrome)("the six checks against a design (E2)", () => {
  it("an exact copy passes every check", async () => {
    const spec = await designOf(page());
    const report = await check(page(), spec);
    expect(report.failures, report.failures.join("\n")).toEqual([]);
    expect(report.score).toBe(100);
    expect(report.extraBands).toEqual([]);
    expect(report.extraPictures).toEqual([]);
    for (const band of report.bands) expect(band.content, band.name).toBeGreaterThanOrEqual(95);
  }, 60_000);

  it("a band moved down fails its own position (and the page height), but not the bands after it", async () => {
    const spec = await designOf(page());
    const report = await check(page({ shift: true }), spec);
    expect(report.bands[2]!.position).toBe(false);
    // Changed in the fix round: this asserted false for the band after the moved one (every band was measured from the top of the page); now it is measured from the band before it, so only the moved band fails.
    expect(report.bands[3]!.position).toBe(true);
    expect(report.bands[1]!.position).toBe(true);
    expect(report.height.ok).toBe(false);
    expect(report.score).toBeLessThan(100);
  }, 60_000);

  it("a word removed fails the word check, naming it", async () => {
    const spec = await designOf(page());
    const report = await check(page({ dropWord: true }), spec);
    expect(report.words.missing).toEqual(["residential"]);
    expect(report.words.ok).toBe(false);
  }, 60_000);

  it("a picture missing fails the picture check in its band: 'not on the page', not matched to another band's picture", async () => {
    const spec = await designOf(page());
    const report = await check(page({ dropPicture: true }), spec);
    const band = report.bands[2]!;
    expect(band.pictures.map((p) => p.note)).toEqual(["not on the page"]);
    expect(report.bands[1]!.pictures.every((p) => p.ok)).toBe(true);
  }, 60_000);

  it("a picture drawn as a CSS background instead of an <img> still counts", async () => {
    const spec = await designOf(page());
    const report = await check(page({ bgPic: true }), spec);
    expect(report.bands[1]!.pictures.map((p) => p.ok)).toEqual([true]);
    expect(report.extraPictures).toEqual([]);
  }, 60_000);

  it("a drawing on the page that isn't in the design is listed, not failed", async () => {
    const spec = await designOf(page());
    const report = await check(page({ extraPicture: true }), spec);
    expect(report.extraPictures).toHaveLength(1);
    expect(report.failures.join("\n")).not.toMatch(/picture/);
  }, 60_000);

  it("a design picture that sits in no band is still checked against the page", async () => {
    const spec = await designOf(page());
    const loose = { ...spec, bands: spec.bands.filter((_, i) => i !== 2) };
    const report = await check(page(), loose);
    expect(report.loosePictures.map((p) => p.ok)).toEqual([true]);
    const gone = await check(page({ dropPicture: true }), loose);
    expect(gone.loosePictures.map((p) => p.note)).toEqual(["not on the page"]);
  }, 60_000);

  it("content hidden (words the colour of their band) fails the colour check: the places where the design has words don't match", async () => {
    const spec = await designOf(page());
    const report = await check(page({ hide: true }), spec);
    const band = report.bands[2]!;
    expect(band.colourOk, JSON.stringify(band)).toBe(false);
  }, 60_000);

  it("words drawn with -webkit-text-fill-color are hidden in the bare render too, so they count as content", async () => {
    const spec = await designOf(page());
    const report = await check(page({ fillText: true, dropPicture: true }), spec);
    // The words are on the page and match; only the picture is missing. Before, the words stayed in the bare render and weren't counted at all (0%).
    expect(report.bands[2]!.content).toBeGreaterThan(0);
  }, 60_000);

  it("a page that scrolls sideways fails the other-widths check", async () => {
    const spec = await designOf(page());
    const report = await check(page({ wide: true }), spec);
    expect(report.widths.some((w) => w.overflow)).toBe(true);
  }, 60_000);

  it("a page that hides its sideways overflow doesn't scroll sideways; the design's own width is checked too", async () => {
    const spec = await designOf(page());
    const report = await check(page({ clipX: true }), spec);
    expect(report.widths.map((w) => w.width)).toEqual([1000, 390, 820, 1920]);
    expect(report.widths.filter((w) => w.overflow)).toEqual([]);
    expect(report.failures, report.failures.join("\n")).toEqual([]);
  }, 60_000);

  it("TAWD's skip link, a screen-reader-only span and invisible text aren't added words", async () => {
    const spec = await designOf(page());
    const report = await check(page({ skip: true }), spec);
    expect(report.words.added).toEqual([]);
    expect(report.words.ok).toBe(true);
  }, 60_000);

  it("a form placeholder the design shows isn't a missing word", async () => {
    const spec = await designOf(page({ designForm: true }));
    const report = await check(page({ form: true }), spec);
    expect(report.words.missing).toEqual([]);
    expect(report.words.added).toEqual([]);
  }, 60_000);

  it("one uncertain 'the' (the second) leaves the other 'the' on the page in place", async () => {
    const spec = await designOf(page({ the: true }));
    const text = spec.words[0]!.text;
    const at = text.lastIndexOf("the");
    const uncertain: DesignSpec = { ...spec, words: [{ text: text.slice(0, at) }, { text: "the", uncertain: true }, { text: text.slice(at + 3) }] };
    const report = await check(page({ the: true }), uncertain);
    expect(report.words.missing).toEqual([]);
    expect(report.words.added).toEqual([]);
  }, 60_000);

  it("sideways overflow doesn't change the colour scores", async () => {
    const spec = await designOf(page());
    const exact = await check(page(), spec);
    const wide = await check(page({ strip: true }), spec);
    expect(wide.widths.some((w) => w.overflow)).toBe(true);
    expect(wide.bands.map((b) => [b.colour, b.content])).toEqual(exact.bands.map((b) => [b.colour, b.content]));
  }, 60_000);

  it("a 4 px divider between the bands is too small to be a band (changed: it used to be reported as an extra band); every design band is found and in place", async () => {
    const spec = await designOf(page());
    const report = await check(page({ divider: true }), spec);
    expect(report.extraBands).toEqual([]);
    expect(report.bands.every((b) => b.built !== null && b.position)).toBe(true);
    expect(report.failures, report.failures.join("\n")).toEqual([]);
  }, 60_000);

  it("header and footer inside one wrapper div, and a wrapper inside main with a floating child, still give all five bands", async () => {
    const spec = await designOf(page());
    const report = await check(page({ app: true, wrap: true }), spec);
    expect(report.extraBands).toEqual([]);
    expect(report.bands.every((b) => b.built !== null && b.position)).toBe(true);
  }, 60_000);

  it("a 1 px picture at the end of the page doesn't collapse the page into one band", async () => {
    const spec = await designOf(page());
    const report = await check(page({ tracker: true }), spec);
    expect(report.failures, report.failures.join("\n")).toEqual([]);
    expect(report.score).toBe(100);
  }, 60_000);

  it("sections narrower than the page (boxed) are still bands", async () => {
    const spec = await designOf(page({ boxed: true }));
    const report = await check(page({ boxed: true }), spec);
    expect(report.failures, report.failures.join("\n")).toEqual([]);
    expect(report.score).toBe(100);
  }, 60_000);

  it("text is read in document order: a wrapped inline span, and a row of cards", async () => {
    const spec = await designOf(page({ order: true }));
    const report = await check(page({ order: true }), spec);
    expect(report.words.missing).toEqual([]);
    expect(report.words.added).toEqual([]);
  }, 60_000);

  it("text in slides outside a clipping carousel isn't a word", async () => {
    const spec = await designOf(page());
    const text = spec.words[0]!.text.replace("Same day service.", "Same day service.\nSlide one");
    const report = await check(page({ carousel: true }), { ...spec, words: [{ text }] });
    expect(report.words.added).toEqual([]);
    expect(report.words.missing).toEqual([]);
  }, 60_000);

  it("a header fixed to the top of the page is a band", async () => {
    const spec = await designOf(page());
    const report = await check(page({ fixedHeader: true }), spec);
    expect(report.extraBands).toEqual([]);
    expect(report.bands.every((b) => b.built !== null && b.position)).toBe(true);
    expect(report.score).toBe(100);
  }, 60_000);

  it("a redirect to an error page that has a body is an error", async () => {
    const spec = await designOf(page());
    pages.set("/gone", "<!doctype html><html><body><h1>Not found</h1><p>Sorry, nothing here.</p></body></html>");
    statuses.set("/gone", 404);
    redirects.set("/moved", "/gone");
    await expect(checkAgainstDesign(browser, `${origin}/moved`, spec)).rejects.toThrow("the page answered 404");
  }, 60_000);

  it("the headline is graded: a band 50 px off scores between the exact copy and a band 300 px off", async () => {
    const spec = await designOf(page());
    const exact = await check(page(), spec);
    // The footer is cut by as much as the section is pushed, so the page height (and the words) stay as they were: only the bands differ.
    const near = await check(page({ shiftBy: 20, footerCut: 20 }), spec);
    const far = await check(page({ shiftBy: 55, footerCut: 55 }), spec);
    expect(exact.score).toBe(100);
    expect(near.height.ok && far.height.ok).toBe(true);
    expect(near.bands[2]!.position).toBe(false);
    expect(far.bands[2]!.position).toBe(false);
    expect(near.score).toBeLessThan(100);
    expect(near.score).toBeGreaterThan(far.score);
  }, 60_000);

  it("a first section 14 px taller fails only itself: the bands below, and their pictures, are measured from it", async () => {
    const spec = await designOf(page());
    const report = await check(page({ tall: true }), spec);
    expect(report.bands.map((b) => b.position)).toEqual([true, false, true, true, true]);
    expect(report.bands[2]!.pictures.every((p) => p.ok)).toBe(true);
    expect(report.height.built).toBe(spec.height + 14);
    expect(report.height.ok).toBe(true);
  }, 60_000);

  it("a page where every band fails position and colour scores low", async () => {
    const spec = await designOf(page());
    const report = await check(page({ scramble: true }), spec);
    expect(report.bands.every((b) => !b.position && !b.colourOk)).toBe(true);
    // Every band wrong, every word right: words are a quarter of the score, so about half (Fable's third read).
    expect(report.score).toBeLessThanOrEqual(50);
  }, 60_000);

  it("a page that answers with an error isn't measured", async () => {
    const spec = await designOf(page());
    await expect(checkAgainstDesign(browser, `${origin}/no-such-page`, spec)).rejects.toThrow("the page answered 404");
  }, 60_000);

  // Fable's third read of E2.
  it("cards pulled up over the band above (overlapping sections) are still separate bands", async () => {
    const spec = await designOf(page({ overlap: true }));
    const report = await check(page({ overlap: true }), spec);
    expect(report.failures, report.failures.join("\n")).toEqual([]);
    expect(report.score).toBe(100);
  }, 60_000);

  it("a page with one section in <main> keeps it as one band, not its parts", async () => {
    const html = `<!doctype html><html><head><style>${CSS}</style></head><body><header><strong>Pat Rivera</strong></header><main><section class="a" style="height:auto;padding:0"><div style="height:300px;background:#eef4ed"><h2>Top part</h2></div><div style="height:500px;background:#8da9c4"><h2>Lower part</h2></div></section></main><footer><p>Reno</p></footer></body></html>`;
    const spec = await designOf(html);
    const report = await check(html, spec);
    expect(report.failures, report.failures.join("\n")).toEqual([]);
  }, 60_000);

  it("reads a drop cap and a superscript as part of their word", async () => {
    const html = `<!doctype html><html><head><style>${CSS}</style></head><body><header><strong>Header</strong></header><main><section class="a"><p><span style="float:left;font-size:3em">W</span>e drill wells the 1<sup>st</sup> time.</p></section></main><footer><p>Reno</p></footer></body></html>`;
    const spec = await designOf(html);
    spec.words = [{ text: "Header We drill wells the 1st time. Reno" }];
    const report = await check(html, spec);
    expect(report.words.missing).toEqual([]);
    expect(report.words.added).toEqual([]);
  }, 60_000);

  it("weighs the words: every word replaced, same layout, scores 80 or less; one dropped word is never 100", async () => {
    const spec = await designOf(page());
    const swapped = await check(page({ swapWords: true }), spec);
    expect(swapped.score).toBeLessThanOrEqual(80);
    const dropped = await check(page({ dropWord: true }), spec);
    expect(dropped.failures.length).toBeGreaterThan(0);
    expect(dropped.score).toBeLessThan(100);
  }, 60_000);

  // Fable's fourth read of E2.
  it("keeps words apart across a line break and between links set apart by a margin, in minified markup", async () => {
    const html = `<!doctype html><html><head><style>${CSS}</style></head><body><header><strong>Header</strong></header><main><section class="a"><h2>Serving<br>Northern Nevada</h2><p><a href="/p">Privacy</a><a href="/t" style="margin-left:20px">Terms</a><span style="margin-left:20px">Sitemap</span></p></section></main><footer><p>Reno</p></footer></body></html>`;
    const spec = await designOf(html);
    spec.words = [{ text: "Header Serving Northern Nevada Privacy Terms Sitemap Reno" }];
    const report = await check(html, spec);
    expect(report.words.missing).toEqual([]);
    expect(report.words.added).toEqual([]);
  }, 60_000);

  it("opens a lone <article> wrapping all of main's sections into those sections", async () => {
    const wrapped = page().replace("<main>", "<main><article>").replace("</main>", "</article></main>");
    const spec = await designOf(page());
    const report = await check(wrapped, spec);
    expect(report.failures, report.failures.join("\n")).toEqual([]);
  }, 60_000);
});
