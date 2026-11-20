import type { PageAsset } from "@tawd/core/mockups";

import type { CanaryFixture } from "./canary";

/*
  The canary's pages (10 November 2026).

  Every fixture stands for a fault that actually reached a client run, named
  in its `why`. They are TAWD-shaped but written here, not copied from a
  client's site: no client's words, numbers or photographs are in the repo.

  Adding one is cheap and always worth it. The rule when a fault is found in
  a real run: before fixing it, add the page that shows it here, so the
  canary would have caught it, and so it can never come back unnoticed.
*/

const BRAND = "#12305a";
const ORANGE = "#e0662b";

const facts = {
  phones: ["(916) 555-0142"],
  /*
    Written the way a California contractor's licence is typed, with a space
    between the classification and the number (10 November 2026). The canary
    found that this exact shape was reported as an INVENTED licence, because
    the pattern stopped at the space. The reference page states it correctly,
    so if that regresses the canary shouts.
  */
  licenseNumbers: ["C-36 998811"],
  yearFounded: 2004,
  businessName: "Canary Patio Covers",
  cities: ["Sacramento", "Folsom"],
  serviceNames: ["Patio covers", "Retractable awnings", "Sunrooms"],
  pictures: { stockAvailable: false, brandColors: [BRAND, ORANGE], trade: "home services" },
} as CanaryFixture["facts"];

const photo = (n: number): PageAsset =>
  ({ token: `tawd-asset:photo-${n}`, kind: "photo", caption: `Photo ${n}`, fileName: `photo-${n}.jpg`, width: 1200, height: 800 }) as PageAsset;

/* A 1x1 transparent PNG: a real <img> that loads, with no client's photograph in the repo. */
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/Vg0AAAAASUVORK5CYII=";

const head = (title: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="description" content="Patio covers, retractable awnings and sunrooms in Sacramento and Folsom, built by a licensed team since 2004.">
<style>body{margin:0;font-family:system-ui,sans-serif;color:#18212b}section{padding:72px 48px}h1{font-size:44px;margin:0 0 16px}h2{font-size:30px;margin:0 0 12px}
.band-brand{background:${BRAND};color:#fff}.cta{display:inline-flex;min-height:48px;align-items:center;padding:0 24px;background:${BRAND};color:#fff;text-decoration:none;border-radius:8px}
img{max-width:100%;height:auto;display:block}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}.icon{font-size:28px;color:${BRAND}}</style></head><body>`;

const header = `<header style="padding:20px 48px"><img data-tawd-logo src="${PIXEL}" alt="Canary Patio Covers" width="140" height="40"><a href="tel:+19165550142">(916) 555-0142</a></header>`;

const hero = (photoToken: string) => `<!-- band 1 --><section class="hero"><h1>Patio covers in Sacramento</h1>
<p>Licensed since 2004, licence C-36 998811, serving Sacramento and Folsom.</p>
<a class="cta" href="#quote">Request a quote</a><img src="${photoToken}" alt="A finished patio cover" width="1200" height="800"></section>`;

/*
  The icon slot's word and the card's heading are separate things: the
  heading names the intake's service, the slot says what the icon shows.
  The "words-with-no-icon" fixture puts the service name in the slot too,
  which is what a client's builder did and why F6 was visible.
*/
const services = (cards: { icon: string; title: string }[]) => `<!-- band 2 --><section><h2>What we build</h2><div class="cards">${cards
  .map((card) => `<div><span class="icon" data-tawd-icon="${card.icon}"></span><h3>${card.title}</h3><p>Built to last, fitted by our own team.</p></div>`)
  .join("")}</div></section>`;

const NAMED_SERVICES = [
  { icon: "home", title: "Patio covers" },
  { icon: "window", title: "Retractable awnings" },
  { icon: "sun", title: "Sunrooms" },
];

const why = `<!-- band 3 --><section class="band-brand"><h2>Why Canary Patio Covers</h2><div class="cards">
<div><span class="icon" data-tawd-icon="shield"></span><h3>Licensed and insured</h3><p>Licence C-36 998811.</p></div>
<div><span class="icon" data-tawd-icon="clock"></span><h3>Twenty years</h3><p>Building since 2004.</p></div>
<div><span class="icon" data-tawd-icon="map-pin"></span><h3>Sacramento and Folsom</h3><p>Both cities, every week.</p></div></div></section>`;

const process = `<!-- band 4 --><section><h2>How it works</h2><ol><li>You call or send the form.</li><li>We measure and quote.</li><li>We build it.</li></ol></section>`;

const areas = `<!-- band 5 --><section><h2>Where we work</h2><p>Sacramento and Folsom.</p><img src="${PIXEL}" alt="Our van in Folsom" width="800" height="400"></section>`;

const contact = `<!-- band 6 --><section id="quote"><h2>Request a quote</h2><form method="post" action="/quote">
<label for="name">Your name</label><input id="name" name="name" type="text" required>
<label for="phone">Phone</label><input id="phone" name="phone" type="tel" required>
<label for="detail">What do you need?</label><textarea id="detail" name="detail"></textarea>
<button type="submit" style="min-height:48px">Request a quote</button></form>
<p>Or call <a href="tel:+19165550142">(916) 555-0142</a>.</p></section>`;

const footer = `<footer style="padding:40px 48px;background:#18212b;color:#fff">Canary Patio Covers, licence C-36 998811. <a href="tel:+19165550142" style="color:#fff">(916) 555-0142</a></footer>`;

/*
  The quote form on a brand band (Clear Sky Awning, 10 November 2026).

  The page's own CSS sets the labels white, inside a white card, with
  !important and two classes - specificity (0,2,1). TAWD's contrast fix was
  written as "html body .tawd-fix-N", which is (0,1,2), so the page's rule
  won: five inputs shipped with no labels a visitor could see, the Creative
  Director scored the concept down for a form it could not fill in, and two
  paid fix rounds were spent re-fixing text that never changed. Every report
  said the contrast was fixed.

  What this page measures is not the rule TAWD writes, it is whether the
  page changed: renderedAfterFixes must not hold a11y.contrast.
*/
const formCardBand = `<!-- band 7 --><section class="band-brand"><style>
.form-card{background:#fff;border-radius:12px;padding:32px;max-width:520px}
.band-brand .form-card label{color:#fff !important;display:block;margin:0 0 6px;font-size:15px;font-weight:600}
.form-card input,.form-card textarea{width:100%;min-height:44px;margin:0 0 16px}</style>
<h2>Free quote</h2><div class="form-card"><form method="post" action="/quote">
<label for="f-name">Your name</label><input id="f-name" name="name" type="text" required>
<label for="f-phone">Phone</label><input id="f-phone" name="phone" type="tel" required>
<label for="f-detail">What do you need?</label><textarea id="f-detail" name="detail"></textarea>
<button type="submit" style="min-height:48px">Request a quote</button></form></div></section>`;

/*
  The articles band, and the "Call or text" link beside it (a client's site
  Awning, 10 November 2026).

  Two faults in one band, both of them code's own:

  - The 1px rule above each post is white on white, so the band reads as
    three runs of bare text. Code's contrast work only ever looked at text,
    so a line drawn in the background's own colour was invisible to it.
  - The icon slot says "text us". TAWD's set HAS a chat bubble
    (message-circle), and "text" alone reaches it, but only as the whole
    word on its own: every phrasing a builder actually writes - "text us",
    "chat with us", "texting" - fell through to the plain dot, and the
    Creative Director marked the concept down for icons TAWD could have
    drawn correctly.
*/
const articlesBand = `<!-- band 8 --><section><style>
.posts{display:grid;grid-template-columns:repeat(3,1fr);gap:32px}
.post{border-top:1px solid #ffffff;padding-top:24px}</style>
<h2>Patio cover guides and answers</h2>
<p><a href="sms:+19165550142"><span class="icon" data-tawd-icon="text us"></span>Call or text</a></p>
<div class="posts">
<div class="post"><h3>Aluminium or wood?</h3><p>What each costs to keep.</p></div>
<div class="post"><h3>Do I need a permit?</h3><p>How the city decides.</p></div>
<div class="post"><h3>Lattice or solid?</h3><p>How much shade each gives.</p></div></div></section>`;

const whole = (photoToken = "tawd-asset:photo-1", cards = NAMED_SERVICES) =>
  `${head("Patio covers in Sacramento | Canary Patio Covers")}${header}${hero(photoToken)}${services(cards)}${why}${process}${areas}${contact}${footer}</body></html>`;

export const CANARY_FIXTURES: CanaryFixture[] = [
  {
    name: "whole-page",
    why: "The healthy page every other fixture is measured against. If its numbers move, something changed for every client.",
    html: whole(),
    facts,
    assets: [photo(1), photo(2)],
    expectations: { services: facts.serviceNames, pageRules: true, rhythm: { brandColors: [BRAND, ORANGE], direction: "classic_trust", hasPhotos: true } },
  },
  {
    name: "hero-only-truncated",
    why: "F3 and F2: a reply cut off mid-page was stored as finished, and EVERY pre-existing check passed on it, because the hero holds the H1, the phone link and the form.",
    html: `${head("Patio covers in Sacramento | Canary Patio Covers")}${header}${hero("tawd-asset:photo-1")}${contact.slice(0, 220)}`,
    facts,
    assets: [photo(1)],
  },
  {
    name: "words-with-no-icon",
    why: "F6: a client's three services were three identical houses. These three words are not in the pinned set, so each must become a reported dot.",
    html: whole("tawd-asset:photo-1", [
      { icon: "retractable awning", title: "Retractable awnings" },
      { icon: "patio cover", title: "Patio covers" },
      { icon: "sunroom", title: "Sunrooms" },
    ]),
    facts,
    assets: [photo(1), photo(2)],
  },
  {
    name: "one-photo-twice",
    why: "F8: the same photograph in two bands while another of the client's photos went unused, and nothing noticed.",
    html: whole("tawd-asset:photo-1").replace('<img src="' + PIXEL + '" alt="Our van in Folsom"', '<img src="tawd-asset:photo-1" alt="Our van in Folsom"'),
    facts,
    assets: [photo(1), photo(2), photo(3)],
  },
  {
    name: "photos-read-from-the-site",
    why: "F30: measureRichness counted /photo-N$/ only, so photos read from a client's current site (photo-site-N) were invisible and Design + content was always measured image-poor.",
    html: whole("tawd-asset:photo-site-1").replace('<img src="' + PIXEL + '" alt="Our van in Folsom"', '<img src="tawd-asset:photo-site-2" alt="Our van in Folsom"'),
    facts,
    assets: [
      { token: "tawd-asset:photo-site-1", kind: "photo", caption: "From the site", fileName: "photo-site-1.jpg", width: 1200, height: 800 } as PageAsset,
      { token: "tawd-asset:photo-site-2", kind: "photo", caption: "From the site", fileName: "photo-site-2.jpg", width: 800, height: 400 } as PageAsset,
    ],
  },
  {
    name: "taller-than-the-cap",
    why: "F35, a client's screen: a page past the 12,000px cap was photographed as its first screen while the checks and the Creative Director read the slices and saw all its bands. imageHeightPx must still be the whole page.",
    html: `${head("Patio covers in Sacramento | Canary Patio Covers")}${header}${hero("tawd-asset:photo-1")}${services(NAMED_SERVICES)}${why}${Array.from(
      { length: 14 },
      (_, i) => `<!-- band ${i + 5} --><section style="min-height:1100px"><h2>More about patio covers, part ${i + 1}</h2><p>A tall band, so the page passes the height cap.</p></section>`,
    ).join("")}${contact}${footer}</body></html>`,
    facts,
    assets: [photo(1), photo(2)],
  },
  {
    name: "form-card-on-a-brand-band",
    why: "A client's site: the page's own two-class !important rule outranked TAWD's contrast fix, so the quote form's labels stayed white on white and two paid fix rounds changed nothing. renderedAfterFixes is the measurement that cannot be fooled.",
    html: `${head("Patio covers in Sacramento | Canary Patio Covers")}${header}${hero("tawd-asset:photo-1")}${services(NAMED_SERVICES)}${formCardBand}${footer}</body></html>`,
    facts,
    assets: [photo(1)],
  },
  {
    name: "invisible-rule-and-text-icon",
    why: "A client's site: a 1px white rule on a white background (code's contrast work never looked at anything but text) and an icon slot saying \"text us\", which fell to a plain dot although the pinned set has a chat bubble.",
    html: `${head("Patio covers in Sacramento | Canary Patio Covers")}${header}${hero("tawd-asset:photo-1")}${services(NAMED_SERVICES)}${articlesBand}${contact}${footer}</body></html>`,
    facts,
    assets: [photo(1)],
  },
];
