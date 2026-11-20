/*
  The shared phone header and footer (Jason, 29 September 2026, Batch 2):
  on a phone every page gets the same header (the logo on the left, a menu
  button on the right, about 60px tall), with the menu holding the pages,
  each submenu inside it, the current page marked, and the tagline and the
  social icons at its foot; and the same footer, its link columns folding
  open one at a time. Built from the home page's own header and footer,
  with no script (the menu and the columns are <details>), and hidden on
  a computer, where the design's own header and footer show.
*/

export interface ShellLink {
  label: string;
  href: string;
  children?: ShellLink[];
}

export interface ShellData {
  siteName: string;
  /** The logo's src (a tawd-asset token or a file path), or null for the name in words. */
  logo: string | null;
  menu: ShellLink[];
  tagline: string | null;
  /** Each social icon's markup (a kit icon marker) and where it goes. */
  socials: { html: string; href: string; label: string }[];
  footerColumns: { title: string; links: ShellLink[] }[];
  /** The last line of the footer (the copyright). */
  footerNote: string | null;
  /** The legal pages, at the very end (TAWD's privacy and cookie pages). */
  legal: ShellLink[];
  /** The design's sections that make up its header and footer, hidden on a phone. */
  headerSections: number[];
  footerSections: number[];
  colors: { background: string; ink: string; accent: string };
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function isCurrent(link: ShellLink, current: string): boolean {
  const norm = (h: string) => h.replace(/\/+$/, "") || "/";
  return norm(link.href) === norm(current);
}

function menuItems(links: ShellLink[], current: string): string {
  return links
    .map((link) => {
      if (link.children?.length) {
        const open = link.children.some((c) => isCurrent(c, current)) || isCurrent(link, current);
        return `<li><details class="tawd-m-sub"${open ? " open" : ""}><summary${isCurrent(link, current) ? ' aria-current="page"' : ""}>${esc(link.label)}</summary><ul>${
          link.href && link.href !== "#" ? `<li><a href="${esc(link.href)}"${isCurrent(link, current) ? ' aria-current="page"' : ""}>All of ${esc(link.label)}</a></li>` : ""
        }${menuItems(link.children, current)}</ul></details></li>`;
      }
      return `<li><a href="${esc(link.href)}"${isCurrent(link, current) ? ' aria-current="page"' : ""}>${esc(link.label)}</a></li>`;
    })
    .join("");
}

export function phoneShellHtml(data: ShellData, current: string): { header: string; footer: string } {
  const brand = data.logo ? `<img src="${esc(data.logo)}" alt="${esc(data.siteName)}">` : `<span>${esc(data.siteName)}</span>`;
  const socials = data.socials.length
    ? `<p class="tawd-m-social">${data.socials.map((s) => `<a href="${esc(s.href)}" aria-label="${esc(s.label)}">${s.html}</a>`).join("")}</p>`
    : "";
  const header = `<header class="tawd-m-header" aria-label="Site"><a class="tawd-m-brand" href="/">${brand}</a><details class="tawd-m-menu"><summary aria-label="Menu"><span class="tawd-m-burger" aria-hidden="true"></span></summary><nav aria-label="Main"><ul>${menuItems(data.menu, current)}</ul>${
    data.tagline ? `<p class="tawd-m-tagline">${esc(data.tagline)}</p>` : ""
  }${socials}</nav></details></header>`;
  const columns = data.footerColumns
    .map((c) => `<details class="tawd-m-col"><summary>${esc(c.title)}</summary><ul>${c.links.map((l) => `<li><a href="${esc(l.href)}"${isCurrent(l, current) ? ' aria-current="page"' : ""}>${esc(l.label)}</a></li>`).join("")}</ul></details>`)
    .join("");
  const legal = data.legal.length ? `<p class="tawd-m-legal">${data.legal.map((l) => `<a href="${esc(l.href)}">${esc(l.label)}</a>`).join("")}</p>` : "";
  const footer = `<footer class="tawd-m-footer" aria-label="Site"><a class="tawd-m-brand" href="/">${brand}</a>${columns}${socials}${data.footerNote ? `<p class="tawd-m-note">${esc(data.footerNote)}</p>` : ""}${legal}</footer>`;
  return { header, footer };
}

/* The phone header and footer's styles: shown under 768px only, where the design's header and footer sections are hidden. */
export function phoneShellCss(data: ShellData): string {
  const hide = [...data.headerSections, ...data.footerSections].map((n) => `[data-figma-section="${n}"]`).join(",");
  const { background, ink, accent } = data.colors;
  return `
.tawd-m-header,.tawd-m-footer{display:none}
@media (max-width:767px){
${hide ? `${hide}{display:none!important}` : ""}
.tawd-m-header{display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:50;height:60px;padding:0 16px;background:${background};color:${ink};box-shadow:0 1px 0 rgba(0,0,0,.08)}
.tawd-m-brand{display:flex;align-items:center;min-height:44px;color:inherit;text-decoration:none;font-weight:700}
.tawd-m-brand img{max-height:44px;width:auto;display:block}
.tawd-m-menu>summary{list-style:none;width:44px;height:44px;display:flex;align-items:center;justify-content:center;cursor:pointer}
.tawd-m-menu>summary::-webkit-details-marker,.tawd-m-sub>summary::-webkit-details-marker,.tawd-m-col>summary::-webkit-details-marker{display:none}
.tawd-m-burger,.tawd-m-burger::before,.tawd-m-burger::after{display:block;width:24px;height:2px;background:currentColor;position:relative;content:""}
.tawd-m-burger::before{position:absolute;top:-7px}.tawd-m-burger::after{position:absolute;top:7px}
.tawd-m-menu[open]>summary .tawd-m-burger{background:transparent}
.tawd-m-menu[open]>summary .tawd-m-burger::before{top:0;transform:rotate(45deg)}
.tawd-m-menu[open]>summary .tawd-m-burger::after{top:0;transform:rotate(-45deg)}
.tawd-m-menu nav{position:absolute;left:0;right:0;top:60px;max-height:calc(100vh - 60px);overflow-y:auto;background:${background};padding:8px 16px 24px;box-shadow:0 8px 16px rgba(0,0,0,.15)}
.tawd-m-menu ul{list-style:none;margin:0;padding:0}
.tawd-m-menu a,.tawd-m-sub>summary{display:flex;align-items:center;min-height:44px;color:inherit;text-decoration:none;font-size:17px;border-bottom:1px solid rgba(127,127,127,.2);cursor:pointer}
.tawd-m-sub>summary{list-style:none;justify-content:space-between}
.tawd-m-sub>summary::after{content:"";width:8px;height:8px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg);margin-right:6px}
.tawd-m-sub[open]>summary::after{transform:rotate(-135deg)}
.tawd-m-sub ul{padding-left:16px}
.tawd-m-menu [aria-current="page"]{color:${accent};font-weight:700}
.tawd-m-tagline{margin:16px 0 8px;font-size:15px;opacity:.85}
.tawd-m-social{display:flex;gap:12px;margin:12px 0 0;flex-wrap:wrap}
.tawd-m-social a{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;color:inherit;font-size:22px}
.tawd-m-footer{display:block;padding:24px 16px;background:${background};color:${ink}}
.tawd-m-footer .tawd-m-brand{margin-bottom:12px}
.tawd-m-col{border-bottom:1px solid rgba(127,127,127,.3)}
.tawd-m-col>summary{list-style:none;display:flex;align-items:center;justify-content:space-between;min-height:48px;font-weight:700;cursor:pointer}
.tawd-m-col>summary::after{content:"+";font-size:22px;font-weight:400}
.tawd-m-col[open]>summary::after{content:"\\2212"}
.tawd-m-col ul{list-style:none;margin:0 0 12px;padding:0}
.tawd-m-col a{display:flex;align-items:center;min-height:44px;color:inherit;text-decoration:none}
.tawd-m-note{font-size:13px;opacity:.8;margin:16px 0 8px}
.tawd-m-legal{display:flex;gap:16px;flex-wrap:wrap;margin:0}
.tawd-m-legal a{display:inline-flex;align-items:center;min-height:44px;color:inherit;font-size:14px}
}`;
}
