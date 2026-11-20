import type { Browser } from "playwright-core";
import { ownPageContext } from "./locked-context";

/*
  Tidying the copies' words and links (Jason, 29 September 2026), by code,
  $0, on each page's source:
  - words the design read got wrong on a "MEET <NAME>" button ("MEET RANS")
    are set from the name in the same card ("MEET DAKOTA");
  - Terms of Use and Disclaimer come out of the footer (the site uses
    TAWD's privacy and cookie pages), and Contact comes out of the menus
    and link lists (no contact page; the details go in the footer and
    About);
  - every link is pointed at its page where its words say which ("MEET
    MEEKO", "WATCH MORE VIDEOS", a menu item with a page's name); the
    rest are reported, with what they could point to.
*/

export interface TidyPage {
  name: string;
  path: string;
}

export interface TidyInput {
  /** The site's pages (name and path, "/" for home). */
  pages: TidyPage[];
  /** Names a "MEET <NAME>" button can have (the dogs), beyond the pages. */
  names: string[];
  /** Where the privacy and cookie pages are. */
  privacyPath: string;
  cookiePath: string;
  /** Link words that point somewhere other than a page of the same name. */
  extraLinks: { match: string; path: string }[];
}

export interface TidyReport {
  changes: string[];
  /** Links whose words don't say where they go, with the page (if any) they could go to. */
  unresolved: { text: string; suggestion: string | null }[];
}

export async function tidyPage(browser: Browser, html: string, input: TidyInput): Promise<{ html: string; report: TidyReport }> {
  const context = await ownPageContext(browser);
  try {
    const page = await context.newPage();
    return await page.evaluate(
      ({ html, input }) => {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const changes: string[] = [];
        const unresolved: { text: string; suggestion: string | null }[] = [];
        const norm = (t: string) => t.replace(/[→←]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
        const words = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
        // The names: the pages', the ones given, and the words on the kit's ribbons (the sample client's dogs).
        // Also the short labels the builder named its own way ("…-ribbon", "…-name", "…-badge"): one or two words, no "meet".
        const ribbonNames = Array.from(doc.querySelectorAll("[class*='kit-ribbon'], [class*='ribbon' i], [class*='name' i], [class*='badge' i]"))
          .filter((r) => !r.querySelector("a, p, h1, h2, h3"))
          .map((r) => words(r))
          .filter((t) => t && t.length < 30 && t.split(" ").length <= 2 && !/^meet\b/i.test(t));
        const names = [...new Set([...input.names, ...ribbonNames, ...input.pages.map((p) => p.name)].map((n) => n.trim()).filter(Boolean))];
        const leaves = () => Array.from(doc.body.querySelectorAll<HTMLElement>("*")).filter((el) => Array.from(el.childNodes).some((c) => c.nodeType === 3 && (c.textContent ?? "").trim()));
        const setWords = (el: Element, to: string) => {
          const nodes: Text[] = [];
          const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n.textContent ?? "").trim()) nodes.push(n as Text);
          if (!nodes.length) return;
          nodes[0]!.textContent = to;
          for (const n of nodes.slice(1)) n.textContent = "";
        };

        // "MEET <NAME>" buttons: the name must be one of the names; else the name in the same card.
        for (const el of leaves()) {
          const m = /^meet\s+(.+)$/i.exec(words(el));
          if (!m) continue;
          const said = m[1]!.trim();
          if (/^the\b/i.test(said) || names.some((n) => norm(n) === norm(said))) continue;
          // The smallest card around the button with exactly one name in it.
          let card: Element | null = el.parentElement;
          let found: string | null = null;
          while (card && card !== doc.body) {
            const inside = names.filter((n) => Array.from(card!.querySelectorAll("*")).some((c) => c !== el && !c.contains(el) && norm(words(c)) === norm(n)));
            if (inside.length === 1) {
              found = inside[0]!;
              break;
            }
            if (inside.length > 1) break;
            card = card.parentElement;
          }
          if (!found) continue;
          const upper = said === said.toUpperCase();
          const before = words(el);
          const arrow = /\s*[→›»]\s*$/.exec(said)?.[0] ?? "";
          const fixed = `${before.slice(0, before.length - said.length)}${upper ? found.toUpperCase() : found}${arrow}`;
          setWords(el, fixed);
          changes.push(`"${before}" -> "${fixed}" (the name in the same card)`);
        }

        // Terms of Use and Disclaimer out; Privacy points at TAWD's page and Cookies joins it.
        for (const el of leaves()) {
          const t = norm(words(el));
          if (t === "terms of use" || t === "terms of service" || t === "terms & conditions" || t === "terms and conditions" || t === "disclaimer") {
            const target = el.closest("a") ?? el;
            // A separator next to it ("|") goes too.
            const prev = target.previousSibling;
            if (prev && prev.nodeType === 3 && /^\s*[|·•]\s*$/.test(prev.textContent ?? "")) prev.remove();
            const prevEl = target.previousElementSibling;
            if (prevEl && /^\s*[|·•]\s*$/.test(prevEl.textContent ?? "")) prevEl.remove();
            target.remove();
            changes.push(`Removed "${words(el)}" from the footer`);
          }
        }
        for (const el of leaves()) {
          if (norm(words(el)) !== "privacy policy") continue;
          const link = el.closest("a") ?? el;
          if (link.tagName === "A") link.setAttribute("href", input.privacyPath);
          else {
            const a = doc.createElement("a");
            a.setAttribute("href", input.privacyPath);
            link.replaceWith(a);
            a.appendChild(link);
          }
          if (!Array.from(doc.querySelectorAll("a")).some((a) => a.getAttribute("href") === input.cookiePath)) {
            const cookie = doc.createElement("a");
            cookie.setAttribute("href", input.cookiePath);
            cookie.textContent = "Cookie Policy";
            const holder = el.closest("a") ?? el;
            holder.insertAdjacentText("afterend", "  |  ");
            holder.parentNode?.insertBefore(cookie, holder.nextSibling?.nextSibling ?? null);
          }
          changes.push("The footer links TAWD's privacy and cookie pages");
        }

        // Contact out of the menus and link lists (no contact page).
        const hasContact = input.pages.some((p) => norm(p.name) === "contact");
        if (!hasContact) {
          for (const el of leaves()) {
            if (norm(words(el)) !== "contact") continue;
            const item = el.closest("li") ?? el.closest("a") ?? el;
            // In a line of links separated by <br>, take the line break with it.
            if (item.nextSibling && (item.nextSibling as Element).tagName === "BR") (item.nextSibling as Element).remove();
            else if (item.previousSibling && (item.previousSibling as Element).tagName === "BR") (item.previousSibling as Element).remove();
            item.remove();
            changes.push('Removed "Contact" (there is no contact page)');
          }
          // A text node "Contact" inside a list of lines (Home<br>...<br>Contact).
          const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
          const drop: Text[] = [];
          for (let n = walker.nextNode(); n; n = walker.nextNode()) if (norm(n.textContent ?? "") === "contact") drop.push(n as Text);
          for (const n of drop) {
            const br = n.previousSibling && (n.previousSibling as Element).tagName === "BR" ? n.previousSibling : n.nextSibling && (n.nextSibling as Element).tagName === "BR" ? n.nextSibling : null;
            br?.remove();
            n.remove();
            changes.push('Removed "Contact" (there is no contact page)');
          }
        }

        // Links: pointed at the page their words name.
        const pathFor = (text: string): string | null => {
          const t = norm(text);
          if (!t) return null;
          if (t === "home") return "/";
          const extra = input.extraLinks.find((x) => x.path !== "remove" && t.includes(norm(x.match)));
          if (extra) return extra.path;
          const exact = input.pages.find((p) => norm(p.name) === t);
          if (exact) return exact.path;
          const meet = /^meet\s+(.+)$/.exec(t);
          if (meet) {
            const p = input.pages.find((x) => norm(x.name) === meet[1] || norm(x.name) === `the ${meet[1]}` || (meet[1] === "the whole pack" && /pack/.test(norm(x.name))));
            if (p) return p.path;
          }
          const within = input.pages.filter((p) => p.path !== "/" && t.includes(norm(p.name)));
          if (within.length === 1) return within[0]!.path;
          return null;
        };
        // Links the team chose to take out ("remove").
        const removals = input.extraLinks.filter((x) => x.path === "remove").map((x) => norm(x.match));
        for (const el of Array.from(doc.body.querySelectorAll<HTMLElement>("a, button"))) {
          if (removals.includes(norm(words(el)))) {
            changes.push(`Removed the link "${words(el)}"`);
            el.remove();
          }
        }
        const linkish = Array.from(doc.body.querySelectorAll<HTMLElement>("a, button, li"));
        for (const el of linkish) {
          if (el.tagName === "LI" && el.querySelector("a")) continue;
          const text = words(el);
          if (!text || text.length > 60) continue;
          const href = el.getAttribute("href");
          if (el.tagName === "A" && href && href !== "#" && !href.startsWith("javascript")) continue;
          const path = pathFor(text);
          if (path) {
            if (el.tagName === "A") el.setAttribute("href", path);
            else {
              const a = doc.createElement("a");
              a.setAttribute("href", path);
              a.innerHTML = el.innerHTML;
              if (el.tagName === "LI") {
                el.innerHTML = "";
                el.appendChild(a);
              } else {
                for (const attr of Array.from(el.attributes)) a.setAttribute(attr.name, attr.value);
                a.setAttribute("href", path);
                el.replaceWith(a);
              }
            }
          } else if (el.tagName === "A" || el.tagName === "BUTTON") {
            unresolved.push({ text, suggestion: input.pages.find((p) => norm(text).split(" ").some((w) => w.length > 3 && norm(p.name).includes(w)))?.path ?? null });
          }
        }
        return { html: `<!doctype html>\n${doc.documentElement.outerHTML}`, report: { changes, unresolved } };
      },
      { html, input },
    );
  } finally {
    await context.close();
  }
}
