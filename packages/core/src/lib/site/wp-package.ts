import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";
import { readDesign } from "./design-md";
import { cf7MailBody, formShortcode, htmlToBlocks, type BlockStats, type WpForm } from "./wp-blocks";
import { themeSlug, wordpressTheme } from "./wordpress";
import { WP_INSTALL_PHP } from "./wp-install";
import { headerMenu, type WpMenu } from "./wp-menu";
import { SPEED_IMAGES_FILE, stripSpeedForBlocks } from "./speed-tags";
import { formatPhonesInHtml } from "../phone";
import { describeChanges, passOverPage } from "./kept-page";

/*
  Build B, B1 (1 October 2026): the WordPress package. Everything a
  WordPress site needs to be the client's Build A site, made by code from
  the build's own files (no AI, no cost): the client's block theme, every
  page as blocks, the Contact Form 7 forms, Rank Math's titles and
  descriptions, the business details, the images, the redirects, and
  install.php, which sets it all up inside WordPress (wp eval-file
  install.php). B2 runs the same installer over SSH (on 20i since 5 October 2026); before
  that, the package is tried in a real WordPress on the laptop
  (WordPress Playground).
*/

export interface WpPackagePage {
  /** "/" or "/drain-cleaning/". */
  path: string;
  slug: string;
  /** The parent page's path, for a page below another; null at the top. */
  parent: string | null;
  /** The page's name in WordPress's page list. */
  title: string;
  /** The <title> Build A gives it (Rank Math's title). */
  seoTitle: string;
  description: string;
  focusKeyword: string;
  /** The page's file in the package. */
  file: string;
  /** Build A's classes on the page's <main>. */
  mainClass: string;
  /** The LocalBusiness details (JSON), on Home and Contact. */
  schema: string;
  order: number;
  stats: BlockStats;
}

export interface WpPackageManifest {
  tawd: 1;
  client: string;
  buildVersion: number;
  theme: string;
  mode: "preview" | "live";
  pages: WpPackagePage[];
  forms: (Pick<WpForm, "name" | "template" | "fields" | "look" | "htmlClass"> & { subject: string; mailBody: string; replyTo: string | null; attachments?: string })[];
  /** "cf7" or "gravityforms": which plugin install.php makes the forms in. */
  formPlugin: "cf7" | "gravityforms";
  formEmails: { to: string[]; copy: string | null };
  /** The build's pictures and other files, by path ("images/home/hero.jpg"). */
  media: string[];
  redirects: { from: string; to: string; code: number }[];
  /** The header's menu as a WordPress menu (null: no nav TAWD could read for certain; the header keeps its HTML). */
  menu: WpMenu | null;
  /** The speed pass's picture sizes, by the picture's address: the theme gives picture blocks their srcset and sizes. */
  srcsets: Record<string, { set: { w: number; url: string }[]; dw: number; pw: number }>;
  notes: string[];
}

export interface WpPackageReport {
  pages: number;
  native: number;
  html: number;
  forms: number;
  media: number;
  redirects: number;
  notes: string[];
}

export interface WpPackageInput {
  clientName: string;
  buildVersion: number;
  /** The build's files as Netlify serves them ("index.html", "about/index.html", "site.css", "images/a.jpg"). */
  files: Map<string, Uint8Array>;
  /** The site plan, when TAWD has it: each page's name, place in the menu and main keyword. */
  plan?: { path: string; name: string; order: number; mainKeyword?: string }[];
  formEmails: { to: string[]; copy: string | null };
  /** B3: "live" once the site is live (installing it again keeps it open to search engines). */
  mode?: "preview" | "live";
  /** The form plugin (1 October 2026): Contact Form 7 (the default) or Gravity Forms (VML's licence). */
  formPlugin?: "cf7" | "gravityforms";
}

export class WpPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WpPackageError";
  }
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/* The files that are Netlify's or Build A's own and not part of the WordPress site. */
const NOT_MEDIA = new Set(["site.css", "robots.txt", "_headers", "_redirects", "sitemap.xml"]);

const isElement = (node: ChildNode): node is Element => node.type === "tag" || node.type === "script" || node.type === "style";
const sourceOf = (html: string, node: ChildNode) => html.slice(node.startIndex!, node.endIndex! + 1);

/* Build A's head tags that WordPress (or Rank Math, or the theme) writes itself. */
function writtenByWordPress(el: Element): boolean {
  const a = el.attribs;
  if (el.name === "title") return true;
  if (el.name === "meta") return Boolean(a.charset) || ["viewport", "description", "robots"].includes((a.name ?? "").toLowerCase()) || /^(og|twitter):/i.test(a.property ?? a.name ?? "");
  if (el.name === "link") {
    const rel = (a.rel ?? "").toLowerCase();
    return rel === "canonical" || /^\/site\.css/.test(a.href ?? "") || /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(a.href ?? "");
  }
  if (el.name === "script") return (a.type ?? "").toLowerCase() === "application/ld+json";
  return false;
}

const textOf = (node: ChildNode): string => (node.type === "text" ? node.data : isElement(node) ? node.children.map(textOf).join("") : "");

interface PageParts {
  title: string;
  description: string;
  schema: string;
  headExtras: string;
  fontLinks: string[];
  mainClass: string;
  main: string;
  before: string;
  after: string;
}

/* A built page, taken apart: its head, the parts before and after <main>, and <main>'s contents. */
export function pageParts(html: string): PageParts {
  const doc = parseDocument(html, { withStartIndices: true, withEndIndices: true, decodeEntities: true });
  const find = (nodes: ChildNode[], name: string): Element | null => {
    for (const n of nodes) {
      if (!isElement(n)) continue;
      if (n.name === name) return n;
      const inside = find(n.children, name);
      if (inside) return inside;
    }
    return null;
  };
  const head = find(doc.children, "head");
  const body = find(doc.children, "body");
  const main = body ? find(body.children, "main") : null;
  if (!body || !main) throw new WpPackageError("A page has no <main>.");
  const headEls = (head?.children ?? []).filter(isElement);
  const title = textOf(headEls.find((e) => e.name === "title") ?? doc).trim();
  const description = headEls.find((e) => e.name === "meta" && (e.attribs.name ?? "").toLowerCase() === "description")?.attribs.content ?? "";
  const schema = headEls.find((e) => e.name === "script" && (e.attribs.type ?? "").toLowerCase() === "application/ld+json");
  const fontLinks = headEls.filter((e) => e.name === "link" && /^https:\/\/fonts\.googleapis\.com\//.test(e.attribs.href ?? "")).map((e) => sourceOf(html, e));
  const headExtras = headEls.filter((e) => !writtenByWordPress(e)).map((e) => sourceOf(html, e)).join("\n");

  // What's around <main> at the top of the body (a <main> inside a wrapper takes the wrapper's place).
  let top: ChildNode = main;
  while (top.parent && top.parent !== body) top = top.parent as ChildNode;
  const bodyStart = body.children[0]?.startIndex ?? top.startIndex!;
  const bodyEnd = (body.children.at(-1)?.endIndex ?? top.endIndex!) + 1;
  const mainInner = main.children.length ? html.slice(main.children[0]!.startIndex!, main.children.at(-1)!.endIndex! + 1) : "";
  return {
    title,
    description,
    schema: schema ? textOf(schema).trim() : "",
    headExtras,
    fontLinks,
    mainClass: (main.attribs.class ?? "").trim(),
    main: mainInner,
    before: html.slice(bodyStart, main.startIndex!),
    after: html.slice(main.endIndex! + 1, bodyEnd),
  };
}

/* What follows <main>: the footer (up to the last <footer>), then what comes after it (the consent banner). */
export function splitAfterMain(after: string): { footer: string; bodyEnd: string } {
  const doc = parseDocument(after, { withStartIndices: true, withEndIndices: true });
  const lastFooter = [...doc.children].reverse().find((n) => isElement(n) && n.name === "footer");
  if (!lastFooter) return { footer: after.trim(), bodyEnd: "" };
  return { footer: after.slice(0, lastFooter.endIndex! + 1).trim(), bodyEnd: after.slice(lastFooter.endIndex! + 1).trim() };
}

/* "index.html" → "/", "about/index.html" → "/about/"; anything else isn't a page. */
export function pathOfFile(file: string): string | null {
  if (file === "index.html") return "/";
  const m = /^((?:[^/]+\/)*[^/]+)\/index\.html$/.exec(file);
  return m ? `/${m[1]}/` : null;
}

const fileOfPath = (path: string) => `content/pages/${path === "/" ? "home" : path.replace(/^\/|\/$/g, "").replace(/\//g, "--")}.html`;

/* The speed pass's picture sizes (an older build has none). */
function readSrcsets(text: string | null): WpPackageManifest["srcsets"] {
  if (!text) return {};
  try {
    const json = JSON.parse(text) as Record<string, { set?: { w: number; url: string }[]; dw?: number; pw?: number }>;
    return Object.fromEntries(Object.entries(json).filter(([, v]) => Array.isArray(v.set)).map(([k, v]) => [k, { set: v.set!, dw: Number(v.dw) || 0, pw: Number(v.pw) || 0 }]));
  } catch {
    return {};
  }
}

/*
  Netlify's _redirects ("/old /new 301") as the redirects WordPress gets. A rule that matches a query string
  ("/ page_id=12 /new 301") comes back with its from as "/?page_id=12": the WordPress installer cannot match a
  query string with a path rule, so it skips that one and says so (it never reads "page_id=12" as an address).
*/
export function readRedirects(text: string): { from: string; to: string; code: number }[] {
  const out: { from: string; to: string; code: number }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2 || !parts[0]!.startsWith("/")) continue;
    const dest = parts.findIndex((p, i) => i > 0 && (p.startsWith("/") || /^https?:\/\//.test(p)));
    if (dest < 0) {
      // No destination at all: the old reading kept the second word as the address, and the installer skipped it.
      out.push({ from: parts[0]!, to: parts[1]!, code: /^30[1278]$/.test(parts[2] ?? "") ? Number(parts[2]) : 301 });
      continue;
    }
    const query = parts.slice(1, dest).join("&");
    out.push({ from: query ? `${parts[0]}?${query}` : parts[0]!, to: parts[dest]!, code: /^30[1278]$/.test(parts[dest + 1] ?? "") ? Number(parts[dest + 1]) : 301 });
  }
  return out;
}

/*
  The package, as files by path. The same build always gives the same
  package.
*/
export function wordpressPackage(input: WpPackageInput): { files: Map<string, Uint8Array>; manifest: WpPackageManifest; report: WpPackageReport } {
  // A page's phone numbers as "(916) 555-0142", also for builds made before Build A wrote them that way (6 October 2026).
  const notes: string[] = [];
  // A supplied home page is kept: its own words are not reformatted (here as in Build A), and what would have changed is told.
  const text = (name: string) => {
    const bytes = input.files.get(name);
    if (!bytes) return null;
    if (!name.endsWith(".html")) return decoder.decode(bytes);
    const passed = passOverPage(decoder.decode(bytes), (page) => formatPhonesInHtml(page));
    // text() reads a page more than once; the note is told once.
    const note = `${name}: the supplied page is kept as it is. Phone layout: ${describeChanges(passed.wouldChange)}.`;
    if (passed.wouldChange.length && !notes.includes(note)) notes.push(note);
    return passed.html;
  };
  const home = text("index.html");
  if (!home) throw new WpPackageError("The build has no home page.");
  const siteCss = text("site.css") ?? "";
  const homeParts = pageParts(home);
  const { footer, bodyEnd } = splitAfterMain(homeParts.after);
  // The header's menus become one WordPress menu where TAWD can read them for certain (VML's dev team, 1 October 2026).
  const pagePaths = new Set([...input.files.keys()].map(pathOfFile).filter((p): p is string => p !== null));
  const menu = headerMenu(homeParts.before, pagePaths);
  notes.push(...menu.notes);
  const header = htmlToBlocks(menu.header);
  const footerBlocks = htmlToBlocks(footer);
  const forms: WpForm[] = [];
  /*
    One Contact Form 7 form per different form: Build A calls most of them
    "contact", but the Contact page's can ask other things than the home
    page's. The same form on many pages is one form; a different one gets
    its own name ("contact-2"), and the page's shortcode follows.
  */
  const nameForms = (markup: string, found: WpForm[]): string => {
    let out = markup;
    for (const form of found) {
      const same = forms.find((f) => f.template === form.template && f.htmlClass === form.htmlClass && f.htmlId === form.htmlId);
      if (same) {
        out = out.replace(formShortcode(form), formShortcode(same));
        continue;
      }
      let name = form.name;
      for (let n = 2; forms.some((f) => f.name === name); n += 1) name = `${form.name}-${n}`;
      const named = { ...form, name };
      out = out.replace(formShortcode(form), formShortcode(named));
      forms.push(named);
    }
    return out;
  };
  header.markup = nameForms(header.markup, header.forms);
  footerBlocks.markup = nameForms(footerBlocks.markup, footerBlocks.forms);

  const planned = new Map((input.plan ?? []).map((p) => [p.path, p]));
  const pages: WpPackagePage[] = [];
  const pageFiles = new Map<string, string>();
  const paths = [...input.files.keys()].map((file) => ({ file, path: pathOfFile(file) })).filter((f): f is { file: string; path: string } => f.path !== null);
  const known = new Set(paths.map((p) => p.path));
  for (const { file, path } of paths.sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = pageParts(text(file)!);
    const made = htmlToBlocks(stripSpeedForBlocks(parts.main));
    made.markup = nameForms(made.markup, made.forms);
    const segments = path.split("/").filter(Boolean);
    const parentPath = segments.length > 1 ? `/${segments.slice(0, -1).join("/")}/` : null;
    if (parentPath && !known.has(parentPath)) notes.push(`${path} sits below ${parentPath}, which isn't a page: it's made at the top level instead.`);
    const plan = planned.get(path);
    const name = plan?.name || parts.title.split(/\s+[|–—-]\s+/)[0]!.trim() || (path === "/" ? "Home" : segments.at(-1)!);
    pages.push({
      path,
      slug: path === "/" ? "home" : segments.at(-1)!,
      parent: parentPath && known.has(parentPath) ? parentPath : null,
      title: name,
      seoTitle: parts.title,
      description: parts.description,
      focusKeyword: plan?.mainKeyword ?? "",
      file: fileOfPath(path),
      mainClass: parts.mainClass,
      schema: parts.schema,
      order: plan?.order ?? (path === "/" ? 0 : 100 + pages.length),
      stats: made.stats,
    });
    pageFiles.set(fileOfPath(path), made.markup);
  }

  let notFound: string | undefined;
  const missing = text("404.html");
  if (missing) {
    const made = htmlToBlocks(pageParts(missing).main);
    notFound = nameForms(made.markup, made.forms);
  }
  if (!known.has("/thank-you/") && forms.length) notes.push("The build has no thank-you page: after a message is sent, people see Contact Form 7's own message.");
  for (const f of forms) notes.push(...f.notes.map((n) => `Form "${f.name}": ${n}`));
  if (forms.length === 0) notes.push("No contact form on the site.");

  const design = readDesign(`<style>${siteCss}</style>`);
  const slug = themeSlug(input.clientName);
  const theme = wordpressTheme({
    clientName: input.clientName,
    buildVersion: input.buildVersion,
    siteCss,
    fontLinks: homeParts.fontLinks,
    design,
    parts: input.formPlugin === "gravityforms" ? { header: gravityShortcodes(header.markup), footer: gravityShortcodes(footerBlocks.markup) } : { header: header.markup, footer: footerBlocks.markup },
    notFound: notFound && input.formPlugin === "gravityforms" ? gravityShortcodes(notFound) : notFound,
    headExtras: homeParts.headExtras,
    bodyEnd,
  });

  const media = [...input.files.keys()].filter((f) => !f.endsWith(".html") && !NOT_MEDIA.has(f) && !f.startsWith("_")).sort();
  const redirects = readRedirects(text("_redirects") ?? "");
  const uniqueForms = forms;

  const manifest: WpPackageManifest = {
    tawd: 1,
    client: input.clientName,
    buildVersion: input.buildVersion,
    theme: slug,
    mode: input.mode ?? "preview",
    formPlugin: input.formPlugin ?? "cf7",
    pages,
    forms: uniqueForms.map((f) => ({
      name: f.name,
      template: f.template,
      fields: f.fields,
      look: f.look,
      htmlClass: f.htmlClass,
      subject: `A new message from the ${input.clientName} website`,
      mailBody: cf7MailBody(f, input.clientName),
      replyTo: f.fields.find((x) => x.type === "email")?.name ?? null,
      // F1: a photo the visitor sent goes with the email.
      attachments: f.fields.filter((x) => x.type === "file").map((x) => `[${x.name}]`).join("\n"),
    })),
    formEmails: input.formEmails,
    media,
    redirects,
    menu: menu.menu,
    srcsets: readSrcsets(text(SPEED_IMAGES_FILE)),
    notes,
  };

  const files = new Map<string, Uint8Array>();
  const put = (path: string, value: string) => files.set(path, encoder.encode(value));
  put("manifest.json", `${JSON.stringify(manifest, null, "\t")}\n`);
  put("install.php", WP_INSTALL_PHP);
  for (const [path, value] of Object.entries(theme)) put(`theme/${slug}/${path}`, value);
  // Gravity Forms: the same place on the page, its own shortcode (install.php puts the real form id in, as for Contact Form 7).
  const shortcodes = (markup: string) => (manifest.formPlugin === "gravityforms" ? gravityShortcodes(markup) : markup);
  for (const [path, value] of pageFiles) put(path, `${shortcodes(value)}\n`);
  for (const path of media) files.set(`media/${path}`, input.files.get(path)!);

  const totals = pages.reduce((t, p) => ({ native: t.native + p.stats.native, html: t.html + p.stats.html }), { native: 0, html: 0 });
  const report: WpPackageReport = { pages: pages.length, native: totals.native, html: totals.html, forms: uniqueForms.length, media: media.length, redirects: redirects.length, notes };
  put("README.txt", readme(input.clientName, input.buildVersion, report, manifest.formPlugin, manifest.menu !== null));
  return { files, manifest, report };
}

function readme(client: string, version: number, report: WpPackageReport, formPlugin: "cf7" | "gravityforms", menu: boolean): string {
  const plugin = formPlugin === "gravityforms" ? "Gravity Forms" : "Contact Form 7";
  return `${client}: the WordPress package (Build B), made by TAWD from Build A version ${version}.

This isn't a whole WordPress site: it's the client's theme, pages, pictures, forms and settings, with an installer that puts them into a WordPress you already have. On 20i, TAWD does all of this itself (Build page, Hosting, Deploy the WordPress preview). These steps are for setting it up by hand, for example on a laptop.

What's inside
- theme/: the client's block theme (no page builder, no third-party theme).
- content/pages/: each page as WordPress blocks. ${report.native} native blocks, ${report.html} parts kept exactly as built (Custom HTML blocks).
- media/: the site's pictures and files (${report.media}).
- manifest.json: the pages, titles and descriptions, ${report.forms} ${plugin} form${report.forms === 1 ? "" : "s"}, ${menu ? "the menu, " : ""}${report.redirects} redirect${report.redirects === 1 ? "" : "s"}.
- install.php: sets the site up inside WordPress.

What it needs
- WordPress 7.1 or later (TAWD's sites run 7.1.2) and PHP 8.1 or later.
- Apache with mod_rewrite (XAMPP has it), so every page's address opens.
- ${plugin}${formPlugin === "gravityforms" ? " (VML's licence)" : ""}, installed and active, for the forms. Rank Math (SEO) is optional.
- WP-CLI, WordPress's command-line tool (one file, wp-cli.phar): https://wp-cli.org

On a laptop with XAMPP (Windows)
1. WordPress: download it from https://wordpress.org/download/ and unzip it into C:\\xampp\\htdocs\\<name>. Make an empty database in phpMyAdmin (http://localhost/phpmyadmin/), then open http://localhost/<name>/ and finish WordPress's own setup. A folder like this is fine: the installer fixes the site's links and addresses for it.
2. Plugins: in WordPress, Plugins, install and activate ${plugin}${formPlugin === "gravityforms" ? " (upload VML's zip)" : ""} (and Rank Math).
3. WP-CLI: download https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar into C:\\xampp.
4. Unzip this package, open PowerShell in its folder and run, as one line:
   C:\\xampp\\php\\php.exe C:\\xampp\\wp-cli.phar eval-file install.php --path=C:\\xampp\\htdocs\\<name>
5. Open http://localhost/<name>/.

Anywhere else (WP-CLI installed as "wp"), from this folder:
  wp eval-file install.php --path=<the WordPress folder>
${menu ? `
The menu
The header's menu is a normal WordPress menu, "Main menu" (Appearance, Menus). The desktop and the phone menus both show it, in the site's design: change it once and both follow. Top-level items only.
` : ""}
Running it again
Safe: it updates the pages, pictures and forms it made before and leaves everything else alone. What the team changed in WordPress is kept: the header, the footer and templates edited in the Site Editor, and the Main menu. To replace those with TAWD's versions, add "reset" after install.php:
  wp eval-file install.php reset --path=<the WordPress folder>

The site stays hidden from search engines until go-live.
${report.notes.length ? `\nTo check\n${report.notes.map((n) => `- ${n}`).join("\n")}\n` : ""}`;
}

/*
  [contact-form-7 id="tawd-form:contact" title="contact" ...] becomes
  [gravityform id="tawd-form:contact" title="false" description="false" ajax="true"]:
  the form's place on the page stays, its class goes on Gravity Forms' form.
*/
export function gravityShortcodes(markup: string): string {
  return markup.replace(/\[contact-form-7 id="(tawd-form:[\w-]+)"[^\]]*\]/g, (_m, token: string) => `[gravityform id="${token}" title="false" description="false" ajax="true"]`);
}
