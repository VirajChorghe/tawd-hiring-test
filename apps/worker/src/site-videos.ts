import type { Browser } from "playwright-core";

import type { SiteVideo } from "@tawd/core/site";
import { ownPageContext } from "./locked-context";

/*
  The client's social videos in the built site (Jason, 29 September 2026):
  the home page's featured video cards (a photo with a play mark over it)
  become click-to-play, one video each in order, their captions the
  videos' titles when given; and a Videos page is made from the home
  page's header and footer with the grid of all of them. A TikTok video's
  thumbnail comes from TikTok's public oEmbed at build time; an Instagram
  one (Instagram gives none without an app key) uses the design's own
  featured-video pictures.
*/

/* A TikTok video's title and thumbnail from its public oEmbed; null when it can't be had. */
export async function tiktokThumbnail(url: string): Promise<{ title: string | null; bytes: Buffer } | null> {
  try {
    const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { title?: string; thumbnail_url?: string };
    if (!data.thumbnail_url) return null;
    const pic = await fetch(data.thumbnail_url, { signal: AbortSignal.timeout(15_000) });
    if (!pic.ok) return null;
    return { title: data.title?.trim() || null, bytes: Buffer.from(await pic.arrayBuffer()) };
  } catch {
    return null;
  }
}

/* The home page with its featured video cards made click-to-play; also the cards' pictures, in order. */
export async function featureVideos(browser: Browser, homeHtml: string, videos: SiteVideo[], playRefs: string[]): Promise<{ html: string; pictures: string[]; cards: number }> {
  const context = await ownPageContext(browser);
  try {
    const tab = await context.newPage();
    return await tab.evaluate(
      ({ homeHtml, videos, playRefs }) => {
        const doc = new DOMParser().parseFromString(homeHtml, "text/html");
        const marks = Array.from(doc.querySelectorAll("[data-kit-icon]")).filter((m) => playRefs.includes(m.getAttribute("data-kit-icon") ?? ""));
        // A page built before keeps last time's cards: they're cleared, then found again.
        for (const old of Array.from(doc.querySelectorAll("[data-tawd-video-card]"))) for (const attr of ["data-tawd-video-card", "data-src", "data-title", "role", "tabindex", "aria-label"]) old.removeAttribute(attr);
        const cards: Element[] = [];
        const pics = (el: Element) => el.querySelectorAll("img,[role=img]").length;
        const hasWords = (el: Element) => Array.from(el.querySelectorAll("*")).some((c) => !c.closest("[data-kit-icon]") && Array.from(c.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim()));
        for (const mark of marks) {
          // A play mark on a thumbnail: one picture right beside it (a heading's play icon has none; its panel has several).
          let box: Element | null = mark.parentElement;
          for (let up = 0; box && up < 3 && pics(box) === 0; up += 1) box = box.parentElement;
          if (!box || pics(box) !== 1) continue;
          // The card: the biggest box around it still holding only that picture, with its caption.
          let card: Element = box;
          for (let up = 0; up < 3 && card.parentElement && pics(card.parentElement) === 1 && card.parentElement.tagName !== "MAIN" && card.parentElement.tagName !== "SECTION"; up += 1) {
            card = card.parentElement;
            if (hasWords(card)) break;
          }
          if (!cards.includes(card)) cards.push(card);
        }
        // Inside a card nothing leads away: the click plays the video.
        for (const card of cards) {
          for (const a of Array.from(card.querySelectorAll("a"))) {
            const span = doc.createElement("span");
            span.className = a.className;
            span.innerHTML = a.innerHTML;
            a.replaceWith(span);
          }
          if (card.tagName === "A") {
            const div = doc.createElement("div");
            div.className = card.className;
            div.innerHTML = card.innerHTML;
            card.replaceWith(div);
            cards[cards.indexOf(card)] = div;
          }
        }
        const pictures = cards.map((c) => c.querySelector("img")?.getAttribute("src") ?? "").filter(Boolean);
        cards.forEach((card, i) => {
          const v = videos[i];
          if (!v) return;
          const title = v.title ?? `Video ${i + 1}`;
          card.setAttribute("data-tawd-video-card", "");
          card.setAttribute("data-src", v.embed);
          card.setAttribute("data-title", title);
          card.setAttribute("role", "button");
          card.setAttribute("tabindex", "0");
          card.setAttribute("aria-label", `Play ${title} (plays from ${v.platform === "tiktok" ? "TikTok" : "Instagram"})`);
          if (v.title) {
            // The caption: the card's words that aren't the play mark.
            const words = Array.from(card.querySelectorAll("*")).filter((el) => !el.closest("[data-kit-icon]") && Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim()));
            const caption = words[words.length - 1];
            if (caption) {
              const nodes = Array.from(caption.childNodes).filter((n) => n.nodeType === 3 || (n as Element).tagName === "BR");
              // A short caption, cut at a word ("…"), never mid-word.
              const t = v.title.replace(/\s+/g, " ").trim();
              const short = t.length <= 44 ? t : `${t.slice(0, 45).replace(/\s+\S*$/, "").replace(/[\s,;:.!?-]+$/, "")}…`;
              nodes.forEach((n, k) => (k === 0 ? (n.textContent = short) : n.remove()));
            }
          }
        });
        return { html: `<!doctype html>\n${doc.documentElement.outerHTML}`, pictures, cards: cards.length };
      },
      { homeHtml, videos, playRefs },
    );
  } finally {
    await context.close();
  }
}

/* A page made from the home page: its header and footer, with `main` between them, the menu marking `path`. */
export async function pageFromHome(browser: Browser, homeHtml: string, main: string, path: string, title: string): Promise<string> {
  const context = await ownPageContext(browser);
  try {
    const tab = await context.newPage();
    return await tab.evaluate(
      ({ homeHtml, main, path, title }) => {
        const doc = new DOMParser().parseFromString(homeHtml, "text/html");
        const top = Array.from(doc.querySelectorAll("[data-figma-section]")).filter((s) => !s.parentElement?.closest("[data-figma-section]"));
        const shell = doc.querySelector("style[data-tawd-shell]")?.textContent ?? "";
        const hidden = new Set([...shell.matchAll(/\[data-figma-section="(\d+)"\]/g)].map((m) => m[1]));
        const keep = new Set<Element>();
        for (const s of top) {
          if (hidden.size ? hidden.has(s.getAttribute("data-figma-section") ?? "") : /^(header|nav)$/i.test(s.tagName)) keep.add(s);
          else break;
        }
        const last = top[top.length - 1];
        if (last && (last.tagName.toLowerCase() === "footer" || /©|copyright/i.test(last.textContent ?? ""))) keep.add(last);
        for (const s of top) if (!keep.has(s)) s.remove();
        const holder = doc.createElement("main");
        holder.innerHTML = main;
        if (last && keep.has(last)) last.before(holder);
        else doc.body.appendChild(holder);
        doc.querySelectorAll("[aria-current]").forEach((a) => a.removeAttribute("aria-current"));
        doc.querySelectorAll(`.tawd-m-header a[href="${path}"], .tawd-m-footer a[href="${path}"]`).forEach((a) => a.setAttribute("aria-current", "page"));
        const t = doc.querySelector("title");
        if (t) t.textContent = title;
        return `<!doctype html>\n${doc.documentElement.outerHTML}`;
      },
      { homeHtml, main, path, title },
    );
  } finally {
    await context.close();
  }
}
