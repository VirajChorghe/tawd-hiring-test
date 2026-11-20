import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Browser } from "playwright-core";

import type { Database } from "@tawd/core/db";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { getStorage } from "@tawd/core/intake/storage";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import type { SeoSuggestJobData } from "@tawd/core/queue";
import { designCopy, designPage, figmaDesign, project } from "@tawd/core/schema";
import { ownPageContext } from "./locked-context";
import { loadHtml } from "./page-load";

/*
  The minimal SEO pass (Jason, 29 September 2026), by code, $0: for each
  page, suggestions the team approves or changes: a title (the page's name
  and the site's), a description (the page's first real paragraph, cut at a
  word under 155 characters), the H1 (the page's only one, else its largest
  words near the top), notes on its headings (none, several H1s, a skipped
  level), and alt text for each picture without one (the words beside it).
  The design and the words on the page never change here.
*/

export interface SeoSuggestion {
  title: string;
  description: string;
  h1: string;
  /** How the page stands now: "one H1", "no H1", "3 H1s". */
  h1Now: string;
  headingNotes: string[];
  /** By the picture's src (a tawd-asset token in the copy). */
  alts: { src: string; alt: string }[];
}

export async function suggestSeo(browser: Browser, html: string, input: { pageName: string; siteName: string; isHome: boolean; tagline: string | null }): Promise<SeoSuggestion> {
  const context = await ownPageContext(browser, { viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    // Pictures aren't needed to read the words; nothing is fetched.
    await page.route("**/*", (route) => (/^(data|about):/.test(route.request().url()) ? route.continue() : route.abort()));
    await loadHtml(page, html);
    const found = await page.evaluate(() => {
      const clean = (t: string) => t.replace(/[→←♡❤]/g, "").replace(/\s+/g, " ").trim();
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden" && !el.closest(".tawd-m-header,.tawd-m-footer");
      };
      const h1s = Array.from(document.querySelectorAll("h1")).filter(visible).map((h) => clean(h.innerText));
      const levels = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).filter(visible).map((h) => Number(h.tagName[1]));
      const notes: string[] = [];
      if (levels.length === 0) notes.push("The page has no headings (H1 to H6): its section titles are styled words only.");
      for (let i = 1; i < levels.length; i += 1) if (levels[i]! > levels[i - 1]! + 1) notes.push(`A heading jumps from H${levels[i - 1]} to H${levels[i]}.`);
      // The largest words in the first screen and a half, not in the header.
      const top = window.innerHeight * 1.5;
      let biggest = { text: "", size: 0 };
      document.querySelectorAll<HTMLElement>("body *").forEach((el) => {
        if (!visible(el) || el.closest("header,nav")) return;
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent ?? "").join(" ");
        const text = clean(el.innerText ?? "");
        if (!clean(own) || text.length < 3 || text.length > 80) return;
        const r = el.getBoundingClientRect();
        if (r.top > top) return;
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size > biggest.size) biggest = { text, size };
      });
      const paragraph = Array.from(document.querySelectorAll<HTMLElement>("p, [class*='text'], div"))
        .filter((el) => visible(el) && !el.closest("header,nav,footer") && el.children.length <= 2)
        .map((el) => clean(el.innerText ?? ""))
        .find((t) => t.length >= 70 && t.split(" ").length >= 10) ?? "";
      const alts = Array.from(document.images)
        .filter((img) => !(img.getAttribute("alt") ?? "").trim() && img.getAttribute("src"))
        .map((img) => {
          // The words in the smallest box around the picture that has some.
          let box: Element | null = img.parentElement;
          let words = "";
          for (let up = 0; box && up < 4 && !words; up += 1) {
            words = Array.from(box.querySelectorAll("*"))
              .filter((c) => c !== img && !c.closest("[data-kit-icon]"))
              .map((c) => Array.from(c.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent ?? "").join(" "))
              .map(clean)
              .find((t) => t.length >= 2 && t.length <= 60) ?? "";
            box = box.parentElement;
          }
          return { src: img.getAttribute("src")!, words };
        });
      return { h1s, notes, biggest: biggest.text, paragraph, alts };
    });
    const cut = (t: string, n: number) => (t.length <= n ? t : `${t.slice(0, t.lastIndexOf(" ", n - 1) > 40 ? t.lastIndexOf(" ", n - 1) : n - 1).replace(/[,;:.\s]+$/, "")}...`);
    const titleCase = (t: string) => (t === t.toUpperCase() ? t.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : t);
    const h1 = found.h1s.length === 1 ? found.h1s[0]! : titleCase(found.biggest || input.pageName);
    const title = cut(input.isHome ? `${input.siteName}${input.tagline ? `: ${input.tagline.replace(/\.$/, "")}` : ""}` : `${titleCase(input.pageName)} | ${input.siteName}`, 60);
    const description = cut(found.paragraph || `${titleCase(input.pageName)} from ${input.siteName}.`, 155);
    const notes = [...found.notes];
    if (found.h1s.length === 0) notes.unshift(`The page has no H1: "${h1}" becomes it.`);
    if (found.h1s.length > 1) notes.unshift(`The page has ${found.h1s.length} H1s; keep one ("${h1}").`);
    const seen = new Set<string>();
    const alts = found.alts
      .filter((a) => !seen.has(a.src) && seen.add(a.src))
      .map((a, i) => ({ src: a.src, alt: a.words ? titleCase(a.words) : `${titleCase(input.pageName)}, picture ${i + 1}` }));
    return { title, description, h1, h1Now: found.h1s.length === 1 ? "one H1" : found.h1s.length ? `${found.h1s.length} H1s` : "no H1", headingNotes: notes, alts };
  } finally {
    await context.close();
  }
}

export async function runSeoSuggestJob(db: Database, browser: Browser, job: SeoSuggestJobData): Promise<void> {
  const storage = getStorage();
  const [figma] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, job.projectId)).limit(1);
  if (!figma?.importedVersion) return;
  const [client] = await db.select({ name: project.clientName }).from(project).where(eq(project.id, job.projectId)).limit(1);
  const pages = await db.select().from(designPage).where(and(eq(designPage.projectId, job.projectId), eq(designPage.figmaVersion, figma.importedVersion))).orderBy(asc(designPage.position));
  const copies = await db.select().from(designCopy).where(and(eq(designCopy.projectId, job.projectId), inArray(designCopy.status, ["done", "needs_cleanup"]))).orderBy(desc(designCopy.createdAt));
  let tagline: string | null = null;
  for (const page of [...pages].sort((a, b) => Number(b.isHome) - Number(a.isHome))) {
    const copy = copies.find((c) => c.frameId === page.frameId);
    const html = copy?.sourceKey ? (await storage.get(copy.sourceKey))?.toString("utf8") : null;
    if (!html) continue;
    if (page.isHome) tagline = /<p class="tawd-m-tagline">([^<]+)<\/p>/.exec(html)?.[1]?.trim() ?? null;
    const suggested = await suggestSeo(browser, html, { pageName: page.name, siteName: client?.name ?? "", isHome: page.isHome, tagline });
    const seo = (page.seo as { approved?: unknown } | null) ?? {};
    await db.update(designPage).set({ seo: { ...seo, suggested, suggestedAt: new Date().toISOString() } }).where(eq(designPage.id, page.id));
  }
  await recordActivity(db, { action: "design.seo_suggested", entityType: "project", entityId: job.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { pages: pages.length }, ipAddress: null, userAgent: null });
}
