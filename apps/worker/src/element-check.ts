import type { Browser } from "playwright-core";

import { checkResult, type CheckResult, type SectionFindings, type SectionPlan } from "@tawd/core/style-kit/element-check";
import { ownPageContext } from "./locked-context";
import { fontsReady, loadHtml } from "./page-load";

/*
  The element check, in the browser (Jason, 28 September 2026): the copy is
  drawn 1440px wide and each section (its data-figma-section element) is
  searched for its kit items and its texts; every text's font is read back
  and checked as loaded; text cut off by its box, or lying over other text,
  is reported. Free, no AI.
*/
export async function runElementCheck(browser: Browser, html: string, plans: SectionPlan[]): Promise<CheckResult> {
  const context = await ownPageContext(browser, { viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await loadHtml(page, html);
    await fontsReady(page);
    const findings: SectionFindings[] = await page.evaluate((plans: SectionPlan[]) => {
      // Arrows and hearts are drawn as icons by the kit; a line break counts as a space.
      const norm = (t: string) => t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[→←♡❤]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
      const visible = (el: Element) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0.05 && r.width > 0 && r.height > 0;
      };
      /* The smallest element in the section whose own text contains the words. */
      const holder = (root: Element, text: string): HTMLElement | null => {
        const want = norm(text);
        let best: HTMLElement | null = null;
        root.querySelectorAll<HTMLElement>("*").forEach((el) => {
          if (!visible(el) || !norm(el.innerText ?? "").includes(want)) return;
          if (!best || best.contains(el)) best = el;
        });
        return best;
      };
      const textRects = (el: Element) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1);
      };
      /* Whether the element's text runs outside a clipping box around it (or off the page). */
      const clipped = (el: Element): boolean => {
        const rects = textRects(el);
        if (rects.length === 0) return false;
        let node: Element | null = el;
        while (node && node !== document.body) {
          const s = getComputedStyle(node);
          if (/(hidden|clip)/.test(s.overflowX + s.overflowY)) {
            const box = node.getBoundingClientRect();
            if (rects.some((r) => r.left < box.left - 2 || r.right > box.right + 2 || r.top < box.top - 2 || r.bottom > box.bottom + 2)) return true;
          }
          node = node.parentElement;
        }
        return rects.some((r) => r.left < -2 || r.right > document.documentElement.clientWidth + 2);
      };
      return plans.map((plan) => {
        const root = document.querySelector(`[data-figma-section="${plan.number}"]`);
        if (!root) return { number: plan.number, found: {}, texts: [], clipped: [], overlaps: [] };
        const found: Record<string, number> = {};
        for (const item of plan.items) found[item.selector] = Array.from(root.querySelectorAll(item.selector)).filter(visible).length;
        const texts = plan.texts.map((t) => {
          const el = holder(root, t.text);
          if (!el) return { id: t.id, present: false, family: null, loaded: false };
          const s = getComputedStyle(el);
          const first = s.fontFamily.split(",")[0]!.trim().replace(/^["']|["']$/g, "");
          // In use if the words come out a different width than in a fallback font (a font that didn't load falls back).
          const ctx = document.createElement("canvas").getContext("2d")!;
          const sample = (el.textContent ?? "").trim().slice(0, 60) || "Handgloves";
          const width = (font: string) => {
            ctx.font = font;
            return ctx.measureText(sample).width;
          };
          const loaded = ["monospace", "serif"].some((fallback) => Math.abs(width(`${s.fontWeight} 40px "${first}", ${fallback}`) - width(`${s.fontWeight} 40px ${fallback}`)) > 0.5);
          return { id: t.id, present: true, family: first, loaded };
        });
        const cut: string[] = [];
        const overlaps: [string, string][] = [];
        const placed: { label: string; rects: DOMRect[]; el: Element }[] = [];
        plan.texts.forEach((t) => {
          const el = holder(root, t.text);
          if (!el) return;
          const label = `the text "${t.text.length > 40 ? `${t.text.slice(0, 39)}…` : t.text}"`;
          if (clipped(el)) cut.push(label);
          placed.push({ label, rects: textRects(el), el });
        });
        for (let i = 0; i < placed.length; i += 1) {
          for (let j = i + 1; j < placed.length; j += 1) {
            const a = placed[i]!, b = placed[j]!;
            if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
            const hit = a.rects.some((ra) =>
              b.rects.some((rb) => {
                const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
                const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
                // Line boxes of big lettering touch without the letters meeting: count a real share of the height.
                return w > 2 && h > Math.min(ra.height, rb.height) * 0.4 && w * h > Math.min(ra.width * ra.height, rb.width * rb.height) * 0.15;
              }),
            );
            if (hit) overlaps.push([a.label, b.label]);
          }
        }
        return { number: plan.number, found, texts, clipped: cut, overlaps };
      });
    }, plans);
    return checkResult(plans, findings);
  } finally {
    await context.close();
  }
}
