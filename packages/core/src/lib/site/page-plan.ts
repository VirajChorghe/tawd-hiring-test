import { splitSections } from "../mockups/sections";
import { headingOf, shapeOf } from "./home-plan";

/*
  Every page's band plan (17 November 2026), the other six-sevenths of F25.

  F25 worked out the HOME page's bands by code and gave them to the builder
  as a numbered plan it must follow, because the one sentence that used to
  carry the layout ("keep the approved homepage's layout and sections") was
  outgunned by the rules around it. Every OTHER page kept that same problem,
  and worse: its whole layout instruction was "Build this page from the
  site's building blocks", with the approved design's sections handed over
  as an unnamed pile and a rule saying the builder "may split it into
  sections, columns or cards".

  Sample Marketing Co.'s Services page, built 17 November 2026, is what that
  produces. Four content groups became four identical bands - an icon, a
  heading, a line, a row of plain cards - and the page used no picture at
  all, because no rule asked it to. The home page beside it, designed by a
  person, uses eight different shapes and two photographs.

  So the design's own bands are read here as a named vocabulary, each page's
  copy is matched to that vocabulary by code, and the result is given to the
  builder the way the home page's plan is. No AI and no network: the design
  is already in hand, and choosing which shape goes where is a decision code
  can make (rule 6).
*/

export interface DesignPattern {
  /** 1-based, the same number the section has in the builder's <example_sections>. */
  number: number;
  /** Its heading in the approved design, so the team can recognise it. */
  heading: string | null;
  /** What it is made of, in the team's words: "a picture and 3 cards". */
  shape: string;
  /** The coarse family. Two bands next to each other must never share one. */
  key: PatternKey;
  hasForm: boolean;
  hasPicture: boolean;
  cards: number;
  questions: boolean;
}

export type PatternKey = "form" | "questions" | "picture+cards" | "cards" | "picture+points" | "points" | "picture+words" | "words";

const count = (html: string, re: RegExp) => html.match(re)?.length ?? 0;

/*
  The family a band belongs to. Coarse on purpose, like shapeOf: enough to
  keep two bands running from being the same thing, without pretending to
  measure a design.
*/
export function patternKey(html: string): PatternKey {
  if (/<form\b/i.test(html)) return "form";
  if (/<details\b/i.test(html)) return "questions";
  const pictures = count(html, /<img\b/gi) + count(html, /data-tawd-photo\b/gi);
  const cards = count(html, /<h[34]\b/gi);
  const points = /<(ol|ul)\b/i.test(html);
  if (cards >= 2) return pictures ? "picture+cards" : "cards";
  if (points) return pictures ? "picture+points" : "points";
  return pictures ? "picture+words" : "words";
}

/*
  The approved design's bands as a vocabulary of named patterns. The
  numbers are the section's own position, so the plan can point the builder
  at a band it has already been given in full.
*/
export function designPatterns(sections: string[]): DesignPattern[] {
  return sections
    .map((html, index) => {
      const key = patternKey(html);
      return {
        number: index + 1,
        heading: headingOf(html),
        shape: shapeOf(html),
        key,
        hasForm: key === "form",
        hasPicture: key.startsWith("picture"),
        cards: count(html, /<h[34]\b/gi),
        questions: key === "questions",
      };
    })
    .filter((p) => p.shape !== "words" || p.heading !== null);
}

/* ---------- the page's own copy ---------- */

export interface CopyGroup {
  /** The "## " heading, or null for the part above the first one. */
  heading: string | null;
  /** How many "### " sub-headings it has: 2 or more is what makes cards cards. */
  subHeadings: number;
  /** Sub-headings that are questions, which the design answers with its own questions band. */
  questions: boolean;
  listItems: number;
  words: number;
  /** The copy asks the visitor to get in touch here, so the form belongs in this band. */
  asks: boolean;
}

const ASKS = /\b(contact|get in touch|send (us )?a message|request a quote|book|enquir|inquir|talk to us|start a conversation)\b/i;

/* The approved copy's own groups: "## " starts one, "### " is an item inside it. */
export function copyGroups(copy: string): CopyGroup[] {
  const groups: CopyGroup[] = [];
  const blank = (heading: string | null): CopyGroup => ({ heading, subHeadings: 0, questions: false, listItems: 0, words: 0, asks: false });
  for (const line of copy.split(/\r?\n/)) {
    const h2 = /^##\s+(?!#)(.+)$/.exec(line);
    if (h2) {
      groups.push(blank(h2[1]!.trim()));
      continue;
    }
    // The H1 and anything before the first "## " are the page's opening band.
    if (groups.length === 0) {
      if (!line.trim()) continue;
      groups.push(blank(null));
    }
    const current = groups[groups.length - 1]!;
    const h3 = /^###\s+(?!#)(.+)$/.exec(line);
    if (h3) {
      current.subHeadings += 1;
      if (h3[1]!.trim().endsWith("?")) current.questions = true;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) current.listItems += 1;
    const words = line.trim().replace(/^#+\s*/, "");
    if (words) {
      current.words += words.split(/\s+/).length;
      if (ASKS.test(words)) current.asks = true;
    }
  }
  return groups;
}

/* ---------- matching one to the other ---------- */

export interface PageBand {
  number: number;
  heading: string | null;
  /** The design pattern this band takes its shape from; null when the design offers none. */
  pattern: DesignPattern | null;
  /** Why this shape, in the team's words. Read by nobody but a person. */
  why: string;
}

/* What shapes suit a group, best first, from the group's own copy. */
function wanted(group: CopyGroup): PatternKey[] {
  if (group.questions) return ["questions", "cards", "points", "words"];
  if (group.asks) return ["form", "picture+words", "words"];
  if (group.subHeadings >= 2) return ["cards", "picture+cards", "picture+points", "points"];
  if (group.listItems >= 2) return ["points", "picture+points", "picture+cards", "cards"];
  return ["picture+words", "words", "picture+points"];
}

/*
  A pattern for each of the copy's groups.

  Three rules, in this order, and each one is why this exists at all:
    1. Never the same family twice running. Four identical bands is the
       failure this was written for.
    2. Prefer a family this page has not used yet, so a page of five groups
       is five shapes rather than two.
    3. If the page has a photo to use and nothing else is picture-led, the
       middle band becomes one. A page with no picture at all is what Build
       A produced for Services, and no rule anywhere forbade it.
  A design that offers only one shape gets only one shape: this never
  invents a pattern the client did not approve.
*/
export function pageBandPlan(copy: string, patterns: DesignPattern[], options: { hasPhoto: boolean } = { hasPhoto: false }): PageBand[] {
  const groups = copyGroups(copy);
  if (groups.length === 0 || patterns.length === 0) return [];
  const hero = patterns[0]!;
  const body = patterns.slice(1);
  const used = new Set<PatternKey>();
  const bands: PageBand[] = [];

  groups.forEach((group, index) => {
    if (index === 0 && group.heading === null) {
      bands.push({ number: 1, heading: null, pattern: hero, why: "the design's own opening band" });
      used.add(hero.key);
      return;
    }
    const previous = bands.at(-1)?.pattern?.key;
    const pool = body.length ? body : patterns;
    const wants = wanted(group);
    const byWant = (list: DesignPattern[]) => wants.map((key) => list.filter((p) => p.key === key)).flat();
    const notPrevious = pool.filter((p) => p.key !== previous);
    // A form band is only ever used where the copy asks for one, so it is not spent on an ordinary group.
    const ordinary = notPrevious.filter((p) => !p.hasForm || group.asks);
    const fresh = ordinary.filter((p) => !used.has(p.key));
    const chosen = byWant(fresh)[0] ?? byWant(ordinary)[0] ?? fresh[0] ?? ordinary[0] ?? pool[0]!;
    used.add(chosen.key);
    bands.push({
      number: bands.length + 1,
      heading: group.heading,
      pattern: chosen,
      why: group.questions
        ? "the copy's questions, as the design answers questions"
        : group.asks
          ? "the copy asks the visitor to get in touch, so the design's own form band holds it"
          : group.subHeadings >= 2
            ? `${group.subHeadings} items with their own headings`
            : group.listItems >= 2
              ? `${group.listItems} points`
              : "words",
    });
  });

  if (options.hasPhoto && !bands.some((b) => b.pattern?.hasPicture)) {
    const middle = Math.max(1, Math.floor(bands.length / 2));
    const picture = body.find((p) => p.hasPicture) ?? patterns.find((p) => p.hasPicture);
    const band = bands[middle];
    if (picture && band) bands[middle] = { ...band, pattern: picture, why: `${band.why}, and this page needs one picture` };
  }
  return bands;
}

/*
  The plan as the builder is given it: binding, numbered, and pointing at
  the band of the approved design each one copies, which the builder
  already has in full in <example_sections>. Worded like the home page's
  plan, because it does the same job.
*/
export function describePageBandPlan(bands: PageBand[]): string {
  if (bands.length === 0) return "";
  const lines = bands.map((b) => {
    const p = b.pattern;
    const from = p ? `shaped like band ${p.number} of the approved design${p.heading ? ` ("${p.heading}")` : ""} — ${p.shape}` : "words";
    return `${b.number}. ${b.heading ? `"${b.heading}"` : "(the page's opening band)"} — ${from}`;
  });
  return `This page has these ${bands.length} bands, in this order. Build it as this plan says, not as the copy's shape suggests:

${lines.join("\n")}

- **This plan wins over the freedom to split the copy.** Do not split one of these bands into two, and do not merge two into one. A band's own heading is the approved copy's heading for that part.
- Each band is built with the classes and the shape of the band of the approved design it names, so this page looks like the page the client approved rather than a page of plain boxes.
- **Two bands next to each other are never the same shape.** If the plan gives them the same one, use the nearest other shape in the design for the second.
- The contact form goes inside the band the plan gives a form to, never in a band of its own. **Never add a band that is not on this list.**`;
}

/* ---------- checking what came back ---------- */

export interface PagePlanIssue {
  id: string;
  severity: "fail" | "warn";
  message: string;
}

/*
  The built page against the two things that went wrong on Services: every
  band the same shape, and no picture anywhere. Reported, not blocking
  (Jason, 17 November 2026): no project already built is stopped by a rule
  it has never been measured against.
*/
export function checkPageVariety(builtHtml: string, options: { name: string; hasPhoto: boolean }): PagePlanIssue[] {
  const bands = splitSections(builtHtml).filter((b) => b.tag !== "header" && b.tag !== "footer");
  if (bands.length < 3) return [];
  const issues: PagePlanIssue[] = [];
  const keys = bands.map((b) => patternKey(b.html));
  const distinct = new Set(keys);
  if (distinct.size < 2) {
    issues.push({
      id: "page.oneShape",
      severity: "warn",
      message: `${options.name} is ${bands.length} bands of the same shape (${[...distinct][0]}). The approved design has more than one, and a page of one shape repeated reads as a list, not as the design the client said yes to.`,
    });
  }
  const repeats = keys.filter((key, index) => index > 0 && key === keys[index - 1]).length;
  if (distinct.size >= 2 && repeats >= 2) {
    issues.push({
      id: "page.sameShapeRunning",
      severity: "warn",
      message: `${options.name} has ${repeats} places where two bands running are the same shape. The design's other bands are there to be used.`,
    });
  }
  if (options.hasPhoto && !/<img\b/i.test(builtHtml)) {
    issues.push({
      id: "page.noPicture",
      severity: "warn",
      message: `${options.name} has no picture at all, and this site has photos to use. Every other page of the approved design has one.`,
    });
  }
  return issues;
}
