import { describe, expect, it } from "vitest";

/*
  Counties and DMAs as service areas (Todd's request, 26 September 2026):
  carried into the mockup prompts, the SEO keyword lookups (DataForSEO
  locations), schema.org areaServed, and the tier (county pages count like
  city pages). The markets here stand in for DataForSEO's list.
*/

import { areaServed, checkTier, describeServiceArea, emptyIntake, hasServiceArea, parseIntake, serviceAreaGuidance } from "@tawd/core/intake";
import { areaServedFrom } from "@tawd/core/site";
import { countyArea, draftPagePlan, keywordAreas, keywordPlan } from "@/lib/seo-plan";

const counties = { scope: "counties" as const, cities: [], counties: ["Washoe County, NV", "Placer, CA"], states: [], dmas: [], radius: { miles: null, address: "" }, wantsIndividualCityPages: null };
const dmas = { ...counties, scope: "dmas" as const, counties: [], dmas: [
    { id: "200811", name: "Reno NV", canonical: "Reno NV,Nevada,United States" },
    { id: "200862", name: "Sacramento-Stockton-Modesto CA", canonical: "Sacramento-Stockton-Modesto CA,California,United States" },
  ] };

describe("counties", () => {
  it("are kept by the intake, described for the site and the builder, and served as administrative areas", () => {
    const intake = parseIntake({ serviceAreas: { scope: "counties", counties: ["Washoe County, NV", ""] } });
    expect(intake.serviceAreas.counties).toEqual(["Washoe County, NV"]);
    expect(hasServiceArea(counties)).toBe(true);
    expect(describeServiceArea(counties)).toBe("Washoe County, NV and Placer, CA");
    expect(serviceAreaGuidance(counties)).toMatch(/name these counties/);
    expect(areaServed(counties)).toEqual([
      { "@type": "AdministrativeArea", name: "Washoe County, NV" },
      { "@type": "AdministrativeArea", name: "Placer, CA" },
    ]);
    expect(areaServedFrom(counties)[0]).toEqual({ type: "AdministrativeArea", name: "Washoe County, NV" });
  });

  it("are looked up where DataForSEO names them, with the county in the words", () => {
    expect(countyArea("Washoe County, NV", null)).toEqual({ name: "Washoe County", place: "Washoe County,Nevada,United States" });
    expect(countyArea("Placer, CA", null)).toEqual({ name: "Placer County", place: "Placer County,California,United States" });
    expect(countyArea("Orleans Parish, LA", null).name).toBe("Orleans Parish");
    expect(countyArea("Washoe", null).place).toBe("United States");
    const groups = keywordPlan({ trade: "plumbing", services: ["Drain cleaning"], areas: counties, businessState: "NV" });
    const washoe = groups.find((g) => g.place === "Washoe County,Nevada,United States")!;
    expect(washoe.keywords.map((k) => k.keyword)).toEqual(expect.arrayContaining(["drain cleaning washoe county", "drain cleaning near me"]));
  });

  it("count toward the tier like city pages, and get a page each on Growth", () => {
    const wants = { ...counties, wantsIndividualCityPages: true };
    const intake = { ...emptyIntake(), serviceAreas: wants };
    expect(checkTier("starter", intake)?.reasons).toEqual(["a separate page for each of 2 counties was asked for"]);
    const pages = draftPagePlan({ tier: "growth", trade: "plumbing", businessName: "Sac Drain", services: ["Drain cleaning"], areas: wants, businessState: "NV", keywords: [] });
    expect(pages.filter((p) => p.kind === "city").map((p) => p.name)).toEqual(["Washoe County", "Placer County"]);
  });
});

describe("DMAs", () => {
  it("are described as areas, served as administrative areas, and looked up as the market Google knows", () => {
    expect(describeServiceArea(dmas)).toBe("The Reno NV and Sacramento-Stockton-Modesto CA areas");
    expect(serviceAreaGuidance(dmas)).toMatch(/TV and ad market/);
    expect(areaServed(dmas)[0]).toEqual({ "@type": "AdministrativeArea", name: "Reno NV area" });
    expect(keywordAreas({ trade: "plumbing", services: [], areas: dmas, businessState: null })).toEqual([
      { kind: "dma", name: "Reno NV area", place: "Reno NV,Nevada,United States" },
      { kind: "dma", name: "Sacramento-Stockton-Modesto CA area", place: "Sacramento-Stockton-Modesto CA,California,United States" },
    ]);
    // The market's name never goes into the search words.
    const words = keywordPlan({ trade: "plumbing", services: ["Drain cleaning"], areas: dmas, businessState: null }).flatMap((g) => g.keywords.map((k) => k.keyword));
    expect(words.every((w) => !/reno|sacramento/.test(w))).toBe(true);
  });

  it("never count toward the tier and never get a page each", () => {
    expect(checkTier("starter", { ...emptyIntake(), serviceAreas: { ...dmas, wantsIndividualCityPages: true } })).toBeNull();
  });
});
