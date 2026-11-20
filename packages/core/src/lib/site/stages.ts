/*
  Staged site builds (Jason, 6 October 2026; standing rules 2 and 8): a
  Lane 1 site is built in stages, one page first, each checked before the
  next. Home first (it also makes the header and footer), then each other
  main page alone, then each group (services, service areas, articles):
  its first page alone, then the rest as one bundle. TAWD's own pages
  (privacy, cookies, thank-you, 404, sitemap, robots) are written by code
  with every stage. All by code; nothing here asks the AI.
*/

export interface StagePage {
  name: string;
  kind: string;
  slug: string;
}

export type StageGroup = "service" | "city" | "article";

export interface BuildStage {
  /** "home", "page:about", "service:first", "service:rest" ... */
  key: string;
  /** "Home", "About", "The first service page: Ant control", "The other 11 service pages" */
  label: string;
  /** The button: "Build Home first", "Build About", "Build the first service page (Ant control)", "Build the other 11 service pages". */
  button: string;
  /** The pages' keys (slug, or "home"). */
  slugs: string[];
  names: string[];
  /** Only the Home stage makes the header and footer. */
  makesParts: boolean;
  group: StageGroup | null;
}

/** What a staged build is asked to do (site_build.options). */
export interface StageBuildOptions {
  kind: "stage";
  /** The pages built by AI this time (slug keys); the rest are kept from the last version or stay "Coming soon". */
  only: string[];
  /** What it was estimated to cost when started: it stops itself at twice this. */
  estimate?: number;
  /** In words, for the activity log and the Build page: "Home", "The other 11 service pages", "Every remaining page". */
  stage: string;
}

export const stageSlugKey = (slug: string): string => slug || "home";

/** The pages TAWD writes itself with every stage, free. */
export const CODE_WRITTEN_PAGES = ["Privacy Policy", "Cookie Policy", "Thank you", "the 404 page", "sitemap.xml", "robots.txt"] as const;

const GROUPS: { kind: StageGroup; one: string; many: string; first: string }[] = [
  { kind: "service", one: "service page", many: "service pages", first: "The first service page" },
  { kind: "city", one: "service-area page", many: "service-area pages", first: "The first service-area page" },
  { kind: "article", one: "article", many: "articles", first: "The first article" },
];

/* The stages, in order, for a page plan (in its own order). */
export function planStages(pages: StagePage[]): BuildStage[] {
  if (pages.length === 0) return [];
  const home = pages.find((p) => p.kind === "home") ?? pages[0]!;
  const grouped = new Set<string>(GROUPS.map((g) => g.kind));
  const stages: BuildStage[] = [{ key: "home", label: home.name, button: `Build ${home.name} first`, slugs: [stageSlugKey(home.slug)], names: [home.name], makesParts: true, group: null }];
  for (const p of pages) {
    if (p === home || grouped.has(p.kind)) continue;
    stages.push({ key: `page:${stageSlugKey(p.slug)}`, label: p.name, button: `Build ${p.name}`, slugs: [stageSlugKey(p.slug)], names: [p.name], makesParts: false, group: null });
  }
  for (const g of GROUPS) {
    const members = pages.filter((p) => p !== home && p.kind === g.kind);
    if (members.length === 0) continue;
    const [first, ...rest] = members;
    stages.push({ key: `${g.kind}:first`, label: `${g.first}: ${first!.name}`, button: `Build ${g.first.toLowerCase()} (${first!.name})`, slugs: [stageSlugKey(first!.slug)], names: [first!.name], makesParts: false, group: g.kind });
    if (rest.length) {
      const label = rest.length === 1 ? `The other ${g.one}` : `The other ${rest.length} ${g.many}`;
      stages.push({
        key: `${g.kind}:rest`,
        label,
        button: `Build ${label.toLowerCase()}`,
        slugs: rest.map((p) => stageSlugKey(p.slug)),
        names: rest.map((p) => p.name),
        makesParts: false,
        group: g.kind,
      });
    }
  }
  return stages;
}

export interface StageState extends BuildStage {
  status: "built" | "next" | "waiting";
  /** The version the stage's pages were built in (the newest of them), once built. */
  builtIn: number | null;
  /** The stage's pages not built yet (a page added to the plan later counts here). */
  toBuild: string[];
}

/*
  Each stage's state against what the latest version has: built (every
  page in it), next (the first stage not built) or waiting. `built` maps
  each built page's key to the version that built it.
*/
export function stageStates(stages: BuildStage[], built: Map<string, number>): StageState[] {
  let nextGiven = false;
  return stages.map((s) => {
    const toBuild = s.slugs.filter((k) => !built.has(k));
    if (toBuild.length === 0) {
      return { ...s, status: "built", builtIn: Math.max(...s.slugs.map((k) => built.get(k)!)), toBuild };
    }
    const status = nextGiven ? "waiting" : "next";
    nextGiven = true;
    return { ...s, status, builtIn: null, toBuild };
  });
}

/** "12 of 49 pages built" */
export function builtCountLine(states: StageState[]): { built: number; total: number; line: string } {
  const total = states.reduce((n, s) => n + s.slugs.length, 0);
  const built = states.reduce((n, s) => n + s.slugs.length - s.toBuild.length, 0);
  return { built, total, line: `${built} of ${total} page${total === 1 ? "" : "s"} built` };
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/*
  A page not built yet, in a partial version: the site's header and footer
  around a short, clearly marked notice, so every menu link works on the
  preview and nothing reads as a finished page. Never indexed, never in
  the sitemap; go-live waits until it's gone.
*/
export function comingSoonMain(name: string): string {
  return `<main id="main" class="tawd-coming-soon"><section class="tawd-simple-page"><p class="tawd-coming-soon-tag">Not built yet</p><h1>${escapeHtml(name)}: coming soon</h1><p>This page is planned for the site and comes in a later stage of the build. Until then, this notice stands in for it on the preview.</p><p><a href="/">Back to the home page</a></p></section></main>`;
}

export const COMING_SOON_CSS = `.tawd-coming-soon-tag{display:inline-block;margin:0 0 16px;padding:4px 10px;border:1.5px dashed currentColor;border-radius:999px;font-size:14px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;opacity:.8}`;

/* ---------- estimates ---------- */

/** The page prompt's own words around the copy (the page list, the rules, the reply format), in tokens. */
export const PAGE_PROMPT_OVERHEAD_TOKENS = 1_500;
/** First guesses until page calls have been measured. */
export const STAGE_PAGE_GUESS = { outputPerInput: 1.6, markupTokens: 3_000, systemTokens: 25_000 };

export interface PageCallHistory {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/*
  The tokens one page will take, scaled with its copy: a long kept page
  costs more than a short new one. Learned from past page calls (the
  output-to-input ratio and the cached system prompt) when there are any.
*/
export function stagePageTokens(copyChars: number, history: PageCallHistory[]): { inputTokens: number; outputTokens: number; cacheReadTokens: number } {
  const inputTokens = PAGE_PROMPT_OVERHEAD_TOKENS + Math.ceil(copyChars / 4);
  if (history.length === 0) {
    return { inputTokens, outputTokens: Math.round(STAGE_PAGE_GUESS.markupTokens + Math.ceil(copyChars / 4) * STAGE_PAGE_GUESS.outputPerInput), cacheReadTokens: STAGE_PAGE_GUESS.systemTokens };
  }
  const sumIn = history.reduce((n, c) => n + Math.max(c.inputTokens, 1), 0);
  const sumOut = history.reduce((n, c) => n + c.outputTokens, 0);
  const cacheRead = Math.round(history.reduce((n, c) => n + c.cacheReadTokens, 0) / history.length);
  return { inputTokens, outputTokens: Math.round(inputTokens * (sumOut / sumIn)), cacheReadTokens: cacheRead || STAGE_PAGE_GUESS.systemTokens };
}
