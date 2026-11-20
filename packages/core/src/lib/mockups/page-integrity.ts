import type { CheckIssue } from "./checks";
import { splitSections } from "./sections";

/*
  Is it still a page? (9 November 2026, after the Sample Rooter run.)

  Every check TAWD had tested for something being *present*: an H1, a title,
  a phone link, a form, a photo. All of them pass on a page that is nothing
  but its hero, because the hero holds every one of those things. So a
  concept whose document had collapsed went through a fix round, a critique,
  a polish pass and a scoring pass, and was shown to the team as finished.

  These checks ask the opposite question: is the thing we built still a
  whole, well-formed page? They are deliberately cheap and certain —
  counting and comparing, no judgment, no browser (the rendered half of the
  answer is structure.collapsed, in the worker's rendered checks).

  Scope: a full page. Every caller of runHtmlChecks passes one.
*/

/*
  Comments, <script> and <style> hold characters that look like markup
  ("</div>" in a CSS content string, a tag inside a comment). The structure
  checks never read them.
*/
export function withoutNonMarkup(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
}

/* How many bands the markup asks for, ignoring anything written inside a script, a style or a comment. */
export function countSections(html: string): number {
  return (withoutNonMarkup(html).match(/<section\b/gi) ?? []).length;
}

function countTag(html: string, tag: string): { open: number; close: number } {
  return {
    open: (html.match(new RegExp(`<${tag}\\b`, "gi")) ?? []).length,
    close: (html.match(new RegExp(`</${tag}\\s*>`, "gi")) ?? []).length,
  };
}

/*
  The band containers the builder writes on purpose. <div> is left out: it
  is the most numerous tag on a page and the likeliest to be miscounted by
  a text scan, and a document cut short is already caught by the <html>,
  <body> and <style> rules below.
*/
const BAND_TAGS = ["section", "main", "header", "footer"] as const;

/*
  A reply that ran out of room mid-document (claude.ts refuses these at
  source since 9 November 2026; this is the second line of defence, and it
  also catches a page broken by an edit that spliced badly).
*/
export function checkDocumentComplete(html: string): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const markup = withoutNonMarkup(html);

  /*
    Read from the stripped markup, never the raw page: a "</html>" written
    inside a script string or a comment would otherwise hide a document
    that stops early (CodeRabbit, PR #59).
  */
  const cutOff: string[] = [];
  if (/<html\b/i.test(markup) && !/<\/html\s*>/i.test(markup)) cutOff.push("</html>");
  if (/<body\b/i.test(markup) && !/<\/body\s*>/i.test(markup)) cutOff.push("</body>");
  // An unterminated <style> swallows the rest of the document: every band after it renders unstyled.
  const style = countTag(html, "style");
  if (style.open > style.close) cutOff.push("</style>");

  if (cutOff.length > 0) {
    issues.push({
      id: "structure.truncated",
      severity: "fail",
      message: `The page stops before it is finished: ${cutOff.join(", ")} ${cutOff.length === 1 ? "is" : "are"} missing. Write the whole page, from <!doctype html> to </html>.`,
    });
  }

  for (const tag of BAND_TAGS) {
    const { open, close } = countTag(markup, tag);
    if (open === close) continue;
    issues.push({
      id: "structure.unbalanced",
      severity: "fail",
      where: `<${tag}>`,
      message:
        open > close
          ? `${open - close} <${tag}> element${open - close === 1 ? " is" : "s are"} never closed. Every <${tag}> needs its </${tag}>.`
          : `${close - open} </${tag}> closing tag${close - open === 1 ? " has" : "s have"} no opening <${tag}>.`,
    });
  }

  return issues;
}

/*
  Two elements with the same id (Jason's Sample Marketing Co. run, 9 November 2026:
  a section the edit copied instead of moved left the page with two
  id="services"). Invalid HTML, and it breaks every "#id" link on the page.
*/
export function checkDuplicateIds(html: string): CheckIssue[] {
  const seen = new Map<string, number>();
  for (const match of withoutNonMarkup(html).matchAll(/\sid\s*=\s*["']([^"']+)["']/gi)) {
    const id = match[1]!.trim();
    if (id) seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  const repeated = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  if (repeated.length === 0) return [];
  return [
    {
      id: "structure.duplicate_id",
      severity: "fail",
      where: repeated.slice(0, 5).join(", "),
      message: `${repeated.length} id${repeated.length === 1 ? " is" : "s are"} used more than once (${repeated.slice(0, 5).join(", ")}${repeated.length > 5 ? ", ..." : ""}). An id belongs to one element only; usually it means a section was copied instead of moved.`,
    },
  ];
}

/** A band's words, for comparing one band with another. */
function bandText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/*
  Short enough to be a repeated call-to-action strip ("Not sure which
  service? Your first consultation is free. Call ...") rather than a band
  the page shows twice by mistake.
*/
const SHORTEST_REAL_BAND = 60;
/** Two bands count as the same when this much of their words matches. */
const COMPARE_CHARS = 300;

/*
  The same band twice (Sample Marketing Co., 9 November 2026: the whole services
  band — heading, photo and eight cards — appeared before and after How we
  work, because a move copied it). Compared by words, so a repeated layout
  with different content is fine.
*/
export function checkDuplicateBands(html: string): CheckIssue[] {
  const seen = new Map<string, number>();
  for (const band of splitSections(html)) {
    const text = bandText(band.html);
    if (text.length < SHORTEST_REAL_BAND) continue;
    const key = text.slice(0, COMPARE_CHARS);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const repeated = [...seen.entries()].filter(([, n]) => n > 1);
  if (repeated.length === 0) return [];
  const first = repeated[0]![0].slice(0, 60);
  return [
    {
      id: "structure.duplicate_band",
      severity: "fail",
      evidence: first,
      message: `The page shows the same band ${repeated.length === 1 ? "twice" : `${repeated.length} times over`}: "${first}...". Keep one and delete the other; a band is never repeated word for word.`,
    },
  ];
}

export function checkPageIntegrity(html: string): CheckIssue[] {
  return [...checkDocumentComplete(html), ...checkDuplicateIds(html), ...checkDuplicateBands(html)];
}
