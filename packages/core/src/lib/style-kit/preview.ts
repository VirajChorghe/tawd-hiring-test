import type { PageInventory } from "./elements";
import type { StyleKit } from "./kit";

/*
  The kit preview (28 September 2026): a page put together by code alone
  from a design page's inventory and the style kit, every element at its
  place in the design: texts from the design read, panels, boxes, buttons,
  ribbons and icons from the kit, photos cut from the design's picture.
  Fixed positions, so it is a check of the kit, not a site; it costs
  nothing and needs no AI. `picture` is the design's picture as an address
  (a data: URL), drawn 1440px wide.

  The picture is in the page once, in one style rule, and every photo
  area points to it with its own position (5 November 2026, gap 8: it was
  written into every photo area, so a long PNG design with many photos made
  a page of hundreds of megabytes that the browser couldn't load in time).
*/
export const DESIGN_PICTURE_CLASS = "kit-design-picture";

export function kitPreviewHtml(input: { title: string; page: PageInventory; kit: StyleKit; css: string; picture: string; fontLinks?: string }): string {
  const { page, kit } = input;
  // Quotes too: these go inside attributes (13 October 2026, the whole-code review).
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const at = (b: { x: number; y: number; w: number; h: number }, top: number) => `left:${b.x}px;top:${b.y - top}px;width:${b.w}px;height:${b.h}px;`;
  const sections = page.sections.map((s) => {
    const parts: string[] = [];
    const order = ["panel", "card", "box", "divider", "picture", "ribbon", "button", "icon", "text"];
    const elements = [...s.elements].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    for (const e of elements) {
      const ref = kit.map[e.id];
      switch (e.kind) {
        case "panel":
        case "card":
        case "box":
          parts.push(`<div class="${esc(ref ?? "")}" style="position:absolute;${at(e.box, s.top)}box-sizing:border-box;"></div>`);
          break;
        case "divider":
          parts.push(`<div class="${esc(ref ?? "")}" style="position:absolute;${at(e.box, s.top)}"></div>`);
          break;
        case "button":
          parts.push(`<a class="${esc(ref ?? "")}" style="position:absolute;${at(e.box, s.top)}box-sizing:border-box;min-height:0;"></a>`);
          break;
        case "ribbon":
          parts.push(`<span class="${esc(ref ?? "")}" style="position:absolute;${at(e.box, s.top)}box-sizing:border-box;padding:0;min-width:0;"></span>`);
          break;
        case "picture":
          parts.push(`<div role="img" aria-label="${esc(e.role)}" class="${DESIGN_PICTURE_CLASS}" style="position:absolute;${at(e.box, s.top)}background-position:-${e.box.x}px -${e.box.y}px;"></div>`);
          break;
        case "icon": {
          const frame = kit.icons.find((i) => i.ref === ref)?.frame;
          const size = frame ? e.box.h / 2 : e.box.h;
          parts.push(`<span data-kit-icon="${ref ?? ""}"${frame ? ` data-kit-frame="${frame}"` : ""} style="position:absolute;left:${e.box.x}px;top:${e.box.y - s.top}px;width:${e.box.w}px;height:${e.box.h}px;font-size:${size}px;box-sizing:border-box;"></span>`);
          break;
        }
        case "text": {
          const oneLine = e.box.h <= e.size * 1.7;
          parts.push(
            `<div data-fit="${oneLine ? "line" : "block"}" style="position:absolute;${at(e.box, s.top)}font-family:var(--kit-font-${e.role});font-size:${e.size}px;font-weight:${e.weight};color:${e.color};line-height:${oneLine ? 1 : 1.45};${oneLine ? "white-space:nowrap;" : ""}display:flex;align-items:center;">${esc(e.text)}</div>`,
          );
          break;
        }
        default:
          break;
      }
    }
    return `<section data-figma-section="${s.number}" aria-label="${esc(s.name)}" style="position:relative;height:${s.height}px;background:${s.background};">${parts.join("")}</section>`;
  });
  // Single lines are scaled to the design's width (the read's font sizes are estimates); blocks keep theirs.
  const fit = `<script>document.fonts.ready.then(()=>{document.querySelectorAll('[data-fit="line"]').forEach(el=>{const want=el.getBoundingClientRect().width;el.style.width='auto';const have=el.getBoundingClientRect().width;if(have>0){el.style.fontSize=(parseFloat(getComputedStyle(el).fontSize)*want/have)+'px';}el.style.width=want+'px';});document.querySelectorAll('[data-fit="block"]').forEach(el=>{const box=el.getBoundingClientRect();el.style.height='auto';el.style.display='block';let lo=6,hi=parseFloat(getComputedStyle(el).fontSize)*2.5;for(let i=0;i<14;i++){const mid=(lo+hi)/2;el.style.fontSize=mid+'px';if(el.scrollHeight>box.height)hi=mid;else lo=mid;}el.style.fontSize=lo+'px';el.style.height=box.height+'px';});document.body.dataset.fitted='1';});</script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(input.title)}</title>${input.fontLinks ?? ""}<style>${input.css}</style><style>body{margin:0;width:${page.width}px}section{overflow:hidden}.${DESIGN_PICTURE_CLASS}{background-image:url("${input.picture.replace(/"/g, "%22")}");background-size:${page.width}px auto;background-repeat:no-repeat}</style></head><body>${sections.join("")}${fit}</body></html>`;
}

/* The kit sheet: every colour, font, part and icon of the kit drawn once, for the team to look over. */
export function kitSheetHtml(kit: StyleKit, css: string): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const firstIcon = kit.icons.find((i) => !i.frame)?.ref;
  const sample = (p: StyleKit["parts"][number]) => {
    if (p.kind === "panel" || p.kind === "card") return `<div class="${p.className}" style="width:240px;height:100px;padding:12px;box-sizing:border-box">.${p.className}</div>`;
    if (p.kind === "box") return `<div class="${p.className}" style="width:360px;height:110px;margin-top:18px;box-sizing:border-box"><p class="kit-box-title" style="font:600 18px var(--kit-font-sans)">A title</p></div>`;
    if (p.kind === "button") return `<a class="${p.className}" style="font-size:15px;letter-spacing:.04em">A BUTTON${firstIcon ? ` <span data-kit-icon="${firstIcon}"></span>` : ""}</a>`;
    if (p.kind === "ribbon") return `<span class="${p.className}" style="font-size:32px">Name</span>`;
    return `<div class="${p.className}" style="width:180px;height:50px"></div>`;
  };
  const kinds: [StyleKit["parts"][number]["kind"], string][] = [
    ["panel", "Panels"],
    ["card", "Cards"],
    ["box", "Bordered boxes"],
    ["button", "Buttons"],
    ["ribbon", "Ribbons"],
    ["divider", "Dividers"],
  ];
  const onDark = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 200;
  };
  let html = `<h2>Colours</h2><div class="row">${kit.colors.map((c) => `<div class="swatch"><div style="background:${c.hex}"></div>${c.hex}<br>${esc(c.uses.slice(0, 2).join(", "))}</div>`).join("")}</div>`;
  html += `<h2>Fonts</h2>${kit.fonts.map((f) => `<div class="font" style="font-family:var(--kit-font-${f.role})">${f.role}: ${esc(f.family)} <span>${Math.round(f.score * 100)}% match${f.alternatives.length ? `; else ${esc(f.alternatives.map((a) => a.family).join(", "))}` : ""}</span></div>`).join("")}`;
  for (const [kind, title] of kinds) {
    const list = kit.parts.filter((p) => p.kind === kind);
    if (list.length) html += `<h2>${title}</h2><div class="row">${list.map((p) => `<div class="part">${sample(p)}<p>${esc(p.description)} (${p.uses.length} ${p.uses.length === 1 ? "use" : "uses"})</p></div>`).join("")}</div>`;
  }
  html += `<h2>Icons</h2><div class="row">${kit.icons
    .map((i) => `<div class="icon" style="background:${onDark(i.frame && i.frameColor?.startsWith("#") ? i.frameColor : i.color) ? "#1f2937" : "#fff"}"><span data-kit-icon="${i.ref}"${i.frame ? ` data-kit-frame="${i.frame}"` : ""} style="font-size:26px"></span><p>${esc(i.label)}${i.frame ? ` (${i.frame})` : ""}</p></div>`)
    .join("")}</div>`;
  if (kit.notes.length) html += `<h2>Notes</h2><ul>${kit.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Style kit</title><style>${css}</style><style>body{font-family:var(--kit-font-sans),sans-serif;margin:24px;color:#18212b;width:1040px}h2{font:600 14px sans-serif;color:#5b6570;border-bottom:1px solid #dde1e4;padding-bottom:4px;margin-top:22px}.row{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}.swatch{font:11px sans-serif;text-align:center;width:84px}.swatch div{height:40px;border:1px solid #cbd2d6;margin-bottom:4px}.font{font-size:30px;margin:4px 0}.font span{font:12px sans-serif;color:#5b6570}.part p,.icon p{font:11px sans-serif;color:#5b6570;max-width:360px}.icon{width:96px;text-align:center;padding:8px 4px;border-radius:6px}.icon p{color:#888}</style></head><body>${html}</body></html>`;
}
