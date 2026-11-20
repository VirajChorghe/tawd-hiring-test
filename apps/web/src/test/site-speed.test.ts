import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "@wordpress/block-serialization-default-parser";

/*
  The speed pass (1 October 2026, Jason: "get the PageSpeed numbers up and
  fix everything in code"): pictures at the size they're shown, as WebP,
  with every size listed; lazy below the first screen; Google Fonts from
  the site, only the ones used, with a stand-in of the same size; far
  sections laid out only when scrolled near; links with no visible words
  labelled; the site's icon; long caching on Netlify and Bluehost; and on
  WordPress, Rank Math writing the descriptions, jQuery at the end, and
  only the form plugin in use. Nora Beagle Site's home page went from 65
  to 94 on mobile and 75 to 100 on desktop (Lighthouse, on the laptop).
*/

import { SECTION_RULE, headersFile, linkLabel, phoneWords, stripSpeedForBlocks, tuneTags, wordpressPackage, type PageSeen, type Renamed, type TagCounts } from "@tawd/core/site";
import { addFallbacks, fallbackRule, phoneMenuRule, familyUsed, fontFamilies, isSerifStack, keepFamilies, latinFaces, pathForms, replacePath, speedLine, speedUpSiteSafely, STAND_INS } from "../../../worker/src/site-speed";

const counts = (): TagCounts => ({ lazy: 0, labels: 0, sections: 0, notes: [] });

describe("the page's own tags", () => {
  const HTML = `<html><head><title>Home</title></head><body><header><a class="head-phone" href="tel:+15555555555"><svg></svg><span class="hide-phone">Call (555) 555-5555</span></a><img src="/assets/images/logo-253-aa.webp" alt="Logo" width="108" height="72"></header><main id="main"><section class="hero"><img src="/images/photo-1.jpg" alt="A beagle" width="520" height="520"></section><section class="cards" style="padding:8px"><img src="/assets/images/photo-3-1005-bb.webp" alt="Training"></section><section class="faq"><a href="mailto:hi@harbor.example"></a></section></main></body></html>`;
  const page: PageSeen = {
    imgs: [
      [
        { src: "/assets/images/logo-253-aa.webp", top: 10, w: 108, h: 72 },
        { src: "/images/photo-1.jpg", top: 150, w: 520, h: 520 },
        { src: "/assets/images/photo-3-1005-bb.webp", top: 2000, w: 419, h: 660 },
      ],
      [
        { src: "/assets/images/logo-253-aa.webp", top: 8, w: 84, h: 56 },
        { src: "/images/photo-1.jpg", top: 600, w: 360, h: 360 },
        { src: "/assets/images/photo-3-1005-bb.webp", top: 4000, w: 348, h: 550 },
      ],
    ],
    sections: [
      [
        { top: 100, h: 800 },
        { top: 1900, h: 1200 },
        { top: 3100, h: 900 },
      ],
      [
        { top: 80, h: 1400 },
        { top: 3900, h: 2400 },
        { top: 6300, h: 1500 },
      ],
    ],
    unnamed: new Map([
      [0, { href: "tel:+15555555555", text: "Call (555) 555-5555" }],
      [1, { href: "mailto:hi@harbor.example", text: "" }],
    ]),
    anchors: 2,
  };
  const renamed: Renamed = new Map([
    [
      "/images/photo-3.jpg",
      {
        main: "/assets/images/photo-3-1005-bb.webp",
        set: [
          { w: 1005, url: "/assets/images/photo-3-1005-bb.webp" },
          { w: 512, url: "/assets/images/photo-3-512-cc.webp" },
        ],
      },
    ],
  ]);

  it("loads the first screen's biggest picture first, the rest when scrolled to, each swapped picture with all its sizes", () => {
    const c = counts();
    const out = tuneTags(HTML, page, renamed, c, "index.html");
    expect(out).toContain('<img fetchpriority="high" src="/images/photo-1.jpg"');
    expect(out).toContain('<img loading="lazy" decoding="async" srcset="/assets/images/photo-3-1005-bb.webp 1005w, /assets/images/photo-3-512-cc.webp 512w" sizes="(max-width: 600px) 348px, 419px" src="/assets/images/photo-3-1005-bb.webp"');
    // The logo is on the first screen: as it was.
    expect(out).toContain('<img src="/assets/images/logo-253-aa.webp"');
    expect(c.lazy).toBe(1);
  });

  it("lays out far sections only when scrolled near, at their measured heights, and labels links with no visible words", () => {
    const c = counts();
    const out = tuneTags(HTML, page, renamed, c, "index.html");
    expect(out).toContain('<section class="hero">');
    expect(out).toContain('<section data-tawd-cv class="cards" style="padding:8px;--tawd-h:1200px;--tawd-hp:2400px">');
    expect(out).toContain('<section data-tawd-cv style="--tawd-h:900px;--tawd-hp:1500px" class="faq">');
    expect(out).toContain(`<style id="tawd-sections">${SECTION_RULE}</style></head>`);
    expect(c.sections).toBe(2);
    // Its own words when they're only hidden on a phone; the address when it has none.
    expect(out).toContain('<a aria-label="Call (555) 555-5555" class="head-phone"');
    expect(out).toContain('<a aria-label="Email hi@harbor.example" href="mailto:hi@harbor.example">');
    expect(c.labels).toBe(2);
  });

  it("leaves a page alone where what the browser saw doesn't line up with the page", () => {
    const c = counts();
    const out = tuneTags(HTML, { ...page, imgs: [page.imgs[0]!.slice(0, 2), page.imgs[1]!.slice(0, 2)], sections: [[], []], unnamed: new Map(), anchors: 9 }, renamed, c, "index.html");
    expect(out).toBe(HTML);
  });

  it("words phone numbers and labels", () => {
    expect(phoneWords("tel:+15555555555")).toBe("(555) 555-5555");
    expect(phoneWords("tel:+442071234567")).toBe("+442071234567");
    expect(linkLabel("tel:+15555555555", "  Beagle question?\n Call (555) 555-5555 ")).toBe("Beagle question? Call (555) 555-5555");
    expect(linkLabel("/about/", "")).toBeNull();
  });

  it("swaps a picture's address everywhere it's used, except the sharing picture in <meta>", () => {
    const html = `<meta property="og:image" content="/images/a.jpg"><img src="/images/a.jpg" srcset="/images/a.jpg 1x"><div style="background:url(/images/a.jpg)"></div><a href="/images/a.jpg.html">x</a>`;
    expect(replacePath(html, "/images/a.jpg", "/assets/images/a-1-x.webp", true)).toBe(`<meta property="og:image" content="/images/a.jpg"><img src="/assets/images/a-1-x.webp" srcset="/assets/images/a-1-x.webp 1x"><div style="background:url(/assets/images/a-1-x.webp)"></div><a href="/images/a.jpg.html">x</a>`);
  });
});

describe("Google Fonts, from the site", () => {
  const URL_BOTH = "https://fonts.googleapis.com/css2?family=Poppins:wght@500;600&family=Source+Sans+3:wght@400;700&display=swap";
  const STYLES = `:root{--sans:"Source Sans 3",Arial,sans-serif;--display:"Fraunces",Georgia,serif}body{font-family:var(--sans)}`;

  it("keeps only the families the site uses", () => {
    expect(fontFamilies(URL_BOTH)).toEqual(["Poppins", "Source Sans 3"]);
    expect(familyUsed(STYLES, "Source Sans 3")).toBe(true);
    expect(familyUsed(STYLES, "Poppins")).toBe(false);
    expect(familyUsed("h1{font-family:Poppins, sans-serif}", "Poppins")).toBe(true);
    expect(keepFamilies(URL_BOTH, new Set(["Source Sans 3"]))).toBe("https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;700&display=swap");
    expect(keepFamilies(URL_BOTH, new Set())).toBeNull();
  });

  it("takes Google's Latin faces and their files", () => {
    const css = `/* cyrillic */\n@font-face {\n  font-family: 'Source Sans 3';\n  src: url(https://fonts.gstatic.com/s/a-cyr.woff2) format('woff2');\n}\n/* latin-ext */\n@font-face {\n  font-family: 'Source Sans 3';\n  src: url(https://fonts.gstatic.com/s/a-ext.woff2) format('woff2');\n  unicode-range: U+0100-02BA;\n}\n/* latin */\n@font-face {\n  font-family: 'Source Sans 3';\n  font-weight: 400;\n  src: url(https://fonts.gstatic.com/s/a-latin.woff2) format('woff2');\n}\n/* latin */\n@font-face {\n  font-family: 'Source Sans 3';\n  font-weight: 700;\n  src: url(https://fonts.gstatic.com/s/a-latin.woff2) format('woff2');\n}`;
    const faces = latinFaces(css);
    expect(faces.rules).toHaveLength(3);
    expect(faces.files).toEqual(["https://fonts.gstatic.com/s/a-ext.woff2", "https://fonts.gstatic.com/s/a-latin.woff2"]);
  });

  it("gives each a stand-in of the same size, in the site's own stacks", () => {
    expect(isSerifStack(STYLES, "Fraunces")).toBe(true);
    expect(isSerifStack(STYLES, "Source Sans 3")).toBe(false);
    const rule = fallbackRule("Source Sans 3", { width: 4884.5, ascent: 102, descent: 40 }, STAND_INS.sans);
    expect(rule).toBe('@font-face{font-family:"Source Sans 3 Fallback";src:local("Arial");size-adjust:92.89%;ascent-override:109.80%;descent-override:43.06%;line-gap-override:0%}');
    expect(addFallbacks(STYLES, ["Source Sans 3", "Fraunces"])).toBe(`:root{--sans:"Source Sans 3","Source Sans 3 Fallback",Arial,sans-serif;--display:"Fraunces","Fraunces Fallback",Georgia,serif}body{font-family:var(--sans)}`);
    // Twice is the same as once; the same quotes inside an attribute.
    expect(addFallbacks(addFallbacks(STYLES, ["Fraunces"]), ["Fraunces"])).toBe(addFallbacks(STYLES, ["Fraunces"]));
    expect(addFallbacks(`<h1 style="font-family:'Fraunces'">`, ["Fraunces"])).toBe(`<h1 style="font-family:'Fraunces','Fraunces Fallback'">`);
  });

  it("keeps a phone menu that runs off the screen on it", () => {
    expect(phoneMenuRule("details.nav-mobile[open] nav.panel", 86)).toBe("@media (max-width:600px){details.nav-mobile[open] nav.panel{position:fixed;left:12px;right:12px;width:auto;max-width:none;top:86px;max-height:calc(100vh - 98px);overflow:auto}}");
  });

  it("sums up what it did in one line for the build's checks", () => {
    expect(speedLine({ images: [{ from: "/images/logo.png", to: "/assets/images/logo-253-x.webp", before: 817688, after: 15590 }], fonts: { kept: ["Fraunces"], dropped: ["Poppins"], files: 2, matched: ["Fraunces"] }, lazy: 3, labels: 1, sections: 2, icon: true, notes: [] })).toBe(
      "Speed: 1 picture made smaller (799 KB to 15 KB); fonts served from the site (Fraunces; unused Poppins left out); 3 pictures below the first screen load when scrolled to; 2 sections far down the pages laid out only when scrolled near; 1 link given a label; the logo as the site's icon.",
    );
  });
});

describe("Netlify and WordPress", () => {
  it("let browsers keep the speed pass's files a year on Netlify (their content is in their names)", () => {
    for (const mode of ["preview", "live"] as const) expect(headersFile(mode)).toContain("/assets/*\n  Cache-Control: public, max-age=31536000, immutable");
  });

  it("keep picture blocks and sections as WordPress blocks, the sizes in the manifest for the theme", () => {
    const enc = (t: string) => new TextEncoder().encode(t);
    const main = `<section data-tawd-cv style="--tawd-h:900px;--tawd-hp:1500px"><h2>Our work</h2><figure><img loading="lazy" decoding="async" srcset="/assets/images/a-1040-x.webp 1040w, /assets/images/a-520-y.webp 520w" sizes="(max-width: 600px) 348px, 520px" src="/assets/images/a-1040-x.webp" alt="A van"></figure></section>`;
    expect(stripSpeedForBlocks(main)).toBe(`<section><h2>Our work</h2><figure><img src="/assets/images/a-1040-x.webp" alt="A van"></figure></section>`);
    const page = (body: string) => `<!doctype html><html><head><title>Harbor</title></head><body><header><a href="/">Harbor</a></header><main id="main">${body}</main><footer><p>Website by Velocity Media Lab</p></footer></body></html>`;
    const files = new Map([
      ["index.html", enc(page(main))],
      ["assets/images/a-1040-x.webp", new Uint8Array([1])],
      ["assets/images/a-520-y.webp", new Uint8Array([2])],
      ["_tawd/images.json", enc(JSON.stringify({ "/assets/images/a-1040-x.webp": { set: [{ w: 1040, url: "/assets/images/a-1040-x.webp" }, { w: 520, url: "/assets/images/a-520-y.webp" }], dw: 520, pw: 348 } }))],
    ]);
    const { files: out, manifest } = wordpressPackage({ clientName: "Harbor Plumbing", buildVersion: 2, files, formEmails: { to: [], copy: null } });
    const home = new TextDecoder().decode(out.get("content/pages/home.html")!);
    expect(parse(home).some((b) => b.blockName === "core/image" || b.innerBlocks.some((i) => i.blockName === "core/image"))).toBe(true);
    expect(manifest.srcsets["/assets/images/a-1040-x.webp"]).toEqual({ set: [{ w: 1040, url: "/assets/images/a-1040-x.webp" }, { w: 520, url: "/assets/images/a-520-y.webp" }], dw: 520, pw: 348 });
    expect(manifest.media).toEqual(["assets/images/a-1040-x.webp", "assets/images/a-520-y.webp"]);

    const install = new TextDecoder().decode(out.get("install.php")!);
    expect(install).toContain("update_option('rank_math_registration_skip', 1);");
    expect(install).toContain("update_option('tawd_srcsets', $srcsets, false);");
    expect(install).toContain("insert_with_markers(get_home_path() . '.htaccess', 'TAWD speed'");
    expect(install).toContain('Header set Cache-Control "public, max-age=31536000, immutable"');
    const theme = new TextDecoder().decode(out.get("theme/tawd-harbor-plumbing/functions.php")!);
    expect(theme).toContain("add_filter('render_block_core/image'");
    expect(theme).toContain("add_filter('gform_init_scripts_footer', '__return_true');");
    expect(theme).toContain("$scripts->add_data($handle, 'group', 1);");
    expect(theme).toContain("add_filter('wpcf7_load_js', 'tawd_page_has_form');");
    expect(theme).toContain("define('TAWD_FORM_IN_PARTS', false);");
  });
});

describe("Fable's B3 and B4 (3 October 2026)", () => {
  it("knows a picture's address however a page writes it", () => {
    expect(pathForms("/images/my photo.jpg")).toEqual(["/images/my photo.jpg", "/images/my%20photo.jpg"]);
    expect(pathForms("/images/café.jpg")).toContain("/images/caf%C3%A9.jpg");
    expect(pathForms("/images/a&b.jpg")).toEqual(["/images/a&b.jpg", "/images/a&amp;b.jpg"]);
    expect(pathForms("/images/a.jpg")).toEqual(["/images/a.jpg"]);
    // The swap finds the encoded address the browser reported decoded.
    const html = `<img src="/images/my%20photo.jpg">`;
    const swapped = pathForms("/images/my photo.jpg").reduce((t, form) => replacePath(t, form, "/assets/images/my-photo-1-x.webp", true), html);
    expect(swapped).toBe(`<img src="/assets/images/my-photo-1-x.webp">`);
  });

  it("puts the site back as it was when the pass stops part-way", async () => {
    const dist = await mkdtemp(path.join(tmpdir(), "tawd-speed-"));
    await writeFile(path.join(dist, "index.html"), "<html><body><h1>Hi</h1></body></html>");
    // A browser that fails as soon as the pass opens a page.
    const browser = { newContext: async () => ({ route: async () => undefined, newPage: async () => { throw new Error("Chromium crashed"); }, close: async () => undefined }) } as never;
    await expect(speedUpSiteSafely(browser, dist, "http://127.0.0.1:9")).rejects.toThrow();
    expect(await readFile(path.join(dist, "index.html"), "utf8")).toBe("<html><body><h1>Hi</h1></body></html>");
    expect(await readdir(path.dirname(dist))).not.toContain(`${path.basename(dist)}.before-speed`);
    await rm(dist, { recursive: true, force: true });
  });
});

describe("Fable's B11 and B12 (3 October 2026)", () => {
  it("never defers a far section that holds a fixed or sticky part (a floating call button)", () => {
    const html = `<html><head></head><body><main><section class="hero">x</section><section class="far">y</section></main></body></html>`;
    const seen = (pinned: boolean): PageSeen => ({
      imgs: [[], []],
      sections: [
        [{ top: 0, h: 900 }, { top: 3000, h: 800, pinned }],
        [{ top: 0, h: 900 }, { top: 4000, h: 900, pinned }],
      ],
      unnamed: new Map(),
      anchors: 0,
    });
    expect(tuneTags(html, seen(false), new Map(), counts(), "index.html")).toContain("data-tawd-cv");
    expect(tuneTags(html, seen(true), new Map(), counts(), "index.html")).not.toContain("data-tawd-cv");
  });

  it("tunes the pictures on a page that carries a tracking pixel in <noscript> or a commented-out picture", () => {
    const html = `<html><head></head><body><noscript><img src="https://www.facebook.com/tr?id=1" height="1"></noscript><!-- <img src="/old.jpg"> --><img src="/images/a.jpg"><img src="/images/b.jpg"></body></html>`;
    const page: PageSeen = {
      imgs: [
        [{ src: "/images/a.jpg", top: 100, w: 400, h: 300 }, { src: "/images/b.jpg", top: 3000, w: 400, h: 300 }],
        [{ src: "/images/a.jpg", top: 100, w: 300, h: 200 }, { src: "/images/b.jpg", top: 5000, w: 300, h: 200 }],
      ],
      sections: [[], []],
      unnamed: new Map(),
      anchors: 0,
    } as never;
    const c = counts();
    const out = tuneTags(html, page, new Map(), c, "index.html");
    expect(out).toContain('<img fetchpriority="high" src="/images/a.jpg">');
    expect(out).toContain('<img loading="lazy" decoding="async" src="/images/b.jpg">');
    // The pixel and the comment are left exactly as they were.
    expect(out).toContain('<noscript><img src="https://www.facebook.com/tr?id=1" height="1"></noscript><!-- <img src="/old.jpg"> -->');
    expect(c.lazy).toBe(1);
  });
});
