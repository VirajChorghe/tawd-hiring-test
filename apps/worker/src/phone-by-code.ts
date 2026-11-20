import type { Browser } from "playwright-core";

import type { ShellData, ShellLink } from "@tawd/core/site";

import { REPAIR_ASSET_HOST } from "./copy-repair";
import { ownPageContext } from "./locked-context";
import { fontsReady, loadHtml, openPage } from "./page-load";

/*
  Phone versions by code (Jason, 29 September 2026: "remake the sample client's phone
  versions by code"; Batch 2's phone rules). No AI. On the page as drawn
  1440px wide, each element's layout is read and turned into phone rules
  under 768px:
  - no fixed heights or widths; absolutely placed things go back into the
    flow (a panel drawn behind a section is dropped, its colour kept);
  - a row of three or more like items (cards) becomes a 2-column grid,
    other rows a column;
  - one alignment per section (the one most of its words use);
  - headings scaled down, images never larger than they are;
  - buttons and links that look like buttons at least 44px tall.
  The rules go into the page as its phone CSS, with data-m marks on the
  elements they are for. The phone check then draws the page 390px wide.
*/

export interface PageLink {
  name: string;
  slug: string;
}

const SHORT = 28;

/* The home page's header and footer, read into the shared phone header and footer. */
export async function readShell(browser: Browser, homeHtml: string, pages: PageLink[], legal: ShellLink[]): Promise<ShellData> {
  const context = await ownPageContext(browser, { viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await loadHtml(page, homeHtml);
    const found = await page.evaluate((SHORT) => {
      const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-figma-section]"));
      const n = (el: Element) => Number(el.getAttribute("data-figma-section"));
      const clean = (t: string) => t.replace(/[→←♡❤]/g, "").replace(/\s+/g, " ").trim();
      // The header: the short sections at the top (a banner and the menu), or the design's <header> and <nav>.
      const headerSections: number[] = [];
      for (const s of sections) {
        const tag = s.tagName.toLowerCase();
        if (s.getBoundingClientRect().height <= 220 || tag === "header" || tag === "nav") headerSections.push(n(s));
        else break;
      }
      const last = sections[sections.length - 1];
      const footerSections = last && (last.tagName.toLowerCase() === "footer" || /©|copyright/i.test(last.innerText)) ? [n(last)] : [];
      const inHeader = sections.filter((s) => headerSections.includes(n(s)));
      // The menu: the row with the most short words side by side.
      const leaves = (roots: HTMLElement[]) =>
        roots.flatMap((r) => Array.from(r.querySelectorAll<HTMLElement>("*"))).filter((el) => {
          if (el.closest("[data-kit-icon]")) return false;
          const own = Array.from(el.childNodes).some((c) => c.nodeType === 3 && (c.textContent ?? "").trim());
          const r = el.getBoundingClientRect();
          return own && r.width > 0 && r.height > 0;
        });
      const words = leaves(inHeader).map((el) => ({ el, text: clean(el.innerText), r: el.getBoundingClientRect() })).filter((w) => w.text && w.text.length <= SHORT);
      const rows = new Map<number, typeof words>();
      for (const w of words) {
        const key = Math.round((w.r.top + w.r.height / 2) / 12);
        rows.set(key, [...(rows.get(key) ?? []), w]);
      }
      const menuRow = [...rows.values()].filter((r) => r.length >= 3).sort((a, b) => b.length - a.length)[0] ?? [];
      const menu = menuRow.sort((a, b) => a.r.left - b.r.left).map((w) => ({ label: w.text, dropdown: Boolean(w.el.querySelector("[data-kit-icon]") || w.el.nextElementSibling?.matches("[data-kit-icon]")) }));
      const menuEls = new Set(menuRow.map((w) => w.el));
      // The logo and the site's name.
      const logo = inHeader.flatMap((s) => Array.from(s.querySelectorAll("img"))).find((i) => i.getBoundingClientRect().width > 60)?.getAttribute("src") ?? null;
      // The tagline: the longest words in the header that aren't the menu.
      const rest = leaves(inHeader).filter((el) => !menuEls.has(el)).map((el) => clean(el.innerText)).filter(Boolean);
      // A short sentence (a name like "SampleHuskyLady" isn't one), the first in the header.
      const tagline = rest.find((t) => t.includes(" ") && t.length > 10 && t.length < 60) ?? null;
      const socials = inHeader.flatMap((s) => Array.from(s.querySelectorAll<HTMLElement>("[data-kit-icon]"))).filter((i) => i.getBoundingClientRect().width >= 24).map((i) => {
          const copy = i.cloneNode(false) as HTMLElement;
          copy.removeAttribute("style");
          copy.removeAttribute("data-m");
          return { html: copy.outerHTML, href: i.closest("a")?.getAttribute("href") ?? "#", label: i.getAttribute("aria-label") ?? "Social" };
        });
      // The footer's columns: a heading in capitals over three or more short lines.
      const footerRoot = footerSections.length ? sections[sections.length - 1]! : null;
      const columns: { title: string; links: string[] }[] = [];
      let note: string | null = null;
      if (footerRoot) {
        const lines = leaves([footerRoot]).map((el) => ({ el, text: clean(el.innerText), r: el.getBoundingClientRect() }));
        note = lines.find((l) => /©|copyright/i.test(l.text))?.text ?? null;
        const heads = lines.filter((l) => l.text.length <= SHORT && l.text === l.text.toUpperCase() && /[A-Z]/.test(l.text));
        for (const h of heads) {
          const under = lines
            .filter((l) => l !== h && Math.abs(l.r.left - h.r.left) < 24 && l.r.top > h.r.top && l.r.top - h.r.bottom < 260 && l.text.length <= SHORT * 2 && !heads.includes(l))
            .sort((a, b) => a.r.top - b.r.top);
          // A block of lines split by line breaks is several links.
          const links = under.flatMap((l) => l.el.innerText.split("\n").map(clean).filter(Boolean));
          if (links.length >= 2) columns.push({ title: h.text, links });
        }
      }
      const siteName = document.title.split(/[:|–-]/)[0]!.trim();
      const bg = inHeader.length ? getComputedStyle(inHeader[inHeader.length - 1]!).backgroundColor : "rgb(255,255,255)";
      const footerBg = footerRoot ? getComputedStyle(footerRoot).backgroundColor : bg;
      return { headerSections, footerSections, menu, logo, tagline, socials, columns, note, siteName, bg, footerBg };
    }, SHORT);
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const href = (label: string): string => {
      if (norm(label) === "home") return "/";
      const p = pages.find((x) => norm(x.name) === norm(label) || norm(x.slug.replace(/-/g, " ")) === norm(label));
      return p ? (p.slug ? `/${p.slug}/` : "/") : "#";
    };
    const menu: ShellLink[] = found.menu.map((m) => {
      const column = found.columns.find((c) => norm(c.title) === norm(m.label));
      return { label: m.label, href: href(m.label), children: m.dropdown || column ? column?.links.map((l) => ({ label: l, href: href(l) })) : undefined };
    });
    const dark = (rgb: string) => {
      const [r, g, b] = (rgb.match(/\d+/g) ?? ["255", "255", "255"]).map(Number);
      return 0.299 * r! + 0.587 * g! + 0.114 * b! < 128;
    };
    return {
      siteName: found.siteName || "Home",
      logo: found.logo,
      menu,
      tagline: found.tagline,
      socials: found.socials,
      footerColumns: found.columns.map((c) => ({ title: c.title, links: c.links.map((l) => ({ label: l, href: href(l) })) })),
      footerNote: found.note,
      legal,
      headerSections: found.headerSections,
      footerSections: found.footerSections,
      colors: { background: found.footerBg, ink: dark(found.footerBg) ? "#ffffff" : "#18212b", accent: dark(found.footerBg) ? "#9cc3ff" : "#1d4ed8" },
    };
  } finally {
    await context.close();
  }
}

/* The page's phone rules, and the page with the marks they use (pictures served by address, as in the kit repair). */
export async function phoneRules(browser: Browser, html: string, files: Map<string, { body: Buffer; contentType: string }> = new Map()): Promise<{ html: string; css: string }> {
  const context = await ownPageContext(browser, { viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await page.route(`${REPAIR_ASSET_HOST}**`, (route) => {
      const file = files.get(route.request().url());
      return file ? route.fulfill({ body: file.body, contentType: file.contentType }) : route.fulfill({ status: 404, body: "" });
    });
    await loadHtml(page, html);
    await fontsReady(page);
    return await page.evaluate(() => {
      let next = 0;
      const rules: string[] = ["body{min-width:0!important;overflow-x:hidden}", "img{max-width:100%!important;height:auto!important}"];
      const mark = (el: HTMLElement, css: string) => {
        if (!el.dataset.m) el.dataset.m = String(++next);
        rules.push(`[data-m="${el.dataset.m}"]{${css}}`);
      };
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== "none";
      };
      for (const root of Array.from(document.querySelectorAll<HTMLElement>("[data-figma-section]"))) {
        mark(root, "height:auto!important;min-height:0!important;padding:28px 16px!important;width:auto!important;max-width:100vw!important;overflow-x:clip!important");
        // One alignment for the section: the one most of its words use.
        let centred = 0, left = 0;
        root.querySelectorAll<HTMLElement>("*").forEach((el) => {
          const text = Array.from(el.childNodes).filter((c) => c.nodeType === 3).map((c) => c.textContent ?? "").join("").trim();
          if (!text || !visible(el)) return;
          const a = getComputedStyle(el).textAlign;
          if (a === "center") centred += text.length;
          else left += text.length;
        });
        const align = centred > left ? "center" : "left";
        rules.push(`[data-m="${root.dataset.m}"],[data-m="${root.dataset.m}"] *{text-align:${align}!important}`);
        const backdrop = root.querySelector<HTMLElement>("[data-kit-repair][aria-hidden]");
        if (backdrop && backdrop.getBoundingClientRect().width > root.getBoundingClientRect().width * 0.4) {
          mark(root, `background:${getComputedStyle(backdrop).backgroundColor}!important`);
        }
        for (const el of [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]) {
          if (el.closest("[data-kit-icon]") && !el.matches("[data-kit-icon]")) continue;
          if (!visible(el)) continue;
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const css: string[] = [];
          // A picture drawn as a background with nothing inside: full width at its own shape.
          if (el !== root && cs.backgroundImage !== "none" && el.children.length === 0 && !(el.textContent ?? "").trim() && r.width > 40) {
            mark(el, `width:100%!important;max-width:${Math.round(r.width)}px!important;height:auto!important;aspect-ratio:${Math.round(r.width)}/${Math.round(r.height)}!important;margin-left:auto!important;margin-right:auto!important`);
            continue;
          }
          if (el.matches("[data-kit-repair][aria-hidden]")) {
            mark(el, "display:none!important");
            continue;
          }
          const iconOverPhoto = el.matches("[data-kit-icon]") && cs.position === "absolute";
          if ((cs.position === "absolute" || cs.position === "fixed") && !iconOverPhoto) css.push("position:static!important;left:auto!important;top:auto!important;right:auto!important;bottom:auto!important;transform:none!important");
          if (el !== root && (el.style.height || (cs.height.endsWith("px") && parseFloat(cs.height) > 60 && el.children.length > 0 && el.tagName !== "IMG"))) css.push("height:auto!important;min-height:0!important");
          if (el !== root && r.width > 390 && el.tagName !== "IMG") css.push("width:auto!important;max-width:100%!important;margin-left:0!important;margin-right:0!important");
          if (el.tagName === "IMG") {
            const img = el as HTMLImageElement;
            // Never larger than the picture itself.
            css.push(`width:${Math.min(100, Math.round((img.naturalWidth / 358) * 100))}%!important;height:auto!important;max-width:100%!important`);
          }
          const kids = Array.from(el.children).filter((k) => visible(k) && getComputedStyle(k).position !== "absolute") as HTMLElement[];
          const sideBySide = kids.length >= 2 && kids.every((k, i) => i === 0 || Math.abs(k.getBoundingClientRect().top - kids[0]!.getBoundingClientRect().top) < 40);
          if ((cs.display.includes("flex") && cs.flexDirection.startsWith("row") && kids.length >= 2) || (cs.display.includes("grid") && sideBySide) || (sideBySide && cs.display === "block")) {
            const widths = kids.map((k) => k.getBoundingClientRect().width);
            const alike = widths.every((w) => Math.abs(w - widths[0]!) < widths[0]! * 0.35);
            if (kids.length >= 3 && alike && widths[0]! < 480) {
              css.push("display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:16px!important;flex-direction:initial!important");
              for (const k of kids) mark(k, "width:auto!important;min-width:0!important;max-width:100%!important;margin:0!important");
            } else if (widths.some((w) => w > 150)) {
              css.push(`display:flex!important;flex-direction:column!important;align-items:${align === "center" ? "center" : "stretch"}!important;gap:16px!important`);
              for (const k of kids) mark(k, "width:auto!important;max-width:100%!important;flex:none!important");
            }
          }
          const size = parseFloat(cs.fontSize);
          if (size > 36) css.push(`font-size:${Math.max(28, Math.round(size * 0.55))}px!important;line-height:1.15!important`);
          else if (size > 22) css.push(`font-size:${Math.round(size * 0.82)}px!important`);
          const buttonLike = el.matches("a,button,[class*='kit-button']") && (cs.backgroundColor !== "rgba(0, 0, 0, 0)" || parseFloat(cs.borderTopWidth) > 0);
          if (buttonLike) css.push("min-height:44px!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;white-space:normal!important;max-width:100%!important");
          if (css.length) mark(el, css.join(";"));
        }
      }
      const css = `@media (max-width:767px){\n${rules.join("\n")}\n}`;
      // The kit's styles and icons are filled in again when the page is put together.
      document.querySelectorAll("style[data-kit]").forEach((s) => s.remove());
      document.querySelectorAll("[data-kit-icon]").forEach((s) => (s.innerHTML = ""));
      return { html: `<!doctype html>\n${document.documentElement.outerHTML}`, css };
    });
  } finally {
    await context.close();
  }
}

export interface PhoneProblem {
  kind: "sideways scrolling" | "overlapping" | "cut off" | "small tap target" | "missing image" | "wrong font" | "low contrast";
  detail: string;
}

/* The phone check: the page drawn 390px wide and looked over. */
export async function phoneCheck(browser: Browser, html: string, fonts: string[] = [], width = 390): Promise<{ problems: PhoneProblem[]; shot: Buffer }> {
  const context = await ownPageContext(browser, { viewport: { width, height: 844 }, deviceScaleFactor: 1 }, [html]);
  try {
    const page = await context.newPage();
    // A page's address (a built site served locally), or the page itself.
    if (/^https?:\/\//.test(html)) await openPage(page, html);
    else await loadHtml(page, html);
    await fontsReady(page);
    const problems: PhoneProblem[] = await page.evaluate((fonts: string[]) => {
      const out: { kind: string; detail: string }[] = [];
      const say = (t: string) => `"${t.replace(/\s+/g, " ").trim().slice(0, 40)}"`;
      if (document.documentElement.scrollWidth > window.innerWidth + 1) out.push({ kind: "sideways scrolling", detail: `the page is ${document.documentElement.scrollWidth}px wide on a 390px screen` });
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        // A visually hidden element (a 1px clipped box, as a skip link is until it gets focus) isn't on the screen.
        const clipped = r.width <= 1 || r.height <= 1 || /inset\(50%\)/.test(s.clipPath) || /rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(s.clip);
        return r.width > 0 && r.height > 0 && !clipped && s.display !== "none" && s.visibility !== "hidden";
      };
      // A bar pinned to the screen (a sticky "Call ..." bar, a fixed header) sits over the page on purpose: it isn't a layout
      // fault, so it's left out of the overlap check (gap 9: the fixed call bar read as text on top of the stats strip).
      const pinned = (el: Element) => {
        for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
          const p = getComputedStyle(n).position;
          if (p === "fixed" || p === "sticky") return true;
        }
        return false;
      };
      const texts = Array.from(document.body.querySelectorAll<HTMLElement>("*")).filter((el) => visible(el) && Array.from(el.childNodes).some((c) => c.nodeType === 3 && (c.textContent ?? "").trim()) && !el.closest("details:not([open]) > :not(summary)"));
      const rects = texts.map((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return { el, rs: Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1), pinned: pinned(el) };
      });
      for (let i = 0; i < rects.length; i += 1) {
        for (let j = i + 1; j < rects.length; j += 1) {
          const a = rects[i]!, b = rects[j]!;
          if (a.el.contains(b.el) || b.el.contains(a.el) || a.pinned || b.pinned) continue;
          const hit = a.rs.some((ra) => b.rs.some((rb) => Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left) > 2 && Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top) > Math.min(ra.height, rb.height) * 0.4));
          if (hit) out.push({ kind: "overlapping", detail: `${say(a.el.innerText)} and ${say(b.el.innerText)}` });
        }
        const { el, rs } = rects[i]!;
        if (rs.some((r) => r.right > window.innerWidth + 2 || r.left < -2)) out.push({ kind: "cut off", detail: `${say(el.innerText)} runs off the screen` });
      }
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("a[href],button,summary"))) {
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.height < 43.5 && r.width < 43.5) out.push({ kind: "small tap target", detail: `${say(el.innerText || el.getAttribute("aria-label") || "a link")} is ${Math.round(r.width)}x${Math.round(r.height)}px (at least 44px)` });
        // A link that looks like a button (a fill or a border) must be 44px tall however it's laid out.
        else if (r.height < 43.5 && (getComputedStyle(el).display !== "inline" || getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)" || parseFloat(getComputedStyle(el).borderTopWidth) > 0)) out.push({ kind: "small tap target", detail: `${say(el.innerText || el.getAttribute("aria-label") || "a link")} is ${Math.round(r.height)}px tall (at least 44px)` });
      }
      // Only the page's own pictures: one from another site isn't loaded in TAWD's pictures, so it isn't judged.
      const own = (img: HTMLImageElement) => {
        try {
          const u = new URL(img.currentSrc || img.src, location.href);
          return u.protocol === "data:" || u.protocol === "blob:" || (location.origin !== "null" && u.origin === location.origin);
        } catch {
          return false;
        }
      };
      for (const img of Array.from(document.images)) if (visible(img) && img.complete && img.naturalWidth === 0 && own(img)) out.push({ kind: "missing image", detail: img.getAttribute("alt") || img.getAttribute("src")?.slice(0, 60) || "an image" });
      const ctx = document.createElement("canvas").getContext("2d")!;
      const usedFonts = new Set(texts.map((el) => getComputedStyle(el).fontFamily.split(",")[0]!.trim().replace(/^["']|["']$/g, "")));
      for (const f of usedFonts) {
        if (!fonts.length || !fonts.includes(f)) continue;
        const width = (font: string) => {
          ctx.font = font;
          return ctx.measureText("Handgloves 0123").width;
        };
        if (["monospace", "serif"].every((fb) => Math.abs(width(`40px "${f}", ${fb}`) - width(`40px ${fb}`)) <= 0.5)) out.push({ kind: "wrong font", detail: `${f} didn't load` });
      }
      return out as never;
    }, fonts);
    // One line per problem, the same ones once.
    const seen = new Set<string>();
    const unique = problems.filter((p) => {
      const key = `${p.kind}|${p.detail}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { problems: unique, shot: await page.screenshot({ fullPage: true }) };
  } finally {
    await context.close();
  }
}
