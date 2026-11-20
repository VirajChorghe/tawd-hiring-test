/*
  Health and beauty rules (Jason, 26 September 2026): med spa, wellness,
  dental and medical sites.

  - No promises of results.
  - Licensed-professional wording only as the client provides it: a title
    or credential on the page must be in the client's own words in the
    intake (certifications, licence numbers, services, their copy).
  - Before-and-after photos only with the client's recorded permission
    (the Photos section; the intake save logs who and when). Without it,
    photos captioned as before-and-after never reach a mockup or a build.
  - Testimonials only when real and supplied: the client's own copy.

  TAWD tells the writers these rules, and flags anything that breaks them
  for the PM: on each page's draft, and on the build's checklist. A flag is
  for a person to judge; it never rewrites anything by itself.
*/

const HEALTH_WORDS =
  /\b(med ?spa|medical spa|wellness|dental|dentist\w*|orthodont\w*|medical|clinic|chiropract\w*|dermatolog\w*|aesthetic\w*|esthetic\w*|botox|fillers?|injectables?|iv therapy|laser hair|physical therap\w*|massage therap\w*|acupunct\w*|naturopath\w*|weight loss)\b/i;

export function isHealthBusiness(trade: string, texts: string[]): boolean {
  return trade === "med_spa" || texts.some((t) => HEALTH_WORDS.test(t));
}

/* Photos captioned as before-and-after. */
export const BEFORE_AFTER = /\bbefore[\s-]*(?:and|&|\/)?[\s-]*after\b|\b(?:before|after) (?:photo|picture|shot|treatment)s?\b/i;

export const HEALTH_RULES_PROMPT = `# Health and beauty rules (this is a health, beauty or medical business)

- Never promise or imply a result: no "guaranteed", "permanent", "cure", "pain-free", "risk-free", "no side effects", "instant results", "look 10 years younger" or similar. Describe what the treatment is and what to expect at the visit, not an outcome.
- Titles and credentials (doctor, Dr., MD, DDS, RN, nurse practitioner, board-certified, licensed ...) only exactly as the intake gives them. If the page needs one the intake doesn't give, write [PLACEHOLDER: provider's title or credential].
- No before-and-after photos or claims about them unless the intake says the client gave permission.
- No testimonials, reviews or patient stories unless the client supplied them word for word.`;

export interface HealthContext {
  /** The client's own words: certifications, licence numbers, services, supplied copy. */
  clientWords: string;
  beforeAfterPermission: boolean;
}

export interface HealthFlag {
  key: "promise" | "credential" | "before_after" | "testimonial";
  rule: string;
  found: string;
}

const PROMISES =
  /\b(guaranteed results|guarantee[ds]?|permanent(?:ly)?(?: results| removal| fix)?|cures?|cured|pain[- ]free|risk[- ]free|no side[- ]effects|100% (?:safe|effective|results?|satisfaction)|instant results|results that last forever|miracle|look (?:\d+ )?years younger|best results)\b/gi;

const CREDENTIALS =
  /\b(?:board[- ]certified|licensed (?:physicians?|nurses?|estheticians?|aestheticians?|dentists?|professionals?|practitioners?|therapists?)|registered nurses?|nurse practitioners?|physician assistants?|medical director|doctors?|physicians?|surgeons?|md|dds|dmd|rn|np|pa-c)\b|\b(?:dr|m\.d|d\.d\.s)\.(?=[\s,;]|$)/gi;

const TESTIMONIALS =
  /\b(testimonials?|what (?:our )?(?:clients|patients|customers) (?:say|are saying)|patient stories|reviews from)\b|★|⭐/gi;

const unique = (list: string[]) => [...new Set(list.map((s) => s.trim()))];

export function healthFlags(text: string, ctx: HealthContext): HealthFlag[] {
  const plain = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const own = ctx.clientWords.toLowerCase();
  const flags: HealthFlag[] = [];

  const promises = unique(plain.match(PROMISES) ?? []).filter((p) => !own.includes(p.toLowerCase()));
  if (promises.length) flags.push({ key: "promise", rule: "No promises of results", found: promises.join(", ") });

  const titles = unique(plain.match(CREDENTIALS) ?? []).filter((c) => !own.includes(c.toLowerCase()));
  if (titles.length) flags.push({ key: "credential", rule: "Professional titles only as the client gives them", found: titles.join(", ") });

  if (!ctx.beforeAfterPermission && BEFORE_AFTER.test(plain)) {
    flags.push({ key: "before_after", rule: "Before-and-after photos only with the client's recorded permission", found: "before-and-after mentioned, and no permission is recorded in the intake's Photos section" });
  }

  const quotes = unique(plain.match(TESTIMONIALS) ?? []).filter((q) => !own.includes(q.toLowerCase()));
  if (quotes.length) flags.push({ key: "testimonial", rule: "Testimonials only when real and supplied by the client", found: quotes.join(", ") });

  return flags;
}

export function describeHealthFlags(flags: HealthFlag[]): string {
  return flags.map((f) => `${f.rule}: ${f.found}`).join(". ");
}

/* The client's own words and the recorded permission, from the intake. */
export function healthContextFrom(intake: {
  business: { certifications: string[]; licenseNumbers: string[] };
  services: { items: { name: string; description: string }[] };
  content: { suppliedCopy: string };
  process: { guarantees: string };
  photos: { beforeAfterPermission: boolean };
}): HealthContext {
  return {
    clientWords: [
      ...intake.business.certifications,
      ...intake.business.licenseNumbers,
      ...intake.services.items.flatMap((s) => [s.name, s.description]),
      intake.content.suppliedCopy,
      intake.process.guarantees,
    ].join("\n"),
    beforeAfterPermission: intake.photos.beforeAfterPermission,
  };
}

/* The same test the writers use, from an intake and its trade. */
export function isHealthProject(trade: string, intake: { business: { name: string }; services: { items: { name: string; description: string }[] } }): boolean {
  return isHealthBusiness(trade, [intake.business.name, ...intake.services.items.flatMap((s) => [s.name, s.description])]);
}

/*
  One item per thing to fix or confirm (Jason, 26 September 2026): each
  promise, title or testimonial wording on its own, so the PM confirms
  exactly what the client agreed to. The id is the rule and the words, so
  a confirmation carries to a later build with the same words.
*/
export interface HealthFlagItem {
  id: string;
  rule: string;
  found: string;
}

export function healthFlagItems(flags: HealthFlag[]): HealthFlagItem[] {
  return flags.flatMap((flag) => {
    const words = flag.key === "before_after" ? [flag.found] : flag.found.split(", ");
    return words.map((found) => ({ id: `${flag.key}:${found.toLowerCase()}`, rule: flag.rule, found }));
  });
}
