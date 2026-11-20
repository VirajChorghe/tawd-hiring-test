import fs from "node:fs";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BRAND_BAND_CLASS, brandBandRule, checkRhythm, classifyBackground, markBrandBands, rhythmRule, type BandKind } from "@tawd/core/mockups";
import { runRenderedChecks } from "../../../worker/src/render";

/*
  Pages that pop (Jason, 8 October 2026, Harbor's concept B: "the site was
  dull... the BG colours were all very subtle, had to change a few sections
  BG to the neon green"). Code sets the rhythm per direction, measures the
  rendered page, and turns the right pale bands to the brand colour.
*/

const GREEN = "#8dc63f";

describe("the colour rhythm", () => {
  it("tells white, a light tint, the brand colour and a dark band apart", () => {
    expect(classifyBackground("rgb(255, 255, 255)", [GREEN])).toBe("pale");
    expect(classifyBackground("rgb(241, 248, 232)", [GREEN])).toBe("pale");
    expect(classifyBackground("rgb(141, 198, 63)", [GREEN])).toBe("brand");
    expect(classifyBackground("rgb(31, 41, 55)", [GREEN])).toBe("strong");
    expect(classifyBackground("image", [GREEN])).toBe("strong");
  });

  const kinds: BandKind[] = ["header", "hero", "services", "other", "why", "process", "area", "contact", "footer"];
  const pale = ["#fff", "#f1f8e8", "#fff", "#f1f8e8", "#fff", "#f1f8e8", "#fff", "#f1f8e8", "#1f2937"];

  it("fails Harbor's all-pale page for Bright and Friendly and plans which bands take the brand colour", () => {
    const { issues, plan } = checkRhythm({ backgrounds: pale, kinds, brandColors: [GREEN], direction: "bright_friendly" });
    expect(issues.map((i) => i.id)).toEqual(["design.colourRhythm"]);
    expect(issues[0]!.message).toContain("needs 3");
    // Never the hero; the call to action before the footer is one of them; at least three.
    expect(plan).not.toContain(1);
    expect(plan).toContain(7);
    expect(plan.length).toBeGreaterThanOrEqual(3);
    // With the plan applied, nothing is left to fail.
    const after = pale.map((bg, i) => (plan.includes(i) ? GREEN : bg));
    expect(checkRhythm({ backgrounds: after, kinds, brandColors: [GREEN], direction: "bright_friendly" }).issues).toEqual([]);
  });

  it("asks less of a quiet direction, and nothing of a portfolio or a page without brand colours", () => {
    const one = pale.map((bg, i) => (i === 4 ? GREEN : bg));
    expect(checkRhythm({ backgrounds: one, kinds, brandColors: [GREEN], direction: "premium_upscale" }).issues).toEqual([]);
    expect(checkRhythm({ backgrounds: pale, kinds, brandColors: [GREEN], direction: "gallery_portfolio" }).issues).toEqual([]);
    expect(checkRhythm({ backgrounds: pale, kinds, brandColors: [], direction: "bright_friendly" }).issues).toEqual([]);
  });

  it("tells the builder the rule for its direction", () => {
    expect(rhythmRule("bright_friendly")).toContain("at least 3 bands");
    expect(rhythmRule("bright_friendly")).toContain("never put more than 2 pale bands");
    expect(rhythmRule("gallery_portfolio")).toBe("");
  });

  it("marks the planned bands once, keeping their classes", () => {
    const html = `<html><body><header>h</header><main><section class="why"><h2>Why</h2></section><section><h2>Call</h2></section></main><footer>f</footer></body></html>`;
    const marked = markBrandBands(html, [1, 2]);
    expect(marked).toContain(`<section class="why ${BRAND_BAND_CLASS}">`);
    expect(marked).toContain(`<section class="${BRAND_BAND_CLASS}">`);
    expect(markBrandBands(marked, [1, 2])).toBe(marked);
    // The fix keeps imagery (the diagnosis: the old rule's background-image:none manufactured flat slabs):
    // only the colour is set, blended over whatever the band already had.
    expect(brandBandRule(GREEN)).toContain(`background-color:${GREEN} !important`);
    expect(brandBandRule(GREEN)).toContain("background-blend-mode:multiply");
    expect(brandBandRule(GREEN)).not.toContain("background-image:none");
  });

  // The design-skills diagnosis (8 November 2026): flat brand runs, photo bands, and a plan that never creates a slab.
  it("flags two full brand-colour bands in a row as one flat slab, naming the bands", () => {
    const slab = ["#fff", "#f1f8e8", GREEN, GREEN, "#fff", "#f1f8e8", "#fff", GREEN, "#1f2937"];
    const { issues } = checkRhythm({ backgrounds: slab, kinds, brandColors: [GREEN], direction: "bright_friendly" });
    const flat = issues.find((i) => i.id === "design.colourRhythm.flatRun");
    expect(flat?.sections).toEqual([2, 3]);
    // CodeRabbit on PR #55: the LONGEST run is named, not the first adjacent pair (a pair at 1-2, the slab at 4-6).
    const longer = ["#fff", GREEN, GREEN, "#f1f8e8", GREEN, GREEN, GREEN, "#f1f8e8", "#1f2937"];
    const longest = checkRhythm({ backgrounds: longer, kinds, brandColors: [GREEN], direction: "bright_friendly" }).issues.find((i) => i.id === "design.colourRhythm.flatRun");
    expect(longest?.sections).toEqual([4, 5, 6]);
    // Separated brand bands are fine.
    const spread = ["#fff", "#f1f8e8", GREEN, "#fff", GREEN, "#f1f8e8", "#fff", GREEN, "#1f2937"];
    expect(checkRhythm({ backgrounds: spread, kinds, brandColors: [GREEN], direction: "bright_friendly" }).issues).toEqual([]);
  });

  it("counts a photo-led band toward the full bands, and asks for one when photos exist and none leads a band", () => {
    // Premium Upscale needs 1 full band: a photo-led band satisfies it with no navy at all.
    const photoLed = ["#fff", "image", "#fff", "#f1f8e8", "#fff", "#1f2937", "#fff", "#f1f8e8", "#1f2937"];
    expect(checkRhythm({ backgrounds: photoLed, kinds, brandColors: [GREEN], direction: "premium_upscale", hasPhotos: true }).issues).toEqual([]);
    // Real photos but not one photo-led band: asked for (its own issue), on top of the pale-rhythm one.
    const asked = checkRhythm({ backgrounds: pale, kinds, brandColors: [GREEN], direction: "bright_friendly", hasPhotos: true }).issues.find((i) => i.id === "design.photoBand");
    expect(asked).toBeDefined();
    // CodeRabbit on PR #55: it points the fix round at the bands the message names (the hero), not the pale plan's bands.
    expect(asked!.sections).toEqual([1]);
    // No photos: never asked for.
    expect(checkRhythm({ backgrounds: pale, kinds, brandColors: [GREEN], direction: "bright_friendly" }).issues.map((i) => i.id)).not.toContain("design.photoBand");
  });

  it("the plan never turns a band next to an existing brand band (no code-made slabs)", () => {
    // Band 3 is already brand; the plan may not pick 2 or 4.
    const one = ["#fff", "#f1f8e8", "#fff", GREEN, "#fff", "#f1f8e8", "#fff", "#f1f8e8", "#1f2937"];
    const { plan } = checkRhythm({ backgrounds: one, kinds, brandColors: [GREEN], direction: "bright_friendly" });
    expect(plan).not.toContain(2);
    expect(plan).not.toContain(4);
    // And applying the plan never produces a flat run.
    const after = one.map((bg, i) => (plan.includes(i) ? GREEN : bg));
    expect(checkRhythm({ backgrounds: after, kinds, brandColors: [GREEN], direction: "bright_friendly" }).issues.map((i) => i.id)).not.toContain("design.colourRhythm.flatRun");
  });

  it("tells the builder a photo band counts and bans back-to-back full-colour bands", () => {
    expect(rhythmRule("bright_friendly")).toContain("full-bleed photograph counts");
    expect(rhythmRule("bright_friendly")).toContain("Never two full brand-colour bands in a row");
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

const band = (bg: string, heading: string) => `<section style="background:${bg};padding:80px 40px"><h2>${heading}</h2><p>Some words about this part of the page.</p></section>`;
const harbor = (style = "") => `<!doctype html><html><head><title>Harbor</title><style>body{margin:0;font-family:sans-serif;color:#1d2a12}${style}</style></head><body>
<header style="background:#fff;padding:20px"><a href="tel:9165550142">(916) 555-0142</a></header>
<main>
<section class="hero" style="background:#f1f8e8;padding:80px 40px"><h1>Pest control in Sacramento</h1><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Technician" width="200" height="100"></section>
${band("#ffffff", "Our services")}
${band("#f1f8e8", "Signs you may need pest control")}
${band("#ffffff", "What sets us apart?")}
${band("#f1f8e8", "How it works")}
${band("#ffffff", "Areas we serve")}
${band("#f1f8e8", "Get a free inspection")}
</main>
<footer style="background:#1f2937;color:#fff;padding:40px">Harbor Pest Control</footer>
</body></html>`;

describe.skipIf(!hasChrome)("the colour rhythm on a rendered page", () => {
  it("measures Harbor's pale page, and code's brand bands pass it", async () => {
    const rhythm = { brandColors: [GREEN], direction: "bright_friendly" };
    const before = await runRenderedChecks(browser, harbor(), { rhythm });
    const issue = before.find((i) => i.id === "design.colourRhythm");
    expect(issue?.sections?.length).toBeGreaterThanOrEqual(3);

    const marked = markBrandBands(harbor(brandBandRule(GREEN)), issue!.sections!);
    const after = await runRenderedChecks(browser, marked, { rhythm });
    expect(after.find((i) => i.id === "design.colourRhythm")).toBeUndefined();
  }, 60_000);

  // CodeRabbit on PR #55: a photo hero under a gradient scrim (the usual pattern) must read as a
  // photo band — before the fix, colourOf returned the gradient stop and design.photoBand fired.
  it("a gradient scrim over a photo still reads as a photo-led band", async () => {
    const gif = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
    const html = `<!doctype html><html><head><title>t</title></head><body style="margin:0">
<header style="background:#fff;padding:20px">h</header>
<main>
<section class="hero" style="background:linear-gradient(rgba(0,0,0,.45),rgba(0,0,0,.45)),url(${gif});background-size:cover;padding:80px 40px"><h1 style="color:#fff">Pest control in Sacramento</h1></section>
${band("#ffffff", "Our services")}
${band("#f1f8e8", "Why us")}
${band(GREEN, "Get a free inspection")}
</main>
<footer style="background:#1f2937;color:#fff;padding:40px">f</footer>
</body></html>`;
    const issues = await runRenderedChecks(browser, html, { rhythm: { brandColors: [GREEN], direction: "premium_upscale", hasPhotos: true } });
    expect(issues.find((i) => i.id === "design.photoBand")).toBeUndefined();
    expect(issues.find((i) => i.id === "design.colourRhythm")).toBeUndefined();
  }, 60_000);
});
