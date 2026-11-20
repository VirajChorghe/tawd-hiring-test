import { describe, expect, it } from "vitest";

import {
  bandFor,
  buildPlan,
  designSpecFrom,
  drawableText,
  entryFor,
  type BuiltPage,
  type ReadForBuild,
  type SheetEntry,
  type SpecBand,
} from "@tawd/core/figma/build-spec";

/*
  E5a: the plan one build call is given. Everything the builder must not be
  left to decide is decided here, by measurement, and each rule below is a
  thing the paid run of 15 November got wrong.
*/

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

const HEADER: SpecBand = { name: "Header", role: "header", top: 0, bottom: 136 };
const HERO: SpecBand = { name: "Hero", role: "band", top: 136, bottom: 594 };
const FOOTER: SpecBand = { name: "Footer", role: "footer", top: 594, bottom: 800 };

const read = (over: Partial<ReadForBuild> = {}): ReadForBuild => ({
  width: 1400,
  height: 800,
  colours: [{ name: "brand", x: 10, y: 10, hex: "#123456" }],
  bands: [
    { band: HEADER, words: [], pictures: [], fonts: [] },
    { band: HERO, words: [], pictures: [], fonts: [{ role: "heading", family: "Inter" }] },
    { band: FOOTER, words: [], pictures: [], fonts: [] },
  ],
  ...over,
});

const sheet = (over: Partial<SheetEntry> = {}): SheetEntry => ({
  id: "a1",
  kind: "photo",
  box: box(0, 136, 1400, 458),
  file: "p1.png",
  icon: null,
  flags: [],
  ...over,
});

const PAGES: BuiltPage[] = [{ name: "Home", slug: "" }];

describe("which band a thing belongs to", () => {
  const bands = [HEADER, HERO, FOOTER];

  it("puts a thing in the band holding its centre", () => {
    expect(bandFor(bands, box(10, 200, 100, 40))).toEqual({ index: 1, outside: false });
    expect(bandFor(bands, box(10, 10, 100, 40))).toEqual({ index: 0, outside: false });
    expect(bandFor(bands, box(10, 700, 100, 40))).toEqual({ index: 2, outside: false });
  });

  it("decides by the centre, not the top edge, for a thing that straddles two bands", () => {
    // Starts inside the header (0-136) but most of it is in the hero: the hero owns it.
    expect(bandFor(bands, box(10, 120, 100, 80))).toEqual({ index: 1, outside: false });
    // And the other way: starts in the hero, but its middle is down in the footer.
    expect(bandFor(bands, box(10, 560, 100, 120))).toEqual({ index: 2, outside: false });
  });

  it("puts a thing that is in no band in the nearest one, and says it was outside", () => {
    expect(bandFor(bands, box(10, 900, 100, 40))).toEqual({ index: 2, outside: true });
    expect(bandFor(bands, box(10, -100, 100, 40))).toEqual({ index: 0, outside: true });
  });

  it("has no band to offer when the read found none", () => {
    expect(bandFor([], box(0, 0, 10, 10))).toBeNull();
  });
});

describe("the words a band is given", () => {
  it("keeps the order the read gave them", () => {
    const plan = buildPlan(
      read({
        bands: [
          { band: HEADER, words: [], pictures: [], fonts: [] },
          {
            band: HERO,
            words: [
              { text: "read first", role: "paragraph", box: box(400, 300, 100, 20) },
              { text: "read second", role: "heading", box: box(40, 200, 300, 40) },
              { text: "read third", role: "paragraph", box: box(40, 300, 100, 20) },
            ],
            pictures: [],
            fonts: [],
          },
          { band: FOOTER, words: [], pictures: [], fonts: [] },
        ],
      }),
      [],
      PAGES,
    );
    expect(plan.bands[1]!.words.map((w) => w.text)).toEqual(["read first", "read second", "read third"]);
  });

  /*
    A row of cards is the ordinary case, not an awkward one. Sorting the page
    by y and then x splits every row into "all the headings, then all the
    paragraphs", and because the checks compare words in order, a perfectly
    built page would then report half of them missing and E5b's rounds would
    be spent chasing failures that are not there.
  */
  it("keeps a row of three cards as heading, words, heading, words", () => {
    const cards = [
      { text: "Repairs", role: "heading" as const, box: box(50, 200, 200, 40) },
      { text: "We fix pumps", role: "paragraph" as const, box: box(50, 260, 200, 30) },
      { text: "Wells", role: "heading" as const, box: box(450, 200, 200, 40) },
      { text: "We drill wells", role: "paragraph" as const, box: box(450, 260, 200, 30) },
      { text: "Filtration", role: "heading" as const, box: box(850, 200, 200, 40) },
      { text: "We clean water", role: "paragraph" as const, box: box(850, 260, 200, 30) },
    ];
    const want = ["Repairs", "We fix pumps", "Wells", "We drill wells", "Filtration", "We clean water"];
    const plan = buildPlan(
      read({
        bands: [
          { band: HEADER, words: [], pictures: [], fonts: [] },
          { band: HERO, words: cards, pictures: [], fonts: [] },
          { band: FOOTER, words: [], pictures: [], fonts: [] },
        ],
      }),
      [],
      PAGES,
    );
    expect(plan.bands[1]!.words.map((w) => w.text)).toEqual(want);
    expect(designSpecFrom(plan).words.map((w) => w.text)).toEqual(want);
  });

  it("flags words that sit outside every band instead of dropping them", () => {
    const plan = buildPlan(
      read({
        bands: [
          { band: HEADER, words: [], pictures: [], fonts: [] },
          { band: HERO, words: [], pictures: [], fonts: [] },
          { band: FOOTER, words: [{ text: "below everything", role: "paragraph", box: box(40, 1200, 200, 20) }], pictures: [], fonts: [] },
        ],
      }),
      [],
      PAGES,
    );
    expect(plan.bands[2]!.words.map((w) => w.text)).toEqual(["below everything"]);
    expect(plan.flags.join(" ")).toMatch(/outside every band/i);
  });
});

/*
  P-5 of the paid run: the build re-formatted the phone numbers. Text is
  carried exactly as drawn; only what cannot be drawn at all is removed.
*/
describe("the words are copied exactly", () => {
  it("leaves a phone number's own format alone", () => {
    for (const number of ["(775) 238-9814", "775.851.1600", "775 238 9814", "+1 775-238-9814"]) {
      expect(drawableText(number)).toBe(number);
    }
  });

  it("keeps spacing, capitals and punctuation as drawn", () => {
    expect(drawableText("  SERVING   Northern Nevada  ")).toBe("  SERVING   Northern Nevada  ");
    expect(drawableText("Water Filtration & System Design")).toBe("Water Filtration & System Design");
  });

  /*
    A whole emoji is two halves that belong together. Written as code points
    so this file stays plain ASCII and there is no doubt what is being tested.
  */
  it("keeps a whole emoji, which is two halves that belong together", () => {
    const spanner = String.fromCodePoint(0x1f527);
    expect(drawableText(`${spanner} Repairs`)).toBe(`${spanner} Repairs`);
    const phone = String.fromCodePoint(0x260e, 0xfe0f);
    expect(drawableText(`Call us ${phone} today`)).toBe(`Call us ${phone} today`);
  });

  it("removes only what cannot be drawn, and drops a run that is then empty", () => {
    expect(drawableText("Reno\u0000 NV")).toBe("Reno NV");
    expect(drawableText("\ud800")).toBe("");
    expect(drawableText("a\udc00b")).toBe("ab");
    const plan = buildPlan(
      read({
        bands: [
          { band: HEADER, words: [], pictures: [], fonts: [] },
          {
            band: HERO,
            words: [
              { text: "\ud800", role: "paragraph", box: box(40, 200, 10, 10) },
              { text: "kept", role: "paragraph", box: box(40, 300, 10, 10) },
            ],
            pictures: [],
            fonts: [],
          },
          { band: FOOTER, words: [], pictures: [], fonts: [] },
        ],
      }),
      [],
      PAGES,
    );
    expect(plan.bands[1]!.words.map((w) => w.text)).toEqual(["kept"]);
  });
});

/*
  A read's picture ids are only unique within one call, and a tall band is
  read in several (Fable's review of E4b-2b). Matching to the asset sheet
  is by position for that reason.
*/
describe("matching a picture to what was prepared", () => {
  it("matches by position, so two pictures sharing an id get their own files", () => {
    const top = sheet({ id: "b1-icon", box: box(60, 150, 120, 120), file: "p1.png" });
    const low = sheet({ id: "b1-icon", box: box(60, 400, 120, 120), file: "p2.png" });
    expect(entryFor([top, low], { id: "b1-icon", kind: "photo", box: box(60, 400, 120, 120) })?.file).toBe("p2.png");
    expect(entryFor([top, low], { id: "b1-icon", kind: "photo", box: box(60, 150, 120, 120) })?.file).toBe("p1.png");
  });

  it("matches nothing when the overlap is too small", () => {
    expect(entryFor([sheet({ box: box(0, 0, 100, 100) })], { id: "x", kind: "photo", box: box(900, 700, 100, 100) })).toBeNull();
  });

  it("refuses to choose when two prepared pictures sit in exactly the same place", () => {
    const a = sheet({ id: "a", box: box(60, 150, 120, 120), file: "p1.png" });
    const b = sheet({ id: "b", box: box(60, 150, 120, 120), file: "p2.png" });
    expect(entryFor([a, b], { id: "a", kind: "photo", box: box(60, 150, 120, 120) })).toBeNull();
  });
});

describe("a picture the page cannot draw yet", () => {
  const withPicture = (kind: SheetEntry["kind"], entry: SheetEntry | null) =>
    buildPlan(
      read({
        bands: [
          { band: HEADER, words: [], pictures: [], fonts: [] },
          { band: HERO, words: [], pictures: [{ id: "a1", kind, box: box(60, 200, 120, 120) }], fonts: [] },
          { band: FOOTER, words: [], pictures: [], fonts: [] },
        ],
      }),
      entry ? [entry] : [],
      PAGES,
    );

  it("keeps a picture that could not be cut, with no file, and asks for an upload", () => {
    const plan = withPicture("photo", sheet({ box: box(60, 200, 120, 120), file: null }));
    expect(plan.bands[1]!.pictures[0]).toMatchObject({ file: null, kind: "photo" });
    expect(plan.flags.join(" ")).toMatch(/could not be cut out of the design, so its space is left empty/i);
  });

  it("keeps a picture the pictures step never prepared, and says so", () => {
    const plan = withPicture("photo", null);
    expect(plan.bands[1]!.pictures[0]).toMatchObject({ file: null, icon: null });
    expect(plan.flags.join(" ")).toMatch(/read but not prepared/i);
  });

  it("leaves a space for an icon that matched nothing in TAWD's set", () => {
    const plan = withPicture("icon", sheet({ kind: "icon", box: box(60, 200, 120, 120), file: null, icon: null }));
    expect(plan.bands[1]!.pictures[0]).toMatchObject({ kind: "icon", icon: null, file: null });
    expect(plan.flags.join(" ")).toMatch(/not matched to one in TAWD's set/i);
  });

  it("gives an icon that did match its name, and flags nothing", () => {
    const plan = withPicture("icon", sheet({ kind: "icon", box: box(60, 200, 120, 120), file: null, icon: { name: "phone", by: "name" } }));
    expect(plan.bands[1]!.pictures[0]).toMatchObject({ kind: "icon", icon: "phone" });
    expect(plan.flags).toEqual([]);
  });

  it("carries the asset sheet's own flags through to the list", () => {
    const plan = withPicture("photo", sheet({ box: box(60, 200, 120, 120), flags: ["the background runs out on wide screens"] }));
    expect(plan.flags.join(" ")).toMatch(/runs out on wide screens/);
  });
});

/*
  P-4 of the paid run: a five-item menu came out as "HOME". The menu is
  drawn in full whether or not the pages exist.
*/
describe("the menu", () => {
  const menuRead = () =>
    read({
      bands: [
        {
          band: HEADER,
          words: [
            { text: "Services", role: "link", box: box(600, 40, 90, 20) },
            { text: "Home", role: "link", box: box(500, 40, 60, 20) },
            { text: "Get a quote", role: "button", box: box(1200, 36, 140, 40) },
            { text: "Pat Rivera Pump", role: "heading", box: box(40, 40, 300, 30) },
          ],
          pictures: [],
          fonts: [],
        },
        { band: HERO, words: [], pictures: [], fonts: [] },
        { band: FOOTER, words: [], pictures: [], fonts: [] },
      ],
    });

  it("keeps every item as drawn, in the order they are drawn", () => {
    const plan = buildPlan(menuRead(), [], PAGES);
    expect(plan.menu.map((m) => m.text)).toEqual(["Home", "Services", "Get a quote"]);
  });

  it("points an item at its page, and leaves the others without one", () => {
    const plan = buildPlan(menuRead(), [], PAGES);
    expect(plan.menu.find((m) => m.text === "Home")!.href).toBe("/");
    expect(plan.menu.find((m) => m.text === "Services")!.href).toBeNull();
  });

  it("says how many items have no page yet, and names them", () => {
    const plan = buildPlan(menuRead(), [], PAGES);
    expect(plan.flags.join(" ")).toMatch(/2 items have no page yet/);
    expect(plan.flags.join(" ")).toMatch(/"Services"/);
    expect(plan.flags.join(" ")).toMatch(/"Get a quote"/);
  });

  it("matches a page name whatever its capitals and punctuation", () => {
    const plan = buildPlan(menuRead(), [], [{ name: "SERVICES", slug: "services" }]);
    expect(plan.menu.find((m) => m.text === "Services")!.href).toBe("/services");
  });

  it("leaves headings and paragraphs out of the menu", () => {
    const plan = buildPlan(menuRead(), [], PAGES);
    expect(plan.menu.map((m) => m.text)).not.toContain("Pat Rivera Pump");
  });

  it("has no menu when the read named no header", () => {
    const plan = buildPlan(
      read({ bands: [{ band: { ...HERO, name: "Hero", role: "band" }, words: [{ text: "Home", role: "link", box: box(10, 200, 50, 20) }], pictures: [], fonts: [] }] }),
      [],
      PAGES,
    );
    expect(plan.menu).toEqual([]);
  });
});

describe("the bands of the plan", () => {
  it("are in order down the page, with the height the read gave them", () => {
    const plan = buildPlan(
      read({
        bands: [
          { band: FOOTER, words: [], pictures: [], fonts: [] },
          { band: HEADER, words: [], pictures: [], fonts: [] },
          { band: HERO, words: [], pictures: [], fonts: [] },
        ],
      }),
      [],
      PAGES,
    );
    expect(plan.bands.map((b) => [b.name, b.top, b.height])).toEqual([
      ["Header", 0, 136],
      ["Hero", 136, 458],
      ["Footer", 594, 206],
    ]);
  });

  it("takes header and footer from what the read named, not from where they sit", () => {
    // A "footer" drawn at the top and a "header" at the bottom: the names win.
    const plan = buildPlan(
      read({
        bands: [
          { band: { name: "Footer", role: "footer", top: 0, bottom: 136 }, words: [], pictures: [], fonts: [] },
          { band: { name: "Header", role: "header", top: 136, bottom: 800 }, words: [{ text: "Home", role: "link", box: box(10, 200, 50, 20) }], pictures: [], fonts: [] },
        ],
      }),
      [],
      PAGES,
    );
    expect(plan.bands[0]!.role).toBe("footer");
    expect(plan.bands[1]!.role).toBe("header");
    // The menu comes from the band named header, wherever it is drawn.
    expect(plan.menu.map((m) => m.text)).toEqual(["Home"]);
  });
});

describe("what the checks are given", () => {
  const plan = () =>
    buildPlan(
      read({
        bands: [
          { band: HEADER, words: [], pictures: [], fonts: [] },
          {
            band: HERO,
            words: [
              { text: "Clear water", role: "heading", box: box(40, 200, 300, 40) },
              { text: "blurred bit", role: "paragraph", box: box(40, 260, 300, 20), unsure: true },
            ],
            pictures: [
              { id: "a1", kind: "photo", box: box(60, 300, 120, 120) },
              { id: "a2", kind: "photo", box: box(300, 300, 120, 120) },
            ],
            fonts: [],
          },
          { band: FOOTER, words: [], pictures: [], fonts: [] },
        ],
      }),
      [sheet({ id: "a1", box: box(60, 300, 120, 120), file: "p1.png" }), sheet({ id: "a2", box: box(300, 300, 120, 120), file: null })],
      PAGES,
    );

  it("marks a word the read was unsure of, so the word check neither demands nor refuses it", () => {
    const spec = designSpecFrom(plan());
    expect(spec.words).toEqual([{ text: "Clear water" }, { text: "blurred bit", uncertain: true }]);
  });

  it("leaves out a picture there is nothing to draw for, so a band is not failed for it", () => {
    const spec = designSpecFrom(plan());
    expect(spec.pictures.map((p) => p.name)).toEqual(["picture 1"]);
  });

  it("gives the same bands and size the builder was given", () => {
    const spec = designSpecFrom(plan());
    expect(spec.width).toBe(1400);
    expect(spec.height).toBe(800);
    expect(spec.bands).toEqual([
      { name: "Header", top: 0, height: 136 },
      { name: "Hero", top: 136, height: 458 },
      { name: "Footer", top: 594, height: 206 },
    ]);
  });
});
