import { describe, expect, it } from "vitest";

import { confirmedFactsFrom } from "@tawd/core/mockups";
import { runChecklist, KEPT_MAIN_ATTR, keptMainWords, backedByOwnWords } from "@tawd/core/site";
import { emptyIntake } from "@tawd/core/intake";

/*
  A supplied home page's own words back its own facts (Jason, 16 November
  2026). He was told plainly what that means: no person checks those facts
  any more, and a page with invented reviews would be carried to live
  unchallenged. These tests prove what it backs and, as important, what it
  does not: every other page, the shared header and footer, and anything the
  page does not itself say.
*/

function intake() {
  const data = emptyIntake();
  data.business.name = "Sample Marketing Co.";
  data.business.phone = "(555) 555-0142";
  data.business.streetAddress = "400 Main Street";
  data.business.city = "Springfield";
  data.business.state = "CA";
  data.serviceAreas.cities = ["Springfield, CA"] as never;
  return data;
}
const facts = () => confirmedFactsFrom(intake());

/* What the owner's real supplied page says, in the words it said them. */
const SUPPLIED_BODY = `
  <section><h1>Marketing that fills your calendar</h1><p>Rated 5 stars on Google</p><p>We have been serving local owners for over 25 years.</p><p>Free consultation for every client. Licensed and insured. Plans from only $499 a month.</p></section>
  <section><h2>What clients say</h2>
    <blockquote>"They doubled our calls."<cite>Desiree C.</cite></blockquote>
    <blockquote>"Worth every penny."<cite>Sean P.</cite></blockquote>
    <blockquote>"Easy to work with."<cite>Coreen S.</cite></blockquote>
  </section>`;

const header = `<header><a href="#main">Skip</a><a href="tel:+15555550142">Call (555) 555-0142</a></header>`;
const footer = `<footer><p>Website by Velocity Media Lab</p></footer>`;
const page = (main: string, mark = true) => `<!doctype html><html lang="en"><head><title>Sample Marketing Co.</title></head><body>${header}<main id="main"${mark ? ` ${KEPT_MAIN_ATTR}` : ""}>${main}</main>${footer}</body></html>`;

/*
  What the go-live check is given as the supplied words is the words of the STORED UPLOAD (suppliedHomeWords reads them from
  original.html), never the built file. Here that is the supplied body, whatever the built page has become since.
*/
const SUPPLIED_WORDS = keptMainWords(page(SUPPLIED_BODY));
const run = (files: [string, string][], suppliedHomeFile?: string | null, suppliedWords: string | null = suppliedHomeFile ? SUPPLIED_WORDS : null) => {
  const f = facts();
  const items = runChecklist({ files: new Map(files), pagePaths: ["/"], domain: null, mobileOverflow: [], gbpUrl: "", claims: f.claims, facts: f, suppliedHomeFile, suppliedWords });
  return { facts: items.find((i) => i.key === "facts")!, claims: items.find((i) => i.key === "claims")! };
};

describe("a supplied page's own words back its own facts", () => {
  it("without the rule the owner's real page blocks go-live on both checks", () => {
    const { facts: f, claims: c } = run([["index.html", page(SUPPLIED_BODY)]], null);
    expect(f.ok).toBe(false);
    expect(f.detail).toContain("Rated 5");
    expect(f.detail).toContain("$499");
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("Free consultation");
  });

  it("with the rule, neither check fires on it, and the checklist says what it left uncounted", () => {
    const { facts: f, claims: c } = run([["index.html", page(SUPPLIED_BODY)]], "index.html");
    expect(f.ok).toBe(true);
    expect(f.flags ?? []).toEqual([]);
    expect(c.ok).toBe(true);
    expect(f.detail).toMatch(/The supplied home page's own words back \d+ findings? on it \(index\.html\)/);
    expect(f.detail).toContain("whoever supplied the page answers for what it says");
    expect(c.detail).toMatch(/own words back \d+ findings?/);
  });

  it("does not back the same words on any other page", () => {
    const other = `<!doctype html><html lang="en"><head><title>About</title></head><body>${header}<main id="main">${SUPPLIED_BODY}</main>${footer}</body></html>`;
    const { facts: f, claims: c } = run([["index.html", page(SUPPLIED_BODY)], ["about/index.html", other]], "index.html");
    expect(f.ok).toBe(false);
    expect(f.detail).toContain("about/index.html");
    // The supplied file's own findings are the only ones left uncounted: the other page's are listed.
    expect(f.detail).not.toMatch(/(^|: |; )index.html: /);
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("Free consultation");
  });

  it("does not trust a mark on a page that is not the approved supplied home page", () => {
    // An AI-written page that carries the mark must not be exempted: only the file the approval and the plan name is.
    const { facts: f } = run([["index.html", page("<p>Fine.</p>")], ["about/index.html", page(SUPPLIED_BODY)]], "index.html");
    expect(f.ok).toBe(false);
    expect(f.detail).toContain("about/index.html");
  });

  it("does not back words the AI added after the upload: the built page carries the mark, the supplied words do not have them", () => {
    // A client edit request ("add that we are rated 5 stars on Google") has the AI rewrite the kept main; restampKept puts the mark back.
    const edited = SUPPLIED_BODY.replace("Rated 5 stars on Google", "Rated 4.9 stars on Yelp by 312 reviewers") + "<p>Lifetime warranty on every repair.</p>";
    // The supplied upload never said these. The built page does, with the mark.
    const { facts: f, claims: c } = run([["index.html", page(edited)]], "index.html");
    expect(f.ok && c.ok).toBe(false);
    // The words the client really supplied are still backed: the same page unedited passes both.
    expect(run([["index.html", page(SUPPLIED_BODY)]], "index.html").facts.ok).toBe(true);
  });

  it("backs nothing when the supplied words could not be found", () => {
    expect(run([["index.html", page(SUPPLIED_BODY)]], "index.html", null).facts.ok).toBe(false);
  });

  it("still reports what the page's own words do not say: a call button dialling a number the page never shows", () => {
    const body = `${SUPPLIED_BODY}<p><a href="tel:+19998887777">Book now</a></p>`;
    const { facts: f } = run([["index.html", page(body)]], "index.html");
    expect(f.ok).toBe(false);
    expect(f.detail).toContain("+19998887777");
  });

  it("backs a number the page shows and dials", () => {
    const shown = `${SUPPLIED_BODY}<p>Call <a href="tel:+19165550100">(916) 555-0100</a></p>`;
    expect(run([["index.html", page(shown)]], "index.html", keptMainWords(page(shown))).facts.ok).toBe(true);
  });

  it("still checks the shared header on the supplied file: a fact there that the supplied words do not say is reported", () => {
    // The supplied main says "$499 a month". The header (TAWD's own) says "$49": a different price, and one the page never said.
    // It is reported only if "$49" is not mistaken for the start of "$499" (whole-word matching), and only if the header is not a way round the check.
    const badHeader = page(SUPPLIED_BODY).replace("(555) 555-0142", "Only $49 today");
    const { facts: f } = run([["index.html", badHeader]], "index.html");
    expect(f.ok).toBe(false);
    expect(f.detail).toContain("$49");
  });
});

describe("the pieces", () => {
  it("reads only the kept main's words, and nothing from a page that is not kept", () => {
    expect(keptMainWords(page("<p>Hello <b>there</b></p>"))).toBe("Hello there");
    expect(keptMainWords(page("<p>Hello</p>", false))).toBeNull();
    expect(keptMainWords(page("<p>Hello</p>"))).not.toContain("Call");
  });

  it("is proof only when the finding is in the words: absent or trivial evidence is never backed", () => {
    expect(backedByOwnWords("Rated 5 stars", "Rated 5 stars on Google")).toBe(true);
    expect(backedByOwnWords("5", "Rated 5 stars")).toBe(false);
    expect(backedByOwnWords("$", "Only $ here")).toBe(false);
    expect(backedByOwnWords("Rated 4 stars", "Rated 5 stars on Google")).toBe(false);
    expect(backedByOwnWords("+1 916-555-0100", "Call (916) 555-0100")).toBe(true);
    expect(backedByOwnWords("+19998887777", "Call (916) 555-0100")).toBe(false);
  });

  it("matches whole words, never part of one", () => {
    expect(backedByOwnWords("$150", "Repairs from $1,150 a month")).toBe(false);
    expect(backedByOwnWords("$1,150", "Repairs from $1,150 a month")).toBe(true);
    expect(backedByOwnWords("100", "Call 555-0100")).toBe(false);
    expect(backedByOwnWords("100", "Over 100 happy clients")).toBe(true);
    expect(backedByOwnWords("$49", "Plans from $499 a month")).toBe(false);
    expect(backedByOwnWords("$49", "Plans from $49.99 a month")).toBe(false);
    expect(backedByOwnWords("ace", "The best place in town")).toBe(false);
  });

  it("backs the short prices trades pages state: $49, $99, $20 off, 5%", () => {
    expect(backedByOwnWords("$49", "Tune-ups $49 and up")).toBe(true);
    expect(backedByOwnWords("$99", "Service call $99.")).toBe(true);
    expect(backedByOwnWords("$20 off", "Save $20 off your first visit")).toBe(true);
    expect(backedByOwnWords("5%", "Senior discount of 5% on all work")).toBe(true);
    // ...but only when the page really says them.
    expect(backedByOwnWords("$49", "Tune-ups $59 and up")).toBe(false);
    expect(backedByOwnWords("5%", "Save 15% today")).toBe(false);
  });

  it("reads a phone number as one number on the page, never digits joined across two", () => {
    expect(backedByOwnWords("+1 555-123-4567", "Office 555-123-4567 any time")).toBe(true);
    // 5551 + 234567 + 8: the digits run together hold 5551234567 but no number on the page is that.
    expect(backedByOwnWords("+1 555-123-4567", "Ref 5551 then 234567 8")).toBe(false);
  });
});
