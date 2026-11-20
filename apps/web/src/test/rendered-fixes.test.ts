import fs from "node:fs";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { embedAssets, existingFixRules, splitSections } from "@tawd/core/mockups";
import { applyCodeFixes, type CheckResult } from "../../../worker/src/pipeline";
import { runRenderedChecks } from "../../../worker/src/render";

/*
  The fixes a browser works out, in a real Chrome: after code has fixed the
  contrast and the logo, the same rendered checks must pass. Skipped where
  Chrome is not installed.
*/

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const hasChrome = fs.existsSync(CHROME);
const require = createRequire(import.meta.url);

type Browser = Parameters<typeof runRenderedChecks>[0];
let browser: Browser;

beforeAll(async () => {
  if (!hasChrome) return;
  const { chromium } = require("../../../worker/node_modules/playwright-core");
  browser = await chromium.launch({ executablePath: CHROME });
});

afterAll(async () => {
  await browser?.close();
});

const whiteLogo = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><rect x="10" y="10" width="180" height="40" fill="#ffffff"/></svg>',
).toString("base64")}`;
const assets = [{ token: "tawd-asset:logo", kind: "logo" as const, caption: null, fileName: "logo.svg", width: 200, height: 60, dataUri: whiteLogo }];

const source = `<!doctype html><html lang="en"><head><title>ABC Plumbers</title></head><body style="margin:0;background:#ffffff">
<header style="background:#ffffff;padding:20px"><img src="tawd-asset:logo" alt="ABC Plumbers"></header>
<section><h1 style="color:#111">ABC Plumbers</h1><p style="color:#b8c4d6">Pale text that nobody can read on white.</p><p style="color:#5fb8c8">Brand teal body text, a little too light.</p></section>
</body></html>`;

const rendered = (html: string) => embedAssets(html, { "tawd-asset:logo": whiteLogo });
const ids = async (html: string) => (await runRenderedChecks(browser, rendered(html))).map((i) => `${i.id}:${i.severity}`);

describe.skipIf(!hasChrome)("fixes worked out in the browser", () => {
  it("fixes the contrast and the logo by code, and the checks then pass", async () => {
    const before = await ids(source);
    expect(before).toContain("a11y.contrast:fail");
    expect(before).toContain("images.logo.invisible:fail");

    const outcome = {
      issues: before.map((entry) => ({ id: entry.split(":")[0]!, severity: "fail" as const, message: "" })),
    } as unknown as CheckResult;
    const fixed = await applyCodeFixes(browser, source, outcome, assets);
    expect(fixed.fixed).toEqual(expect.arrayContaining(["contrast", "logo visibility"]));

    const after = await ids(fixed.html);
    expect(after).not.toContain("a11y.contrast:fail");
    expect(after).not.toContain("images.logo.invisible:fail");

    // Aimed by class on the element itself, never by position.
    expect(existingFixRules(fixed.html).join(" ")).not.toMatch(/nth-child/);
    expect(fixed.html).toMatch(/<img class="tawd-logo-on-light" src="tawd-asset:logo"/);
    const tealClass = /<p class="(tawd-fix-\d+)" style="color:#5fb8c8">/.exec(fixed.html)![1]!;
    expect(fixed.html).not.toContain("data-tawd-n");

    // The same hue, only darker: the brand teal stays a teal.
    const teal = existingFixRules(fixed.html).find((r) => r.includes(`.${tealClass} `))!;
    const hex = /#([0-9a-f]{6})/.exec(teal)![1]!;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    expect(g!).toBeGreaterThan(r!);
    expect(b!).toBeGreaterThan(r!);
  }, 60_000);

  it("running the fixes again changes nothing", async () => {
    const outcome = { issues: [{ id: "a11y.contrast", severity: "fail", message: "" }] } as unknown as CheckResult;
    const once = await applyCodeFixes(browser, source, outcome, assets);
    const again = await applyCodeFixes(browser, once.html, { issues: [] } as unknown as CheckResult, assets);
    expect(again.html).toBe(once.html);
  }, 60_000);

  it("keeps working when the layout around the fixed elements changes", async () => {
    const outcome = {
      issues: [
        { id: "a11y.contrast", severity: "fail", message: "" },
        { id: "images.logo.invisible", severity: "fail", message: "" },
      ],
    } as unknown as CheckResult;
    const fixed = await applyCodeFixes(browser, source, outcome, assets);
    // A new band before everything, and a new element before the logo and the text.
    const moved = fixed.html
      .replace("<header", `<div style="padding:8px">Open today</div><header`)
      .replace("<img", "<span>Call us</span><img")
      .replace("<h1", "<p>New line</p><h1");
    const after = await ids(moved);
    expect(after).not.toContain("a11y.contrast:fail");
    expect(after).not.toContain("images.logo.invisible:fail");
  }, 60_000);

  it("replaces fixes aimed by position with fixes aimed by class", async () => {
    const old = source.replace(
      "</head>",
      `<style data-tawd-fixes>
body > header:nth-child(1) > img:nth-child(1) { filter: brightness(0) !important; }
</style>
</head>`,
    );
    const fixed = await applyCodeFixes(browser, old, { issues: [] } as unknown as CheckResult, assets);
    const rules = existingFixRules(fixed.html);
    expect(rules.join(" ")).not.toMatch(/nth-child/);
    expect(fixed.html).toContain(`class="tawd-logo-on-light"`);
    const after = await ids(fixed.html);
    expect(after).not.toContain("images.logo.invisible:fail");
    expect(after).not.toContain("a11y.contrast:fail");
  }, 60_000);

  it("names the same band as the page source does", async () => {
    const html = `<!doctype html><html lang="en"><head><title>t</title></head><body style="background:#fff">
<main><header><p>ABC Plumbers</p></header><section><h1>Hi</h1></section><section><p style="color:#dddddd">Too pale to read here.</p></section></main>
<footer><p>Footer</p></footer></body></html>`;
    const contrast = (await runRenderedChecks(browser, html)).find((i) => i.id === "a11y.contrast")!;
    const bands = splitSections(html);
    expect(contrast.sections).toEqual([2]);
    expect(bands[2]!.html).toContain("Too pale to read here.");
  }, 60_000);
});

/*
  Text over a photo or a gradient is measured from the pixels behind it,
  not read as if it sat on white (the faithful copy's hero showed a false
  1.0 to 1, 25 September 2026).
*/
describe.skipIf(!hasChrome)("contrast over pictures, in a real browser", () => {
  const svg = (colour: string) =>
    `data:image/svg+xml;base64,${Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="600"><rect width="1440" height="600" fill="${colour}"/></svg>`,
    ).toString("base64")}`;
  const contrastOf = async (html: string) =>
    (await runRenderedChecks(browser, html)).find((i) => i.id === "a11y.contrast");

  it("skips text that is off the screen (a closed menu drawer) instead of failing the concept (Dave Riccio's Concept A, 1 October 2026)", async () => {
    const html = `<!doctype html><html lang="en"><head><title>t</title></head><body style="margin:0;background:#fff">
<section style="height:600px;background:#0e2a47"><h1 style="color:#fff;margin:0;padding:80px">Plumbing in Sacramento</h1></section>
<nav style="position:fixed;top:0;left:100%;width:360px;height:100vh;background:url('${svg("#333333")}') center/cover"><a href="/" style="color:#ffffff;display:block;padding:24px">Home</a><a href="/drains" style="color:#ffffff;display:block;padding:24px">Drain cleaning</a></nav>
<div style="position:absolute;top:2400px;left:-2000px;background:url('${svg("#222222")}')"><p style="color:#fff">Far off to the left</p></div></body></html>`;
    // Before the fix this threw "Clipped area is either empty or outside the resulting image".
    await expect(runRenderedChecks(browser, html)).resolves.toBeDefined();
    expect(await contrastOf(html)).toBeUndefined();
  }, 60_000);

  it("passes white text on a dark gradient", async () => {
    const html = `<!doctype html><html lang="en"><head><title>t</title></head><body style="margin:0;background:#fff">
<section style="height:600px;background:linear-gradient(120deg,#0e2a47,#1f4e79)"><h1 style="color:#fff;margin:0;padding:80px">Well drilling in Grass Valley</h1><p style="color:#fff;padding:0 80px">Family-run, same-day pump repair.</p></section></body></html>`;
    expect(await contrastOf(html)).toBeUndefined();
  }, 60_000);

  it("passes white text on a dark photo underneath it, and fails it on a pale one", async () => {
    const page = (colour: string) => `<!doctype html><html lang="en"><head><title>t</title></head><body style="margin:0;background:#fff">
<section style="position:relative;height:600px"><img src="${svg(colour)}" alt="" style="position:absolute;inset:0;width:100%;height:100%">
<div style="position:relative;padding:80px"><p style="color:#ffffff;font-size:18px">Same-day pump repair across Nevada County.</p></div></section></body></html>`;
    expect(await contrastOf(page("#1d2a33"))).toBeUndefined();
    const pale = await contrastOf(page("#eeeeee"));
    expect(pale?.message).toContain('on "Same-day pump repair across Nevada');
  }, 60_000);

  it("still reads plain backgrounds from the styles", async () => {
    const html = `<!doctype html><html lang="en"><head><title>t</title></head><body style="margin:0;background:#fff"><p style="color:#dddddd">Too pale to read on white.</p></body></html>`;
    expect((await contrastOf(html))?.message).toMatch(/^1 text element does not meet the contrast floor/);
  }, 60_000);
});

/*
  The contrast fix by code works out a darker (or lighter) shade from the
  colour behind the text. Over a photo or a gradient there is no one colour
  behind it, so it leaves that text alone (4c, 25 September 2026).
*/
describe.skipIf(!hasChrome)("the contrast fix leaves text over pictures alone", () => {
  const pale = `data:image/svg+xml;base64,${Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="600"><rect width="1440" height="600" fill="#eeeeee"/></svg>',
  ).toString("base64")}`;
  const outcome = { passed: false, issues: [{ id: "a11y.contrast", severity: "fail" as const, message: "" }] } as unknown as CheckResult;

  it("fixes pale text on white, but not white text on a photo", async () => {
    const html = `<!doctype html><html lang="en"><head><title>t</title></head><body style="margin:0;background:#fff">
<section style="position:relative;height:600px"><img src="${pale}" alt="" style="position:absolute;inset:0;width:100%;height:100%">
<div style="position:relative;padding:80px"><p style="color:#ffffff;font-size:18px">Same-day pump repair across Nevada County.</p></div></section>
<section><p style="color:#dddddd">Too pale to read on white.</p></section></body></html>`;
    const fixed = await applyCodeFixes(browser, html, outcome, []);
    expect(fixed.fixed).toContain("contrast");
    const sections = splitSections(fixed.html);
    // The photo's section is untouched; the plain one got its class.
    expect(sections[0]!.html).not.toContain("tawd-fix");
    expect(sections[1]!.html).toContain("tawd-fix");
  }, 60_000);
});

describe.skipIf(!hasChrome)("a contrast fix that changes nothing is not made", () => {
  it("leaves white text on a mid-tone button alone (only its background could fix it)", async () => {
    const html = `<!doctype html><html lang="en"><head><title>t</title></head><body style="margin:0;background:#fff">
<section><a style="display:inline-block;background:#c8551b;color:#ffffff;font-size:17px;padding:14px 26px">Call (530) 555-0199</a></section></body></html>`;
    const outcome = { passed: false, issues: [{ id: "a11y.contrast", severity: "fail" as const, message: "" }] } as unknown as CheckResult;
    const fixed = await applyCodeFixes(browser, html, outcome, []);
    expect(fixed.fixed).not.toContain("contrast");
    expect(fixed.html).not.toContain("tawd-fix");
  }, 60_000);
});

/*
  Text too faint to read (5 November 2026, Clear Sky Awning's Concept A:
  its contact card passed). The check read see-through text colours as
  solid, ignored fading on the text or its container, and never looked at
  text sitting straight in a div. Each now fails, and the code fix repairs
  what a colour can repair.
*/
describe.skipIf(!hasChrome)("faint text, in a real browser", () => {
  const card = (inner: string, cardStyle = "background:#0e2a47;padding:32px") => `<!doctype html><html lang="en"><head><title>t</title></head><body style="margin:0;background:#ffffff">
<header><p style="color:#111">Clear Sky Awning</p></header><section><h1 style="color:#111">Awnings in Sacramento</h1></section>
<section><div class="contact-card" style="${cardStyle}">${inner}</div></section><footer><p style="color:#111">Footer</p></footer></body></html>`;
  const contrastOf = async (html: string) => (await runRenderedChecks(browser, html)).find((i) => i.id === "a11y.contrast");

  it("fails see-through white text on a dark card", async () => {
    const found = await contrastOf(card('<p style="color:rgba(255,255,255,0.3)">Call or text us any day of the week</p>'));
    expect(found?.message).toContain("Call or text us");
    expect(await contrastOf(card('<p style="color:#ffffff">Call or text us any day of the week</p>'))).toBeUndefined();
  }, 60_000);

  it("fails text faded by the opacity of its container", async () => {
    const found = await contrastOf(card('<div style="opacity:0.35"><p style="color:#ffffff">Free estimates on every job</p></div>'));
    expect(found?.message).toContain("Free estimates");
  }, 60_000);

  it("fails pale text sitting straight in a div, an address or a strong", async () => {
    for (const tag of ["div", "address", "strong"]) {
      const found = await contrastOf(card(`<${tag} style="color:#c9d3df">Open Monday to Saturday, 8 to 5</${tag}>`, "background:#ffffff;padding:32px"));
      expect(found?.message, tag).toContain("Open Monday to Saturday");
    }
  }, 60_000);

  it("leaves text faded to nothing alone (an animation's starting state)", async () => {
    expect(await contrastOf(card('<p style="color:#ffffff;opacity:0">Fades in on scroll</p>'))).toBeUndefined();
  }, 60_000);

  it("lays a see-through card over the band behind it", async () => {
    // Dark text on a 20% white card over navy reads as dark on dark.
    const found = await contrastOf(`<!doctype html><html lang="en"><head><title>t</title></head><body style="margin:0;background:#0e2a47">
<section><h1 style="color:#fff">Awnings</h1><div style="background:rgba(255,255,255,0.2);padding:24px"><p style="color:#333333">Licensed and insured since day one</p></div></section></body></html>`);
    expect(found?.message).toContain("Licensed and insured");
  }, 60_000);

  it("repairs see-through text by code, and the check then passes", async () => {
    const html = card('<p style="color:rgba(255,255,255,0.3)">Call or text us any day of the week</p>');
    const before = (await runRenderedChecks(browser, html)).map((i) => i.id);
    expect(before).toContain("a11y.contrast");
    const outcome = { issues: [{ id: "a11y.contrast", severity: "fail" as const, message: "" }] } as unknown as CheckResult;
    const fixed = await applyCodeFixes(browser, html, outcome, []);
    expect(fixed.fixed).toContain("contrast");
    expect(await contrastOf(fixed.html)).toBeUndefined();
  }, 60_000);
});
