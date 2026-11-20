import { outlineReference, type RawReferenceBand, type ReferenceOutline, type SectionKind } from "./references";
import { splitSections } from "./sections";

/*
  How much of each reference site a concept used (Jason, 7 October 2026),
  measured by code, free: the concept's homepage read into the same outline
  as the reference (its bands' kinds top to bottom, the hero, the trust
  signals, the services layout), then compared part by part. Structure only:
  colours, fonts, words and photos are never taken from a reference, so
  they aren't measured.

  The share is weighted: section order 50%, the hero 20%, trust signals 15%,
  the services layout 15%, over the parts the reference has.
*/

const strip = (html: string) =>
  html
    .replace(/<(script|style|svg|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** The concept's homepage as the outline a reference gets. */
export function conceptOutline(html: string): ReferenceOutline {
  const sections = splitSections(html);
  const bands: RawReferenceBand[] = sections.map((s) => {
    const heading = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(s.html)?.[1] ?? "";
    const cards = Math.max(
      (s.html.match(/<(article|li)\b/gi) ?? []).length,
      (s.html.match(/class="[^"]*\bcard\b[^"]*"/gi) ?? []).length,
    );
    return {
      tag: s.tag,
      heading: strip(heading),
      text: strip(s.html).slice(0, 1_500),
      images: (s.html.match(/<img\b|background-image\s*:/gi) ?? []).length,
      cards,
      hasForm: /<form\b/i.test(s.html),
      height: 100,
    };
  });
  const hero = bands.find((b) => b.tag !== "header" && b.tag !== "nav" && (b.text || b.images));
  const heroHtml = hero ? sections[bands.indexOf(hero)]!.html : "";
  const calls = [...heroHtml.matchAll(/<(a|button)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .filter((m) => /\bbtn|button|cta\b/i.test(m[0]) || m[1]!.toLowerCase() === "button" || /href="tel:/i.test(m[0]))
    .map((m) => strip(m[2]!));
  return outlineReference(bands, calls);
}

export interface ReferenceUse {
  url: string;
  /** 0 to 100. */
  percent: number;
  /** What the concept has like the reference, in plain words. */
  taken: string[];
  /** What the reference has that the concept doesn't. */
  notTaken: string[];
}

const SKIP: SectionKind[] = ["other", "footer"];
const KIND_WORDS: Record<SectionKind, string> = {
  hero: "hero",
  services: "services",
  trust: "trust",
  reviews: "reviews",
  about: "about",
  process: "process",
  areas: "service areas",
  offer: "offer",
  faq: "FAQ",
  gallery: "gallery",
  contact: "contact",
  cta: "call to action",
  footer: "footer",
  other: "other",
};

/* The reference's section kinds that appear in the concept in the same order (longest common subsequence). */
function sameOrder(ref: SectionKind[], mine: SectionKind[]): SectionKind[] {
  const table = Array.from({ length: ref.length + 1 }, () => new Array<number>(mine.length + 1).fill(0));
  for (let i = ref.length - 1; i >= 0; i--)
    for (let j = mine.length - 1; j >= 0; j--) table[i]![j] = ref[i] === mine[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const out: SectionKind[] = [];
  let i = 0;
  let j = 0;
  while (i < ref.length && j < mine.length) {
    if (ref[i] === mine[j]) {
      out.push(ref[i]!);
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++;
    else j++;
  }
  return out;
}

const kindsOf = (outline: ReferenceOutline) => outline.bands.map((b) => b.kind).filter((k) => !SKIP.includes(k)).filter((k, i, all) => i === 0 || all[i - 1] !== k);
const cardsLayout = (layout: string | null) => (layout === null ? null : /cards/.test(layout) ? "cards" : "list");

export function referenceUse(url: string, reference: ReferenceOutline, concept: ReferenceOutline): ReferenceUse {
  const taken: string[] = [];
  const notTaken: string[] = [];
  let score = 0;
  let weight = 0;

  const refKinds = kindsOf(reference);
  if (refKinds.length >= 2) {
    const kept = sameOrder(refKinds, kindsOf(concept));
    weight += 50;
    score += (50 * kept.length) / refKinds.length;
    if (kept.length >= 2) taken.push(`${kept.length} of its ${refKinds.length} sections in its order (${kept.map((k) => KIND_WORDS[k]).join(", ")})`);
    const missing = refKinds.filter((k, i) => refKinds.indexOf(k) === i && !kept.includes(k));
    if (missing.length) notTaken.push(`its ${missing.map((k) => KIND_WORDS[k]).join(", ")} section${missing.length === 1 ? "" : "s"}${kept.length < 2 ? " and its order" : ""}`);
  }

  weight += 20;
  const photo = reference.hero.hasImage === concept.hero.hasImage;
  const calls = (reference.hero.calls.length > 0) === (concept.hero.calls.length > 0);
  score += (photo ? 12 : 0) + (calls ? 8 : 0);
  const heroWords = `${reference.hero.hasImage ? "with a photo" : "led by text"}${reference.hero.calls.length ? " and buttons" : ""}`;
  if (photo && calls) taken.push(`a hero ${heroWords}, like it`);
  else notTaken.push(`its hero (${heroWords})`);

  if (reference.trustSignals.length) {
    const shared = reference.trustSignals.filter((t) => concept.trustSignals.includes(t));
    weight += 15;
    score += (15 * shared.length) / reference.trustSignals.length;
    if (shared.length) taken.push(`${shared.length} of its ${reference.trustSignals.length} kinds of proof (${shared.join(", ")})`);
    const others = reference.trustSignals.filter((t) => !shared.includes(t));
    if (others.length) notTaken.push(others.join(", "));
  }

  const refServices = cardsLayout(reference.serviceLayout);
  if (refServices) {
    weight += 15;
    if (refServices === cardsLayout(concept.serviceLayout)) {
      score += 15;
      taken.push(refServices === "cards" ? "services as cards, like it" : "services as a list, like it");
    } else notTaken.push(refServices === "cards" ? "its service cards" : "its list of services");
  }

  return { url, percent: weight ? Math.round((100 * score) / weight) : 0, taken, notTaken };
}
