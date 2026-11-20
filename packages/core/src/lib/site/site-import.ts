import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";

import { phonesIn } from "../mockups/current-site";
import { formatPhonesInText, formatUsPhone } from "../phone";
import { blockedSiteMessage, botCheck } from "./bot-check";
import type { BlockedRoute } from "./blocked-route";
import { COOKIE_POLICY_PATH, PRIVACY_POLICY_PATH } from "./policies";

/*
  Keep the current site (Jason, 6 October 2026; docs/plans/keep-current-site.md):
  a makeover keeps the client's own pages and words. This file is the code
  side, with no database and no network (the worker passes a fetch in):

  - which addresses of the current site are pages to import (the sitemap
    first, the home page's menu when there is none; same site only; feeds,
    attachments, archives, search and the policies TAWD replaces left out);
  - each page's own words, exactly: the main content only, with headings,
    paragraphs, lists, tables, links (internal ones pointed at the new
    paths) and the page's title, description, canonical and H1;
  - the page's kind and name for the page plan, and its words as the
    kept copy (Markdown, the page drafts' format);
  - the check after a build that the kept words are still on the page.

  The client's site is data, never instructions.
*/

/* ---------- addresses ---------- */

export type PolicyKind = "privacy" | "cookies";

/* A WordPress-style privacy or cookie policy: TAWD writes its own, so these are noted as replaced. */
export function policyKindOf(path: string): PolicyKind | null {
  const p = path.toLowerCase();
  if (/(^|\/)(privacy|privacy-policy|privacy-notice|privacy-statement)\/?$/.test(p)) return "privacy";
  if (/(^|\/)(cookies|cookie-policy|cookie-notice|cookie-statement|cookies-policy)\/?$/.test(p)) return "cookies";
  return null;
}

/* The new site's address for a policy page. */
export function policyPath(kind: PolicyKind): string {
  return kind === "privacy" ? PRIVACY_POLICY_PATH : COOKIE_POLICY_PATH;
}

/* A link to the site's own page, as the new site writes it: the same path (URLs are kept), the policies at TAWD's. */
export function newSitePath(url: string): string {
  const path = importPath(url);
  const policy = policyKindOf(path);
  return policy ? policyPath(policy) : path;
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/* "https://www.example.com/ant-control?x=1#top" -> "/ant-control/"; files keep their name. */
export function importPath(url: string): string {
  try {
    const raw = decodeURI(new URL(url).pathname || "/").replace(/\/{2,}/g, "/");
    const path = raw.toLowerCase();
    if (/\.[a-z0-9]{2,5}$/i.test(path) || path.endsWith("/")) return path;
    return `${path}/`;
  } catch {
    return "/";
  }
}

const FILE_RE = /\.(jpe?g|png|gif|webp|avif|svg|ico|pdf|docx?|xlsx?|pptx?|zip|mp4|mov|mp3|css|js|json|xml|kml|txt|rss|atom)$/i;

/*
  Why an address is not a page to import, or null when it is one. Same
  site only (www or not); no feeds, files, archives, search, logins or
  WordPress's own addresses. The policies are a reason of their own:
  "replaced" (TAWD writes its own).
*/
export function skipReason(url: string, siteHost: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Not a web address";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "Not a web page";
  if (hostOf(url) !== siteHost) return "Another website";
  const path = importPath(url);
  if (FILE_RE.test(path)) return "A file, not a page";
  if (/\/(feed|rss|atom|comments\/feed)\/$/.test(path) || /\/feed\//.test(path)) return "A feed";
  if (/^\/(wp-json|wp-admin|wp-content|wp-includes|wp-login\.php|xmlrpc\.php|cgi-bin)(\/|$)/.test(path)) return "WordPress's own address";
  if (/^\/(tag|category|author|tags|categories|topics?|archives?)\//.test(path) || /\/(tag|category|author)\/[^/]+\/$/.test(path)) return "An archive (tag, category or author)";
  if (/\/attachment\//.test(path) || parsed.searchParams.has("attachment_id")) return "An attachment page";
  if (/\/page\/\d+\/$/.test(path)) return "A second page of a list";
  if (/^\/(\d{4})\/(\d{2}\/)?$/.test(path)) return "An archive (by date)";
  if (/^\/(search|cart|checkout|my-account|account|login|wp-signup\.php|thank-you|thanks|thankyou)\/$/.test(path) || parsed.searchParams.has("s")) return "Search, account or thank-you page";
  if (parsed.searchParams.has("p") || parsed.searchParams.has("page_id") || parsed.searchParams.has("replytocom")) return "A query address";
  const policy = policyKindOf(path);
  if (policy) return `Replaced: TAWD writes its own ${policy === "privacy" ? "privacy policy" : "cookie policy"} (${policyPath(policy)})`;
  return null;
}

export interface SitemapEntry {
  url: string;
  lastmod: string | null;
}

/* A sitemap's pages with their last change, or a sitemap index's sitemaps. */
export function readSitemap(xml: string): { entries: SitemapEntry[]; sitemaps: string[] } {
  const decode = (s: string) => s.replace(/&amp;/g, "&").trim();
  if (/<sitemapindex\b/i.test(xml)) {
    return { entries: [], sitemaps: [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => decode(m[1]!)) };
  }
  const entries: SitemapEntry[] = [];
  for (const block of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
    const loc = /<loc>\s*([^<]+?)\s*<\/loc>/i.exec(block[1]!)?.[1];
    if (!loc) continue;
    entries.push({ url: decode(loc), lastmod: /<lastmod>\s*([^<]+?)\s*<\/lastmod>/i.exec(block[1]!)?.[1]?.trim() ?? null });
  }
  return { entries, sitemaps: [] };
}

/* Which of a sitemap index's sitemaps hold pages: taxonomies, authors, pictures, videos and places don't. */
export function sitemapKind(url: string): "pages" | "posts" | "other" | "skip" {
  const name = (url.split("/").pop() ?? "").toLowerCase();
  if (/(category|tag|author|taxonomy|attachment|image|video|local|locations|news-sitemap|product_cat|portfolio_cat|_cat|format)/.test(name)) return "skip";
  if (/^page[-_]sitemap|wp-sitemap-posts-page/.test(name)) return "pages";
  if (/^post[-_]sitemap|wp-sitemap-posts-post/.test(name)) return "posts";
  return "other";
}

/* ---------- reading a page ---------- */

const isElement = (node: ChildNode): node is Element => node.type === "tag" || node.type === "script" || node.type === "style";

const DROP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "object",
  "embed",
  "video",
  "audio",
  "canvas",
  "nav",
  "aside",
  "button",
  "select",
  "input",
  "textarea",
  "label",
  "dialog",
  "map",
  "head",
]);

/* Class names of the parts around a page's own words: cookie bars, popups, sidebars, share buttons, related posts, page builders' mobile copies. */
const DROP_CLASS_EXACT = new Set([
  "sidebar",
  "widget-area",
  "breadcrumb",
  "breadcrumbs",
  "yoast-breadcrumbs",
  "rank-math-breadcrumb",
  "sharedaddy",
  "share-buttons",
  "social-share",
  "social-icons",
  "a2a_kit",
  "addtoany_share_save_container",
  "related-posts",
  "jp-relatedposts",
  "yarpp-related",
  "comments-area",
  "comment-respond",
  "post-navigation",
  "nav-links",
  "screen-reader-text",
  "sr-only",
  "visually-hidden",
  "skip-link",
  "elementor-hidden-desktop",
  "elementor-tab-mobile-title",
  "elementor-widget-posts",
  "elementor-widget-loop-grid",
  "elementor-widget-nav-menu",
  "elementor-widget-sitemap",
  "elementor-widget-share-buttons",
  "elementor-widget-social-icons",
  "elementor-widget-google_maps",
  "elementor-widget-video",
  "elementor-widget-post-navigation",
  "elementor-widget-author-box",
  "elementor-widget-post-comments",
  "elementor-widget-post-info",
  "elementor-widget-table-of-contents",
  "elementor-location-popup",
  "elementor-location-header",
  "elementor-location-footer",
  "elementor-search-form",
  "wp-block-latest-posts",
  "wp-block-search",
  "wp-block-social-links",
  "wp-block-navigation",
  "newsletter",
  "post-meta",
  "entry-meta",
  "entry-footer",
  "byline",
  "posted-on",
  "tags-links",
  "cat-links",
  "ez-toc-container",
  "toc_container",
]);
const DROP_CLASS_PART = /(cookie|cmplz|gdpr|consent|borlabs|moove_gdpr|popup|pum-|modal|lightbox|chat-widget|tidio|intercom|offcanvas|off-canvas|back-to-top|scroll-top|whatsapp|sticky-call|floating-)/;
/* Review widgets (Trustindex, Elfsight, Google reviews plugins): reviews are never copied as page words (the house rule); the page notes them. */
const REVIEW_WIDGET = /^(ti-widget|trustindex|elfsight-app|eapps-|grw-|wp-gr|wpgr|rplg|wprev|google-reviews|reviews-widget|yelp-review|elementor-widget-trustindex|brb-)/;
const FORM_CLASS = /^(wpcf7|gform_wrapper|wpforms-container|elementor-widget-form|frm_forms|nf-form-cont|fluentform|ff-el-group|hs-form)/;

function classes(el: Element): string[] {
  return (el.attribs.class ?? "").split(/\s+/).filter(Boolean);
}

function hiddenByAttrs(el: Element): boolean {
  if ("hidden" in el.attribs) return true;
  if (el.attribs["aria-hidden"] === "true") return true;
  const style = (el.attribs.style ?? "").replace(/\s+/g, "").toLowerCase();
  return /display:none|visibility:hidden/.test(style);
}

function isChrome(el: Element): boolean {
  const role = (el.attribs.role ?? "").toLowerCase();
  if (role === "navigation" || role === "complementary" || role === "banner" || role === "contentinfo" || role === "dialog" || role === "search") return true;
  const id = (el.attribs.id ?? "").toLowerCase();
  if (DROP_CLASS_PART.test(id) || /^(sidebar|comments|respond|secondary|colophon|masthead|site-header|site-footer)$/.test(id)) return true;
  return classes(el).some((c) => {
    const lower = c.toLowerCase();
    return DROP_CLASS_EXACT.has(lower) || DROP_CLASS_PART.test(lower);
  });
}

function isReviewWidget(el: Element): boolean {
  return el.name === "trustindex" || classes(el).some((c) => REVIEW_WIDGET.test(c.toLowerCase()));
}

function isForm(el: Element): boolean {
  return el.name === "form" || classes(el).some((c) => FORM_CLASS.test(c.toLowerCase()));
}

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "blockquote",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "header",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "main",
  "ol",
  "p",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
  "center",
  "form",
  "body",
]);

export type ImportedBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: "p"; text: string }
  | { type: "ul" | "ol"; items: string[] }
  | { type: "table"; rows: string[][] }
  | { type: "quote"; text: string };

export interface ImportedImage {
  src: string;
  /** null when the picture has no alt attribute at all; "" when it is marked decorative. */
  alt: string | null;
}

export interface ImportedLink {
  /** The address as written, made absolute. */
  url: string;
  text: string;
  internal: boolean;
}

export interface ExtractedPage {
  title: string;
  metaDescription: string;
  canonical: string | null;
  robots: string;
  blocks: ImportedBlock[];
  images: ImportedImage[];
  links: ImportedLink[];
  /** The page had a form (contact, quote): the new page gets TAWD's form. */
  hasForm: boolean;
  /** Review widgets left out (their reviews are never copied). */
  reviewWidgets: number;
  /** schema.org types in the page's JSON-LD (LocalBusiness, Service, ...). */
  schemaTypes: string[];
  /** Pictures, scripts or styles loaded over http:// on an https page. */
  mixedContent: number;
  phones: string[];
  wordCount: number;
  /** The site's menu, read from the header (for page names, and the fallback when there is no sitemap). */
  menu: { label: string; url: string }[];
  /** Contact details the whole page carries, header and footer too (for filling empty intake answers, 0.96.0). */
  contact?: PageContact;
}

/*
  What a page proves about the business (0.96.0): its tel: and mailto:
  links, and the postal addresses in its own schema.org JSON-LD. Free text
  is never parsed into an address. Data, never instructions.
*/
export interface PageContact {
  /** Numbers from tel: links, as "(916) 555-0142" when they're US numbers. */
  tels: string[];
  /** Addresses from mailto: links, lower case. */
  emails: string[];
  /** schema.org PostalAddress values (streetAddress, addressLocality, addressRegion, postalCode). */
  addresses: { streetAddress: string; city: string; state: string; zip: string }[];
}

const FIELD_MAX = 200;
/** schema.org types for a business or organisation (LocalBusiness and its kinds: Plumber, HVACBusiness, PestControl, LegalService...). */
const BUSINESS_TYPE = /^(LocalBusiness|Organization|Organisation|Corporation|PestControl|Plumber|Electrician|Locksmith|Attorney|Notary|.*Business|.*Service|.*Contractor|.*Store|.*Company|.*Agency|.*Office|HousePainter|RoofingContractor|GeneralContractor|MovingCompany)$/;
// eslint-disable-next-line no-control-regex
const plainValue = (value: unknown): string => (typeof value === "string" ? squash(value.replace(/[\u0000-\u001f<>]/g, " ")).slice(0, FIELD_MAX) : "");

/* The page's tel: and mailto: links and its JSON-LD postal addresses (data only, capped). */
export function contactOf(doc: ChildNode[]): PageContact {
  const tels = new Set<string>();
  const emails = new Set<string>();
  const decode = (text: string) => {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  };
  for (const a of findAll(doc, (el) => el.name === "a" && Boolean(el.attribs.href))) {
    const href = a.attribs.href!.trim();
    if (/^tel:/i.test(href)) {
      const digits = decode(href.slice(4)).replace(/[^\d+]/g, "");
      if (digits.replace(/\D/g, "").length >= 10) tels.add(formatUsPhone(digits));
    } else if (/^mailto:/i.test(href)) {
      const address = decode(href.slice(7).split("?")[0] ?? "").trim().toLowerCase();
      if (/^[^\s@<>]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/.test(address)) emails.add(address);
    }
  }
  const addresses: PageContact["addresses"] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((v) => visit(v, depth + 1));
      return;
    }
    const record = value as Record<string, unknown>;
    const types = (Array.isArray(record["@type"]) ? record["@type"] : [record["@type"]]).filter((t): t is string => typeof t === "string");
    // Only a business's or organisation's own address (Fable's review M2): never an event's place, a person's or a review's.
    if (types.some((t) => BUSINESS_TYPE.test(t))) {
      for (const a of Array.isArray(record.address) ? record.address : [record.address]) {
        if (!a || typeof a !== "object") continue;
        const r = a as Record<string, unknown>;
        const found = { streetAddress: plainValue(r.streetAddress), city: plainValue(r.addressLocality), state: plainValue(r.addressRegion), zip: plainValue(r.postalCode) };
        if ((found.streetAddress || found.city) && !addresses.some((x) => JSON.stringify(x) === JSON.stringify(found))) addresses.push(found);
      }
    }
    for (const [key, inner] of Object.entries(record)) if (key !== "@context") visit(inner, depth + 1);
  };
  for (const script of findAll(doc, (el) => el.name === "script" && /ld\+json/i.test(el.attribs.type ?? ""))) {
    try {
      visit(JSON.parse(script.children.map((c) => (c.type === "text" ? c.data : "")).join("")), 0);
    } catch {
      // Not readable JSON: no address from it.
    }
  }
  return { tels: [...tels].slice(0, 10), emails: [...emails].slice(0, 10), addresses: addresses.slice(0, 5) };
}

const squash = (text: string) => text.replace(/[ \s]+/g, " ").trim();

function textOf(node: ChildNode): string {
  if (node.type === "text") return node.data;
  if (!isElement(node) || node.type !== "tag") return "";
  if (node.name === "br") return " ";
  return node.children.map(textOf).join("");
}

/*
  An absolute http(s) address, or null. The parsed protocol is what counts:
  "java&#9;script:" gets past a text check and URL then drops the tab
  (13 October 2026, the whole-code review).
*/
function absolute(href: string, base: string): string | null {
  try {
    const url = new URL(href.trim(), base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function imageSrc(el: Element): string | null {
  const candidates = [el.attribs["data-src"], el.attribs["data-lazy-src"], el.attribs["data-original"], el.attribs.src, el.attribs["data-srcset"]?.split(/\s+/)[0], el.attribs.srcset?.split(/\s+/)[0]];
  return candidates.find((c) => c && !c.startsWith("data:") && c.trim()) ?? null;
}

interface WalkContext {
  base: string;
  siteHost: string;
  blocks: ImportedBlock[];
  images: ImportedImage[];
  links: ImportedLink[];
  hasForm: boolean;
  reviewWidgets: number;
  /** Paragraph text gathered from loose inline content. */
  pending: string[];
  /** Internal links as the copy writes them (the new site's path). */
  rewrite: (url: string) => string;
}

/* Inline content as Markdown text: links written [text](path), everything else as its words. */
function inline(ctx: WalkContext, node: ChildNode, withLinks = true): string {
  if (node.type === "text") return node.data;
  if (!isElement(node) || node.type !== "tag") return "";
  if (DROP_TAGS.has(node.name) && node.name !== "button" && node.name !== "label") return "";
  if (hiddenByAttrs(node) || isChrome(node) || isReviewWidget(node)) return "";
  if (node.name === "br") return " ";
  if (node.name === "img") {
    collectImage(ctx, node);
    return "";
  }
  const inner = node.children.map((c) => inline(ctx, c, withLinks && node.name !== "a")).join("");
  if (node.name === "a" && withLinks) {
    const text = squash(inner);
    const href = node.attribs.href ?? "";
    if (!text || !href || /^(#|javascript:|tel:|mailto:|sms:)/i.test(href.trim())) return inner;
    const url = absolute(href, ctx.base);
    if (!url) return inner;
    const internal = hostOf(url) === ctx.siteHost;
    ctx.links.push({ url, text, internal });
    const target = internal ? ctx.rewrite(url) : url;
    return ` [${text.replace(/[[\]]/g, "")}](${target}) `;
  }
  return inner;
}

function collectImage(ctx: WalkContext, el: Element): void {
  const src = imageSrc(el);
  if (!src) return;
  const url = absolute(src, ctx.base);
  if (!url) return;
  const width = Number(el.attribs.width ?? 0);
  const height = Number(el.attribs.height ?? 0);
  // Icons and tracking pixels aren't the page's pictures.
  if ((width && width < 40) || (height && height < 40)) return;
  if (ctx.images.some((i) => i.src === url)) return;
  ctx.images.push({ src: url, alt: "alt" in el.attribs ? squash(el.attribs.alt ?? "") : null });
}

function flush(ctx: WalkContext): void {
  const text = cleanInline(ctx.pending.join(""));
  ctx.pending = [];
  if (text) pushBlock(ctx, { type: "p", text });
}

/* Spaces tidied around links and punctuation, so "word [link](/x/) ." reads "word [link](/x/)." */
function cleanInline(text: string): string {
  return squash(text)
    .replace(/\s+([,.;:!?)])/g, "$1")
    .replace(/\(\s+/g, "(")
    .trim();
}

function pushBlock(ctx: WalkContext, block: ImportedBlock): void {
  const last = ctx.blocks.at(-1);
  // Page builders repeat a block for another screen size: the same block twice in a row is kept once.
  if (last && JSON.stringify(last) === JSON.stringify(block)) return;
  ctx.blocks.push(block);
}

function listItems(ctx: WalkContext, el: Element): string[] {
  const items: string[] = [];
  for (const child of el.children) {
    if (!isElement(child) || child.type !== "tag" || hiddenByAttrs(child) || isChrome(child)) continue;
    if (child.name !== "li") continue;
    // The item's own words; a list inside an item is read as more items after it.
    const own = cleanInline(child.children.filter((c) => !(isElement(c) && (c.name === "ul" || c.name === "ol"))).map((c) => inline(ctx, c)).join(""));
    if (own) items.push(own);
    for (const sub of child.children) if (isElement(sub) && (sub.name === "ul" || sub.name === "ol")) items.push(...listItems(ctx, sub));
  }
  return items;
}

function tableRows(ctx: WalkContext, el: Element): string[][] {
  const rows: string[][] = [];
  const visit = (node: Element) => {
    for (const child of node.children) {
      if (!isElement(child) || child.type !== "tag") continue;
      if (child.name === "tr") {
        const cells = child.children
          .filter((c): c is Element => isElement(c) && (c.name === "td" || c.name === "th"))
          .map((c) => cleanInline(c.children.map((x) => inline(ctx, x)).join("")).replace(/\|/g, "/"));
        if (cells.some(Boolean)) rows.push(cells);
      } else if (child.name === "thead" || child.name === "tbody" || child.name === "tfoot") visit(child);
    }
  };
  visit(el);
  return rows;
}

function walk(ctx: WalkContext, node: ChildNode): void {
  if (node.type === "text") {
    if (node.data.trim()) ctx.pending.push(node.data);
    else if (ctx.pending.length) ctx.pending.push(" ");
    return;
  }
  if (!isElement(node) || node.type !== "tag") return;
  if (hiddenByAttrs(node)) return;
  if (isForm(node)) {
    flush(ctx);
    ctx.hasForm = true;
    return;
  }
  if (isReviewWidget(node)) {
    flush(ctx);
    ctx.reviewWidgets++;
    return;
  }
  if (DROP_TAGS.has(node.name) || isChrome(node)) return;
  if (node.name === "img") {
    collectImage(ctx, node);
    return;
  }
  if (!BLOCK_TAGS.has(node.name)) {
    ctx.pending.push(inline(ctx, node));
    return;
  }
  flush(ctx);
  const heading = /^h([1-6])$/.exec(node.name);
  if (heading) {
    const text = squash(textOf(node));
    if (text) pushBlock(ctx, { type: "heading", level: Number(heading[1]) as 1 | 2 | 3 | 4 | 5 | 6, text });
    for (const img of node.children) if (isElement(img) && img.name === "img") collectImage(ctx, img);
    return;
  }
  if (node.name === "p" || node.name === "summary" || node.name === "dt" || node.name === "dd" || node.name === "figcaption" || node.name === "address") {
    // A paragraph holding block content (it happens) is walked like a box.
    if (node.children.some((c) => isElement(c) && c.type === "tag" && BLOCK_TAGS.has(c.name) && c.name !== "p")) {
      for (const child of node.children) walk(ctx, child);
      flush(ctx);
      return;
    }
    const text = cleanInline(node.children.map((c) => inline(ctx, c)).join(""));
    if (text) pushBlock(ctx, { type: "p", text });
    return;
  }
  if (node.name === "ul" || node.name === "ol") {
    const items = listItems(ctx, node);
    if (items.length) pushBlock(ctx, { type: node.name, items });
    return;
  }
  if (node.name === "table") {
    const rows = tableRows(ctx, node);
    if (rows.length) pushBlock(ctx, { type: "table", rows });
    return;
  }
  if (node.name === "blockquote") {
    const text = cleanInline(node.children.map((c) => inline(ctx, c)).join(" "));
    if (text) pushBlock(ctx, { type: "quote", text });
    return;
  }
  if (node.name === "hr") return;
  for (const child of node.children) walk(ctx, child);
  flush(ctx);
}

function findAll(nodes: ChildNode[], test: (el: Element) => boolean, out: Element[] = []): Element[] {
  for (const node of nodes) {
    if (!isElement(node)) continue;
    if (test(node)) out.push(node);
    findAll(node.children, test, out);
  }
  return out;
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9'’-]*/g) ?? [];
}

/* The part of the page that holds its own words: <main>, else the article, else the content box, else the body. */
function contentRoot(doc: ChildNode[]): Element | null {
  const textLength = (el: Element) => squash(textOf(el)).length;
  const pick = (list: Element[]) => list.sort((a, b) => textLength(b) - textLength(a))[0] ?? null;
  const mains = findAll(doc, (el) => el.name === "main" || el.attribs.role === "main");
  if (mains.length) return pick(mains);
  const articles = findAll(doc, (el) => el.name === "article");
  if (articles.length === 1) return articles[0]!;
  const boxes = findAll(doc, (el) => /^(content|primary|main-content|maincontent)$/.test(el.attribs.id ?? "") || classes(el).some((c) => /^(entry-content|site-content|page-content|post-content|main-content)$/.test(c)));
  if (boxes.length) return pick(boxes);
  return findAll(doc, (el) => el.name === "body")[0] ?? null;
}

function schemaTypesIn(doc: ChildNode[]): string[] {
  const types = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const type = record["@type"];
    for (const t of Array.isArray(type) ? type : [type]) if (typeof t === "string") types.add(t);
    for (const [key, inner] of Object.entries(record)) if (key !== "@context") visit(inner);
  };
  for (const script of findAll(doc, (el) => el.name === "script" && /ld\+json/i.test(el.attribs.type ?? ""))) {
    try {
      visit(JSON.parse(script.children.map((c) => (c.type === "text" ? c.data : "")).join("")));
    } catch {
      // Not readable JSON: no types from it.
    }
  }
  return [...types].slice(0, 40);
}

/* The header's menu: labels and addresses, in order. */
export function menuOf(doc: ChildNode[], base: string): { label: string; url: string }[] {
  const headers = findAll(doc, (el) => el.name === "header" || el.attribs.role === "banner" || classes(el).includes("elementor-location-header"));
  const scope = headers.length ? headers : findAll(doc, (el) => el.name === "nav").slice(0, 1);
  const out: { label: string; url: string }[] = [];
  for (const box of scope) {
    for (const a of findAll(box.children, (el) => el.name === "a" && Boolean(el.attribs.href))) {
      const label = squash(textOf(a));
      const url = absolute(a.attribs.href!, base);
      if (!label || !url || label.length > 40 || /^(#|javascript:|tel:|mailto:)/i.test(a.attribs.href!.trim()) || /^skip to\b/i.test(label)) continue;
      if (!out.some((m) => m.url === url && m.label === label)) out.push({ label, url });
    }
  }
  return out.slice(0, 80);
}

/*
  One page of the current site, read by code: its head (title, description,
  canonical, robots, structured data) and its own words. The header, menu,
  footer, sidebars, cookie bars, popups, share buttons, forms' fields and
  scripts are left out; a form is noted.
*/
export function extractPage(html: string, pageUrl: string, rewrite: (url: string) => string = newSitePath): ExtractedPage {
  const doc = parseDocument(html, { decodeEntities: true }).children;
  const head = findAll(doc, (el) => el.name === "head")[0];
  const headNodes = head ? head.children : doc;
  const titleEl = findAll(headNodes, (el) => el.name === "title")[0] ?? findAll(doc, (el) => el.name === "title")[0];
  const meta = (name: string) => findAll(headNodes, (el) => el.name === "meta" && (el.attribs.name ?? el.attribs.property ?? "").toLowerCase() === name)[0]?.attribs.content ?? "";
  const canonicalEl = findAll(headNodes, (el) => el.name === "link" && (el.attribs.rel ?? "").toLowerCase().split(/\s+/).includes("canonical"))[0];
  const siteHost = hostOf(pageUrl) ?? "";
  const ctx: WalkContext = { base: pageUrl, siteHost, blocks: [], images: [], links: [], hasForm: false, reviewWidgets: 0, pending: [], rewrite };
  const root = contentRoot(doc);
  if (root) {
    for (const child of root.children) walk(ctx, child);
    flush(ctx);
  }
  // A form anywhere in the page's own part counts (one inside a hidden popup doesn't).
  const allText = ctx.blocks.map(blockText).join(" ");
  let mixed = 0;
  if (pageUrl.startsWith("https:")) {
    for (const el of findAll(doc, (e) => ["img", "script", "iframe", "source", "video", "audio"].includes(e.name) || (e.name === "link" && /stylesheet/i.test(e.attribs.rel ?? "")))) {
      const src = el.attribs.src ?? (el.name === "link" ? el.attribs.href : "") ?? "";
      if (/^http:\/\//i.test(src.trim())) mixed++;
    }
  }
  return {
    title: squash(titleEl ? textOf(titleEl) : ""),
    metaDescription: squash(meta("description")),
    canonical: canonicalEl?.attribs.href ? absolute(canonicalEl.attribs.href, pageUrl) : null,
    robots: squash(meta("robots")).toLowerCase(),
    blocks: ctx.blocks,
    images: ctx.images,
    links: ctx.links,
    hasForm: ctx.hasForm,
    reviewWidgets: ctx.reviewWidgets,
    schemaTypes: schemaTypesIn(doc),
    mixedContent: mixed,
    phones: phonesIn(allText),
    wordCount: words(stripLinks(allText)).length,
    menu: menuOf(doc, pageUrl),
    contact: contactOf(doc),
  };
}

/* "[Ant control](/ant-control/)" -> "Ant control". */
export function stripLinks(text: string): string {
  return text.replace(/\[([^\]]*)\]\([^)\s]*\)/g, "$1");
}

export function blockText(block: ImportedBlock): string {
  switch (block.type) {
    case "ul":
    case "ol":
      return block.items.join(". ");
    case "table":
      return block.rows.map((r) => r.join(" ")).join(". ");
    default:
      return block.text;
  }
}

export function headingsOf(blocks: ImportedBlock[]): { level: number; text: string }[] {
  return blocks.flatMap((b) => (b.type === "heading" ? [{ level: b.level, text: b.text }] : []));
}

/* ---------- the page plan from the current site ---------- */

export type ImportKind = "home" | "about" | "contact" | "service" | "service_areas" | "city" | "pricing" | "faq" | "reviews" | "blog" | "article" | "other";

const STATE_CODES =
  "al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc".split(" ");
const SERVICE_WORDS = /\b(control|removal|repair|repairs|install|installation|replacement|cleaning|service|services|treatment|inspection|extermination|exterminator|exclusion|maintenance|prevention|abatement|proofing|plumbing|hvac|heating|cooling|roofing|glass|windows?|doors?|law|lawyer|attorney|injury|defense|landscaping|painting|electrical|pest)\b/i;

/* Pages whose address has a service's words but aren't a service ("public-highlights-pest-control", "partners-we-recommend"). */
const NOT_A_SERVICE = /(^|-)(highlights|media|press|featured|partners?|recommend|recommended|careers|jobs|privacy|terms|sitemap|thank-you|thanks)(-|$)/;

export function notAService(path: string): boolean {
  return NOT_A_SERVICE.test(path.toLowerCase().split("/").filter(Boolean).at(-1) ?? "");
}

/* A city page's own place from its address: "/pest-control-el-dorado-hills-ca/" -> "el dorado hills". Null when nothing is left. */
export function pagePlace(path: string): string | null {
  const words = (path.toLowerCase().split("/").filter(Boolean).at(-1) ?? "").split("-").filter(Boolean);
  if (words.length >= 2 && STATE_CODES.includes(words.at(-1)!)) words.pop();
  const place = words.filter((w) => !SERVICE_WORDS.test(w) && !/^(in|near|of|the|and|for|best|local|top|company|companies|\d+)$/.test(w)).join(" ");
  return place.length > 2 ? place : null;
}

/* An article by its address alone (/blog/<name>/ and the like), before it's read: importKind's own rule. */
export function articleAddress(path: string): boolean {
  const segments = path.toLowerCase().split("/").filter(Boolean);
  return segments.length >= 2 && /^(blog|news|articles|insights|tips)$/.test(segments[0]!);
}

/* The page's kind by code: its address first, then its title and H1. */
export function importKind(input: { path: string; title: string; h1: string; fromPosts?: boolean; blogIndex?: string | null; cities?: string[] }): ImportKind {
  const path = input.path.toLowerCase();
  if (path === "/") return "home";
  const segments = path.split("/").filter(Boolean);
  const last = segments.at(-1) ?? "";
  if (input.blogIndex && path === input.blogIndex) return "blog";
  if (/^(blog|news|articles|insights|resources|tips)$/.test(last) && segments.length === 1) return "blog";
  if (input.fromPosts || articleAddress(path)) return "article";
  if (/^(about|about-us|our-story|who-we-are|our-team|meet-the-team|company)$/.test(last)) return "about";
  if (/^(contact|contact-us|get-in-touch|request-a-quote|get-a-quote|free-quote|free-estimate|schedule|book|book-now)$/.test(last)) return "contact";
  if (/(pricing|prices|price-list|rates|coupons?|specials|offers|deals|plans)/.test(last)) return "pricing";
  if (/^(faq|faqs|frequently-asked-questions|questions)$/.test(last)) return "faq";
  if (/^(reviews|testimonials|what-our-customers-say)$/.test(last)) return "reviews";
  if (/^(service-areas?|areas-we-serve|areas-served|locations|where-we-serve|cities-we-serve)$/.test(last)) return "service_areas";
  if (notAService(path)) return "other";
  const words = last.split("-");
  const text = `${input.title} ${input.h1}`;
  const cityHit = (input.cities ?? []).some((c) => {
    const slug = c.toLowerCase().split(",")[0]!.trim().replace(/[^a-z0-9]+/g, "-");
    return slug.length > 2 && (last === slug || last.startsWith(`${slug}-`) || last.endsWith(`-${slug}`) || last.includes(`-${slug}-`));
  });
  // "Pest Control In Roseville, CA" on /roseville-pest-control/: the place the title names is in the address too.
  const named = [...text.matchAll(/\b(?:in|near|serving)\s+([A-Z][A-Za-z .'-]+?),\s*[A-Z]{2}\b/gi)].map((m) => m[1]!.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-"));
  const placeInPath = named.some((slug) => slug.length > 2 && `-${last}-`.includes(`-${slug}-`));
  if (cityHit || placeInPath || (words.length >= 2 && STATE_CODES.includes(words.at(-1)!))) return "city";
  if (SERVICE_WORDS.test(last.replace(/-/g, " "))) return "service";
  return "other";
}

const SEPARATORS = /\s+[|\-–—:•·]\s+/;

/* The page's name in the plan and the menu: the old menu's label, else the title's first part, else the H1. */
export function importName(input: { path: string; title: string; h1: string; menuLabel?: string | null; kind: ImportKind; siteName?: string }): string {
  if (input.kind === "home") return "Home";
  const clip = (s: string) => squash(s).slice(0, 80);
  // A menu written in capitals ("ABOUT US") reads as "About Us" in the plan; the page's own words are untouched.
  if (input.menuLabel && input.menuLabel.length <= 40) return clip(/[a-z]/.test(input.menuLabel) ? input.menuLabel : input.menuLabel.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()));
  const parts = input.title.split(SEPARATORS).map((p) => p.trim()).filter(Boolean);
  const site = (input.siteName ?? "").toLowerCase();
  const titlePart = parts.find((p) => !site || p.toLowerCase() !== site) ?? "";
  if (input.kind === "article") return clip(input.h1 || titlePart || input.path);
  if (titlePart && titlePart.length <= 60) return clip(titlePart);
  if (input.h1) return clip(input.h1);
  const last = input.path.split("/").filter(Boolean).at(-1) ?? "page";
  return clip(last.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase()));
}

/* The plan's slug for a kept page: its path without the slashes ("" for Home; "blog/a-post" keeps its folder). */
export function slugFromPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

/* ---------- the kept copy ---------- */

/*
  The page's words as the page drafts' Markdown: "# " for the H1 (one only:
  a second H1 is written as "## "; a page with none gets its title as the
  H1, noted in the SEO suggestions), "##" to "######", paragraphs, "- " and
  "1. " lists, "> " quotes and "| " table rows. Links stay as [text](path).
*/
export function keptMarkdown(page: Pick<ExtractedPage, "blocks" | "title">, fallbackH1: string): { markdown: string; notes: string[] } {
  const notes: string[] = [];
  const lines: string[] = [];
  let h1Seen = false;
  const hasH1 = page.blocks.some((b) => b.type === "heading" && b.level === 1);
  // The page's own name for the home page ("Home") is a label, never a client's headline (F-034).
  const HOME_NAME = /^(home|home ?page|index)$/i;
  const usable = (text: string) => {
    const t = squash(text);
    if (!t) return "";
    if (HOME_NAME.test(t)) return "";
    // "Home | Acme Plumbing", "Acme Plumbing - Home": the label goes, the business name stays.
    const parts = t.split(SEPARATORS).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1 && parts.some((p) => HOME_NAME.test(p))) return parts.filter((p) => !HOME_NAME.test(p)).join(" | ");
    return t;
  };
  let promote: ImportedBlock | null = null;
  if (!hasH1) {
    // The real title, then the first usable heading of any level (made the H1 where it stands), then the caller's fallback; else flagged as missing.
    const title = usable(page.title);
    promote = title ? null : (page.blocks.find((b) => b.type === "heading" && usable(b.text)) ?? null);
    const h1 = title || (promote?.type === "heading" ? usable(promote.text) : "") || usable(fallbackH1) || "[PLACEHOLDER: page heading]";
    if (!promote) {
      lines.push(`# ${h1}`);
      h1Seen = true;
    }
    notes.push(
      h1.startsWith("[PLACEHOLDER")
        ? "The page had no H1 and no usable title: its headline is missing, and is marked as a placeholder."
        : `The page had no H1: TAWD used "${h1}" as its H1.`,
    );
  }
  for (const block of page.blocks) {
    switch (block.type) {
      case "heading": {
        let level: number = block === promote ? 1 : block.level;
        if (level === 1 && h1Seen) {
          level = 2;
          notes.push(`A second H1 ("${block.text.slice(0, 80)}") is kept as an H2.`);
        }
        if (level === 1) h1Seen = true;
        lines.push(`${"#".repeat(level)} ${stripLinks(block.text)}`);
        break;
      }
      case "p":
        lines.push(block.text.replace(/^(#{1,6}\s|[-*]\s|\d+\.\s|>\s|\|)/, "\\$1"));
        break;
      case "quote":
        lines.push(`> ${block.text}`);
        break;
      case "ul":
        lines.push(block.items.map((i) => `- ${i}`).join("\n"));
        break;
      case "ol":
        lines.push(block.items.map((i, n) => `${n + 1}. ${i}`).join("\n"));
        break;
      case "table":
        lines.push(block.rows.map((r) => `| ${r.join(" | ")} |`).join("\n"));
        break;
    }
  }
  return { markdown: `${lines.join("\n\n").trim()}\n`, notes };
}

/* ---------- the words check after a build ---------- */

/* Lower case, plain quotes and dashes, no link syntax or Markdown marks, single spaces. */
export function normalizeWords(text: string): string {
  return stripLinks(text)
    // Invisible characters (zero-width spaces, seen in Finley's headings) aren't words.
    .replace(/[​-‍⁠﻿­]/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/[’‘`´]/g, "'")
    .replace(/[“”«»„]/g, '"')
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/[  ]/g, " ")
    .replace(/…/g, "...")
    .replace(/\*\*|__/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9$%&@'".,!?:;/+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* The kept copy's sentences (headings, list items, table cells and sentences of paragraphs), as the reader sees them. */
export function keptSentences(markdown: string): string[] {
  const out: string[] = [];
  for (const raw of markdown.replace(/\r\n/g, "\n").split("\n")) {
    let line = raw.trim();
    if (!line) continue;
    line = line.replace(/^\\/, "").replace(/^#{1,6}\s+/, "").replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").replace(/^>\s+/, "");
    if (line.startsWith("|")) {
      for (const cell of line.split("|").map((c) => c.trim()).filter(Boolean)) out.push(cell);
      continue;
    }
    // Sentences: split after . ! ? followed by a space and a capital or a digit.
    const parts = stripLinks(line).split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/);
    for (const part of parts) if (normalizeWords(part).length >= 2) out.push(part.trim());
  }
  return [...new Set(out)];
}

/* A built page's visible words: its <main> without scripts, styles and hidden parts. */
export function visibleText(html: string): string {
  const doc = parseDocument(html, { decodeEntities: true }).children;
  const parts: string[] = [];
  const visit = (node: ChildNode) => {
    if (node.type === "text") {
      parts.push(node.data);
      return;
    }
    if (!isElement(node) || node.type !== "tag") return;
    if (["script", "style", "noscript", "template", "svg"].includes(node.name) || hiddenByAttrs(node)) return;
    if (node.name === "br") parts.push(" ");
    const block = BLOCK_TAGS.has(node.name) || node.name === "a" || node.name === "button";
    if (block) parts.push(" ");
    node.children.forEach(visit);
    if (block) parts.push(" ");
  };
  doc.forEach(visit);
  return squash(parts.join(""));
}

export interface KeptWordsResult {
  total: number;
  missing: string[];
}

/*
  Every sentence of the kept copy should be on the built page, word for
  word (spacing, case, quote marks and dashes aside). The ones that aren't
  are listed: missing, or changed. Code only; it never fixes anything.
  A phone number written another way is the same words: sites show every
  US number as "(916) 555-0142" (6 October 2026).
*/
export function keptWordsCheck(builtHtml: string, keptCopy: string): KeptWordsResult {
  const page = ` ${normalizeWords(formatPhonesInText(visibleText(builtHtml)))} `;
  const sentences = keptSentences(keptCopy);
  const missing = sentences.filter((s) => {
    const n = normalizeWords(formatPhonesInText(s)).replace(/[.,!?:;]+$/, "");
    return n.length > 0 && !page.includes(n);
  });
  return { total: sentences.length, missing };
}

/* How alike two pages' words are, 0 to 1 (shared runs of five words). */
export function textSimilarity(a: string, b: string): number {
  const shingles = (text: string) => {
    const list = words(stripLinks(text));
    const set = new Set<string>();
    for (let i = 0; i + 5 <= list.length; i++) set.add(list.slice(i, i + 5).join(" "));
    return set;
  };
  const x = shingles(a);
  const y = shingles(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const s of x) if (y.has(s)) shared++;
  return shared / (x.size + y.size - shared);
}

/* ---------- reading the whole site ---------- */

export interface FetchedText {
  /** The address that answered, after any redirects (for a blocked route's copy: the original address it stands for). */
  url: string;
  status: number;
  contentType: string;
  text: string;
  /** Where the answer came from: the live site, or the blocked route (site/blocked-route.ts). */
  readFrom?: "site" | "fallback";
  /** The copy's date (ISO), when the route gives one. */
  snapshotAt?: string;
  /** Which route gave it, when a chain of routes stands behind one seam ("jina", "zyte"). */
  via?: string;
}

/** Fetches one address politely (the worker's: public addresses only, a timeout and a size limit). null: it couldn't be read. */
export type SiteFetch = (url: string) => Promise<FetchedText | null>;

/** At most this many addresses from a blocked route's own list over the page limit are listed (a list can hold thousands). */
export const MAX_LIST_OVERFLOW = 50;

export class SiteImportError extends Error {
  /** The site blocks TAWD's server (a bot check or a refusal) and no route could read it. */
  blocked: boolean;
  constructor(message: string, blocked = false) {
    super(message);
    this.name = "SiteImportError";
    this.blocked = blocked;
  }
}

export interface CrawledPage {
  url: string;
  path: string;
  /** From the blog's post sitemap: an article. */
  fromPosts: boolean;
  extracted: ExtractedPage;
  readFrom?: "site" | "fallback";
  /** The blocked route's name, for a page it gave. */
  via?: string;
  snapshotAt?: string;
}

export interface CrawlResult {
  origin: string;
  host: string;
  /** Where the page list came from: the sitemap, the home page's menu, or a blocked route's own list of the site's pages (with the menu). */
  source: "sitemap" | "menu" | "fallback-list";
  /** The live home page was blocked and this route (its name) was read instead; null when the site was read as usual. */
  route: string | null;
  pages: CrawledPage[];
  skipped: { url: string; reason: string }[];
  /** Pages over the tier's limit, in the order they'd have been read. */
  notImported: string[];
  failed: { url: string; reason: string }[];
  /** Pages on the list that neither the live site nor the route could give (addresses). */
  gaps: string[];
  /** Links in the pages' words to addresses on the site that don't answer. */
  brokenLinks: { from: string; to: string; status: number | null }[];
  /** The home page's menu. */
  menu: { label: string; url: string }[];
  /** Requests made. */
  requests: number;
}

/** At most this many sitemap addresses are considered (F-008): the plan's work grows with them. */
export const MAX_PLAN_ADDRESSES = 5000;

/* How the cut's note starts. It sits in the left-out list the team sees, but it is a note, not an address: leftOutUrls skips it, so it never becomes a redirect. */
export const SITEMAP_CAP_NOTE = "The sitemap listed ";

/*
  The page list from the candidate addresses: which are pages, which are
  skipped and why. Linear (a Set of the skipped paths), where it used to
  scan the skipped list for every address.
*/
export function planCandidates(candidates: string[], host: string, origin: string, listFrom = Infinity): { skipped: CrawlResult["skipped"]; list: string[]; ownCount: number } {
  const skipped: CrawlResult["skipped"] = [];
  const skippedPaths = new Set<string>();
  const seen = new Set<string>(["/"]);
  const list: string[] = [`${origin}/`];
  /** How many of the list came from the site itself (sitemap or menu), before the route's own list. */
  let ownCount = 1;
  for (const [index, url] of candidates.entries()) {
    const fromList = index >= listFrom;
    const reason = skipReason(url, host);
    const path = importPath(url);
    if (reason) {
      if (!fromList && reason !== "Another website" && !skippedPaths.has(path)) {
        skippedPaths.add(path);
        skipped.push({ url, reason });
      }
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    list.push(`${origin}${path}`);
    if (!fromList) ownCount = list.length;
  }
  return { skipped, list, ownCount };
}

/** A live page that's gone (404 or 410) while reading through a blocked route: never brought back from it. */
export const GONE_FROM_LIVE = "No longer on the live site";

const isHtml = (r: FetchedText) => r.status >= 200 && r.status < 300 && (!r.contentType || /html/i.test(r.contentType));

/* Page sitemaps before the others, posts last. */
function sitemapRank(url: string): number {
  const kind = sitemapKind(url);
  return kind === "pages" ? 0 : kind === "other" ? 1 : kind === "posts" ? 2 : 3;
}

/*
  Reads the current site page by page, one request at a time, with a pause
  between them: the home page, then the sitemap (robots.txt's sitemaps,
  /sitemap_index.xml, /sitemap.xml, /wp-sitemap.xml; WordPress's page
  sitemap first and its post sitemap last, newest posts first), or the
  home page's menu when there is no sitemap. Same site only. Pages over
  the limit are listed, not read.

  A blocked site (0.94.0; one seam since 0.96.0, site/blocked-route.ts):
  when the live home page is a bot check and a route is given, the home
  page comes from the route and every later address is asked of the live
  site first, then of the route. A live 404 or 410 means the page is gone.
  After liveStopAfter blocked live answers in a row, the live site isn't
  asked again. With no sitemap, the list is the route's home menu, then
  the route's own list of the site's pages. A page nothing could give is
  a gap, listed for the team to paste its words. With no route, a blocked
  home page stops the read (SiteImportError, blocked).
*/
export async function crawlSite(
  siteUrl: string,
  options: {
    fetch: SiteFetch;
    maxPages: number;
    /** Blog articles read on top of maxPages (a makeover keeps them: KEPT_ARTICLE_LIMIT, 0.98.0). */
    extraArticles?: number;
    wait?: (ms: number) => Promise<void>;
    pauseMs?: number;
    maxSitemaps?: number;
    maxLinkChecks?: number;
    onProgress?: (step: string) => Promise<void> | void;
    /** The home page's answer, already fetched (the read asks it first, before the browser looks): not asked again. */
    home?: FetchedText | null;
    /** Read when the live home page is a bot check (blockedRouteFor, in the worker). */
    fallback?: BlockedRoute | null;
    /** The home page gave no answer and the caller treats that as blocked (Fable's review M5): this message, and the route's turn. */
    noAnswerBlocked?: string | null;
    /** Blocked live answers in a row before the live site isn't asked again (route mode). */
    liveStopAfter?: number;
    /** The live fetch once the site is known to block TAWD: a shorter timeout, so a host that holds connections doesn't stall the read. */
    blockedLiveFetch?: SiteFetch;
  },
): Promise<CrawlResult> {
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pause = options.pauseMs ?? 500;
  const liveStopAfter = options.liveStopAfter ?? 3;
  let requests = 0;
  /** Addresses asked of the route (the request count when the route doesn't count its own calls). */
  let routeAsks = 0;
  let route: BlockedRoute | null = null;
  const live = async (url: string) => {
    if (requests > 0) await wait(pause);
    requests++;
    return (route && options.blockedLiveFetch ? options.blockedLiveFetch : options.fetch)(url);
  };
  /** Blocked live answers in a row (route mode). */
  let streak = 0;
  const fromRoute = async (url: string): Promise<FetchedText | null> => {
    routeAsks++;
    const answer = await route!.fetch(url);
    return answer ? { ...answer, readFrom: "fallback" } : null;
  };
  /* Live first; in route mode, the route when the live answer is blocked (a live 404 or 410 is returned as it is). */
  const get = async (url: string): Promise<FetchedText | null> => {
    if (!route) return live(url);
    if (streak < liveStopAfter) {
      const answer = await live(url);
      if (answer && (answer.status === 404 || answer.status === 410)) return { ...answer, readFrom: "site" };
      if (answer && answer.status >= 200 && answer.status < 300 && !botCheck(answer)) {
        streak = 0;
        return { ...answer, readFrom: "site" };
      }
      streak++;
    }
    return fromRoute(url);
  };
  let start: URL;
  try {
    start = new URL(/^https?:\/\//i.test(siteUrl.trim()) ? siteUrl.trim() : `https://${siteUrl.trim()}`);
  } catch {
    throw new SiteImportError("The current website's address isn't a web address.");
  }
  let routeLine = "";
  const progress = async (step: string) => options.onProgress?.(routeLine ? `${routeLine} ${step}` : step);
  await progress("Reading the home page");
  const given = options.home !== undefined;
  let home = given ? options.home! : await live(`${start.origin}/`);
  if (given) requests++;
  const check = home ? botCheck(home) : null;
  const blockedWords = check ? blockedSiteMessage(start.href, check) : !home && options.noAnswerBlocked ? options.noAnswerBlocked : null;
  if (blockedWords) {
    // A bot check is never kept as the client's words. The blocked route's copy is read instead, when there is one.
    if (!options.fallback) throw new SiteImportError(blockedWords, true);
    route = options.fallback;
    streak = 1;
    routeLine = `${hostOf(start.href) ?? start.hostname} blocks TAWD's server: reading it through ${route.label}.`;
    await progress("Reading the home page");
    const copy = await fromRoute(`${start.origin}/`);
    if (!copy || botCheck(copy) || !isHtml(copy)) {
      throw new SiteImportError(`${blockedWords} ${route.label} couldn't read it either.`, true);
    }
    home = copy;
  }
  if (!home || !isHtml(home)) throw new SiteImportError(home ? `The home page answered ${home.status}.` : "The site couldn't be opened (no answer, or not a public address).");
  // The address the site really uses (https, www or not) after its redirects. A route's copy keeps the site's own scheme (only the host, www or not, is taken from it).
  const homeAt = new URL(home.url);
  const origin = home.readFrom === "fallback" && hostOf(home.url) === hostOf(start.href) ? `${start.protocol}//${homeAt.host}` : homeAt.origin;
  const host = hostOf(origin)!;
  const homeExtract = extractPage(home.text, `${origin}/`);

  await progress("Reading the sitemap");
  const robots = await get(`${origin}/robots.txt`);
  const sitemapQueue = [
    ...new Set([
      ...(robots && robots.status === 200 ? [...robots.text.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]!) : []),
      `${origin}/sitemap_index.xml`,
      `${origin}/sitemap.xml`,
      `${origin}/wp-sitemap.xml`,
    ]),
  ];
  const read = new Set<string>();
  const byKind: Record<"pages" | "posts" | "other", SitemapEntry[]> = { pages: [], posts: [], other: [] };
  let anySitemap = false;
  while (sitemapQueue.length && read.size < (options.maxSitemaps ?? 12)) {
    const next = sitemapQueue.shift()!;
    if (read.has(next) || hostOf(next) !== host) continue;
    const kind = sitemapKind(next);
    if (kind === "skip") continue;
    read.add(next);
    const answer = await get(next);
    if (!answer || answer.status !== 200 || !/<(urlset|sitemapindex)\b/i.test(answer.text)) continue;
    read.add(answer.url);
    const found = readSitemap(answer.text);
    if (found.sitemaps.length) {
      anySitemap = true;
      // An index lists the real sitemaps: the plain /sitemap.xml guesses are dropped, pages first.
      sitemapQueue.length = 0;
      sitemapQueue.push(...found.sitemaps.filter((s) => !read.has(s)).sort((a, b) => sitemapRank(a) - sitemapRank(b)));
      continue;
    }
    anySitemap = true;
    byKind[kind].push(...found.entries);
  }
  const fromPosts = new Set(byKind.posts.map((e) => importPath(e.url)));
  const posts = [...byKind.posts].sort((a, b) => (b.lastmod ?? "").localeCompare(a.lastmod ?? ""));
  let candidates = [...byKind.pages, ...byKind.other, ...posts].map((e) => e.url);
  let source: CrawlResult["source"] = "sitemap";
  /** Where the route's own list starts in the candidates (its addresses aren't noted as left out, and their overflow is capped). */
  let listFrom = Infinity;
  if (!anySitemap || candidates.length === 0) {
    source = "menu";
    candidates = homeExtract.menu.map((m) => m.url);
    if (route?.list) {
      // No sitemap, live or from the route: the route's home menu first, then the route's own list (blog posts the menu lacks).
      await progress(`Listing the site's pages through ${route.label}`);
      routeAsks++;
      const listed = await route.list(host);
      listFrom = candidates.length;
      const menuPaths = new Set(["/", ...candidates.map(importPath)]);
      if (listed.some((u) => !skipReason(u, host) && !menuPaths.has(importPath(u)))) source = "fallback-list";
      candidates = [...candidates, ...listed];
    }
  }

  /*
    A sitemap can list tens of thousands of addresses (F-008: 40,000 took 21
    minutes in a loop that froze the whole worker). Only the first
    MAX_PLAN_ADDRESSES are considered, and the team is told.
  */
  const sitemapListed = source === "sitemap" ? candidates.length : 0;
  let planNote: string | null = null;
  if (sitemapListed > MAX_PLAN_ADDRESSES) {
    /*
      The list runs pages, then other addresses (a shop's products), then
      posts. Keeping only the start dropped every post on a big shop (the
      batch D review), so the start and the end are kept and the middle goes.
    */
    const half = Math.floor(MAX_PLAN_ADDRESSES / 2);
    candidates = [...candidates.slice(0, half), ...candidates.slice(candidates.length - (MAX_PLAN_ADDRESSES - half))];
    planNote = `${SITEMAP_CAP_NOTE}${sitemapListed.toLocaleString("en-US")} addresses; the first ${half.toLocaleString("en-US")} and the last ${(MAX_PLAN_ADDRESSES - half).toLocaleString("en-US")} were considered.`;
  } else if (listFrom !== Infinity && candidates.length > listFrom + MAX_PLAN_ADDRESSES) {
    candidates = candidates.slice(0, listFrom + MAX_PLAN_ADDRESSES);
  }
  const { skipped, list, ownCount } = planCandidates(candidates, host, origin, listFrom);
  if (planNote) skipped.push({ url: `${origin}/sitemap.xml`, reason: planNote });
  const limit = Math.max(1, options.maxPages);
  const extra = Math.max(0, options.extraArticles ?? 0);
  /*
    A makeover's blog articles don't count toward the tier's limit (Jason,
    7 October 2026, 0.98.0): the other pages up to the limit, the articles
    (newest first) up to the extra plus any of the limit the pages left.
    An article is known by its address before it's read: a post sitemap's,
    or /blog/<name>/ and the like (importKind's own rule).
  */
  const articleUrl = (url: string) => fromPosts.has(importPath(url)) || articleAddress(importPath(url));
  let reading: Set<string>;
  if (extra > 0) {
    const others = list.filter((u) => !articleUrl(u)).slice(0, limit);
    const articles = list.filter(articleUrl).slice(0, extra + Math.max(0, limit - others.length));
    reading = new Set([...others, ...articles]);
  } else {
    reading = new Set(list.slice(0, limit));
  }
  const toRead = list.filter((u) => reading.has(u));
  // Over the limit: the site's own pages all listed; the route's list at most MAX_LIST_OVERFLOW.
  const own = new Set(list.slice(0, ownCount));
  const overflow = list.filter((u) => !reading.has(u));
  const notImported = [...overflow.filter((u) => own.has(u)), ...overflow.filter((u) => !own.has(u)).slice(0, MAX_LIST_OVERFLOW)];
  // A route may ask for the pages a few at a time (Jina: about 5 at once); crawlSite still takes them in order.
  route?.prefetch?.(toRead.slice(1));

  const where = (answer: FetchedText): Pick<CrawledPage, "readFrom" | "snapshotAt" | "via"> =>
    route
      ? { readFrom: answer.readFrom ?? "site", ...(answer.readFrom === "fallback" ? { via: answer.via ?? route.name } : {}), ...(answer.snapshotAt ? { snapshotAt: answer.snapshotAt } : {}) }
      : {};
  const pages: CrawledPage[] = [{ url: `${origin}/`, path: "/", fromPosts: false, extracted: homeExtract, ...where(home) }];
  const failed: CrawlResult["failed"] = [];
  const gaps: string[] = [];
  const readPaths = new Set<string>(["/"]);
  for (const [index, url] of toRead.entries()) {
    if (index === 0) continue;
    const path = importPath(url);
    await progress(`Reading page ${index + 1} of ${toRead.length}: ${path}`);
    const answer = await get(url);
    if (route && answer?.readFrom === "site" && (answer.status === 404 || answer.status === 410)) {
      skipped.push({ url, reason: GONE_FROM_LIVE });
      continue;
    }
    if (!answer) {
      if (route) gaps.push(url);
      else failed.push({ url, reason: "It couldn't be read (no answer, too big, or not a public address)." });
      continue;
    }
    if (botCheck(answer)) {
      failed.push({ url, reason: "The site's bot check answered instead of this page." });
      continue;
    }
    if (!isHtml(answer)) {
      failed.push({ url, reason: answer.status >= 400 ? `It answered ${answer.status}.` : "It isn't a web page." });
      continue;
    }
    const finalPath = importPath(answer.url);
    if (hostOf(answer.url) !== host || (finalPath !== path && readPaths.has(finalPath))) {
      skipped.push({ url, reason: `Redirects to ${hostOf(answer.url) !== host ? answer.url : finalPath}` });
      continue;
    }
    readPaths.add(finalPath);
    // A route's copy keeps the site's own address (its original, on the site's origin).
    const pageUrl = answer.readFrom === "fallback" ? `${origin}${finalPath}` : answer.url;
    pages.push({ url: pageUrl, path: finalPath, fromPosts: fromPosts.has(path), extracted: extractPage(answer.text, pageUrl), ...where(answer) });
  }

  // Links in the pages' words to addresses on the site that weren't read: are they there? Not through a route: a copy's links say nothing about the live site.
  const known = new Set<string>([...readPaths, ...skipped.map((s) => importPath(s.url)), ...notImported.map(importPath), ...gaps.map(importPath)]);
  const unknown = new Map<string, string>();
  for (const page of pages) {
    for (const link of page.extracted.links) {
      if (!link.internal) continue;
      const target = importPath(link.url);
      if (known.has(target) || unknown.has(target) || FILE_RE.test(target) || skipReason(link.url, host)) continue;
      unknown.set(target, page.path);
    }
  }
  const checked = new Map<string, number | null>();
  for (const target of [...unknown.keys()].slice(0, route ? 0 : (options.maxLinkChecks ?? 15))) {
    await progress(`Checking a link: ${target}`);
    const answer = await live(`${origin}${target}`);
    if (!answer || answer.status >= 400) checked.set(target, answer?.status ?? null);
  }
  // Every page that links to a broken address, not only the first one found.
  const brokenLinks: CrawlResult["brokenLinks"] = [];
  const brokenSeen = new Set<string>();
  for (const page of pages) {
    for (const link of page.extracted.links) {
      const target = importPath(link.url);
      if (!link.internal || !checked.has(target)) continue;
      const key = `${page.path}\u0000${target}`;
      if (brokenSeen.has(key)) continue;
      brokenSeen.add(key);
      brokenLinks.push({ from: page.path, to: target, status: checked.get(target)! });
    }
  }
  // Real calls: the live site's, plus the route's own count (cache hits aren't calls), or the addresses asked of it.
  const routeCalls = route ? (route.requests ? route.requests() : routeAsks) : 0;
  return { origin, host, source, route: route?.name ?? null, pages, skipped, notImported, failed, gaps, brokenLinks, menu: homeExtract.menu, requests: requests + routeCalls };
}

/* ---------- copies read through a blocked route; 0.94.0's Internet Archive rows ---------- */

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/* A copy's date: "13 May 2026" (long) or "13 May 2026" with the month cut to three letters (short). Dates are UTC. Kept for 0.94.0's Internet Archive rows and drafts. */
export function archiveDate(iso: string, style: "long" | "short" = "long"): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const month = MONTH_NAMES[d.getUTCMonth()]!;
  return `${d.getUTCDate()} ${style === "short" ? month.slice(0, 3) : month} ${d.getUTCFullYear()}`;
}

/** A copy older than this many months is used but marked amber (Jason, 7 October 2026). */
export const ARCHIVE_OLD_MONTHS = 6;

/* Whole months between a copy's date and now. */
export function monthsOld(iso: string, at = Date.now()): number {
  const d = new Date(iso);
  const now = new Date(at);
  let months = (now.getUTCFullYear() - d.getUTCFullYear()) * 12 + (now.getUTCMonth() - d.getUTCMonth());
  if (now.getUTCDate() < d.getUTCDate()) months--;
  return Math.max(0, months);
}

export const isOldCopy = (iso: string | undefined, at = Date.now()) => Boolean(iso) && monthsOld(iso!, at) >= ARCHIVE_OLD_MONTHS;

/* The kept draft of a page nothing could read: a visible placeholder, so the site can't go live until its words are pasted or the page removed. */
export function gapPlaceholder(path: string): string {
  return `[PLACEHOLDER: the words of ${path} (TAWD couldn't read this page: the live site blocks TAWD and no other source had it). Paste them here or remove the page.]`;
}
