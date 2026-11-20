import fs from "node:fs";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compareWithDesign } from "../../../worker/src/fidelity";
import { measureBands, renderConcept } from "../../../worker/src/render";

/*
  The fidelity check in a real Chrome: a page compared with a picture of
  itself matches almost fully; a page that differs in one section scores
  lower there, and only there. Skipped where Chrome is not installed.
*/

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const hasChrome = fs.existsSync(CHROME);
const require = createRequire(import.meta.url);

type Browser = Parameters<typeof renderConcept>[0];
let browser: Browser;

beforeAll(async () => {
  if (!hasChrome) return;
  const { chromium } = require("../../../worker/node_modules/playwright-core");
  browser = await chromium.launch({ executablePath: CHROME });
});

afterAll(async () => {
  await browser?.close();
});

const page = (heroColour: string) => `<!doctype html><html><head><style>*{box-sizing:border-box}</style></head><body style="margin:0;font-family:Arial">
<header data-figma-section="1" style="height:120px;background:#ffffff;display:flex;align-items:center;padding:0 80px"><b style="font-size:28px;color:#1f4e79">Example Well &amp; Pump</b></header>
<section data-figma-section="2" style="height:700px;background:${heroColour};color:#fff;padding:120px 80px"><h1 style="font-size:60px;margin:0">Well drilling</h1></section>
<section data-figma-section="3" style="height:500px;background:#f4f1ea;padding:80px"><h2 style="margin:0">Our services</h2></section>
</body></html>`;

const sections = [
  { name: "Header", top: 0, height: 120 },
  { name: "Hero", top: 120, height: 700 },
  { name: "Services", top: 820, height: 500 },
];

describe.skipIf(!hasChrome)("the fidelity check in a real browser", () => {
  it("scores a page against a picture of itself close to 100%", async () => {
    const shot = await renderConcept(browser, page("#1f4e79"));
    const result = await compareWithDesign(browser, {
      design: shot.fullPage,
      copy: shot.fullPage,
      frameWidth: 1440,
      sections,
      copyBands: await measureBands(browser, page("#1f4e79")),
    });
    expect(result.method).toBe("sections");
    expect(result.overall).toBeGreaterThanOrEqual(98);
  }, 60_000);

  it("scores lower where a section differs, and only there", async () => {
    const design = await renderConcept(browser, page("#1f4e79"));
    const copy = await renderConcept(browser, page("#c8551b"));
    const result = await compareWithDesign(browser, {
      design: design.fullPage,
      copy: copy.fullPage,
      frameWidth: 1440,
      sections,
      copyBands: await measureBands(browser, page("#c8551b")),
    });
    const byName = Object.fromEntries(result.sections.map((s) => [s.name, s.score]));
    expect(byName.Header).toBeGreaterThanOrEqual(95);
    expect(byName.Services).toBeGreaterThanOrEqual(95);
    expect(byName.Hero).toBeLessThan(40);
    expect(result.overall).toBeLessThan(80);
  }, 60_000);

  it("compares the page whole when the sections don't pair up", async () => {
    const shot = await renderConcept(browser, page("#1f4e79"));
    const result = await compareWithDesign(browser, {
      design: shot.fullPage,
      copy: shot.fullPage,
      frameWidth: 1440,
      sections,
      copyBands: [{ top: 0, bottom: 100 }],
    });
    expect(result.method).toBe("page");
    expect(result.overall).toBeGreaterThanOrEqual(98);
  }, 60_000);
});
