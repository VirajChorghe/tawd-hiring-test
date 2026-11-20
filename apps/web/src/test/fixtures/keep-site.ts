/*
  A saved WordPress pest-control site for the "keep the current site" tests
  (6 October 2026): a sitemap index (pages, posts, categories, authors), the
  pages, two blog posts, the header menu, a footer, a cookie bar, a popup, a
  review widget, Elementor's copy for phones, a contact form, JSON-LD.
  Made up: Acme Pest Control isn't a real business. No network.
*/

export const SITE = "https://www.acmepest.example";

const header = `<header class="elementor elementor-location-header"><a class="skip-link screen-reader-text" href="#content">Skip to content</a>
<a href="${SITE}/"><img src="${SITE}/wp-content/uploads/logo.png" alt="Acme Pest Control" width="200" height="60"></a>
<nav aria-label="Menu"><ul>
<li><a href="${SITE}/">Home</a></li>
<li><a href="${SITE}/about-us/">About Us</a></li>
<li><a href="${SITE}/ant-control/">Ants</a></li>
<li><a href="${SITE}/rodent-control/">Rodents</a></li>
<li><a href="${SITE}/pest-control-folsom-ca/">Folsom</a></li>
<li><a href="${SITE}/specials/">Specials</a></li>
<li><a href="${SITE}/blog/">Blog</a></li>
<li><a href="${SITE}/contact/">Contact Us</a></li>
</ul></nav><a href="tel:9165550142">Call (916) 555-0142</a></header>`;

const footer = `<footer class="elementor elementor-location-footer"><p>Acme Pest Control, 12 Oak St, Folsom, CA 95630</p><p>Call (916) 555-0142</p>
<a href="${SITE}/privacy-policy/">Privacy Policy</a> <a href="${SITE}/cookie-policy/">Cookie Policy</a></footer>`;

const cookieBar = `<div id="cmplz-cookiebanner-container"><div class="cmplz-cookiebanner"><p>We use cookies to improve your experience.</p><button>Accept</button></div></div>`;
const popup = `<div class="elementor-location-popup"><h2>Get 20% off today!</h2><p>Sign up for our newsletter.</p></div>`;
const reviews = `<div class="ti-widget"><div class="ti-review-item"><p>Best pest service ever, five stars!</p><span>Gary A.</span></div></div>`;
const schema = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"LocalBusiness","name":"Acme Pest Control"},{"@type":"Product","aggregateRating":{"@type":"AggregateRating","ratingValue":"5"}}]}</script>`;

function page(input: { title: string; description?: string; canonical?: string; main: string; robots?: string; extraHead?: string }): string {
  return `<!doctype html><html lang="en-US"><head><meta charset="utf-8"><title>${input.title}</title>
${input.description !== undefined ? `<meta name="description" content="${input.description}">` : ""}
${input.canonical ? `<link rel="canonical" href="${input.canonical}">` : ""}
${input.robots ? `<meta name="robots" content="${input.robots}">` : ""}
<script>window.dataLayer = [];</script><style>.x{color:red}</style>${schema}${input.extraHead ?? ""}</head>
<body>${header}${cookieBar}<main id="content" class="site-main">${input.main}</main>${footer}${popup}<script src="${SITE}/wp-content/plugins/x.js"></script></body></html>`;
}

const cityWords = (city: string) => `<h1>Pest Control in ${city}, CA</h1>
<p>Acme Pest Control keeps homes in ${city} free of ants, spiders, rodents and cockroaches all year round.</p>
<p>Our licensed technicians inspect your home, treat the problem at its source and come back between visits at no extra charge if pests return.</p>
<p>We treat the outside of your home every other month, seal the gaps pests use to get in and leave you a written report after every visit.</p>
<p>Call us today for a free inspection and an honest price with no hidden fees, and we will book a visit that suits you.</p>`;

export const PAGES: Record<string, string> = {
  "/": page({
    title: "Acme Pest Control | Pest Control in Folsom, CA",
    description: "Acme Pest Control protects homes in Folsom and Roseville from ants, rodents and spiders. Licensed, local and family owned. Call for a free quote.",
    canonical: `${SITE}/`,
    main: `<section class="elementor-section"><div class="elementor-widget-heading"><h1>Family-Owned Pest Control in Folsom</h1></div>
<div class="elementor-widget-text-editor"><p>We have protected Folsom homes since 2012. Our bi-monthly plan starts at <strong>$40 per month</strong>.</p>
<p>See our <a href="${SITE}/ant-control/">ant control</a> service, or read our <a href="${SITE}/privacy-policy/">privacy policy</a>.</p></div>
<div class="elementor-widget-text-editor elementor-hidden-desktop"><p>We have protected Folsom homes since 2012. Our bi-monthly plan starts at $40 per month.</p></div>
<h2>Why choose us</h2><ul><li>Licensed (#OPR12345)</li><li>Pet-safe treatments</li><li>Free re-treatments</li></ul>
${reviews}
<div class="elementor-widget-form"><form><label>Name</label><input name="name"><textarea name="message"></textarea><button>Send</button></form></div>
<img src="${SITE}/wp-content/uploads/truck.jpg" alt="Our service truck"></section>`,
  }),
  "/about-us/": page({
    title: "About Us | Acme Pest Control",
    description: "Meet the Acme Pest Control team.",
    canonical: `${SITE}/about-us/`,
    main: `<h1>About Acme Pest Control</h1><p>Zack started Acme in 2012 after ten years with a national company.</p>
<blockquote>"We treat every home like our own."</blockquote>
<aside class="sidebar"><h3>Recent posts</h3><ul><li>Spring ants</li></ul></aside>`,
  }),
  "/contact/": page({
    title: "Contact | Acme Pest Control",
    description: "",
    canonical: `${SITE}/contact/`,
    main: `<h1>Contact Us</h1><h3>Call Us</h3><p>(916) 555-0142</p><h3>Email</h3><p>info@acmepest.example</p>
<div class="wpcf7"><form><input name="your-name"><input type="submit" value="Send"></form></div>`,
  }),
  "/ant-control/": page({
    title: "Ant Control In Folsom, CA - Fast, Pet-Safe Ant Treatments by Acme Pest Control",
    description: "Acme Pest Control protects homes in Folsom and Roseville from ants, rodents and spiders. Licensed, local and family owned. Call for a free quote.",
    canonical: `${SITE}/ant-control/`,
    main: `<h1>Ant Control in Folsom</h1><h1>Say goodbye to ants</h1>
<p>Ants come inside looking for water and food. We find the nest and treat it.</p>
<h2>Our prices</h2><table><thead><tr><th>Plan</th><th>Price</th></tr></thead><tbody><tr><td>One visit</td><td>$150</td></tr><tr><td>Bi-monthly</td><td>$40 per month</td></tr></tbody></table>
<h4>Common ants</h4><ol><li>Argentine ants</li><li>Carpenter ants</li></ol>
<p>Also see <a href="http://www.acmepest.example/rodent-control/">rodent control</a> and <a href="${SITE}/termite-control/">termites</a>.</p>
<p>Call <a href="tel:9165550199">(916) 555-0199</a> for a free quote.</p>
<img src="${SITE}/wp-content/uploads/ants.jpg"><img src="${SITE}/wp-content/uploads/IMG_2041.jpg" alt="IMG_2041.jpg">
<div class="elementor-widget-posts"><article><h3>Spring ants</h3><p>Read more</p></article></div>`,
  }),
  "/rodent-control/": page({
    title: "Rodent Control | Acme Pest Control",
    description: "Rodents in the attic? Acme Pest Control removes mice and rats and seals the gaps they use to get in, in Folsom and nearby.",
    main: `<h1>Rodent Control</h1><p>Mice and rats chew wires and spread disease.</p>`,
  }),
  "/pest-control-folsom-ca/": page({ title: "Pest Control in Folsom, CA | Acme Pest Control", description: "Pest control in Folsom.", canonical: `${SITE}/pest-control-folsom-ca/`, main: cityWords("Folsom") }),
  "/pest-control-roseville-ca/": page({ title: "Pest Control in Roseville, CA | Acme Pest Control", description: "Pest control in Roseville.", canonical: `${SITE}/pest-control-roseville-ca/`, main: cityWords("Roseville"), robots: "noindex, follow" }),
  "/specials/": page({ title: "Specials | Acme Pest Control", description: "Coupons and specials.", canonical: `${SITE}/`, main: `<h2>This month's specials</h2><p>$50 off your first service.</p>` }),
  "/blog/": page({ title: "Blog | Acme Pest Control", description: "Pest tips.", canonical: `${SITE}/blog/`, main: `<h1>Our Blog</h1><p>Tips from our technicians.</p><div class="elementor-widget-posts"><article><h3>Spring ants</h3></article></div>` }),
  "/blog/spring-ants/": page({
    title: "Why Ants Come Inside in Spring | Acme Pest Control",
    description: "Why ants come inside in spring, and what to do about it.",
    canonical: `${SITE}/blog/spring-ants/`,
    main: `<article><header class="entry-header"><h1>Why Ants Come Inside in Spring</h1></header><div class="entry-meta">Posted on March 3, 2026 by Zack</div>
<div class="entry-content"><p>Warm, wet spring weather drives ant colonies indoors.</p><h2>What you can do</h2><ul><li>Wipe counters</li><li>Fix leaks</li></ul></div>
<div class="sharedaddy"><h3>Share this:</h3></div><div id="comments" class="comments-area"><h2>Leave a reply</h2></div></article>`,
  }),
  "/blog/winter-mice/": page({
    title: "Mice in Winter | Acme Pest Control",
    description: "Mice move indoors in winter.",
    canonical: `${SITE}/blog/winter-mice/`,
    main: `<article><h1>Mice in Winter</h1><p>Mice move into warm attics when it gets cold.</p></article>`,
  }),
};

const sitemap = (urls: { loc: string; lastmod?: string }[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`).join("")}</urlset>`;

export const FILES: Record<string, { status: number; type: string; body: string; location?: string }> = {
  "https://acmepest.example/": { status: 301, type: "text/html", body: "", location: `${SITE}/` },
  [`${SITE}/robots.txt`]: { status: 200, type: "text/plain", body: `User-agent: *\nDisallow: /wp-admin/\nSitemap: ${SITE}/sitemap_index.xml\n` },
  [`${SITE}/sitemap_index.xml`]: {
    status: 200,
    type: "application/xml",
    body: `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${SITE}/post-sitemap.xml</loc></sitemap><sitemap><loc>${SITE}/page-sitemap.xml</loc></sitemap><sitemap><loc>${SITE}/category-sitemap.xml</loc></sitemap><sitemap><loc>${SITE}/author-sitemap.xml</loc></sitemap></sitemapindex>`,
  },
  [`${SITE}/page-sitemap.xml`]: {
    status: 200,
    type: "application/xml",
    body: sitemap(
      ["/", "/about-us/", "/contact/", "/ant-control/", "/rodent-control/", "/pest-control-folsom-ca/", "/pest-control-roseville-ca/", "/specials/", "/privacy-policy/", "/cookie-policy/", "/blog/", "/feed/", "/tag/ants/", "/old-page/", "/wp-content/uploads/menu.pdf"].map((p) => ({ loc: `${SITE}${p}` })),
    ),
  },
  [`${SITE}/post-sitemap.xml`]: {
    status: 200,
    type: "application/xml",
    body: sitemap([
      { loc: `${SITE}/blog/winter-mice/`, lastmod: "2025-12-01T10:00:00+00:00" },
      { loc: `${SITE}/blog/spring-ants/`, lastmod: "2026-03-03T10:00:00+00:00" },
    ]),
  },
  [`${SITE}/old-page/`]: { status: 404, type: "text/html", body: "<h1>Not found</h1>" },
  [`${SITE}/termite-control/`]: { status: 404, type: "text/html", body: "<h1>Not found</h1>" },
};
for (const [path, html] of Object.entries(PAGES)) FILES[`${SITE}${path}`] = { status: 200, type: "text/html; charset=UTF-8", body: html };

/* A fetch that serves the saved site; anything else is a 404. Records what was asked for. */
export function siteFetch(asked: string[] = [], overrides: Record<string, { status: number; type: string; body: string; location?: string }> = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    asked.push(url);
    const file = overrides[url] ?? FILES[url];
    if (!file) return new Response("<h1>Not found</h1>", { status: 404, headers: { "content-type": "text/html" } });
    const headers: Record<string, string> = { "content-type": file.type };
    if (file.location) headers.location = file.location;
    return new Response(file.status >= 300 && file.status < 400 ? null : file.body, { status: file.status, headers });
  }) as typeof fetch;
}
