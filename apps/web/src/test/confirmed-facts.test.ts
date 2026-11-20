import { describe, expect, it } from "vitest";

import { FACT_CHECKS_BLOCK, confirmedFactsFrom, factIssues, factIssuesOnSite, runHtmlChecks } from "@tawd/core/mockups";
import { runChecklist } from "@tawd/core/site";
import { emptyIntake } from "@tawd/core/intake";

/*
  B1 (audit F-002): the fact checks on every page, against one list of the
  intake's confirmed facts. The cases are the audit's probe p8: before this,
  every one of them passed runHtmlChecks, and built pages were never
  checked at all.
*/

function intake() {
  const data = emptyIntake();
  data.business.name = "Synthetic Plumbing Co";
  data.business.phone = "(555) 555-0142";
  data.business.streetAddress = "400 Main Street";
  data.business.city = "Springfield";
  data.business.state = "CA";
  data.business.yearFounded = 1998 as never;
  data.business.licenseNumbers = ["C-36 998811"] as never;
  data.business.locations = [{ name: "North", phone: "(555) 555-0199", streetAddress: "9 Elm Road", city: "Ogdenville", state: "CA" }] as never;
  data.serviceAreas.cities = ["Springfield, CA", "North Haverbrook, CA"] as never;
  data.process.quotingAndPricing = "Drain clearing is $149, camera inspection $250.";
  data.content.suppliedCopy = "Owner Marge Simpson started the business. 27 years of experience between our team.";
  return data;
}

const facts = () => confirmedFactsFrom(intake());
const ids = (body: string, head = "") => factIssues(page(body, head), facts(), { year: 2026 }).map((i) => i.id);
const page = (body: string, head = "") =>
  `<!doctype html><html lang="en"><head><title>Plumber</title>${head}</head><body><header><a href="tel:+15555550142">Call (555) 555-0142</a></header><main><h1>Plumber in Springfield</h1><section>${body}</section></main></body></html>`;

describe("the confirmed facts, built once", () => {
  it("has every phone, the locations' too, and every address and town", () => {
    const f = facts();
    expect(f.phones).toHaveLength(2);
    expect(f.streetAddresses).toEqual(["400 Main Street", "9 Elm Road"]);
    expect(f.places).toEqual(expect.arrayContaining(["Springfield", "Ogdenville", "North Haverbrook, CA"]));
    expect(f.townsUnbounded).toBe(false);
  });

  it("does not check towns when the service area is not a list of towns", () => {
    const data = intake();
    data.serviceAreas.scope = "states" as never;
    expect(factIssues(page("<p>Proudly serving Shelbyville.</p>"), confirmedFactsFrom(data)).map((i) => i.id)).not.toContain("facts.town");
  });
});

describe("what a page may say (probe p8)", () => {
  it("passes a clean page", () => {
    expect(ids("<p>We fix pipes.</p>")).toEqual([]);
  });

  it("catches a call button that dials another number", () => {
    expect(ids('<p><a href="tel:+19998887777">Call now</a></p>')).toContain("facts.tel");
  });

  it("accepts a call button for a location's own number", () => {
    expect(ids('<p><a href="tel:+15555550199">Call North</a></p>')).toEqual([]);
  });

  it("catches a founding year that is not the intake's", () => {
    expect(ids("<p>Founded in 1975.</p>")).toContain("facts.year");
    expect(ids("<p>Serving Springfield since 1975.</p>")).toContain("facts.year");
    expect(ids("<p>Serving Springfield since 1998.</p>")).toEqual([]);
  });

  it("catches more years in business than the founding year allows, unless the client said it", () => {
    expect(ids("<p>Over 40 years of experience.</p>")).toContain("facts.years");
    expect(ids("<p>28 years in business.</p>")).toEqual([]);
    expect(ids("<p>27 years of experience.</p>")).toEqual([]);
  });

  it("catches ratings and review counts", () => {
    expect(ids("<p>4.9 stars from 312 Google reviews.</p>")).toContain("facts.rating");
    expect(ids("<p>312 five-star reviews.</p>")).toContain("facts.rating");
  });

  it("catches a price the client never gave, and accepts one they did", () => {
    expect(ids("<p>Drain clearing from $89.</p>")).toContain("facts.price");
    expect(ids("<p>Drain clearing is $149.</p>")).toEqual([]);
    expect(ids("<p>Camera inspection $250.00.</p>")).toEqual([]);
  });

  it("catches a town the business does not serve", () => {
    expect(factIssues(page("<p>Proudly serving Shelbyville and Capital City.</p>"), facts()).map((i) => i.evidence)).toEqual(["Shelbyville", "Capital City"]);
    expect(ids("<p>Visit us in Shelbyville, CA.</p>")).toContain("facts.town");
    expect(ids("<p>Serving Springfield, Ogdenville and North Haverbrook homeowners.</p>")).toEqual([]);
  });

  it("catches a person the client never named", () => {
    expect(ids("<p>Owner Dana Whitfield and her technicians.</p>")).toContain("facts.name");
    expect(ids("<p>Founded by Marge Simpson.</p>")).toEqual([]);
  });

  it("catches an address that is not the intake's", () => {
    expect(ids("<p>Visit us at 12 Oak Street.</p>")).toContain("facts.address");
    expect(ids("<p>Visit us at 400 Main Street.</p>")).toEqual([]);
  });

  it("reads the structured data too", () => {
    expect(ids("<p>We fix pipes.</p>", '<script type="application/ld+json">{"@type":"Plumber","aggregateRating":{"ratingValue":"4.9","reviewCount":"312"}}</script>')).toContain("facts.rating");
    expect(ids("<p>We fix pipes.</p>", '<script type="application/ld+json">{"@type":"Plumber","telephone":"+1-999-888-7777"}</script>')).toContain("facts.tel");
    expect(ids("<p>We fix pipes.</p>", '<script type="application/ld+json">{"@type":"Plumber","telephone":"+1-555-555-0142"}</script>')).toEqual([]);
  });

  it("leaves a visible placeholder alone: it declares the fact missing", () => {
    expect(ids("<p>[PLACEHOLDER: 4.9 stars from Google, to confirm with the client]</p>")).toEqual([]);
  });

  // The decision itself, pinned (review L3): the tests below follow the switch, so without this one a flip to "report only" would pass unnoticed.
  it("blocks: Jason's decision of 12 November 2026, after the false-alarm count", () => {
    expect(FACT_CHECKS_BLOCK).toBe(true);
  });

  it("fails when the switch is on (Jason, 12 Nov: block on all of them), and only reports when it is off", () => {
    expect(factIssues(page("<p>Drain clearing from $89.</p>"), facts()).every((i) => i.severity === (FACT_CHECKS_BLOCK ? "fail" : "warn"))).toBe(true);
  });
});

describe("on the mockup and on the built site", () => {
  it("runs inside the mockup checks when the confirmed facts are given", () => {
    const f = facts();
    const outcome = runHtmlChecks(page('<p><a href="tel:+19998887777">Call now</a></p>'), { phones: f.phones, licenseNumbers: f.licenseNumbers, yearFounded: f.yearFounded, businessName: f.businessName, cities: [], confirmed: f });
    expect(outcome.issues.map((i) => i.id)).toContain("facts.tel");
  });

  it("checks every page of the built site, the 404 page included, with the older checks too", () => {
    const hits = factIssuesOnSite(
      [
        ["index.html", page("<p>We fix pipes.</p>")],
        ["404.html", page("<p>Lost? Call (999) 888-7777.</p>")],
        ["about/index.html", page("<p>CSLB Lic #1045873. Over 40 years of experience.</p>")],
      ],
      facts(),
      { year: 2026 },
    );
    expect(hits.map((h) => `${h.file} ${h.id}`)).toEqual(["404.html house.phone.invented", "about/index.html house.license.invented", "about/index.html facts.years"]);
  });

  it("shows on the go-live checklist, blocking when the switch is on", () => {
    const files = new Map([
      ["index.html", page('<p>Drain clearing from $89.</p><a href="#main">skip</a>')],
      ["404.html", page("<p>Lost?</p>")],
    ]);
    const item = runChecklist({ files, pagePaths: ["/"], domain: null, mobileOverflow: [], gbpUrl: "", facts: facts() }).find((c) => c.key === "facts")!;
    expect(item.ok).toBe(false);
    expect(item.blocksGoLive).toBe(FACT_CHECKS_BLOCK);
    expect(item.detail).toContain("index.html: $89");
    if (FACT_CHECKS_BLOCK) expect(item.label).toBe("Facts match the intake");
    else expect(item.label).toContain("report only");
  });
});
