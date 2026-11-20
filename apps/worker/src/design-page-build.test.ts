import { describe, expect, it } from "vitest";

import { buildPlan, type BuiltPage, type ReadForBuild, type SheetEntry } from "@tawd/core/figma/build-spec";

import { pageFromReply, pageProblems } from "./design-page-build";

/*
  E5a: what code finds wrong with a built page the moment it arrives, before
  a browser is opened and before anyone is shown it. Each case below is
  something the paid run of 15 November actually produced and called "done".
*/

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const PAGES: BuiltPage[] = [{ name: "Home", slug: "" }];

const read: ReadForBuild = {
  width: 1400,
  height: 800,
  colours: [],
  bands: [
    {
      band: { name: "Header", role: "header", top: 0, bottom: 136 },
      words: [
        { text: "Home", role: "link", box: box(500, 40, 60, 20) },
        { text: "Services", role: "link", box: box(600, 40, 90, 20) },
      ],
      pictures: [],
      fonts: [],
    },
    {
      band: { name: "Hero", role: "band", top: 136, bottom: 594 },
      words: [
        { text: "Clear water for Northern Nevada", role: "heading", box: box(40, 200, 600, 50) },
        { text: "(775) 238-9814", role: "label", box: box(40, 280, 200, 24) },
      ],
      pictures: [{ id: "a1", kind: "photo", box: box(700, 160, 600, 400) }],
      fonts: [],
    },
    { band: { name: "Footer", role: "footer", top: 594, bottom: 800 }, words: [{ text: "Pat Rivera Pump", role: "paragraph", box: box(40, 700, 300, 20) }], pictures: [], fonts: [] },
  ],
};

const sheet: SheetEntry[] = [{ id: "a1", kind: "photo", box: box(700, 160, 600, 400), file: "p1.png", icon: null, flags: [] }];
const PLAN = buildPlan(read, sheet, PAGES);

const page = (body: string, head = "<style>a{color:red}</style>") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

const GOOD = page(`
  <header><a href="/">Home</a><span class="tawd-no-page">Services</span></header>
  <main>
    <h1>Clear water for Northern Nevada</h1>
    <p>(775) 238-9814</p>
    <img src="p1.png" alt="A well pump">
  </main>
  <footer>Pat Rivera Pump</footer>
`);

describe("a page worth looking at", () => {
  it("finds nothing wrong with one that carries everything the plan asked for", () => {
    expect(pageProblems(GOOD, PLAN)).toEqual([]);
  });
});

describe("a reply that is not a page", () => {
  it("says so and stops there", () => {
    expect(pageProblems("I can help with that! Here is the plan...", PLAN)).toEqual(["The build did not send back a whole web page."]);
  });

  it("takes the page out of a code fence the model added", () => {
    expect(pageFromReply("Here you go:\n\n```html\n<!doctype html><html></html>\n```\n")).toBe("<!doctype html><html></html>");
  });

  it("takes the page out of a reply with words before it and no fence", () => {
    expect(pageFromReply("Sure, here it is.\n<!doctype html><html></html>")).toBe("<!doctype html><html></html>");
  });

  it("leaves a clean page alone", () => {
    expect(pageFromReply("<!doctype html><html></html>")).toBe("<!doctype html><html></html>");
  });
});

/* P-1: the run marked pages done with whole bands blank, and flagged nothing. */
describe("a band with none of its words", () => {
  it("names the band", () => {
    const blank = page(`
      <header><a href="/">Home</a><span>Services</span></header>
      <main><h1>Clear water for Northern Nevada</h1><p>(775) 238-9814</p><img src="p1.png" alt="x"></main>
      <footer></footer>
    `);
    expect(pageProblems(blank, PLAN).join(" ")).toMatch(/A band has none of their words on the page: Footer/);
  });

  it("names each one when several are blank", () => {
    const blank = page(`<header><a href="/">Home</a><span>Services</span></header><main><h1>x</h1><img src="p1.png" alt="x"></main>`);
    const problems = pageProblems(blank, PLAN).join(" ");
    expect(problems).toMatch(/2 bands have none of their words/);
    expect(problems).toMatch(/Hero/);
    expect(problems).toMatch(/Footer/);
  });
});

/* P-4: the five-item menu came out as "HOME". */
describe("a menu item left out", () => {
  it("names it", () => {
    const cut = page(`
      <header><a href="/">Home</a></header>
      <main><h1>Clear water for Northern Nevada</h1><p>(775) 238-9814</p><img src="p1.png" alt="x"></main>
      <footer>Pat Rivera Pump</footer>
    `);
    expect(pageProblems(cut, PLAN).join(" ")).toMatch(/A menu item is missing from the page: "Services"/);
  });
});

/* P-5: the run re-formatted the phone numbers. */
describe("a phone number re-formatted", () => {
  it("is caught even though the digits are all still there", () => {
    // The word check cannot see this: it drops punctuation, so both forms
    // are the same words to it. This is exactly what the paid run did.
    const tidied = GOOD.replace("(775) 238-9814", "775-238-9814");
    expect(pageProblems(tidied, PLAN).join(" ")).toMatch(/re-written into a different shape.*\(775\) 238-9814/);
  });

  it("is caught when only the spacing changed", () => {
    const tidied = GOOD.replace("(775) 238-9814", "(775)238-9814");
    expect(pageProblems(tidied, PLAN).join(" ")).toMatch(/re-written into a different shape/);
  });

  it("does not complain about a number the page simply does not have", () => {
    // That is a missing word, reported as one; it is not a re-formatting.
    const gone = GOOD.replace("<p>(775) 238-9814</p>", "");
    const problems = pageProblems(gone, PLAN).join(" ");
    expect(problems).toMatch(/of the design's words are not on the page/);
    expect(problems).not.toMatch(/re-written into a different shape/);
  });

  it("does not complain when the page carries the number exactly as drawn", () => {
    expect(pageProblems(GOOD, PLAN).join(" ")).not.toMatch(/re-written/);
  });

  it("is reported when the digits themselves change", () => {
    const wrong = GOOD.replace("(775) 238-9814", "(775) 238-0000");
    expect(pageProblems(wrong, PLAN).join(" ")).toMatch(/of the design's words are not on the page/);
  });
});

describe("the pictures and icons", () => {
  it("says when a prepared picture was never placed", () => {
    const noPicture = GOOD.replace('<img src="p1.png" alt="A well pump">', "");
    expect(pageProblems(noPicture, PLAN).join(" ")).toMatch(/A picture was prepared but not placed on the page: picture 1/);
  });

  it("says when a matched icon is missing", () => {
    const withIcon = buildPlan(
      { ...read, bands: read.bands.map((b) => (b.band.name === "Hero" ? { ...b, pictures: [{ id: "i1", kind: "icon" as const, box: box(60, 300, 40, 40) }] } : b)) },
      [{ id: "i1", kind: "icon", box: box(60, 300, 40, 40), file: null, icon: { name: "phone", by: "name" }, flags: [] }],
      PAGES,
    );
    const without = page(`<header><a href="/">Home</a><span>Services</span></header><main><h1>Clear water for Northern Nevada</h1><p>(775) 238-9814</p></main><footer>Pat Rivera Pump</footer>`);
    expect(pageProblems(without, withIcon).join(" ")).toMatch(/An icon is missing from the page: phone/);
    const withIt = without.replace("</main>", '<span data-kit-icon="phone"></span></main>');
    expect(pageProblems(withIt, withIcon).join(" ")).not.toMatch(/icon is missing/);
  });

  it("does not ask for a picture that was never prepared", () => {
    const plan = buildPlan(read, [], PAGES);
    const without = page(`<header><a href="/">Home</a><span>Services</span></header><main><h1>Clear water for Northern Nevada</h1><p>(775) 238-9814</p></main><footer>Pat Rivera Pump</footer>`);
    expect(pageProblems(without, plan).join(" ")).not.toMatch(/not placed on the page/);
  });
});

describe("the shape of the page", () => {
  it("wants exactly one stylesheet", () => {
    expect(pageProblems(page("<h1>x</h1>", ""), PLAN).join(" ")).toMatch(/no stylesheet/);
    expect(pageProblems(page("<h1>x</h1>", "<style>a{}</style><style>b{}</style>"), PLAN).join(" ")).toMatch(/has 2 stylesheets/);
  });

  it("wants exactly one main heading", () => {
    expect(pageProblems(GOOD.replace("<h1>", "<h2>").replace("</h1>", "</h2>"), PLAN).join(" ")).toMatch(/no main heading/);
    expect(pageProblems(GOOD.replace("<footer>", "<footer><h1>again</h1>"), PLAN).join(" ")).toMatch(/has 2 main headings/);
  });

  it("refuses JavaScript", () => {
    expect(pageProblems(GOOD.replace("</body>", "<script>alert(1)</script></body>"), PLAN).join(" ")).toMatch(/has JavaScript in it/);
  });

  it("refuses anything loaded from the internet", () => {
    expect(pageProblems(GOOD.replace('src="p1.png"', 'src="https://example.com/a.png"'), PLAN).join(" ")).toMatch(/loads something from the internet/);
  });

  it("does not count the stylesheet's own text as the page's words", () => {
    const hidden = page(
      `<header><a href="/">Home</a><span>Services</span></header><main><h1>x</h1><img src="p1.png" alt="x"></main>`,
      "<style>/* Clear water for Northern Nevada (775) 238-9814 Pat Rivera Pump */</style>",
    );
    expect(pageProblems(hidden, PLAN).join(" ")).toMatch(/bands have none of their words/);
  });
});

/*
  Fable's review of E5a: the checks were weaker than the Run book claimed,
  and two of them accused a correct page.
*/
describe("what the checks must not get wrong", () => {
  it("counts a band's words run by run, not 'did any of them appear somewhere'", () => {
    // Every run of the Hero present except one. A band is not fine because one line of it showed up.
    const most = page(`
      <header><a href="/">Home</a><span>Services</span></header>
      <main><h1>Clear water for Northern Nevada</h1></main>
      <footer>Pat Rivera Pump</footer>
    `);
    const problems = pageProblems(most, PLAN).join(" ");
    expect(problems).toMatch(/A band is missing some of their words: Hero \(1 of 2 missing\)/);
    expect(problems).not.toMatch(/bands have none of their words/);
  });

  it("reads a character the design's own words contain and the page has to escape", () => {
    // The design draws a curly apostrophe. A page must write it as an entity
    // (or the character); undecoded, "rsquo" lands in the middle of the run
    // and the words either side are reported missing from a correct page.
    const curly = String.fromCodePoint(0x2019);
    const withCurly = buildPlan(
      {
        ...read,
        bands: read.bands.map((b) =>
          b.band.name === "Footer" ? { ...b, words: [{ text: `Nevada${curly}s own water people`, role: "paragraph" as const, box: box(40, 700, 300, 20) }] } : b,
        ),
      },
      sheet,
      PAGES,
    );
    const escaped = page(`
      <header><a href="/">Home</a><span class="tawd-no-page">Services</span></header>
      <main><h1>Clear water for Northern Nevada</h1><p>(775) 238-9814</p><img src="p1.png" alt="x"></main>
      <footer>Nevada&rsquo;s own water people</footer>
    `);
    expect(pageProblems(escaped, withCurly)).toEqual([]);
  });

  it("reads the characters a page actually writes, so they are not counted as missing words", () => {
    const entities = page(`
      <header><a href="/">Home</a><span>Services</span></header>
      <main><h1>Clear water for Northern Nevada</h1><p>(775)&nbsp;238-9814</p><img src="p1.png" alt="x"></main>
      <footer>Pat Rivera Pump &mdash; est.&nbsp;1979 &copy; &rsquo;til today</footer>
    `);
    const problems = pageProblems(entities, PLAN).join(" ");
    // "Pat Rivera Pump" is all there; rsquo/mdash/copy must not turn into words of their own.
    expect(problems).not.toMatch(/rsquo|mdash|copy|nbsp/);
    // Undecoded, "Pat&rsquo;s" breaks the run and the Footer is reported empty.
    expect(problems).not.toMatch(/Footer/);
    expect(problems).not.toMatch(/of the design's words are not on the page/);
  });

  it("allows a link to the client's own Facebook page", () => {
    const social = GOOD.replace("</footer>", '<a href="https://facebook.com/patrivera">Facebook</a></footer>');
    expect(pageProblems(social, PLAN).join(" ")).not.toMatch(/from the internet/);
  });

  it("still refuses a picture, stylesheet or font fetched from elsewhere", () => {
    for (const bad of [
      GOOD.replace('src="p1.png"', 'src="https://example.com/a.png"'),
      GOOD.replace("<style>", '<link rel="stylesheet" href="https://fonts.example.com/x.css"><style>'),
      GOOD.replace("a{color:red}", "@import '//evil.example.com/x.css';a{color:red}"),
      GOOD.replace("a{color:red}", "a{background:url(https://example.com/bg.png)}"),
      GOOD.replace('src="p1.png"', 'src="p1.png" srcset="https://example.com/a2.png 2x"'),
    ]) {
      expect(pageProblems(bad, PLAN).join(" ")).toMatch(/from the internet/);
    }
  });

  it("refuses a page that sends the browser somewhere else on its own", () => {
    const refresh = GOOD.replace("<style>", '<meta http-equiv="refresh" content="0;url=https://example.com"><style>');
    expect(pageProblems(refresh, PLAN).join(" ")).toMatch(/sends the browser somewhere else/);
  });
});
