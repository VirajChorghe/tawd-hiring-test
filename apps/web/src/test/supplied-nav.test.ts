import { describe, expect, it } from "vitest";

import { anchorPaths, deadLinks, headerNavLinks, menuPages, rewriteAnchors } from "@tawd/core/supplied-nav";
import { navKind, planFromNav } from "@/lib/seo-plan";

/*
  The menu of a homepage supplied as one HTML file (Jason, option A, 17
  November 2026): its items are the site's pages, and a link that pointed at
  a section of the home page points at the page that now holds it.

  The header below is the shape of the real file the team uploaded on 16
  November 2026 (Sample Marketing Co.): a logo outside the menu, six items in a
  <nav>, one of them going nowhere, and a call-to-action button that is not
  a page.
*/
const HEADER = `<header class="top"><div class="wrap hdr">
  <a href="#" aria-label="Sample Marketing Co. home"><svg class="logo"><title>Sample Marketing Co. logo</title></svg>Sample Marketing Co.</a>
  <nav aria-label="Main"><a href="#services">Services</a><a href="#approach">Our Approach</a><a href="#sarah">About Sarah</a><a href="#testimonials">Testimonials</a><a href="#">Insights</a><a href="#contact">Contact</a></nav>
  <a class="btn btn-primary" href="#contact">Start with a conversation</a>
</div></header>`;

describe("the menu of a supplied homepage", () => {
  it("is the <nav>'s items in order, without the logo or the call-to-action button", () => {
    expect(headerNavLinks(HEADER)).toEqual([
      { label: "Services", href: "#services" },
      { label: "Our Approach", href: "#approach" },
      { label: "About Sarah", href: "#sarah" },
      { label: "Testimonials", href: "#testimonials" },
      { label: "Insights", href: "#" },
      { label: "Contact", href: "#contact" },
    ]);
  });

  it("falls back to the header's own links when there is no <nav>, minus the logo, the phone and the skip link", () => {
    const plain = `<header><a class="sr" href="#main">Skip to content</a><a href="/">Home logo</a><a href="/about/">About</a><a href="tel:+15302272479">530-227-2479</a><a href="mailto:a@b.com">Email</a></header>`;
    expect(headerNavLinks(plain)).toEqual([{ label: "About", href: "/about/" }]);
    expect(headerNavLinks("")).toEqual([]);
  });

  it("reads an href however it is written, and never reads one that only looks like an href", () => {
    const header = `<nav aria-label="Main"><a href='#single'>Single</a><a href=#bare>Bare</a><a data-href="/decoy/" href="#real">Decoy</a></nav>`;
    expect(headerNavLinks(header)).toEqual([
      { label: "Single", href: "#single" },
      { label: "Bare", href: "#bare" },
      { label: "Decoy", href: "#real" },
    ]);
  });

  it("reads a label through its tags and entities, leaves icon text out, and never lists the same words twice", () => {
    const header = `<nav aria-label="Main"><a href="#a"><span>Caf&eacute;</span> &amp; <span>Sarah&#39;s</span> &#x27;Story&#x27;</a><a href="#b">Caf&eacute; &amp; Sarah&#39;s &#x27;Story&#x27;</a><a href="#c"><svg><title>Arrow icon</title></svg>Pricing</a></nav>`;
    expect(headerNavLinks(header)).toEqual([
      { label: "Café & Sarah's 'Story'", href: "#a" },
      { label: "Pricing", href: "#c" },
    ]);
  });

  it("is one item per place: a menu item repeated as a button is not a second page, but two that go nowhere both count", () => {
    const header = `<nav aria-label="Main"><a href="#contact">Contact</a><a href="#contact" class="btn">Get a quote</a><a href="#">Insights</a><a href="#">Careers</a></nav>`;
    expect(headerNavLinks(header).map((l) => l.label)).toEqual(["Contact", "Insights", "Careers"]);
  });

  it("never makes a page of a link that leaves the site", () => {
    const header = `<nav aria-label="Main"><a href="https://booking.example.com">Book a call</a><a href="//cdn.example.com/x">Protocol relative</a><a href="javascript:alert(1)">Bad</a><a href="/about/">About</a></nav>`;
    expect(headerNavLinks(header)).toEqual([{ label: "About", href: "/about/" }]);
  });

  /*
    The first version of this module read the file with regular expressions
    and said in its own comment that they were linear. A review measured 28
    seconds on 240 KB of "<a ", and the upload cap is 10 MB. This runs in the
    web app's own process, so a file like that would freeze the app for
    everyone. The parser reads it in one pass.
  */
  it("reads a hostile file in a moment, not in minutes", () => {
    const hostile = `<nav aria-label="Main">${"<a ".repeat(80_000)}</nav>`;
    const started = Date.now();
    headerNavLinks(hostile);
    deadLinks(hostile);
    rewriteAnchors(hostile, new Map([["#services", "/services/"]]));
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("what each menu item becomes", () => {
  it("is a page of the kind its own words name", () => {
    expect(navKind("Services")).toBe("hub");
    expect(navKind("About Sarah")).toBe("about");
    expect(navKind("Testimonials")).toBe("reviews");
    expect(navKind("Insights")).toBe("blog");
    expect(navKind("Contact")).toBe("contact");
    expect(navKind("Areas we serve")).toBe("service_areas");
    expect(navKind("Pricing")).toBe("pricing");
    expect(navKind("FAQ")).toBe("faq");
    // Nothing is guessed: a name TAWD does not know is a page, just not a kind it can name.
    expect(navKind("Our Approach")).toBe("other");
  });

  it("is the plan: the Home page as it was, then the menu in its own order", () => {
    const drafted = [
      { kind: "home" as const, name: "Home", slug: "", mainKeyword: "digital marketing reno", supportingKeywords: [], title: "Digital Marketing in Reno | SB", metaDescription: "m", h1: "Digital Marketing in Reno" },
      { kind: "contact" as const, name: "Contact", slug: "contact", mainKeyword: "", supportingKeywords: [], title: "Contact us | SB", metaDescription: "How to reach SB.", h1: "Contact SB" },
    ];
    const plan = planFromNav(headerNavLinks(HEADER), drafted, "Sample Marketing Co.");
    expect(plan.map((p) => p.name)).toEqual(["Home", "Services", "Our Approach", "About Sarah", "Testimonials", "Insights", "Contact"]);
    expect(plan.map((p) => p.slug)).toEqual(["", "services", "our-approach", "about-sarah", "testimonials", "insights", "contact"]);
    // The Home page is untouched: it is the page being kept.
    expect(plan[0]).toEqual(drafted[0]);
    // The ordinary plan's page of the same kind gives up its measured keywords and words rather than being thrown away.
    expect(plan.find((p) => p.kind === "contact")).toMatchObject({ name: "Contact", metaDescription: "How to reach SB.", h1: "Contact SB" });
    // A menu item the ordinary plan had nothing for still gets a title and a description.
    expect(plan.find((p) => p.name === "Our Approach")!.title).toBe("Our Approach | Sample Marketing Co.");
  });

  it("never plans a second home page, and never plans over a page every site already gets", () => {
    const home = { kind: "home" as const, name: "Home", slug: "", mainKeyword: "", supportingKeywords: [], title: "t", metaDescription: "m", h1: "h" };
    const nav = [
      { label: "Home", href: "#top" },
      { label: "Home page", href: "#hero" },
      { label: "Privacy Policy", href: "#privacy" },
      { label: "Services", href: "#services" },
    ];
    const plan = planFromNav(nav, [home], "Sample Marketing Co.");
    expect(plan.map((p) => p.name)).toEqual(["Home", "Privacy Policy", "Services"]);
    // The build writes its own policy at /privacy/, so the menu's page cannot take that path.
    expect(plan.map((p) => p.slug)).toEqual(["", "privacy-policy", "services"]);
    // A "Home" item sends its link to the home page rather than to a page of its own.
    expect(anchorPaths(nav, plan)).toEqual(new Map([["#top", "/"], ["#hero", "/"], ["#privacy", "/privacy-policy/"], ["#services", "/services/"]]));
  });

  it("leaves the plan exactly as it was when the design has no menu", () => {
    const drafted = [{ kind: "home" as const, name: "Home", slug: "", mainKeyword: "", supportingKeywords: [], title: "t", metaDescription: "m", h1: "h" }];
    expect(planFromNav([], drafted, "Sample Marketing Co.")).toBe(drafted);
  });
});

describe("the links inside the kept page", () => {
  const body = `<main><a href="#services">All services</a><a href="#services-intro">Jump</a><a href="#">Insights</a><a href="">Nothing</a><a href='#contact' class="btn">Start with a conversation</a><a href="tel:+15302272479">Call</a><a id="top"></a></main>`;
  const paths = anchorPaths(headerNavLinks(HEADER), [
    { name: "Home", slug: "" },
    { name: "Services", slug: "services" },
    { name: "Contact", slug: "contact" },
  ]);

  it("point at the pages that now hold them, and only on an exact match", () => {
    expect(paths).toEqual(new Map([["#services", "/services/"], ["#contact", "/contact/"]]));
    const out = rewriteAnchors(body, paths);
    expect(out.html).toContain(`<a href="/services/">All services</a>`);
    expect(out.html).toContain(`<a href="/contact/" class="btn">Start with a conversation</a>`);
    // Not a menu item: left exactly as the design wrote it.
    expect(out.html).toContain(`<a href="#services-intro">Jump</a>`);
    expect(out.html).toContain(`<a href="tel:+15302272479">Call</a>`);
    // Only what this page actually used is reported, not everything the menu allows.
    expect(out.moved).toEqual(["#services -> /services/", "#contact -> /contact/"]);
  });

  it("are left alone when the design's menu names no page of that name", () => {
    expect(anchorPaths(headerNavLinks(HEADER), [{ name: "Home", slug: "" }])).toEqual(new Map());
    expect(rewriteAnchors(body, new Map())).toEqual({ html: body, moved: [] });
    expect(rewriteAnchors(body, new Map([["#nothing-here", "/x/"]])).moved).toEqual([]);
  });

  it("is never confused by a link whose href is the name of something on every object", () => {
    const odd = `<main><a href="constructor">A</a><a href="__proto__">B</a></main>`;
    expect(rewriteAnchors(odd, new Map([["#services", "/services/"]])).html).toBe(odd);
  });

  it("list the ones that go nowhere, with the words a visitor would click", () => {
    expect(deadLinks(body)).toEqual([
      { label: "Insights", href: "#" },
      { label: "Nothing", href: `""` },
    ]);
    // An anchor with no href at all is a target, not a broken link.
    expect(deadLinks(`<a id="services"></a>`)).toEqual([]);
    // However the href is written.
    expect(deadLinks(`<a href='#'>Single</a><a href=#>Bare</a>`).map((d) => d.label)).toEqual(["Single", "Bare"]);
  });
});

describe("the menu the built site's header is given", () => {
  const plan = [
    { name: "Home", kind: "home", slug: "" },
    { name: "Services", kind: "hub", slug: "services" },
    { name: "Our Approach", kind: "other", slug: "our-approach" },
    { name: "About Sarah", kind: "about", slug: "about-sarah" },
    { name: "Testimonials", kind: "reviews", slug: "testimonials" },
    { name: "Insights", kind: "blog", slug: "insights" },
    { name: "Contact", kind: "contact", slug: "contact" },
  ];

  it("is the design's own, in its order, with the home page first", () => {
    expect(menuPages(HEADER, plan).map((p) => p.name)).toEqual(["Home", "Services", "Our Approach", "About Sarah", "Testimonials", "Insights", "Contact"]);
  });

  /*
    A page that is built and paid for is never left with no link to it (a
    review of the first version: one matching item was enough to cut every
    other page out of the menu, so a team-added page was built and linked
    from nowhere).
  */
  it("still lists a page the menu does not name, after the ones it does", () => {
    const extra = [...plan, { name: "Drain cleaning", kind: "service", slug: "drain-cleaning" }];
    expect(menuPages(HEADER, extra).map((p) => p.name)).toEqual([...plan.map((p) => p.name), "Drain cleaning"]);
    const older = [plan[0]!, { name: "Digital Marketing", kind: "service", slug: "digital-marketing" }, plan[6]!];
    expect(menuPages(HEADER, older).map((p) => p.name)).toEqual(["Home", "Contact", "Digital Marketing"]);
  });

  it("gives nothing back when the menu names no page at all, which leaves the header planned as before", () => {
    expect(menuPages(HEADER, [{ name: "Drain cleaning", kind: "service", slug: "drain-cleaning" }])).toEqual([]);
    expect(menuPages("", plan)).toEqual([]);
  });
});

/*
  What a second reviewer found in the first version of this module
  (CodeRabbit on #107). Each of these is a client's file doing something
  ordinary HTML allows, and each of them went wrong.
*/
describe("a client's file, read the way a browser would", () => {
  it("replaces the link's own href, not one written inside another attribute", () => {
    const page = `<main><a title='Example href="#old"' href="#services">Services</a></main>`;
    const out = rewriteAnchors(page, new Map([["#services", "/services/"]]));
    expect(out.html).toBe(`<main><a title='Example href="#old"' href="/services/">Services</a></main>`);
    expect(out.moved).toEqual(["#services -> /services/"]);
  });

  it("replaces an unquoted or single-quoted href, and keeps the rest of the tag", () => {
    const page = `<main><a class="x" href=#services data-k="1">A</a><a href='#services'>B</a></main>`;
    const out = rewriteAnchors(page, new Map([["#services", "/services/"]]));
    expect(out.html).toBe(`<main><a class="x" href="/services/" data-k="1">A</a><a href="/services/">B</a></main>`);
  });

  it("leaves a link alone when the attribute is there without a value, and when there is no href at all", () => {
    const page = `<main><a hidden href="#services">A</a><a>B</a></main>`;
    expect(rewriteAnchors(page, new Map([["#services", "/services/"]])).html).toBe(`<main><a hidden href="/services/">A</a><a>B</a></main>`);
  });

  it("reads a header nested far deeper than a call stack would allow", () => {
    const deep = `<header>${"<div>".repeat(20_000)}<nav aria-label="Main"><a href="#services">Services</a></nav>${"</div>".repeat(20_000)}</header>`;
    expect(headerNavLinks(deep)).toEqual([{ label: "Services", href: "#services" }]);
    expect(deadLinks(`${"<span>".repeat(20_000)}<a href="#">Nowhere</a>`)).toEqual([{ label: "Nowhere", href: "#" }]);
  });

  it("never writes a title with nothing in front of the bar when the business has no name yet", () => {
    const home = { kind: "home" as const, name: "Home", slug: "", mainKeyword: "", supportingKeywords: [], title: "t", metaDescription: "m", h1: "h" };
    const plan = planFromNav([{ label: "Our Approach", href: "#approach" }], [home], "   ");
    expect(plan[1]!.title).toBe("Our Approach | [PLACEHOLDER: business name]");
    expect(plan[1]!.metaDescription).toContain("[PLACEHOLDER: business name]");
  });
});
