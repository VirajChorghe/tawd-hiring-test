import { describe, expect, it } from "vitest";

import {
  bandsOnImage,
  pictureToPagePercent,
  matchOutcomeDetails,
  matchOutcomes,
  readPageBands,
  STYLES_PART,
  bandAtPin,
  bandsForNote,
  buildSectionEditPrompt,
  markBands,
  outlineBands,
  parseLocateReply,
  parseSectionReplies,
  replaceSections,
  sectionsForIssue,
  splitSections,
  styleSection,
} from "@tawd/core/mockups";

/* A page as its bands, so a fix round edits one band, not the page. */

const page = (body: string) => `<!doctype html><html><head><title>t</title><style>section{}</style></head><body>${body}</body></html>`;

describe("splitting a page into bands", () => {
  it("finds the header, each section and the footer, in order", () => {
    const html = page(`<header><nav><a href="#">Home</a></nav></header>
<section class="hero"><h1>Hi</h1><section class="inner"><p>Nested</p></section></section>
<!-- a comment <section> -->
<section><img src="x" alt="y"><br></section>
<script>const s = "<section>";</script>
<footer><p>Bye</p></footer>`);
    const sections = splitSections(html);
    expect(sections.map((s) => s.tag)).toEqual(["header", "section", "section", "footer"]);
    expect(sections[1]!.html).toBe('<section class="hero"><h1>Hi</h1><section class="inner"><p>Nested</p></section></section>');
    expect(html.slice(sections[3]!.start, sections[3]!.end)).toBe("<footer><p>Bye</p></footer>");
  });

  it("opens up a <main> and a single wrapper", () => {
    expect(splitSections(page("<header></header><main><section>a</section><section>b</section></main><footer></footer>")).map((s) => s.tag)).toEqual([
      "header",
      "section",
      "section",
      "footer",
    ]);
    expect(splitSections(page('<div class="wrap"><header></header><section>a</section><footer></footer></div>')).map((s) => s.tag)).toEqual([
      "header",
      "section",
      "footer",
    ]);
  });

  it("swaps only the bands it is given, leaving the rest byte for byte", () => {
    const html = page("<header>H</header><section>One</section><section>Two</section><footer>F</footer>");
    const sections = splitSections(html);
    const out = replaceSections(html, sections, new Map([[2, "<section>Two, fixed</section>"]]));
    expect(out).toBe(html.replace("<section>Two</section>", "<section>Two, fixed</section>"));
  });
});

describe("finding the band a problem is in", () => {
  const html = page(`<header><a href="tel:+19165550147">(916) 555-0147</a></header>
<section><h1>ABC Plumbers</h1><p>Call (916) 555-9999 today</p></section>
<section><p>Services</p></section>
<section><form><input id="n"></form></section>
<footer>ABC</footer>`);
  const sections = splitSections(html);

  it("uses the evidence the check left, even with markup between the digits", () => {
    expect(sectionsForIssue({ id: "house.phone.invented", severity: "fail", message: "", evidence: "(916) 555-9999" }, sections)).toEqual([1]);
    const split = splitSections(page('<header></header><section><p>Call <b>916</b>-555-9999</p></section>'));
    expect(sectionsForIssue({ id: "house.phone.invented", severity: "fail", message: "", evidence: "916-555-9999" }, split)).toEqual([1]);
  });

  it("follows what the check is about", () => {
    expect(sectionsForIssue({ id: "structure.h1.multiple", severity: "fail", message: "" }, sections)).toEqual([1]);
    expect(sectionsForIssue({ id: "a11y.labels", severity: "fail", message: "" }, sections)).toEqual([3]);
    expect(sectionsForIssue({ id: "images.logo.unused", severity: "fail", message: "" }, sections)).toEqual([0, 4]);
    // A rendered check says where itself.
    expect(sectionsForIssue({ id: "layout.overflow", severity: "fail", message: "", sections: [2] }, sections)).toEqual([2]);
  });

  it("falls back to the header and hero, never the whole page", () => {
    expect(sectionsForIssue({ id: "something.new", severity: "fail", message: "" }, sections)).toEqual([0, 1]);
  });
});

describe("reading the AI's answer", () => {
  it("takes only bands that were asked about, and only markup", () => {
    const reply = `Here you go:
<tawd-section id="1"><section><h1>Fixed</h1></section></tawd-section>
<tawd-section id="3"><section>Not asked</section></tawd-section>
<tawd-section id="2">no markup</tawd-section>`;
    expect([...parseSectionReplies(reply, [1, 2]).entries()]).toEqual([[1, "<section><h1>Fixed</h1></section>"]]);
  });
});

/*
  The improvement round and Request changes edit parts of the page, like
  a fix round: the bands a note or a request is about, and the style sheet
  for a page-wide change.
*/
describe("the parts an edit is about", () => {
  const html = page(`<header id="top"><a href="/">ABC Plumbers</a></header>
<section class="hero"><h1>Plumbing in Sacramento</h1></section>
<section id="services"><h2>Our Services</h2><p>Drains</p></section>
<footer><p>Footer</p></footer>`).replace(
    "</head>",
    `<style data-tawd-fixes>\n.tawd-fix-1 { color: #111 !important; }\n</style>\n<style>body { font-family: serif; } h1 { font-size: 48px; }</style></head>`,
  );
  const bands = splitSections(html);

  it("takes the page's own style sheet, never TAWD's fix block, as the styles part", () => {
    const styles = styleSection(html)!;
    expect(styles.index).toBe(STYLES_PART);
    expect(styles.html).toContain("font-family: serif");
    expect(html.slice(styles.start, styles.end)).toBe(styles.html);
    expect(styleSection("<html><body><p>x</p></body></html>")).toBeNull();
  });

  it("numbers the bands for the reviewer without changing what a band is", () => {
    const marked = markBands(html);
    expect(marked).toContain("<!-- band 0 -->\n<header");
    expect(marked).toContain("<!-- band 3 -->\n<footer");
    expect(splitSections(marked).map((s) => s.html)).toEqual(bands.map((s) => s.html));
  });

  it("places a note by its band, the style sheet for a page-wide note, or its section name", () => {
    expect(bandsForNote({ band: 2, section: "Anything" }, bands)).toEqual([2]);
    expect(bandsForNote({ band: -1, section: "Whole page" }, bands)).toEqual([STYLES_PART]);
    expect(bandsForNote({ band: 9, section: "Footer" }, bands)).toEqual([3]);
    expect(bandsForNote({ section: "Header" }, bands)).toEqual([0]);
    expect(bandsForNote({ band: null, section: "Hero" }, bands)).toEqual([1]);
    expect(bandsForNote({ section: "Services" }, bands)).toEqual([2]);
    expect(bandsForNote({ section: "Our services" }, bands)).toEqual([2]);
    // Nothing clearly named: found by the small call instead.
    expect(bandsForNote({ section: "Trust signals" }, bands)).toBeNull();
  });

  it("outlines the bands in a line each, for the call that finds a request's parts", () => {
    expect(outlineBands(bands).split("\n")).toEqual([
      "0. <header#top> ABC Plumbers",
      "1. <section.hero> Plumbing in Sacramento",
      "2. <section#services> Our Services",
      "3. <footer> Footer",
    ]);
  });

  it("reads which bands the call found, and the styles, ignoring anything that is not a band", () => {
    expect(parseLocateReply("1, 3 and styles", 4)).toEqual([-1, 1, 3]);
    expect(parseLocateReply("Bands 2, 7", 4)).toEqual([2]);
    expect(parseLocateReply("None of them.", 4)).toEqual([]);
  });

  it("puts a pinned comment on the band it sits on", () => {
    const extents = [
      { top: 0, bottom: 10 },
      { top: 10, bottom: 60 },
      { top: 60, bottom: 100 },
    ];
    expect(bandAtPin(3, extents)).toBe(0);
    expect(bandAtPin(10, extents)).toBe(1);
    expect(bandAtPin(99.9, extents)).toBe(2);
    expect(bandAtPin(100, extents)).toBe(2);
    expect(bandAtPin(50, [])).toBeNull();
  });

  it("swaps the style sheet and bands back in, and leaves everything else as it was", () => {
    const styles = styleSection(html)!;
    const replies = parseSectionReplies(
      `<tawd-section id="styles"><style>body { font-family: sans-serif; }</style></tawd-section>\n<tawd-section id="2"><section id="services" class="tawd-fix-1"><h2>Services</h2></section><section><h2>FAQ</h2></section></tawd-section>`,
      [STYLES_PART, 2],
    );
    const out = replaceSections(html, [...bands, styles], replies);
    expect(out).toContain("<style>body { font-family: sans-serif; }</style>");
    expect(out).toContain(".tawd-fix-1 { color: #111 !important; }");
    expect(out).toContain(`<section id="services" class="tawd-fix-1"><h2>Services</h2></section><section><h2>FAQ</h2></section>`);
    expect(out).toContain(bands[0]!.html);
    expect(out).toContain(bands[1]!.html);
    expect(out).toContain(bands[3]!.html);
  });

  it("asks for only the changed parts, and explains the style sheet only when it is sent", () => {
    const base = {
      kind: "improve" as const,
      clientName: "ABC Plumbers",
      directionLabel: "Classic Trust",
      request: "# Creative Director notes\n\n- Bigger headline",
      factsKnown: "- Phone number: (916) 555-0100",
    };
    const bandsOnly = buildSectionEditPrompt({ ...base, sections: [{ index: 1, html: bands[1]!.html }] });
    expect(bandsOnly).toContain("The Creative Director reviewed it");
    expect(bandsOnly).toContain(`<tawd-section id="1">`);
    expect(bandsOnly).toContain("Reply with only the parts you changed");
    expect(bandsOnly).toContain("Keep every class that starts with tawd-");
    expect(bandsOnly).not.toContain("style sheet");
    expect(bandsOnly).not.toContain("<footer>");

    const withStyles = buildSectionEditPrompt({
      ...base,
      kind: "changes",
      sections: [{ index: STYLES_PART, html: styleSection(html)!.html }],
    });
    expect(withStyles).toContain("The team asked for the changes below.");
    expect(withStyles).toContain(`<tawd-section id="styles">`);
    expect(withStyles).toContain("The page's style sheet is included");
  });
});

describe("bands kept with a version, and Done or Not done (2 October 2026)", () => {
  it("places bands on the picture in percent, stopping at the picture's height", () => {
    const bands = [
      { top: 0, bottom: 600, label: "Header" },
      { top: 600, bottom: 13_000, label: "Long" },
      { top: 13_000, bottom: 14_000, label: "Below the cap" },
    ];
    expect(bandsOnImage(bands, 12_000)).toEqual([
      { index: 0, top: 0, bottom: 5, label: "Header" },
      { index: 1, top: 5, bottom: 100, label: "Long" },
    ]);
    expect(bandsOnImage(bands, 0)).toEqual([]);
  });

  it("reads bands from a version's checks, and none from an older version", () => {
    expect(readPageBands({ heightPx: 3000, imageHeightPx: 3000, bands: [{ top: 0, bottom: 10, label: "Header" }, { nope: 1 }] })).toEqual({
      bands: [{ top: 0, bottom: 10, label: "Header" }],
      imageHeight: 3000,
    });
    expect(readPageBands({ passed: true })).toEqual({ bands: [], imageHeight: 0 });
    expect(readPageBands(null)).toEqual({ bands: [], imageHeight: 0 });
  });

  it("matches the Creative Director's answers to the requests by their label, then by words, never by position", () => {
    const requested = [
      { question: "Comment 1", note: "Use the brand blue." },
      { question: "Comment 2", note: "Bigger phone number in the header" },
      { question: "Comment 3", note: "Warmer photos" },
    ];
    // Out of order, one quoted in full inside a longer note.
    expect(
      matchOutcomes(requested, [
        { note: "Warmer photos", addressed: false },
        { note: "Comment 2: Bigger phone number in the header", addressed: true },
        { note: "use the brand blue", addressed: true },
      ]),
    ).toEqual([true, true, false]);
    // Reworded and reordered, but labelled (8 October 2026): by the label, with the reason.
    expect(
      matchOutcomeDetails(requested, [
        { ref: "Comment 3", note: "Photos", addressed: true, reason: "The hero photo is warmer." },
        { ref: "Comment 1", note: "Blue", addressed: true, reason: "Buttons and bands use #1F4E79." },
        { ref: "Comment 2", note: "Phone", addressed: false, reason: "The header's number is still 16px." },
      ]),
    ).toEqual([
      { addressed: true, reason: "Buttons and bands use #1F4E79." },
      { addressed: false, reason: "The header's number is still 16px." },
      { addressed: true, reason: "The hero photo is warmer." },
    ]);
    // Reworded with no label: never guessed by position any more (an answer could land on the wrong comment).
    expect(
      matchOutcomes(requested, [
        { note: "Blue", addressed: true },
        { note: "Phone", addressed: false },
        { note: "Photos", addressed: true },
      ]),
    ).toEqual([null, null, null]);
  });
});

describe("pages taller than the picture (Fable's A7, 3 October 2026)", () => {
  it("turns a point down the picture into a point down the whole page, and reads an older version's picture height", () => {
    expect(pictureToPagePercent(50, { heightPx: 24_000, truncated: true })).toBe(25);
    expect(pictureToPagePercent(50, { heightPx: 3_000, truncated: false })).toBe(50);
    expect(pictureToPagePercent(50, null)).toBe(50);
    expect(readPageBands({ heightPx: 24_000, truncated: true, bands: [] }).imageHeight).toBe(12_000);
    expect(readPageBands({ heightPx: 3_000, truncated: false, bands: [] }).imageHeight).toBe(3_000);
  });
});
