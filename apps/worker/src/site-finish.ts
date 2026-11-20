import { promises as fs } from "node:fs";
import path from "node:path";
import type { Browser, Page } from "playwright-core";

import { KIT_ICONS } from "@tawd/core/style-kit/icon-set";

import { serve } from "./site-build";
import { ownPageContext } from "./locked-context";
import { fontsReady, loadHtml, openPage } from "./page-load";

/* The icon set's brand logos, by the start of their drawing: a brand logo belongs only in a link (29 September 2026: a signpost's pin became Thumbtack's logo). */
const BRAND_MARKS = KIT_ICONS.filter((i) => i.style === "brand")
  .map((i) => /d="([^"]{12,40})/.exec(i.body)?.[1])
  .filter((d): d is string => Boolean(d));

/*
  The finishing pass (Jason, 29 September 2026: "fix TAWD, not just this
  site"). After a design build, each page is opened in Chrome as it will be
  served and fixed by code, from what is really on the page:

  - links with no real destination are removed (a card that only led
    nowhere goes with its link; empty sections close up); social icons
    only where the project has the address;
  - breadcrumbs come from the site map; "→ →" becomes one arrow; a "meet
    the others" card that points at the page itself goes;
  - an icon holder the kit couldn't fill is dropped; play marks over a
    picture become a dark disc with a white triangle;
  - text and icons under 3:1 against their background take the button's or
    the section's readable colour;
  - the menu lists every page (children under their dropdown, which also
    links its own page and shows an arrow); the phone menu opens below the
    bar; the tablet header keeps the logo off the words;
  - grids that overflow wrap; on a phone, section padding stops at 48px,
    fixed hero heights go, lone last cards centre, card titles that wrap
    to 4+ lines drop the grid to one column; text is at least 14px and
    footer links 16px with a 44px tap height;
  - pictures get their size, lazy loading below the fold, and are made
    WebP at twice their largest displayed size.

  Then the Site check rules (section E of Jason's list) run on the result
  and every page gets its notes. No AI, $0.
*/

export interface SiteMapPage {
  name: string;
  path: string;
}

export interface FinishInput {
  pages: SiteMapPage[];
  /** Profile addresses the project has, by platform ("tiktok", "instagram", "youtube", "facebook"). */
  socials: Record<string, string>;
}

export interface FinishResult {
  /** Notes by page path: what the Site check rules found after the pass. */
  notes: Map<string, string[]>;
  /** Picture files rewritten (old path to new path). */
  pictures: Map<string, string>;
}

const WIDTHS = [1440, 820, 390] as const;

/* Every page of the built site, fixed in place; then the pictures. */
export async function finishSite(browser: Browser, dist: string, input: FinishInput): Promise<FinishResult> {
  const { server, origin } = await serve(dist);
  const notes = new Map<string, string[]>();
  const displayed = new Map<string, number>();
  try {
    const parents = await readParents(browser, origin, input.pages);
    const ogImage = await largestPicture(browser, `${origin}/`);
    const files = (await htmlFiles(dist)).filter((f) => !/^(404|_)/.test(f));
    const { anchors, photos: namePhotos } = await nameCards(browser, origin, files, input.pages, parents);
    for (const file of files) {
      const pagePath = `/${file.replace(/index\.html$/, "")}`;
      const html = await finishPage(browser, origin, pagePath, input, parents, displayed, ogImage, anchors, namePhotos);
      if (html) await fs.writeFile(path.join(dist, file), html, "utf8");
    }
    const pictures = await optimisePictures(browser, dist, displayed);
    if (pictures.size) {
      for (const file of files) {
        const full = path.join(dist, file);
        let text = await fs.readFile(full, "utf8");
        for (const [from, to] of pictures) text = text.split(from).join(to);
        await fs.writeFile(full, text, "utf8");
      }
    }
    for (const file of files) {
      const pagePath = `/${file.replace(/index\.html$/, "")}`;
      notes.set(pagePath, await auditPage(browser, `${origin}${pagePath}`, pagePath, input.pages, parents));
    }
    return { notes, pictures };
  } finally {
    server.close();
  }
}

async function htmlFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".html"))
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
    .sort();
}

/* The site map's shape from the home page's menu: a page listed inside a dropdown belongs under that dropdown's page. */
async function readParents(browser: Browser, origin: string, pages: SiteMapPage[]): Promise<Record<string, string>> {
  const context = await ownPageContext(browser, { viewport: { width: 1440, height: 900 }, javaScriptEnabled: false }, [origin]);
  try {
    const page = await context.newPage();
    await openPage(page, `${origin}/`);
    return await page.evaluate((all: SiteMapPage[]) => {
      const byWords = (text: string) => {
        const t = text.replace(/\s+/g, " ").trim().toLowerCase();
        return all.find((p) => p.name.toLowerCase() === t) ?? all.find((p) => p.path !== "/" && t.split(/[^a-z0-9]+/).includes(p.path.replace(/\//g, "")));
      };
      const out: Record<string, string> = {};
      for (const details of Array.from(document.querySelectorAll("header details"))) {
        const summary = details.querySelector(":scope > summary");
        const owner = summary ? byWords(summary.textContent ?? "") : undefined;
        if (!owner) continue;
        for (const a of Array.from(details.querySelectorAll("a[href]"))) {
          const href = a.getAttribute("href")!;
          if (href !== owner.path && all.some((p) => p.path === href)) out[href] = owner.path;
        }
      }
      return out;
    }, pages);
  } finally {
    await context.close();
  }
}

/*
  Names on cards across the site that have no page of their own (Ghost):
  where each is shown, preferring a page other pages sit under (Meet the
  Pack), so "Meet Ghost" can point at that card.
*/
async function nameCards(browser: Browser, origin: string, files: string[], pages: SiteMapPage[], parents: Record<string, string>): Promise<{ anchors: Record<string, string>; photos: Record<string, string> }> {
  const found = new Map<string, string[]>();
  const photos: Record<string, string> = {};
  const hubs = new Set(Object.values(parents));
  for (const file of files) {
    const at = `/${file.replace(/index\.html$/, "")}`;
    const { page, close } = await open(browser, `${origin}${at}`, 1440);
    try {
      const names: { name: string; photo: string | null }[] = await page.evaluate(() =>
        Array.from(document.querySelectorAll("main [class*='ribbon' i], main [class*='name' i], main [class*='badge' i]"))
          .filter((r) => r.children.length === 0 || !r.querySelector("a, p, h1, h2, h3"))
          .map((r) => {
            // The photo in the same small card (one picture only), for placeholders elsewhere that name this dog.
            let card: Element | null = r.parentElement;
            for (let i = 0; i < 3 && card && card.querySelectorAll("img").length === 0; i += 1) card = card.parentElement;
            const imgs = card ? card.querySelectorAll("img") : [];
            return { name: (r.textContent ?? "").replace(/\s+/g, " ").trim(), photo: imgs.length === 1 ? (imgs[0] as HTMLImageElement).getAttribute("src") : null };
          })
          .filter((t) => t.name && t.name.length < 30 && t.name.split(" ").length <= 2 && !/^meet\b/i.test(t.name)),
      );
      for (const n of names) {
        found.set(n.name.toLowerCase(), [...(found.get(n.name.toLowerCase()) ?? []), at]);
        if (n.photo && !photos[n.name.toLowerCase()]) photos[n.name.toLowerCase()] = n.photo;
      }
    } finally {
      await close();
    }
  }
  const out: Record<string, string> = {};
  for (const [name, where] of found) {
    if (pages.some((p) => p.name.toLowerCase() === name)) continue;
    out[name] = where.find((w) => hubs.has(w)) ?? where[0]!;
  }
  return { anchors: out, photos };
}

/* The home page's biggest picture: the site's share image. */
async function largestPicture(browser: Browser, url: string): Promise<string | null> {
  const { page, close } = await open(browser, url, 1440);
  try {
    return await page.evaluate(() => {
      const area = (i: Element) => i.getBoundingClientRect().width * i.getBoundingClientRect().height;
      const imgs = Array.from(document.querySelectorAll("main img")).filter((i) => (i.getAttribute("src") ?? "").startsWith("/"));
      return imgs.sort((a, b) => area(b) - area(a))[0]?.getAttribute("src") ?? null;
    });
  } finally {
    await close();
  }
}

async function open(browser: Browser, url: string, width: number): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await ownPageContext(browser, { viewport: { width, height: 900 }, javaScriptEnabled: false }, [url]);
  const page = await context.newPage();
  await openPage(page, url);
  await fontsReady(page);
  return { page, close: () => context.close() };
}

/* One page: the fixes that don't depend on the screen, then the ones measured at each width, written into the page. */
async function finishPage(browser: Browser, origin: string, pagePath: string, input: FinishInput, parents: Record<string, string>, displayed: Map<string, number>, ogImage: string | null, anchors: Record<string, string>, namePhotos: Record<string, string>): Promise<string | null> {
  const url = `${origin}${pagePath}`;
  // 1. Structure, at desktop width: links, cards, menu, breadcrumbs, icons.
  const first = await open(browser, url, 1440);
  let html: string;
  try {
    await first.page.evaluate(structuralFixes, { pages: input.pages, socials: input.socials, parents, current: pagePath, ogImage, anchors, namePhotos, brandMarks: BRAND_MARKS });
    html = await serialize(first.page);
  } finally {
    await first.close();
  }
  // 2. What each width needs, measured on the fixed page; one style block.
  const rules: string[] = [];
  for (const width of WIDTHS) {
    const { page, close } = await open(browser, url, width);
    try {
      // The fixed page, at the page's own address so its files still load.
      await loadHtml(page, html, { what: "A page of the built site" });
      await fontsReady(page);
      // Measured, the fixes put in, and measured again (a fix can show the next: an item that shrinks leaves its row too tall).
      for (let round = 0; round < 3; round += 1) {
        const measured = await page.evaluate(measureFixes, { width });
        const fresh = measured.rules.filter((r) => !rules.includes(r));
        rules.push(...fresh);
        for (const [src, w] of measured.pictures) displayed.set(src, Math.max(displayed.get(src) ?? 0, w));
        if (!fresh.length) break;
        await page.evaluate((css) => {
          let tag = document.querySelector("style[data-tawd-measuring]");
          if (!tag) {
            tag = document.createElement("style");
            tag.setAttribute("data-tawd-measuring", "");
            document.head.appendChild(tag);
          }
          tag.textContent = css;
        }, rules.join("\n"));
      }
      await page.evaluate(() => document.querySelector("style[data-tawd-measuring]")?.remove());
      // The markers the rules point at go on with the page.
      html = await serialize(page);
    } finally {
      await close();
    }
  }
  // 3. Contrast, on the page with its new styles.
  const withRules = html.replace(/<style data-tawd-finish>[\s\S]*?<\/style>/, "").replace(/<\/head>/i, `<style data-tawd-finish>${[...new Set(rules)].join("\n")}</style></head>`);
  const last = await open(browser, url, 1440);
  try {
    await loadHtml(last.page, withRules, { what: "A page of the built site" });
    await fontsReady(last.page);
    await last.page.evaluate(contrastFixes);
    return await serialize(last.page);
  } finally {
    await last.close();
  }
}

async function serialize(page: Page): Promise<string> {
  return page.evaluate(() => `<!DOCTYPE html>\n${document.documentElement.outerHTML}`);
}

/* ---------- in the page: structure ---------- */

function structuralFixes(input: { pages: SiteMapPage[]; socials: Record<string, string>; parents: Record<string, string>; current: string; ogImage: string | null; anchors: Record<string, string>; namePhotos: Record<string, string>; brandMarks: string[] }): void {
  const { pages, socials, parents, current, ogImage, anchors, namePhotos, brandMarks } = input;
  // A name set in capitals in the design ("MIA", "HUSKY TALK") reads as a name in menus and breadcrumbs ("Mia", "Husky Talk").
  const shown = (name: string) => (name.length >= 3 && name === name.toUpperCase() && !/^(FAQS?|SEO|USA|HVAC|DIY|FAQ)$/.test(name) ? name.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase()) : name);
  const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const PLATFORMS: [string, RegExp][] = [
    ["tiktok", /tiktok/i],
    ["instagram", /instagram/i],
    ["youtube", /youtube/i],
    ["facebook", /facebook/i],
    ["x", /twitter|\bx\b/i],
    ["pinterest", /pinterest/i],
  ];
  const platformOf = (a: Element) => {
    const said = `${a.getAttribute("aria-label") ?? ""} ${a.getAttribute("title") ?? ""} ${text(a)}`;
    return PLATFORMS.find(([, re]) => re.test(said))?.[0] ?? null;
  };
  const dead = (href: string | null) => {
    if (href === null) return true;
    const h = href.trim();
    return h === "" || h === "#" || h.startsWith("#!") || /^javascript:/i.test(h);
  };
  const removeClosingUp = (el: Element) => {
    let parent = el.parentElement;
    el.remove();
    // Containers left with nothing to show go too (up to the section).
    while (parent && parent !== document.body && parent.tagName !== "MAIN" && parent.tagName !== "HEADER" && parent.tagName !== "FOOTER") {
      const hasContent = text(parent) !== "" || parent.querySelector("img, svg, video, iframe, picture");
      if (hasContent) break;
      const up: HTMLElement | null = parent.parentElement;
      parent.remove();
      parent = up;
    }
  };

  // The design's stand-in words and blank photos: TAWD's visible placeholder, for the team to fill (they stop go-live until then).
  const PLACEHOLDER_WORDS: [RegExp, (t: string) => string][] = [
    [/^(.{2,40}?)\s+goes here\.?$/i, (t) => t.replace(/\s+goes here\.?$/i, "").toLowerCase()],
    [/^short description of\b/i, () => "short description"],
    [/lorem ipsum/i, () => "text"],
    [/^(photo|image)?\s*placeholder\b/i, () => "photo"],
    [/^your (text|title|heading) here\b/i, (t) => t.replace(/^your\s+/i, "").replace(/\s+here.*$/i, "").toLowerCase()],
  ];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("main *"))) {
    if (!Array.from(el.childNodes).some((c) => c.nodeType === 3 && (c.textContent ?? "").trim()) || el.closest(".tawd-placeholder")) continue;
    const t = text(el);
    const hit = PLACEHOLDER_WORDS.find(([re]) => re.test(t));
    if (hit) el.innerHTML = `<mark class="tawd-placeholder">[PLACEHOLDER: ${hit[1](t)}]</mark>`;
  }
  // Social links: the real address, or gone.
  for (const a of Array.from(document.querySelectorAll("a"))) {
    const platform = platformOf(a);
    if (!platform || !a.querySelector("[data-kit-icon], svg, img")) continue;
    const href = a.getAttribute("href");
    if (!dead(href) && !/^#/.test(href ?? "")) continue;
    if (socials[platform]) {
      a.setAttribute("href", socials[platform]!);
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener");
    } else removeClosingUp(a);
  }

  // "Meet Ghost" with no page of Ghost's own: to Ghost's card on the page that has it (/meet/#ghost); the card gets its id there.
  const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  for (const [name, at] of Object.entries(anchors)) {
    if (at !== current) continue;
    const label = Array.from(document.querySelectorAll("main *")).find((el) => el.children.length === 0 && text(el).toLowerCase() === name);
    const card = label?.closest("li, article, [class*='card' i], [class*='item' i]") ?? label?.parentElement;
    if (card && !card.id) card.id = slugOf(name);
  }
  for (const a of Array.from(document.querySelectorAll("a"))) {
    const said = /^meet\s+(.+?)\s*[→›»]?$/i.exec(text(a))?.[1]?.toLowerCase();
    if (!said || !anchors[said]) continue;
    const href = a.getAttribute("href");
    const ownPage = pages.find((p) => shown(p.name).toLowerCase() === said || p.path === `/${slugOf(said)}/`);
    if (ownPage) continue;
    if (dead(href) || !href || !pages.some((p) => p.path === href.split("#")[0])) a.setAttribute("href", anchors[said] === current ? `#${slugOf(said)}` : `${anchors[said]}#${slugOf(said)}`);
  }

  const DATE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i;
  // Post teasers that all lead to the same list page: the posts themselves don't exist, so the cards go.
  const READ = /read more|continue reading|keep reading|read the (post|story|article)/i;
  // (A teaser: a card with a title, or a date, and a "read more"; dated or not.)
  // The card's post link: its "read more", or (a dated card) any link it has.
  const postLink = (c: Element) => Array.from(c.querySelectorAll("a[href]")).find((a) => READ.test(text(a))) ?? (DATE.test(text(c)) ? c.querySelector("a[href]") : null);
  const teasers = Array.from(document.querySelectorAll("main article, main li, main [class*='card']")).filter((c) => (DATE.test(text(c)) || c.querySelector("h2, h3, h4")) && postLink(c));
  const byParent = new Map<Element, Element[]>();
  for (const c of teasers) if (c.parentElement && !teasers.some((o) => o !== c && o.contains(c))) byParent.set(c.parentElement, [...(byParent.get(c.parentElement) ?? []), c]);
  for (const [, cards] of byParent) {
    const targets = cards.map((c) => postLink(c)?.getAttribute("href"));
    if (cards.length >= 2 && new Set(targets).size === 1) for (const c of cards) removeClosingUp(c);
    else for (const [i, c] of cards.entries()) if (dead(targets[i] ?? null) || targets[i] === current) removeClosingUp(c);
  }

  // Buttons and calls to action, never kept as labels.
  const READ_WORDS = /read more|view|explore|shop|buy|follow|watch|learn|see |our story|our promise|suggest|browse|get |join|send|subscribe|download|→/i;
  // Links with no destination: a card that only led there goes; a button or chip goes; words stay as words.
  for (const a of Array.from(document.querySelectorAll("a"))) {
    if (!a.isConnected) continue;
    const href = a.getAttribute("href");
    const inPage = href?.startsWith("#") && href.length > 1 && document.getElementById(decodeURIComponent(href.slice(1)));
    // A button on a page that leads to that same page ("Follow Mia" on Mia's page) goes nowhere either.
    const toItself = href === current && Boolean(a.closest("main")) && !a.closest("nav, [class*='breadcrumb' i]");
    if (!dead(href) && !(href?.startsWith("#") && !inPage) && !toItself) continue;
    const card = a.closest("article, li, [class*='card']");
    if (card && card !== a && DATE.test(text(card))) {
      // A post teaser whose "read more" led nowhere: the post doesn't exist, so the card goes.
      const others = Array.from(card.querySelectorAll("a[href]")).filter((x) => x !== a && !dead(x.getAttribute("href")));
      if (others.length === 0) {
        removeClosingUp(card);
        continue;
      }
    }
    // A chip in a row of short links (topics): stays as a plain label.
    const row = a.parentElement?.closest("ul, ol, div, nav, p");
    const chips = row ? Array.from(row.querySelectorAll("a")).filter((x) => text(x).split(" ").length <= 4 && text(x).length <= 30) : [];
    if (chips.length >= 3 && text(a).split(" ").length <= 4 && !READ_WORDS.test(text(a)) && !a.querySelector("img")) {
      const label = document.createElement("span");
      label.className = `${a.className} tawd-label`.trim();
      label.innerHTML = a.innerHTML;
      a.replaceWith(label);
      continue;
    }
    const inSentence = a.parentElement && ["P", "LI", "SPAN", "TD"].includes(a.parentElement.tagName) && text(a.parentElement).length > text(a).length + 12;
    if (inSentence) a.replaceWith(...Array.from(a.childNodes));
    else removeClosingUp(a);
  }
  // Buttons that do nothing.
  for (const b of Array.from(document.querySelectorAll("button:not([type=submit]):not([aria-controls]):not([data-video]):not([data-src]):not([aria-expanded]):not(.tawd-video):not([data-tawd-close])"))) {
    if (!b.closest("form") && !b.getAttribute("onclick")) removeClosingUp(b);
  }

  // Lists of dated posts under a posts heading ("Popular posts", "Latest from Husky Talk"): the posts don't exist.
  const POSTS = /post|article|blog|stor(y|ies)|talk|latest|popular|recent/i;
  for (const list of Array.from(document.querySelectorAll("main ul, main ol, main div"))) {
    if (!list.isConnected) continue;
    const items = Array.from(list.children).filter((c) => DATE.test(text(c)));
    if (items.length < 2 || items.length < list.children.length * 0.6) continue;
    let heading: Element | null = null;
    for (let at: Element | null = list; at && !heading && at.tagName !== "MAIN"; at = at.parentElement) {
      for (let sib = at.previousElementSibling; sib && !heading; sib = sib.previousElementSibling) if (/^H[2-4]$/.test(sib.tagName) || sib.querySelector("h2, h3, h4")) heading = /^H[2-4]$/.test(sib.tagName) ? sib : sib.querySelector("h2, h3, h4");
    }
    if (heading && POSTS.test(text(heading))) {
      removeClosingUp(list);
      if (heading.isConnected && !heading.nextElementSibling) removeClosingUp(heading);
    }
  }
  // A "follow us on Instagram" strip for a platform the project has no address for.
  for (const section of Array.from(document.querySelectorAll("main section, main aside"))) {
    const heading = text(section.querySelector("h2, h3, h4"));
    const platform = PLATFORMS.find(([, re]) => re.test(heading))?.[0];
    if (platform && /follow|join|see us|find us/i.test(heading) && !socials[platform]) section.remove();
  }
  // A container left with only headings and buttons (its cards removed) closes up; a heading left with nothing after it goes.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const box of Array.from(document.querySelectorAll("main section, main div, main aside"))) {
      if (!box.isConnected || box.querySelector("h1")) continue;
      const kids = Array.from(box.children).filter((c) => c.tagName !== "STYLE" && c.tagName !== "SCRIPT");
      if (!kids.length) continue;
      const bare = kids.every((c) => /^H[2-6]$/.test(c.tagName) || c.hasAttribute("data-kit-icon") || (c.tagName === "A" && READ_WORDS.test(text(c))) || (c.tagName === "P" && c.children.length === 1 && c.firstElementChild?.tagName === "A" && READ_WORDS.test(text(c))));
      if (bare && kids.some((c) => /^H[2-6]$/.test(c.tagName))) removeClosingUp(box);
    }
    for (const h of Array.from(document.querySelectorAll("main h2, main h3"))) {
      if (!h.isConnected) continue;
      const next = h.nextElementSibling;
      if (h.querySelector(".tawd-placeholder")) continue;
      if ((!next && h.parentElement && h.parentElement.children.length > 1 && h === h.parentElement.lastElementChild) || (next && next.tagName === h.tagName)) removeClosingUp(h);
    }
  }

  // A post list left with only its heading closes up.
  for (const section of Array.from(document.querySelectorAll("main section"))) {
    const words = text(section);
    const headings = Array.from(section.querySelectorAll("h1,h2,h3,h4")).map(text).join(" ");
    if (!section.querySelector("img, p, li, a, form, iframe, video") && words.length <= headings.length + 2) section.remove();
  }

  // One arrow, not two.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue && /[→›»]\s*[→›»]/.test(node.nodeValue)) node.nodeValue = node.nodeValue.replace(/([→›»])(\s*[→›»])+/g, "$1");
  }
  for (const a of Array.from(document.querySelectorAll("a"))) {
    const icon = a.querySelector("[data-kit-icon]");
    const last = a.lastChild;
    // An arrow icon and an arrow character: the character goes.
    if (icon && last?.nodeType === 3 && /[→›»]\s*$/.test(last.nodeValue ?? "") && a.lastElementChild === icon) last.nodeValue = (last.nodeValue ?? "").replace(/\s*[→›»]\s*$/, " ");
  }

  // "Meet the others" cards that point at this very page.
  if (current !== "/") {
    for (const a of Array.from(document.querySelectorAll(`main a[href="${current}"]`))) {
      const card = a.closest("li, article, [class*='card'], [class*='item']");
      if (card && card.closest("main") && !card.matches("main, section")) {
        const siblings = card.parentElement ? Array.from(card.parentElement.children).filter((c) => c.querySelector("a[href]")) : [];
        if (siblings.length >= 3) card.remove();
      }
    }
  }

  // A sibling page's name in this page's headings or picture descriptions ("MIA" on Dakota's page, from the page it was filled from): this page's name. A card that links to that sibling keeps it.
  const here = pages.find((p) => p.path === current);
  const parentPath = parents[current];
  if (here && parentPath) {
    const siblings = pages.filter((p) => p.path !== current && parents[p.path] === parentPath);
    const own = shown(here.name);
    const linksTo = (el: Element, path: string) => {
      for (let at: Element | null = el, i = 0; at && i < 3 && !["MAIN", "SECTION"].includes(at.tagName); at = at.parentElement, i += 1) if (at.matches(`a[href="${path}"]`) || at.querySelector(`a[href="${path}"]`)) return true;
      return false;
    };
    const cased = (found: string) => (found === found.toUpperCase() ? own.toUpperCase() : own);
    for (const sib of siblings) {
      const re = new RegExp(`\\b${shown(sib.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
      for (const el of Array.from(document.querySelectorAll("main h1, main h2, main h3"))) {
        if (linksTo(el, sib.path) || !re.test(text(el))) continue;
        re.lastIndex = 0;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) n.nodeValue = (n.nodeValue ?? "").replace(re, cased);
      }
      for (const img of Array.from(document.querySelectorAll("main img[alt]"))) {
        re.lastIndex = 0;
        if (!linksTo(img, sib.path) && re.test(img.getAttribute("alt") ?? "")) img.setAttribute("alt", (img.getAttribute("alt") ?? "").replace(re, cased));
      }
    }
  }

  // An "at a glance" value that only repeats its label ("AGE" under "AGE"): the value is missing, shown as a placeholder to fill.
  for (const label of Array.from(document.querySelectorAll("main [class*='label' i]"))) {
    const value = label.nextElementSibling;
    if (value && /value/i.test(value.className) && text(value).toLowerCase() === text(label).toLowerCase() && text(label)) {
      value.innerHTML = `<mark class="tawd-placeholder">[PLACEHOLDER: ${text(label).toLowerCase()}]</mark>`;
    }
  }

  // Breadcrumbs from the site map.
  const crumbs = document.querySelectorAll("nav[aria-label*='readcrumb' i], [class*='breadcrumb' i]:not(:has([class*='breadcrumb' i]))");
  if (crumbs.length && current !== "/") {
    const chain: SiteMapPage[] = [];
    let at: string | undefined = current;
    while (at && at !== "/") {
      const p = pages.find((x) => x.path === at);
      if (!p) break;
      chain.unshift(p);
      at = parents[at];
    }
    const home = pages.find((p) => p.path === "/");
    const parts = [...(home ? [home] : []), ...chain];
    for (const crumb of Array.from(crumbs)) {
      if (crumb.querySelector("nav[aria-label*='readcrumb' i]")) continue;
      crumb.innerHTML = parts
        .map((p, i) => (i === parts.length - 1 ? `<span aria-current="page">${shown(p.name)}</span>` : `<a href="${p.path}">${shown(p.name)}</a>`))
        .join(" <span aria-hidden=\"true\">›</span> ");
    }
  }

  // Icon holders the kit couldn't fill: another copy of the same icon on the page, or the holder goes.
  const emptyKinds = new Set<string>();
  for (const holder of Array.from(document.querySelectorAll("[data-kit-icon]"))) {
    if (holder.querySelector("svg, img")) continue;
    const twin = document.querySelector(`[data-kit-icon="${holder.getAttribute("data-kit-icon")}"] svg`);
    if (twin) holder.appendChild(twin.cloneNode(true));
    else {
      if (holder.className) emptyKinds.add(holder.className);
      removeClosingUp(holder);
    }
  }
  // One of a row of icon circles can't be shown: the row goes without circles, so it stays even.
  for (const kind of emptyKinds) for (const holder of Array.from(document.getElementsByClassName(kind.split(" ")[0]!))) if (holder.hasAttribute("data-kit-icon")) removeClosingUp(holder);

  // A brand's logo outside a link (the kit matched a shape of the design to it): not the brand's, so it goes.
  for (const icon of Array.from(document.querySelectorAll("main [data-kit-icon]"))) {
    const d = icon.querySelector("path")?.getAttribute("d") ?? "";
    if (!icon.closest("a") && brandMarks.some((m) => d.startsWith(m))) removeClosingUp(icon);
  }
  // A piece of the design's illustration traced as an icon, standing alone (no words beside it, not in a button, link or heading): a leftover; it goes.
  for (const icon of Array.from(document.querySelectorAll<HTMLElement>("main [data-kit-traced]"))) {
    if (icon.closest("a, button, h1, h2, h3, h4, h5, h6, li, label, [class*='ribbon' i], [class*='badge' i]")) continue;
    const r = icon.getBoundingClientRect();
    if (r.width === 0) continue;
    const beside = Array.from((icon.parentElement ?? document.body).querySelectorAll("*")).some((el) => {
      if (el === icon || icon.contains(el) || el.contains(icon)) return false;
      if (!Array.from(el.childNodes).some((c) => c.nodeType === 3 && (c.textContent ?? "").trim())) return false;
      const b = el.getBoundingClientRect();
      return Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top) > r.height * 0.4;
    });
    const overPicture = Array.from(document.querySelectorAll("main img")).some((img) => {
      const p = img.getBoundingClientRect();
      return r.left >= p.left && r.right <= p.right && r.top >= p.top && r.bottom <= p.bottom;
    });
    if (!beside && !overPicture) removeClosingUp(icon);
  }

  // Play marks over a picture: a dark disc with a white triangle, centred.
  for (const icon of Array.from(document.querySelectorAll<HTMLElement>("[data-kit-icon]"))) {
    const holder = icon.parentElement;
    const picture = holder?.querySelector(":scope > img, :scope > picture");
    if (!holder || !picture) continue;
    const box = icon.getBoundingClientRect();
    const pic = picture.getBoundingClientRect();
    const over = box.left >= pic.left - 2 && box.right <= pic.right + 2 && box.top >= pic.top - 2 && box.bottom <= pic.bottom + 2;
    // A play mark sits at the picture's centre (a heart or a badge in a corner is not one).
    const centred = Math.abs(box.left + box.width / 2 - (pic.left + pic.width / 2)) <= pic.width * 0.2 && Math.abs(box.top + box.height / 2 - (pic.top + pic.height / 2)) <= pic.height * 0.2;
    if (!over || !centred) continue;
    icon.setAttribute("data-tawd-play", "");
    if (getComputedStyle(holder).position === "static") holder.style.position = "relative";
  }

  // The menu: every page listed; children under their dropdown, which links its own page first.
  const navs = Array.from(document.querySelectorAll("header nav"));
  for (const nav of navs) {
    const list = nav.querySelector(":scope > ul, ul");
    if (!list) continue;
    const listed = new Set(Array.from(nav.querySelectorAll("a[href]")).map((a) => a.getAttribute("href")));
    for (const details of Array.from(nav.querySelectorAll("details"))) {
      const summary = details.querySelector(":scope > summary");
      const words = text(summary).toLowerCase();
      const owner = pages.find((p) => p.name.toLowerCase() === words) ?? pages.find((p) => p.path !== "/" && words.split(/[^a-z0-9]+/).includes(p.path.replace(/\//g, "")));
      const sub = details.querySelector("ul");
      if (owner && sub && !listed.has(owner.path)) {
        const li = document.createElement("li");
        li.innerHTML = `<a href="${owner.path}">${summary ? text(summary) : shown(owner.name)}</a>`;
        sub.prepend(li);
        listed.add(owner.path);
      }
      summary?.setAttribute("data-tawd-dropdown", "");
      // Children listed under the dropdown but missing from it.
      if (owner && sub) {
        for (const [child, parent] of Object.entries(parents)) {
          if (parent !== owner.path || listed.has(child)) continue;
          const page = pages.find((p) => p.path === child);
          if (!page) continue;
          const li = document.createElement("li");
          li.innerHTML = `<a href="${page.path}">${shown(page.name)}</a>`;
          sub.append(li);
          listed.add(child);
        }
      }
    }
    // Top-level pages missing from the menu, in site order.
    for (const p of pages) {
      if (listed.has(p.path) || parents[p.path] || p.path === "/") continue;
      const sample = list.querySelector(":scope > li");
      const li = document.createElement("li");
      li.innerHTML = `<a href="${p.path}">${shown(p.name)}</a>`;
      if (sample?.className) li.className = sample.className;
      const sampleLink = sample?.querySelector(":scope > a");
      if (sampleLink?.className) li.querySelector("a")!.className = sampleLink.className;
      list.append(li);
      listed.add(p.path);
    }
    for (const a of Array.from(nav.querySelectorAll("a[href]"))) if (a.getAttribute("href") === current) a.setAttribute("aria-current", "page");
  }

  // The duplicate policy line under a footer that already links both policies.
  const footer = document.querySelector("footer");
  if (footer) {
    for (const p of Array.from(document.querySelectorAll(".tawd-privacy-links"))) {
      const has = (href: string) => Array.from(footer.querySelectorAll(`a[href="${href}"]`)).some((a) => !p.contains(a));
      if (has("/privacy/") && has("/cookies/") && !p.querySelector("[data-tawd-cookie-settings], [data-tawd-optout]")) p.remove();
    }
  }

  // (The design's stand-in words became placeholders first, above.) Its blank photos: TAWD's visible placeholder too.
  const flat = (img: HTMLImageElement) => {
    try {
      const c = document.createElement("canvas");
      c.width = 24;
      c.height = 24;
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0, 24, 24);
      const d = ctx.getImageData(0, 0, 24, 24).data;
      const lum: number[] = [];
      for (let i = 0; i < d.length; i += 4) lum.push(0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!);
      const sorted = [...lum].sort((x, y) => x - y);
      const median = sorted[Math.floor(sorted.length / 2)]!;
      return median > 170 && lum.filter((v) => Math.abs(v - median) <= 14).length / lum.length >= 0.8;
    } catch {
      return false;
    }
  };
  for (const img of Array.from(document.querySelectorAll<HTMLImageElement>("main img"))) {
    if (!img.complete || !img.naturalWidth || !flat(img) && !/placeholder/i.test(img.getAttribute("alt") ?? "")) continue;
    // A dog's circle in "Became a family": that dog's own photo from elsewhere on the site.
    let card: Element | null = img.parentElement;
    for (let i = 0; i < 3 && card && !text(card); i += 1) card = card.parentElement;
    const named = card ? Object.keys(namePhotos).find((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text(card))) : undefined;
    if (named && card && text(card).length < 80) {
      img.setAttribute("src", namePhotos[named]!);
      img.setAttribute("alt", named.replace(/(^|\s)([a-z])/g, (_m, a2: string, b: string) => a2 + b.toUpperCase()));
      img.removeAttribute("width");
      img.removeAttribute("height");
      continue;
    }
    const r = img.getBoundingClientRect();
    const box = document.createElement("div");
    box.className = `${img.className} tawd-placeholder-photo`.trim();
    box.setAttribute("style", `aspect-ratio:${Math.max(1, Math.round(r.width))}/${Math.max(1, Math.round(r.height))};width:100%;max-width:${Math.round(r.width)}px`);
    box.innerHTML = `<mark class="tawd-placeholder">[PLACEHOLDER: photo]</mark>`;
    img.replaceWith(box);
  }

  // A photo gallery opens its pictures large on a click (a small lightbox, no outside code).
  const galleries = Array.from(document.querySelectorAll("main [class*='gallery' i]")).filter((g) => g.querySelectorAll("img").length >= 3 && !g.querySelector("[class*='gallery' i]"));
  if (galleries.length && !document.querySelector("#tawd-lightbox")) {
    for (const g of galleries) for (const img of Array.from(g.querySelectorAll("img"))) img.setAttribute("data-tawd-lightbox", "");
    const dialog = document.createElement("dialog");
    dialog.id = "tawd-lightbox";
    dialog.setAttribute("aria-label", "Photo");
    dialog.innerHTML = `<button type="button" aria-label="Close" data-tawd-close>×</button><img alt="">`;
    document.body.appendChild(dialog);
    const script = document.createElement("script");
    script.textContent = `document.addEventListener("click",function(e){var t=e.target;var d=document.getElementById("tawd-lightbox");if(!d)return;if(t&&t.hasAttribute&&t.hasAttribute("data-tawd-lightbox")){var i=d.querySelector("img");i.src=t.currentSrc||t.src;i.alt=t.alt||"";d.showModal();}else if(t===d||(t&&t.hasAttribute&&t.hasAttribute("data-tawd-close"))){d.close();}});`;
    document.body.appendChild(script);
  }

  // The head: a description from the page's own words when it has none, a share picture, names in the title as names.
  const meta = document.querySelector('meta[name="description"]');
  if (meta && !(meta.getAttribute("content") ?? "").trim()) {
    // The first paragraph of 70+ characters; else the first paragraphs together, if they say at least 40.
    const paras = Array.from(document.querySelectorAll("main p")).map(text).filter((t) => t.length >= 20 && !/^\[PLACEHOLDER/i.test(t));
    const joined = paras.slice(0, 3).join(" ");
    const lead = paras.find((t) => t.length >= 70) ?? (joined.length >= 40 ? joined : undefined);
    if (lead) {
      const cut = lead.length <= 155 ? lead : `${lead.slice(0, 154).replace(/\s+\S*$/, "")}…`;
      meta.setAttribute("content", cut);
      document.querySelector('meta[property="og:description"]')?.setAttribute("content", cut);
    }
  }
  if (ogImage && !document.querySelector('meta[property="og:image"]')) {
    const base = document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? location.href;
    const tag = document.createElement("meta");
    tag.setAttribute("property", "og:image");
    tag.setAttribute("content", new URL(ogImage, base).toString());
    document.head.appendChild(tag);
  }
  const [titleName, ...titleRest] = document.title.split(" | ");
  if (titleName) {
    document.title = [shown(titleName), ...titleRest].join(" | ");
    document.querySelector('meta[property="og:title"]')?.setAttribute("content", document.title);
  }

  // kit-box-title is for a title set into a kit box's top border (position:absolute). Off any element that isn't inside a
  // kit box (gap 9: footer column headings took it and jumped out of their grid, stacking on top of each other).
  for (const title of Array.from(document.querySelectorAll(".kit-box-title"))) {
    let inBox = false;
    for (let n: Element | null = title.parentElement; n && n !== document.body; n = n.parentElement) {
      if (typeof n.className === "string" && /\bkit-box-\d+\b/.test(n.className)) { inBox = true; break; }
    }
    if (!inBox) title.classList.remove("kit-box-title");
  }

  // Pictures: their real size, never shown larger than they are, and lazy below the first screen.
  for (const img of Array.from(document.querySelectorAll("img"))) {
    if (img.naturalWidth && !img.getAttribute("width")) {
      img.setAttribute("width", String(img.naturalWidth));
      img.setAttribute("height", String(img.naturalHeight));
    }
    // A raster photo is capped at its own width by code (gap 9: "never larger than natural" was only an instruction to the
    // AI; a 290px photo was shown at 381px, blurry). min(100%, …) keeps it inside its container on a narrow phone too, so
    // the cap never overrides the site's own responsive max-width:100%. Vector pictures (SVG) scale cleanly and are left alone.
    const src = img.getAttribute("src") ?? "";
    if (img.naturalWidth && !/\.svg(\?|#|$)/i.test(src) && !/^data:image\/svg/i.test(src)) {
      const style = (img.getAttribute("style") ?? "").replace(/;?\s*$/, "");
      img.setAttribute("style", `${style ? `${style};` : ""}max-width:min(100%, ${img.naturalWidth}px)`);
    }
    img.setAttribute("decoding", "async");
    if (img.getBoundingClientRect().top > window.innerHeight && !img.closest("header")) img.setAttribute("loading", "lazy");
  }
}

/* ---------- in the page: what each width needs ---------- */

function measureFixes(input: { width: number }): { rules: string[]; pictures: [string, number][] } {
  const { width } = input;
  const rules: string[] = [];
  const phone = width < 768;
  const tablet = width >= 768 && width < 1100;
  const media = (css: string) => (phone ? `@media (max-width:767px){${css}}` : tablet ? `@media (min-width:768px) and (max-width:1099px){${css}}` : `@media (min-width:1100px){${css}}`);
  let n = Number(document.body.getAttribute("data-tawd-n") ?? "0");
  const id = (el: Element) => {
    let v = el.getAttribute("data-tf");
    if (!v) {
      n += 1;
      v = String(n);
      el.setAttribute("data-tf", v);
    }
    return `[data-tf="${v}"]`;
  };
  const px = (v: string) => Number.parseFloat(v) || 0;

  // Grids that overflow wrap instead.
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("main *"))) {
    const s = getComputedStyle(el);
    if (s.display !== "grid" && s.display !== "inline-grid") continue;
    const cols = s.gridTemplateColumns.split(" ").filter(Boolean);
    if (cols.length < 2) continue;
    const r = el.getBoundingClientRect();
    const overflow = el.scrollWidth > el.clientWidth + 2 || r.right > window.innerWidth + 1;
    if (overflow) {
      const min = phone ? 140 : 200;
      rules.push(media(`${id(el)}{grid-template-columns:repeat(auto-fill,minmax(min(100%,${min}px),1fr))!important;}`));
    }
  }
  // Wide fixed-width things squeezed in.
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("main *"))) {
    const r = el.getBoundingClientRect();
    if (r.width > window.innerWidth + 1 && !el.closest("[data-tf]")) rules.push(media(`${id(el)}{max-width:100%!important;min-width:0!important;}`));
  }

  if (phone) {
    // Room at the end of the page for a bar pinned to the bottom of the screen (gap 9: a sticky "Call (number)" bar sat on
    // top of the last section, with nothing reserving space for it). The dismissible cookie bar is left out.
    let barRoom = 0;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      if (el.closest("#tawd-consent, .tawd-consent, [data-tawd-skip]") || /#main$/.test(el.getAttribute("href") ?? "")) continue;
      const s = getComputedStyle(el);
      if (s.position !== "fixed" && s.position !== "sticky") continue;
      const r = el.getBoundingClientRect();
      if (r.height < 8 || r.width < window.innerWidth * 0.6) continue;
      const atBottom = (s.bottom !== "auto" && px(s.bottom) <= 8) || (s.position === "fixed" && Math.abs(r.bottom - window.innerHeight) <= 4);
      if (atBottom && r.top > window.innerHeight * 0.5) barRoom = Math.max(barRoom, Math.ceil(r.height) + 8);
    }
    if (barRoom) rules.push(media(`body{padding-bottom:${barRoom}px!important}`));
    // Section padding at most 48px; no fixed hero heights; side padding where content touches the edge.
    for (const section of Array.from(document.querySelectorAll<HTMLElement>("main section, main > div"))) {
      const s = getComputedStyle(section);
      const top = px(s.paddingTop), bottom = px(s.paddingBottom);
      const fix: string[] = [];
      if (top > 48) fix.push("padding-top:48px!important");
      if (bottom > 48) fix.push("padding-bottom:48px!important");
      if (px(s.height) > 0 && /px/.test(section.style.height)) fix.push("height:auto!important");
      if (px(s.minHeight) > 400) fix.push("min-height:0!important");
      if (px(s.marginTop) > 48) fix.push("margin-top:32px!important");
      if (px(s.marginBottom) > 48) fix.push("margin-bottom:32px!important");
      const r = section.getBoundingClientRect();
      const content = Array.from(section.querySelectorAll<HTMLElement>("p, h1, h2, h3, li, a, img, [class*='card']")).filter((c) => c.getBoundingClientRect().width > 0);
      if (r.width >= window.innerWidth - 1 && content.some((c) => c.getBoundingClientRect().left < 8 && c.tagName !== "IMG") && px(s.paddingLeft) < 16) fix.push("padding-left:16px!important", "padding-right:16px!important");
      if (fix.length) rules.push(media(`${id(section)}{${fix.join(";")}}`));
    }
    // Blocks with a set height taller than their content (a hero that leaves blank space).
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("main *"))) {
      const s = getComputedStyle(el);
      const h = el.getBoundingClientRect().height;
      if (h < 300 || s.position === "absolute") continue;
      const inner = Array.from(el.children).reduce((m, c) => Math.max(m, (c as HTMLElement).getBoundingClientRect().bottom), el.getBoundingClientRect().top) - el.getBoundingClientRect().top;
      if (el.children.length && h - inner > 200 && (px(s.minHeight) > 0 || s.height.endsWith("px") && el.style.height === "" && /vh|px/.test(s.minHeight + s.height))) rules.push(media(`${id(el)}{min-height:0!important;height:auto!important;}`));
    }
    // A flex item sized for a row (flex-basis 260px) that, stacked on a phone, becomes 260px of height with nothing in it.
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const parent = el.parentElement;
      if (!parent) continue;
      const ps = getComputedStyle(parent);
      if (ps.display !== "flex" || !ps.flexDirection.startsWith("column")) continue;
      const basis = px(getComputedStyle(el).flexBasis);
      if (basis < 60) continue;
      const r = el.getBoundingClientRect();
      const inner = Array.from(el.children).reduce((m, c) => Math.max(m, (c as HTMLElement).getBoundingClientRect().bottom), r.top) - r.top;
      if (r.height - inner > 40) rules.push(media(`${id(el)}{flex-basis:auto!important;}`));
    }
    // Footers and headers keep phone spacing too.
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("footer, footer > *, header > *"))) {
      const s = getComputedStyle(el);
      const fix: string[] = [];
      if (px(s.paddingTop) > 48) fix.push("padding-top:40px!important");
      if (px(s.paddingBottom) > 48) fix.push("padding-bottom:40px!important");
      if (px(s.rowGap) > 40) fix.push("row-gap:32px!important");
      if (fix.length) rules.push(media(`${id(el)}{${fix.join(";")}}`));
    }
    // Something wider than the box it sits in (a 186px circle in a 175px grid cell): it fits, and keeps its shape.
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("main *"))) {
      const parent = el.parentElement;
      if (!parent) continue;
      const pr = parent.getBoundingClientRect();
      const ps = getComputedStyle(parent);
      const inner = pr.width - px(ps.paddingLeft) - px(ps.paddingRight) - px(ps.borderLeftWidth) - px(ps.borderRightWidth);
      const r = el.getBoundingClientRect();
      if (inner <= 0 || r.width <= inner + 1 || getComputedStyle(el).position === "absolute") continue;
      rules.push(media(`${id(el)}{max-width:100%!important;height:auto!important;aspect-ratio:${Math.round(r.width)}/${Math.max(1, Math.round(r.height))}!important;}`));
    }
    // A row or grid of several items touching a screen edge (the pack's circles): side padding, so nothing touches or pokes out.
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("main *"))) {
      const s = getComputedStyle(el);
      if (!["grid", "flex"].includes(s.display)) continue;
      const kids = (Array.from(el.children) as HTMLElement[]).filter((k) => k.getBoundingClientRect().width > 0);
      if (kids.length < 2) continue;
      const left = Math.min(...kids.map((k) => k.getBoundingClientRect().left));
      const right = Math.max(...kids.map((k) => k.getBoundingClientRect().right));
      if ((left < 8 || right > window.innerWidth - 8) && px(s.paddingLeft) < 12) rules.push(media(`${id(el)}{padding-left:16px!important;padding-right:16px!important;box-sizing:border-box!important;max-width:100%!important;}`));
    }
    // A grid or flex item much taller than what's in it (rows stretched for a wide screen): it fits its content, and the grid stops stretching.
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("main *"))) {
      const parent = el.parentElement;
      if (!parent) continue;
      const ps = getComputedStyle(parent);
      if (!["grid", "flex", "inline-grid", "inline-flex"].includes(ps.display)) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 120 || !el.children.length) continue;
      let top = Infinity, bottom = -Infinity;
      for (const c of Array.from(el.children) as HTMLElement[]) {
        const b = c.getBoundingClientRect();
        if (b.height === 0) continue;
        top = Math.min(top, b.top);
        bottom = Math.max(bottom, b.bottom);
      }
      if (!Number.isFinite(top)) continue;
      const empty = r.height - (bottom - top) - px(getComputedStyle(el).paddingTop) - px(getComputedStyle(el).paddingBottom);
      if (empty > 60) {
        rules.push(media(`${id(el)}{height:auto!important;min-height:0!important;}`));
        rules.push(media(`${id(parent)}{align-items:start!important;align-content:start!important;grid-auto-rows:auto!important;grid-template-rows:none!important;height:auto!important;min-height:0!important;}`));
      }
    }
    // Card grids whose titles wrap to four lines or more: one column.
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("main *"))) {
      const s = getComputedStyle(el);
      if (s.display !== "grid" || s.gridTemplateColumns.split(" ").length < 2) continue;
      const titles = Array.from(el.querySelectorAll<HTMLElement>("h3, h4, [class*='title']"));
      const wraps = titles.some((t) => t.getBoundingClientRect().height / (px(getComputedStyle(t).lineHeight) || px(getComputedStyle(t).fontSize) * 1.3) >= 3.6);
      if (wraps) rules.push(media(`${id(el)}{grid-template-columns:1fr!important;}`));
    }
  }

  // A lone last card centres.
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("main *"))) {
    const s = getComputedStyle(el);
    const kids = Array.from(el.children) as HTMLElement[];
    if (kids.length < 3) continue;
    if (s.display === "grid") {
      const cols = s.gridTemplateColumns.split(" ").filter(Boolean).length;
      if (cols >= 2 && kids.length % cols === 1) rules.push(media(`${id(kids[kids.length - 1]!)}{grid-column:1/-1;justify-self:center;width:calc((100% - ${(cols - 1)} * ${s.columnGap === "normal" ? "0px" : s.columnGap}) / ${cols});}`));
    } else if (s.display === "flex" && s.flexWrap === "wrap") {
      const lastTop = kids[kids.length - 1]!.getBoundingClientRect().top;
      const alone = kids.filter((k) => Math.abs(k.getBoundingClientRect().top - lastTop) < 2).length === 1 && kids[0]!.getBoundingClientRect().top < lastTop;
      if (alone && s.justifyContent !== "center") rules.push(media(`${id(el)}{justify-content:center!important;}`));
    }
  }

  // Text at least 14px; footer links 16px with a 44px tap height.
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
    if (!Array.from(el.childNodes).some((c) => c.nodeType === 3 && (c.textContent ?? "").trim())) continue;
    const s = getComputedStyle(el);
    if (px(s.fontSize) > 0 && px(s.fontSize) < 14 && el.getBoundingClientRect().width > 0 && !el.closest("a[href='#main']")) rules.push(media(`${id(el)}{font-size:14px!important;}`));
  }
  rules.push(`footer a{font-size:max(16px,1em);min-height:44px;display:inline-flex;align-items:center;}`);
  rules.push(`.tawd-placeholder-photo{display:flex;align-items:center;justify-content:center;background:#f3f4f6;border:2px dashed #b45309;border-radius:8px;}.tawd-placeholder-photo mark,mark.tawd-placeholder{background:#fef3c7;color:#7c2d12;padding:2px 6px;border-radius:4px;font-weight:700;}.tawd-label{cursor:default;}[data-tawd-lightbox]{cursor:zoom-in;}#tawd-lightbox{border:0;padding:0;background:transparent;max-width:92vw;max-height:92vh;}#tawd-lightbox::backdrop{background:rgba(0,0,0,.8);}#tawd-lightbox img{display:block;max-width:92vw;max-height:88vh;width:auto;height:auto;border-radius:8px;}#tawd-lightbox [data-tawd-close]{position:absolute;top:8px;right:8px;width:44px;height:44px;border:0;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;font-size:28px;cursor:pointer;}`);
  // The skip link takes no room until it gets keyboard focus.
  rules.push(`a[href="#main"]:not(:focus):not(:focus-visible){position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0 0 0 0)!important;clip-path:inset(50%)!important;white-space:nowrap!important;border:0!important}a[href="#main"]:focus,a[href="#main"]:focus-visible{position:fixed!important;top:8px;left:8px;z-index:1000;width:auto!important;height:auto!important;padding:12px 16px!important;background:#fff;color:#000;clip:auto!important;clip-path:none!important;overflow:visible!important}`);

  // The header at tablet width: the logo shrinks until it clears the words beside it.
  if (tablet) {
    const logo = document.querySelector<HTMLElement>("header img");
    if (logo) {
      const lr = logo.getBoundingClientRect();
      const words = Array.from(document.querySelectorAll<HTMLElement>("header p, header nav a, header h1, header h2")).filter((w) => w.getBoundingClientRect().width > 0);
      const hit = words.some((w) => {
        const r = w.getBoundingClientRect();
        return Math.min(r.right, lr.right) - Math.max(r.left, lr.left) > 2 && Math.min(r.bottom, lr.bottom) - Math.max(r.top, lr.top) > 2;
      });
      if (hit) rules.push(media(`${id(logo)}{height:auto!important;max-height:96px!important;width:auto!important;max-width:30vw!important;margin-bottom:0!important;}`));
    }
  }

  // The phone menu opens below the bar instead of pushing its button down; dropdown labels keep their width and get an arrow.
  rules.push(`@media (max-width:767px){header{position:relative}header details[open]:has(nav)>:not(summary){position:absolute;left:0;right:0;top:100%;z-index:60;max-height:calc(100vh - 80px);overflow:auto}header details:has(nav)>summary{margin-left:auto}header [data-tawd-dropdown]{width:auto!important;min-width:0!important;height:auto!important;flex-direction:row!important;white-space:normal}header :is(div,nav,p)[class*="social"],header div:has(>a[aria-label]){flex-wrap:wrap;max-width:100%}}`);
  rules.push(`[data-tawd-dropdown]::after{content:"";display:inline-block;width:.45em;height:.45em;margin-left:.45em;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:translateY(-25%) rotate(45deg);}details[open]>[data-tawd-dropdown]::after{transform:translateY(15%) rotate(-135deg);}`);
  rules.push(`[data-tawd-play]{position:absolute!important;left:50%!important;top:50%!important;transform:translate(-50%,-50%)!important;width:56px!important;height:56px!important;border-radius:50%!important;background:rgba(1,21,59,.62)!important;color:#fff!important;font-size:22px!important;border:0!important;display:flex!important;align-items:center;justify-content:center;pointer-events:none;}[data-tawd-play] svg{height:1em!important;width:auto!important;}`);

  // The largest size each picture is shown at (for its WebP file).
  const pictures: [string, number][] = [];
  for (const img of Array.from(document.querySelectorAll("img"))) {
    const src = img.getAttribute("src");
    if (src?.startsWith("/")) pictures.push([src, Math.round(img.getBoundingClientRect().width)]);
  }
  document.body.setAttribute("data-tawd-n", String(n));
  return { rules: [...new Set(rules)], pictures };
}

/* ---------- in the page: contrast ---------- */

function contrastFixes(): void {
  const parse = (c: string): [number, number, number, number] | null => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const v = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
    return [v[0]!, v[1]!, v[2]!, v.length > 3 ? v[3]! : 1];
  };
  const lum = ([r, g, b]: number[]) => {
    const f = (x: number) => {
      const s = x / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
  };
  const ratio = (a: number[], b: number[]) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };
  // The colour behind an element: the first solid background up the tree; unknown over a picture.
  const behind = (el: Element): number[] | null => {
    for (let at: Element | null = el; at; at = at.parentElement) {
      const s = getComputedStyle(at);
      if (s.backgroundImage !== "none" && !s.backgroundImage.startsWith("linear-gradient")) return null;
      const c = parse(s.backgroundColor);
      if (c && c[3] > 0.5) return c.slice(0, 3);
      if (at.tagName === "IMG" || at.tagName === "PICTURE") return null;
    }
    return [255, 255, 255];
  };
  const overPicture = (el: Element) => {
    const r = el.getBoundingClientRect();
    return Array.from(document.querySelectorAll("img")).some((img) => {
      if (img.contains(el) || el.contains(img)) return false;
      const p = img.getBoundingClientRect();
      return r.left >= p.left && r.right <= p.right && r.top >= p.top && r.bottom <= p.bottom && getComputedStyle(el).position === "absolute";
    });
  };
  const readable = (bg: number[], preferred: number[] | null) => {
    if (preferred && ratio(preferred, bg) >= 4.5) return preferred;
    const light = [255, 255, 255], dark = [1, 21, 59];
    return ratio(light, bg) >= ratio(dark, bg) ? light : dark;
  };
  const css = (c: number[]) => `rgb(${c.map((x) => Math.round(x)).join(",")})`;

  // Icons: at least 3:1, taking their button's text colour first.
  for (const icon of Array.from(document.querySelectorAll<HTMLElement>("[data-kit-icon]"))) {
    if (icon.hasAttribute("data-tawd-play") || overPicture(icon)) continue;
    const s = getComputedStyle(icon);
    const fg = parse(s.color);
    const bg = behind(icon.parentElement ?? icon);
    const own = parse(getComputedStyle(icon).backgroundColor);
    const ground = own && own[3] > 0.5 ? own.slice(0, 3) : bg;
    if (!fg || !ground) continue;
    if (ratio(fg.slice(0, 3), ground) >= 3) continue;
    const parentColour = parse(getComputedStyle(icon.parentElement ?? icon).color);
    const pick = readable(ground, parentColour ? parentColour.slice(0, 3) : null);
    icon.style.setProperty("color", css(pick), "important");
    if (s.borderStyle !== "none") icon.style.setProperty("border-color", css(pick), "important");
  }
  // Text: at least 4.5:1 (3:1 for large text).
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
    if (!Array.from(el.childNodes).some((c) => c.nodeType === 3 && (c.textContent ?? "").trim())) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || overPicture(el)) continue;
    const s = getComputedStyle(el);
    const fg = parse(s.color);
    const bg = behind(el);
    if (!fg || !bg) continue;
    const large = Number.parseFloat(s.fontSize) >= 24 || (Number.parseFloat(s.fontSize) >= 18.6 && Number(s.fontWeight) >= 700);
    if (ratio(fg.slice(0, 3), bg) >= (large ? 3 : 4.5)) continue;
    el.style.setProperty("color", css(readable(bg, null)), "important");
  }
}

/* ---------- the Site check rules (section E) ---------- */

export async function auditPage(browser: Browser, url: string, current: string, pages: SiteMapPage[], parents: Record<string, string>): Promise<string[]> {
  const out: string[] = [];
  for (const width of [1440, 390]) {
    const { page, close } = await open(browser, url, width);
    try {
      const found = await page.evaluate(auditInPage, { width, current, pages, parents });
      for (const f of found) out.push(`Site rule (${width === 390 ? "phone" : "computer"}): ${f}`);
    } finally {
      await close();
    }
  }
  return [...new Set(out)];
}

function auditInPage(input: { width: number; current: string; pages: SiteMapPage[]; parents: Record<string, string> }): string[] {
  const { width, current, pages, parents } = input;
  // A name set in capitals in the design ("MIA", "HUSKY TALK") reads as a name in menus and breadcrumbs ("Mia", "Husky Talk").
  const shownName = (name: string) => (name.length >= 3 && name === name.toUpperCase() && !/^(FAQS?|SEO|USA|HVAC|DIY|FAQ)$/.test(name) ? name.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase()) : name);
  const out: string[] = [];
  const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none" && !el.closest("details:not([open]) > :not(summary)");
  };
  // Dead links.
  const dead = Array.from(document.querySelectorAll("a")).filter((a) => shown(a) && (!a.getAttribute("href") || a.getAttribute("href")!.trim() === "#" || a.getAttribute("href")!.trim() === ""));
  if (dead.length) out.push(`${dead.length} link${dead.length === 1 ? " goes" : "s go"} nowhere (${dead.slice(0, 4).map((a) => `"${text(a).slice(0, 30) || a.getAttribute("aria-label") || "icon"}"`).join(", ")}).`);
  // Contrast.
  const parse = (c: string) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const v = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
    return [v[0]!, v[1]!, v[2]!, v.length > 3 ? v[3]! : 1];
  };
  const lum = ([r, g, b]: number[]) => [r!, g!, b!].map((x) => (x / 255 <= 0.03928 ? x / 255 / 12.92 : ((x / 255 + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  const ratio = (a: number[], b: number[]) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };
  const behind = (el: Element): number[] | null => {
    for (let at: Element | null = el; at; at = at.parentElement) {
      const s = getComputedStyle(at);
      if (s.backgroundImage !== "none" && !s.backgroundImage.startsWith("linear-gradient")) return null;
      const c = parse(s.backgroundColor);
      if (c && c[3]! > 0.5) return c.slice(0, 3);
    }
    return [255, 255, 255];
  };
  const low: string[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
    const isIcon = el.hasAttribute("data-kit-icon");
    const hasText = Array.from(el.childNodes).some((c) => c.nodeType === 3 && (c.textContent ?? "").trim());
    if ((!isIcon && !hasText) || !shown(el) || el.hasAttribute("data-tawd-play")) continue;
    const s = getComputedStyle(el);
    const fg = parse(s.color);
    const own = parse(s.backgroundColor);
    const bg = isIcon && own && own[3]! > 0.5 ? own.slice(0, 3) : behind(isIcon ? el.parentElement ?? el : el);
    if (!fg || !bg) continue;
    if (ratio(fg.slice(0, 3), bg) < 3) low.push(isIcon ? "an icon" : `"${text(el).slice(0, 30)}"`);
  }
  if (low.length) out.push(`${low.length} thing${low.length === 1 ? " is" : "s are"} hard to see (contrast under 3:1): ${[...new Set(low)].slice(0, 4).join(", ")}.`);
  // Wider than the screen.
  if (document.documentElement.scrollWidth > window.innerWidth) out.push(`The page is ${document.documentElement.scrollWidth}px wide on a ${width}px screen.`);
  // Blank gaps on a phone.
  if (width < 768) {
    const boxes = Array.from(document.querySelectorAll<HTMLElement>("main *"))
      .filter((el) => shown(el) && (el.tagName === "IMG" || Array.from(el.childNodes).some((c) => c.nodeType === 3 && (c.textContent ?? "").trim()) || el.hasAttribute("data-kit-icon") || ["BUTTON", "IFRAME", "VIDEO", "INPUT"].includes(el.tagName)))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return [r.top + window.scrollY, r.bottom + window.scrollY] as const;
      })
      .sort((a, b) => a[0] - b[0]);
    let reach = boxes[0]?.[1] ?? 0;
    for (const [top, bottom] of boxes.slice(1)) {
      if (top - reach > 200) {
        out.push(`A blank gap of ${Math.round(top - reach)}px on a phone.`);
        break;
      }
      reach = Math.max(reach, bottom);
    }
  }
  // Placeholder words.
  const words = text(document.body);
  const fake = ["Placeholder", "Goes Here", "Lorem", "Short description of"].filter((w) => new RegExp(w, "i").test(words));
  if (fake.length) out.push(`Placeholder text on the page: ${fake.join(", ")}.`);
  // Pages beside this one under the same parent (a dog page and its brothers and sisters).
  const parent = parents[current];
  if (parent) {
    const siblings = pages.filter((p) => p.path !== current && parents[p.path] === parent);
    const named = (el: Element) => siblings.filter((p) => new RegExp(`\\b${p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(el.getAttribute("alt") ?? text(el)));
    const own = (el: Element, p: SiteMapPage) => {
      for (let at: Element | null = el, i = 0; at && i < 3 && !["MAIN", "SECTION"].includes(at.tagName); at = at.parentElement, i += 1) if (at.matches(`a[href="${p.path}"]`) || at.querySelector(`a[href="${p.path}"]`)) return true;
      return false;
    };
    const wrong: string[] = [];
    for (const el of Array.from(document.querySelectorAll("main h1, main h2, main h3, main img[alt]"))) {
      for (const p of named(el)) if (!own(el, p)) wrong.push(`${p.name} in ${el.tagName === "IMG" ? "a picture's alt text" : `the heading "${text(el).slice(0, 30)}"`}`);
    }
    if (wrong.length) out.push(`Another page's name on this page: ${[...new Set(wrong)].slice(0, 4).join("; ")}.`);
    const labels = Array.from(document.querySelectorAll("main [class*='label' i]"));
    const same = labels.filter((l) => {
      const next = l.nextElementSibling;
      return next && /value/i.test(next.className) && text(next).toLowerCase() === text(l).toLowerCase();
    });
    if (same.length) out.push(`"At a glance" values equal to their labels: ${same.slice(0, 4).map(text).join(", ")}.`);
  }
  // Breadcrumbs match the site map.
  const crumb = document.querySelector("nav[aria-label*='readcrumb' i]") ?? document.querySelector("[class*='breadcrumb' i]");
  if (crumb && current !== "/") {
    const expected: string[] = [];
    for (let at: string | undefined = current; at; at = parents[at]) {
      expected.unshift(shownName(pages.find((p) => p.path === at)?.name ?? at));
      if (!parents[at]) break;
    }
    const home = pages.find((p) => p.path === "/");
    if (home) expected.unshift(shownName(home.name));
    const got = Array.from(crumb.querySelectorAll("a, [aria-current]")).map(text).filter(Boolean);
    if (got.join(" > ").toLowerCase() !== expected.join(" > ").toLowerCase()) out.push(`The breadcrumb says "${got.join(" > ")}"; the site map says "${expected.join(" > ")}".`);
  }
  // Pictures shown larger than they are.
  const blurry = Array.from(document.querySelectorAll("img")).filter((img) => shown(img) && img.naturalWidth > 0 && img.getBoundingClientRect().width > img.naturalWidth * 1.15);
  if (blurry.length) out.push(`${blurry.length} picture${blurry.length === 1 ? " is" : "s are"} shown larger than ${blurry.length === 1 ? "it is" : "they are"} (blurry): ${blurry.slice(0, 3).map((i) => `${i.getAttribute("src")} (${i.naturalWidth}px shown at ${Math.round(i.getBoundingClientRect().width)}px)`).join(", ")}.`);
  // A meta description.
  const meta = document.querySelector('meta[name="description"]')?.getAttribute("content") ?? "";
  if (!meta.trim()) out.push("The page has no meta description.");
  return width === 390 ? out.filter((o) => !/meta description|breadcrumb|placeholder|another page's name|at a glance/i.test(o)) : out;
}

/* ---------- pictures: WebP at twice their largest displayed size ---------- */

async function optimisePictures(browser: Browser, dist: string, displayed: Map<string, number>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const context = await ownPageContext(browser);
  try {
    const page = await context.newPage();
    for (const [src, shownAt] of displayed) {
      if (!/\.(png|jpe?g)$/i.test(src) || shownAt <= 0) continue;
      const file = path.join(dist, src.replace(/^\//, ""));
      const bytes = await fs.readFile(file).catch(() => null);
      if (!bytes) continue;
      const type = /\.png$/i.test(src) ? "image/png" : "image/jpeg";
      const webp = await page.evaluate(
        async ({ data, type, target }) => {
          const img = new Image();
          img.src = `data:${type};base64,${data}`;
          await img.decode();
          const scale = Math.min(1, target / img.naturalWidth);
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
          const url = canvas.toDataURL("image/webp", 0.86);
          return url.startsWith("data:image/webp") ? url.split(",")[1]! : null;
        },
        { data: bytes.toString("base64"), type, target: shownAt * 2 },
      );
      if (!webp) continue;
      const next = src.replace(/\.(png|jpe?g)$/i, ".webp");
      const buffer = Buffer.from(webp, "base64");
      // Only when it is really smaller (a tiny PNG icon can grow as WebP).
      if (buffer.length >= bytes.length) continue;
      await fs.writeFile(path.join(dist, next.replace(/^\//, "")), buffer);
      out.set(src, next);
    }
  } finally {
    await context.close();
  }
  return out;
}
