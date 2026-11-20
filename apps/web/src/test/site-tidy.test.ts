import fs from "node:fs";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/*
  Words and links, by code (Jason, 29 September 2026): garbled "MEET" names
  set from the card they're in, Terms of Use and Disclaimer out, the footer
  pointing at TAWD's privacy and cookie pages, Contact out, links pointed at
  their pages, the team's choices applied, the rest reported. Real Chrome;
  skipped where it isn't installed.
*/

import { tidyPage } from "../../../worker/src/site-tidy";
import { applySeo, withSharedChrome } from "../../../worker/src/site-exact";
import { suggestSeo } from "../../../worker/src/seo-suggest";
import { featureVideos, pageFromHome } from "../../../worker/src/site-videos";
import { parseVideoLink, readVideoLinks, videosPageMain } from "@tawd/core/site";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const hasChrome = fs.existsSync(CHROME);
const require = createRequire(import.meta.url);
type Browser = Parameters<typeof tidyPage>[0];
let browser: Browser;

beforeAll(async () => {
  if (!hasChrome) return;
  const { chromium } = require("../../../worker/node_modules/playwright-core");
  browser = await chromium.launch({ executablePath: CHROME });
});
afterAll(async () => {
  await browser?.close();
});

const PAGE = `<!doctype html><html><head></head><body>
<nav><ul><li>HOME</li><li>MEET THE PACK</li><li>BEAGLE TALK</li><li>VIDEOS</li><li>CONTACT</li></ul></nav>
<section>
  <div class="card"><span class="kit-ribbon-1">Biscuit</span><p>The fluffy dictator.</p><a class="btn">MEET BISCUIT</a></div>
  <div class="card"><span class="kit-ribbon-1">Scout</span><p>The derp.</p><a class="btn">MEET RANS</a></div>
  <div class="card"><span class="kit-ribbon-1">Maple</span><p>The observer.</p><a class="btn">MEET HARE</a></div>
  <a class="btn">MEET THE WHOLE PACK</a>
  <a>READ MORE</a><a>READ MORE</a><a>FOLLOW OUR PACK</a><a>WATCH MORE VIDEOS</a>
</section>
<footer><p>Home<br>Beagle Talk<br>Contact</p><p>© 2026 Nora. <a href="#">Privacy Policy</a> | <a href="#">Terms of Use</a> | <a href="#">Disclaimer</a></p></footer>
</body></html>`;

const INPUT = {
  pages: [
    { name: "Home", path: "/" },
    { name: "Meet the Pack", path: "/meet-the-pack/" },
    { name: "Biscuit", path: "/biscuit/" },
    { name: "Scout", path: "/scout/" },
    { name: "Maple", path: "/maple/" },
    { name: "Beagle Talk", path: "/beagle-talk/" },
    { name: "Videos", path: "/videos/" },
  ],
  names: [],
  privacyPath: "/privacy/",
  cookiePath: "/cookies/",
  extraLinks: [] as { match: string; path: string }[],
};

describe.skipIf(!hasChrome)("words and links, in a real browser", () => {
  it("fixes the garbled names, the footer and Contact, points the links, and reports the rest", async () => {
    const { html, report } = await tidyPage(browser, PAGE, INPUT);
    expect(report.changes).toEqual(expect.arrayContaining(['"MEET RANS" -> "MEET SCOUT" (the name in the same card)', '"MEET HARE" -> "MEET MAPLE" (the name in the same card)']));
    expect(html).not.toMatch(/Terms of Use|Disclaimer|CONTACT|Contact/);
    expect(html).toContain('<a href="/privacy/">Privacy Policy</a>');
    expect(html).toContain('<a href="/cookies/">Cookie Policy</a>');
    expect(html).toContain('<a class="btn" href="/scout/">MEET SCOUT</a>');
    expect(html).toContain('<a class="btn" href="/meet-the-pack/">MEET THE WHOLE PACK</a>');
    expect(html).toContain('<a href="/videos/">WATCH MORE VIDEOS</a>');
    expect(html).toContain('<li><a href="/beagle-talk/">BEAGLE TALK</a></li>');
    expect(report.unresolved.map((u) => u.text)).toEqual(["READ MORE", "READ MORE", "FOLLOW OUR PACK"]);

    // The team's choices: "READ MORE" to Beagle Talk, "FOLLOW OUR PACK" removed.
    const again = await tidyPage(browser, html, { ...INPUT, extraLinks: [{ match: "read more", path: "/beagle-talk/" }, { match: "follow our pack", path: "remove" }] });
    expect(again.html.match(/<a href="\/beagle-talk\/">READ MORE<\/a>/g)).toHaveLength(2);
    expect(again.html).not.toContain("FOLLOW OUR PACK");
    expect(again.report.unresolved).toEqual([]);
  }, 60_000);
});

describe.skipIf(!hasChrome)("one header and footer on every page", () => {
  it("puts the home page's header and footer in place of a page's own when they carry the same menu, keeping the page's section numbers", async () => {
    const home = `<!doctype html><html><head><style data-tawd-shell>@media (max-width:767px){[data-figma-section="1"],[data-figma-section="2"],[data-figma-section="5"]{display:none!important}}</style></head><body>
<header data-figma-section="1"><img src="/images/home/design-logo.png"><p>Real life with five Beagles.</p></header>
<nav data-figma-section="2"><a href="/">HOME</a><a href="/meet-the-pack/">MEET THE PACK</a><a href="/beagle-talk/">BEAGLE TALK</a></nav>
<section data-figma-section="3">Home's hero</section><footer data-figma-section="5"><p>Home's footer. © 2026</p></footer></body></html>`;
    const poppy = `<!doctype html><html><head></head><body>
<header data-figma-section="1"><img src="/images/poppy/design-logo.png"><p>Real life with five Beagles!</p></header>
<nav data-figma-section="2"><a>HOME</a><a>MEET THE PAKC</a><a>BEAGLE TALK</a></nav>
<section data-figma-section="3">Poppy's story</section><section data-figma-section="4">More about Poppy</section><footer data-figma-section="6"><p>Poppy's footer ©</p></footer></body></html>`;
    const out = await withSharedChrome(browser, poppy, home);
    expect(out).toContain("/images/home/design-logo.png");
    expect(out).toContain('<a href="/meet-the-pack/">MEET THE PACK</a>');
    expect(out).not.toContain("PAKC");
    expect(out).toContain("Poppy's story");
    expect(out).toContain(`<footer data-figma-section="6"><p>Home's footer.`);
    // A page whose top isn't the same menu keeps its own.
    const landing = poppy.replace(/<nav[\s\S]*?<\/nav>/, '<section data-figma-section="2">A special offer banner</section>').replace(/<header[\s\S]*?<\/header>/, '<section data-figma-section="1">Totally different</section>');
    expect(await withSharedChrome(browser, landing, home)).toContain("Totally different");
  }, 60_000);
});

describe("video links", () => {
  it("reads TikTok and Instagram video links into their players, with titles, and leaves out anything else", () => {
    expect(parseVideoLink("https://www.tiktok.com/@norahappybeaglelady/video/7412345678901234567?lang=en")).toMatchObject({ platform: "tiktok", embed: "https://www.tiktok.com/player/v1/7412345678901234567" });
    expect(parseVideoLink("https://instagram.com/reel/C9AbCdEfGhI/?igsh=x")).toMatchObject({ platform: "instagram", embed: "https://www.instagram.com/reel/C9AbCdEfGhI/embed" });
    expect(parseVideoLink("https://www.instagram.com/p/C9AbCdEfGhI/")!.embed).toBe("https://www.instagram.com/p/C9AbCdEfGhI/embed");
    expect(parseVideoLink("https://youtube.com/watch?v=1")).toBeNull();
    const read = readVideoLinks(["https://www.tiktok.com/@k/video/7412345678901234567 | Beagle howl concert", "", "not a link", "https://www.tiktok.com/@k/video/7412345678901234567"].join("\n"));
    expect(read.videos).toHaveLength(1);
    expect(read.videos[0]!.title).toBe("Beagle howl concert");
    expect(read.rejected).toEqual(["not a link"]);
    expect(videosPageMain(read.videos, [null])).toContain('data-src="https://www.tiktok.com/player/v1/7412345678901234567"');
  });
});

describe.skipIf(!hasChrome)("videos in the built site", () => {
  it("makes the home page's featured video cards click-to-play and a Videos page from its header and footer", async () => {
    const home = `<!doctype html><html><head><title>Nora: Home</title><style data-tawd-shell>@media (max-width:767px){[data-figma-section="1"],[data-figma-section="3"]{display:none!important}}</style></head><body>
<header class="tawd-m-header"><a href="/" aria-current="page">HOME</a><a href="/videos/">VIDEOS</a></header>
<header data-figma-section="1"><a href="/">HOME</a><a href="/videos/">VIDEOS</a></header>
<section data-figma-section="2"><h2>FEATURED VIDEOS</h2>
<div class="v"><div class="pic"><img src="/images/home/design-image-7.png"><span data-kit-icon="kit-icon-7"></span></div><p>Beagle Howl<br>Concert</p></div>
<div class="v"><div class="pic"><img src="/images/home/design-image-8.png"><span data-kit-icon="kit-icon-7"></span></div><p>Magic Treat Window</p></div></section>
<footer data-figma-section="3"><p>© 2026 Nora</p></footer></body></html>`;
    const videos = readVideoLinks(["https://www.tiktok.com/@k/video/7412345678901234567 | Morning zoomies", "https://www.instagram.com/reel/C9AbCdEfGhI/"].join("\n")).videos;
    const featured = await featureVideos(browser, home, videos, ["kit-icon-7"]);
    expect(featured.cards).toBe(2);
    expect(featured.pictures).toEqual(["/images/home/design-image-7.png", "/images/home/design-image-8.png"]);
    expect(featured.html).toContain('data-src="https://www.tiktok.com/player/v1/7412345678901234567"');
    expect(featured.html).toContain("<p>Morning zoomies</p>");
    expect(featured.html).toContain("Magic Treat Window");
    const page = await pageFromHome(browser, featured.html, videosPageMain(videos, featured.pictures), "/videos/", "Videos | Nora");
    expect(page).toContain("<title>Videos | Nora</title>");
    expect(page).not.toContain("FEATURED VIDEOS");
    expect(page).toContain('<a href="/videos/" aria-current="page">VIDEOS</a>');
    expect(page).toMatch(/<main><section class="tawd-videos"[\s\S]*<\/main><footer/);
  }, 60_000);
});


describe.skipIf(!hasChrome)("the SEO basics", () => {
  const PAGE = `<!doctype html><html><head><title>x</title><style>.big{font-size:64px;font-weight:700}</style></head><body>
<header><p>MENU</p></header>
<section><p class="big">MEET THE PACK</p><p>Five Beagles share one very loud house: meet Biscuit, Poppy, Scout, Maple and Ghost, and see what each one is really like.</p>
<div><img src="tawd-asset:design-image-1"><p>Biscuit</p></div><div><img src="tawd-asset:design-image-2" alt="Already described"><p>Poppy</p></div></section></body></html>`;

  it("suggests a title, a description, the H1 and alt text from the page's own words, noting what's missing", async () => {
    const s = await suggestSeo(browser, PAGE, { pageName: "MEET", siteName: "NoraHappyBeagleLady", isHome: false, tagline: null });
    expect(s.title).toBe("Meet | NoraHappyBeagleLady");
    expect(s.description.startsWith("Five Beagles share one very loud house")).toBe(true);
    expect(s.description.length).toBeLessThanOrEqual(158);
    expect(s.h1).toBe("Meet The Pack");
    expect(s.h1Now).toBe("no H1");
    expect(s.headingNotes[0]).toContain("no H1");
    expect(s.alts).toEqual([{ src: "tawd-asset:design-image-1", alt: "Biscuit" }]);
    const home = await suggestSeo(browser, PAGE, { pageName: "Home", siteName: "NoraHappyBeagleLady", isHome: true, tagline: "Real life with five Beagles." });
    expect(home.title).toBe("NoraHappyBeagleLady: Real life with five Beagles");
  }, 60_000);

  it("puts the approved alt text on its picture and makes the approved words the H1, looking the same", async () => {
    const built = PAGE.replace("tawd-asset:design-image-1", "/images/meet/design-image-1.png");
    const out = await applySeo(browser, built, { h1: "MEET THE PACK", alts: [{ src: "tawd-asset:design-image-1", alt: "Biscuit the Siberian Beagle" }] });
    expect(out).toContain('<img src="/images/meet/design-image-1.png" alt="Biscuit the Siberian Beagle">');
    expect(out).toContain('alt="Already described"');
    expect(out).toMatch(/<h1 class="big" style="font-size:64px;font-weight:700;[^"]*">MEET THE PACK<\/h1>/);
  }, 60_000);
});
