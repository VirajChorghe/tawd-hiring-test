/*
  Matching a new page to the old site's page whose photos it should reuse
  (crawl-%, Jason 7 November 2026). "Everything new" projects with a current
  site (and kept projects too) give each built page its own real photos: the
  old page most like it supplies them.

  Rule 1 (the important one): only a match we're confident in — the same path,
  or a clear overlap of meaningful words. When it's unclear this returns null
  and the caller falls back to the home page's photos, never a guess: a wrong
  product photo on a page is worse than a repeated one.

  Structure/words only; the photos, alt text, de-duplication across neighbours
  and the record of which old page was used are the caller's job.
*/

export interface OldPageForMatch {
  /** The old page's path, e.g. "/awnings/" ("/" is the home page). */
  path: string;
  title: string;
  name: string;
  h1s: string[];
}

export interface NewPageForMatch {
  /** "" for the home page; otherwise the page's slug (its path is `/${slug}/`). */
  slug: string;
  name: string;
  mainKeyword: string;
}

export interface PageMatch {
  oldPath: string;
  /** Why it matched, for the build notes / activity log. */
  reason: string;
}

// Words too general to tie a page to a topic: joiners, web noise, and the generic
// service qualifiers that recur across sibling pages — if these counted, "emergency
// plumbing repair" and "emergency electrical repair" would share two words and wrongly
// match. Only the distinguishing nouns (plumbing vs electrical) should decide.
const STOP = new Set([
  "the", "and", "a", "an", "of", "in", "for", "to", "our", "us", "we", "your", "you",
  "page", "html", "htm", "php", "index", "home", "www", "com", "near", "me", "services", "service",
  "with", "on", "at", "by", "or", "is", "are",
  // generic service qualifiers (not a topic on their own)
  "repair", "repairs", "installation", "install", "installs", "installed", "replacement", "replace",
  "maintenance", "cleaning", "clean", "removal", "remove", "inspection", "inspect", "cost", "costs",
  "pricing", "price", "prices", "commercial", "residential", "emergency", "local", "free", "estimate",
  "estimates", "quote", "quotes", "affordable", "best", "top", "professional", "expert", "experts",
  "company", "contractor", "contractors", "new", "used",
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !STOP.has(t)),
  );
}

/** The path turned into words ("/standing-seam-awnings/" → "standing seam awnings"). */
function pathWords(path: string): string {
  return path.replace(/[/_-]+/g, " ");
}

/** A new page's path from its slug ("" is the home). */
export function newPagePath(slug: string): string {
  return slug ? `/${slug}/` : "/";
}

/*
  The old page a new page should take its photos from, or null when no match
  is confident enough (the caller then uses the home page's photos).

  - The same path is the surest match.
  - Otherwise the old page sharing the most meaningful words, and only when at
    least two are shared, so a single shared word (often the city) is not
    enough to pick a page. `generalWords` (e.g. the business's own keyword and
    city) are never counted toward that.
*/
export function matchOldPage(
  newPage: NewPageForMatch,
  oldPages: OldPageForMatch[],
  options: { generalWords?: string; homePath?: string } = {},
): PageMatch | null {
  const homePath = options.homePath ?? "/";
  const path = newPagePath(newPage.slug);
  if (path === homePath) return null; // the home keeps its own photos; never matched here

  const exact = oldPages.find((o) => o.path === path && o.path !== homePath);
  if (exact) return { oldPath: exact.path, reason: "same path on the old site" };

  const general = tokens(options.generalWords ?? "");
  const mine = new Set([...tokens(`${pathWords(path)} ${newPage.name} ${newPage.mainKeyword}`)].filter((w) => !general.has(w)));
  if (mine.size === 0) return null;

  let best: { page: OldPageForMatch; shared: string[] } | null = null;
  for (const old of oldPages) {
    if (old.path === homePath) continue; // the home's photos are the fallback, never a topic match
    const theirs = tokens(`${pathWords(old.path)} ${old.title} ${old.name} ${old.h1s.join(" ")}`);
    const shared = [...mine].filter((w) => theirs.has(w));
    if (shared.length >= 2 && (!best || shared.length > best.shared.length)) best = { page: old, shared };
  }
  if (best) return { oldPath: best.page.path, reason: `shares "${best.shared.join(", ")}"` };
  return null; // not confident — fall back to the home page's photos
}
