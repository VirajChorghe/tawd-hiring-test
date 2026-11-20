import { describe, expect, it, vi } from "vitest";

import { consentBanner, consentBannerWorks, isActiveUrl, stripActiveContent, stripActiveContentInPage, type TrackingConfig } from "@tawd/core/site";

/*
  The whole-code review (13 October 2026), High 1: a built site seen inside
  TAWD runs nothing, and nothing the AI writes can run on a client's site.
*/

const files = new Map<string, Buffer>();

vi.mock("@/lib/session", () => ({ requireUser: async () => ({ id: "u1" }) }));
vi.mock("@tawd/core/intake/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tawd/core/intake/storage")>()),
  getStorage: () => ({ get: async (key: string) => files.get(key) ?? null }),
}));

const { GET } = await import("@/app/(app)/projects/[id]/build/site/[version]/[[...path]]/route");

describe("a built site inside TAWD", () => {
  it("is served in a sandbox where none of its scripts run", async () => {
    const id = "6f1c2a52-8a54-4c55-9e0a-0d5c7a1b2c3d";
    files.set(`projects/${id}/site/v1/index.html`, Buffer.from('<html><body><img src="x" onerror="alert(1)"></body></html>'));
    const response = await GET(new Request("http://x"), { params: Promise.resolve({ id, version: "1", path: [] }) });
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/^sandbox allow-same-origin/);
    expect(csp).not.toContain("allow-scripts");
    expect(csp).toContain("script-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("code the AI writes, taken out before the files are written", () => {
  it("drops scripts and handlers, and any structured data the model wrote (TAWD adds its own to the head, F-011)", () => {
    const html =
      '<footer><script>fetch("/x")</script><img src="/images/a.jpg" alt="" onerror="go()" ONLOAD=\'x\'><script type="application/ld+json">{"a":1}</script><svg onload=evil()><circle r="2"/></svg></footer>';
    expect(stripActiveContent(html)).toBe('<footer><img src="/images/a.jpg" alt=""><svg><circle r="2"/></svg></footer>');
  });

  it("turns addresses that run code into #, however they're disguised", () => {
    for (const href of ["javascript:alert(1)", " JavaScript:x", "java&#9;script:x", "java&#x09;script:x", "jav&tab;ascript:x", "vbscript:x", "data:text/html,<b>"]) {
      expect(isActiveUrl(href)).toBe(true);
      expect(stripActiveContent(`<a class="btn" href="${href}">Go</a>`)).toBe('<a class="btn" href="#">Go</a>');
    }
    expect(stripActiveContent('<iframe srcdoc="<script>x</script>" src="https://calendly.com/x"></iframe>')).toBe('<iframe src="https://calendly.com/x"></iframe>');
  });

  it("keeps no script at all, whatever type it claims (CodeRabbit, PR #5; F-011)", () => {
    expect(stripActiveContent('<p>a</p><script data-type="application/ld+json">fetch("/x")</script>')).toBe("<p>a</p>");
    expect(stripActiveContent("<script type='application/ld+json'>{}</script>")).toBe("");
  });

  it("cleans only the AI's parts of a whole page, so TAWD's consent banner keeps working", () => {
    const banner = consentBanner({ consentMode: "opt_in" } as TrackingConfig, { floor: "opt_out", honorGpc: true, symmetricalButtons: true, optOutHonoredNotice: true, privacyChoicesLink: true });
    expect(banner).toContain("onclick=\"tawdConsent('granted')\"");
    const page = `<html><head><script type="application/ld+json">{}</script><script>window.tawdConsent=function(){}</script></head><body><header><a href="javascript:x()">Hi</a></header><main id="main"><img src="/a.jpg" onerror="x()"></main><footer><script>x()</script><p>Website by Velocity Media Lab</p></footer>${banner}<div id="tawd-consent"><button onclick="x()">Fake</button></div></body></html>`;
    const out = stripActiveContentInPage(page, [banner]);
    // TAWD's own banner, exactly as TAWD writes it, keeps its buttons; a look-alike with its id is cleaned (CodeRabbit, PR #5).
    expect(out).not.toContain("x()");
    expect(out).toContain(banner);
    expect(out).toContain('<div id="tawd-consent"><button>Fake</button></div>');
    expect(out).toContain("<script>window.tawdConsent=function(){}</script>");
    expect(out).toContain('<script type="application/ld+json">{}</script>');
    // An exact copy's sections straight in <body> are cleaned too; TAWD's own video script stays (CodeRabbit, PR #5).
    const video = "<script>document.addEventListener('click',function(){})</script>";
    const exact = `<html><head><title>x</title></head><body><section class="hero"><script>steal()</script><a href="javascript:steal()">Go</a></section>${video}</body></html>`;
    const cleaned = stripActiveContentInPage(exact, [video]);
    expect(cleaned).not.toContain("steal()");
    expect(cleaned).toContain(video);
    // Tag-like text in an attribute never ends the part being cleaned.
    expect(stripActiveContentInPage('<body><main data-x="</main>"><script>alert(1)</script></main></body>')).not.toContain("alert(1)");
  });

  /*
    Audit F-005 (12 November 2026): the finishing step saves each page as the
    browser rewrote it, which writes the banner's `hidden` as `hidden=""`. The
    speed pass then no longer recognised TAWD's own banner, took its buttons'
    onclick away, and visitors got a banner they could not answer or close.
  */
  it("still knows TAWD's banner after the browser has rewritten it, and still cleans a look-alike", () => {
    for (const consentMode of ["opt_in", "opt_out"] as const) {
      for (const symmetricalButtons of [true, false]) {
        const banner = consentBanner({ consentMode } as TrackingConfig, { floor: "opt_out", honorGpc: false, symmetricalButtons, optOutHonoredNotice: false, privacyChoicesLink: false });
        // Exactly what Chrome's outerHTML gave back in the audit's run.
        const rewritten = banner.replace(' hidden><p>', ' hidden=""><p>');
        expect(rewritten).not.toBe(banner);
        const page = `<html><head></head><body><main id="main"><img src="/a.jpg" onerror="x()"></main>${rewritten}</body></html>`;
        const out = stripActiveContentInPage(page, [banner]);
        expect(out).toContain(rewritten);
        expect(consentBannerWorks(out)).toBe(true);
        expect(out).not.toContain("x()");
      }
    }
    const banner = consentBanner({ consentMode: "opt_in" } as TrackingConfig, { floor: "opt_out", honorGpc: false, symmetricalButtons: true, optOutHonoredNotice: false, privacyChoicesLink: false });
    const lookAlike = banner.replace(' hidden><p>', ' hidden=""><p>').replace("tawdConsent('denied')", "steal()");
    const out = stripActiveContentInPage(`<html><body>${lookAlike}</body></html>`, [banner]);
    expect(out).not.toContain("steal()");
    expect(consentBannerWorks(out)).toBe(false);
  });

  it("does not take a copy of TAWD's banner with a comment slipped inside for the banner itself", () => {
    const banner = consentBanner({ consentMode: "opt_in" } as TrackingConfig, { floor: "opt_out", honorGpc: false, symmetricalButtons: true, optOutHonoredNotice: false, privacyChoicesLink: false });
    const copy = banner.replace(/^(<[^>]*>)/, "$1<!-- x -->");
    expect(copy).not.toBe(banner);
    const out = stripActiveContentInPage(`<html><body>${copy}</body></html>`, [banner]);
    expect(out).not.toContain("onclick");
    // The real banner, comments and all, is still left alone.
    expect(stripActiveContentInPage(`<html><body>${banner}</body></html>`, [banner])).toContain(banner);
  });

  it("tells a working banner from one whose buttons were stripped", () => {
    const banner = consentBanner({ consentMode: "opt_in" } as TrackingConfig, { floor: "opt_out", honorGpc: false, symmetricalButtons: false, optOutHonoredNotice: false, privacyChoicesLink: false });
    expect(consentBannerWorks(`<body>${banner}</body>`)).toBe(true);
    expect(consentBannerWorks(`<body>${stripActiveContent(banner)}</body>`)).toBe(false);
    expect(consentBannerWorks("<body><p>No banner</p></body>")).toBe(false);
  });

  it("leaves a normal page exactly as it was", () => {
    const html =
      '<main id="main"><style>.a>b{color:red}</style><details open><summary>Menu</summary><a href="/contact/">Contact</a></details><a href="tel:+19162357878" class="btn">Call</a><a href="mailto:a@b.com">Email</a><img src="data:image/png;base64,AAA" alt="dot" /><p title="one > two">5 > 3</p></main>';
    expect(stripActiveContent(html)).toBe(html);
  });
});
