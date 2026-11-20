import type { CheckIssue } from "./checks";
import type { RunNote } from "./run-notes";
import { KIT_ICONS } from "../style-kit/icon-set";

/*
  Icons by code (Jason, 8 October 2026: Finley's mosquito icon was
  "something else"). The builder no longer draws icons: it writes
  <span class="icon" data-tawd-icon="mosquito"></span>, a plain word for
  what the icon shows, and code puts in the matching icon from TAWD's
  pinned set (Tabler Icons 3.48.0, MIT; see style-kit/icon-set.ts). Free,
  always the same family, and fewer output tokens than drawing SVG paths.

  Tabler has no mosquito, termite, ant or rat: insects get its "bug" (a clean,
  recognisable insect rather than a guess at a mosquito), rodents and other
  animals "paw".
*/

export const ICON_ATTR = "data-tawd-icon";

const WORD_ICONS: [RegExp, string][] = [
  [/\bspiders?\b/i, "spider"],
  [/\bbats?\b/i, "bat"],
  [/\b(mosquito(?:e?s)?|gnats?|fl(?:y|ies)|ants?|termites?|(?:cock)?roach(?:es)?|beetles?|fleas?|ticks?|bed ?bugs?|wasps?|hornets?|bees?|yellow ?jackets?|silverfish|earwigs?|crickets?|moths?|insects?|bugs?|pests?|stinging)\b/i, "bug"],
  [/\b(rodents?|rats?|mice|mouse|squirrels?|gophers?|moles?|voles?|raccoons?|skunks?|opossums?|wildlife|birds?|pigeons?|animals?|pets?|dogs?|cats?)\b/i, "paw"],
  [/\b(spray(?:ing)?|treatments?|fumigat\w*|exterminat\w*)\b/i, "spray"],
  [/\b(weeds?|lawns?|grass|yards?|landscap\w*|mow\w*)\b/i, "lawn-mower"],
  [/\b(trees?|arbor\w*|stumps?)\b/i, "trees"],
  [/\b(gardens?|plants?|shrubs?)\b/i, "plant"],
  [/\b(water ?heaters?|heaters?|furnaces?|heating|boilers?|gas)\b/i, "flame"],
  [/\b(air ?condition\w*|a\/?c|cooling)\b/i, "air-conditioning"],
  [/\b(hvac|thermostats?|temperature|ventilation|ducts?)\b/i, "temperature"],
  [/\b(drains?|sewers?|pipes?|piping|re-?pipe|plumb\w*|clogs?|hydro-?jet\w*|rooter)\b/i, "pipeline"],
  [/\b(leaks?|water|floods?|moisture|wet)\b/i, "droplet"],
  [/\b(bath\w*|showers?|toilets?|tubs?|faucets?|sinks?|fixtures?)\b/i, "bath"],
  [/\b(solar)\b/i, "solar-panel"],
  [/\b(electric\w*|wiring|panels?|power|generators?|lighting)\b/i, "bolt"],
  [/\b(outlets?|plugs?|sockets?)\b/i, "plug"],
  [/\b(windows?)\b/i, "window"],
  [/\b(glass|glazing|mirrors?|windshields?)\b/i, "glass"],
  [/\b(doors?)\b/i, "door"],
  [/\b(fenc\w*|gates?)\b/i, "fence"],
  [/\b(walls?|drywall|masonry|brick)\b/i, "wall"],
  [/\b(ladders?|gutters?|roof\w*)\b/i, "ladder"],
  [/\b(paint\w*)\b/i, "paint"],
  [/\b(clean\w*|vacuum\w*|carpets?|janitorial|maid)\b/i, "vacuum-cleaner"],
  [/\b(garages?)\b/i, "car-garage"],
  [/\b(fire|smoke|extinguish\w*)\b/i, "fire-extinguisher"],
  [/\b(legal|law|lawyers?|attorneys?|courts?|trials?|litigation)\b/i, "gavel"],
  [/\b(injur\w*|claims?|settlements?|justice|fair)\b/i, "scale"],
  [/\b(inspect\w*|assess\w*|diagnos\w*|search|find)\b/i, "search"],
  [/\b(emergenc\w*|24\s*\/\s*7|urgent|same[- ]day|fast|rapid)\b/i, "alarm"],
  [/\b(guarantee\w*|warrant\w*|licen[cs]ed|insured|bonded|protect\w*|safe\w*|prevent\w*|secure)\b/i, "shield-check"],
  /*
    Gap 10 (New Dawn Awning, 5 November 2026) sent every outdoor-living word
    here to the house, so that a patio or shade business would never get a
    wrench (which says repairs). It worked, and it cost more than it saved:
    retractable awnings, patio covers and sunrooms are three different
    things, and the rule made them three identical houses on one page, which
    is what the Creative Director then marked the concept down for.

    So the words that name a thing the pinned set has no icon for are gone
    from this rule, and fall through to the dot, which is reported (see
    UNKNOWN_ICON). "Outdoor living" and "backyard" stay: they name the place,
    and the place is the home.
  */
  [/\b(outdoor living|backyards?)\b/i, "home"],
  [/\b(home|homes|house|residential|household)\b/i, "home"],
  [/\b(commercial|business\w*|offices?|restaurants?|warehouses?|property managers?)\b/i, "building-store"],
  [/\b(phones?|call\w*)\b/i, "phone"],
  /*
    Texting and chat, before the envelope (New Dawn Awning, 10 November
    2026). The pinned set HAS a chat bubble, and "text" reached it - but
    only as that one word on its own, because it was an alias, and an alias
    is matched against the whole slot. The builder wrote "text us", so both
    "Call or text" links showed a plain dot and the concept lost points for
    an icon TAWD already owns. Nothing was missing from the set: the words
    were not reaching it.

    Whole words on purpose: "context" and "chateau" are not these words,
    and "e-mail" and "message" stay with the envelope on the next line.
  */
  [/\b(sms|texts?|texting|chats?|chatting)\b/i, "message-circle"],
  [/\b(e-?mail|message)\b/i, "mail"],
  // An address as a place ("Our address", "Address", "Directions"), never the verb ("we address every issue", review M5); "visit" stays the calendar's ("Book a visit").
  [/\b(locat\w*|areas?|map|local|near|cit(?:y|ies)|county|directions)\b|^\s*address(?:es)?\s*$|\b(?:our|the|shop|office|street|mailing|business|physical)\s+address(?:es)?\b/i, "map-pin"],
  [/\b(hours|time|on[- ]time|minutes)\b/i, "clock"],
  [/\b(calendar|appointments?|book\w*|schedul\w*)\b/i, "calendar"],
  [/\b(price\w*|pricing|quotes?|estimates?|costs?|affordable|financ\w*|\$)\b/i, "currency-dollar"],
  [/\b(stars?|rating|reviews?)\b/i, "star"],
  [/\b(awards?|best)\b/i, "award"],
  [/\b(teams?|people|staff|crew|technicians?|experts?)\b/i, "users"],
  [/\b(trucks?|vans?|fleet|mobile)\b/i, "truck"],
  [/\b(eco|green|organic|natural|environment\w*)\b/i, "leaf"],
  [/\b(famil\w*|kids|children|care)\b/i, "heart"],
  // "Service" alone says nothing about repairs (gap 10: New Dawn's "main service" got a wrench); it falls to the trade's icon.
  [/\b(tools?|repairs?|fix\w*|install\w*|maintenance)\b/i, "tool"],
  [/\b(checks?|done|complete)\b/i, "circle-check"],
];

/*
  A word TAWD has no icon for (Jason's call, 9 November 2026).

  Until today an unresolved word fell back to the trade's own icon, or to a
  house: gap 10, 8 October 2026, which was itself a fix — Sacramento
  Plumbing's sewer, repiping and "more" arrows had been getting a plain
  tick. New Dawn Awning showed what the fallback really does. Retractable
  awnings, patio covers and sunrooms are three different things, none of
  them in the icon set, so the page showed three identical houses, and the
  Creative Director marked the concept down for icons the builder never
  chose.

  A dot instead. It is the only mark in the pinned set that claims nothing:
  a star says quality, a tick says included, sparkles say new. This is the
  rule Jason set for photographs the day before — when TAWD cannot find the
  right one it says so plainly rather than showing the wrong one — and
  every dot is reported, as a run note and as a warning on the checks, so
  the team sees that TAWD had no icon rather than thinking it chose badly.

  The dots are the measurement too: they name the words the icon set is
  missing, from real runs instead of from anybody's guess.
*/
export const UNKNOWN_ICON = "point";

/* Common words for an icon that aren't the icon set's own names. */
const ALIASES: Record<string, string> = {
  arrow: "arrow-right",
  "arrow-right": "arrow-right",
  next: "arrow-right",
  more: "arrow-right",
  chevron: "chevron-down",
  warning: "alert-triangle",
  alert: "alert-triangle",
  caution: "alert-triangle",
  danger: "alert-triangle",
  info: "info-circle",
  question: "help-circle",
  help: "help-circle",
  menu: "menu-2",
  close: "x",
  check: "circle-check",
  tick: "circle-check",
  done: "circle-check",
  location: "map-pin",
  pin: "map-pin",
  address: "map-pin",
  chat: "message-circle",
  sms: "message-circle",
  text: "message-circle",
  email: "mail",
  quote: "quote",
  dollar: "currency-dollar",
};

const KIT_NAMES = new Set(KIT_ICONS.filter((i) => i.style === "outline").map((i) => i.name));

/** How an icon was arrived at. `unknown` means TAWD had none for the word and used the dot. */
export type IconFoundBy = "name" | "alias" | "word" | "context" | "unknown";

/*
  The icon for a word or phrase, and how it was found, in order: the icon
  set's own name ("clock", "shovel"), a common alias ("arrow", "warning"),
  the word rules (stems too: "repiping", "faucets"), then `context` (the
  card's heading, when the word told nothing) — and then nothing, because
  anything else would be a guess. See UNKNOWN_ICON.
*/
export function iconChoice(word: string, options: { context?: string | null } = {}): { name: string; by: IconFoundBy } {
  const plain = word.trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (KIT_NAMES.has(plain)) return { name: plain, by: "name" };
  if (ALIASES[plain]) return { name: ALIASES[plain]!, by: "alias" };
  const byWord = WORD_ICONS.find(([pattern]) => pattern.test(word) || pattern.test(stemmed(word)))?.[1];
  if (byWord) return { name: byWord, by: "word" };
  if (options.context) {
    const byContext = WORD_ICONS.find(([pattern]) => pattern.test(options.context!) || pattern.test(stemmed(options.context!)))?.[1];
    if (byContext) return { name: byContext, by: "context" };
  }
  return { name: UNKNOWN_ICON, by: "unknown" };
}

/** Just the icon's name. */
export function iconFor(word: string, options: { context?: string | null } = {}): string {
  return iconChoice(word, options).name;
}

/* "repiping" -> "re pipe", "faucets" -> "faucet": so the rules' word boundaries match. */
function stemmed(text: string): string {
  return text
    .toLowerCase()
    .replace(/^re-?(?=[a-z]{3})/g, "re ")
    .replace(/\bre(?=pip)/g, "re ")
    .replace(/(ing|s)\b/g, "")
    .replace(/pip\b/g, "pipe");
}

/* The icon as inline SVG in the outline style, sized by the text and coloured by currentColor. */
export function iconSvg(name: string): string {
  const icon = KIT_ICONS.find((i) => i.name === name && i.style === "outline") ?? KIT_ICONS.find((i) => i.name === UNKNOWN_ICON && i.style === "outline")!;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${icon.body}</svg>`;
}

/* An icon slot the builder left empty: <span data-tawd-icon="mosquito"></span> (or i, div, b), with nothing inside. */
const EMPTY_SLOT = new RegExp(`<(span|i|div|b|em)\\b([^>]*\\s${ICON_ATTR}\\s*=\\s*["']([^"']*)["'][^>]*)>\\s*<\\/\\1>`, "gi");
/* A slot already filled (an icon TAWD put in before, kept or copied by the builder): its whole element. */
const FILLED_SLOT = new RegExp(`<(span|i|div|b|em)\\b([^>]*\\s${ICON_ATTR}\\s*=\\s*["']([^"']*)["'][^>]*)>\\s*<svg\\b[\\s\\S]*?<\\/svg>\\s*<\\/\\1>`, "gi");

/* The text of the next heading after a position: what the card or line the icon sits in is about. */
function headingAfter(html: string, at: number): string | null {
  const next = /<(h[2-5]|strong)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(html.slice(at, at + 600));
  return next ? next[2]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || null : null;
}

/*
  Fills every empty icon slot, and with `refill`, puts the right icon in
  slots already filled (a site build copies the concept's icons, ticks and
  all). Running it twice changes nothing more.
*/
export function fillIcons(html: string, options: { refill?: boolean } = {}): { html: string; filled: number; notes: RunNote[] } {
  let filled = 0;
  const notes: RunNote[] = [];
  const choose = (word: string, context: string | null) => {
    const choice = iconChoice(word, { context });
    if (choice.by === "unknown") {
      notes.push({
        step: "icons",
        action: "substituted",
        what: `"${word.trim() || "a slot with no word"}"`,
        with: "a plain dot",
        why: "TAWD's icon set has no icon for that word, and a near-enough one would say something the page never said",
      });
    }
    return choice.name;
  };
  const fill = (all: string, tag: string, attrs: string, word: string, offset: number) => {
    const name = choose(word, headingAfter(html, offset + all.length));
    const cleanAttrs = attrs.replace(/\s+data-tawd-icon-name\s*=\s*["'][^"']*["']/i, "");
    const out = `<${tag}${cleanAttrs} data-tawd-icon-name="${name}">${iconSvg(name)}</${tag}>`;
    if (out !== all) filled += 1;
    return out;
  };
  let out = html.replace(EMPTY_SLOT, (all, tag: string, attrs: string, word: string, offset: number) => fill(all, tag, attrs, word, offset));
  if (options.refill) {
    const source = out;
    out = source.replace(FILLED_SLOT, (all, tag: string, attrs: string, word: string, offset: number) => {
      const before = /data-tawd-icon-name\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
      const name = choose(word, headingAfter(source, offset + all.length));
      if (before === name) return all;
      filled += 1;
      const cleanAttrs = attrs.replace(/\s+data-tawd-icon-name\s*=\s*["'][^"']*["']/i, "");
      return `<${tag}${cleanAttrs} data-tawd-icon-name="${name}">${iconSvg(name)}</${tag}>`;
    });
  }
  return { html: out, filled, notes };
}

/* A slot TAWD filled with the dot, and the word it was asked for. The name is appended last, so it follows the word. */
const UNKNOWN_FILLED = new RegExp(
  `<(?:span|i|div|b|em)\\b[^>]*\\s${ICON_ATTR}\\s*=\\s*["']([^"']*)["'][^>]*\\sdata-tawd-icon-name\\s*=\\s*["']${UNKNOWN_ICON}["'][^>]*>`,
  "gi",
);

/*
  The words on this page that TAWD has no icon for, each named once. A slot
  that asked for the dot by name is not one of them - it got exactly what it
  asked for - so "point" is never reported as a word with no icon.
*/
export function iconWordsWithNoIcon(html: string): string[] {
  const words = [...html.matchAll(UNKNOWN_FILLED)]
    .map((m) => (m[1] ?? "").replace(/\s+/g, " ").trim())
    .filter((word) => word.length > 0 && word.toLowerCase() !== UNKNOWN_ICON);
  return [...new Set(words)];
}

/*
  The checks: empty icon slots, which code fills; and the words it had no
  icon for, which it cannot. The second is a warning, not a fail — the page
  is honest, it just has a dot where a picture of the thing would be better
  — and it is here so the team and the Creative Director read "TAWD has no
  icon for this" instead of deciding the builder chose badly.
*/
export function checkIcons(html: string): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const empty = html.match(EMPTY_SLOT) ?? [];
  if (empty.length > 0) {
    issues.push({
      id: "icons.unfilled",
      severity: "fail",
      message: `${empty.length} icon slot${empty.length === 1 ? " is" : "s are"} empty; TAWD fills ${empty.length === 1 ? "it" : "them"} from its icon set.`,
    });
  }
  const unknown = iconWordsWithNoIcon(html);
  if (unknown.length > 0) {
    issues.push({
      id: "icons.noIcon",
      severity: "warn",
      message: `TAWD's icon set has no icon for ${unknown.length === 1 ? "this word" : "these words"}, so ${unknown.length === 1 ? "its slot shows" : "their slots show"} a plain dot: ${unknown.map((w) => `"${w}"`).join(", ")}.`,
    });
  }
  return issues;
}

/** The rule for the builder, in place of drawing icons. */
export const ICON_RULE = `- Icons: never draw an icon's SVG yourself. Write an empty slot, <span class="icon" ${ICON_ATTR}="word"></span>, where word is a plain word for what it shows, for example mosquito, termite, rodent, spider, drain, water heater, air conditioning, window, phone, clock, calendar, map, shield, home, price. TAWD fills each slot with a matching icon from one icon family, drawn with currentColor at 1em: size and colour the slot with CSS (font-size and color). No emoji.`;
