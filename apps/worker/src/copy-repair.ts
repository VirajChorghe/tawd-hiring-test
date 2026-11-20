import type { Browser } from "playwright-core";

import type { SectionInventory } from "@tawd/core/style-kit/elements";
import type { StyleKit } from "@tawd/core/style-kit/kit";
import { ownPageContext } from "./locked-context";
import { fontsReady, loadHtml } from "./page-load";

/*
  The kit repair (Jason, 29 September 2026): an existing copy made right
  with the style kit by code, for $0, instead of paying the AI again. On
  the copy as the browser draws it, each item of each section's inventory
  is put in place:
  - lettering: every text of the design set in the kit's font for its kind;
  - ribbons and buttons: found by their words, given the kit's class;
  - panels, cards and bordered boxes: the element that covers the design's
    area gets the kit's class, else a backdrop is drawn behind the section
    at that place (a box's title is set into its border);
  - icons: an icon picture cut from the design is swapped for the kit's
    vector, a play button goes over its photo, and any other icon goes
    beside its nearest words (or at its place when there are none);
  - text cut off by a box that clips it is let out.
  Dividers are left as they are (minor lines). What can't be placed is
  reported by name; the worker then measures the page again and keeps each
  section only if it didn't get worse.
*/

export interface RepairItem {
  id: string;
  kind: "panel" | "card" | "box" | "button" | "ribbon" | "icon";
  /** The kit class or icon marker. */
  ref: string;
  label: string;
  /** In the design's pixels, from the top of its section. */
  box: { x: number; y: number; w: number; h: number };
  text?: string;
  /** The part's CSS (for classes), inline so it wins over the copy's own styles. */
  css?: string;
  frame?: "ring" | "disc" | null;
  group?: string | null;
  /** For a box: the texts inside it (to find the element around them) and its title. */
  inside?: string[];
  /** For an icon: the words it sits beside in the design, and on which side. */
  anchor?: { text: string; before: boolean } | null;
  title?: string | null;
}

export interface RepairSection {
  number: number;
  name: string;
  /** The design section's height and the page's width, for placing by position. */
  designHeight: number;
  designWidth: number;
  items: RepairItem[];
  texts: { text: string; role: string }[];
}

export interface RepairReport {
  placed: { section: number; label: string; how: string }[];
  notPlaced: { section: number; label: string; why: string }[];
  fonts: number;
  unclipped: number;
}

const KIND_WORDS: Record<string, string> = { panel: "the coloured panel", card: "the card", box: "the bordered box", button: "the button", ribbon: "the ribbon" };

/* What to put in place, section by section, from the kit and the page's inventory (dividers left out). */
export function repairPlan(kit: StyleKit, sections: { number: number; name: string; inventory: SectionInventory }[], designWidth: number): RepairSection[] {
  return sections.map(({ number, name, inventory }) => {
    const texts = inventory.elements.filter((e): e is Extract<typeof e, { kind: "text" }> => e.kind === "text");
    const items: RepairItem[] = [];
    for (const e of inventory.elements) {
      const ref = kit.map[e.id];
      if (!ref) continue;
      const box = { x: e.box.x, y: e.box.y - inventory.top, w: e.box.w, h: e.box.h };
      const part = kit.parts.find((p) => p.className === ref);
      if (e.kind === "panel" || e.kind === "card") items.push({ id: e.id, kind: e.kind, ref, label: `${KIND_WORDS[e.kind]} (${ref})`, box, css: part?.css });
      else if (e.kind === "box") {
        const inside = texts.filter((t) => t.box.x + t.box.w / 2 > e.box.x && t.box.x + t.box.w / 2 < e.box.x + e.box.w && t.box.y + t.box.h / 2 > e.box.y - 30 && t.box.y + t.box.h / 2 < e.box.y + e.box.h);
        const title = e.titleGap ? inside.find((t) => Math.abs(t.box.y + t.box.h / 2 - e.box.y) < 30 && t.box.x + t.box.w / 2 > e.titleGap!.from && t.box.x + t.box.w / 2 < e.titleGap!.to) : undefined;
        items.push({ id: e.id, kind: "box", ref, label: `${KIND_WORDS.box} (${ref})`, box, css: part?.css, inside: inside.map((t) => t.text), title: title?.text ?? null });
      } else if (e.kind === "button" || e.kind === "ribbon") items.push({ id: e.id, kind: e.kind, ref, label: `${KIND_WORDS[e.kind]} "${e.text}" (${ref})`, box, text: e.text, css: part?.css });
      else if (e.kind === "icon") {
        const icon = kit.icons.find((i) => i.ref === ref);
        // The words beside it in the design: on its line, close by (or the words of the button or ribbon it is on).
        const cy = e.box.y + e.box.h / 2;
        let anchor: RepairItem["anchor"] = null;
        let gap = Math.max(3 * e.box.w, 60);
        for (const t of texts) {
          if (cy < t.box.y - e.box.h * 0.4 || cy > t.box.y + t.box.h + e.box.h * 0.4) continue;
          const before = e.box.x + e.box.w / 2 < t.box.x + t.box.w / 2;
          const d = before ? t.box.x - (e.box.x + e.box.w) : e.box.x - (t.box.x + t.box.w);
          if (d < gap) {
            gap = Math.max(d, -1e6);
            anchor = { text: t.text, before };
          }
        }
        items.push({ id: e.id, kind: "icon", ref, label: `the ${icon?.label === "icon from the design" ? "icon" : `${icon?.label} icon`} (${ref})`, box, frame: icon?.frame ?? null, group: e.group, anchor });
      }
    }
    return { number, name, designHeight: inventory.height, designWidth, items, texts: texts.map((t) => ({ text: t.text, role: t.role })) };
  });
}

/* Where the page's pictures are served from during a repair, so the page itself stays small. */
export const REPAIR_ASSET_HOST = "https://tawd-asset.invalid/";

/*
  Puts the kit's items into the copy, in the browser; returns the page and
  what was done. The page's pictures are addresses under REPAIR_ASSET_HOST,
  answered from `files` (a copy with its pictures inside runs to many
  megabytes, too much to pass back out of the browser).
*/
export async function repairInBrowser(
  browser: Browser,
  html: string,
  plan: RepairSection[],
  files: Map<string, { body: Buffer; contentType: string }> = new Map(),
): Promise<{ html: string; report: RepairReport }> {
  const context = await ownPageContext(browser, { viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await page.route(`${REPAIR_ASSET_HOST}**`, (route) => {
      const file = files.get(route.request().url());
      return file ? route.fulfill({ body: file.body, contentType: file.contentType }) : route.fulfill({ status: 404, body: "" });
    });
    await loadHtml(page, html);
    await fontsReady(page);
    const report = await page.evaluate((plan: RepairSection[]) => {
      const placed: RepairReport["placed"] = [];
      const notPlaced: RepairReport["notPlaced"] = [];
      let fonts = 0;
      let unclipped = 0;
      const norm = (t: string) => t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[→←♡❤]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
      };
      const pageRect = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height };
      };
      type R = { x: number; y: number; w: number; h: number };
      const iou = (a: R, b: R) => {
        const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (w <= 0 || h <= 0) return 0;
        return (w * h) / (a.w * a.h + b.w * b.h - w * h);
      };
      /* The smallest visible element in root whose text holds the words (as shown: a line break counts as a space). */
      const holder = (root: Element, text: string): HTMLElement | null => {
        const want = norm(text);
        if (!want) return null;
        let best: HTMLElement | null = null;
        root.querySelectorAll<HTMLElement>("*").forEach((el) => {
          if (el.closest("[data-kit-icon]") || !visible(el) || !norm(el.innerText ?? "").includes(want)) return;
          if (!best || best.contains(el)) best = el;
        });
        return best;
      };
      const addStyle = (el: HTMLElement, css: string | undefined) => {
        if (!css) return;
        el.setAttribute("style", `${el.getAttribute("style") ?? ""};${css}`.replace(/^;/, ""));
      };
      const iconSpan = (item: RepairItem, size: number, extra = "") =>
        `<span data-kit-icon="${item.ref}"${item.frame ? ` data-kit-frame="${item.frame}"` : ""} data-kit-repair="1" style="font-size:${Math.max(10, Math.round(item.frame ? size / 2 : size))}px;${extra}"></span>`;
      const backdrop = (root: HTMLElement, rootRect: R, target: R, cls: string, css: string | undefined) => {
        if (getComputedStyle(root).position === "static") root.style.position = "relative";
        root.style.isolation = "isolate";
        const left = ((target.x - rootRect.x) / rootRect.w) * 100;
        const width = (target.w / rootRect.w) * 100;
        root.insertAdjacentHTML(
          "afterbegin",
          // nosemgrep: typescript.react.security.audit.react-unsanitized-method.react-unsanitized-method -- the worker's own headless page; class and style are built by code from the style kit, never from page text
          `<div class="${cls}" aria-hidden="true" data-kit-repair="1" style="${css ?? ""};position:absolute;left:${left.toFixed(2)}%;width:${width.toFixed(2)}%;top:${Math.round(target.y - rootRect.y)}px;height:${Math.round(target.h)}px;z-index:-1;pointer-events:none;min-height:0;padding:0"></div>`,
        );
      };

      for (const section of plan) {
        const root = document.querySelector<HTMLElement>(`[data-figma-section="${section.number}"]`);
        if (!root) {
          for (const item of section.items) notPlaced.push({ section: section.number, label: item.label, why: "the section isn't in the copy" });
          continue;
        }
        const rootRect = pageRect(root);
        const sx = rootRect.w / section.designWidth;
        const sy = rootRect.h / Math.max(1, section.designHeight);
        const map = (b: R): R => ({ x: rootRect.x + b.x * sx, y: rootRect.y + b.y * sy, w: b.w * sx, h: b.h * sy });

        // Lettering in the kit's fonts.
        for (const t of section.texts) {
          const el = holder(root, t.text);
          if (!el) continue;
          el.style.fontFamily = `var(--kit-font-${t.role})`;
          fonts += 1;
        }

        for (const item of section.items) {
          const target = map(item.box);
          if (item.kind === "ribbon" || item.kind === "button") {
            let el = holder(root, item.text ?? "");
            if (!el) {
              notPlaced.push({ section: section.number, label: item.label, why: "its words aren't in the copy" });
              continue;
            }
            if (item.kind === "button") {
              const link = el.closest("a,button");
              if (link && root.contains(link)) el = link as HTMLElement;
            }
            // A word inside a wide block gets its own span, so the ribbon or button fits the word.
            if (pageRect(el).w > target.w * 2) {
              el.innerHTML = `<span>${el.innerHTML}</span>`;
              el = el.firstElementChild as HTMLElement;
            }
            el.classList.add(item.ref);
            addStyle(el, item.css);
            placed.push({ section: section.number, label: item.label, how: "on its words" });
            continue;
          }
          if (item.kind === "panel" || item.kind === "card" || item.kind === "box") {
            let el: HTMLElement | null = null;
            if (item.kind === "box" && item.inside?.length) {
              // The element around all the box's texts.
              const holders: HTMLElement[] = [];
              for (const t of item.inside) {
                const h = holder(root, t);
                if (h) holders.push(h);
              }
              if (holders.length) {
                let common: HTMLElement | null = holders[0]!;
                while (common && !holders.every((h: HTMLElement) => common!.contains(h))) common = common.parentElement as HTMLElement | null;
                if (common && root.contains(common) && iou(pageRect(common), target) >= 0.35) el = common;
              }
            }
            if (!el) {
              let best = 0;
              [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))].forEach((c) => {
                if (!visible(c) || c.closest("[data-kit-repair]")) return;
                const score = iou(pageRect(c), target);
                if (score > best) {
                  best = score;
                  el = c;
                }
              });
              if (best < 0.6) el = null;
            }
            if (el && !(el as HTMLElement).dataset.kitRepair && el !== root) {
              const e = el as HTMLElement;
              e.classList.add(item.ref);
              addStyle(e, item.css);
              if (item.kind === "box" && item.title) {
                const title = holder(e, item.title);
                if (title) {
                  title.classList.add("kit-box-title");
                  e.style.paddingTop = `${Math.max(parseFloat(getComputedStyle(e).paddingTop) || 0, 36)}px`;
                }
              }
              placed.push({ section: section.number, label: item.label, how: "on the element that covers it" });
            } else {
              backdrop(root, rootRect, target, item.ref, item.css);
              if (item.kind === "box" && item.title) {
                const title = holder(root, item.title);
                if (title) {
                  title.style.position = "relative";
                  title.style.background = "var(--kit-title-bg,#fff)";
                  title.style.width = "max-content";
                  title.style.marginLeft = "auto";
                  title.style.marginRight = "auto";
                  title.style.padding = "0 24px";
                }
              }
              placed.push({ section: section.number, label: item.label, how: "drawn behind the section at its place" });
            }
            continue;
          }
          // Icons.
          const cx = target.x + target.w / 2, cy = target.y + target.h / 2;
          const pictures = Array.from(root.querySelectorAll<HTMLElement>("img,svg:not([data-kit-icon] svg)")).filter((p) => visible(p) && !p.closest("[data-kit-icon]"));
          const cut = pictures.find((p) => {
            const r = pageRect(p);
            return iou(r, target) >= 0.3 && r.w * r.h <= target.w * target.h * 4;
          });
          if (cut) {
            cut.insertAdjacentHTML("beforebegin", iconSpan(item, pageRect(cut).h));
            cut.remove();
            placed.push({ section: section.number, label: item.label, how: "in place of the picture cut from the design" });
            continue;
          }
          if (item.group === "play over a photo") {
            const photo = pictures.find((p) => {
              const r = pageRect(p);
              return cx > r.x && cx < r.x + r.w && cy > r.y && cy < r.y + r.h;
            });
            if (photo?.parentElement) {
              const parent = photo.parentElement;
              if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
              const pr = pageRect(parent);
              parent.insertAdjacentHTML("beforeend", iconSpan(item, target.h, `position:absolute;left:${Math.round(cx - pr.x - target.w / 2)}px;top:${Math.round(cy - pr.y - target.h / 2)}px;`));
              placed.push({ section: section.number, label: item.label, how: "over its photo" });
              continue;
            }
          }
          // Beside the words it sits beside in the design.
          const words = item.anchor ? holder(root, item.anchor.text) : null;
          if (words && item.anchor) {
            words.insertAdjacentHTML(item.anchor.before ? "afterbegin" : "beforeend", iconSpan(item, target.h, item.anchor.before ? "margin-right:0.4em;" : "margin-left:0.4em;"));
            placed.push({ section: section.number, label: item.label, how: `${item.anchor.before ? "before" : "after"} "${item.anchor.text}"` });
            continue;
          }
          if (getComputedStyle(root).position === "static") root.style.position = "relative";
          root.insertAdjacentHTML("beforeend", iconSpan(item, target.h, `position:absolute;left:${((target.x - rootRect.x) / rootRect.w * 100).toFixed(2)}%;top:${Math.round(target.y - rootRect.y)}px;`));
          placed.push({ section: section.number, label: item.label, how: "at its place" });
        }

        // Text cut off by a box that clips it: let it out.
        root.querySelectorAll<HTMLElement>("*").forEach((el) => {
          if (!Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim())) return;
          const range = document.createRange();
          range.selectNodeContents(el);
          const rects = Array.from(range.getClientRects());
          let node: HTMLElement | null = el;
          while (node && node !== root.parentElement) {
            const s = getComputedStyle(node);
            if (/(hidden|clip)/.test(s.overflowX + s.overflowY) && node !== document.body) {
              const b = node.getBoundingClientRect();
              if (rects.some((r) => r.right > b.right + 2 || r.bottom > b.bottom + 2 || r.left < b.left - 2 || r.top < b.top - 2)) {
                node.style.overflow = "visible";
                if (s.height !== "auto") {
                  node.style.minHeight = s.height;
                  node.style.height = "auto";
                }
                unclipped += 1;
              }
            }
            node = node.parentElement;
          }
        });
      }
      return { placed, notPlaced, fonts, unclipped };
    }, plan);
    // The kit's styles and icons are filled in again when the page is put together: leave them out here.
    const out = await page.evaluate(() => {
      document.querySelectorAll("style[data-kit]").forEach((s) => s.remove());
      document.querySelectorAll("[data-kit-icon]").forEach((s) => (s.innerHTML = ""));
      return `<!doctype html>\n${document.documentElement.outerHTML}`;
    });
    return { html: out, report };
  } finally {
    await context.close();
  }
}

/* The repaired page with some sections put back as they were (the ones that came out worse). */
export async function keepSectionsFrom(browser: Browser, repaired: string, original: string, numbers: number[]): Promise<string> {
  if (numbers.length === 0) return repaired;
  const context = await ownPageContext(browser);
  try {
    const page = await context.newPage();
    return await page.evaluate(
      ({ repaired, original, numbers }) => {
        const parser = new DOMParser();
        const a = parser.parseFromString(repaired, "text/html");
        const b = parser.parseFromString(original, "text/html");
        for (const n of numbers) {
          const mine = a.querySelector(`[data-figma-section="${n}"]`);
          const theirs = b.querySelector(`[data-figma-section="${n}"]`);
          if (mine && theirs) mine.replaceWith(a.importNode(theirs, true));
        }
        return `<!doctype html>\n${a.documentElement.outerHTML}`;
      },
      { repaired, original, numbers },
    );
  } finally {
    await context.close();
  }
}
