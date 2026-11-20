import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
  a client's site fixes (Jason, 29 September 2026), in TAWD itself: the
  finishing pass and the Site check rules, the fill of sibling pages, the
  intake originals, the photo trims, the video links, the share link, the
  personal-site privacy wording, the kit's icon markers. Real Chrome where
  it's needed (skipped without it).
*/

vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }) }));
vi.mock("@/app/actions", () => {
  const f = async () => ({ ok: true });
  return new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : f), has: () => true });
});

import { clearArea, readVideoLinks, renderPolicy, shortCaption, socialProfiles, withPolicyLinks, type PolicyFields } from "@tawd/core/site";
import { applyKit, type StyleKit } from "@tawd/core/style-kit/kit";
import type { FigmaNode } from "@tawd/core/figma";
import { DesignSiteFlow } from "@/components/mockups/design-site-flow";
import { designSourceOf, designSourceWords } from "@/lib/figma";
import type { DesignFlowView } from "@/lib/design-site";
import { trimDesignEdges } from "../../../worker/src/design-site";
import { useOriginals } from "../../../worker/src/originals";
import { finishSite } from "../../../worker/src/site-finish";
import { phoneCheck } from "../../../worker/src/phone-by-code";
import { featureVideos } from "../../../worker/src/site-videos";
import { fillInBrowser, planFill } from "../../../worker/src/template-fill";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const hasChrome = fs.existsSync(CHROME);
const require = createRequire(import.meta.url);
type Browser = Parameters<typeof finishSite>[0];
let browser: Browser;

beforeAll(async () => {
  if (!hasChrome) return;
  const { chromium } = require("../../../worker/node_modules/playwright-core");
  browser = await chromium.launch({ executablePath: CHROME });
});
afterAll(async () => {
  await browser?.close();
});

describe("by code, no browser", () => {
  it("reads video links however they're separated, cleans %20, and names what it can't read", () => {
    const text = "https://www.tiktok.com/@norahappybeaglelady/video/7639535161624759566,https://www.tiktok.com/@norahappybeaglelady/video/7658082845306473741 , https://www.instagram.com/reel/Cabc123xyz/%20 https://www.tiktok.com/@k/video/7682796244304973070 | Pool day\nnot a link, https://example.com/x";
    const { videos, rejected } = readVideoLinks(text);
    expect(videos.map((v) => v.embed)).toEqual([
      "https://www.tiktok.com/player/v1/7639535161624759566",
      "https://www.tiktok.com/player/v1/7658082845306473741",
      "https://www.instagram.com/reel/Cabc123xyz/embed",
      "https://www.tiktok.com/player/v1/7682796244304973070",
    ]);
    expect(videos[3]!.title).toBe("Pool day");
    expect(rejected).toEqual(["not a link,", "https://example.com/x"]);
    expect(socialProfiles(videos)).toEqual({ tiktok: "https://www.tiktok.com/@norahappybeaglelady" });
  });

  it("adds only the policy links a footer lacks, and cuts captions at a word", () => {
    const has = '<footer><a href="/privacy/">Privacy Policy</a> | <a href="/cookies/">Cookie Policy</a></footer>';
    expect(withPolicyLinks(has, false)).toBe(has);
    expect(withPolicyLinks("<footer><p>©</p></footer>", false)).toContain('<p class="tawd-privacy-links"><a href="/privacy/">Privacy Policy</a> · <a href="/cookies/">Cookie Policy</a></p>');
    expect(shortCaption("Multiple Beagle Syndrome: The Diagnosis Is Confirmed and There Is No Cure", 40)).toBe("Multiple Beagle Syndrome: The Diagnosis…");
  });

  it("gives a personal site the privacy wording without appointments or a business phone; a business keeps its own", () => {
    const fields: PolicyFields = { legalName: "NoraHappyBeagleLady", address: "Reno, NV", phone: "", privacyEmail: "nora@example.com", siteUrl: "https://norahappybeaglelady.com", hostingProvider: "Netlify", effectiveDate: "September 29, 2026" };
    const personal = renderPolicy("privacy", fields, null, [], { personal: true });
    expect(personal).not.toMatch(/appointment|service address|ZIP code|Phone:/);
    expect(personal).toContain("read and reply to your messages");
    const business = renderPolicy("privacy", { ...fields, phone: "(775) 555-0100" }, null);
    expect(business).toContain("schedule appointments and follow up about your service");
    expect(business).toContain("service address or ZIP code");
  });

  it("fills icon markers on any element (a circle made of a div), and marks icons traced from the design", () => {
    const kit = { icons: [{ ref: "kit-icon-1", svg: "<svg></svg>", label: "icon from the design", frame: null, frameColor: null, color: "#000", uses: [] }, { ref: "kit-icon-2", svg: "<svg><path/></svg>", label: "paw", frame: null, frameColor: null, color: "#000", uses: [] }] } as unknown as StyleKit;
    const { html } = applyKit('<div class="life-icon" data-kit-icon="kit-icon-2"></div><span data-kit-icon="kit-icon-1"></span>', kit, "");
    expect(html).toContain('<div class="life-icon" data-kit-icon="kit-icon-2" aria-hidden="true"><svg><path/></svg></div>');
    expect(html).toContain('data-kit-icon="kit-icon-1" aria-hidden="true" data-kit-traced><svg></svg>');
  });

  it("trims design marks off a photo's edge, and leaves a heading over its middle", () => {
    const photo = { x: 500, y: 200, w: 900, h: 500 };
    expect(clearArea(photo, [{ x: 600, y: 660, w: 300, h: 30 }])).toMatchObject({ y: 200, h: 444 });
    expect(clearArea(photo, [{ x: 800, y: 400, w: 200, h: 40 }])).toBeNull();
    expect(clearArea(photo, [])).toBeNull();
  });

  it("labels a design by where it really came from (a client's PDF was saved with the \"figma\" default)", () => {
    expect(designSourceOf({ source: "figma", url: "upload", fileKey: "upload", fileName: "NoraHappyBeagleLady_Finished_Website_Mockups.pdf" })).toBe("pdf");
    expect(designSourceWords({ source: "figma", url: "", fileName: "Nora.pdf" })).toBe("an uploaded PDF");
    expect(designSourceWords({ source: "upload", url: "upload", fileName: "home.png" })).toBe("uploaded images");
    expect(designSourceWords({ source: "figma", url: "https://www.figma.com/design/abc/Pat", fileName: "Pat - Well & Pump" })).toBe("Figma");
  });

  it("shows the share link only once a deploy has finished", () => {
    const view = { optionB: false, review: null, step: "preview", design: { ready: true, pages: 1, source: "Figma" }, pages: [{ id: "p", key: "home", name: "Home", slug: "", isHome: true, built: true, filledFrom: null }], videos: "", estimates: { home: { cost: 0, label: "$0", aiPages: 0, filledPages: 0, reused: 0 }, all: { cost: 0, label: "$0", aiPages: 0, filledPages: 0, reused: 0 } }, reworkLabel: "", building: null, preview: { version: 1, pages: [] }, site: { url: null, deploying: true, deployFailed: null, privateWarning: null }, approved: false, canRun: true, isAdmin: true } as unknown as DesignFlowView;
    expect(renderToStaticMarkup(<DesignSiteFlow projectId="x" view={view} />)).not.toContain("Share for review");
    const ready = { ...view, site: { ...view.site, url: "https://abc--nora.netlify.app", deploying: false } } as DesignFlowView;
    expect(renderToStaticMarkup(<DesignSiteFlow projectId="x" view={ready} />)).toContain("<code>https://abc--nora.netlify.app</code>");
  });
});

/* A small built site with the faults a client's had. */
function makeSite(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tawd-finish-"));
  const css = `body{margin:0;font-family:Arial}header{background:#0b1a4a}header a,header summary{color:#fff}.kit-button-1{background:#0b1a4a;color:#fff;padding:12px}.page a{color:#0b1a4a}[data-kit-icon="kit-icon-9"]{color:#0b1a4a}.grid6{display:grid;grid-template-columns:repeat(6,260px);gap:10px}.hero{padding:180px 20px}`;
  const header = `<header><a href="#main">Skip to content</a><a href="/"><img src="/images/logo.png" alt="Logo"></a><nav aria-label="Primary"><ul><li><a href="/">Home</a></li><li><details><summary>Meet the Pack</summary><ul><li><a href="/poppy/">Poppy</a></li><li><a href="/scout/">Scout</a></li></ul></details></li></ul></nav><a href="#" aria-label="TikTok"><span data-kit-icon="kit-icon-3"><svg viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg></span></a><a href="#" aria-label="Facebook"><span data-kit-icon="kit-icon-3"><svg viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg></span></a></header>`;
  const footer = `<footer><a href="/privacy/">Privacy Policy</a> | <a href="/cookies/">Cookie Policy</a><p class="tawd-privacy-links"><a href="/privacy/">Privacy Policy</a> · <a href="/cookies/">Cookie Policy</a></p></footer>`;
  const page = (title: string, main: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title} | Nora</title><meta name="description" content><link rel="canonical" href="https://nora.example/"><link rel="stylesheet" href="/site.css"></head><body>${header}<main id="main" class="page">${main}</main>${footer}</body></html>`;
  const write = (file: string, text: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  write("site.css", css);
  write("images/logo.png", png);
  write("images/dog.png", png);
  write("index.html", page("Home", `<section class="hero"><span class="signpost-pin" data-kit-icon="kit-icon-7"><svg viewBox="0 0 24 24"><path d="M6.18 6.38h11.69v2.68H6.17zm7.27 3.8v3.14"/></svg></span><img src="/images/dog.png" alt="The pack" style="width:600px;height:300px"><h1>Beagle Chaos</h1><p>Five Beagles. Plenty of naps, one muddy happy house with the whole pack every single day.</p></section><section><h2>Beagle Talk</h2><div class="posts"><article class="card"><h3>Why Beagles Howl</h3><a href="/beagle-talk/">READ MORE →</a></article><article class="card"><h3>Keeping Beagles Healthy</h3><a href="/beagle-talk/">READ MORE →</a></article></div></section><section><h2>Products</h2><div class="grid6"><div>a</div><div>b</div><div>c</div><div>d</div><div>e</div><div>f</div></div><h3>Product Name Goes Here</h3></section>`));
  write("poppy/index.html", page("POPPY", `<nav class="poppy-breadcrumb" aria-label="Breadcrumb"><a href="/">Home</a> &gt; <a href="/">Home</a> &gt; Poppy</nav><h1>POPPY</h1><p>Poppy is our sweet, elegant matriarch who leads the whole pack with love and calm confidence.</p><a class="kit-button-1" href="/poppy/"><span data-kit-icon="kit-icon-9"><svg viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg></span> FOLLOW POPPY</a><a class="kit-button-1" href="#">VIEW FULL GALLERY →</a><div class="rest"><div class="card"><img src="/images/dog.png" alt="Scout"><span class="name-ribbon">Scout</span><a href="/scout/">MEET SCOUT → →</a></div><div class="card"><img src="/images/dog.png" alt="Poppy"><span class="name-ribbon">Poppy</span><a href="/poppy/">MEET POPPY</a></div><div class="card"><img src="/images/dog.png" alt="Ghost"><span class="name-ribbon">Ghost</span><a href="#">MEET GHOST</a></div></div>`));
  write("scout/index.html", page("SCOUT", `<h1>POPPY</h1><h2>Poppy's Photo Gallery</h2><p>Scout is our goofy, dramatic, over-the-top Beagle with a heart of gold and a huge personality.</p><div class="glance"><p class="glance-label">AGE</p><p class="glance-value">AGE</p></div>`));
  return dir;
}

describe.skipIf(!hasChrome)("the finishing pass and the Site check rules", () => {
  it("fixes a client's faults by code, then checks the rules on what a visitor sees", async () => {
    const dir = makeSite();
    const pages = [
      { name: "Home", path: "/" },
      { name: "MEET", path: "/meet/" },
      { name: "POPPY", path: "/poppy/" },
      { name: "SCOUT", path: "/scout/" },
    ];
    const { notes } = await finishSite(browser, dir, { pages, socials: { tiktok: "https://www.tiktok.com/@nora" } });
    const home = fs.readFileSync(path.join(dir, "index.html"), "utf8");
    const poppy = fs.readFileSync(path.join(dir, "poppy/index.html"), "utf8");
    const scout = fs.readFileSync(path.join(dir, "scout/index.html"), "utf8");

    // Social icons: the real address, or gone.
    expect(home).toContain('href="https://www.tiktok.com/@nora"');
    expect(home).not.toContain('aria-label="Facebook"');
    // A brand's logo (Thumbtack's) matched to a signpost's pin, outside any link: gone.
    expect(home).not.toContain("signpost-pin");
    // Fake posts (teasers all leading to the same list page) gone; a placeholder word made TAWD's visible placeholder.
    expect(home).not.toContain("Why Beagles Howl");
    expect(home).toContain("[PLACEHOLDER: product name]");
    // The duplicate policy line under a footer that has both links.
    expect(home).not.toContain("tawd-privacy-links");
    // A description from the page's own words; a share picture; the skip link hidden.
    expect(home).toMatch(/<meta name="description" content="Five Beagles\. Plenty of naps/);
    expect(home).toContain('property="og:image"');
    expect(home).toContain('a[href="#main"]:not(:focus)');
    // The menu lists every page, the dropdown links its own page and marks the current one.
    expect(poppy).toMatch(/<summary[^>]*data-tawd-dropdown/);
    expect(poppy).toContain('<a href="/meet/">Meet the Pack</a>');
    expect(poppy).toMatch(/<a href="\/poppy\/" aria-current="page">Poppy<\/a>/);

    // Poppy: the breadcrumb from the site map; no link to the page itself; no dead button; one arrow; Ghost to his card's page; her own card gone.
    expect(poppy).toMatch(/<a href="\/">Home<\/a> <span aria-hidden="true">›<\/span> <a href="\/meet\/">Meet<\/a> <span aria-hidden="true">›<\/span> <span aria-current="page">Poppy<\/span>/);
    expect(poppy).not.toContain("FOLLOW POPPY");
    expect(poppy).not.toContain("VIEW FULL GALLERY");
    expect(poppy).toContain("MEET SCOUT →</a>");
    expect(poppy).not.toContain("MEET POPPY");
    expect(poppy).toContain("<title>Poppy | Nora</title>");

    // Scout: a sibling's name in the headings becomes the page's; a value that repeats its label becomes a placeholder.
    expect(scout).toContain("<h1>SCOUT</h1>");
    expect(scout).toContain("Scout's Photo Gallery");
    expect(scout).toContain("[PLACEHOLDER: age]");

    // The rules find nothing left on Poppy but what can't be fixed by code; the grid that overflowed wraps.
    expect(notes.get("/poppy/")!.filter((n) => !/larger than/.test(n))).toEqual([]);
    expect(notes.get("/")!.some((n) => /wide on a/.test(n))).toBe(false);
    expect(notes.get("/")!.join(" ")).toContain("Placeholder text on the page");
  }, 240_000);

  it("fails a page on each Site check rule", async () => {
    const dir = makeSite();
    // Nothing fixed first: the rules run straight on the faults (a page a client's build made before the pass).
    const { auditPage } = await import("../../../worker/src/site-finish");
    const { serve } = await import("../../../worker/src/site-build");
    const { server, origin } = await serve(dir);
    try {
      const pages = [{ name: "Home", path: "/" }, { name: "MEET", path: "/meet/" }, { name: "POPPY", path: "/poppy/" }, { name: "SCOUT", path: "/scout/" }];
      const parents = { "/poppy/": "/meet/", "/scout/": "/meet/" };
      const home = (await auditPage(browser, `${origin}/`, "/", pages, parents)).join("\n");
      expect(home).toMatch(/link.* go(es)? nowhere/);
      expect(home).toMatch(/wide on a 390px screen/);
      expect(home).toMatch(/Placeholder text on the page: Goes Here/);
      expect(home).toMatch(/no meta description/);
      const poppy = (await auditPage(browser, `${origin}/poppy/`, "/poppy/", pages, parents)).join("\n");
      expect(poppy).toMatch(/hard to see \(contrast under 3:1\)/);
      expect(poppy).toMatch(/The breadcrumb says "Home > Home"; the site map says "Home > Meet > Poppy"/);
      const scout = (await auditPage(browser, `${origin}/scout/`, "/scout/", pages, parents)).join("\n");
      expect(scout).toMatch(/Another page's name on this page: POPPY in the heading "POPPY"/);
      expect(scout).toMatch(/"At a glance" values equal to their labels: AGE/);
    } finally {
      server.close();
    }
  }, 240_000);
});

describe.skipIf(!hasChrome)("gap 9: footer titles, capped photos, room for a pinned bar", () => {
  function makeGap9Site(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tawd-gap9-"));
    // A 4x4 checker (not a flat colour, so it's kept as a photo rather than made a placeholder).
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAGklEQVR4nGMQsal4/fo1hGSAs0RsKhhwygAA3IIcSd6Rq1MAAAAASUVORK5CYII=", "base64");
    fs.mkdirSync(path.join(dir, "images"), { recursive: true });
    fs.writeFileSync(path.join(dir, "images/pic.png"), png);
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Home | Biz</title><meta name="description" content="Welcome to Biz, your local experts for everything around the home, every day of the week here."><link rel="canonical" href="https://biz.example/"><style>
body{margin:0;font-family:Arial}
.photo{width:600px;height:450px;display:block}
footer{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:24px}
.kit-box-title{position:absolute;left:50%;top:0;transform:translate(-50%,-50%)}
.callbar{position:fixed;left:0;right:0;bottom:0;height:56px;display:flex;align-items:center;justify-content:center;background:#0b1a4a}
.callbar a{color:#fff}
</style></head><body><main id="main"><section><h1>Welcome to Biz</h1><img class="photo" src="/images/pic.png" alt="Our crew at work on a home"><p>We are the local experts homeowners call for everything around the house, every single day of the week, rain or shine.</p></section></main><footer><div><h3 class="kit-box-title">SERVICES</h3><ul><li><a href="/a/">A</a></li></ul></div><div><h3 class="kit-box-title">AREAS</h3><ul><li><a href="/b/">B</a></li></ul></div><div><h3 class="kit-box-title">CONTACT</h3><ul><li><a href="/c/">C</a></li></ul></div></footer><div class="callbar"><a href="tel:+19165550142">Call (916) 555-0142</a></div></body></html>`;
    fs.writeFileSync(path.join(dir, "index.html"), html);
    return dir;
  }

  it("takes a stray kit-box-title off footer headings, caps the photo at its own width, and leaves room for the fixed call bar", async () => {
    const dir = makeGap9Site();
    await finishSite(browser, dir, { pages: [{ name: "Home", path: "/" }], socials: {} });
    const home = fs.readFileSync(path.join(dir, "index.html"), "utf8");
    // (a) the stray kit-box-title is off the footer headings (they flow in their grid again, not stacked in one spot).
    expect(home).not.toMatch(/<h3[^>]*class="[^"]*kit-box-title/);
    expect(home).toContain("SERVICES");
    // (d) the 4px photo is capped at its own width by code (inside min(100%, …) so it stays in its container), not shown at 600px.
    expect(home).toMatch(/<img[^>]*class="photo"/);
    expect(home).toMatch(/max-width:\s*min\(100%,\s*4px\)/);
    // (b) room at the end of the page for the bar pinned to the bottom of the phone screen.
    expect(home).toMatch(/@media \(max-width:767px\)\{body\{padding-bottom:\d+px!important\}\}/);
  }, 240_000);

  it("doesn't read a bar pinned to the screen as text overlapping the page, but still catches a real overlap (gap 9)", async () => {
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}.bar{position:fixed;left:0;right:0;bottom:0;height:56px;display:flex;align-items:center;justify-content:center;background:#003}.bar a{color:#fff}</style></head><body><p style="position:absolute;bottom:12px;left:10px;margin:0">Serving the whole area since 1998</p><p style="position:absolute;top:10px;left:10px;margin:0">OVERLAP ONE HERE</p><p style="position:absolute;top:14px;left:12px;margin:0">OVERLAP TWO HERE</p><div class="bar"><a href="tel:+19165550142">Call (916) 555-0142</a></div></body></html>`;
    const { problems } = await phoneCheck(browser, html, [], 390);
    // The fixed bar sitting over the page isn't an overlap fault.
    expect(problems.some((p) => p.kind === "overlapping" && /Call \(916\)/.test(p.detail))).toBe(false);
    // A genuine overlap of two ordinary texts is still caught.
    expect(problems.some((p) => p.kind === "overlapping" && /OVERLAP/.test(p.detail))).toBe(true);
  }, 120_000);
});

describe.skipIf(!hasChrome)("pictures and videos", () => {
  it("uses the intake's original for a design crop, in the same spot, and leaves a different photo alone", async () => {
    const page = await browser.newPage();
    // An "original" drawn by code, and a small softened crop of it (as a PDF would hold it).
    const [original, crop, other] = await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 900;
      c.height = 600;
      const x = c.getContext("2d")!;
      const g = x.createLinearGradient(0, 0, 900, 600);
      g.addColorStop(0, "#2d5a27");
      g.addColorStop(1, "#c9a36b");
      x.fillStyle = g;
      x.fillRect(0, 0, 900, 600);
      for (let i = 0; i < 40; i += 1) {
        x.fillStyle = `hsl(${(i * 37) % 360},60%,${30 + (i % 5) * 10}%)`;
        x.beginPath();
        x.arc((i * 97) % 900, (i * 53) % 600, 20 + (i % 7) * 8, 0, Math.PI * 2);
        x.fill();
      }
      const small = document.createElement("canvas");
      small.width = 150;
      small.height = 100;
      const s = small.getContext("2d")!;
      s.filter = "blur(1px)";
      s.drawImage(c, 300, 150, 300, 200, 0, 0, 150, 100);
      const o = document.createElement("canvas");
      o.width = 300;
      o.height = 200;
      const oc = o.getContext("2d")!;
      oc.fillStyle = "#88aacc";
      oc.fillRect(0, 0, 300, 200);
      oc.fillStyle = "#223";
      oc.fillRect(40, 40, 120, 80);
      return [c.toDataURL("image/png"), small.toDataURL("image/jpeg", 0.7), o.toDataURL("image/png")];
    });
    await page.close();
    const assets = [
      { token: "tawd-asset:poppy-design-image-1", dataUri: crop },
      { token: "tawd-asset:poppy-design-image-2", dataUri: other },
      { token: "tawd-asset:design-logo", dataUri: other },
    ];
    const done = await useOriginals(
      browser,
      { logo: { name: "logo.svg", contentType: "image/svg+xml", bytes: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>") }, photos: [{ name: "IMG_2041.png", contentType: "image/png", bytes: Buffer.from(original.split(",")[1]!, "base64") }] },
      assets,
    );
    expect(done.map((d) => d.token).sort()).toEqual(["tawd-asset:design-logo", "tawd-asset:poppy-design-image-1"]);
    expect(assets[2]!.dataUri.startsWith("data:image/svg+xml")).toBe(true);
    const size = await (await browser.newPage()).evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      return [img.naturalWidth, img.naturalHeight];
    }, assets[0]!.dataUri);
    // The same 300x200 part of the original, at the original's sharpness (the crop was 150x100).
    expect(size[0]).toBeGreaterThan(260);
    expect(size[0]).toBeLessThan(340);
    expect(assets[1]!.dataUri).toBe(other);
  }, 120_000);

  it("trims a light strip of design words off a photo's edge, and leaves a round photo's frame", async () => {
    const page = await browser.newPage();
    const [tabbed, round] = await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 400;
      c.height = 300;
      const x = c.getContext("2d")!;
      x.fillStyle = "#5a7a3a";
      x.fillRect(0, 0, 400, 300);
      x.fillStyle = "#ffffff";
      x.fillRect(0, 262, 400, 38);
      x.fillStyle = "#0b1a4a";
      x.font = "bold 14px Arial";
      x.fillText("PHOTO GALLERY    IN ACTION", 80, 286);
      const r = document.createElement("canvas");
      r.width = 200;
      r.height = 200;
      const y = r.getContext("2d")!;
      y.fillStyle = "#fff";
      y.fillRect(0, 0, 200, 200);
      y.fillStyle = "#6b8e23";
      y.beginPath();
      y.arc(100, 100, 96, 0, Math.PI * 2);
      y.fill();
      y.strokeStyle = "#0b1a4a";
      y.lineWidth = 4;
      y.stroke();
      return [c.toDataURL("image/png"), r.toDataURL("image/png")];
    });
    await page.close();
    const trimmed = await trimDesignEdges(browser, tabbed);
    expect(trimmed).not.toBeNull();
    const size = await (await browser.newPage()).evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      return [img.naturalWidth, img.naturalHeight];
    }, trimmed!);
    expect(size[0]).toBe(400);
    expect(size[1]).toBeLessThanOrEqual(262);
    expect(await trimDesignEdges(browser, round)).toBeNull();
  }, 120_000);

  it("makes each thumbnail with a play mark a video card, never a heading's play icon, and nothing in a card leads away", async () => {
    const html = `<!doctype html><html><body><main><section><div class="panel"><h2><span data-kit-icon="play"></span>FEATURED VIDEOS</h2><div class="grid"><div class="item"><a href="/videos/"><img src="a.jpg"><span data-kit-icon="play"></span></a><p>One</p></div><div class="item"><a href="/videos/"><img src="b.jpg"><span data-kit-icon="play"></span></a><p>Two</p></div></div></div></section></main></body></html>`;
    const videos = [
      { platform: "tiktok" as const, url: "https://www.tiktok.com/@k/video/1", embed: "https://www.tiktok.com/player/v1/1", title: "The whole pack howling at the fire engine that went by this morning" },
      { platform: "tiktok" as const, url: "https://www.tiktok.com/@k/video/2", embed: "https://www.tiktok.com/player/v1/2", title: "Pool day" },
    ];
    const out = await featureVideos(browser, html, videos, ["play"]);
    expect(out.cards).toBe(2);
    expect(out.html).not.toMatch(/class="panel"[^>]*data-tawd-video-card/);
    expect(out.html).not.toContain('href="/videos/"');
    expect(out.html).toContain("The whole pack howling at the fire engine…");
  }, 60_000);
});

describe.skipIf(!hasChrome)("a sibling page filled from its template", () => {
  const text = (id: string, characters: string, x: number, y: number, size = 16): FigmaNode => ({ id, name: characters, type: "TEXT", characters, style: { fontSize: size }, absoluteBoundingBox: { x, y, width: 120, height: size * 1.3 } }) as unknown as FigmaNode;
  const photo = (id: string, ref: string, x: number, y: number): FigmaNode => ({ id, name: "Photo", type: "RECTANGLE", fills: [{ type: "IMAGE", imageRef: ref }], absoluteBoundingBox: { x, y, width: 300, height: 200 } }) as unknown as FigmaNode;
  const frame = (children: FigmaNode[]): FigmaNode => ({ id: "f", name: "Page", type: "FRAME", absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 }, children }) as unknown as FigmaNode;

  it("takes Poppy's layout only: its own words and photos, labels stay labels, Poppy's leftovers go", async () => {
    const poppy = frame([
      text("1", "POPPY", 100, 100, 60),
      text("2", "AGE", 100, 300, 12),
      text("3", "10.5 Years", 100, 330, 14),
      text("4", "Our Mama Poppy", 900, 600, 20),
      photo("5", "m-hero", 700, 100),
      photo("6", "m-extra", 700, 500),
    ]);
    const maple = frame([
      text("1", "MAPLE", 100, 100, 60),
      text("2", "AGE", 100, 318, 12),
      text("3", "7 Years", 100, 300, 14),
      photo("5", "w-hero", 700, 100),
    ]);
    const plan = planFill({ frame: poppy, byImageRef: { "m-hero": "tawd-asset:poppy-design-image-1", "m-extra": "tawd-asset:poppy-design-image-2" }, name: "POPPY" }, { frame: maple, byImageRef: { "w-hero": "tawd-asset:maple-design-image-1" }, name: "MAPLE" });
    expect(plan.texts).toEqual(expect.arrayContaining([{ from: "POPPY", to: "MAPLE" }, { from: "10.5 Years", to: "7 Years" }]));
    expect(plan.texts.some((t) => t.from === "AGE")).toBe(false);
    expect(plan.removeTexts).toEqual(["Our Mama Poppy"]);
    expect(plan.removePhotos).toEqual(["tawd-asset:poppy-design-image-2"]);
    const source = `<main class="page-poppy"><h1>POPPY</h1><h2>Poppy's Photo Gallery</h2><p class="label">AGE</p><p class="value">10.5 Years</p><img src="tawd-asset:poppy-design-image-1" alt="Poppy in the leaves"><div class="extra"><img src="tawd-asset:poppy-design-image-2" alt="Poppy"></div><p class="quote">Our Mama Poppy</p></main>`;
    const { html } = await fillInBrowser(browser, source, plan);
    expect(html).toContain("<h1>MAPLE</h1>");
    expect(html).toContain("Maple's Photo Gallery");
    expect(html).toContain('<p class="label">AGE</p><p class="value">7 Years</p>');
    expect(html).toContain('src="tawd-asset:maple-design-image-1" alt="Maple in the leaves"');
    expect(html).not.toMatch(/Mama|poppy-design-image-2|class="extra"/);
  }, 60_000);
});
