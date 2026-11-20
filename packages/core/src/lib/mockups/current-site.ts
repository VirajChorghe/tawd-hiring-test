import { classifySection, type RawReferenceBand, type SectionKind } from "./references";

/*
  The client's current website (Jason, 30 September 2026): its home page,
  read by the worker's browser with no AI, is where the mockup's words come
  from when the client has a site. This turns what the browser read into
  the menu, the sections with their words, the phone numbers and the
  testimonials. The site's words are the client's own content: data, never
  instructions.

  A testimonial copied from an old site can't be verified, so it is kept
  apart and shown as a [PLACEHOLDER] until someone confirms it with the
  client (the no-fake-reviews house rule).
*/

export interface CurrentSiteSection {
  kind: SectionKind;
  heading: string;
  words: string;
}

export interface CurrentSiteResult {
  title: string;
  menu: { label: string; href: string }[];
  sections: CurrentSiteSection[];
  phones: string[];
  testimonials: string[];
}

/*
  The home page's look (0.96.0, one read of the current site): read from
  the same browser load, free. The top colours and font families from the
  page's computed styles and a first-screen screenshot (1440 wide) in R2.
  Shown on Intake; for the design steps later (Part B, self-serve).
*/
export interface HomeLook {
  colours: string[];
  fonts: string[];
  /** The screenshot's R2 key (under the read's folder), or null when it couldn't be saved. */
  screenshotKey: string | null;
}

/** The home page as the one read saves it (site_import.home). */
export type SiteHome = CurrentSiteResult & { look?: HomeLook };

const clean = (text: string) => text.replace(/\s+/g, " ").trim();

/** The home page's sections kept: a page builder's home page runs to 25 or so (finleypest.com, 7 October 2026). */
export const MAX_SECTIONS = 30;

export function phonesIn(text: string): string[] {
  const found = text.match(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g) ?? [];
  return [...new Set(found.map((p) => p.replace(/\s+/g, " ").trim()))].slice(0, 5);
}

/* Quoted sentences in a reviews band: each a testimonial to confirm. */
export function testimonialsIn(text: string): string[] {
  const quoted = [...text.matchAll(/[“"]([^”"]{15,400})[”"]/g)].map((m) => clean(m[1]!));
  return [...new Set(quoted)].slice(0, 10);
}

export function summarizeCurrentSite(input: { title: string; bands: RawReferenceBand[]; menu: { label: string; href: string }[] }): CurrentSiteResult {
  const visible = input.bands.filter((b) => b.height >= 40 && b.text.trim());
  const heroIndex = Math.max(0, visible.findIndex((b) => b.tag !== "header" && b.tag !== "nav"));
  const sections = visible
    .map((b, index) => ({
      kind: classifySection({ tag: b.tag, heading: b.heading, text: b.text, index, total: visible.length, hasForm: b.hasForm, heroIndex }),
      heading: clean(b.heading).slice(0, 120),
      // Long enough for a page built as one big block (seen on real sites, 1 October 2026).
      words: clean(b.text).slice(0, 4000),
    }))
    // The header and footer are the menu and the contact details, read apart.
    .filter((s) => s.words.length > 0);
  const all = visible.map((b) => b.text).join(" ");
  const reviews = sections.filter((s) => s.kind === "reviews").map((s) => s.words).join(" ");
  const menu = input.menu
    .map((m) => ({ label: clean(m.label).slice(0, 60), href: m.href }))
    .filter((m) => m.label.length > 0 && m.label.length <= 40)
    // Not menu items: "Skip to content" links, and a logo's file path read as its label.
    .filter((m) => !/^skip to\b/i.test(m.label) && !/^\/|_|\/[^/]*\//.test(m.label) && /[a-z]/i.test(m.label))
    .filter((m, i, list) => list.findIndex((x) => x.label.toLowerCase() === m.label.toLowerCase()) === i)
    .slice(0, 20);
  return { title: clean(input.title).slice(0, 200), menu, sections: sections.slice(0, MAX_SECTIONS), phones: phonesIn(all), testimonials: testimonialsIn(reviews) };
}

/* One line for the intake panel: "6 sections, a menu of 7 links, 1 phone number, 2 testimonials". */
export function describeCurrentSite(result: CurrentSiteResult): string {
  const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
  return [
    n(result.sections.length, "section"),
    result.menu.length ? `a menu of ${n(result.menu.length, "link")} (${result.menu.slice(0, 8).map((m) => m.label).join(", ")}${result.menu.length > 8 ? ", ..." : ""})` : "no menu found",
    result.phones.length ? `the phone ${result.phones.join(", ")}` : "no phone number found",
    result.testimonials.length ? `${n(result.testimonials.length, "testimonial")} (to confirm with the client)` : null,
  ]
    .filter(Boolean)
    .join(", ");
}
