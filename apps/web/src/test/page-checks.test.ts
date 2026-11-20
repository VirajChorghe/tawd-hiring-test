import fs from "node:fs";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkPageRules, runHtmlChecks } from "@tawd/core/mockups";
import { PAGE_WRITING_RULES } from "../../../../packages/core/src/lib/page-writing-rules";
import { buildSiteSystemPrompt } from "@tawd/core/site";
import { runRenderedChecks } from "../../../worker/src/render";

/*
  Jason's seven comments on Sample Plumbing Co.' concept (8 October
  2026), as checks on TAWD's own concepts and one rule for both builders.
*/

const facts = { businessName: "Sample Plumbing Co.", cities: ["Sacramento"] };
const page = (bands: string) => `<!doctype html><html><head><title>t</title></head><body><header><p>24/7 emergency plumbing</p><a class="btn" href="tel:+19162357878">24/7 Emergency (916) 235-7878</a></header><main>${bands}</main><footer>f</footer></body></html>`;

describe("the page rules, as checks", () => {
  it("fails a form button that isn't 'Request a quote' (TAWD rewords it by code)", () => {
    const issues = checkPageRules(page('<section class="hero"><h1>Plumber in Sacramento</h1><a class="btn" href="#contact">Describe the problem</a><img src="tawd-asset:photo-1" alt="x"></section>'), facts);
    expect(issues.map((i) => i.id)).toEqual(["copy.formButton"]);
  });

  it("fails '24/7' more than twice on the first screen, naming it", () => {
    const issues = checkPageRules(page('<section class="hero"><p class="kicker">24/7</p><h1>24/7 Emergency Plumbing</h1><img src="tawd-asset:photo-1" alt="x"></section>'), facts);
    expect(issues.find((i) => i.id === "copy.repeats")?.message).toContain('"24/7" appears 4 times');
  });

  // A2 (CodeRabbit on PR #55): the credential budget holds on the WHOLE page, not only the first screen.
  it("fails '24/7' more than twice across the whole page, with the first screen clean", () => {
    const bands = '<section class="hero"><h1>Plumber in Sacramento</h1><img src="tawd-asset:photo-1" alt="x"></section>' +
      "<section><h2>Our services</h2><p>24/7 drain work.</p></section>" +
      "<section><h2>Why us</h2><p>We answer 24/7.</p></section>" +
      "<section><h2>How it works</h2><p>Call 24/7 and we come out.</p></section>";
    const issues = checkPageRules(page(bands), facts);
    expect(issues.find((i) => i.id === "copy.repeats")?.message).toContain('"24/7" appears 3 times on the page');
    // Twice on the page (the budget) is fine; the header's own 24/7s are chrome and don't count.
    const twice = bands.replace("<p>Call 24/7 and we come out.</p>", "<p>Call and we come out.</p>");
    expect(checkPageRules(page(twice), facts).find((i) => i.id === "copy.repeats")).toBeUndefined();
  });

  it("fails a drawn map in the service-area band", () => {
    const map = `<svg viewBox="0 0 200 300"><path d="${"M10 10 L20 20 ".repeat(40)}"/></svg>`;
    const issues = checkPageRules(page(`<section class="hero"><h1>Plumber in Sacramento</h1><img src="tawd-asset:photo-1" alt="x"></section><section><h2>Areas we serve</h2>${map}</section>`), facts);
    expect(issues.map((i) => i.id)).toContain("images.drawnMap");
  });

  it("only runs on TAWD's own concepts", () => {
    const html = page('<section class="hero"><h1>Plumber</h1><a class="btn" href="#contact">Describe the problem</a></section>');
    const base = { phones: ["(916) 235-7878"], licenseNumbers: [], yearFounded: null, businessName: facts.businessName, cities: facts.cities };
    expect(runHtmlChecks(html, base).issues.some((i) => i.id === "copy.formButton")).toBe(false);
    expect(runHtmlChecks(html, { ...base, pictures: { stockAvailable: false } }).issues.some((i) => i.id === "copy.formButton")).toBe(true);
  });

  it("is told to both builders, and the site builder no longer suggests 'Send a message'", () => {
    expect(PAGE_WRITING_RULES).toContain('"Request a quote"');
    const site = buildSiteSystemPrompt("profile", { css: "", header: "", footer: "", sections: [] } as never, "assets");
    expect(site).toContain(PAGE_WRITING_RULES);
    expect(site).not.toContain('"Send a message"),');
  });

  // A2 (the design-skills diagnosis, 8 November 2026): "say each fact once per screen" licensed a
  // credential 7 times on a 7-screen page. Now a page budget: at most twice, in different forms.
  it("gives credentials a page budget of two tellings in different forms, not once per screen", () => {
    expect(PAGE_WRITING_RULES).toContain("at most twice on the page");
    expect(PAGE_WRITING_RULES).toContain("different forms");
    expect(PAGE_WRITING_RULES).not.toContain("Say each fact once per screen");
    // The first-screen caps (code-checked in page-checks.ts) stay.
    expect(PAGE_WRITING_RULES).toContain("each appear at most twice");
  });
});

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const hasChrome = fs.existsSync(CHROME);
const require = createRequire(import.meta.url);
let browser: Parameters<typeof runRenderedChecks>[0];

beforeAll(async () => {
  if (!hasChrome) return;
  const { chromium } = require("../../../worker/node_modules/playwright-core");
  browser = await chromium.launch({ executablePath: CHROME });
});
afterAll(async () => {
  await browser?.close();
});

const faq = (headOnLeft: boolean) => `<!doctype html><html><head><style>.wrap{display:grid;grid-template-columns:1fr 1fr;gap:40px;width:1200px}</style></head><body><main>
<section><div class="wrap">
  <div>${headOnLeft ? '<span class="eyebrow">FAQ</span><h2>Plumbing questions</h2>' : ""}<div class="box">Water where it shouldn't be?</div></div>
  <div><details><summary>Do you offer emergency service?</summary><p>Yes.</p></details></div>
</div></section></main></body></html>`;

describe.skipIf(!hasChrome)("a heading over one column only, on the render", () => {
  it("fails the official run's FAQ layout, and passes it with the heading above both columns", async () => {
    const bad = await runRenderedChecks(browser, faq(true), { pageRules: true });
    expect(bad.find((i) => i.id === "layout.headingOneColumn")?.sections).toEqual([0]);
    const good = await runRenderedChecks(browser, faq(false).replace("<section>", "<section><h2>Plumbing questions</h2>"), { pageRules: true });
    expect(good.find((i) => i.id === "layout.headingOneColumn")).toBeUndefined();
    // Not on a designer's design.
    expect((await runRenderedChecks(browser, faq(true), {})).find((i) => i.id === "layout.headingOneColumn")).toBeUndefined();
  }, 60_000);
});

/*
  Gap 13 (6 November 2026, a client's Concept B): the rendered layout safety
  net for the builder's free-form inline CSS.
*/
const headingBand = (constrained: boolean) => `<!doctype html><html><head><style>
  .col{width:900px}
  h2.t{font-size:34px;line-height:1.2;margin:0;${constrained ? "max-width:12ch;" : ""}}
</style></head><body><main>
<section><div class="col"><h2 class="t">Why homeowners across the whole region keep choosing our awning team</h2><p>Body copy sits below the heading.</p></div></section>
</main></body></html>`;

// A constrained heading that wraps to only two lines but carries heavy vertical
// padding: its border-box height must not be miscounted as a third line.
const headingPadded = `<!doctype html><html><head><style>
  .col{width:900px}
  h2.t{font-size:30px;line-height:1.2;margin:0;padding:24px 0;max-width:16ch}
</style></head><body><main>
<section><div class="col"><h2 class="t">Local awning experts</h2><p>Body copy sits below the heading.</p></div></section>
</main></body></html>`;

describe.skipIf(!hasChrome)("a heading squeezed onto too many lines, on the render", () => {
  it("fails a heading pinched onto three or more lines while its column has room, and passes the same heading at full width", async () => {
    const bad = await runRenderedChecks(browser, headingBand(true), { pageRules: true });
    expect(bad.find((i) => i.id === "layout.headingWrap")?.sections).toEqual([0]);
    const good = await runRenderedChecks(browser, headingBand(false), { pageRules: true });
    expect(good.find((i) => i.id === "layout.headingWrap")).toBeUndefined();
    // Not on a designer's design (no page rules).
    expect((await runRenderedChecks(browser, headingBand(true), {})).find((i) => i.id === "layout.headingWrap")).toBeUndefined();
  }, 60_000);

  it("counts the text's own lines, not its padding: a padded two-line heading is not flagged", async () => {
    expect((await runRenderedChecks(browser, headingPadded, { pageRules: true })).find((i) => i.id === "layout.headingWrap")).toBeUndefined();
  }, 60_000);
});

// A grid whose row-spanning item leaves an interior cell empty (hole), versus
// the same grid with every cell filled.
const gridBand = (hole: boolean) => `<!doctype html><html><head><style>
  .g{display:grid;grid-template-columns:1fr 1fr 1fr;grid-template-rows:180px 180px;gap:16px;width:1200px}
  .cell{background:#eee}
  .span{grid-column:1/2;grid-row:1/3}
  .a{grid-column:2/3;grid-row:1/2}
  .b{grid-column:3/4;grid-row:1/2}
  .c{grid-column:3/4;grid-row:2/3}
  .d{grid-column:2/3;grid-row:2/3}
</style></head><body><main>
<section><div class="g">
  <div class="cell span">Main</div>
  <div class="cell a">A</div>
  <div class="cell b">B</div>
  <div class="cell c">C</div>
  ${hole ? "" : '<div class="cell d">D</div>'}
</div></section></main></body></html>`;

// A normal three-column grid whose last row is partly filled: a trailing gap,
// not a hole, and no item spans — it must be left alone.
const partialGrid = `<!doctype html><html><head><style>
  .g{display:grid;grid-template-columns:1fr 1fr 1fr;grid-template-rows:160px 160px;gap:16px;width:1200px}
  .cell{background:#eee}
</style></head><body><main>
<section><div class="g">
  <div class="cell">1</div><div class="cell">2</div><div class="cell">3</div>
  <div class="cell">4</div><div class="cell">5</div>
</div></section></main></body></html>`;

// A correctly tiled grid with a tall feature card spanning two rows and short,
// top-aligned sibling cards (align-items:start). Every cell has a child, so a
// cell-centre hit-test would wrongly read the short cards' cells as empty.
const gridStartAligned = `<!doctype html><html><head><style>
  .g{display:grid;grid-template-columns:1fr 1fr 1fr;grid-template-rows:180px 180px;gap:16px;width:1200px;align-items:start}
  .cell{background:#eee;min-height:40px}
  .span{grid-column:1/2;grid-row:1/3;min-height:376px}
  .a{grid-column:2/3;grid-row:1/2}
  .b{grid-column:3/4;grid-row:1/2}
  .c{grid-column:3/4;grid-row:2/3}
  .d{grid-column:2/3;grid-row:2/3}
</style></head><body><main>
<section><div class="g">
  <div class="cell span">Main</div>
  <div class="cell a">A</div><div class="cell b">B</div>
  <div class="cell c">C</div><div class="cell d">D</div>
</div></section></main></body></html>`;

// The same holed grid, but its items are wrapped in a display:contents element
// (which is not itself a grid item) — the hole must still be found.
const gridContentsHole = `<!doctype html><html><head><style>
  .g{display:grid;grid-template-columns:1fr 1fr 1fr;grid-template-rows:180px 180px;gap:16px;width:1200px}
  .cell{background:#eee}
  .span{grid-column:1/2;grid-row:1/3}
  .a{grid-column:2/3;grid-row:1/2}
  .b{grid-column:3/4;grid-row:1/2}
  .c{grid-column:3/4;grid-row:2/3}
</style></head><body><main>
<section><div class="g"><div style="display:contents">
  <div class="cell span">Main</div><div class="cell a">A</div><div class="cell b">B</div><div class="cell c">C</div>
</div></div></section></main></body></html>`;

// A grid with fixed columns narrower than the container and justify-content:center
// shifts the tracks off the content edge, so the cell map can't be trusted: skip it.
const gridCentered = `<!doctype html><html><head><style>
  .g{display:grid;grid-template-columns:200px 200px 200px;grid-template-rows:180px 180px;gap:16px;width:1200px;justify-content:center}
  .cell{background:#eee}
  .span{grid-column:1/2;grid-row:1/3}
  .a{grid-column:2/3;grid-row:1/2}
  .b{grid-column:3/4;grid-row:1/2}
  .c{grid-column:3/4;grid-row:2/3}
</style></head><body><main>
<section><div class="g">
  <div class="cell span">Main</div><div class="cell a">A</div><div class="cell b">B</div><div class="cell c">C</div>
</div></section></main></body></html>`;

describe.skipIf(!hasChrome)("an empty grid cell left by a row-spanning item, on the render", () => {
  it("fails a grid with an interior empty cell, passes the fully tiled grid, and leaves a normal partial last row alone", async () => {
    const bad = await runRenderedChecks(browser, gridBand(true), { pageRules: true });
    expect(bad.find((i) => i.id === "layout.gridOrphan")?.sections).toEqual([0]);
    const good = await runRenderedChecks(browser, gridBand(false), { pageRules: true });
    expect(good.find((i) => i.id === "layout.gridOrphan")).toBeUndefined();
    // A normal partial last row (no span) is not a hole.
    expect((await runRenderedChecks(browser, partialGrid, { pageRules: true })).find((i) => i.id === "layout.gridOrphan")).toBeUndefined();
    // Not on a designer's design (no page rules).
    expect((await runRenderedChecks(browser, gridBand(true), {})).find((i) => i.id === "layout.gridOrphan")).toBeUndefined();
  }, 60_000);

  it("does not flag a tiled grid whose short cards are top-aligned (overlap, not a centre hit-test)", async () => {
    expect((await runRenderedChecks(browser, gridStartAligned, { pageRules: true })).find((i) => i.id === "layout.gridOrphan")).toBeUndefined();
  }, 60_000);

  it("still finds the hole when the items are wrapped in display:contents", async () => {
    expect((await runRenderedChecks(browser, gridContentsHole, { pageRules: true })).find((i) => i.id === "layout.gridOrphan")?.sections).toEqual([0]);
  }, 60_000);

  it("skips a grid whose tracks are centred (justify-content), rather than mis-mapping its cells", async () => {
    expect((await runRenderedChecks(browser, gridCentered, { pageRules: true })).find((i) => i.id === "layout.gridOrphan")).toBeUndefined();
  }, 60_000);
});

/*
  The repeated trust facts (Jason's run, 10 November 2026).

  The Creative Director marked Concept A down three times for one fault:
  the hero's "Since 1970 / License #123456" line repeating the stat bar
  directly below it, a six-item list repeating band 8's spec list word for
  word, and a timeline "repeating a year already shown four times". Its
  verdict on the page was that the repeated trust facts "keep it short of
  a finished, sellable feel".

  "24/7" was already on a page-wide budget because it is exact. The year
  and the licence are exact too - TAWD has both from the intake - which is
  why they can now be counted the same way.
*/
describe("the credential budget, page-wide", () => {
  const facts = { businessName: "Clear Sky Awning", cities: ["Fair Oaks", "Folsom"], phones: ["(916) 555-0111"], yearFounded: 1970, licenseNumbers: ["123456"] };
  const page = (bands: string) =>
    `<!doctype html><html><head><title>T</title></head><body><header><a href="tel:+19165550111">Call (916) 555-0111</a></header>${bands}<footer>Clear Sky Awning, since 1970, License #123456</footer></body></html>`;

  const ids = (html: string) => checkPageRules(html, facts).filter((i) => i.id === "copy.repeats");

  it("flags a founding year said four times in the page's own bands", () => {
    const html = page(
      `<section><h1>Patio Covers in Fair Oaks</h1><p>Building since 1970.</p></section>
       <section><h2>The numbers</h2><p>Since 1970. License #123456.</p></section>
       <section><h2>Patio Covers Since 1970</h2><p>A timeline from 1970 to today.</p></section>`,
    );
    const found = ids(html);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("1970");
    expect(found[0]!.message).toContain("at most twice");
  });

  it("flags a licence number said three times", () => {
    const html = page(
      `<section><h1>Patio covers</h1><p>License #123456.</p></section>
       <section><p>License 123456 held since 1970.</p></section>
       <section><p>Licence number 123456.</p></section>`,
    );
    expect(ids(html)[0]!.message).toContain("123456");
  });

  it("allows twice, and never counts the header or the footer", () => {
    // Twice in the bands, plus the footer's own mention: still within budget.
    const html = page(`<section><h1>Patio covers in Fair Oaks</h1><p>Since 1970.</p></section><section><p>Since 1970, License #123456.</p></section>`);
    expect(ids(html)).toEqual([]);
  });

  it("leaves the city alone, because local SEO wants it repeated", () => {
    const html = page(
      `<section><h1>Patio Covers in Fair Oaks</h1><p>Serving Fair Oaks homeowners.</p></section>
       <section><h2>Where we work</h2><p>Fair Oaks, Folsom and nearby.</p></section>
       <section><h2>Fair Oaks patio covers</h2><p>Fair Oaks projects.</p></section>`,
    );
    expect(ids(html)).toEqual([]);
  });

  it("does not count the year inside a phone number, an address, a price or a longer number", () => {
    const html = page(
      `<section><h1>Patio covers</h1><p>Since 1970.</p></section>
       <section><p>Call (916) 235-1970 or 916-1970-123.</p></section>
       <section><p>Visit 19700 Folsom Blvd. From $1970 or 1970.50 total.</p></section>
       <section><p>Order 41970 and ref (1970).</p></section>`,
    );
    expect(ids(html)).toEqual([]);
  });

  it("says nothing when the intake has no year or licence", () => {
    const bare = { businessName: "Clear Sky Awning", cities: ["Fair Oaks"], phones: [] };
    const html = page(`<section><p>Since 1970. Since 1970. Since 1970.</p></section>`);
    expect(checkPageRules(html, bare).filter((i) => i.id === "copy.repeats")).toEqual([]);
  });
});
