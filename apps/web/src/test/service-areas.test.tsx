import { describe, expect, it } from "vitest";

import {
  areaServed,
  assessCompleteness,
  checkTier,
  describeServiceArea,
  emptyIntake,
  parseIntake,
  serviceAreaGuidance,
  serviceAreasSchema,
} from "@tawd/core/intake";
import { buildConceptUserPrompt, describeFactsForPrompt, listIntakeFacts } from "@tawd/core/mockups";

/*
  Service areas (the founders' request, 25 September 2026): specific
  cities or towns, whole states, nationwide, or a radius around an address.
  Carried into the mockup prompts ("Serving all of Nevada"), the SEO data
  (areaServed) and the tier check (only city pages count toward Growth).
*/

const areas = (input: Record<string, unknown>) => serviceAreasSchema.parse(input);

describe("the four kinds of service area", () => {
  it("says each in words, and in schema.org's areaServed", () => {
    const cities = areas({ cities: ["Reno", "Sparks", "Carson City"] });
    expect(describeServiceArea(cities)).toBe("Reno, Sparks and Carson City");
    expect(areaServed(cities)).toEqual([
      { "@type": "City", name: "Reno" },
      { "@type": "City", name: "Sparks" },
      { "@type": "City", name: "Carson City" },
    ]);

    const states = areas({ scope: "states", states: ["NV", "CA"] });
    expect(describeServiceArea(states)).toBe("All of Nevada and California");
    expect(serviceAreaGuidance(states)).toContain('say "Serving all of Nevada and California"');
    expect(areaServed(states)).toEqual([
      { "@type": "State", name: "Nevada" },
      { "@type": "State", name: "California" },
    ]);

    const nationwide = areas({ scope: "nationwide" });
    expect(describeServiceArea(nationwide)).toBe("Nationwide across the USA");
    expect(areaServed(nationwide)).toEqual([{ "@type": "Country", name: "United States" }]);

    const radius = areas({ scope: "radius", radius: { miles: "50", address: "4105 Kietzke Ln, Reno, NV" } });
    expect(describeServiceArea(radius)).toBe("Within 50 miles of 4105 Kietzke Ln, Reno, NV");
    expect(areaServed(radius)).toEqual([
      { "@type": "GeoCircle", geoMidpoint: { "@type": "Place", address: "4105 Kietzke Ln, Reno, NV" }, geoRadius: 80467 },
    ]);
  });

  it("keeps an intake from before the choice as a list of cities, and refuses a state that isn't one", () => {
    const old = parseIntake({ serviceAreas: { cities: ["Grass Valley"], wantsIndividualCityPages: true } });
    expect(old.serviceAreas).toMatchObject({ scope: null, cities: ["Grass Valley"], states: [], radius: { miles: null, address: "" } });
    expect(describeServiceArea(old.serviceAreas)).toBe("Grass Valley");
    expect(serviceAreasSchema.safeParse({ scope: "states", states: ["XX"] }).success).toBe(false);
  });

  it("counts as answered only when the chosen kind is filled in", () => {
    const missing = (serviceAreas: Record<string, unknown>) => {
      const intake = emptyIntake();
      intake.serviceAreas = areas(serviceAreas);
      return assessCompleteness({ projectTrade: null, intake, files: [] }).missing.some((m) => m.key === "serviceAreas.atLeastOne");
    };
    expect(missing({ scope: "states" })).toBe(true);
    expect(missing({ scope: "states", states: ["NV"] })).toBe(false);
    expect(missing({ scope: "nationwide" })).toBe(false);
    expect(missing({ scope: "radius", radius: { miles: 50, address: "" } })).toBe(true);
    expect(missing({ scope: "radius", radius: { miles: 50, address: "Reno, NV" } })).toBe(false);
    // Cities typed earlier don't count once another kind is chosen.
    expect(missing({ scope: "radius", cities: ["Reno"] })).toBe(true);
  });

  it("counts only individual city pages toward Growth", () => {
    const intake = emptyIntake();
    intake.serviceAreas = areas({ cities: ["Reno", "Sparks"], wantsIndividualCityPages: true });
    expect(checkTier("starter", intake)?.reasons).toEqual(["a separate page for each of 2 cities was asked for"]);
    intake.serviceAreas = areas({ scope: "states", states: ["NV"], cities: ["Reno", "Sparks"], wantsIndividualCityPages: true });
    expect(checkTier("starter", intake)).toBeNull();
  });
});

describe("in the mockup prompts", () => {
  it("tells the builder to say the whole state, and not to list towns", () => {
    const intake = emptyIntake();
    intake.serviceAreas = areas({ scope: "states", states: ["NV"] });
    const facts = listIntakeFacts(intake, []);
    const known = describeFactsForPrompt(facts).known;
    expect(known).toContain('All of Nevada (the whole state: say "Serving all of Nevada", and don\'t list towns the client didn\'t name)');
    const prompt = buildConceptUserPrompt({
      brief: { skillId: "impeccable", direction: "modern_clean", conceptLabel: "A" },
      project: { clientName: "Example Well & Pump", trade: "well_and_pump", tier: "starter" },
      intake,
      assets: [],
      facts,
    });
    expect(prompt).toContain('say "Serving all of Nevada"');
    expect(prompt).toContain('"scope": "states"');
  });

  it("says nationwide without states or towns, and a radius from the address", () => {
    const facts = (serviceAreas: Record<string, unknown>) => {
      const intake = emptyIntake();
      intake.serviceAreas = areas(serviceAreas);
      return describeFactsForPrompt(listIntakeFacts(intake, [])).known;
    };
    expect(facts({ scope: "nationwide" })).toContain("Nationwide across the USA (say \"Serving customers nationwide\"");
    expect(facts({ scope: "radius", radius: { miles: 25, address: "Bishop, CA" } })).toContain("Within 25 miles of Bishop, CA");
  });
});
