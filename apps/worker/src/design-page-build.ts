import type Anthropic from "@anthropic-ai/sdk";

import { requestSettings } from "@tawd/core/mockups";
import { buildDesignPagePlanPrompt, buildDesignPageSystemPrompt, type PromptPlan } from "@tawd/core/site/design-page-build";
import { designSpecFrom, type BuildPlan } from "@tawd/core/figma/build-spec";

import { compareSpecWords, wordsOf } from "./design-checks";
import { imageBlock } from "./image-type";

/*
  The one build call of the new Lane 2 route (E5a, 15 November 2026; spec 15
  section 6 stage 4), and the checks run on what it sends back before anyone
  is shown the page.

  The checks here are plain code on the HTML text: no browser, no cost, run
  the moment the reply arrives. They are not the real measurement -- that is
  E2's checks in a real browser, which E5b runs -- but they catch the kind
  of thing the paid run of 15 November produced and called "done": whole
  bands with no words, the menu cut down to one item, pictures never placed.
  Catching it here means the correction rounds start from a page worth
  correcting, and a build that came back broken is never shown as finished.
*/

/*
  Room to finish the page.

  The measured run of 15 November wrote 20,000 to 28,000 output tokens for
  this page alone (spec 15 section 13), and the model's thinking counts
  against the same limit, so 32,000 would cut a long page off part-way --
  which shows up as half a page and the note that it ran out of room. The
  reply is streamed, so a high limit costs nothing that is not written.
*/
export const MAX_TOKENS = 64_000;

/** What the model sent back, with whatever code found wrong with it. */
export interface BuiltDesignPage {
  html: string;
  problems: string[];
}

/** The plan in the shape the prompt wants. */
export function promptPlan(plan: BuildPlan): PromptPlan {
  return {
    width: plan.width,
    height: plan.height,
    bands: plan.bands.map((b) => ({
      name: b.name,
      role: b.role,
      top: b.top,
      height: b.height,
      words: b.words.map((w) => ({ text: w.text, role: w.role, box: w.box, unsure: w.unsure })),
      pictures: b.pictures.map((p) => ({ name: p.name, kind: p.kind, box: p.box, file: p.file, icon: p.icon })),
      fonts: b.fonts,
    })),
    menu: plan.menu.map((m) => ({ text: m.text, href: m.href })),
    colours: plan.colours.map((c) => ({ name: c.name, hex: c.hex })),
  };
}

/* Everything between <style> or <script> and its end, dropped; then the tags. */
function visibleText(html: string): string {
  return html
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_m, n: string) => safeChar(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => safeChar(parseInt(n, 16)))
    .replace(/&([a-z]+\d*);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

/*
  The named characters a built page actually uses. Decoding only a handful
  left the rest as junk words ("rsquo", "mdash"), which the word check then
  reported as words the design does not have and words of the design that
  are missing: a correct page accused twice over.
*/
const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  rsquo: "\u2019",
  lsquo: "\u2018",
  rdquo: "\u201d",
  ldquo: "\u201c",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  deg: "\u00b0",
  times: "\u00d7",
  middot: "\u00b7",
  eacute: "\u00e9",
  bull: "\u2022",
};

function safeChar(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
}

function count(html: string, re: RegExp): number {
  return (html.match(re) ?? []).length;
}

/**
 * What is wrong with the page the build sent back.
 *
 * An empty list means it is worth looking at, not that it is right: the
 * real measurement is E2's checks in a browser. Each line is written for
 * a person to read, because each one is shown on the build's screen.
 */
export function pageProblems(html: string, plan: BuildPlan): string[] {
  const problems: string[] = [];
  const page = html.trim();

  if (!/<html[\s>]/i.test(page) || !/<\/html>/i.test(page)) {
    return ["The build did not send back a whole web page."];
  }

  const styles = count(page, /<style\b/gi);
  if (styles === 0) problems.push("The page has no stylesheet, so nothing is laid out or coloured.");
  else if (styles > 1) problems.push(`The page has ${styles} stylesheets; it should have one.`);

  if (/<script\b/i.test(page)) problems.push("The page has JavaScript in it. A built page must work without any.");

  /*
    What the page FETCHES from elsewhere, which is not the same as what it
    links to. A footer link to the client's own Facebook page is ordinary
    and must not be reported; a picture, stylesheet, font or frame pulled
    from another address is the thing that must never happen. Checking
    `href` of any kind reported every social link as a fault.
  */
  const outside = [
    ...(page.match(/\bsrc\s*=\s*["']?(?:https?:)?\/\/[^"'\s>]+/gi) ?? []),
    ...(page.match(/\bsrcset\s*=\s*["'][^"']*(?:https?:)?\/\/[^"']*/gi) ?? []),
    ...(page.match(/url\(\s*["']?(?:https?:)?\/\/[^)]+/gi) ?? []),
    ...(page.match(/@import\s+["'](?:https?:)?\/\/[^"']+/gi) ?? []),
    ...(page.match(/<link\b[^>]*href\s*=\s*["']?(?:https?:)?\/\/[^"'\s>]+/gi) ?? []),
  ];
  if (outside.length) problems.push(`The page loads ${outside.length === 1 ? "something" : `${outside.length} things`} from the internet; everything must come from the design.`);
  if (/<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i.test(page)) problems.push("The page sends the browser somewhere else on its own. A built page never does that.");

  const h1s = count(page, /<h1[\s>]/gi);
  if (h1s === 0) problems.push("The page has no main heading.");
  else if (h1s > 1) problems.push(`The page has ${h1s} main headings; it should have one.`);

  // Every prepared picture placed, and every matched icon drawn.
  const missingFiles = plan.bands
    .flatMap((b) => b.pictures)
    .filter((p) => p.file !== null && !page.includes(p.file))
    .map((p) => p.name);
  if (missingFiles.length) problems.push(`${missingFiles.length === 1 ? "A picture was" : `${missingFiles.length} pictures were`} prepared but not placed on the page: ${missingFiles.join(", ")}.`);

  const missingIcons = [...new Set(plan.bands.flatMap((b) => b.pictures).filter((p) => p.icon !== null && !page.includes(`data-kit-icon="${p.icon}"`)).map((p) => p.icon!))];
  if (missingIcons.length) problems.push(`${missingIcons.length === 1 ? "An icon is" : `${missingIcons.length} icons are`} missing from the page: ${missingIcons.join(", ")}.`);

  // P-4: the menu is drawn in full or the build has failed.
  const text = visibleText(page);
  const built = wordsOf(text);
  const lostMenu = plan.menu.filter((m) => {
    const want = wordsOf(m.text);
    return want.length > 0 && !hasRun(built, want);
  });
  if (lostMenu.length) problems.push(`${lostMenu.length === 1 ? "A menu item is" : `${lostMenu.length} menu items are`} missing from the page: ${lostMenu.map((m) => `"${m.text}"`).join(", ")}.`);

  /*
    P-1: a band that was given words and did not draw them.

    Counted run by run, not "did any of them appear". Without a browser
    this cannot tell WHERE on the page a word is, so a band whose every
    run appears somewhere passes even if they landed in the wrong band --
    that is for E5b to measure. What it does catch, and what the paid run
    produced, is a band whose words are simply not on the page at all.
    Asking only for one run meant a band of nine paragraphs passed on the
    strength of a single "Learn more" in the hero.
  */
  const blank: string[] = [];
  const partial: string[] = [];
  for (const b of plan.bands) {
    const runs = b.words.filter((w) => !w.unsure).map((w) => wordsOf(w.text)).filter((r) => r.length > 0);
    if (runs.length === 0) continue;
    const found = runs.filter((r) => hasRun(built, r)).length;
    if (found === 0) blank.push(b.name);
    else if (found < runs.length) partial.push(`${b.name} (${runs.length - found} of ${runs.length} missing)`);
  }
  if (blank.length) problems.push(`${blank.length === 1 ? "A band has" : `${blank.length} bands have`} none of their words on the page: ${blank.join(", ")}.`);
  if (partial.length) problems.push(`${partial.length === 1 ? "A band is" : `${partial.length} bands are`} missing some of their words: ${partial.join(", ")}.`);

  // P-5: a phone number, address, price or date re-shaped into a tidier
  // form. The word check cannot see this at all -- it drops punctuation, so
  // "(775) 238-9814" and "775-238-9814" are the same words to it. Any run
  // with a number in it must appear character for character; when its
  // digits are on the page but its shape is not, the build re-formatted it.
  const flat = text.replace(/\s+/g, " ");
  const pageDigits = flat.replace(/\D+/g, "");
  const reshaped = plan.bands
    .flatMap((b) => b.words)
    .filter((w) => !w.unsure && /\d/.test(w.text))
    .map((w) => w.text.replace(/\s+/g, " ").trim())
    .filter((want) => want !== "" && !flat.includes(want) && pageDigits.includes(want.replace(/\D+/g, "")))
    .filter((want, i, all) => all.indexOf(want) === i);
  if (reshaped.length) {
    problems.push(
      `${reshaped.length === 1 ? "This was re-written into a different shape" : `${reshaped.length} of these were re-written into a different shape`}; the design's own wording must be kept: ${reshaped.map((w) => `"${w}"`).join(", ")}.`,
    );
  }

  // Everything else the design says and the page does not.
  const spec = designSpecFrom(plan);
  const { missing } = compareSpecWords(spec.words, built);
  if (missing.length) {
    const some = missing.slice(0, 8).join(" ");
    problems.push(`${missing.length} of the design's words are not on the page${missing.length > 8 ? ` (the first few: ${some})` : `: ${some}`}.`);
  }

  return problems;
}

/** Whether `want` appears in `built` as a run, in order. */
function hasRun(built: string[], want: string[]): boolean {
  if (want.length === 0) return false;
  for (let i = 0; i + want.length <= built.length; i += 1) {
    let ok = true;
    for (let j = 0; j < want.length; j += 1) {
      if (built[i + j] !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/** Whatever the model wrapped the page in, removed. */
export function pageFromReply(reply: string): string {
  const fenced = reply.match(/```(?:html)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1]! : reply).trim();
  const start = body.search(/<!doctype html|<html[\s>]/i);
  return start > 0 ? body.slice(start).trim() : body;
}

/** The one call: the design picture and the plan in, one page out. */
export async function buildDesignPage(input: {
  client: Anthropic;
  model: string;
  profileText: string;
  clientName: string;
  plan: BuildPlan;
  picture: Buffer;
  onUsage: (usage: Anthropic.Usage, stopReason: string | null, content: Anthropic.ContentBlock[]) => Promise<void>;
}): Promise<BuiltDesignPage> {
  /*
    No cache_control: E5a makes ONE call per build, and the instructions
    carry the client's name, so nothing is ever read back from that cache.
    Writing it is a surcharge for no saving. It belongs here once E5b's
    correction rounds make several calls against the same instructions.
  */
  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: buildDesignPageSystemPrompt({ profileText: input.profileText, clientName: input.clientName }) }];
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: [imageBlock(input.picture), { type: "text", text: buildDesignPagePlanPrompt(promptPlan(input.plan)) }],
    },
  ];

  const response = await input.client.messages
    .stream({ model: input.model, max_tokens: MAX_TOKENS, system, messages, ...requestSettings(input.model, { effort: "low" }) })
    .finalMessage();
  await input.onUsage(response.usage, response.stop_reason, response.content);

  const reply = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const html = pageFromReply(reply);

  const problems = pageProblems(html, input.plan);
  // Why a page came back wrong, when the reply itself says: first in the list.
  if (response.stop_reason === "max_tokens") problems.unshift("The build ran out of room before it finished the page.");
  if (response.stop_reason === "refusal") problems.unshift("The build refused to write this page. Nothing is wrong with TAWD; look at the design's own words.");
  if (html.trim() === "") problems.unshift("The build sent nothing back at all.");
  return { html, problems };
}
