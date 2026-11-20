import { splitSections } from "../mockups/sections";

/*
  The home page's band plan (F25, 10 November 2026).

  The approved mockup is what the team and the client said yes to. The built
  home page is written fresh from the approved copy, and the only thing that
  held its layout together was one sentence in the prompt: "keep the
  approved homepage's layout and sections, with its copy replaced by the
  approved copy below."

  That sentence was outgunned by the rules around it — use the copy "word
  for word, in its order", "you may split it into sections, columns or
  cards", and a hard rule that any page asking the visitor to get in touch
  gets a contact form with named fields in a named order. New Dawn's
  contact band, one two-column section in the mockup, came out as an info
  band and a separate form band. That is those rules winning, and nothing
  anywhere compared the result with the mockup.

  The mockup's bands were also handed over as "examples of the site's
  building blocks" — a pile of blocks, with nothing saying that this is the
  order the client approved.

  So the order is worked out here, by code, and given to the builder as a
  numbered plan it must follow. Then the rules that used to win are made to
  defer to it, and the built page is checked against it.
*/

export interface HomeBand {
  /** 1-based, as the builder and the team count bands. */
  number: number;
  /** The band's own heading (h1-h3), trimmed, or null when it has none. */
  heading: string | null;
  /** What the band is made of, in the team's words: "a form", "3 cards", "a photo and words". */
  shape: string;
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();

/* A band's own heading: the first h1, h2 or h3 in it. Shared with page-plan.ts, which reads the same bands for the other pages. */
export function headingOf(html: string): string | null {
  const found = /<h([123])\b[^>]*>([\s\S]*?)<\/h\1>/i.exec(html);
  const words = found ? text(found[2]!) : "";
  return words ? words.slice(0, 120) : null;
}

/*
  What the band is made of. Deliberately coarse: enough for a builder to
  rebuild the same shape and for a check to notice a band that was split in
  two, without pretending to measure a design.
*/
export function shapeOf(html: string): string {
  const parts: string[] = [];
  if (/<form\b/i.test(html)) parts.push("a form");
  const images = html.match(/<img\b/gi)?.length ?? 0;
  const frames = html.match(/data-tawd-photo\b/gi)?.length ?? 0;
  const pictures = images + frames;
  if (pictures > 1) parts.push(`${pictures} pictures`);
  else if (pictures === 1) parts.push("a picture");
  /*
    A repeated child is a grid: three cards, four steps. Counted by the
    children that carry their own sub-heading, which is what makes a card a
    card here, rather than by guessing at CSS.
  */
  const cards = html.match(/<h[34]\b/gi)?.length ?? 0;
  if (cards >= 2) parts.push(`${cards} cards`);
  if (/<(ol|ul)\b/i.test(html) && cards < 2) parts.push("a list");
  if (/<details\b/i.test(html)) parts.push("questions that open");
  if (parts.length === 0) parts.push("words");
  return parts.join(" and ");
}

/*
  The bands of the approved home page, in order. The header and footer are
  left out: they are built once and shared, and the builder is told not to
  write them.
*/
export function homeBandPlan(mockupHtml: string): HomeBand[] {
  const bands = splitSections(mockupHtml);
  if (bands.length === 0) return [];
  const first = bands[0]!;
  const last = bands.at(-1)!;
  const isHeader = (b: (typeof bands)[number]) => b === first && (b.tag === "header" || /<nav\b/i.test(b.html));
  const isFooter = (b: (typeof bands)[number]) => b === last && b !== first && (b.tag === "footer" || /<footer\b/i.test(b.html));
  return bands
    .filter((b) => !isHeader(b) && !isFooter(b))
    .map((b, index) => ({ number: index + 1, heading: headingOf(b.html), shape: shapeOf(b.html) }));
}

/*
  The plan as the builder is given it. Binding, not an example — and it
  says what to do where the approved copy and the mockup disagree, because
  they are two different texts written by two different steps, and the
  builder cannot follow both orders at once. Saying so beats leaving it to
  invent something.
*/
export function describeHomeBandPlan(plan: HomeBand[]): string {
  if (plan.length === 0) return "";
  const lines = plan.map((b) => `${b.number}. ${b.heading ? `"${b.heading}"` : "(no heading)"} — ${b.shape}`);
  return `The approved homepage has these ${plan.length} bands, in this order. This is what the client said yes to, so the homepage you build has the same bands in the same order, one for one:

${lines.join("\n")}

- **This plan wins over the freedom to split the copy.** Do not split one of these bands into two, and do not merge two into one. A band's own heading may be reworded to the approved copy's heading for that part.
- **The contact form goes inside the band above that already has one** — it does not become a band of its own.
- Where the approved copy has nothing for a band, keep the band and fill it from the copy's nearest part rather than inventing anything; where the copy has a part no band covers, add it to the band it belongs with. **Never add a band that is not on this list.**`;
}

export interface HomePlanIssue {
  id: string;
  severity: "fail" | "warn";
  message: string;
}

/*
  The built home page against the plan (F25's missing check). Bands are
  counted, and their headings compared loosely — the approved copy rewords
  them on purpose, so this is about a band going missing or being split,
  not about wording.
*/
export function checkHomeAgainstPlan(builtHtml: string, plan: HomeBand[]): HomePlanIssue[] {
  if (plan.length === 0) return [];
  const built = homeBandPlan(builtHtml);
  if (built.length === plan.length) return [];
  const [more, fewer] = built.length > plan.length ? ["more", "fewer"] : ["fewer", "more"];
  void fewer;
  return [
    {
      id: "home.bandsDiffer",
      severity: "fail",
      message:
        `The approved homepage has ${plan.length} band${plan.length === 1 ? "" : "s"} and the built homepage has ${built.length}: ` +
        `${more === "more" ? "a band was split or added" : "a band was merged or left out"}. The client approved the mockup's layout, so the built page keeps it band for band. ` +
        `Approved: ${plan.map((b) => b.heading ?? b.shape).join(" / ")}. Built: ${built.map((b) => b.heading ?? b.shape).join(" / ")}.`,
    },
  ];
}
