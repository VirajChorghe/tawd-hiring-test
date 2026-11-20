import type { CheckIssue } from "./checks";
import { descriptionWithoutClaims } from "./claims";
import { elementClasses, setElementClasses } from "./element-marks";

/*
  Fixes TAWD makes itself, before any AI is asked (Jason, 25 September
  2026: fix rounds were 44% of AI spend).

  Everything here is plain text surgery on the page source, so it costs
  nothing and is exactly repeatable. The rendered fixes (contrast, the logo
  treatment) are worked out in the browser by the worker and arrive here as
  CSS rules; this file puts them in one marked style block, replacing any
  earlier one, so running the fixes twice never stacks them.

  After these run, the checks run again. Only what is still failing goes to
  a (targeted, section-only) AI fix.
*/

export const TITLE_LIMIT = 60;
export const DESCRIPTION_LIMIT = 160;

const FIX_STYLE_PATTERN = /<style data-tawd-fixes>[\s\S]*?<\/style>\s*/i;

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function plainText(html: string): string {
  return decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/*
  At most `max` characters: the longest run of whole sentences that fits,
  otherwise the longest run of whole words (no trailing punctuation left
  dangling). Never cuts a word in half.
*/
export function shortenAt(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;

  const sentences = clean.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [];
  let fitting = "";
  for (const sentence of sentences) {
    if ((fitting + sentence).trim().length > max) break;
    fitting += sentence;
  }
  if (fitting.trim().length >= Math.min(60, max * 0.5)) return fitting.trim();

  const words = clean.split(" ");
  let out = "";
  for (const word of words) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > max) break;
    out = next;
  }
  return out.replace(/[\s,;:–—-]+$/, "").trim();
}

/*
  A title over the limit: keep whole " | " or " - " parts from the start
  while they fit (the business name and city are usually there), otherwise
  shorten at a word boundary.
*/
export function shortenTitle(title: string, max = TITLE_LIMIT): string {
  const clean = title.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const parts = clean.split(/\s+[|–—-]\s+|\s*:\s+/);
  if (parts.length > 1) {
    const separator = /\s\|\s/.test(clean) ? " | " : " - ";
    let kept = parts[0]!;
    for (const part of parts.slice(1)) {
      const next = `${kept}${separator}${part}`;
      if (next.length > max) break;
      kept = next;
    }
    if (kept.length <= max && kept.length >= 20) return kept;
  }
  return shortenAt(clean, max);
}

export function replaceFixStyle(html: string, css: string): string {
  const without = html.replace(FIX_STYLE_PATTERN, "");
  if (!css.trim()) return without;
  const block = `<style data-tawd-fixes>\n${css.trim()}\n</style>\n`;
  return /<\/head>/i.test(without)
    ? without.replace(/<\/head>/i, `${block}</head>`)
    : `${block}${without}`;
}

/** The CSS already in the fix block, one rule per line. */
export function existingFixRules(html: string): string[] {
  const block = FIX_STYLE_PATTERN.exec(html)?.[0] ?? "";
  return block
    .replace(/<\/?style[^>]*>/gi, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export interface CodeFixResult {
  html: string;
  /** Plain names of what was fixed, for the generating screen. */
  fixed: string[];
}

/** Title and meta description, from the HTML alone. */
export function fixTitleAndDescription(html: string, issues: CheckIssue[]): CodeFixResult {
  const ids = new Set(issues.map((i) => i.id));
  const fixed: string[] = [];
  let out = html;

  if (ids.has("seo.title.long")) {
    const match = /<title>([\s\S]*?)<\/title>/i.exec(out);
    if (match) {
      const shorter = shortenTitle(decode(match[1]!));
      if (shorter && shorter.length <= TITLE_LIMIT) {
        out = out.replace(match[0], `<title>${escapeText(shorter)}</title>`);
        fixed.push("title length");
      }
    }
  }

  const descriptionTag = /<meta[^>]+name=["']description["'][^>]*>/i;
  /*
    A claim the intake doesn't back, in the description: taken out here,
    because the AI fix round never sees the head (12 November 2026). If
    that leaves no description, one is written below as for a missing one.
  */
  const unclaimed = descriptionWithoutClaims(out, issues);
  if (unclaimed.removed > 0) {
    out = unclaimed.html;
    fixed.push(`${unclaimed.removed === 1 ? "a sentence" : `${unclaimed.removed} sentences`} with a flagged claim taken out of the meta description`);
  }

  if (ids.has("seo.description.long")) {
    const tag = descriptionTag.exec(out)?.[0];
    const content = tag ? /content=["']([^"']*)["']/i.exec(tag)?.[1] : null;
    if (tag && content) {
      const shorter = shortenAt(decode(content), DESCRIPTION_LIMIT);
      if (shorter) {
        out = out.replace(tag, `<meta name="description" content="${escapeAttribute(shorter)}">`);
        fixed.push("description length");
      }
    }
  }

  if ((ids.has("seo.description.missing") || unclaimed.removed > 0) && !descriptionTag.test(out)) {
    // The headline and the first real sentence of the page say what it is.
    const h1 = plainText(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(out)?.[1] ?? "");
    const firstParagraph = [...out.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((m) => plainText(m[1]!))
      .find((text) => text.length > 40 && !/\[PLACEHOLDER/i.test(text));
    const draft = [h1 && !/[.!?]$/.test(h1) ? `${h1}.` : h1, firstParagraph].filter(Boolean).join(" ");
    const description = shortenAt(draft, DESCRIPTION_LIMIT);
    if (description.length >= 50 && /<\/head>/i.test(out)) {
      const written = out.replace(/<\/head>/i, () => `<meta name="description" content="${escapeAttribute(description)}">\n</head>`);
      // Never a description that brings back a claim just taken out (the page's copy can still hold it).
      if (descriptionWithoutClaims(written, issues).removed === 0) {
        out = written;
        fixed.push("missing description");
      }
    }
  }

  return { html: out, fixed };
}

/*
  Tap targets, for the mobile build: minimum sizes that only apply on small
  screens, so the desktop mockup the client approves looks exactly as built.
*/
export const MOBILE_TAP_TARGET_CSS =
  "@media (max-width: 767px) { a, button, input[type=submit], input[type=button] { min-height: 44px; min-width: 44px; } }";

/* ---------- fixes aimed by class ---------- */

/*
  What the browser found, by element number (see element-marks.ts): text
  to recolor, and logos that vanish against what is behind them.
*/
export interface ElementFindings {
  contrast: {
    n: number;
    color: string;
    /* The colour the element had, for the run note; only set when code chose a different hue (F31, 9 November 2026). */
    from?: string;
    /* True when the colour it had was neither a brand colour nor a neutral, so a darker shade of it would have stayed off-brand. */
    offBrand?: boolean;
    /* True when the colour it had was plain white or plain black: no hue to keep, so a brand colour is used (10 November 2026). */
    colourless?: boolean;
    /* True when TAWD had already fixed this element and it is still failing: the page's own CSS is winning, so the rule is written stronger. */
    overridden?: boolean;
    /* The page's own selector that is overriding the fix, when one was found: the rule the builder should remove. */
    fighting?: string;
  }[];
  logos: { n: number; on: "light" | "dark" }[];
  /*
    Lines drawn in the colour of the background behind them, so nobody can
    see them (New Dawn Awning, 10 November 2026): the element, which side
    carries the line, and the colour it gets instead.
  */
  edges?: { n: number; side: string; color: string; from?: string }[];
}

/* One fixed rule per logo treatment: the class says which. */
/* The class is repeated for the same reason as the contrast rule above: it must beat the page's own CSS. */
export const LOGO_RULES = [
  "html body .tawd-logo-on-light.tawd-logo-on-light { filter: brightness(0) !important; }",
  "html body .tawd-logo-on-dark.tawd-logo-on-dark { filter: brightness(0) invert(1) !important; }",
];

const FIX_CLASS = /^tawd-fix-(\d+)$/;
const EDGE_CLASS = /^tawd-edge-(\d+)$/;

/** The selector a fix rule is kept under: one rule per selector. */
export function ruleSelector(rule: string): string {
  return rule.split("{")[0]!.trim();
}

/*
  What a fix rule is AIMED AT, with a repeated class counted once: the key a
  page's rules are kept under, so one element has one rule.

  The repetition is only there to out-rank the page's own CSS, and it
  changes with what code finds (two classes normally, three when the page
  was still beating the fix). Keyed by the raw selector, a second run would
  have left the first run's weaker rule sitting beside the new one, both
  with !important: the page would render from whichever came last, and the
  old colour would never go away. Rule 2 of docs/CODE-REVIEW-STANDARD.md -
  what is written while an artefact is made must hold when it is loaded
  back - found this before it shipped.
*/
export function ruleTarget(rule: string): string {
  /*
    The repeat has to end where the class name ends: without the lookahead,
    ".a.ab" would have had its ".a" matched inside ".ab" and come back
    ".ab", which is a different selector. Found by reading this line again
    rather than by a test failing.
  */
  return ruleSelector(rule).replace(/(\.[A-Za-z0-9_-]+)(?:\1(?![A-Za-z0-9_-]))+/g, "$1");
}

/* Rules from before the classes: aimed by position (body > div:nth-child(2) > ...). */
export function isPositionRule(rule: string): boolean {
  return /^body\s*>/.test(ruleSelector(rule));
}

/*
  Puts the findings on the page as classes, and returns the rules they
  need. A text element fixed before keeps its number, so its rule is
  replaced rather than doubled.
*/
export function applyElementFindings(html: string, findings: ElementFindings): { html: string; rules: string[] } {
  const changes = new Map<number, { add: string; remove?: RegExp }>();
  const rules: string[] = [];

  let next = Math.max(0, ...[...html.matchAll(/\btawd-fix-(\d+)\b/g)].map((m) => Number(m[1]))) + 1;
  for (const { n, color, overridden } of findings.contrast) {
    const known = elementClasses(html, n).map((c) => FIX_CLASS.exec(c)?.[1]).find(Boolean);
    const name = `tawd-fix-${known ?? next++}`;
    changes.set(n, { add: name });
    /*
      The class is repeated so the rule beats the page's own CSS (New Dawn,
      10 November 2026). "html body .tawd-fix-N" is specificity (0,1,2); the
      page had ".band-brand .form-card label{color:#fff !important}", which
      is (0,2,1), so with both marked !important the page's own rule won and
      TAWD's fix did nothing. The quote form shipped with white labels on a
      white card - five empty boxes - and the fix rounds kept re-fixing text
      that never changed, at full price, while every report said the
      contrast had been fixed.

      Twice makes it (0,2,2), which beats what a builder writes. Three times
      when the measurement says the fix STILL did not take, which is as far
      as this goes: an arms race is not a mechanism, so a third failure is
      reported as a run note naming the page's own rule instead (see
      rendered-fixes.ts), and the canary measures the page after the fixes
      rather than the rule TAWD wrote.
    */
    const aimed = overridden ? `.${name}.${name}.${name}` : `.${name}.${name}`;
    rules.push(`html body ${aimed} { color: ${color} !important; }`);
  }

  /*
    A line given a colour that can be seen. Its own class, not the contrast
    one: an element can need both fixes, and two rules under the same
    selector would leave one of them to overwrite the other when the page's
    rules are merged by what they aim at.
  */
  let nextEdge = Math.max(0, ...[...html.matchAll(/\btawd-edge-(\d+)\b/g)].map((m) => Number(m[1]))) + 1;
  for (const { n, side, color } of findings.edges ?? []) {
    const known = elementClasses(html, n).map((c) => EDGE_CLASS.exec(c)?.[1]).find(Boolean);
    const name = `tawd-edge-${known ?? nextEdge++}`;
    const already = changes.get(n);
    changes.set(n, { add: already ? `${already.add} ${name}` : name, ...(already?.remove ? { remove: already.remove } : {}) });
    rules.push(`html body .${name}.${name} { border-${side}-color: ${color} !important; }`);
  }

  for (const { n, on } of findings.logos) {
    const already = changes.get(n);
    changes.set(n, { add: already ? `${already.add} tawd-logo-on-${on}` : `tawd-logo-on-${on}`, remove: /^tawd-logo-on-/ });
  }
  if (findings.logos.length > 0) rules.push(...LOGO_RULES);

  return { html: setElementClasses(html, changes), rules };
}

/*
  Rules whose class is no longer on the page (a section was rewritten
  without it) are dropped; so are the old position rules.
*/
export function keepLiveRules(html: string, rules: string[]): string[] {
  const body = html.replace(FIX_STYLE_PATTERN, "");
  return rules.filter((rule) => {
    if (isPositionRule(rule)) return false;
    const fix = /\.(tawd-fix-\d+|tawd-edge-\d+|tawd-logo-on-(?:light|dark))\b/.exec(ruleSelector(rule));
    return !fix || new RegExp(`\\b${fix[1]}\\b`).test(body);
  });
}
