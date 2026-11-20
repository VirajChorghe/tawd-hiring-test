import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";

/*
  Build B, B1 (1 October 2026): a built Build A page as WordPress block
  markup, by code, at no cost (Jason's decision: code first, AI only for
  what's left). Each element the code can map exactly becomes a native
  block (Group, Heading, Paragraph, List, Image, Details); anything else
  (an inline style, an SVG, a script, a layout of loose text) stays as it
  was inside a Custom HTML block, so the page looks the same either way.
  The theme carries Build A's stylesheet, so the classes still apply.

  Every native block is written exactly as WordPress's own save() writes
  it, so the editor opens it without "This block contains unexpected or
  invalid content". The markup is checked with WordPress's block parser in
  the tests, and in a real WordPress (Playground) before Bluehost.
*/

export interface BlockStats {
  /** Native blocks made. */
  native: number;
  /** Custom HTML blocks: parts the code kept as they were. */
  html: number;
  /** Contact Form 7 forms. */
  forms: number;
}

export interface BlockPage {
  markup: string;
  stats: BlockStats;
  /** The forms on the page, in order, for Contact Form 7. */
  forms: WpForm[];
}

export interface WpForm {
  /** The form's name on Build A ("contact"); the form is found by it on WordPress. */
  name: string;
  /** Contact Form 7's form template: the form's own markup with its fields as form tags. */
  template: string;
  /** The fields people fill in, for the email (and, with required and options, for Gravity Forms). */
  fields: { name: string; label: string; type: string; required?: boolean; options?: string[] }[];
  /** How Build A dressed the form: the classes Gravity Forms' fields and button are given (1 October 2026). */
  look?: { wrapper: string; label: string; input: string; button: string; buttonText: string };
  /** The <form> element's class and id, kept on the form Contact Form 7 prints. */
  htmlClass: string;
  htmlId: string;
  /** Anything the code couldn't carry over, to check by hand. */
  notes: string[];
}

/* ---------- block comments, as WordPress serializes them ---------- */

/* serializeAttributes in @wordpress/blocks: nothing in the JSON can end the comment or read as markup. */
export function blockAttrs(attrs: Record<string, unknown>): string {
  const clean = Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined && v !== ""));
  if (Object.keys(clean).length === 0) return "";
  const json = JSON.stringify(clean)
    .replace(/--/g, "\\u002d\\u002d")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\\"/g, "\\u0022");
  return ` ${json}`;
}

export function block(name: string, attrs: Record<string, unknown>, inner: string | null): string {
  if (inner === null) return `<!-- wp:${name}${blockAttrs(attrs)} /-->`;
  return `<!-- wp:${name}${blockAttrs(attrs)} -->\n${inner}\n<!-- /wp:${name} -->`;
}

export const htmlBlock = (html: string) => block("html", {}, html.trim());

/* ---------- reading the page ---------- */

const isElement = (node: ChildNode): node is Element => node.type === "tag" || node.type === "script" || node.type === "style";
const isBlank = (node: ChildNode) => (node.type === "text" && !node.data.trim()) || node.type === "comment";

/* The element's markup exactly as it is in the page. */
const sourceOf = (html: string, node: ChildNode) => html.slice(node.startIndex!, node.endIndex! + 1);

/* What's between an element's opening and closing tags, exactly as written. */
function innerSource(html: string, el: Element): string {
  if (el.children.length === 0) return "";
  return html.slice(el.children[0]!.startIndex!, el.children.at(-1)!.endIndex! + 1);
}

const escapeAttr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* Only these attributes can be carried by a block's own settings. */
function onlyAttrs(el: Element, allowed: string[]): boolean {
  return Object.keys(el.attribs).every((name) => allowed.includes(name));
}

const classNameOf = (el: Element) => (el.attribs.class ?? "").trim().split(/\s+/).filter(Boolean).join(" ");
const ANCHOR = /^[A-Za-z][\w:.-]*$/;
const anchorOk = (el: Element) => el.attribs.id === undefined || ANCHOR.test(el.attribs.id);

/*
  Text formatting the editor's rich text keeps as it is: a heading, a
  paragraph or a list item whose content is only these round-trips through
  the editor unchanged.
*/
const INLINE = new Set(["a", "abbr", "b", "br", "code", "em", "i", "kbd", "mark", "s", "small", "span", "strong", "sub", "sup", "time", "u"]);
const INLINE_ATTRS = new Set(["class", "href", "target", "rel", "title", "aria-hidden", "aria-label", "datetime", "lang"]);

function inlineOnly(nodes: ChildNode[]): boolean {
  return nodes.every((node) => {
    if (node.type === "text") return true;
    if (node.type === "comment") return false;
    if (!isElement(node) || node.type !== "tag" || !INLINE.has(node.name)) return false;
    if (!Object.keys(node.attribs).every((a) => INLINE_ATTRS.has(a))) return false;
    // A link the editor opens as a link: a real address, never a script.
    if (node.name === "a" && /^\s*javascript:/i.test(node.attribs.href ?? "")) return false;
    return inlineOnly(node.children);
  });
}

/* The block's settings for a class and an id ("anchor"). */
function classAndAnchor(el: Element): Record<string, unknown> {
  return { className: classNameOf(el) || undefined, anchor: el.attribs.id || undefined };
}

/* class="wp-block-x extra" and id="...", in the order WordPress writes them. */
function wrapperAttrs(el: Element, base: string | null): string {
  const classes = [base, classNameOf(el)].filter(Boolean).join(" ");
  return `${classes ? ` class="${escapeAttr(classes)}"` : ""}${el.attribs.id ? ` id="${escapeAttr(el.attribs.id)}"` : ""}`;
}

/* ---------- the blocks ---------- */

/* The group block's tag choices. */
const GROUP_TAGS = new Set(["div", "section", "article", "aside", "header", "footer", "main"]);

interface Ctx {
  html: string;
  stats: BlockStats;
  forms: WpForm[];
}

/*
  A part kept as it is. A form inside it still becomes Contact Form 7's:
  WordPress runs shortcodes in Custom HTML blocks too.
*/
function asHtml(ctx: Ctx, node: ChildNode): string {
  ctx.stats.html += 1;
  return htmlBlock(withForms(ctx, node));
}

function withForms(ctx: Ctx, node: ChildNode): string {
  if (!isElement(node)) return sourceOf(ctx.html, node);
  if (node.name === "form") return formShortcode(addForm(ctx, node));
  if (node.children.length === 0 || !holdsForm(node)) return sourceOf(ctx.html, node);
  const open = ctx.html.slice(node.startIndex!, node.children[0]!.startIndex!);
  const close = ctx.html.slice(node.children.at(-1)!.endIndex! + 1, node.endIndex! + 1);
  return `${open}${node.children.map((c) => withForms(ctx, c)).join("")}${close}`;
}

function holdsForm(el: Element): boolean {
  return el.children.some((c) => isElement(c) && (c.name === "form" || holdsForm(c)));
}

function heading(ctx: Ctx, el: Element): string | null {
  if (!onlyAttrs(el, ["class", "id"]) || !anchorOk(el) || !inlineOnly(el.children)) return null;
  const level = Number(el.name.slice(1));
  ctx.stats.native += 1;
  return block("heading", { level: level === 2 ? undefined : level, ...classAndAnchor(el) }, `<${el.name}${wrapperAttrs(el, "wp-block-heading")}>${innerSource(ctx.html, el)}</${el.name}>`);
}

function paragraph(ctx: Ctx, el: Element): string | null {
  if (!onlyAttrs(el, ["class", "id"]) || !anchorOk(el) || !inlineOnly(el.children)) return null;
  ctx.stats.native += 1;
  return block("paragraph", classAndAnchor(el), `<p${wrapperAttrs(el, null)}>${innerSource(ctx.html, el)}</p>`);
}

function list(ctx: Ctx, el: Element): string | null {
  if (!onlyAttrs(el, ["class", "id"]) || !anchorOk(el)) return null;
  const items = el.children.filter((c) => !isBlank(c));
  if (items.length === 0) return null;
  if (!items.every((c): c is Element => isElement(c) && c.name === "li" && onlyAttrs(c, ["class"]) && inlineOnly(c.children))) return null;
  const ordered = el.name === "ol";
  const inner = items
    .map((li) => block("list-item", { className: classNameOf(li) || undefined }, `<li${wrapperAttrs(li, null)}>${innerSource(ctx.html, li)}</li>`))
    .join("\n\n");
  ctx.stats.native += 1 + items.length;
  return block("list", { ordered: ordered || undefined, ...classAndAnchor(el) }, `<${el.name}${wrapperAttrs(el, "wp-block-list")}>${inner}</${el.name}>`);
}

/* <figure><img src alt></figure>, the image block's own shape. A lone <img> stays as it is: a figure around it would change the layout. */
function image(ctx: Ctx, el: Element): string | null {
  if (!onlyAttrs(el, ["class", "id"]) || !anchorOk(el)) return null;
  const kids = el.children.filter((c) => !isBlank(c));
  const img = kids[0];
  if (kids.length !== 1 || !img || !isElement(img) || img.name !== "img") return null;
  if (!onlyAttrs(img, ["src", "alt"]) || !img.attribs.src || /^\s*(javascript|data):/i.test(img.attribs.src)) return null;
  ctx.stats.native += 1;
  const alt = img.attribs.alt ?? "";
  return block(
    "image",
    { ...classAndAnchor(el) },
    `<figure${wrapperAttrs(el, "wp-block-image")}><img src="${escapeAttr(img.attribs.src)}" alt="${escapeAttr(alt)}"/></figure>`,
  );
}

/* An FAQ question: <details><summary>…</summary>…</details>. */
function details(ctx: Ctx, el: Element): string | null {
  if (!onlyAttrs(el, ["class"])) return null;
  const kids = el.children.filter((c) => !isBlank(c));
  const summary = kids[0];
  if (!summary || !isElement(summary) || summary.name !== "summary" || Object.keys(summary.attribs).length > 0 || !inlineOnly(summary.children)) return null;
  const rest = kids.slice(1);
  if (rest.some((c) => !isElement(c))) return null;
  const inner = blocksOf(ctx, rest as Element[]);
  if (inner === null) return null;
  ctx.stats.native += 1;
  return block("details", { className: classNameOf(el) || undefined }, `<details${wrapperAttrs(el, "wp-block-details")}><summary>${innerSource(ctx.html, summary)}</summary>${inner}</details>`);
}

/*
  A section named by its heading (aria-labelledby): the group block can't
  carry that, so it gets the heading's words as its aria-label instead,
  which gives it the same name for screen readers.
*/
function labelOf(el: Element): string | undefined {
  if (el.attribs["aria-label"] !== undefined) return el.attribs["aria-label"];
  const ids = el.attribs["aria-labelledby"]?.trim().split(/\s+/);
  if (!ids) return undefined;
  const byId = (nodes: ChildNode[], id: string): Element | null => {
    for (const n of nodes) {
      if (!isElement(n)) continue;
      if (n.attribs.id === id) return n;
      const inside = byId(n.children, id);
      if (inside) return inside;
    }
    return null;
  };
  const words = ids.map((id) => byId(el.children, id)).map((n) => (n ? textOf(n) : null));
  return words.every((w): w is string => Boolean(w)) ? words.join(" ") : undefined;
}

function group(ctx: Ctx, el: Element): string | null {
  if (!GROUP_TAGS.has(el.name) || !onlyAttrs(el, ["class", "id", "aria-label", "aria-labelledby"]) || !anchorOk(el)) return null;
  const label = labelOf(el);
  if (el.attribs["aria-labelledby"] !== undefined && label === undefined) return null;
  const kids = el.children.filter((c) => !isBlank(c));
  // Loose text beside elements can't be a block of its own.
  if (kids.length === 0 || kids.some((c) => !isElement(c))) return null;
  const before = { ...ctx.stats };
  const inner = blocksOf(ctx, kids as Element[]);
  if (inner === null) return null;
  // Nothing inside became a native block: one Custom HTML block for the lot is simpler to edit.
  if (ctx.stats.native === before.native && ctx.stats.forms === before.forms) {
    ctx.stats.html = before.html;
    return null;
  }
  ctx.stats.native += 1;
  return block(
    "group",
    { tagName: el.name === "div" ? undefined : el.name, ...classAndAnchor(el), ariaLabel: label, layout: { type: "default" } },
    `<${el.name}${wrapperAttrs(el, "wp-block-group")}${label !== undefined ? ` aria-label="${escapeAttr(label)}"` : ""}>${inner}</${el.name}>`,
  );
}

function addForm(ctx: Ctx, el: Element): WpForm {
  const made = contactForm7(ctx.html, el, ctx.forms.length);
  ctx.forms.push(made);
  ctx.stats.forms += 1;
  return made;
}

function form(ctx: Ctx, el: Element): string {
  return block("shortcode", {}, formShortcode(addForm(ctx, el)));
}

/* The shortcode the installer finishes: the form's id on the site is only known once it exists there. */
export function formShortcode(made: WpForm): string {
  const opts = [`id="${FORM_ID_TOKEN}${made.name}"`, `title="${made.name}"`];
  if (made.htmlClass) opts.push(`html_class="${made.htmlClass}"`);
  if (made.htmlId) opts.push(`html_id="${made.htmlId}"`);
  return `[contact-form-7 ${opts.join(" ")}]`;
}

/* The installer swaps "tawd-form:contact" for the form's real id. */
export const FORM_ID_TOKEN = "tawd-form:";

function one(ctx: Ctx, el: Element): string {
  if (el.name === "form") return form(ctx, el);
  const made =
    /^h[1-6]$/.test(el.name) ? heading(ctx, el)
    : el.name === "p" ? paragraph(ctx, el)
    : el.name === "ul" || el.name === "ol" ? list(ctx, el)
    : el.name === "figure" ? image(ctx, el)
    : el.name === "details" ? details(ctx, el)
    : GROUP_TAGS.has(el.name) ? group(ctx, el)
    : null;
  return made ?? asHtml(ctx, el);
}

function blocksOf(ctx: Ctx, elements: Element[]): string | null {
  return elements.map((el) => one(ctx, el)).join("\n\n");
}

/* The blocks for a run of HTML: a page's <main> contents, or a part. */
export function htmlToBlocks(html: string): BlockPage {
  const doc = parseDocument(html, { withStartIndices: true, withEndIndices: true, decodeEntities: true });
  const ctx: Ctx = { html, stats: { native: 0, html: 0, forms: 0 }, forms: [] };
  const out: string[] = [];
  for (const node of doc.children) {
    if (isBlank(node)) continue;
    out.push(isElement(node) ? one(ctx, node) : asHtml(ctx, node));
  }
  return { markup: out.join("\n\n"), stats: ctx.stats, forms: ctx.forms };
}

/* ---------- Contact Form 7 ---------- */

const CF7_TYPES = new Set(["text", "email", "tel", "url", "number", "date"]);
const OPTION_VALUE = /^[-\w]+$/;
/* Contact Form 7's quoted values can't hold a double quote. */
const quoted = (text: string) => `"${text.replace(/"/g, "”").replace(/[\r\n]+/g, " ").trim()}"`;
const fieldName = (name: string) => name.replace(/[^\w-]/g, "-").replace(/^[^A-Za-z]+/, "") || "field";

/*
  A Build A form as a Contact Form 7 form: the form's own markup (labels,
  wrappers, classes) stays, each field becomes a form tag, and Netlify's
  extras (the hidden form name, the honeypot) go. The email lists the
  fields; the installer sends it to the client with a copy to VML.
*/
export function contactForm7(html: string, formEl: Element, index: number): WpForm {
  const name = (formEl.attribs.name ?? "").replace(/[^\w-]/g, "") || (index === 0 ? "contact" : `contact-${index + 1}`);
  const notes: string[] = [];
  const fields: WpForm["fields"] = [];
  const labels = new Map<string, string>();
  const collectLabels = (nodes: ChildNode[]) => {
    for (const n of nodes) {
      if (!isElement(n)) continue;
      if (n.name === "label" && n.attribs.for) labels.set(n.attribs.for, textOf(n));
      collectLabels(n.children);
    }
  };
  collectLabels(formEl.children);

  const opts = (el: Element) => {
    const parts: string[] = [];
    if (el.attribs.id && OPTION_VALUE.test(el.attribs.id)) parts.push(`id:${el.attribs.id}`);
    for (const c of classNameOf(el).split(" ").filter((c) => OPTION_VALUE.test(c))) parts.push(`class:${c}`);
    if (el.attribs.autocomplete && OPTION_VALUE.test(el.attribs.autocomplete)) parts.push(`autocomplete:${el.attribs.autocomplete}`);
    return parts;
  };
  const labelFor = (el: Element, fallback: string) => labels.get(el.attribs.id ?? "") || el.attribs["aria-label"] || el.attribs.placeholder || fallback;

  const render = (nodes: ChildNode[]): string =>
    nodes
      .map((node) => {
        if (!isElement(node)) return sourceOf(html, node);
        const el = node;
        if (el.name === "input" && el.attribs.name === "form-name") return "";
        if (el.name === "p" && /\btawd-honeypot\b/.test(el.attribs.class ?? "")) return "";
        if (el.name === "input" || el.name === "textarea" || el.name === "select") {
          const type = el.name === "input" ? (el.attribs.type ?? "text").toLowerCase() : el.name;
          if (type === "hidden") return "";
          if (type === "submit") return `[submit ${[...opts(el), quoted(el.attribs.value || "Send")].join(" ")}]`;
          const field = fieldName(el.attribs.name ?? `field-${fields.length + 1}`);
          const star = el.attribs.required !== undefined ? "*" : "";
          const placeholder = el.attribs.placeholder ? ["placeholder", quoted(el.attribs.placeholder)] : [];
          if (type === "textarea") {
            fields.push({ name: field, label: labelFor(el, field), type, required: Boolean(star) });
            // Contact Form 7 makes a message box 40 by 10 unless told; a browser's own is 20 by 2. Build A's size stays.
            const rows = /^\d+$/.test(el.attribs.rows ?? "") ? el.attribs.rows : "2";
            const cols = /^\d+$/.test(el.attribs.cols ?? "") ? el.attribs.cols : "20";
            return `[textarea${star} ${[field, `${cols}x${rows}`, ...opts(el), ...placeholder].join(" ")}]`;
          }
          if (type === "select") {
            const options = el.children.filter((c): c is Element => isElement(c) && c.name === "option");
            // An empty first option ("Choose one") is Contact Form 7's include_blank, not a choice.
            const blank = options[0]?.attribs.value === "";
            const choices = options.filter((o) => o.attribs.value !== "").map((o) => quoted(textOf(o)));
            fields.push({ name: field, label: labelFor(el, field), type, required: Boolean(star), options: options.filter((o) => o.attribs.value !== "").map((o) => textOf(o)) });
            return `[select${star} ${[field, ...opts(el), ...(blank ? ["include_blank"] : []), ...choices].join(" ")}]`;
          }
          // F1: a photo (one file, as Netlify takes it), sent with the email.
          if (type === "file") {
            fields.push({ name: field, label: labelFor(el, field), type, required: Boolean(star) });
            return `[file${star} ${[field, ...opts(el), "limit:8mb", "filetypes:jpg|jpeg|png|gif|webp|heic"].join(" ")}]`;
          }
          // F1: a tickbox inside its label ("This is an emergency"): Contact Form 7's acceptance is a bare box.
          if (type === "checkbox") {
            fields.push({ name: field, label: labels.get(el.attribs.id ?? "") || el.attribs["aria-label"] || textOf(el.parent as ChildNode).trim() || field, type, required: Boolean(star) });
            return `[acceptance ${[field, ...opts(el), ...(star ? [] : ["optional"])].join(" ")}]`;
          }
          if (!CF7_TYPES.has(type)) {
            notes.push(`A "${type}" field (${field}) isn't carried over; add it in Contact Form 7 by hand.`);
            return "";
          }
          fields.push({ name: field, label: labelFor(el, field), type, required: Boolean(star) });
          return `[${type}${star} ${[field, ...opts(el), ...placeholder].join(" ")}]`;
        }
        if (el.name === "button") {
          const type = (el.attribs.type ?? "submit").toLowerCase();
          if (type !== "submit") return sourceOf(html, el);
          return `[submit ${[...opts(el), quoted(textOf(el) || "Send")].join(" ")}]`;
        }
        if (el.children.length === 0) return sourceOf(html, el);
        const open = html.slice(el.startIndex!, el.children[0]!.startIndex!);
        const close = html.slice(el.children.at(-1)!.endIndex! + 1, el.endIndex! + 1);
        return `${open}${render(el.children)}${close}`;
      })
      .join("");

  const template = render(formEl.children).trim();
  if (!/\[submit\b/.test(template)) notes.push("The form has no send button.");
  return {
    name,
    template: template || "[submit \"Send\"]",
    fields,
    look: formLook(formEl),
    htmlClass: classNameOf(formEl)
      .split(" ")
      .filter((c) => OPTION_VALUE.test(c))
      .join(" "),
    htmlId: formEl.attribs.id && OPTION_VALUE.test(formEl.attribs.id) ? formEl.attribs.id : "",
    notes,
  };
}

function textOf(node: ChildNode): string {
  if (node.type === "text") return node.data;
  if (!isElement(node)) return "";
  return node.children.map(textOf).join("").replace(/\s+/g, " ").trim();
}

/* The email Contact Form 7 sends: every field, labelled. */
export function cf7MailBody(made: WpForm, siteName: string): string {
  const lines = made.fields.map((f) => `${f.label.replace(/[\[\]]/g, "")}: [${f.name}]`);
  return `A new message from the ${siteName} website.\n\n${lines.join("\n")}\n\n--\nSent from [_url]`;
}

/* How Build A dressed a form: the first field's wrapper, its label and box, and the send button (for Gravity Forms). */
function formLook(form: Element): NonNullable<WpForm["look"]> {
  const all: Element[] = [];
  const walk = (nodes: ChildNode[]) => {
    for (const n of nodes) {
      // Netlify's hidden spam trap isn't part of the form's look.
      if (!isElement(n) || /tawd-honeypot/.test(n.attribs.class ?? "") || n.attribs.name === "bot-field" || n.attribs.name === "form-name") continue;
      all.push(n);
      walk(n.children);
    }
  };
  walk(form.children);
  const isBox = (e: Element) => (e.name === "input" && !["hidden", "submit", "checkbox", "radio", "button"].includes((e.attribs.type ?? "text").toLowerCase())) || e.name === "textarea" || e.name === "select";
  const box = all.find(isBox);
  let wrapper = "";
  for (let up = box?.parent as Element | null; up && up !== form; up = up.parent as Element | null) {
    if (up.children.some((c) => isElement(c) && c.name === "label")) {
      wrapper = classNameOf(up);
      break;
    }
  }
  const button = all.find((e) => (e.name === "button" && (e.attribs.type ?? "submit").toLowerCase() === "submit") || (e.name === "input" && (e.attribs.type ?? "").toLowerCase() === "submit"));
  return {
    wrapper,
    label: classNameOf(all.find((e) => e.name === "label") ?? form),
    input: box ? classNameOf(box) : "",
    button: button ? classNameOf(button) : "",
    buttonText: button ? (button.name === "input" ? (button.attribs.value ?? "") : textOf(button)) || "Send message" : "Send message",
  };
}
