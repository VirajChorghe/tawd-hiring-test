import { describe, expect, it } from "vitest";

import {
  DESCRIPTION_LIMIT,
  MOBILE_TAP_TARGET_CSS,
  TITLE_LIMIT,
  applyElementFindings,
  elementClasses,
  existingFixRules,
  keepLiveRules,
  numberElements,
  setElementClasses,
  findClaimIssues,
  fixTitleAndDescription,
  replaceFixStyle,
  ruleSelector,
  ruleTarget,
  runHtmlChecks,
  shortenAt,
  shortenTitle,
} from "@tawd/core/mockups";
import { CODE_FIXABLE } from "../../../worker/src/pipeline";

/*
  Fixes by code, before any AI: free, exact and repeatable. After them the
  checks must pass for what they fixed.
*/

const page = (head: string, body = "<h1>ABC Plumbers in Sacramento</h1>") =>
  `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;

const facts = { phones: [], licenseNumbers: [], yearFounded: null, businessName: "ABC Plumbers", cities: [] };

describe("shortening text", () => {
  it("keeps whole sentences when they fit, otherwise whole words", () => {
    const text = "Burst pipe or no hot water? Call ABC Plumbers, open around the clock across Sacramento. We fix it the same day, and we tell you the price first.";
    const short = shortenAt(text, 100);
    expect(short).toBe("Burst pipe or no hot water? Call ABC Plumbers, open around the clock across Sacramento.");

    const words = shortenAt("One two three four five six seven eight nine ten eleven twelve", 30);
    expect(words.length).toBeLessThanOrEqual(30);
    expect(words).toBe("One two three four five six");
  });

  it("shortens a title by dropping trailing parts first", () => {
    expect(shortenTitle("ABC Plumbers | 24/7 Emergency Plumbing | Sacramento, Elk Grove and Folsom")).toBe(
      "ABC Plumbers | 24/7 Emergency Plumbing",
    );
    const long = "ABC Plumbers emergency plumbing drain cleaning water heaters and repiping in Sacramento";
    expect(shortenTitle(long).length).toBeLessThanOrEqual(TITLE_LIMIT);
  });
});

describe("fixing the title and meta description", () => {
  it("brings a long title and description under the limit, and the checks then pass", () => {
    const html = page(
      `<title>ABC Plumbers | 24/7 Emergency Plumbing | Sacramento, Elk Grove and Folsom</title><meta name="description" content="ABC Plumbers fixes burst pipes, blocked drains and broken water heaters across Sacramento. Call any time, day or night, and a licensed plumber is on the way. We give the price before we start, every time.">`,
    );
    const before = runHtmlChecks(html, facts).issues;
    const result = fixTitleAndDescription(html, before);
    expect(result.fixed).toEqual(["title length", "description length"]);

    const after = runHtmlChecks(result.html, facts).issues.map((i) => i.id);
    expect(after).not.toContain("seo.title.long");
    expect(after).not.toContain("seo.description.long");
    const description = /content="([^"]*)"/.exec(result.html)![1]!;
    expect(description.length).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
    expect(description.endsWith(".")).toBe(true);
  });

  it("writes a missing description from the headline and the first real paragraph", () => {
    const html = page(
      "<title>ABC Plumbers</title>",
      "<h1>Emergency plumbing in Sacramento</h1><p>Short.</p><p>Burst pipe or no hot water? ABC Plumbers answers day and night and gives the price before starting.</p>",
    );
    const result = fixTitleAndDescription(html, runHtmlChecks(html, facts).issues);
    expect(result.fixed).toEqual(["missing description"]);
    expect(result.html).toContain(
      '<meta name="description" content="Emergency plumbing in Sacramento. Burst pipe or no hot water? ABC Plumbers answers day and night and gives the price before starting.">',
    );
  });

  /*
    CodeRabbit on PR #75 (12 November 2026): a claim found only in the meta
    description had no repair path. The AI fix round is handed the page's
    bands and never the head, so the claim survived every paid round. Code
    now takes the sentence out, and the guard then finds nothing.
  */
  describe("a claim in the meta description", () => {
    const NONE = { guarantees: "", currentOffers: "", financingAvailable: false };
    const body = "<h1>Patio covers in Fair Oaks</h1><p>Custom aluminium patio covers, designed and built for your backyard in Fair Oaks.</p>";

    it("is taken out by code, the rest of the description kept exactly, and the guard then passes", () => {
      const html = page('<title>Patio covers</title><meta name="description" content="Family owned since 1970. Custom patio covers in Fair Oaks &amp; Carmichael, built for shade.">', body);
      const issues = findClaimIssues(html, NONE);
      expect(issues.map((i) => i.id)).toContain("house.claim.unsupported");
      // The pipeline runs the code fixes for it, rather than going straight to a paid round.
      expect(CODE_FIXABLE.has("house.claim.unsupported")).toBe(true);
      const result = fixTitleAndDescription(html, issues);
      expect(result.html).toContain('<meta name="description" content="Custom patio covers in Fair Oaks &amp; Carmichael, built for shade.">');
      expect(result.fixed).toEqual(["a sentence with a flagged claim taken out of the meta description"]);
      expect(findClaimIssues(result.html, NONE)).toEqual([]);
      // Run again on its own output: nothing more to do.
      expect(fixTitleAndDescription(result.html, findClaimIssues(result.html, NONE))).toEqual({ html: result.html, fixed: [] });
    });

    it("writes a new description from the page when the claim was all of it", () => {
      const html = page('<title>Patio covers</title><meta name="description" content="The best patio covers in Fair Oaks!">', body);
      const result = fixTitleAndDescription(html, findClaimIssues(html, NONE));
      expect(result.fixed).toEqual(["a sentence with a flagged claim taken out of the meta description", "missing description"]);
      expect(result.html).toContain('<meta name="description" content="Patio covers in Fair Oaks. Custom aluminium patio covers, designed and built for your backyard in Fair Oaks.">');
      expect(findClaimIssues(result.html, NONE)).toEqual([]);
    });

    it("keeps a hostile kept sentence as it was, with nothing escaping the attribute", () => {
      const html = page(`<title>Patio covers</title><meta name="description" content='Family owned. Covers from $&amp; "up" - $1 a day.'>`, body);
      const result = fixTitleAndDescription(html, findClaimIssues(html, NONE));
      expect(result.html).toContain('<meta name="description" content="Covers from $&amp; &quot;up&quot; - $1 a day.">');
    });

    it("leaves the description alone when the claim is only in the page's copy", () => {
      const html = page('<title>Patio covers</title><meta name="description" content="Custom patio covers in Fair Oaks, built for shade.">', `${body}<p>A family owned business.</p>`);
      const issues = findClaimIssues(html, NONE);
      expect(issues.map((i) => i.id)).toContain("house.claim.unsupported");
      expect(fixTitleAndDescription(html, issues)).toEqual({ html, fixed: [] });
    });
  });

  it("leaves a page with nothing to fix untouched", () => {
    const html = page('<title>ABC Plumbers</title><meta name="description" content="Plumbers in Sacramento, day and night, with the price given before any work starts.">');
    const result = fixTitleAndDescription(html, runHtmlChecks(html, facts).issues);
    expect(result).toEqual({ html, fixed: [] });
  });
});

describe("the fix style block", () => {
  it("is one marked block that replaces itself, so fixes never stack", () => {
    const html = page("<title>t</title>");
    const once = replaceFixStyle(html, `body > p:nth-child(2) { color: #333 !important; }\n${MOBILE_TAP_TARGET_CSS}`);
    const twice = replaceFixStyle(once, existingFixRules(once).join("\n"));
    expect(twice).toBe(once);
    expect(once.match(/data-tawd-fixes/g)).toHaveLength(1);
    expect(existingFixRules(once)).toHaveLength(2);
    // Mobile only: the desktop mockup looks exactly as built.
    expect(MOBILE_TAP_TARGET_CSS).toMatch(/^@media \(max-width: 767px\)/);
  });
});

/*
  Fixes the browser works out land on the element itself, as a class, so
  they move with it when the layout or a section changes.
*/
describe("aiming a fix at an element by class", () => {
  const source = `<!doctype html><html><head><title>t</title><style>p > a { color: red }</style><script>if (a < b) { x = "<p>" }</script></head>
<body><!-- <p>not an element</p> --><header><img src="tawd-asset:logo" alt="ABC"></header><p class='lead big'>Hello</p><p>Bye</p></body></html>`;

  it("numbers every real opening tag, skipping comments and the insides of script and style", () => {
    const numbered = numberElements(source);
    const numbers = [...numbered.matchAll(/<(\w+) data-tawd-n="(\d+)"/g)].map((m) => `${m[1]}${m[2]}`);
    expect(numbers).toEqual(["html0", "head1", "title2", "style3", "script4", "body5", "header6", "img7", "p8", "p9"]);
    expect(numbered).toContain(`x = "<p>"`);
    expect(numbered).toContain("<!-- <p>not an element</p> -->");
  });

  it("adds a class to the numbered element only, keeping the classes it had", () => {
    const out = setElementClasses(source, new Map([[8, { add: "tawd-fix-1" }]]));
    expect(out).toContain(`<p class="lead big tawd-fix-1">Hello</p><p>Bye</p>`);
    expect(out.replace(`class="lead big tawd-fix-1"`, "class='lead big'")).toBe(source);
    expect(elementClasses(out, 8)).toEqual(["lead", "big", "tawd-fix-1"]);
  });

  it("gives each recolored element its own class, and reuses it when fixed again", () => {
    const first = applyElementFindings(source, { contrast: [{ n: 8, color: "#111111" }, { n: 9, color: "#222222" }], logos: [] });
    expect(first.html).toContain(`<p class="lead big tawd-fix-1">`);
    expect(first.html).toContain(`<p class="tawd-fix-2">Bye`);
    /*
      The class is written twice (10 November 2026). "html body .tawd-fix-N"
      is specificity (0,1,2), and a client's page had ".band-brand
      .form-card label{color:#fff!important}" at (0,2,1), so the page's own
      rule won and five form labels shipped white on a white card.
    */
    expect(first.rules).toEqual([
      "html body .tawd-fix-1.tawd-fix-1 { color: #111111 !important; }",
      "html body .tawd-fix-2.tawd-fix-2 { color: #222222 !important; }",
    ]);
    const again = applyElementFindings(first.html, { contrast: [{ n: 9, color: "#000000" }], logos: [] });
    expect(again.html).toBe(first.html);
    expect(again.rules).toEqual(["html body .tawd-fix-2.tawd-fix-2 { color: #000000 !important; }"]);
  });

  /*
    What happens on the SECOND run, which is where this nearly went wrong
    (rule 2 of docs/CODE-REVIEW-STANDARD.md). A page carries its fix rules
    with it, so the rule written today meets the rule written yesterday.
  */
  it("writes a stronger rule when the page's own CSS beat the last one", () => {
    const html = numberElements(`<html><head></head><body><p class="lead tawd-fix-1">Hi</p></body></html>`);
    const applied = applyElementFindings(html, { contrast: [{ n: 3, color: "#111111", overridden: true }], logos: [] });
    expect(applied.rules).toEqual(["html body .tawd-fix-1.tawd-fix-1.tawd-fix-1 { color: #111111 !important; }"]);
    // The class is not added twice to the element itself.
    expect(elementClasses(applied.html, 3)).toEqual(["lead", "tawd-fix-1"]);
  });

  it("replaces the rule it wrote last time instead of leaving both", () => {
    const weak = "html body .tawd-fix-1 { color: #999999 !important; }";
    const strong = "html body .tawd-fix-1.tawd-fix-1 { color: #111111 !important; }";
    const stronger = "html body .tawd-fix-1.tawd-fix-1.tawd-fix-1 { color: #111111 !important; }";
    // All three aim at the same element, so a page keeps one of them, not three.
    expect(ruleTarget(weak)).toBe(ruleTarget(strong));
    expect(ruleTarget(strong)).toBe(ruleTarget(stronger));
    expect(ruleTarget(weak)).toBe("html body .tawd-fix-1");
    // And a rule aimed somewhere else keeps its own place.
    expect(ruleTarget("html body .tawd-fix-2.tawd-fix-2 { color: #111 !important; }")).toBe("html body .tawd-fix-2");
    expect(ruleTarget(MOBILE_TAP_TARGET_CSS)).toBe(ruleSelector(MOBILE_TAP_TARGET_CSS));
    /*
      Only a WHOLE class name repeated counts. ".a.ab" is two different
      classes, and collapsing the ".a" inside ".ab" would turn one
      selector into another one.
    */
    expect(ruleTarget("html body .a.ab { color: #111 !important; }")).toBe("html body .a.ab");
    expect(ruleTarget(".tawd-fix-1.tawd-fix-10 { color: #111 !important; }")).toBe(".tawd-fix-1.tawd-fix-10");
  });

  /*
    A line drawn in the colour of the background behind it (a client's
    articles band): its own class, because one element can need both fixes.
  */
  it("colours a line nobody can see, under its own class", () => {
    const html = numberElements(`<html><head></head><body><div class="post">Guides</div></body></html>`);
    const applied = applyElementFindings(html, {
      contrast: [],
      logos: [],
      edges: [{ n: 3, side: "top", color: "#12305a", from: "#ffffff" }],
    });
    expect(applied.rules).toEqual(["html body .tawd-edge-1.tawd-edge-1 { border-top-color: #12305a !important; }"]);
    expect(elementClasses(applied.html, 3)).toEqual(["post", "tawd-edge-1"]);

    // Both fixes on one element: two classes, two rules, and neither loses the other.
    const both = applyElementFindings(html, {
      contrast: [{ n: 3, color: "#111111" }],
      logos: [],
      edges: [{ n: 3, side: "top", color: "#12305a" }],
    });
    expect(elementClasses(both.html, 3)).toEqual(["post", "tawd-fix-1", "tawd-edge-1"]);
    expect(both.rules).toEqual([
      "html body .tawd-fix-1.tawd-fix-1 { color: #111111 !important; }",
      "html body .tawd-edge-1.tawd-edge-1 { border-top-color: #12305a !important; }",
    ]);

    // Run again on its own output: the same classes, not a growing list.
    const twice = applyElementFindings(both.html, {
      contrast: [{ n: 3, color: "#111111" }],
      logos: [],
      edges: [{ n: 3, side: "top", color: "#12305a" }],
    });
    expect(twice.html).toBe(both.html);
    expect(elementClasses(twice.html, 3)).toEqual(["post", "tawd-fix-1", "tawd-edge-1"]);
  });

  it("drops a line's rule when its class has left the page", () => {
    const rule = "html body .tawd-edge-1.tawd-edge-1 { border-top-color: #12305a !important; }";
    expect(keepLiveRules(`<body><div class="post tawd-edge-1">x</div></body>`, [rule])).toEqual([rule]);
    expect(keepLiveRules(`<body><div class="post">x</div></body>`, [rule])).toEqual([]);
  });

  it("marks a logo for its background, and swaps the mark when the background changes", () => {
    const light = applyElementFindings(source, { contrast: [], logos: [{ n: 7, on: "light" }] });
    expect(light.html).toContain(`<img class="tawd-logo-on-light" src="tawd-asset:logo"`);
    expect(light.rules.join("\n")).toContain(".tawd-logo-on-light { filter: brightness(0) !important; }");
    const dark = applyElementFindings(light.html, { contrast: [], logos: [{ n: 7, on: "dark" }] });
    expect(dark.html).toContain(`<img class="tawd-logo-on-dark" src="tawd-asset:logo"`);
    expect(dark.rules.join("\n")).toContain(".tawd-logo-on-dark { filter: brightness(0) invert(1) !important; }");
  });

  it("drops rules aimed by position, and rules whose class has left the page", () => {
    const html = `<html><head></head><body><p class="tawd-fix-2">x</p></body></html>`;
    expect(
      keepLiveRules(html, [
        "body > header:nth-child(1) > img:nth-child(1) { filter: brightness(0) !important; }",
        "html body .tawd-fix-1 { color: #111 !important; }",
        "html body .tawd-fix-2 { color: #222 !important; }",
        "html body .tawd-logo-on-light { filter: brightness(0) !important; }",
        MOBILE_TAP_TARGET_CSS,
      ]),
    ).toEqual(["html body .tawd-fix-2 { color: #222 !important; }", MOBILE_TAP_TARGET_CSS]);
  });
});
