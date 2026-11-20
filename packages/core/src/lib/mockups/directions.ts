import type { Trade } from "../enums";

/*
  The thirteen design directions and how TAWD pre-selects them.

  Straight from skills/DIRECTIONS.md, which is authoritative. Two rules there
  do real work and are easy to lose:

  - Every concept in a run uses a *different* design skill, so the three
    genuinely differ rather than being one skill's house style three times.
  - An emergency trade always gets one Bold Emergency concept. Somebody with
    a burst pipe is not browsing.

  The PM can override any pick. This only decides what the form starts with.
*/

export const skillIds = ["ui_ux_pro_max", "impeccable", "taste"] as const;
export type SkillId = (typeof skillIds)[number];

export const skillLabels: Record<SkillId, string> = {
  ui_ux_pro_max: "UI UX Pro Max",
  impeccable: "Impeccable",
  taste: "Taste Skill",
};

/** The folder under /skills, which is read-only and pinned. */
export const skillFolders: Record<SkillId, string> = {
  ui_ux_pro_max: "ui-ux-pro-max-tawd",
  impeccable: "impeccable-tawd",
  taste: "taste-skill-tawd",
};

export const directionIds = [
  "classic_trust",
  "bold_emergency",
  "modern_clean",
  "warm_local",
  "premium_upscale",
  "rugged_craftsman",
  "editorial_authority",
  "bright_friendly",
  "technical_precision",
  "heritage_established",
  "clinical_calm",
  "brand_led",
  "gallery_portfolio",
] as const;
export type DirectionId = (typeof directionIds)[number];

export interface Direction {
  id: DirectionId;
  label: string;
  /** One line, shown under the picker on the setup screen. */
  description: string;
  /** The skill that handles this direction most naturally. */
  bestSkill: SkillId;
  /** Any skill can build a Brand-Led concept, since the brand decides it. */
  anySkill?: boolean;
  /** Only offered when the intake gives a founding year we can verify. */
  needsFoundingYear?: boolean;
  /** Extra rules for the builder, beyond the one-line description. */
  buildNote?: string;
  /*
    A3+C1 (the design-skills diagnosis, 8 November 2026): the directions used
    to differ by one line of adjectives over one shared skeleton, so the
    concepts converged. Each direction now carries structural variants — hero
    archetypes, a section-order twist, how the brand colour is deployed — and
    code DEALS one of each per concept (dealStructure), so two projects'
    Classic Trust concepts get different shapes, not re-skins of one.
  */
  structure?: {
    /** Hero archetypes that suit this direction; the dealt one is binding. */
    heroes: string[];
    /** Section-order twists on the standard run (hero → trust → services → process → reviews → areas → CTA). */
    orders: string[];
    /** How the full brand colour is deployed on the page. */
    brand: string[];
  };
}

export const directions: Record<DirectionId, Direction> = {
  classic_trust: {
    id: "classic_trust",
    label: "Classic Trust",
    description:
      "Deep brand color, sturdy type, an orderly layout, credentials up front.",
    bestSkill: "ui_ux_pro_max",
    structure: {
      heroes: [
        "a split hero: the headline and the credentials left, the quote form right",
        "a full-bleed photograph to the viewport edges, the headline and one call to action over it, a stat strip along its bottom edge",
      ],
      orders: ["the trust band (credentials as a stat strip) directly under the hero, services after", "services first, then one strong customer quote before the process"],
      brand: ["as bands: an early full-colour band and the call-to-action band", "as ground: the hero sits on the brand colour, one more full band at the call to action"],
    },
  },
  bold_emergency: {
    id: "bold_emergency",
    label: "Bold Emergency",
    description:
      "High contrast, a huge tap-to-call number, one urgent accent, almost no motion.",
    bestSkill: "ui_ux_pro_max",
    structure: {
      heroes: [
        "a call-first hero: the phone number set as large as the headline, the one urgent accent on it",
        "a split hero: the emergency promise and the number left, a three-field quote form right",
      ],
      orders: ["the three-step 'what happens when you call' directly under the hero", "services as big tap targets directly under the hero, the process after"],
      brand: ["as ground: the hero on the brand colour, the accent only on the call button", "as bands: the hero pale with the accent on the number, full-colour bands at the trust strip and the call to action"],
    },
  },
  modern_clean: {
    id: "modern_clean",
    label: "Modern Clean",
    description:
      "Lots of white space, a crisp sans-serif, one accent color and a clean grid.",
    bestSkill: "impeccable",
    structure: {
      heroes: [
        "a typographic hero: the headline huge on white, a thin stat strip under it, no photo in the hero",
        "a full-bleed photograph to the viewport edges, the headline over it in the crisp sans",
      ],
      orders: ["services as the clean grid directly under the hero", "one project photograph full-width under the hero, then services"],
      brand: ["as ink: headings and buttons carry the brand colour, one full band at the call to action", "as bands: one early, one at the call to action"],
    },
  },
  warm_local: {
    id: "warm_local",
    label: "Warm Local",
    description:
      "A warm palette, friendly type and people-first imagery with a neighborhood feel.",
    bestSkill: "taste",
    structure: {
      heroes: [
        "a full-bleed photograph of people or a home to the viewport edges, a warm scrim, the headline over it",
        "a split hero: a friendly welcome and the phone left, a people photo right, slightly overlapping the band below",
      ],
      orders: ["one customer's words right under the hero, then services", "the neighbourhood (service-area) band early, right after services"],
      brand: ["as bands: a warm full-colour band early and at the call to action", "as ground: the reviews band on the brand colour, plus the call to action"],
    },
  },
  premium_upscale: {
    id: "premium_upscale",
    label: "Premium Upscale",
    description:
      "Refined serif, a muted rich palette, generous space and large imagery.",
    bestSkill: "taste",
    structure: {
      heroes: [
        "a full-bleed photograph to the viewport edges, the serif headline set over generous space",
        "a typographic hero: the serif headline huge on the pale ground, one large photograph directly beneath, edge to edge",
      ],
      orders: ["the work first: a large project image band under the hero, the process after", "a short manifesto line under the hero, then services as large imagery"],
      brand: ["as ink: the serif headings in the brand colour, one deep full band at the call to action", "as a photo-led rhythm: photo bands carry the page, one full band at the call to action"],
    },
  },
  rugged_craftsman: {
    id: "rugged_craftsman",
    label: "Rugged Craftsman",
    description:
      "Earth and steel tones, strong condensed type, subtle texture, equipment imagery.",
    bestSkill: "impeccable",
    structure: {
      heroes: [
        "a full-bleed photograph of the work or the rig to the viewport edges, the condensed headline over it",
        "a split hero: the headline and a parts/labour fact left, an equipment photo right",
      ],
      orders: ["the work band (jobs done) directly under the hero, services after", "the three-step process early, told in the trade's own words"],
      brand: ["as bands: an earth-tone full band early and at the call to action", "as ground: the stat strip on the brand colour under the hero, plus the call to action"],
    },
  },
  editorial_authority: {
    id: "editorial_authority",
    label: "Editorial Authority",
    description:
      "Magazine typography, strong headlines, proof told as stories.",
    bestSkill: "taste",
    structure: {
      heroes: [
        "a typographic hero: a magazine headline huge on the ground, a standfirst line, no photo in the hero",
        "a split hero: the headline left like a front page, one strong photograph right with a caption",
      ],
      orders: ["one proof story (a real job, told in three sentences) directly under the hero", "services as a contents-like index early, each with a one-line story"],
      brand: ["as ink: headlines and rules in the brand colour, one full band at the call to action", "as bands: a full-colour pull-quote band mid-page and the call to action"],
    },
  },
  bright_friendly: {
    id: "bright_friendly",
    label: "Bright and Friendly",
    description: "Cheerful colors, rounded shapes, approachable icons.",
    bestSkill: "ui_ux_pro_max",
    structure: {
      heroes: [
        "a split hero: a cheerful headline left, a photo in a rounded frame right",
        "a full-bleed photograph with a bright scrim, the headline and one rounded call to action over it",
      ],
      orders: ["services as rounded cards directly under the hero", "a happy-customer quote band early, services after"],
      brand: ["as bands: three full-colour bands (early, middle, the call to action)", "as bands plus a photo-led band that counts toward the rhythm"],
    },
  },
  technical_precision: {
    id: "technical_precision",
    label: "Technical Precision",
    description:
      "An engineered look, clean lines, spec-driven proof such as efficiency ratings.",
    bestSkill: "impeccable",
    structure: {
      heroes: [
        "a typographic hero: the headline set like a spec sheet with a thin rule grid, a figures strip under it",
        "a split hero: the headline and the key spec left, a precise equipment photo right",
      ],
      orders: ["the specs/figures band directly under the hero, services after", "services as an engineered grid first, the process as a numbered sequence"],
      brand: ["as ink: rules, numbers and buttons in the brand colour, one full band at the call to action", "as bands: the figures strip on the brand colour and the call to action"],
    },
  },
  heritage_established: {
    id: "heritage_established",
    label: "Heritage Established",
    description: "Classic type, badge-style details, a timeless palette.",
    bestSkill: "taste",
    needsFoundingYear: true,
    structure: {
      heroes: [
        "a full-bleed photograph with a classic serif headline and the founding year set as a small badge",
        "a typographic hero: the name and founding year set like a letterhead, a photograph band directly beneath",
      ],
      orders: ["the story band (the founding year, told straight) under the hero, services after", "services first, the heritage band mid-page with the badge details"],
      brand: ["as bands: a deep full-colour band early and at the call to action", "as ink: the serif and badges in the brand colour, one full band at the call to action"],
    },
  },
  clinical_calm: {
    id: "clinical_calm",
    label: "Clinical Calm",
    description: "A soft light palette, calm spacing, a reassuring tone.",
    bestSkill: "ui_ux_pro_max",
    structure: {
      heroes: [
        "a split hero: a reassuring headline left, a calm photo right, everything unhurried",
        "a typographic hero on the soft ground, a gentle photo band directly beneath",
      ],
      orders: ["the 'what to expect' process directly under the hero", "services as calm cards first, one patient/customer quote after"],
      brand: ["as ink: soft brand accents on headings and buttons, one full band at the call to action", "as bands: a muted full band at the trust strip and the call to action"],
    },
  },
  brand_led: {
    id: "brand_led",
    label: "Brand-Led",
    description:
      "Follows the client's brand guide exactly; only layout and structure vary.",
    bestSkill: "ui_ux_pro_max",
    anySkill: true,
    structure: {
      heroes: [
        "whatever hero the brand guide implies; absent guidance, a full-bleed photograph with the headline over it",
        "whatever hero the brand guide implies; absent guidance, a split hero with the quote form right",
      ],
      orders: ["the trust band directly under the hero, services after", "services first, one strong quote before the process"],
      brand: ["exactly as the brand guide uses it; absent guidance, as bands at the trust strip and call to action", "exactly as the brand guide uses it; absent guidance, as the hero's ground plus the call to action"],
    },
  },
  // Jason, 26 September 2026: the 13th, for creative businesses.
  gallery_portfolio: {
    id: "gallery_portfolio",
    label: "Gallery and Portfolio",
    description:
      "Image-led with minimal text, generous white space, portfolio grids and a page per project.",
    bestSkill: "impeccable",
    buildNote:
      "The work is the hero: a large project image first, then a portfolio grid, with short captions (project, place, year only as the intake gives them). Use only the client's own project photos; every grid tile without one is a visible [PLACEHOLDER], never a stock or invented image presented as their work. Keep the phone number and a clear enquiry button visible, as on every TAWD site.",
  },
};

/* A small stable hash (FNV-1a), so a concept's dealt structure is reproducible across fix rounds. */
function fnv(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface DealtStructure {
  hero: string;
  order: string;
  brand: string;
}

/*
  C1: one concept's dealt structure. Stable for the same (direction, seed,
  label) — a fix round rebuilds the same shape — and different across
  projects (the seed), so consecutive clients in one direction get different
  pages, not re-skins. The label offsets the pick, so sibling concepts lean
  toward different hero archetypes even when their directions' pools overlap.
  Null for a direction with no pools (the designer's concept, Gallery).
*/
export function dealStructure(directionId: string, seed: string, label: string): DealtStructure | null {
  const structure = (directions as Record<string, Direction | undefined>)[directionId]?.structure;
  if (!structure) return null;
  const base = fnv(`${directionId}|${seed.trim().toLowerCase()}`);
  const offset = Math.max(0, ["A", "B", "C"].indexOf(label));
  /*
    One index into every (hero, order, brand) combination, so labels A, B and C always land on
    three different combinations (a per-pool offset wraps after two in two-item pools, making A
    and C identical; CodeRabbit PR #56). The hero varies fastest, so neighbouring labels differ
    in their most visible choice; the hash picks where in the combination space a client starts.
  */
  const { heroes, orders, brand } = structure;
  const index = (base + offset) % (heroes.length * orders.length * brand.length);
  return {
    hero: heroes[index % heroes.length]!,
    order: orders[Math.floor(index / heroes.length) % orders.length]!,
    brand: brand[Math.floor(index / (heroes.length * orders.length)) % brand.length]!,
  };
}

/* The prompt block for a dealt structure: binding, with one honest escape hatch. */
export function structureBlock(dealt: DealtStructure): string {
  return `# This concept's structure (dealt by TAWD — binding, like the direction)

- The hero: ${dealt.hero}.
- The section order: ${dealt.order}.
- The brand colour: ${dealt.brand}.

TAWD deals these so no two concepts share a shape. Follow them. If the client's material makes one impossible (no photograph good enough for the hero, say), use the nearest workable shape and say so in one line before the HTML.`;
}

/*
  Creative businesses, where the work itself sells: interior designers,
  artists, photographers, remodelers, architects. Read from the business
  name, the services and the mood words; the trade list has no such trade.
*/
const CREATIVE_WORDS =
  /\b(interior design\w*|artists?|art studio|fine art|murals?|photograph\w*|remodel\w*|renovat\w*|architect\w*|portfolio|gallery|galleries|home staging|kitchen (?:and|&) bath design)\b/i;

/* The creative trades (26 September 2026): Gallery and Portfolio leads for them, whatever their words say. */
export const CREATIVE_TRADES: Trade[] = ["interior_design", "art_decorative_finishes", "photography", "architecture_remodeling"];

export function isCreativeBusiness(texts: string[]): boolean {
  return texts.some((text) => CREATIVE_WORDS.test(text));
}

/*
  Trades where the visitor is usually in trouble right now. TAWD-PROFILE
  section 2 and DIRECTIONS.md selection rule 2: one concept must be Bold
  Emergency for these.
*/
const EMERGENCY_TRADES: Trade[] = ["plumbing", "hvac", "garage_doors"];

const DEFAULT_BY_TRADE: Partial<Record<Trade, DirectionId[]>> = {
  plumbing: ["bold_emergency", "modern_clean", "warm_local"],
  hvac: ["bold_emergency", "modern_clean", "warm_local"],
  garage_doors: ["bold_emergency", "modern_clean", "warm_local"],
  legal: ["classic_trust", "editorial_authority", "premium_upscale"],
  med_spa: ["clinical_calm", "premium_upscale", "modern_clean"],
  roofing: ["rugged_craftsman", "classic_trust", "modern_clean"],
  well_and_pump: ["rugged_craftsman", "classic_trust", "modern_clean"],
  electrical: ["technical_precision", "modern_clean", "classic_trust"],
  glass_and_windows: ["modern_clean", "classic_trust", "premium_upscale"],
  home_services: ["warm_local", "modern_clean", "bright_friendly"],
  // Jason, 27 September 2026: trust and proof first (licensed, safe for family and pets), then a clean modern build and proof told as stories.
  pest_control: ["classic_trust", "modern_clean", "editorial_authority"],
  interior_design: ["gallery_portfolio", "premium_upscale", "classic_trust"],
  art_decorative_finishes: ["gallery_portfolio", "premium_upscale", "classic_trust"],
  photography: ["gallery_portfolio", "premium_upscale", "classic_trust"],
  architecture_remodeling: ["gallery_portfolio", "premium_upscale", "classic_trust"],
  other: ["modern_clean", "classic_trust", "warm_local"],
};

const FALLBACK: DirectionId[] = ["modern_clean", "classic_trust", "warm_local"];

/*
  A trade read from the words when the project says "other" (27 September
  2026: Finley Pest Control was entered as "other" and got Warm Local).
  Only trades with their own direction list; the first match wins.
*/
const TRADE_WORDS: [Trade, RegExp][] = [
  ["pest_control", /\b(pest|termites?|exterminat\w*|rodents?|bed ?bugs?|mosquito\w*|wildlife (?:control|removal))\b/i],
  ["plumbing", /\b(plumb\w*|drain cleaning|water heaters?)\b/i],
  ["hvac", /\b(hvac|heating and (?:air|cooling)|air condition\w*|furnaces?)\b/i],
  ["roofing", /\b(roof\w*)\b/i],
  ["electrical", /\b(electrician|electrical)\b/i],
  ["garage_doors", /\bgarage doors?\b/i],
  ["legal", /\b(law (?:firm|office)|attorneys?|lawyers?)\b/i],
];

export function tradeFromWords(trade: Trade, texts: string[]): Trade {
  if (trade !== "other") return trade;
  for (const [candidate, pattern] of TRADE_WORDS) if (texts.some((text) => pattern.test(text))) return candidate;
  return trade;
}

/*
  What the client actually supplied (27 September 2026, after the Finley
  mockups: inputs beat rules). The brand, the real photos and the studied
  reference sites move the proposal; the PM can still override any pick.
*/
export interface ProposalInputs {
  /** The brand colours the concepts will use, entered or taken from the logo. */
  colors: string[];
  colorsFrom: "entered" | "logo" | "none";
  photos: { count: number; people: number; work: number };
  /** One per reference site; closestDirection comes from its study, when AI was allowed. */
  references: { url: string; studied: boolean; closestDirection?: DirectionId | null }[];
}

function hsl(hex: string): { h: number; s: number; l: number } | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(match[1]!.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d > 0) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

/* The character of a palette, for the proposal: deep and sober, bright, or rich and muted. */
export function paletteCharacter(colors: string[]): "deep" | "bright" | "rich" | null {
  const tones = colors.map(hsl).filter((c): c is NonNullable<typeof c> => c !== null && c.s > 0.12 && c.l > 0.08 && c.l < 0.92);
  if (tones.length === 0) return null;
  const main = tones[0]!;
  const hasGold = tones.some((c) => c.h >= 35 && c.h <= 55 && c.s > 0.35 && c.l < 0.6);
  const hasNearBlack = colors.map(hsl).some((c) => c !== null && c.l < 0.15);
  if (hasGold && hasNearBlack) return "rich";
  if (tones.filter((c) => c.s > 0.6 && c.l >= 0.4 && c.l <= 0.65).length >= 2) return "bright";
  if (main.l < 0.4) return "deep";
  return null;
}

/* Move a direction to a position in the list (inserting it if missing). */
function moveTo(list: DirectionId[], id: DirectionId, at: number): DirectionId[] {
  const rest = list.filter((d) => d !== id);
  rest.splice(Math.min(at, rest.length), 0, id);
  return rest;
}

const IMAGE_LED: DirectionId[] = ["premium_upscale", "warm_local", "gallery_portfolio"];

/* B4: the fewest photos of the client's own work a portfolio grid can honestly be built from. */
export const GALLERY_MIN_WORK_PHOTOS = 6;

function applyInputs(ordered: DirectionId[], inputs: ProposalInputs, notes: string[]): DirectionId[] {
  let list = [...ordered];

  const character = paletteCharacter(inputs.colors);
  const from = inputs.colorsFrom === "logo" ? "The logo's colours" : "The brand colours";
  if (character === "deep") {
    list = moveTo(list, "classic_trust", 0);
    notes.push(`${from} are deep and sober, which suits Classic Trust.`);
  } else if (character === "bright") {
    // It leads: Classic Trust shares its skill, so second place would lose it.
    list = moveTo(list, "bright_friendly", 0);
    notes.push(`${from} are bright, so Bright and Friendly leads.`);
  } else if (character === "rich") {
    list = moveTo(list, "premium_upscale", 1);
    notes.push(`${from} are dark with gold, which suits Premium Upscale.`);
  }

  if (inputs.photos.count === 0) {
    /*
      Each concept needs a different skill, and most of Taste's directions
      lean on photos, so its type-led one, Editorial Authority, goes ahead
      of them.
    */
    const rest = list.filter((d) => !IMAGE_LED.includes(d));
    list = [...(rest.includes("editorial_authority") ? rest : [...rest, "editorial_authority" as DirectionId]), ...list.filter((d) => IMAGE_LED.includes(d))];
    notes.push("No real photos yet, so directions that lean on photos moved down. Results will be weaker until the client sends some.");
  } else if (inputs.photos.people > 0 && !list.slice(0, 3).some((d) => d === "warm_local" || d === "classic_trust")) {
    list = moveTo(list, "warm_local", 2);
    notes.push("The client sent a photo of their team, which suits a people-first direction.");
  }

  return list;
}

/*
  References set the bar: a direction two or more of them point to leads,
  one gets a place.

  This runs AFTER the trade's own rules, not with the other inputs (Jason's
  run, 10 November 2026). It used to run inside applyInputs, and then the
  "creative business" rule rebuilt the order on top of it - so New Dawn
  Awning was proposed Premium Upscale while TAWD's own card said "None of
  the 3 studied reference sites lean this way (they lean to Classic Trust,
  Bright and Friendly, Rugged Craftsman)". It knew, said so, and proposed
  the other thing anyway; Jason changed the direction by hand.

  The references are the client's own choice of bar, so they outrank a
  guess made from the words in the intake. What still outranks THEM is a
  brand guide, which is the client telling TAWD what the brand is.
*/
function applyReferenceVotes(ordered: DirectionId[], inputs: ProposalInputs, notes: string[]): DirectionId[] {
  let list = [...ordered];
  const votes = new Map<DirectionId, number>();
  for (const ref of inputs.references) {
    if (ref.closestDirection && directions[ref.closestDirection]) votes.set(ref.closestDirection, (votes.get(ref.closestDirection) ?? 0) + 1);
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  // A leader no reference points to (the creative guess) gives up the lead to the strongest vote.
  const leaderVoted = list.length > 0 && votes.has(list[0]!);
  for (const [index, [id, count]] of ranked.slice(0, 2).entries()) {
    // Only ever up: a direction already ahead of its place stays where it is.
    // The strongest vote leads when it has two or more, or when the current leader has none; the next takes the place after it.
    const target = count >= 2 || !leaderVoted ? index : index + 1;
    const at = list.indexOf(id);
    if (at < 0 || at > target) list = moveTo(list, id, target);
    notes.push(
      `${count} of the ${inputs.references.length} reference site${inputs.references.length === 1 ? "" : "s"} ${count === 1 ? "is" : "are"} closest to ${directions[id].label}, so it is one of the picks.`,
    );
  }
  return list;
}

export interface PreselectInput {
  trade: Trade;
  /** The client's inputs; the proposal is made from these as well as the trade. */
  inputs?: ProposalInputs;
  /** Lower-cased mood words from the intake. */
  moodWords: string[];
  /** True when the intake supplies brand colors or fonts. */
  hasBrandGuide: boolean;
  hasFoundingYear: boolean;
  conceptCount: number;
  /** Directions already used for this trade and city, from the design log. */
  usedNearby?: DirectionId[];
  /** isCreativeBusiness on the intake: Gallery and Portfolio leads. */
  creative?: boolean;
}

export interface PreselectedConcept {
  label: "A" | "B" | "C";
  direction: DirectionId;
  skillId: SkillId;
  /** Why this one is here, shown on the setup screen. */
  reason: string;
}

export interface PreselectResult {
  concepts: PreselectedConcept[];
  /** The "Why these directions" list on the setup screen. */
  notes: string[];
}

function moodMatches(moodWords: string[], needles: string[]): boolean {
  return moodWords.some((word) =>
    needles.some((needle) => word.toLowerCase().includes(needle)),
  );
}

export function preselectDirections(input: PreselectInput): PreselectResult {
  const notes: string[] = [];
  const count = Math.min(3, Math.max(1, input.conceptCount));

  let ordered: DirectionId[] = [
    ...(DEFAULT_BY_TRADE[input.trade] ?? FALLBACK),
  ];
  if (input.inputs) ordered = applyInputs(ordered, input.inputs, notes);

  // B4: is the project photo-starved for a portfolio? (Decided once, used by the creative lead and the gate below.)
  // An unknown photo count is not evidence of a portfolio, so it counts as starved (CodeRabbit PR #58).
  const galleryStarved = input.inputs === undefined || input.inputs.photos.work < GALLERY_MIN_WORK_PHOTOS;

  if ((input.creative || CREATIVE_TRADES.includes(input.trade)) && !galleryStarved) {
    ordered = ["gallery_portfolio", "premium_upscale", "classic_trust", ...ordered.filter((d) => !["gallery_portfolio", "premium_upscale", "classic_trust"].includes(d))];
    notes.push(
      "A creative business, where the work sells itself, so Gallery and Portfolio leads. It needs the client's project photos; missing ones show as placeholders.",
    );
  } else if (input.creative || CREATIVE_TRADES.includes(input.trade)) {
    ordered = ["premium_upscale", "classic_trust", ...ordered.filter((d) => !["gallery_portfolio", "premium_upscale", "classic_trust"].includes(d))];
  }

  /*
    The studied reference sites, applied here: after the trade's defaults
    and the creative-business guess, and before the brand guide. See
    applyReferenceVotes for what went wrong when they were applied first.
  */
  if (input.inputs) ordered = applyReferenceVotes(ordered, input.inputs, notes);

  // A full brand guide means the brand decides the look, so lead with it.
  if (input.hasBrandGuide) {
    ordered = ["brand_led", ...ordered.filter((d) => d !== "brand_led")];
    notes.push(
      "The client supplied brand colors or fonts, so one concept follows the brand guide exactly.",
    );
  }

  if (moodMatches(input.moodWords, ["premium", "luxury", "high-end", "upscale"])) {
    if (!ordered.includes("premium_upscale")) {
      ordered.splice(Math.min(2, ordered.length), 0, "premium_upscale");
      notes.push(
        'The mood words mention premium, so Premium Upscale is one of the picks.',
      );
    }
  }

  if (moodMatches(input.moodWords, ["friendly", "family", "local", "honest"])) {
    if (!ordered.includes("warm_local") && !ordered.includes("bright_friendly")) {
      ordered.splice(Math.min(2, ordered.length), 0, "warm_local");
      notes.push(
        'The mood words mention friendly or local, so Warm Local is one of the picks.',
      );
    }
  }

  // Heritage is only honest when the intake gives a year to stand behind.
  if (!input.hasFoundingYear) {
    ordered = ordered.filter((d) => d !== "heritage_established");
  }

  /*
    B4 (the design-skills diagnosis, 8 November 2026): Gallery and Portfolio
    is only dealt when the project has enough real work photos to fill a
    portfolio. Its own rule (and the Creative Director's image-poor
    must-fix) makes an image-poor gallery a guaranteed hold — the best
    design in the audit scored lowest purely because of this. The PM can
    still pick it by hand.
  */
  if (galleryStarved && (ordered.includes("gallery_portfolio") || input.creative || CREATIVE_TRADES.includes(input.trade))) {
    ordered = ordered.filter((d) => d !== "gallery_portfolio");
    // One consistent explanation: drop an earlier "Gallery ... is one of the picks" claim (a reference site's vote).
    for (let i = notes.length - 1; i >= 0; i -= 1) if (notes[i]!.includes(directions.gallery_portfolio.label) && notes[i]!.includes("one of the picks")) notes.splice(i, 1);
    notes.push(
      input.inputs
        ? `Gallery and Portfolio needs at least ${GALLERY_MIN_WORK_PHOTOS} photos of the client's own work (${input.inputs.photos.work} so far), so it isn't proposed yet. Premium Upscale carries the creative look meanwhile.`
        : `Gallery and Portfolio needs at least ${GALLERY_MIN_WORK_PHOTOS} photos of the client's own work, and the photos haven't been counted yet, so it isn't proposed. Premium Upscale carries the creative look meanwhile.`,
    );
  }

  // Rule 3: avoid repeating what a competitor nearby already has.
  const used = new Set(input.usedNearby ?? []);
  if (used.size > 0) {
    const clashes = ordered.filter((d) => used.has(d));
    if (clashes.length > 0) {
      ordered = [
        ...ordered.filter((d) => !used.has(d)),
        ...ordered.filter((d) => used.has(d)),
      ];
      notes.push(
        `Moved ${clashes
          .map((d) => directions[d].label)
          .join(" and ")} down the list: already used for another ${input.trade.replace(/_/g, " ")} client nearby.`,
      );
    }
  }

  // Top up from the full catalog if the trade list was short.
  for (const id of directionIds) {
    if (ordered.length >= 6) break;
    if (ordered.includes(id)) continue;
    if (id === "heritage_established" && !input.hasFoundingYear) continue;
    if (id === "brand_led" && !input.hasBrandGuide) continue;
    if (id === "gallery_portfolio" && ((!input.creative && !CREATIVE_TRADES.includes(input.trade)) || galleryStarved)) continue;
    ordered.push(id);
  }

  const isEmergency = EMERGENCY_TRADES.includes(input.trade);
  const chosen = chooseWithDistinctSkills(ordered, count, isEmergency);

  if (isEmergency) {
    notes.unshift(
      `${input.trade.replace(/_/g, " ")} is an emergency trade, so one concept is always Bold Emergency.`,
    );
  }

  if (count > 1) {
    notes.push(
      "Each concept uses a different design skill, so the concepts genuinely differ.",
    );
  }

  const labels: Array<"A" | "B" | "C"> = ["A", "B", "C"];

  return {
    concepts: chosen.map((pick, index) => ({
      label: labels[index]!,
      direction: pick.direction,
      skillId: pick.skillId,
      reason:
        isEmergency && pick.direction === "bold_emergency"
          ? "Required for emergency trades"
          : index === 0
            ? "Suggested"
            : directions[pick.direction].description,
    })),
    notes,
  };
}

/*
  Picks `count` directions such that no two share a design skill.

  Brand-Led can be built by any skill, so it takes whichever is still free.
  If the constraint cannot be met from the candidates - which only happens
  with a short list - the remaining slots take the next direction regardless,
  because two similar concepts beats none.
*/
function chooseWithDistinctSkills(
  candidates: DirectionId[],
  count: number,
  emergencyFirst: boolean,
): { direction: DirectionId; skillId: SkillId }[] {
  const ordered = [...candidates];

  if (emergencyFirst) {
    const at = ordered.indexOf("bold_emergency");
    if (at > 0) ordered.splice(at, 1);
    if (at !== 0) ordered.unshift("bold_emergency");
  }

  const picks: { direction: DirectionId; skillId: SkillId }[] = [];
  const usedSkills = new Set<SkillId>();

  for (const [at, id] of ordered.entries()) {
    if (picks.length >= count) break;
    const direction = directions[id];
    if (!direction) continue;
    if (picks.some((p) => p.direction === id)) continue;

    /*
      A direction that any skill can build takes the slot it earned by its
      position, with whichever skill is still free. Holding it back until
      the end sounds tidier but loses it: by then the slots are taken.
      It prefers a free skill none of the directions behind it needs:
      taking the first free one dropped the reference sites' own pick
      (Brand-Led took Classic Trust's skill, and Classic Trust was cut while
      the note still said it was one of the picks).
    */
    // The skills of the directions that would fill the slots left after this one.
    const neededLater = new Set<SkillId>();
    const slotsAfter = count - picks.length - 1;
    for (const later of ordered.slice(at + 1)) {
      if (neededLater.size >= slotsAfter) break;
      const next = directions[later];
      if (!next || next.anySkill || usedSkills.has(next.bestSkill)) continue;
      neededLater.add(next.bestSkill);
    }
    const skillId = direction.anySkill
      ? (skillIds.find((skill) => !usedSkills.has(skill) && !neededLater.has(skill)) ??
        skillIds.find((skill) => !usedSkills.has(skill)))
      : usedSkills.has(direction.bestSkill)
        ? undefined
        : direction.bestSkill;

    if (!skillId) continue;

    picks.push({ direction: id, skillId });
    usedSkills.add(skillId);
  }

  // Last resort: fill remaining slots even if a skill repeats.
  for (const id of ordered) {
    if (picks.length >= count) break;
    if (picks.some((p) => p.direction === id)) continue;
    const direction = directions[id];
    if (!direction) continue;
    const free = skillIds.find((skill) => !usedSkills.has(skill));
    const skillId = free ?? direction.bestSkill;
    picks.push({ direction: id, skillId });
    usedSkills.add(skillId);
  }

  return picks.slice(0, count);
}

/*
  A coarse color family for the design log.

  Two hex codes are never equal in practice, so comparing them is useless.
  What matters is "another plumber in Sacramento already has a green site".
*/
export function paletteFamily(hex: string | undefined | null): string | null {
  if (!hex) return null;
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;

  let value = match[1]!;
  if (value.length === 3) {
    value = value
      .split("")
      .map((c) => c + c)
      .join("");
  }

  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;

  if (delta < 0.08) return lightness < 0.25 ? "near-black" : lightness > 0.85 ? "near-white" : "gray";

  let hue = 0;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue = (hue * 60 + 360) % 360;

  if (hue < 20 || hue >= 340) return "red";
  if (hue < 45) return "orange";
  if (hue < 70) return "yellow";
  if (hue < 175) return "green";
  if (hue < 200) return "teal";
  if (hue < 255) return "blue";
  if (hue < 290) return "purple";
  return "pink";
}

/*
  The team's own picks, checked against the same rules.

  The setup screen lets the PM change any concept's direction. Choosing a
  direction also chooses its skill (the one that builds it most naturally,
  or any free one for Brand-Led), so the rules are checked on the whole set
  at once, in the browser for an immediate message and again on the server
  before anything is queued.
*/
export function isEmergencyTrade(trade: Trade): boolean {
  return EMERGENCY_TRADES.includes(trade);
}

export interface PickRules {
  trade: Trade;
  hasFoundingYear: boolean;
}

export interface CheckedPicks {
  concepts: { label: "A" | "B" | "C"; direction: DirectionId; skillId: SkillId }[];
  /** Plain sentences, one per broken rule. Empty means the picks are fine. */
  problems: string[];
  /*
    Advice the PM may overrule: shown, never blocking, and an override is
    logged. The emergency-trade rule lives here (Jason, 25 September 2026).
  */
  warnings: string[];
}

export function assignSkills(
  picks: { label: "A" | "B" | "C"; direction: DirectionId }[],
  rules: PickRules,
): CheckedPicks {
  const problems: string[] = [];
  const warnings: string[] = [];
  const concepts: CheckedPicks["concepts"] = [];
  const used = new Set<SkillId>();

  // Fixed-skill directions first, so Brand-Led takes whatever is left.
  const fixed = picks.filter((p) => !directions[p.direction]?.anySkill);
  const flexible = picks.filter((p) => directions[p.direction]?.anySkill);

  for (const pick of fixed) {
    const direction = directions[pick.direction];
    if (!direction) {
      problems.push(`Concept ${pick.label} has a direction TAWD does not know.`);
      continue;
    }
    const clash = concepts.find((c) => c.skillId === direction.bestSkill);
    if (clash) {
      const others = skillIds
        .filter((s) => s !== direction.bestSkill)
        .map((s) => skillLabels[s])
        .join(" or ");
      problems.push(
        `Concepts ${clash.label} and ${pick.label} would both be built with ${
          skillLabels[direction.bestSkill]
        } (${directions[clash.direction].label} and ${direction.label}). Each concept needs a different design skill, so pick a direction built with ${others} for one of them.`,
      );
    }
    concepts.push({ ...pick, skillId: direction.bestSkill });
    used.add(direction.bestSkill);
  }

  for (const pick of flexible) {
    const free = skillIds.find((s) => !used.has(s));
    if (!free) {
      problems.push(
        `Concept ${pick.label} (${directions[pick.direction].label}) has no design skill left; each concept needs a different one.`,
      );
      continue;
    }
    concepts.push({ ...pick, skillId: free });
    used.add(free);
  }

  const seen = new Map<DirectionId, string>();
  for (const pick of picks) {
    const earlier = seen.get(pick.direction);
    if (earlier) {
      problems.push(
        `Concepts ${earlier} and ${pick.label} are both ${directions[pick.direction]?.label}. Each concept needs its own direction.`,
      );
    }
    seen.set(pick.direction, pick.label);
  }

  if (
    isEmergencyTrade(rules.trade) &&
    !picks.some((p) => p.direction === "bold_emergency")
  ) {
    warnings.push(
      `${rules.trade.replace(/_/g, " ")} is an emergency trade, and TAWD normally includes Bold Emergency. You can go ahead without it; the choice is logged.`.replace(
        /^./,
        (c) => c.toUpperCase(),
      ),
    );
  }

  if (
    !rules.hasFoundingYear &&
    picks.some((p) => p.direction === "heritage_established")
  ) {
    problems.push(
      "Heritage Established needs a founding year in the intake, so the page has something true to stand behind.",
    );
  }

  concepts.sort((a, b) => a.label.localeCompare(b.label));
  return { concepts, problems, warnings };
}

/*
  Lane 2, Option B: the designer's own design, improved by TAWD, on the
  concept board as Concept 1 (26 September 2026). Not one of the thirteen
  directions and built by no skill: it is stored with direction and skill
  "designer", and every place that shows or prompts a direction asks
  directionInfo, which knows it.
*/
export const DESIGNER_CONCEPT = "designer";

/*
  A homepage the team supplied as one finished HTML file (16 November 2026),
  put on the board as a concept by the html-mockup-import job. Like the
  designer's design it is none of the thirteen directions and no skill built
  it; it is stored with this direction and skill, and anything that shows or
  prompts a direction asks directionInfo, which knows it.
*/
export const HTML_HOMEPAGE_CONCEPT = "html-homepage";

export const HTML_HOMEPAGE_DIRECTION = {
  label: "The supplied homepage",
  description:
    "A finished homepage the team supplied as an HTML file. Keep its layout, colours, fonts, pictures and words exactly; change only what is asked.",
};

export const DESIGNER_DIRECTION = {
  label: "The designer's design, improved",
  description:
    "The web designer's own homepage from Figma, with the fixes the team chose and the designer accepted. Keep its layout, brand colours, fonts and words; change only what is asked.",
};

/*
  A concept TAWD's skills built (one of the three board concepts of a run), as
  opposed to one somebody else made and TAWD only stores: the designer's
  design (Figma) and a supplied homepage (HTML). Every paid AI step that runs
  "on the run's concepts" (the Creative Director review, a review rerun, the
  references) is for generated concepts only; the two supplied kinds have no
  skill file to build or revise them from.
*/
export function isGeneratedConcept(skillId: string): boolean {
  return skillId !== DESIGNER_CONCEPT && skillId !== HTML_HOMEPAGE_CONCEPT;
}

/* A concept's direction for showing or prompting: one of the thirteen, the designer's, or the raw name. */
export function directionInfo(id: string): { label: string; description: string; buildNote?: string } {
  if (id === DESIGNER_CONCEPT) return DESIGNER_DIRECTION;
  if (id === HTML_HOMEPAGE_CONCEPT) return HTML_HOMEPAGE_DIRECTION;
  return (directions as Record<string, Direction | undefined>)[id] ?? { label: id, description: "" };
}
