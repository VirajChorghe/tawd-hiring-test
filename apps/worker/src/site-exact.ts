import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Browser } from "playwright-core";

import { getDb } from "@tawd/core/db";
import { designCopy, designPage, figmaDesign, pagePlanPage, project } from "@tawd/core/schema";
import { getStorage } from "@tawd/core/intake/storage";
import { exactImagePath, homeParts, pageMeta, replaceAssetTokens } from "@tawd/core/site";

import { applyKit, kitCss } from "@tawd/core/style-kit/kit";

import { loadDesignSource } from "./design-source";
import { loadKitForCopy } from "./style-kit-job";
import { VIDEO_CSS, VIDEO_SCRIPT, videosPageMain, type SiteVideo } from "@tawd/core/site";
import { featureVideos, pageFromHome, tiktokThumbnail } from "./site-videos";
import { ownPageContext } from "./locked-context";
import { loadHtml } from "./page-load";

/*
  The home page's header and footer sections put in place of a page's own
  (Jason, 29 September 2026: "one shared header and footer on every page").
  A page's first sections are its header when they carry the same menu
  words as the home page's header (the phone header's hidden sections name
  them); its last section is its footer when it is a <footer> or carries
  the copyright line. Pictures already point at their files, so the home
  page's header brings its own logo.
*/
/*
  The approved SEO basics into a built page: a description on each picture
  that has none (its src, a token or its file, ends with the token's name),
  and the H1: when the page has none, the element holding the approved words
  becomes one, keeping exactly the size, weight and spacing it had.
*/
export async function applySeo(browser: Browser, html: string, seo: { h1: string; alts: { src: string; alt: string }[] }): Promise<string> {
  const context = await ownPageContext(browser, { viewport: { width: 1440, height: 900 } });
  try {
    const tab = await context.newPage();
    await tab.route("**/*", (route) => (/^(data|about):/.test(route.request().url()) ? route.continue() : route.abort()));
    await loadHtml(tab, html);
    return await tab.evaluate((seo) => {
      const name = (src: string) => src.replace(/^tawd-asset:/, "").replace(/^.*\//, "").replace(/\.[a-z0-9]+$/i, "");
      for (const img of Array.from(document.images)) {
        if ((img.getAttribute("alt") ?? "").trim()) continue;
        const match = seo.alts.find((a) => name(a.src) === name(img.getAttribute("src") ?? ""));
        if (match?.alt) img.setAttribute("alt", match.alt);
      }
      const norm = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
      if (seo.h1 && !document.querySelector("h1")) {
        let best: HTMLElement | null = null;
        document.querySelectorAll<HTMLElement>("body *").forEach((el) => {
          if (el.closest(".tawd-m-header,.tawd-m-footer,[data-kit-icon]")) return;
          if (norm(el.innerText ?? "") !== norm(seo.h1)) return;
          if (!best || best.contains(el)) best = el;
        });
        if (best) {
          const el = best as HTMLElement;
          const cs = getComputedStyle(el);
          const keep = `font-size:${cs.fontSize};font-weight:${cs.fontWeight};line-height:${cs.lineHeight};margin:${cs.margin};font-family:${cs.fontFamily.replace(/"/g, "'")};color:${cs.color};display:${cs.display === "inline" ? "inline-block" : cs.display}`;
          const h1 = document.createElement("h1");
          for (const attr of Array.from(el.attributes)) h1.setAttribute(attr.name, attr.value);
          h1.setAttribute("style", `${el.getAttribute("style") ?? ""};${keep}`.replace(/^;/, ""));
          while (el.firstChild) h1.appendChild(el.firstChild);
          el.replaceWith(h1);
        }
      }
      return `<!doctype html>\n${document.documentElement.outerHTML}`;
    }, seo);
  } finally {
    await context.close();
  }
}

export async function withSharedChrome(browser: Browser, pageHtml: string, homeHtml: string): Promise<string> {
  const context = await ownPageContext(browser);
  try {
    const tab = await context.newPage();
    return await tab.evaluate(
      ({ pageHtml, homeHtml }) => {
        const parser = new DOMParser();
        const page = parser.parseFromString(pageHtml, "text/html");
        const home = parser.parseFromString(homeHtml, "text/html");
        const top = (doc: Document) => Array.from(doc.querySelectorAll("[data-figma-section]")).filter((s) => !s.parentElement?.closest("[data-figma-section]"));
        const words = (el: Element) => new Set((el.textContent ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
        // The home page's header: the sections its phone header hides at the top (else its <header> and <nav>).
        const hidden = /\[data-figma-section="(\d+)"\]/g;
        const shell = home.querySelector("style[data-tawd-shell]")?.textContent ?? "";
        const hiddenNumbers = new Set([...shell.matchAll(hidden)].map((m) => m[1]));
        const homeTop = top(home);
        const homeHeader: Element[] = [];
        for (const s of homeTop) {
          if (hiddenNumbers.size ? hiddenNumbers.has(s.getAttribute("data-figma-section") ?? "") : /^(header|nav)$/i.test(s.tagName)) homeHeader.push(s);
          else break;
        }
        const isFooter = (s: Element | undefined) => Boolean(s && (s.tagName.toLowerCase() === "footer" || /\u00a9|copyright/i.test(s.textContent ?? "")));
        const homeFooter = isFooter(homeTop[homeTop.length - 1]) ? homeTop[homeTop.length - 1]! : null;
        const pageTop = top(page);
        if (homeHeader.length && pageTop.length > homeHeader.length) {
          const mine = pageTop.slice(0, homeHeader.length);
          const homeWords = new Set(homeHeader.flatMap((s) => [...words(s)]));
          const pageWords = mine.flatMap((s) => [...words(s)]);
          const shared = pageWords.filter((w) => homeWords.has(w)).length / Math.max(1, homeWords.size);
          if (shared >= 0.5) {
            homeHeader.forEach((s, i) => {
              const copy = page.importNode(s, true) as Element;
              // Keeps this page's own section number, so its phone rules still find it.
              copy.setAttribute("data-figma-section", mine[i]!.getAttribute("data-figma-section") ?? "");
              mine[i]!.replaceWith(copy);
            });
          }
        }
        const pageLast = pageTop[pageTop.length - 1];
        if (homeFooter && isFooter(pageLast) && pageLast !== pageTop[0]) {
          const copy = page.importNode(homeFooter, true) as Element;
          copy.setAttribute("data-figma-section", pageLast!.getAttribute("data-figma-section") ?? "");
          pageLast!.replaceWith(copy);
        }
        return `<!doctype html>\n${page.documentElement.outerHTML}`;
      },
      { pageHtml, homeHtml },
    );
  } finally {
    await context.close();
  }
}

/*
  Lane 2, Option A (28 September 2026): the approved design's pages, for a
  build that uses them exactly. Each page is its copy's source (with its
  phone CSS), its images written under its own folder. Null when the
  project isn't an Option A project with every page copied; the usual build
  then applies.
*/

export interface ExactSitePage {
  id: string;
  name: string;
  slug: string;
  kind: "home" | "page";
  title: string | null;
  metaDescription: string | null;
  mainKeyword: string | null;
  /** The page, its images already pointing at their files. */
  html: string;
}

export interface ExactSite {
  pages: ExactSitePage[];
  images: { path: string; bytes: Buffer }[];
  parts: { head: string; header: string; footer: string };
}

export async function loadExactSite(projectId: string, browser: Browser): Promise<ExactSite | null> {
  const db = getDb();
  const storage = getStorage();
  const [row] = await db.select({ lane: project.lane, laneOption: project.laneOption }).from(project).where(eq(project.id, projectId)).limit(1);
  if (row?.lane !== "lane_2" || row.laneOption !== "a") return null;
  const [figma] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  if (!figma?.importedVersion) return null;
  const rows = await db
    .select()
    .from(designPage)
    .where(and(eq(designPage.projectId, projectId), eq(designPage.figmaVersion, figma.importedVersion)))
    .orderBy(asc(designPage.position));
  if (rows.length === 0) return null;
  // Each page's newest finished copy; one that still has sections to fix stops the build with a clear line.
  const copies = await db
    .select()
    .from(designCopy)
    .where(and(eq(designCopy.projectId, projectId), eq(designCopy.figmaVersion, figma.importedVersion), inArray(designCopy.frameId, rows.map((r) => r.frameId)), inArray(designCopy.status, ["done", "needs_cleanup"])))
    .orderBy(desc(designCopy.createdAt));
  const plan = await db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId));

  const pages: ExactSitePage[] = [];
  const images: ExactSite["images"] = [];
  for (const page of rows) {
    const copy = copies.find((c) => c.frameId === page.frameId);
    if (copy?.status === "needs_cleanup") throw new Error(`${page.name} still has sections to fix. On Mockups, accept its copy as it is or rebuild those sections first.`);
    const source = copy?.sourceKey ? (await storage.get(copy.sourceKey))?.toString("utf8") : null;
    if (!copy || !source) throw new Error(`${page.name} has no finished copy. Copy every page on Mockups first.`);
    const design = await loadDesignSource(db, storage, browser, { projectId, frameId: page.frameId, frameName: page.frameName, purpose: "build the site" });
    // The style kit (29 September 2026): its styles and icons into the page, its fonts as the site's own files.
    const styled = await loadKitForCopy(db, { projectId, designVersion: copy.figmaVersion, frameId: copy.frameId });
    let html = source;
    if (styled) {
      html = applyKit(html, styled.kit, kitCss(styled.kit, (key) => `/fonts/${key.split("/").pop()}`)).html;
      for (const font of styled.kit.fonts) {
        for (const file of font.files) {
          const path = `/fonts/${file.key.split("/").pop()}`;
          if (images.some((i) => i.path === path)) continue;
          const bytes = await storage.get(file.key);
          if (bytes) images.push({ path, bytes });
        }
      }
    }
    for (const asset of design.assets) {
      const match = /^data:([^;]+);base64,(.*)$/.exec(asset.dataUri);
      if (!match) continue;
      const ext = match[1]!.includes("png") ? "png" : match[1]!.includes("svg") ? "svg" : match[1]!.includes("webp") ? "webp" : "jpg";
      const file = exactImagePath(page.slug, asset.token, ext);
      images.push({ path: file, bytes: Buffer.from(match[2]!, "base64") });
      html = replaceAssetTokens(html, new Map([[asset.token, file]]));
    }
    const planned = plan.find((p) => p.slug === page.slug || (page.isHome && p.kind === "home"));
    const own = pageMeta(source);
    // The SEO basics the team approved (29 September 2026): alt text, the H1, the title and description.
    const seo = (page.seo as { approved?: { title: string; description: string; h1: string; alts: { src: string; alt: string }[] } } | null)?.approved;
    if (seo) {
      const applied = await applySeo(browser, html, seo);
      if (typeof applied === "string" && applied.includes("<body")) html = applied;
    }
    pages.push({
      id: page.id,
      name: page.name,
      slug: page.slug,
      kind: page.isHome ? "home" : "page",
      title: seo?.title || planned?.title || own.title,
      metaDescription: seo?.description || planned?.metaDescription || own.description,
      mainKeyword: planned?.mainKeyword ?? null,
      html,
    });
  }
  const home = pages.find((p) => p.kind === "home") ?? pages[0]!;
  // One header and footer on every page: the home page's (29 September 2026).
  for (const page of pages) {
    if (page === home) continue;
    const shared = await withSharedChrome(browser, page.html, home.html);
    if (typeof shared === "string" && shared.includes("<body")) page.html = shared;
  }

  // The client's social videos (29 September 2026): the home page's featured videos and a Videos page, click-to-play.
  const [client] = await db.select({ name: project.clientName, videos: project.videos }).from(project).where(eq(project.id, projectId)).limit(1);
  const videos = (client?.videos as SiteVideo[] | null) ?? [];
  if (videos.length) {
    const homeRow = rows.find((r) => r.isHome) ?? rows[0]!;
    const styled = await loadKitForCopy(db, { projectId, designVersion: figma.importedVersion, frameId: homeRow.frameId });
    const playRefs = (styled?.kit.icons ?? []).filter((i) => i.label === "player-play" || i.label === "play button").map((i) => i.ref);
    const withAssets = (html: string) => html.replace(/<\/head>/i, `<style>${VIDEO_CSS}</style></head>`).replace(/<\/body>/i, `${VIDEO_SCRIPT}</body>`);
    const featured = await featureVideos(browser, home.html, videos, playRefs);
    if (typeof featured?.html === "string") home.html = withAssets(featured.html);
    const thumbs: (string | null)[] = [];
    for (const [i, v] of videos.entries()) {
      const tiktok = v.platform === "tiktok" ? await tiktokThumbnail(v.url) : null;
      if (tiktok) {
        const path = `/images/videos/${i + 1}.jpg`;
        images.push({ path, bytes: tiktok.bytes });
        thumbs.push(path);
        if (!v.title && tiktok.title) v.title = tiktok.title.slice(0, 80);
      } else {
        const pics = featured?.pictures ?? [];
        thumbs.push(pics.length ? pics[i % pics.length]! : null);
      }
    }
    const existing = pages.find((p) => p.slug === "videos");
    const name = client?.name ?? "";
    const html = await pageFromHome(browser, home.html, videosPageMain(videos, thumbs), "/videos/", `Videos | ${name}`);
    if (typeof html === "string") {
      const page = { id: existing?.id ?? "videos", name: "Videos", slug: "videos", kind: "page" as const, title: `Videos | ${name}`, metaDescription: `Videos from ${name}: ${videos.length} to watch.`, mainKeyword: null, html: withAssets(html) };
      if (existing) Object.assign(existing, page);
      else pages.push(page);
    }
  }
  return { pages, images, parts: homeParts(home.html) };
}
