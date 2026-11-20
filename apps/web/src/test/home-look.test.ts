import fs from "node:fs";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/*
  The home page's look on a page builder's site (Harbor's first real read,
  7 October 2026, 0.97.0): main > div > div > sections is read section by
  section, a heading's <br> keeps its space, a long section keeps up to
  4,000 characters, and the menu is the nav with the site's own links, not
  a "Skip to content" nav. Laid out as a blocked route's HTML is (JavaScript
  off, no requests). Real Chrome; skipped where it isn't installed.
*/

import { summarizeCurrentSite, MAX_SECTIONS } from "@tawd/core/mockups";
import { HOME_TEXT_CAP, readMenu } from "../../../worker/src/home-look";
import { BAND_TEXT_CAP, readBands } from "../../../worker/src/liked-sites";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const hasChrome = fs.existsSync(CHROME);
const require = createRequire(import.meta.url);
type Page = Parameters<typeof readBands>[0];
let browser: { newContext: (o: object) => Promise<{ newPage: () => Promise<Page>; close: () => Promise<void> }>; close: () => Promise<void> };

beforeAll(async () => {
  if (!hasChrome) return;
  const { chromium } = require("../../../worker/node_modules/playwright-core");
  browser = await chromium.launch({ executablePath: CHROME });
});
afterAll(async () => {
  await browser?.close();
});

const long = "Pests are more than just a nuisance. ".repeat(60);
const section = (n: number, heading: string, words: string) => `<div class="elementor-element e-flex"><div class="e-con-inner"><h2>${heading}</h2><p>${words}</p><p style="height:120px">Section ${n}.</p></div></div>`;
const PAGE = `<!doctype html><html><head><title>Harbor Pest Control</title></head><body>
<nav class="skip"><a href="#content">Skip to content</a></nav>
<header class="elementor elementor-location-header">
  <div class="top-bar"><a href="https://www.facebook.com/harbor">Facebook</a> <a href="https://pay.example.com/">Pest Control Payment</a> <a href="tel:9165550122">(916) 555 0122</a></div>
  <nav class="elementor-nav-menu--main"><ul>
    <li><a href="https://harborpest.com/">HOME</a></li><li><a href="https://harborpest.com/about/">ABOUT US</a></li>
    <li><a href="https://harborpest.com/pest-control/">PEST CONTROL</a></li><li><a href="https://harborpest.com/blog/">BLOG</a></li>
    <li><a href="https://harborpest.com/contact/">CONTACT US</a></li>
  </ul></nav>
</header>
<main id="content"><div class="page-content"><div class="elementor elementor-7938">
  <div class="elementor-element hero"><div class="e-con-inner"><h1>Pest Control Services<br>Sacramento</h1><p>Serving the Greater Sacramento Area Since 2014.</p><p style="height:400px">Book Pest Control Now!</p></div></div>
  ${section(2, "What Makes Us Trusted Pest Experts", "BBB-Accredited Business. Licensed Contractors.")}
  ${section(3, "Year-Round Pest Protection", long)}
  ${Array.from({ length: 24 }, (_, i) => section(i + 4, `Part ${i + 4}`, "Local, licensed and family-run.")).join("\n")}
</div></div></main>
<footer><p>QUICK LINKS Home About Us. 1100 Melody Ln. Suite 2017 Roseville, CA 95678</p><p style="height:200px">Copyright 2026 Harbor Pest Control</p></footer>
</body></html>`;

async function laidOut(): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: false });
  const page = await context.newPage();
  await (page as unknown as { route: (p: string, f: (r: { abort: () => Promise<void> }) => Promise<void>) => Promise<void> }).route("**/*", (r) => r.abort());
  await (page as unknown as { setContent: (h: string) => Promise<void> }).setContent(PAGE.replace("<head>", `<head><base href="https://harborpest.com/">`));
  return { page, close: () => context.close() };
}

describe.skipIf(!hasChrome)("a page builder's home page, read section by section", () => {
  it("every section apart, the heading's <br> as a space, a long section kept to 4,000 characters, the menu from the nav with the site's links", async () => {
    const { page, close } = await laidOut();
    try {
      const { bands } = await readBands(page, { textCap: HOME_TEXT_CAP });
      const result = summarizeCurrentSite({ title: "Harbor Pest Control", bands, menu: await readMenu(page) });
      expect(result.menu.map((m) => m.label)).toEqual(["HOME", "ABOUT US", "PEST CONTROL", "BLOG", "CONTACT US"]);
      const headings = result.sections.map((s) => s.heading);
      expect(headings).toContain("Pest Control Services Sacramento");
      expect(headings).toContain("What Makes Us Trusted Pest Experts");
      // All 27 of the page's sections and its header and footer: more than the old 20, within MAX_SECTIONS.
      expect(headings).toContain("Part 27");
      expect(result.sections.length).toBeLessThanOrEqual(MAX_SECTIONS);
      const longOne = result.sections.find((s) => s.heading === "Year-Round Pest Protection")!;
      expect(longOne.words.length).toBeGreaterThan(BAND_TEXT_CAP);
      // Other readers (liked sites) keep the shorter cut.
      const short = (await readBands(page)).bands.find((b) => b.heading === "Year-Round Pest Protection")!;
      expect(short.text.length).toBeLessThanOrEqual(BAND_TEXT_CAP);
    } finally {
      await close();
    }
  });
});
