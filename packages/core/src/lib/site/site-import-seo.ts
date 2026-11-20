import { blockText, hostOf, importKind, notAService, pagePlace, importName, importPath, keptMarkdown, slugFromPath, textSimilarity, type CrawlResult, type CrawledPage, type ImportKind, type PageContact } from "./site-import";

/*
  Keep the current site, the SEO side (Jason, 6 October 2026): the kept
  pages checked against TAWD's own SEO rules (the ones the SEO pass and the
  go-live SEO check use), by code, free. Suggestions only: nothing changes
  until the SEO team decides. Each says the page, what TAWD found, why it
  matters and what TAWD would do.
*/

export interface ImportedPageSummary {
  path: string;
  url: string;
  kind: ImportKind;
  name: string;
  title: string;
  metaDescription: string;
  canonical: string | null;
  robots: string;
  h1s: string[];
  headings: { level: number; text: string }[];
  wordCount: number;
  images: number;
  /** Pictures with no alt attribute at all. */
  imagesNoAlt: number;
  /** Pictures whose alt text is a file name ("IMG_2041.jpg", "Ant-Control-1"). */
  imagesFileAlt: number;
  /** Paths this page links to in its words (the site's own pages). */
  internalLinks: string[];
  /** Links to the site's own pages written with http://. */
  httpLinks: number;
  hasForm: boolean;
  reviewWidgets: number;
  schemaTypes: string[];
  phones: string[];
  mixedContent: number;
  /** The most alike other page, when over half its words are the same runs. */
  similar: { path: string; percent: number } | null;
  /** What keeping the words changed in structure (a second H1 as an H2, a title used as the H1). */
  notes: string[];
  /** The kept page in storage ("" for a gap: nothing was read). */
  key: string;
  /** Blocked sites: read from the live site or through a blocked route (0.94.0 rows: the Internet Archive), and the copy's date (ISO). */
  readFrom?: "site" | "fallback" | "archive";
  /** The blocked route that gave the page (its name). */
  via?: string;
  snapshotAt?: string;
  /** On the list, but neither the live site nor the blocked route could give it: planned with a placeholder for its words. */
  gap?: boolean;
  /** tel:, mailto: and JSON-LD addresses the page carries (0.96.0, for filling empty intake answers). */
  contact?: PageContact;
  /** The read could see the page's canonical link (0.99.0: Jina's reads before then removed every link tag). */
  canonicalSeen?: boolean;
}

const FILE_ALT = /(\.(jpe?g|png|gif|webp|svg)$)|^(img|dsc|image|photo|screenshot)[-_ ]?\d+|[a-z]+-[a-z0-9]+-\d+(-e\d+)?$|^[\w-]+-\d{2,}x\d{2,}$/i;

export function summarizeCrawled(page: CrawledPage, extra: { kind: ImportKind; name: string; key: string }): ImportedPageSummary {
  const e = page.extracted;
  const heads = e.blocks.flatMap((b) => (b.type === "heading" ? [{ level: b.level, text: b.text }] : []));
  const internal = [...new Set(e.links.filter((l) => l.internal).map((l) => importPath(l.url)))];
  return {
    path: page.path,
    url: page.url,
    kind: extra.kind,
    name: extra.name,
    title: e.title,
    metaDescription: e.metaDescription,
    canonical: e.canonical,
    robots: e.robots,
    h1s: heads.filter((h) => h.level === 1).map((h) => h.text),
    headings: heads.slice(0, 60),
    wordCount: e.wordCount,
    images: e.images.length,
    imagesNoAlt: e.images.filter((i) => i.alt === null).length,
    imagesFileAlt: e.images.filter((i) => i.alt && FILE_ALT.test(i.alt.trim())).length,
    internalLinks: internal,
    httpLinks: e.links.filter((l) => l.internal && /^http:\/\//i.test(l.url)).length,
    hasForm: e.hasForm,
    reviewWidgets: e.reviewWidgets,
    schemaTypes: e.schemaTypes,
    phones: e.phones,
    mixedContent: e.mixedContent,
    similar: null,
    notes: keptMarkdown(e, heads.find((h) => h.level === 1)?.text ?? e.title).notes,
    key: extra.key,
    ...(page.readFrom ? { readFrom: page.readFrom } : {}),
    ...(page.via ? { via: page.via } : {}),
    ...(page.snapshotAt ? { snapshotAt: page.snapshotAt } : {}),
    ...(e.contact ? { contact: e.contact } : {}),
    canonicalSeen: true,
  };
}

/* A page nothing could read (blocked live, not in the archive): its kind and name guessed from its address, no words, no file. */
export function gapSummary(url: string, input: { menu: { label: string; url: string }[]; host: string; cities: string[]; siteName: string }): ImportedPageSummary {
  const path = importPath(url);
  const kind = importKind({ path, title: "", h1: "", cities: input.cities });
  const menuLabel = input.menu.find((m) => hostOf(m.url) === input.host && importPath(m.url) === path)?.label ?? null;
  const name = importName({ path, title: "", h1: "", menuLabel, kind, siteName: input.siteName });
  return {
    path,
    url,
    kind,
    name,
    title: "",
    metaDescription: "",
    canonical: null,
    robots: "",
    h1s: [],
    headings: [],
    wordCount: 0,
    images: 0,
    imagesNoAlt: 0,
    imagesFileAlt: 0,
    internalLinks: [],
    httpLinks: 0,
    hasForm: false,
    reviewWidgets: 0,
    schemaTypes: [],
    phones: [],
    mixedContent: 0,
    similar: null,
    notes: [],
    key: "",
    gap: true,
  };
}

/* What's stored for one kept page (R2): its words as the kept copy, and what the plan needs. */
export interface KeptPageFile {
  url: string;
  path: string;
  kind: ImportKind;
  name: string;
  title: string;
  metaDescription: string;
  h1: string;
  markdown: string;
  notes: string[];
  hadForm: boolean;
  images: { src: string; alt: string | null }[];
  /** "archive": saved by 0.94.0 (the Internet Archive, removed in 0.96.0). */
  readFrom?: "site" | "fallback" | "archive";
  /** The blocked route that gave the page (its name). */
  via?: string;
  snapshotAt?: string;
}

/*
  The crawl as the job stores it: a summary row per page (the database)
  and a file per page (R2). Kinds and names by code; the blog page becomes
  a plain list of the kept articles (made by TAWD from their titles; the
  old page's own words before its list are kept), and a blog with no page
  of its own gets one, so no article is left without a way in.
*/
export function importRecords(crawl: CrawlResult, input: { keyFor: (n: number) => string; cities: string[]; siteName: string }): { summaries: ImportedPageSummary[]; files: { key: string; page: KeptPageFile }[] } {
  const menuLabel = (path: string) => crawl.menu.find((m) => hostOf(m.url) === crawl.host && importPath(m.url) === path)?.label ?? null;
  const articles = crawl.pages.filter((p) => importKind({ path: p.path, title: p.extracted.title, h1: "", fromPosts: p.fromPosts }) === "article");
  const folders = new Map<string, number>();
  for (const a of articles) {
    const folder = a.path.split("/").filter(Boolean).slice(0, -1).join("/");
    if (folder) folders.set(folder, (folders.get(folder) ?? 0) + 1);
  }
  const blogFolder = [...folders.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const blogIndex = blogFolder ? `/${blogFolder}/` : null;
  const pages = [...crawl.pages];
  if (blogIndex && articles.length && !pages.some((p) => p.path === blogIndex)) {
    pages.push({ url: `${crawl.origin}${blogIndex}`, path: blogIndex, fromPosts: false, extracted: { ...emptyExtract(), title: "Blog", blocks: [{ type: "heading", level: 1, text: "Blog" }] } });
  }
  const similar = markSimilarPages(pages.filter((p) => !articles.includes(p)).map((p) => ({ path: p.path, text: pageText(p) })));
  const summaries: ImportedPageSummary[] = [];
  const files: { key: string; page: KeptPageFile }[] = [];
  pages.forEach((page, n) => {
    const h1 = page.extracted.blocks.find((b) => b.type === "heading" && b.level === 1);
    const h1Text = h1 && h1.type === "heading" ? h1.text : "";
    const kind = importKind({ path: page.path, title: page.extracted.title, h1: h1Text, fromPosts: page.fromPosts, blogIndex, cities: input.cities });
    const name = importName({ path: page.path, title: page.extracted.title, h1: h1Text, menuLabel: menuLabel(page.path), kind, siteName: input.siteName });
    const key = input.keyFor(n);
    let { markdown, notes } = keptMarkdown(page.extracted, h1Text || page.extracted.title || name);
    if (kind === "blog") {
      const list = articles.map((a) => {
        const title = a.extracted.blocks.find((b) => b.type === "heading" && b.level === 1);
        return `- [${(title && title.type === "heading" ? title.text : a.extracted.title || a.path).replace(/[[\]]/g, "")}](${a.path})`;
      });
      // The old page's heading and any words above its list of posts, then TAWD's list of the kept articles.
      const own = keptMarkdown({ blocks: page.extracted.blocks.filter((b) => b.type === "heading" || b.type === "p"), title: page.extracted.title }, h1Text || name).markdown.trim();
      markdown = `${own}\n\n${list.join("\n")}\n`;
      notes = [...notes, `The list of articles is made by TAWD from the kept articles' titles (${articles.length}).`];
    }
    const summary = summarizeCrawled(page, { kind, name, key });
    summary.similar = similar.get(page.path) ?? null;
    summary.notes = notes;
    summaries.push(summary);
    files.push({
      key,
      page: {
        url: page.url,
        path: page.path,
        kind,
        name,
        title: page.extracted.title,
        metaDescription: page.extracted.metaDescription,
        h1: h1Text,
        markdown,
        notes,
        hadForm: page.extracted.hasForm,
        images: page.extracted.images,
        ...(page.readFrom ? { readFrom: page.readFrom } : {}),
        ...(page.via ? { via: page.via } : {}),
        ...(page.snapshotAt ? { snapshotAt: page.snapshotAt } : {}),
      },
    });
  });
  // The pages nothing could read (7 October 2026): listed for Use these pages to plan, with a placeholder for their words.
  for (const url of crawl.gaps ?? []) summaries.push(gapSummary(url, { menu: crawl.menu, host: crawl.host, cities: input.cities, siteName: input.siteName }));
  return { summaries, files };
}

function emptyExtract(): CrawledPage["extracted"] {
  return { title: "", metaDescription: "", canonical: null, robots: "", blocks: [], images: [], links: [], hasForm: false, reviewWidgets: 0, schemaTypes: [], mixedContent: 0, phones: [], wordCount: 0, menu: [] };
}

/* Each page's most alike other page, when they share over half their runs of words (city pages copied from one another). */
export function markSimilarPages(pages: { path: string; text: string }[], threshold = 0.5): Map<string, { path: string; percent: number }> {
  const out = new Map<string, { path: string; percent: number }>();
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const score = textSimilarity(pages[i]!.text, pages[j]!.text);
      if (score < threshold) continue;
      const percent = Math.round(score * 100);
      for (const [a, b] of [
        [pages[i]!, pages[j]!],
        [pages[j]!, pages[i]!],
      ] as const) {
        if ((out.get(a.path)?.percent ?? 0) < percent) out.set(a.path, { path: b.path, percent });
      }
    }
  }
  return out;
}

export function pageText(page: CrawledPage): string {
  return page.extracted.blocks.map(blockText).join(" ");
}

export interface SuggestionItem {
  page: string;
  found: string;
}

export interface SuggestionGroup {
  key: string;
  title: string;
  why: string;
  would: string;
  /** high: costs rankings or visitors now; medium: worth fixing; low: tidy-up. */
  importance: "high" | "medium" | "low";
  items: SuggestionItem[];
}

export interface SiteFacts {
  name: string;
  phone: string;
  city: string;
  /** The intake's service areas, as written ("Folsom, CA"). */
  cities: string[];
  services: string[];
}

export const TITLE_MAX = 60;
export const META_MAX = 155;
export const META_MIN = 70;
const THIN: Partial<Record<ImportKind, number>> = { home: 300, service: 300, city: 300, about: 150, article: 500, pricing: 150, service_areas: 150 };

const digits = (s: string) => s.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
const STOP = new Set(["the", "and", "a", "an", "of", "in", "for", "to", "our", "us", "your", "with", "on", "at", "by", "we", "you", "is", "are", "page", "home", "services", "service", "company"]);
const topicWords = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)));

/*
  The suggestions, most important first. Every rule here is one TAWD's own
  build or go-live check holds its new pages to.
*/
export function currentSiteSuggestions(input: {
  pages: ImportedPageSummary[];
  brokenLinks: { from: string; to: string; status: number | null }[];
  notImported: string[];
  facts: SiteFacts;
}): SuggestionGroup[] {
  const { pages, facts } = input;
  const groups: SuggestionGroup[] = [];
  const add = (group: Omit<SuggestionGroup, "items">, items: SuggestionItem[]) => {
    if (items.length) groups.push({ ...group, items });
  };
  const content = pages.filter((p) => p.kind !== "blog");
  // Service and city pages by their address too: a page about media mentions or partners isn't one, whatever words its address has.
  const localPages = content.filter((p) => p.kind === "home" || ((p.kind === "service" || p.kind === "city") && !notAService(p.path)));

  // Titles.
  add(
    { key: "title-missing", title: "Pages with no title", why: "The title is the blue link in Google's results; without one Google makes its own, often badly.", would: "Write a title of up to 60 characters with the page's service and city, in the page plan.", importance: "high" },
    content.filter((p) => !p.title).map((p) => ({ page: p.path, found: "No <title>." })),
  );
  add(
    { key: "title-long", title: "Titles too long for search results", why: "Google cuts titles at about 60 characters, so the end (often the business name or the city) isn't seen.", would: "Shorten each to 60 characters or fewer, keeping the service and city first.", importance: "medium" },
    content.filter((p) => p.title.length > TITLE_MAX).map((p) => ({ page: p.path, found: `${p.title.length} characters: "${p.title}"` })),
  );
  const byTitle = new Map<string, string[]>();
  for (const p of content) if (p.title) byTitle.set(p.title.toLowerCase(), [...(byTitle.get(p.title.toLowerCase()) ?? []), p.path]);
  add(
    { key: "title-duplicate", title: "The same title on several pages", why: "Pages with the same title compete with each other, and Google may show the wrong one.", would: "Give each page its own title naming what's on it.", importance: "high" },
    [...byTitle.values()].filter((paths) => paths.length > 1).flatMap((paths) => paths.map((path) => ({ page: path, found: `Same title as ${paths.filter((p) => p !== path).join(", ")}` }))),
  );
  const places = [facts.city, ...facts.cities].map((c) => c.split(",")[0]!.trim().toLowerCase()).filter((c) => c.length > 2);
  if (places.length) {
    add(
      { key: "title-city", title: "Titles without a city", why: "Local searches name a place (\"pest control Folsom\"); a title with the city is more likely to show for them.", would: "Add the main city (or the page's own city) to the title.", importance: "medium" },
      localPages
        .filter((p) => p.title && !places.some((c) => p.title.toLowerCase().includes(c)) && !/,\s*[A-Z]{2}\b/.test(p.title))
        // A city page whose title names its own place ("Pest Control El Dorado Hills" on /pest-control-el-dorado-hills-ca/), in the intake or not.
        .filter((p) => {
          const place = p.kind === "city" ? pagePlace(p.path) : null;
          return !place || !` ${p.title.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `.includes(` ${place} `);
        })
        .map((p) => ({ page: p.path, found: `"${p.title}"` })),
    );
  }
  add(
    { key: "title-service", title: "Service page titles that don't name the service", why: "The title is the strongest signal of what the page is about.", would: "Start the title with the service (\"Ant Control in Folsom, CA\").", importance: "medium" },
    localPages
      .filter((p) => p.kind === "service" && p.title)
      .filter((p) => {
        const want = topicWords(`${p.name} ${slugFromPath(p.path).replace(/-/g, " ")}`);
        const have = topicWords(p.title);
        return want.size > 0 && ![...want].some((w) => have.has(w) || have.has(w.replace(/s$/, "")) || have.has(`${w}s`));
      })
      .map((p) => ({ page: p.path, found: `"${p.title}"` })),
  );

  // Meta descriptions.
  add(
    { key: "meta-missing", title: "Pages with no meta description", why: "Google shows the description under the title; without one it picks a random line from the page.", would: "Write one of 70 to 155 characters that says what the visitor gets and how to call.", importance: "medium" },
    content.filter((p) => !p.metaDescription).map((p) => ({ page: p.path, found: "No meta description." })),
  );
  add(
    { key: "meta-length", title: "Meta descriptions too long or too short", why: `Google shows about ${META_MAX} characters; a very short one wastes the space.`, would: `Keep each between ${META_MIN} and ${META_MAX} characters.`, importance: "low" },
    content
      .filter((p) => p.metaDescription && (p.metaDescription.length > META_MAX || p.metaDescription.length < META_MIN))
      .map((p) => ({ page: p.path, found: `${p.metaDescription.length} characters` })),
  );
  const byMeta = new Map<string, string[]>();
  for (const p of content) if (p.metaDescription) byMeta.set(p.metaDescription.toLowerCase(), [...(byMeta.get(p.metaDescription.toLowerCase()) ?? []), p.path]);
  add(
    { key: "meta-duplicate", title: "The same meta description on several pages", why: "Repeated descriptions make the pages look alike in search results.", would: "Write one description per page.", importance: "medium" },
    [...byMeta.values()].filter((paths) => paths.length > 1).flatMap((paths) => paths.map((path) => ({ page: path, found: `Same as ${paths.filter((p) => p !== path).join(", ")}` }))),
  );

  // Headings.
  add(
    { key: "h1-missing", title: "Pages with no H1", why: "The H1 tells visitors and Google what the page is about.", would: "TAWD already used the page's title as its H1 in the kept words; check it reads well.", importance: "high" },
    content.filter((p) => p.h1s.length === 0).map((p) => ({ page: p.path, found: "No H1 on the page." })),
  );
  add(
    { key: "h1-multiple", title: "Pages with more than one H1", why: "One H1 per page keeps the main topic clear.", would: "TAWD keeps the first as the H1 and the others as H2s (same words).", importance: "medium" },
    content.filter((p) => p.h1s.length > 1).map((p) => ({ page: p.path, found: `${p.h1s.length} H1s: ${p.h1s.map((h) => `"${h.slice(0, 60)}"`).join(", ")}` })),
  );
  add(
    { key: "h1-topic", title: "H1s that don't match the page's topic", why: "When the H1 and the title talk about different things, Google is less sure what to rank the page for.", would: "Make the H1 name the page's service or city, close to the title.", importance: "low" },
    content
      .filter((p) => p.kind !== "home" && p.h1s.length >= 1 && p.title)
      .filter((p) => {
        const h1 = topicWords(p.h1s[0]!);
        const topic = topicWords(`${p.title} ${slugFromPath(p.path).replace(/[-/]/g, " ")}`);
        return h1.size > 0 && ![...h1].some((w) => topic.has(w) || topic.has(w.replace(/s$/, "")));
      })
      .map((p) => ({ page: p.path, found: `H1 "${p.h1s[0]}", title "${p.title}"` })),
  );
  add(
    { key: "heading-order", title: "Headings that skip a level", why: "Screen readers and Google read headings as an outline; a jump from H2 to H4 breaks it.", would: "Use the next level down (H2, then H3).", importance: "low" },
    content
      .map((p) => {
        const jumps: string[] = [];
        p.headings.forEach((h, i) => {
          const before = p.headings[i - 1];
          if (before && h.level > before.level + 1) jumps.push(`H${before.level} to H${h.level} at "${h.text.slice(0, 50)}"`);
        });
        return { page: p.path, found: jumps.slice(0, 3).join("; ") + (jumps.length > 3 ? ` (and ${jumps.length - 3} more)` : "") };
      })
      .filter((x) => x.found),
  );

  // Pictures.
  add(
    { key: "alt", title: "Pictures without alt text", why: "Alt text describes a picture to blind visitors and to Google Images.", would: "TAWD writes alt text for every picture on the new site; the ones without any are listed so the team can describe them.", importance: "medium" },
    content.filter((p) => p.imagesNoAlt + p.imagesFileAlt > 0).map((p) => ({ page: p.path, found: [p.imagesNoAlt ? `${p.imagesNoAlt} with no alt text` : "", p.imagesFileAlt ? `${p.imagesFileAlt} with a file name as alt text` : ""].filter(Boolean).join(", ") + ` (of ${p.images})` })),
  );

  // Thin content and near-duplicates.
  add(
    { key: "thin", title: "Pages with few words", why: "Pages with little to say rarely rank, and visitors leave without the answer they came for.", would: "Add what a customer asks about this service or place (the team decides; TAWD invents nothing).", importance: "medium" },
    content.filter((p) => THIN[p.kind] !== undefined && p.wordCount < THIN[p.kind]!).map((p) => ({ page: p.path, found: `${p.wordCount} words (aim for ${THIN[p.kind]}+)` })),
  );
  add(
    { key: "similar", title: "Pages that are mostly the same words", why: "City pages copied from one another with the name swapped are treated as near-duplicates: Google ranks one and ignores the rest.", would: "Give each its own local details (neighbourhoods, local pests, jobs done there), or merge them.", importance: "high" },
    content.filter((p) => p.similar).map((p) => ({ page: p.path, found: `${p.similar!.percent}% the same runs of words as ${p.similar!.path}` })),
  );
  const homes = content.filter((p) => p.kind !== "home" && /^\/(home|homepage|home-page|index|home-\d+|homepage-\d+)\/$/.test(p.path));
  add(
    { key: "second-home", title: "A second home page", why: "An old copy of the home page competes with the real one.", would: "Leave it out of the new site; the redirects send its address to the home page.", importance: "medium" },
    homes.map((p) => ({ page: p.path, found: `"${p.title || p.name}"` })),
  );

  // Links.
  // No "pages nothing links to" (Jason, 7 October 2026): the new site's menu, footer and blog list link every kept page, so there's nothing for the team to do.
  add(
    { key: "broken", title: "Links to pages that don't exist", why: "Broken links lose visitors and waste the trust a link passes.", would: "Point each at the right page, or remove the link (the team picks the page).", importance: "high" },
    input.brokenLinks.map((b) => ({ page: b.from, found: `Links to ${b.to}, which answers ${b.status ?? "nothing"}` })),
  );
  const notCarried = new Set(input.notImported.map(importPath));
  add(
    { key: "not-carried", title: "Links to pages over the plan's page limit", why: "Those pages aren't on the new site, so the links would break.", would: "The redirects send them to the closest page; or the client moves up a tier to keep them.", importance: "medium" },
    content.flatMap((p) => p.internalLinks.filter((l) => notCarried.has(l)).slice(0, 5).map((l) => ({ page: p.path, found: `Links to ${l}` }))),
  );
  add(
    { key: "canonical", title: "Canonical tags that point elsewhere or are missing", why: "The canonical tells Google which address is the real one; a wrong one can drop the page from Google.", would: "TAWD writes a correct canonical on every page of the new site (once the domain is in the intake).", importance: "medium" },
    content
      // A page Jina read before 0.99.0 had its link tags removed: its canonical is unknown, not missing.
      .filter((p) => p.canonicalSeen || p.via !== "jina")
      .map((p) => {
        if (!p.canonical) return { page: p.path, found: "No canonical tag." };
        if (importPath(p.canonical) !== p.path) return { page: p.path, found: `Points at ${p.canonical}` };
        if (/^http:/i.test(p.canonical) && /^https:/i.test(p.url)) return { page: p.path, found: `Uses http:// (${p.canonical})` };
        return null;
      })
      .filter((x): x is SuggestionItem => x !== null),
  );
  add(
    { key: "noindex", title: "Pages hidden from Google", why: "A noindex page never shows in search results, which may not be what the client wants.", would: "Ask the client whether these should rank; the new site lets Google in once it's live.", importance: "high" },
    content.filter((p) => /noindex/.test(p.robots)).map((p) => ({ page: p.path, found: `robots: ${p.robots}` })),
  );
  add(
    { key: "mixed", title: "http:// on an https site", why: "Pictures or scripts over http:// show a \"Not secure\" warning or don't load; http:// links take a redirect.", would: "The new site uses https:// for everything.", importance: "low" },
    content
      .filter((p) => p.mixedContent > 0 || p.httpLinks > 0)
      .map((p) => ({ page: p.path, found: [p.mixedContent ? `${p.mixedContent} file${p.mixedContent === 1 ? "" : "s"} over http://` : "", p.httpLinks ? `${p.httpLinks} link${p.httpLinks === 1 ? "" : "s"} to its own pages over http://` : ""].filter(Boolean).join(", ") })),
  );

  // Structured data.
  const home = pages.find((p) => p.kind === "home");
  const local = (types: string[]) => types.some((t) => /LocalBusiness|Organization|Service$|Contractor|Plumber|Electrician|HVACBusiness|RoofingContractor|PestControl|Attorney|LegalService|HomeAndConstructionBusiness/.test(t));
  if (home && !local(home.schemaTypes)) {
    add(
      { key: "schema-home", title: "No business details for Google on the home page", why: "LocalBusiness structured data gives Google the name, phone, address and hours for the map and the knowledge panel.", would: "TAWD writes LocalBusiness data from the intake on the home and contact pages of every build.", importance: "medium" },
      [{ page: "/", found: home.schemaTypes.length ? `Only ${home.schemaTypes.slice(0, 5).join(", ")}` : "No structured data." }],
    );
  }
  add(
    { key: "schema-service", title: "Service pages without Service structured data", why: "Service data tells Google which service the page offers, where.", would: "TAWD doesn't add Service data yet: the SEO team decides whether it's worth asking for.", importance: "low" },
    content.filter((p) => p.kind === "service" && !p.schemaTypes.includes("Service")).map((p) => ({ page: p.path, found: p.schemaTypes.length ? `Has ${p.schemaTypes.slice(0, 4).join(", ")}` : "No structured data." })),
  );
  const ratings = content.filter((p) => p.schemaTypes.includes("AggregateRating"));
  add(
    { key: "schema-rating", title: "Star ratings in the page's structured data", why: "Ratings a business marks up about itself are against Google's rules for local businesses and can earn a manual penalty; TAWD's no-fake-reviews rule needs reviews that can be checked.", would: "Leave them out of the new site; show real reviews from the client's Google profile instead (the team links them).", importance: "medium" },
    ratings.length ? [{ page: ratings.length === content.length ? "(every page)" : ratings.map((p) => p.path).slice(0, 6).join(", "), found: `AggregateRating on ${ratings.length} of ${content.length} pages` }] : [],
  );

  // Name, address, phone.
  const phone = digits(facts.phone);
  if (phone.length >= 10) {
    add(
      { key: "nap-phone", title: "Phone numbers that differ from the intake", why: "The same name, address and phone everywhere (NAP) helps local rankings; a different number confuses Google and customers.", would: "Use the intake's number everywhere: TAWD's header, footer and schema already do. The kept words are flagged on the page review.", importance: "high" },
      content
        .map((p) => ({ page: p.path, other: p.phones.filter((n) => digits(n).length >= 10 && digits(n) !== phone) }))
        .filter((x) => x.other.length)
        .map((x) => ({ page: x.page, found: `${x.other.join(", ")} (the intake has ${facts.phone})` })),
    );
  }
  if (facts.name.trim()) {
    const short = facts.name.toLowerCase().replace(/\b(llc|inc|co|corp|ltd)\b\.?/g, "").trim();
    add(
      { key: "nap-name", title: "The business name isn't on the page", why: "Pages that never name the business are weaker for local searches.", would: "TAWD's header, footer and schema carry the name on every page.", importance: "low" },
      content.filter((p) => ["home", "about", "contact"].includes(p.kind) && !`${p.title} ${p.h1s.join(" ")} ${p.name}`.toLowerCase().includes(short.split(" ")[0]!)).map((p) => ({ page: p.path, found: `"${facts.name}" isn't in the title or H1` })),
    );
  }

  // Reviews widgets.
  add(
    { key: "reviews", title: "Review widgets (not copied)", why: "Reviews shown by a widget belong to Google or Yelp; copying their words onto the site would be unverifiable (TAWD's no-fake-reviews rule).", would: "Leave them out; the team can add the client's real Google reviews link or widget on the new site.", importance: "low" },
    content.filter((p) => p.reviewWidgets > 0).length ? [{ page: content.filter((p) => p.reviewWidgets > 0).length === content.length ? "(every page)" : content.filter((p) => p.reviewWidgets > 0).map((p) => p.path).slice(0, 6).join(", "), found: `${content.filter((p) => p.reviewWidgets > 0).length} page(s) had a review widget` }] : [],
  );

  const rank = { high: 0, medium: 1, low: 2 } as const;
  return groups.sort((a, b) => rank[a.importance] - rank[b.importance]);
}

/* What the new site does on its own, whatever the SEO team decides: the short list under the suggestions. */
export function tawdDoesBetter(pages: ImportedPageSummary[], options: { hasHours?: boolean } = {}): string[] {
  const out = [
    // Hours are listed only when the intake has hours the schema can write (F-044).
    `LocalBusiness structured data from the intake (name, phone, address, ${options.hasHours ? "hours, " : ""}areas) on the home and contact pages.`,
    "One H1 and Open Graph tags on every page, and a canonical tag once the domain is in the intake.",
    "The speed pass: smaller pictures (WebP), the fonts on the site, lazy loading, a year's caching.",
    "A sitemap.xml and robots.txt written for the new site; the old addresses that change are redirected (301).",
    "A phone-first layout with tap-to-call, checked at phone width.",
    "Alt text on every picture, and visible focus and contrast for accessibility.",
  ];
  if (pages.some((p) => p.mixedContent > 0 || p.httpLinks > 0)) out.push("https:// everywhere.");
  return out;
}
