import fs from "node:fs";
import { describe, expect, it } from "vitest";

import { astroProject, extractDesignSystem, isActiveUrl, placeholdersIn, readHtmlMockup, stripActiveContent, MAX_EXTRACTED_IMAGES, MAX_EXTRACTED_FONTS } from "@tawd/core/site";
import { splitSections } from "@tawd/core/mockups";

import { CANARY_FIXTURES } from "../../../worker/src/canary-fixtures";

/* The rule as it was before 16 November 2026: header = first band, footer = last band. */
function oldHeaderAndFooter(html: string) {
  const bands = splitSections(html);
  const first = bands[0]!;
  const last = bands.at(-1)!;
  const header = first.tag === "header" || /<nav\b/i.test(first.html) ? first.html : "";
  const footer = last !== first && (last.tag === "footer" || /<footer\b/i.test(last.html)) ? last.html : "";
  const sections = bands.filter((b) => b.html !== header && b.html !== footer).map((b) => b.html);
  return { header, footer, sections };
}

describe("extractDesignSystem finds the header and footer among the bands", () => {
  it("keeps every TAWD Lane 1 canary fixture exactly as before", () => {
    expect(CANARY_FIXTURES.length).toBe(8);
    for (const fixture of CANARY_FIXTURES) {
      const ds = extractDesignSystem(fixture.html);
      const old = oldHeaderAndFooter(fixture.html);
      expect({ name: fixture.name, header: ds.header, footer: ds.footer, sections: ds.sections }).toEqual({ name: fixture.name, ...old });
    }
  });

  const page = (...bands: string[]) => `<html><head><style>a{}</style></head><body>${bands.join("")}</body></html>`;
  const skip = '<a class="skip" href="#main">Skip to content</a>';
  const header = "<header><nav><a>Home</a></nav></header>";
  const hero = "<section><h1>Hi</h1></section>";
  const mid = "<section><nav><a>In-page links</a></nav></section>";
  const footer = "<footer>(c)</footer>";
  const callBar = '<nav class="callbar"><a href="tel:1">Call</a></nav>';

  it("finds a header under a skip link and a footer above a sticky call bar", () => {
    const ds = extractDesignSystem(page(skip, header, hero, footer, callBar));
    expect(ds.header).toBe(header);
    expect(ds.footer).toBe(footer);
    expect(ds.sections).toEqual([skip, hero, callBar]);
  });

  it("does not take a nav in the middle of the page for a header", () => {
    const ds = extractDesignSystem(page(hero, hero, hero, hero, mid, hero, footer));
    expect(ds.header).toBe("");
    expect(ds.sections).toContain(mid);
  });

  it("does not take a footer from the middle of the page", () => {
    const ds = extractDesignSystem(page(header, footer, hero, hero, hero, hero));
    expect(ds.footer).toBe("");
  });

  const file = "C:/Users/jason/Downloads/sb-marketing-homepage-option-3.html";
  it.skipIf(!fs.existsSync(file))("finds the real header and footer in the Sample Marketing Co. mockup", () => {
    const ds = extractDesignSystem(fs.readFileSync(file, "utf8"));
    expect(ds.header).not.toBe("");
    expect(ds.footer).not.toBe("");
    expect(ds.footer.startsWith("<footer")).toBe(true);
  });
});

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
const JPG = Buffer.from("ffd8ffe000104a464946", "hex").toString("base64");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 ")]).toString("base64");

describe("readHtmlMockup: photos", () => {
  it("replaces each embedded photo with a token, in src and in css url()", () => {
    const html = `<body><img src="data:image/png;base64,${PNG}" alt="a"><div style="background:url('data:image/jpeg;base64,${JPG}')"></div></body>`;
    const r = readHtmlMockup(html);
    expect(r.html).toBe(`<body><img src="tawd-asset:photo-1" alt="a"><div style="background:url('tawd-asset:photo-2')"></div></body>`);
    expect(r.images.map((i) => [i.token, i.contentType, i.bytes.length])).toEqual([
      ["tawd-asset:photo-1", "image/png", 16],
      ["tawd-asset:photo-2", "image/jpeg", 10],
    ]);
  });

  it("gives one token to the same picture used twice", () => {
    const uri = `data:image/webp;base64,${WEBP}`;
    const r = readHtmlMockup(`<body><img src="${uri}"><i style="background:url(${uri})"></i></body>`);
    expect(r.images).toHaveLength(1);
    expect(r.html.match(/tawd-asset:photo-1/g)).toHaveLength(2);
  });

  it("refuses svg, a lying type and an oversized one, and says so", () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from("<svg onload=alert(1)/>").toString("base64")}`;
    const lie = `data:image/png;base64,${JPG}`;
    const big = `data:image/png;base64,${Buffer.alloc(9 * 1024 * 1024, 1).toString("base64")}`;
    const r = readHtmlMockup(`<body><img src="${svg}"><img src="${lie}"><img src="${big}"></body>`);
    expect(r.images).toHaveLength(0);
    expect(r.html).not.toContain("data:image");
    expect(r.warnings).toHaveLength(3);
    expect(r.warnings[0]).toContain("image/svg+xml");
    expect(r.warnings[1]).toContain("not really image/png");
    expect(r.warnings[2]).toContain("larger than 8 MB");
  });

  it("stops at the cap on the number of pictures", () => {
    const imgs = Array.from({ length: MAX_EXTRACTED_IMAGES + 2 }, (_, i) => {
      const b = Buffer.concat([Buffer.from("89504e47", "hex"), Buffer.from([i, i + 1, i + 2])]).toString("base64");
      return `<img src="data:image/png;base64,${b}">`;
    }).join("");
    const r = readHtmlMockup(`<body>${imgs}</body>`);
    expect(r.images).toHaveLength(MAX_EXTRACTED_IMAGES);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toContain("most TAWD takes");
  });
});

describe("readHtmlMockup: scripts", () => {
  it("removes scripts, handlers and javascript: links and reports each", () => {
    const html = `<body><script>document.querySelectorAll('details').forEach(d=>d.addEventListener('toggle',f))</script><script src="https://x.test/a.js"></script><a href="javascript:alert(1)" onclick="go()">x</a><a href=" &#106;avascript:evil()">y</a><button onmouseover='z()'>b</button></body>`;
    const r = readHtmlMockup(html);
    expect(r.html).toBe(`<body><a href="#">x</a><a href="#">y</a><button>b</button></body>`);
    expect(r.removed).toEqual([
      expect.stringContaining("2 scripts removed (one was the FAQ open/close; one was an outside script file)"),
      "2 inline event handlers removed (attributes like onclick that run script when clicked or loaded).",
      '2 javascript: links replaced with a plain "#" link.',
    ]);
  });

  it("leaves svg icons and the form byte for byte alone", () => {
    const svg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 1l2 2" fill="none" stroke="currentColor"/></svg>';
    const form = '<form action="/send" method="post"><input name="n" required><button type="submit">Send</button></form>';
    const css = '<style>a > b{content:">"}</style>';
    const html = `<body>${css}${svg}${form}</body>`;
    const r = readHtmlMockup(html);
    expect(r.html).toBe(html);
    expect(r.removed).toEqual([]);
  });

  it("does not take photos mentioned only inside a script", () => {
    const r = readHtmlMockup(`<body><script>var x="data:image/png;base64,${PNG}"</script></body>`);
    expect(r.images).toHaveLength(0);
  });
});

describe("readHtmlMockup on the real Sample Marketing Co. file", () => {
  const file = "C:/Users/jason/Downloads/sb-marketing-homepage-option-3.html";
  it.skipIf(!fs.existsSync(file))("reads it end to end", () => {
    const original = fs.readFileSync(file, "utf8");
    const r = readHtmlMockup(original);
    expect(r.images).toHaveLength(3);
    expect(r.html).not.toMatch(/<script/i);
    expect(r.html).not.toMatch(new RegExp("data:image/[a-z+]+;base64"));
    expect(r.html.match(/<svg\b/g)?.length).toBe(original.match(/<svg\b/g)?.length);
    expect(r.html.match(/<form\b/g)).toHaveLength(1);
    const ds = extractDesignSystem(r.html);
    expect(ds.header).not.toBe("");
    expect(ds.footer).not.toBe("");
  });
});

const b64 = (head: string | number[]) => Buffer.concat([typeof head === "string" ? Buffer.from(head) : Buffer.from(head), Buffer.from([9, 9, 9, 9])]).toString("base64");
const face = (mime: string, data: string) => `<style>@font-face{font-family:X;src:url(data:${mime};base64,${data}) format("woff2")}</style>`;

describe("readHtmlMockup: fonts", () => {
  it("lifts each font out of the css into a font token, kept apart from the photos", () => {
    const html = `<head>${face("font/woff2", b64("wOF2"))}${face("application/x-font-woff", b64("wOFF"))}${face("font/otf", b64("OTTO"))}${face("font/ttf", b64([0, 1, 0, 0]))}</head><body></body>`;
    const r = readHtmlMockup(html);
    expect(r.images).toHaveLength(0);
    expect(r.fonts.map((f) => [f.token, f.contentType, f.bytes.length])).toEqual([
      ["tawd-asset:font-1", "font/woff2", 8],
      ["tawd-asset:font-2", "font/woff", 8],
      ["tawd-asset:font-3", "font/otf", 8],
      ["tawd-asset:font-4", "font/ttf", 8],
    ]);
    expect(r.html).toContain("src:url(tawd-asset:font-1)");
    expect(r.html).not.toContain("base64");
  });

  it("gives one token to a font used twice", () => {
    const d = b64("wOF2");
    const r = readHtmlMockup(`<head>${face("font/woff2", d)}${face("font/woff2", d)}</head><body></body>`);
    expect(r.fonts).toHaveLength(1);
    expect(r.html.match(/tawd-asset:font-1/g)).toHaveLength(2);
  });

  it("refuses an unknown type, a lying type, an oversized font and too many, and says so", () => {
    const eot = face("application/vnd.ms-fontobject", b64("wOF2"));
    const lie = face("font/woff2", b64("OTTO"));
    const big = face("font/woff2", Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(3 * 1024 * 1024)]).toString("base64"));
    const many = Array.from({ length: MAX_EXTRACTED_FONTS + 1 }, (_, i) => face("font/woff2", b64([0x77, 0x4f, 0x46, 0x32, i]))).join("");
    const r = readHtmlMockup(`<head>${eot}${lie}${big}${many}</head><body></body>`);
    expect(r.fonts).toHaveLength(MAX_EXTRACTED_FONTS);
    expect(r.warnings).toHaveLength(4);
    expect(r.warnings[0]).toContain("application/vnd.ms-fontobject");
    expect(r.warnings[1]).toContain("not really font/woff2");
    expect(r.warnings[2]).toContain("larger than 2 MB");
    expect(r.warnings[3]).toContain("most TAWD takes");
  });

  it("does not lift a small non-base64 favicon out as a photo; the cleaner drops that link and says so", () => {
    const html = `<head><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E"></head><body></body>`;
    const r = readHtmlMockup(html);
    expect(r.images).toHaveLength(0);
    expect(r.html).toBe("<head></head><body></body>");
    expect(r.removed).toEqual([expect.stringContaining("1 <link> tag removed")]);
  });

  const file = "C:/Users/jason/Downloads/sb-marketing-homepage-option-3.html";
  it.skipIf(!fs.existsSync(file))("shrinks the real file's css to its real size", () => {
    const original = fs.readFileSync(file, "utf8");
    const before = extractDesignSystem(original).css.length;
    const r = readHtmlMockup(original);
    const after = extractDesignSystem(r.html).css.length;
    expect(r.fonts).toHaveLength(8);
    expect(r.warnings).toEqual([]);
    expect(after).toBeLessThan(before / 4);
    expect(r.html).not.toContain("data:font");
  });
});

/* ---------- the security review of 16 November 2026 ---------- */

/* What a browser would run: parsed back, no script, no handler, no frame, no refresh, no active address. */
function live(html: string): string[] {
  const hits: string[] = [];
  if (/<script\b/i.test(html)) hits.push("script");
  if (/<(iframe|object|embed)\b/i.test(html)) hits.push("embed");
  if (/<meta\b[^>]*http-equiv/i.test(html)) hits.push("meta refresh");
  if (/\bon[a-z]+\s*=/i.test(html.replace(/<style[\s\S]*?<\/style>/gi, ""))) hits.push("handler");
  if (/srcdoc\s*=/i.test(html)) hits.push("srcdoc");
  if (/(?:href|src|data)\s*=\s*["']?\s*(?:javascript|data:text)/i.test(html)) hits.push("active url");
  return hits;
}

describe("readHtmlMockup: the cleaner is the parser-based one (S1)", () => {
  const bypasses: Record<string, string> = {
    "a split script tag": "<scr<script></script>ipt>alert(1)</scr<script></script>ipt>",
    "an attribute with no space before it (img)": '<img src="a"/onerror=alert(1)>',
    "an attribute after a slash (a)": "<a/onclick=alert(1)>x</a>",
    "an attribute right after a quote (a)": '<a href="x"onclick=alert(1)>x</a>',
    "an attribute right after a quote (div)": "<div title='a'onmouseover=alert(1)>x</div>",
    "an empty comment hiding an img": "<!--><img src=x onerror=alert(1)>-->",
    "a style inside an svg": "<svg><style><img src=x onerror=alert(1)></style></svg>",
    "an iframe srcdoc": '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    "an iframe with a data page": '<iframe src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="></iframe>',
    "an object": '<object data="https://evil.test/x.swf"></object>',
    "an embed": '<embed src="https://evil.test/x.swf">',
    "a meta refresh": '<meta http-equiv="refresh" content="0;url=https://evil.test">',
  };
  for (const [name, attack] of Object.entries(bypasses)) {
    it(`kills ${name}`, () => {
      const r = readHtmlMockup(`<html><head></head><body>${attack}</body></html>`);
      expect(live(r.html)).toEqual([]);
    });
  }

  it("still reports what it removed, worked out from what the cleaner really took out", () => {
    const r = readHtmlMockup('<body><scr<script></script>ipt>alert(1)</scr<script></script>ipt><a href="x"onclick="go()">x</a><iframe src="https://evil.test"></iframe></body>');
    expect(r.removed.join(" ")).toContain("script");
    expect(r.removed.join(" ")).toContain("inline event handler");
    expect(r.removed.join(" ")).toContain("embedded frame");
  });
});

describe("readHtmlMockup: pathological input does not hang (S2)", () => {
  it("reads 2 MB of unterminated tags, scripts and comments in a few seconds at most", () => {
    for (const unit of ["<a", "<script ", "<a ", "<!--", '<a "', "<style>"]) {
      const started = Date.now();
      readHtmlMockup(`<body>${unit.repeat(Math.floor((2 * 1024 * 1024) / unit.length))}`);
      expect(Date.now() - started, `unit ${JSON.stringify(unit)}`).toBeLessThan(5000);
    }
  }, 60_000);

  it("reads a long run of base64-looking text and many half data addresses quickly", () => {
    const started = Date.now();
    readHtmlMockup(`<body>${"data:image/png;base64,AAAA\n".repeat(60_000)}${"A".repeat(1_000_000)}`);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 30_000);
});

describe("readHtmlMockup: uploaded css is cleaned (S3)", () => {
  it("drops a remote @import and url(), and keeps the photo and font tokens", () => {
    const font = b64("wOF2");
    const html = `<head><style>@import url(https://evil.test/x.css);@font-face{font-family:X;src:url(data:font/woff2;base64,${font})}body{background:url(https://tracker.test/p.gif)}.h{background:url('data:image/png;base64,${PNG}')}</style></head><body></body>`;
    const r = readHtmlMockup(html);
    expect(r.html).not.toContain("evil.test");
    expect(r.html).not.toContain("tracker.test");
    expect(r.html).toContain("url(tawd-asset:font-1)");
    expect(r.html).toContain("tawd-asset:photo-1");
    expect(r.images).toHaveLength(1);
    expect(r.fonts).toHaveLength(1);
    expect(r.removed.join(" ")).toContain("CSS was changed");
  });

  it("the built site's stylesheet is cleaned too, with the tokens swapped for paths", () => {
    const css = "@import url(https://evil.test/x.css);.a{background:url(tawd-asset:photo-1)}@font-face{src:url(tawd-asset:font-1)}.b{background:url(https://tracker.test/p.gif)}";
    const files = astroProject({
      clientName: "X",
      design: { css, fontLinks: [], header: "", footer: "", sections: [] },
      parts: { header: "", footer: "" },
      pages: [],
      images: [
        { token: "tawd-asset:photo-1", path: "/images/photo-1.png" },
        { token: "tawd-asset:font-1", path: "/fonts/font-1.woff2" },
      ],
    });
    const out = files.get("public/site.css")!;
    expect(out).not.toContain("evil.test");
    expect(out).not.toContain("tracker.test");
    expect(out).toContain("url(/images/photo-1.png)");
    expect(out).toContain("url(/fonts/font-1.woff2)");
  });
});

describe("readHtmlMockup: a data address wrapped over lines is read whole (S4)", () => {
  it("reads a photo and a font whose base64 is wrapped, and leaves no leftover base64", () => {
    const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(200, 7)]);
    const wrap = (b: Buffer) => b.toString("base64").replace(/(.{40})/g, "$1\r\n      ").trimEnd();
    const woff = Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(200, 5)]);
    const r = readHtmlMockup(`<head><style>@font-face{src:url(data:font/woff2;base64,${wrap(woff)})}</style></head><body><img src="data:image/png;base64,${wrap(png)}" alt="x"></body>`);
    expect(r.images).toHaveLength(1);
    expect(r.images[0]!.bytes.length).toBe(png.length);
    expect(r.fonts[0]!.bytes.length).toBe(woff.length);
    expect(r.html).not.toMatch(/[A-Za-z0-9+/]{20}/);
    expect(r.html).toContain('<img src="tawd-asset:photo-1" alt="x">');
  });

  it("still ends a data address at a space in a srcset", () => {
    const r = readHtmlMockup(`<body><img srcset="data:image/png;base64,${PNG} 2x, data:image/png;base64,${PNG} 1x" alt="x"></body>`);
    expect(r.html).toContain('srcset="tawd-asset:photo-1 2x, tawd-asset:photo-1 1x"');
  });
});

describe("readHtmlMockup: a dropped picture leaves a visible placeholder (S5)", () => {
  it("never leaves an empty src or url()", () => {
    const lie = `data:image/png;base64,${JPG}`;
    const r = readHtmlMockup(`<body><img src="${lie}" alt="a"><div style="background:url(${lie})"></div></body>`);
    expect(r.html).not.toMatch(/src=""|url\(\)|url\(""\)/);
    expect(r.html).toContain('src="tawd-asset:missing-photo-1"');
    expect(r.images).toHaveLength(0);
    expect(r.warnings[0]).toContain("[PLACEHOLDER]");
  });

  it("the site build turns that token into a visible [PLACEHOLDER] the go-live gate sees", () => {
    const files = astroProject({
      clientName: "X",
      design: { css: ".a{background:url(tawd-asset:missing-photo-1)}", fontLinks: [], header: "", footer: "", sections: [] },
      parts: { header: '<img src="tawd-asset:missing-photo-1" alt="a">', footer: "" },
      pages: [],
      images: [],
    });
    const layout = [...files.values()].join("\n");
    expect(placeholdersIn(layout)).toEqual(["[PLACEHOLDER: image missing-photo-1]"]);
  });
});

describe("readHtmlMockup: a huge character entity is not a crash (S6)", () => {
  it("reads &#x110000; and &#99999999999; without throwing", () => {
    expect(() => readHtmlMockup('<body><a href="&#x110000;javascript:x">a</a><a href="&#99999999999;">b</a></body>')).not.toThrow();
  });
  it("isActiveUrl and stripActiveContent do not throw on one either", () => {
    expect(() => isActiveUrl("&#x110000;")).not.toThrow();
    expect(() => stripActiveContent('<a href="&#x110000;">x</a>')).not.toThrow();
  });
});

describe("readHtmlMockup: photos only a script mentioned are dropped, the rest renumbered", () => {
  it("renumbers the surviving photos from 1", () => {
    const r = readHtmlMockup(`<body><script>var x="data:image/png;base64,${PNG}"</script><img src="data:image/jpeg;base64,${JPG}"></body>`);
    expect(r.images.map((i) => i.token)).toEqual(["tawd-asset:photo-1"]);
    expect(r.html).toContain('src="tawd-asset:photo-1"');
  });
});
