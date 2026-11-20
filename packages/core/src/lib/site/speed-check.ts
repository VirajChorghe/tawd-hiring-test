/*
  The Speed check (1 October 2026): what Google PageSpeed says about a
  page, in the shape TAWD keeps and shows: the four scores, the timings
  and the main things to fix, in Google's own words with how much each
  would save. Read by code from PageSpeed's answer; nothing is invented.
*/

export interface SpeedScores {
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
}

export interface SpeedResult {
  scores: SpeedScores;
  /** "1.2 s", "0.02": as Google shows them. */
  metrics: { fcp: string | null; lcp: string | null; cls: string | null; tbt: string | null; speedIndex: string | null };
  /** The main things to fix, worst first: Google's title and what it would save ("Est savings of 1,279 KiB"). */
  issues: { title: string; saves: string | null }[];
  /** The page is kept out of search engines (a preview): SEO reads low until go-live. */
  hiddenFromSearch: boolean;
}

interface Audit {
  title?: string;
  score?: number | null;
  scoreDisplayMode?: string;
  displayValue?: string;
}

const score = (c: { score?: number | null } | undefined) => (typeof c?.score === "number" ? Math.round(c.score * 100) : null);

export function readPageSpeed(json: unknown): SpeedResult | null {
  const lhr = (json as { lighthouseResult?: { categories?: Record<string, { score?: number | null }>; audits?: Record<string, Audit> } } | null)?.lighthouseResult;
  if (!lhr?.categories) return null;
  const audits = lhr.audits ?? {};
  const value = (id: string) => audits[id]?.displayValue ?? null;
  // What counts towards a better score: the insights and diagnostics that failed, worst first; not the timings themselves, nor the preview's search block.
  const skip = new Set(["first-contentful-paint", "largest-contentful-paint", "speed-index", "total-blocking-time", "cumulative-layout-shift", "interactive", "max-potential-fid", "is-crawlable"]);
  const issues = Object.entries(audits)
    .filter(([id, a]) => !skip.has(id) && typeof a.score === "number" && a.score < 0.9 && (a.scoreDisplayMode === "metricSavings" || a.scoreDisplayMode === "binary" || a.scoreDisplayMode === "numeric"))
    .sort((a, b) => (a[1].score ?? 1) - (b[1].score ?? 1))
    .slice(0, 6)
    .map(([, a]) => ({ title: a.title ?? "", saves: a.displayValue ?? null }))
    .filter((i) => i.title);
  return {
    scores: { performance: score(lhr.categories.performance), accessibility: score(lhr.categories.accessibility), bestPractices: score(lhr.categories["best-practices"]), seo: score(lhr.categories.seo) },
    metrics: { fcp: value("first-contentful-paint"), lcp: value("largest-contentful-paint"), cls: value("cumulative-layout-shift"), tbt: value("total-blocking-time"), speedIndex: value("speed-index") },
    issues,
    hiddenFromSearch: typeof audits["is-crawlable"]?.score === "number" && audits["is-crawlable"].score === 0,
  };
}

/* Google's bands: 90 and up good, 50 to 89 needs work, under 50 poor. */
export function scoreBand(n: number | null): "good" | "fair" | "poor" | "none" {
  if (n === null) return "none";
  return n >= 90 ? "good" : n >= 50 ? "fair" : "poor";
}

/* PageSpeed's address for one page, one device, all four scores. */
export function pageSpeedUrl(url: string, strategy: "mobile" | "desktop", key?: string | null): string {
  const q = new URLSearchParams({ url, strategy });
  for (const c of ["performance", "accessibility", "best-practices", "seo"]) q.append("category", c);
  if (key) q.set("key", key);
  return `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q.toString()}`;
}
