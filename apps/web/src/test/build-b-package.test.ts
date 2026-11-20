import { describe, expect, it } from "vitest";
import { parse } from "@wordpress/block-serialization-default-parser";

/*
  Build B, B1 (1 October 2026): the WordPress package, made by code from a
  Build A build. The pages become native blocks where the code can map
  them exactly and Custom HTML blocks where it can't; WordPress's own
  block parser reads every one; forms become Contact Form 7's; the
  package carries the theme, the pages, the pictures, the redirects and
  the installer.
*/

import { blockAttrs, headerMenu, htmlToBlocks, pageParts, readRedirects, wordpressPackage, wordpressTheme, readDesign } from "@tawd/core/site";

type Parsed = ReturnType<typeof parse>[number];
const real = (blocks: Parsed[]) => blocks.filter((b) => b.blockName !== null);
const names = (blocks: Parsed[]): string[] => real(blocks).flatMap((b) => [b.blockName!, ...names(b.innerBlocks)]);

describe("pages as blocks", () => {
  it("maps headings, paragraphs, lists, figures and sections to native blocks, exactly as WordPress writes them", () => {
    const html = `<section class="hero" aria-labelledby="h"><h1 id="h" class="big">Drain <em>cleaning</em></h1><p class="lead">Same day.</p><ul class="ticks"><li>Fast</li><li><strong>Fair</strong></li></ul><figure class="pic"><img src="/images/a.jpg" alt="A van"></figure></section><h2>Why us</h2>`;
    const { markup, stats } = htmlToBlocks(html);
    const parsed = parse(markup);
    expect(names(parsed)).toEqual(["core/group", "core/heading", "core/paragraph", "core/list", "core/list-item", "core/list-item", "core/image", "core/heading"]);
    expect(stats).toEqual({ native: 8, html: 0, forms: 0 });
    const group = real(parsed)[0]!;
    // The section keeps its name for screen readers, as the heading's words.
    expect(group.attrs).toEqual({ tagName: "section", className: "hero", ariaLabel: "Drain cleaning", layout: { type: "default" } });
    expect(markup).toContain('<section class="wp-block-group hero" aria-label="Drain cleaning">');
    expect(markup).toContain('<!-- wp:heading {"level":1,"className":"big","anchor":"h"} -->\n<h1 class="wp-block-heading big" id="h">Drain <em>cleaning</em></h1>');
    expect(markup).toContain('<ul class="wp-block-list ticks"><!-- wp:list-item -->\n<li>Fast</li>');
    expect(markup).toContain('<figure class="wp-block-image pic"><img src="/images/a.jpg" alt="A van"/></figure>');
    // Level 2 is the heading block's default, so it isn't written.
    expect(markup).toContain("<!-- wp:heading -->\n<h2 class=\"wp-block-heading\">Why us</h2>");
  });

  it("keeps what it can't map exactly as it was, in Custom HTML blocks", () => {
    const svg = `<svg class="i" viewBox="0 0 24 24"><path d="M0 0h24"/></svg>`;
    const styled = `<div style="color:red"><p>Hot</p></div>`;
    const button = `<a class="btn" href="tel:+15555550100">Call</a>`;
    const { markup, stats } = htmlToBlocks(`<section class="band">${svg}<p>Text</p>${styled}${button}</section>`);
    const group = real(parse(markup))[0]!;
    const inner = real(group.innerBlocks);
    expect(inner.map((b) => b.blockName)).toEqual(["core/html", "core/paragraph", "core/html", "core/html"]);
    // Word for word: the parser hands back exactly the original markup.
    expect(inner[0]!.innerHTML.trim()).toBe(svg);
    expect(inner[2]!.innerHTML.trim()).toBe(styled);
    expect(inner[3]!.innerHTML.trim()).toBe(button);
    expect(stats).toEqual({ native: 2, html: 3, forms: 0 });
  });

  it("keeps a whole section as one HTML block when nothing in it maps", () => {
    const { markup, stats } = htmlToBlocks(`<div class="paws"><svg viewBox="0 0 1 1"></svg><svg viewBox="0 0 1 1"></svg></div>`);
    expect(names(parse(markup))).toEqual(["core/html"]);
    expect(stats).toEqual({ native: 0, html: 1, forms: 0 });
  });

  it("doesn't let loose text, odd attributes or unknown formatting into native blocks", () => {
    for (const html of [`<div class="x">Loose <p>text</p></div>`, `<p data-x="1">Hi</p>`, `<h2>An <img src="/a.png" alt=""> icon</h2>`, `<p>A <a href="javascript:alert(1)">link</a></p>`, `<section aria-labelledby="missing"><p>x</p></section>`]) {
      expect(names(parse(htmlToBlocks(html).markup)), html).toEqual(["core/html"]);
    }
  });

  it("writes block settings so nothing in them can end the comment", () => {
    expect(blockAttrs({ className: "a--b", anchor: undefined, ariaLabel: "<x> & \"y\"" })).toBe(' {"className":"a\\u002d\\u002db","ariaLabel":"\\u003cx\\u003e \\u0026 \\u0022y\\u0022"}');
    expect(blockAttrs({ className: "" })).toBe("");
    const { markup } = htmlToBlocks(`<p class="a--b">x</p>`);
    expect(real(parse(markup))[0]!.attrs).toEqual({ className: "a--b" });
  });

  it("makes FAQ questions Details blocks", () => {
    const { markup } = htmlToBlocks(`<details class="faq"><summary>Do you work weekends?</summary><p>Yes.</p></details>`);
    expect(names(parse(markup))).toEqual(["core/details", "core/paragraph"]);
    expect(markup).toContain('<details class="wp-block-details faq"><summary>Do you work weekends?</summary>');
  });
});

const FORM = `<form name="contact" method="POST" action="/thank-you/" data-netlify="true" netlify-honeypot="bot-field" class="quote-form"><input type="hidden" name="form-name" value="contact" /><p class="tawd-honeypot" hidden><label>Leave this empty: <input name="bot-field" /></label></p><div class="field"><label for="f-name">Name</label><input id="f-name" name="name" required autocomplete="name"></div><div class="field"><label for="f-email">Email</label><input id="f-email" type="email" name="email" placeholder="you@example.com"></div><label for="f-msg">Message</label><textarea id="f-msg" name="message" required></textarea><input type="range" name="budget"><button type="submit" class="btn">Send message</button></form>`;

describe("forms", () => {
  it("become Contact Form 7 forms: the same markup, each field a form tag, Netlify's extras gone", () => {
    const { markup, forms, stats } = htmlToBlocks(`<section class="contact"><h2>Get a quote</h2>${FORM}</section>`);
    expect(names(parse(markup))).toEqual(["core/group", "core/heading", "core/shortcode"]);
    expect(markup).toContain('[contact-form-7 id="tawd-form:contact" title="contact" html_class="quote-form"]');
    expect(stats.forms).toBe(1);
    const form = forms[0]!;
    expect(form.template).toBe(
      '<div class="field"><label for="f-name">Name</label>[text* name id:f-name autocomplete:name]</div><div class="field"><label for="f-email">Email</label>[email email id:f-email placeholder "you@example.com"]</div><label for="f-msg">Message</label>[textarea* message 20x2 id:f-msg][submit class:btn "Send message"]',
    );
    expect(form.fields).toEqual([
      { name: "name", label: "Name", type: "text", required: true },
      { name: "email", label: "Email", type: "email", required: false },
      { name: "message", label: "Message", type: "textarea", required: true },
    ]);
    // How Build A dressed it, for Gravity Forms.
    expect(form.look).toEqual({ wrapper: "field", label: "", input: "", button: "btn", buttonText: "Send message" });
    // A field Contact Form 7 can't take is named, not silently dropped.
    expect(form.notes).toEqual(['A "range" field (budget) isn\'t carried over; add it in Contact Form 7 by hand.']);
  });

  it("still become Contact Form 7's inside a part kept as HTML (WordPress runs shortcodes there too)", () => {
    const { markup, forms } = htmlToBlocks(`<div style="padding:8px">${FORM}</div>`);
    const html = real(parse(markup))[0]!;
    expect(html.blockName).toBe("core/html");
    expect(html.innerHTML.trim()).toBe('<div style="padding:8px">[contact-form-7 id="tawd-form:contact" title="contact" html_class="quote-form"]</div>');
    expect(forms).toHaveLength(1);
  });
});

const enc = (text: string) => new TextEncoder().encode(text);
const page = (title: string, main: string, extraHead = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><meta name="description" content="About ${title}, a plumber in Sacramento."><link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;700&amp;display=swap" rel="stylesheet"><link rel="stylesheet" href="/site.css"><link rel="canonical" href="https://example.com/" /><meta property="og:title" content="${title}" />${extraHead}</head><body><header class="site-header"><a class="skip" href="#main">Skip to content</a><nav><a href="/">Home</a></nav></header><main id="main" class="page-x">${main}</main><footer class="site-footer"><p>Website by Velocity Media Lab</p></footer><div id="tawd-consent" hidden>Cookies?</div><script>window.tawdConsent=1</script></body></html>`;

function build(): Map<string, Uint8Array> {
  return new Map([
    ["index.html", enc(page("Harbor Plumbing | Sacramento", `<section class="hero"><h1>Harbor Plumbing</h1><figure><img src="/images/hero.jpg" alt="A van"></figure></section>`, `<script type="application/ld+json">{"@type":"Plumber","name":"Harbor"}</script><script src="https://www.googletagmanager.com/gtag/js?id=G-1" data-consent="analytics"></script>`))],
    ["services/index.html", enc(page("Services | Harbor Plumbing", `<h1>Services</h1>`))],
    ["services/drains/index.html", enc(page("Drain cleaning | Harbor Plumbing", `<h1>Drain cleaning</h1>`))],
    ["contact/index.html", enc(page("Contact | Harbor Plumbing", `<h1>Contact</h1>${FORM}`))],
    ["thank-you/index.html", enc(page("Thanks", `<h1>Thanks</h1>`))],
    ["404.html", enc(page("Not found", `<h1>We can't find that page</h1>`))],
    ["site.css", enc(".hero{padding:80px 0}body{color:#111111;background:#ffffff}")],
    ["images/hero.jpg", new Uint8Array([1, 2, 3])],
    ["robots.txt", enc("User-agent: *\nDisallow: /\n")],
    ["_headers", enc("/*\n  X-Robots-Tag: noindex\n")],
    ["_redirects", enc("# old site\n/old-drains /services/drains/ 301\n/about-us.html /\n")],
  ]);
}

describe("the package", () => {
  it("carries the theme, every page, the forms, the pictures, the redirects and the installer", () => {
    const { files, manifest, report } = wordpressPackage({
      clientName: "Harbor Plumbing",
      buildVersion: 4,
      files: build(),
      plan: [{ path: "/services/drains/", name: "Drain cleaning", order: 3, mainKeyword: "drain cleaning sacramento" }],
      formEmails: { to: ["owner@harbor.example"], copy: "sites@vml.example" },
    });
    expect([...files.keys()].sort()).toEqual([
      "README.txt",
      "content/pages/contact.html",
      "content/pages/home.html",
      "content/pages/services--drains.html",
      "content/pages/services.html",
      "content/pages/thank-you.html",
      "install.php",
      "manifest.json",
      "media/images/hero.jpg",
      "theme/tawd-harbor-plumbing/functions.php",
      "theme/tawd-harbor-plumbing/inc/body-end.html",
      "theme/tawd-harbor-plumbing/inc/head.html",
      "theme/tawd-harbor-plumbing/parts/footer.html",
      "theme/tawd-harbor-plumbing/parts/header.html",
      "theme/tawd-harbor-plumbing/style.css",
      "theme/tawd-harbor-plumbing/templates/404.html",
      "theme/tawd-harbor-plumbing/templates/front-page.html",
      "theme/tawd-harbor-plumbing/templates/index.html",
      "theme/tawd-harbor-plumbing/templates/page.html",
      "theme/tawd-harbor-plumbing/theme.json",
    ]);
    const drains = manifest.pages.find((p) => p.path === "/services/drains/")!;
    expect(drains).toMatchObject({ slug: "drains", parent: "/services/", title: "Drain cleaning", seoTitle: "Drain cleaning | Harbor Plumbing", focusKeyword: "drain cleaning sacramento", order: 3, mainClass: "page-x" });
    const home = manifest.pages.find((p) => p.path === "/")!;
    expect(home).toMatchObject({ slug: "home", parent: null, title: "Harbor Plumbing", schema: '{"@type":"Plumber","name":"Harbor"}' });
    expect(manifest.media).toEqual(["images/hero.jpg"]);
    expect(manifest.redirects).toEqual([
      { from: "/old-drains", to: "/services/drains/", code: 301 },
      { from: "/about-us.html", to: "/", code: 301 },
    ]);
    expect(manifest.forms).toHaveLength(1);
    expect(manifest.forms[0]).toMatchObject({ name: "contact", replyTo: "email", subject: "A new message from the Harbor Plumbing website" });
    expect(manifest.formEmails).toEqual({ to: ["owner@harbor.example"], copy: "sites@vml.example" });
    expect(manifest.mode).toBe("preview");
    expect(report).toMatchObject({ pages: 5, forms: 1, media: 1, redirects: 2 });
    expect(report.notes).toEqual(['Form "contact": A "range" field (budget) isn\'t carried over; add it in Contact Form 7 by hand.']);

    const text = (path: string) => new TextDecoder().decode(files.get(path)!);
    // Every page file reads as blocks.
    for (const p of manifest.pages) expect(real(parse(text(p.file))).length, p.path).toBeGreaterThan(0);
    // The header and footer are template parts; what Build A has after the footer is printed at the end of each page.
    expect(text("theme/tawd-harbor-plumbing/parts/header.html")).toContain('<a class="skip" href="#main">Skip to content</a>');
    expect(text("theme/tawd-harbor-plumbing/parts/footer.html")).toContain("Website by Velocity Media Lab");
    expect(text("theme/tawd-harbor-plumbing/inc/body-end.html")).toBe('<div id="tawd-consent" hidden>Cookies?</div><script>window.tawdConsent=1</script>\n');
    // The tracking code stays; what WordPress and Rank Math write themselves doesn't come twice.
    expect(text("theme/tawd-harbor-plumbing/inc/head.html")).toBe('<script src="https://www.googletagmanager.com/gtag/js?id=G-1" data-consent="analytics"></script>\n');
    expect(text("theme/tawd-harbor-plumbing/templates/404.html")).toContain("We can't find that page");
    expect(text("install.php")).toMatch(/^<\?php/);
    // WordPress's own address rules, written by the installer (from the command line WordPress doesn't): without them only the home page opened.
    expect(text("install.php")).toContain("insert_with_markers(get_home_path() . '.htaccess', 'WordPress'");
    expect(text("install.php")).toContain("'RewriteRule . ' . $base . '/index.php [L]'");
    expect(text("README.txt")).toContain("wp eval-file install.php");
  });

  it("keeps different forms apart, even when Build A calls them all \"contact\", and the same form on many pages as one", () => {
    const files = build();
    const other = FORM.replace(">Name<", ">Your name<");
    files.set("about/index.html", enc(page("About | Harbor Plumbing", `<h1>About</h1>${other}`)));
    files.set("faq/index.html", enc(page("FAQ | Harbor Plumbing", `<h1>FAQ</h1>${FORM}`)));
    const { files: out, manifest } = wordpressPackage({ clientName: "Harbor Plumbing", buildVersion: 4, files, formEmails: { to: [], copy: null } });
    expect(manifest.forms.map((f) => [f.name, f.fields[0]!.label])).toEqual([
      ["contact", "Your name"],
      ["contact-2", "Name"],
    ]);
    const text = (path: string) => new TextDecoder().decode(out.get(path)!);
    expect(text("content/pages/about.html")).toContain('id="tawd-form:contact"');
    expect(text("content/pages/contact.html")).toContain('[contact-form-7 id="tawd-form:contact-2" title="contact-2"');
    expect(text("content/pages/faq.html")).toContain('id="tawd-form:contact-2"');
  });

  it("is the same every time for the same build", () => {
    const a = wordpressPackage({ clientName: "Harbor Plumbing", buildVersion: 4, files: build(), formEmails: { to: [], copy: null } });
    const b = wordpressPackage({ clientName: "Harbor Plumbing", buildVersion: 4, files: build(), formEmails: { to: [], copy: null } });
    expect([...a.files.entries()].map(([k, v]) => [k, v.length])).toEqual([...b.files.entries()].map(([k, v]) => [k, v.length]));
  });

  it("refuses a build with no home page", () => {
    expect(() => wordpressPackage({ clientName: "X", buildVersion: 1, files: new Map(), formEmails: { to: [], copy: null } })).toThrow("no home page");
  });

  it("reads a page apart and Netlify's redirects", () => {
    const parts = pageParts(page("T", "<h1>Hi</h1>"));
    expect(parts).toMatchObject({ title: "T", mainClass: "page-x", main: "<h1>Hi</h1>" });
    expect(parts.before).toBe('<header class="site-header"><a class="skip" href="#main">Skip to content</a><nav><a href="/">Home</a></nav></header>');
    expect(readRedirects("/a /b 302\n\n# x\nbad line\n/c /d")).toEqual([
      { from: "/a", to: "/b", code: 302 },
      { from: "/c", to: "/d", code: 301 },
    ]);
    // A query-string rule keeps its query in `from` (the installer then skips it by name) and never reads "page_id=12" as the destination.
    expect(readRedirects("/ page_id=12  /about/  301")).toEqual([{ from: "/?page_id=12", to: "/about/", code: 301 }]);
    expect(readRedirects("/blog/ p=3 a=1  /x/  302")).toEqual([{ from: "/blog/?p=3&a=1", to: "/x/", code: 302 }]);
  });
});

describe("the theme", () => {
  it("has Build A's shape: no spacing of WordPress's own, <main id=\"main\">, no wrappers", () => {
    const files = wordpressTheme({ clientName: "Harbor", buildVersion: 1, siteCss: "", fontLinks: [], design: readDesign("<style></style>"), parts: { header: "", footer: "" } });
    const json = JSON.parse(files["theme.json"]!);
    expect(json.settings.spacing.blockGap).toBeNull();
    expect(files["templates/page.html"]).toContain('<!-- wp:group {"tagName":"main","anchor":"main","layout":{"type":"default"}} -->\n<main class="wp-block-group" id="main"><!-- wp:post-content');
    expect(files["functions.php"]).toContain("add_filter('render_block', function ($html, $block) {");
    expect(files["functions.php"]).toContain("'~^\\s*<div\\b[^>]*>~'");
    expect(files["functions.php"]).toContain("_tawd_main_class");
    expect(files["functions.php"]).toContain("wpcf7mailsent");
    // The login name stays private (13 October 2026): no users API, author pages, users sitemap or oEmbed author for visitors.
    expect(files["functions.php"]).toContain("strpos($route, '/wp/v2/users') === 0");
    expect(files["functions.php"]).toContain("if (is_author() || (isset($_GET['author']) && !is_user_logged_in())) {");
    expect(files["functions.php"]).toContain("return $name === 'users' ? false : $provider;");
    expect(files["functions.php"]).toContain("unset($data['author_name'], $data['author_url']);");
  });

  it("puts the stylesheet's @import lines (its fonts) first, where browsers read them, whole", () => {
    const font = "@import url('https://fonts.googleapis.com/css2?family=Fraunces:wght@500;700&family=Source+Sans+3:wght@400;600&display=swap');";
    const files = wordpressTheme({ clientName: "Harbor", buildVersion: 1, siteCss: `${font}\n.hero{padding:8px}`, fontLinks: [], design: readDesign("<style></style>"), parts: { header: "", footer: "" } });
    const css = files["style.css"]!;
    expect(css.indexOf(font)).toBeGreaterThan(0);
    expect(css.indexOf(font)).toBeLessThan(css.indexOf(".tawd-honeypot"));
    expect(css.split(font)).toHaveLength(2);
    expect(css).toContain(".hero{padding:8px}");
  });
});

describe("Gravity Forms, the second form option (1 October 2026)", () => {
  it("gives the same pages Gravity Forms shortcodes, and the installer each field's type, whether it's required, its choices and the form's look", () => {
    const { files, manifest } = wordpressPackage({ clientName: "Harbor Plumbing", buildVersion: 4, files: build(), formEmails: { to: ["owner@harbor.example"], copy: null }, formPlugin: "gravityforms" });
    const text = (path: string) => new TextDecoder().decode(files.get(path)!);
    expect(manifest.formPlugin).toBe("gravityforms");
    const contact = text("content/pages/contact.html");
    expect(contact).toContain('[gravityform id="tawd-form:contact" title="false" description="false" ajax="true"]');
    expect(contact).not.toContain("contact-form-7");
    const form = manifest.forms[0]!;
    expect(form.fields.map((f) => [f.name, f.type, Boolean(f.required)])).toEqual([
      ["name", "text", true],
      ["email", "email", false],
      ["message", "textarea", true],
    ]);
    expect(form.look).toMatchObject({ wrapper: "field", button: "btn", buttonText: "Send message" });
    expect(form.htmlClass).toBe("quote-form");
    // The installer makes Gravity Forms' forms (messages kept in Entries) and the thank-you page as their confirmation.
    const install = text("install.php");
    expect(install).toContain("GFAPI::add_form($form)");
    expect(install).toContain("home_url('/thank-you/')");
    expect(install).toContain("update_option('tawd_form_looks'");
    // The theme dresses Gravity Forms in Build A's classes, relays its messages and leaves the email to TAWD's relay when it's on.
    const functions = text("theme/tawd-harbor-plumbing/functions.php");
    for (const hook of ["gform_disable_css", "gform_field_content", "gform_submit_button", "gform_entry_created", "gform_disable_notification"]) expect(functions, hook).toContain(hook);
    // The weekly check's own address: signed with the site's key, through Gravity Forms, the test entry removed.
    expect(functions).toContain("register_rest_route('tawd/v1', '/check'");
    expect(functions).toContain("hash_equals(hash_hmac('sha256', $sig[0] . '.' . $body, TAWD_FORMS_SECRET), $sig[1])");
    expect(functions).toContain("GFAPI::submit_form((int) $form['id'], $input)");
    expect(functions).toContain("GFAPI::delete_entry((int) $result['entry_id'])");
    // The check never emails anyone (Fable's B2, 3 October 2026), and a relay that didn't answer is a failure, not ok.
    expect(functions).toContain("$GLOBALS['tawd_checking'] = true;");
    expect(functions).toContain("if (!empty($GLOBALS['tawd_checking'])) {\n\t\treturn true;");
    expect(functions).toContain("new WP_Error('tawd_relay', ");
    expect(functions).not.toContain("'relayed' => $relayed");
    // Fable's B6: each signed check runs once.
    expect(functions).toContain("$once = 'tawd_check_' . md5($sig[1]);");
    expect(functions).toContain("new WP_Error('tawd_replay', ");
    // Fable's B7: "<" inside the structured data can't end its script.
    expect(functions).toContain("str_replace('<', '\\u003c', $schema)");
    // Fable's B9: a redeploy keeps the team's notifications, confirmations and fields on TAWD's forms.
    expect(install).toContain("$old = GFAPI::get_form($existing[$title]);");
    expect(install).toContain("if ($key !== 'tawd' && !isset($form['notifications'][$key]))");
    // Fable's B5: the header's menu place keeps a menu the team chose.
    expect(install).toContain("if ($reset || !$current || !wp_get_nav_menu_object($current)) {");
    expect(install).toContain("Menu place: kept the menu the team chose for the header");
    expect(install).toContain("'Menu: kept (Main menu, edited in WordPress)'");
  });

  it("keeps Contact Form 7 the default", () => {
    const { files, manifest } = wordpressPackage({ clientName: "Harbor Plumbing", buildVersion: 4, files: build(), formEmails: { to: [], copy: null } });
    expect(manifest.formPlugin).toBe("cf7");
    expect(new TextDecoder().decode(files.get("content/pages/contact.html")!)).not.toContain("[gravityform");
  });

  it("reads a select's choices and leaves the honeypot out of the look", () => {
    const html = `<form name="quote" data-netlify="true" netlify-honeypot="bot-field"><p class="tawd-honeypot" hidden><label>Leave this empty: <input name="bot-field" /></label></p><div class="row"><label for="s">Service</label><select id="s" name="service" required><option value="">Choose</option><option>Drains</option><option>Leaks</option></select></div><button class="cta">Get a quote</button></form>`;
    const { forms } = htmlToBlocks(`<section>${html}</section>`);
    expect(forms[0]!.fields).toEqual([{ name: "service", label: "Service", type: "select", required: true, options: ["Drains", "Leaks"] }]);
    expect(forms[0]!.look).toMatchObject({ wrapper: "row", button: "cta", buttonText: "Get a quote" });
  });
});

describe("for VML's dev team (1 October 2026)", () => {
  const NAV = (cls: string) => `<nav class="${cls}" aria-label="Main">\n        <a href="/">Home</a>\n        <a href="/services/">Services &amp; prices</a>\n        <a href="/contact/" aria-current="page">Contact</a>\n      </nav>`;
  const HEADER = `<header class="site-header"><a class="skip" href="#main">Skip to content</a><a class="logo" href="/">Harbor</a>${NAV("nav")}<details class="nav-mobile"><summary>Menu</summary>${NAV("panel")}</details><a class="btn" href="/contact/">Get a quote</a></header>`;
  const pages = new Set(["/", "/services/", "/contact/"]);

  it("makes the header's menus one WordPress menu, each drawn in its own markup", () => {
    const { header, menu, notes } = headerMenu(HEADER, pages);
    expect(notes).toEqual([]);
    expect(menu!.items).toEqual([
      { label: "Home", path: "/" },
      { label: "Services & prices", path: "/services/" },
      { label: "Contact", path: "/contact/" },
    ]);
    expect(menu!.navs).toEqual([
      { key: "nav-1", template: '<a{tawd:current} href="{tawd:href}">{tawd:label}</a>', gap: "\n        " },
      { key: "nav-2", template: '<a{tawd:current} href="{tawd:href}">{tawd:label}</a>', gap: "\n        " },
    ]);
    // The rest of the header stays exactly as built.
    expect(header).toBe(`<header class="site-header"><a class="skip" href="#main">Skip to content</a><a class="logo" href="/">Harbor</a><nav class="nav" aria-label="Main">\n        [tawd_menu nav="nav-1"]\n      </nav><details class="nav-mobile"><summary>Menu</summary><nav class="panel" aria-label="Main">\n        [tawd_menu nav="nav-2"]\n      </nav></details><a class="btn" href="/contact/">Get a quote</a></header>`);
  });

  it("reads items in lists, and keeps a nav it can't read for certain as HTML, saying why", () => {
    const list = `<nav><ul class="menu"><li class="item"><a class="link" href="/">Home</a></li><li class="item"><a class="link" href="/services">Services</a></li></ul></nav>`;
    expect(headerMenu(`<header>${list}</header>`, pages).menu!.navs[0]!.template).toBe('<li class="item"><a{tawd:current} class="link" href="{tawd:href}">{tawd:label}</a></li>');
    const dropdown = `<header><nav aria-label="Main"><a href="/">Home</a><div><a href="/services/">Services</a><a href="/contact/">Contact</a></div></nav></header>`;
    const kept = headerMenu(dropdown, pages);
    expect(kept.menu).toBeNull();
    expect(kept.header).toBe(dropdown);
    expect(kept.notes).toEqual(['The header\'s "Main" menu is kept as HTML (it has a dropdown): edit it in the Site Editor.']);
    const outside = headerMenu(`<header><nav aria-label="Main"><a href="/">Home</a><a href="https://other.example/">Shop</a><a href="/contact/">Contact</a></nav></header>`, pages);
    expect(outside.menu).toBeNull();
    expect(outside.notes[0]).toContain("links to other places");
    // A phone menu with other pages than the desktop one stays as built.
    const different = headerMenu(`<header>${NAV("nav")}<nav class="panel"><a href="/">Home</a><a href="/contact/">Contact</a></nav></header>`, pages);
    expect(different.menu!.navs.map((n) => n.key)).toEqual(["nav-1"]);
    expect(different.notes[0]).toContain("lists different pages");
  });

  it("puts the menu in the package, the theme draws it, and the installer makes it once (the team's after that)", () => {
    const files = build();
    for (const [name, value] of files) if (name.endsWith(".html")) files.set(name, enc(new TextDecoder().decode(value).replace(/<header[\s\S]*?<\/header>/, HEADER)));
    files.set("services/index.html", enc(page("Services | Harbor Plumbing", "<h1>Services</h1>")));
    const { files: out, manifest } = wordpressPackage({ clientName: "Harbor Plumbing", buildVersion: 4, files, formEmails: { to: [], copy: null } });
    const text = (path: string) => new TextDecoder().decode(out.get(path)!);
    expect(manifest.menu!.items.map((i) => i.path)).toEqual(["/", "/services/", "/contact/"]);
    const part = text("theme/tawd-harbor-plumbing/parts/header.html");
    expect(part).toContain('[tawd_menu nav="nav-1"]');
    expect(part).toContain('[tawd_menu nav="nav-2"]');
    // Kept as one Custom HTML part, where WordPress runs shortcodes.
    expect(names(parse(part))).not.toContain("core/list");
    expect(text("theme/tawd-harbor-plumbing/functions.php")).toContain("add_shortcode('tawd_menu'");
    expect(text("theme/tawd-harbor-plumbing/functions.php")).toContain("register_nav_menus(array('primary' => 'Main menu'))");
    const install = text("install.php");
    expect(install).toContain("wp_create_nav_menu('Main menu')");
    expect(install).toContain("Menu: kept (edited in WordPress, Appearance, Menus)");
  });

  it("keeps the team's Site Editor changes unless reset, and fixes links and address rules for a WordPress in a folder", () => {
    const { files } = wordpressPackage({ clientName: "Harbor Plumbing", buildVersion: 4, files: build(), formEmails: { to: [], copy: null } });
    const install = new TextDecoder().decode(files.get("install.php")!);
    expect(install).toContain("$reset = in_array('reset'");
    expect(install).toMatch(/if \(\$reset\) \{\n\tforeach \(\$edited as \$id\) \{\n\t\twp_delete_post\(\$id, true\);/);
    expect(install).toContain("Kept (edited in WordPress): ");
    expect(install).toContain("$base = rtrim((string) wp_parse_url(home_url('/'), PHP_URL_PATH), '/');");
    expect(install).toContain("'RewriteBase ' . $base . '/'");
    expect(install).toContain("'RewriteRule . ' . $base . '/index.php [L]'");
    expect(install).toContain("tawd_links(tawd_urls((string) file_get_contents($tawd_dir . '/' . $p['file']), $urls), $base)");
  });

  it("has a README that says it isn't a whole site, what it needs, and how to set it up on a laptop with XAMPP", () => {
    const readme = (formPlugin?: "cf7" | "gravityforms") => new TextDecoder().decode(wordpressPackage({ clientName: "Harbor Plumbing", buildVersion: 4, files: build(), formEmails: { to: [], copy: null }, formPlugin }).files.get("README.txt")!);
    const cf7 = readme();
    expect(cf7).toContain("This isn't a whole WordPress site");
    expect(cf7).toContain("WP-CLI, WordPress's command-line tool");
    expect(cf7).toContain("C:\\xampp\\php\\php.exe C:\\xampp\\wp-cli.phar eval-file install.php --path=C:\\xampp\\htdocs\\<name>");
    expect(cf7).toContain("wp eval-file install.php reset --path=<the WordPress folder>");
    expect(cf7).toContain("Contact Form 7, installed and active");
    expect(readme("gravityforms")).toContain("Gravity Forms (VML's licence), installed and active");
    expect(readme("gravityforms")).toContain("1 Gravity Forms form,");
  });
});

