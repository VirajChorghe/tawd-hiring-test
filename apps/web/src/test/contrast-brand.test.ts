import fs from "node:fs";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyElementFindings, numberElements, replaceFixStyle } from "@tawd/core/mockups";
import { computeRenderedFixes } from "../../../worker/src/rendered-fixes";

/*
  F31 (a client's site, 9 November 2026): the contrast fixer took text that could
  not be read and gave it a darker shade of the colour it already had -
  keeping its hue, which is right only when the hue was right. The page's
  text was an off-brand purple, so it came out a darker off-brand purple,
  written with !important. The Creative Director said the purple was not the
  brand; the builder could not act on that, the score did not move, and the
  round was paid for.

  Now a colour that belongs to the client - one of the brand's, or a neutral
  - still keeps its hue, and one that belongs to neither is replaced by a
  brand colour that passes (or plain near-black/white) and reported as a run
  note.
*/

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const hasChrome = fs.existsSync(CHROME);
const require = createRequire(import.meta.url);
let browser: Parameters<typeof computeRenderedFixes>[0];

beforeAll(async () => {
  if (!hasChrome) return;
  const { chromium } = require("../../../worker/node_modules/playwright-core");
  browser = await chromium.launch({ executablePath: CHROME });
});
afterAll(async () => {
  await browser?.close();
});

const GREEN = "#8dc63f";

/* One paragraph of unreadable text on white, in whatever colour the test names. */
const page = (color: string) =>
  numberElements(
    `<!doctype html><html><head><title>T</title></head><body style="background:#ffffff;margin:0">
<p style="color:${color};font-size:16px">Carson City plumbers, open all hours, every day of the year.</p>
</body></html>`,
  );

/* The hue of a hex colour, 0-1, so a test can say "still green" without naming an exact shade. */
const hueOf = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return null;
  const d = max - min;
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h / 6;
};
const gap = (a: number, b: number) => {
  const d = Math.abs(a - b) % 1;
  return Math.min(d, 1 - d);
};

describe.skipIf(!hasChrome)("the contrast fixer and the brand's colours", () => {
  it("replaces an off-brand colour instead of darkening it, and says so", async () => {
    // A pale lilac on white: unreadable, and nowhere near the brand's green.
    const fixes = await computeRenderedFixes(browser, page("#c9a7e8"), [GREEN]);
    expect(fixes.contrast).toHaveLength(1);
    const fix = fixes.contrast[0]!;
    expect(fix.offBrand).toBe(true);
    expect(fix.from).toBe("#c9a7e8");
    // The new colour is the brand's hue, not a darker lilac.
    expect(gap(hueOf(fix.color)!, hueOf(GREEN)!)).toBeLessThan(20 / 360);

    const note = fixes.notes[0]!;
    expect(note.step).toBe("contrast");
    expect(note.action).toBe("substituted");
    expect(note.what).toContain("#c9a7e8");
    expect(note.with).toBe(fix.color);
    expect(note.why).toContain("not one of the brand's");
  });

  /*
    EVERY colour code changes is reported now, not only the off-brand ones
    (Jason's run, 10 November 2026). A fix that kept the hue made no note at
    all, so the Creative Director saw grey step titles and a washed-out
    strip title with no explanation and told the builder to "remove
    tawd-fix-24 to -29" - code rules with !important, which the builder
    cannot remove. That round was paid for and the score could not move.
  */
  it("keeps the brand's own hue when the colour was the brand's all along, and still says what it did", async () => {
    // Too pale to read, but the right colour: darkening it is the right fix.
    const fixes = await computeRenderedFixes(browser, page("#d8edb8"), [GREEN]);
    expect(fixes.contrast).toHaveLength(1);
    expect(fixes.contrast[0]!.offBrand).toBeUndefined();
    expect(gap(hueOf(fixes.contrast[0]!.color)!, hueOf(GREEN)!)).toBeLessThan(20 / 360);
    expect(fixes.notes).toHaveLength(1);
    expect(fixes.notes[0]!.what).toContain("#d8edb8");
    expect(fixes.notes[0]!.why).toContain("moved lighter or darker");
  });

  it("leaves a grey grey: a colour with no hue cannot be the wrong hue", async () => {
    const fixes = await computeRenderedFixes(browser, page("#c4c4c4"), [GREEN]);
    expect(fixes.contrast).toHaveLength(1);
    expect(fixes.contrast[0]!.offBrand).toBeUndefined();
    expect(fixes.contrast[0]!.colourless).toBeUndefined();
    expect(hueOf(fixes.contrast[0]!.color)).toBeNull();
    expect(fixes.notes).toHaveLength(1);
    expect(fixes.notes[0]!.why).toContain("moved lighter or darker");
  });

  it("judges nothing when the project has no brand colours", async () => {
    const fixes = await computeRenderedFixes(browser, page("#c9a7e8"), []);
    expect(fixes.contrast).toHaveLength(1);
    expect(fixes.contrast[0]!.offBrand).toBeUndefined();
    expect(fixes.notes).toHaveLength(1);
  });

  /*
    White text inside a white card (Clear Sky Awning's quote form).

    White is a neutral, so it went through "the colour belongs to the
    client", kept its hue, and walked down the greys until it passed:
    #737373 on five form labels and on six process-step titles. Nobody
    designed a grey label. The Creative Director asked for the navy the
    headings use, and scored Ready to send 2 of 5 for the hand work.
  */
  it("gives plain white a brand colour, not a grey nobody chose", async () => {
    const fixes = await computeRenderedFixes(browser, page("#ffffff"), [GREEN]);
    expect(fixes.contrast).toHaveLength(1);
    const fix = fixes.contrast[0]!;
    expect(fix.colourless).toBe(true);
    expect(gap(hueOf(fix.color)!, hueOf(GREEN)!)).toBeLessThan(20 / 360);
    /*
      The note says what the code actually does, including the fallback:
      a colour the client owns where one works on that background, else
      plain near-black or near-white. Check 2 of the review standard found
      the first wording promising a brand colour the code might not use.
    */
    expect(fixes.notes[0]!.why).toContain("a colour the client owns where one works here");
    expect(fixes.notes[0]!.why).toContain("plain near-black or near-white");
  });

  it("gives plain black on a dark band a brand colour too", async () => {
    const dark = numberElements(
      `<!doctype html><html><head><title>T</title></head><body style="background:#111111;margin:0">
<p style="color:#000000;font-size:16px">Carson City plumbers, open all hours, every day of the year.</p>
</body></html>`,
    );
    const fixes = await computeRenderedFixes(browser, dark, [GREEN]);
    expect(fixes.contrast).toHaveLength(1);
    expect(fixes.contrast[0]!.colourless).toBe(true);
    expect(gap(hueOf(fixes.contrast[0]!.color)!, hueOf(GREEN)!)).toBeLessThan(20 / 360);
  });

  /*
    The fault itself: a fix that never reached the page.

    TAWD wrote "html body .tawd-fix-N", specificity (0,1,2), against the
    page's own ".band-brand .form-card label{color:#fff!important}" at
    (0,2,1). The page won, the labels stayed white on white, and two paid
    fix rounds re-fixed text that never changed while every report said the
    contrast had been fixed.
  */
  const formCard = () =>
    numberElements(
      `<!doctype html><html><head><title>T</title><style>
.band-brand{background:#12305a}
.form-card{background:#ffffff;padding:24px}
.band-brand .form-card label{color:#ffffff !important;font-size:15px}
</style></head><body style="margin:0">
<section class="band-brand"><div class="form-card"><label for="n">Your name</label><input id="n"></div></section>
</body></html>`,
    );

  it("writes a rule that beats the page's own, so the label actually changes", async () => {
    const first = await computeRenderedFixes(browser, formCard(), [GREEN]);
    expect(first.contrast).toHaveLength(1);
    const applied = applyElementFindings(formCard(), { contrast: first.contrast, logos: [] });
    // The page as TAWD stores it after the fix, measured again: nothing left to fix.
    const after = await computeRenderedFixes(browser, replaceFixStyle(applied.html, applied.rules.join("\n")), [GREEN]);
    expect(after.contrast).toEqual([]);
  });

  it("says which of the page's own rules is fighting the fix, and writes a stronger one", async () => {
    /*
      Round two: the page already carries TAWD's fix, and a three-class rule
      of the page's own still beats it. The note names that rule, because
      the builder can remove it - and cannot remove TAWD's.
    */
    const round2 = numberElements(
      `<!doctype html><html><head><title>T</title><style>
.band-brand{background:#12305a}
.card{background:#ffffff;padding:24px}
.band-brand .card label.white{color:#ffffff !important;font-size:15px}
html body .tawd-fix-1.tawd-fix-1{color:#112e56 !important}</style></head><body style="margin:0">
<section class="band-brand"><div class="card"><label class="white tawd-fix-1" for="n">Your name</label><input id="n"></div></section>
</body></html>`,
    );
    const fixes = await computeRenderedFixes(browser, round2, [GREEN]);
    expect(fixes.contrast).toHaveLength(1);
    expect(fixes.contrast[0]!.overridden).toBe(true);
    expect(fixes.contrast[0]!.fighting).toBe(".band-brand .card label.white");
    const told = fixes.notes.find((note) => note.what.includes(".band-brand .card label.white"));
    expect(told, "the run notes never named the page's own rule").toBeTruthy();
    expect(told!.why).toContain("Remove it from the page's CSS");
  });

  it("never tells the builder to remove a rule of TAWD's own", async () => {
    /*
      The colour-rhythm step writes ".tawd-band-brand{background-color:...
      !important;color:#fff !important}" into TAWD's own fix block. Name
      that to the builder and the note becomes the very instruction nobody
      can carry out that run notes exist to replace - a code rule, with
      !important, that the builder cannot remove.

      The band here is forced light by an inline !important background,
      which beats a stylesheet rule, so TAWD's own white text sits on white
      and fails. The element itself matches ".tawd-band-brand", which is
      what makes this the case that needs the guard: a rule of TAWD's that
      matches the failing element directly and is not one of the
      "tawd-fix-N" rules the selector test already skips.

      Watched failing with the guard removed: `fighting` came back
      ".tawd-band-brand".
    */
    const ours = numberElements(
      `<!doctype html><html><head><title>T</title><style data-tawd-fixes>
.tawd-band-brand{background-color:#12305a !important;color:#ffffff !important}</style></head><body style="margin:0">
<section class="tawd-band-brand tawd-fix-1" style="background:#ffffff !important;padding:24px">Carson City plumbers, open all hours, every day of the year.</section>
</body></html>`,
    );
    const fixes = await computeRenderedFixes(browser, ours, [GREEN]);
    expect(fixes.contrast).toHaveLength(1);
    // Recorded as a fix that did not take - that part is true, and worth saying.
    expect(fixes.contrast[0]!.overridden).toBe(true);
    // But no rule of TAWD's own is ever named as the one to remove.
    expect(fixes.contrast[0]!.fighting).toBeUndefined();
    const told = fixes.notes.find((note) => note.action === "changed");
    expect(told!.what).not.toContain("tawd-band-brand");
    expect(told!.why).toContain("overriding the fix");
  });

  /*
    Lines nobody can see (Clear Sky Awning's articles band, 10 November
    2026): a 1px rule above each post, drawn white on white, so the three
    posts ran together as bare text.
  */
  const withLine = (css: string, markup: string) =>
    numberElements(
      `<!doctype html><html><head><title>T</title><style>body{background:#ffffff;margin:0}${css}</style></head>
<body><section style="padding:24px">${markup}</section></body></html>`,
    );

  it("colours a line drawn in the background's own colour", async () => {
    const fixes = await computeRenderedFixes(
      browser,
      withLine(".post{border-top:1px solid #ffffff;padding-top:16px;width:400px}", `<div class="post"><h3>Aluminium or wood?</h3></div>`),
      [GREEN],
    );
    expect(fixes.edges).toHaveLength(1);
    expect(fixes.edges![0]!.side).toBe("top");
    expect(fixes.edges![0]!.from).toBe("#ffffff");
    expect(gap(hueOf(fixes.edges![0]!.color)!, hueOf(GREEN)!)).toBeLessThan(20 / 360);
    expect(fixes.fixed).toContain("invisible lines");
    const note = fixes.notes.find((n) => n.step === "lines");
    expect(note!.what).toContain("top line");
    expect(note!.why).toContain("nobody could see it");
  });

  it("leaves a quiet divider somebody chose, and a whole box, alone", async () => {
    // #eeeeee on white is 1.13 to 1: subtle on purpose, and above the 1.1 line.
    const quiet = await computeRenderedFixes(
      browser,
      withLine(".post{border-top:1px solid #eeeeee;padding-top:16px;width:400px}", `<div class="post"><h3>Guides</h3></div>`),
      [GREEN],
    );
    expect(quiet.edges).toEqual([]);

    // Four sides is a box, not a line: a white-bordered card on white is a shape, and not this check's business.
    const box = await computeRenderedFixes(
      browser,
      withLine(".card{border:1px solid #ffffff;padding:16px;width:400px}", `<div class="card"><h3>Guides</h3></div>`),
      [GREEN],
    );
    expect(box.edges).toEqual([]);
  });

  it("leaves a table's faked spacing alone", async () => {
    /*
      A cell with a border the colour of its background is the oldest way
      of faking space between rows, so colouring it would draw a line where
      somebody deliberately drew none - the same reason a link or a button
      is skipped. Found on a second read of this scan, not by a failure.
    */
    const table = await computeRenderedFixes(
      browser,
      withLine(
        "td{border-bottom:4px solid #ffffff;padding:8px}table{border-collapse:separate;width:600px}",
        `<table><tbody><tr><td>Monday to Saturday</td><td>9:00 AM - 5:00 PM</td></tr><tr><td>Sunday</td><td>Closed</td></tr></tbody></table>`,
      ),
      [GREEN],
    );
    expect(table.edges).toEqual([]);
  });

  it("leaves the tab trick alone: a line inside a link or a button", async () => {
    const tab = await computeRenderedFixes(
      browser,
      withLine(".tab{border-bottom:2px solid #ffffff;display:block;width:400px}", `<a class="tab" href="/x">Patio covers</a>`),
      [GREEN],
    );
    expect(tab.edges).toEqual([]);
  });

  it("still makes the text readable when the only brand colour cannot be read here", async () => {
    // The brand colour is white, which can never be read on white: the result is a neutral, not the lilac.
    const fixes = await computeRenderedFixes(browser, page("#c9a7e8"), ["#ffffff"]);
    expect(fixes.contrast).toHaveLength(1);
    expect(fixes.contrast[0]!.offBrand).toBe(true);
    expect(hueOf(fixes.contrast[0]!.color)).toBeNull();
  });

  it("reaches past the white in a brand list to the brand's real colour", async () => {
    // Brand lists usually open with #ffffff; taking it first would turn the text grey when green was there.
    const fixes = await computeRenderedFixes(browser, page("#c9a7e8"), ["#ffffff", GREEN]);
    expect(fixes.contrast[0]!.offBrand).toBe(true);
    expect(gap(hueOf(fixes.contrast[0]!.color)!, hueOf(GREEN)!)).toBeLessThan(20 / 360);
  });
});
