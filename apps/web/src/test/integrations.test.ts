import { describe, expect, it } from "vitest";

import { canEmbed, embedSrc, parseIntake } from "@tawd/core/intake";
import { checkIntegrationLinks, fillIntegrations, integrationsChecklistItem, integrationsPrompt, type SiteIntegration } from "@tawd/core/site";

/*
  The client's online tools (26 September 2026): booking, shop, portal and
  review links in the intake, placed by the builder, checked at build time.
  No live calls: the web is a stand-in.
*/

const booking: SiteIntegration = { id: "b", kind: "booking", provider: "Vagaro", url: "https://www.vagaro.com/glowmedspa", embed: false };
const calendly: SiteIntegration = { id: "c", kind: "booking", provider: "Calendly", url: "https://calendly.com/glow/consult", embed: true };
const portal: SiteIntegration = { id: "p", kind: "portal", provider: "Patient portal", url: "https://glow.janeapp.com/portal", embed: false };

describe("the intake's online tools", () => {
  it("keeps a link per tool and drops empty rows", () => {
    const intake = parseIntake({ extras: { integrations: [{ id: "a", kind: "shop", provider: "Shopify", url: "https://shop.glow.com" }, { id: "b", kind: "booking", provider: "", url: "" }] } });
    expect(intake.extras.integrations).toEqual([{ id: "a", kind: "shop", provider: "Shopify", url: "https://shop.glow.com", embed: false }]);
  });

  it("offers the calendar on the page only for booking pages made to be framed", () => {
    expect(canEmbed("booking", calendly.url)).toBe(true);
    expect(canEmbed("booking", booking.url)).toBe(false);
    expect(canEmbed("reviews", calendly.url)).toBe(false);
    expect(embedSrc("http://calendly.com/x")).toBeNull();
  });
});

describe("placing them", () => {
  it("tells the builder where each goes, with the exact address and never a review of its own", () => {
    const prompt = integrationsPrompt([booking, portal, { id: "r", kind: "reviews", provider: "Google", url: "https://g.page/r/glow", embed: false }]);
    expect(prompt).toContain('"Book online" button in the header');
    expect(prompt).toContain("https://www.vagaro.com/glowmedspa");
    expect(prompt).toContain('"Patient portal"');
    expect(prompt).toContain("Never write, quote or invent a review");
    expect(prompt).not.toContain("data-tawd-integration");
    expect(integrationsPrompt([])).toBe("");
  });

  it("asks for a calendar spot only when the calendar is wanted, and TAWD fills it in", () => {
    expect(integrationsPrompt([calendly])).toContain('<div data-tawd-integration="c"></div>');
    const main = fillIntegrations('<main><h2>Book a visit</h2><div data-tawd-integration="c"></div><div data-tawd-integration="gone"></div></main>', [calendly]);
    expect(main).toContain('<iframe src="https://calendly.com/glow/consult?embed_type=Inline&amp;hide_gdpr_banner=1" title="Book online with Calendly"');
    expect(main).toContain('href="https://calendly.com/glow/consult"');
    expect(main).not.toContain("data-tawd-integration");
  });
});

describe("checking them", () => {
  const web = (answers: Record<string, number | "down">) =>
    (async (url: string, init?: RequestInit) => {
      const answer = answers[`${init?.method} ${url}`] ?? answers[url];
      if (answer === "down" || answer === undefined) throw new TypeError("fetch failed");
      return new Response(null, { status: answer });
    }) as typeof fetch;

  it("counts a page that answers, even one that keeps checkers out, and not one that's gone or down", async () => {
    const results = await checkIntegrationLinks(
      ["https://a.example", "https://b.example", "https://c.example", "https://d.example", "https://a.example"],
      web({ "https://a.example": 200, "https://b.example": 403, "https://c.example": 404, "https://d.example": "down" }),
    );
    expect(results.map((r) => [r.url, r.ok])).toEqual([
      ["https://a.example", true],
      ["https://b.example", true],
      ["https://c.example", false],
      ["https://d.example", false],
    ]);
  });

  it("never opens a private address, first or after a redirect (13 October 2026)", async () => {
    const asked: string[] = [];
    const redirecting = (async (url: string) => {
      asked.push(url);
      if (url === "https://f.example/") return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } });
      if (url === "https://g.example/") return new Response(null, { status: 301, headers: { location: "/book" } });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const refuse = async (url: string) => /169\.254|localhost/.test(url);
    const results = await checkIntegrationLinks(["https://f.example/", "http://localhost/admin", "https://g.example/"], redirecting, 10_000, refuse);
    expect(results.map((r) => [r.url, r.ok])).toEqual([
      ["https://f.example/", false],
      ["http://localhost/admin", false],
      ["https://g.example/", true],
    ]);
    expect(asked).toEqual(["https://f.example/", "https://g.example/", "https://g.example/book"]);
  });

  it("tries a GET when a server refuses HEAD", async () => {
    const [result] = await checkIntegrationLinks(["https://e.example"], web({ "HEAD https://e.example": 405, "GET https://e.example": 200 }));
    expect(result!.ok).toBe(true);
  });

  it("lists what isn't on the site and what doesn't answer, and blocks go-live until fixed", () => {
    const pages = ['<a href="https://www.vagaro.com/glowmedspa">Book online</a>'];
    const item = integrationsChecklistItem([booking, portal], pages, [
      { url: booking.url, ok: true, detail: "Answers" },
      { url: portal.url, ok: false, detail: "Answers 404" },
    ])!;
    expect(item).toMatchObject({ key: "integrations", ok: false, blocksGoLive: true });
    expect(item.detail).toBe("Patient or client portal isn't on the site; Patient or client portal (Answers 404)");
    expect(integrationsChecklistItem([booking], pages, [{ url: booking.url, ok: true, detail: "Answers" }])).toMatchObject({ ok: true, detail: "1 link, each on the site and answering" });
    expect(integrationsChecklistItem([], pages, [])).toBeNull();
  });
});
