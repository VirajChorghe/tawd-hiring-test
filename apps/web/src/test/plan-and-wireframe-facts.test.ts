import { describe, expect, it } from "vitest";

import { draftWireframeSections, listIntakeFacts } from "@tawd/core/mockups";
import { emptyIntake, parseIntake } from "@tawd/core/intake";
import { draftPagePlan, dominantSiteCity } from "@/lib/seo-plan";
import { pageFactsOf } from "@/lib/seo-data";

/*
  The official run (Sample Plumbing Co., 8 October 2026): the plan
  made Home "Drain cleaning in California", the wireframe always added
  Reviews, Why choose us and an FAQ, and the plan always an About and FAQ page.
*/

const statewide = {
  tier: "growth" as const,
  trade: "plumbing" as const,
  businessName: "Sample Plumbing Co.",
  services: ["Drain cleaning", "Water heater repair and installation", "Sewer line repair"],
  areas: { ...emptyIntake().serviceAreas, scope: "states", states: ["CA"], wantsIndividualCityPages: false } as never,
  businessState: "CA",
  keywords: [],
};

describe("the page plan", () => {
  it("aims Home at the trade and the base city, never one service or the whole state", () => {
    const pages = draftPagePlan({ ...statewide, businessCity: "Sacramento" });
    const home = pages.find((p) => p.kind === "home")!;
    expect(home.h1).toBe("Plumber in Sacramento");
    expect(home.title).toBe("Plumber in Sacramento | Sample Plumbing Co.");
    expect(home.metaDescription).toContain("drain cleaning, water heater repair and installation, sewer line repair in Sacramento");
    // Service pages too: by the city people search in.
    expect(pages.find((p) => p.name === "Drain cleaning")!.h1).toBe("Drain cleaning in Sacramento");
  });

  it("keeps the state where there's no base city", () => {
    expect(draftPagePlan(statewide).find((p) => p.kind === "home")!.h1).toBe("Plumber in California");
  });

  // #4 (7 November 2026): a makeover's primary city follows the current site's SEO focus, not the intake
  // address. A client's site is "Patio Covers in Sacramento" but its shop is in Fair Oaks.
  describe("a makeover's primary city follows the current site's SEO focus (#4)", () => {
    const clearSky = {
      tier: "growth" as const,
      trade: "home_services" as never,
      businessName: "Clear Sky Awning",
      services: ["Patio covers", "Lattice", "Roof mount"],
      areas: { ...emptyIntake().serviceAreas, scope: "cities", cities: ["Fair Oaks", "Sacramento", "Folsom"], wantsIndividualCityPages: false } as never,
      businessState: "CA",
      businessCity: "Fair Oaks",
      keywords: [],
    };

    it("dominantSiteCity picks the served city most prominent in the home H1/title/meta, and never a new one", () => {
      const home = { h1s: ["Patio Covers in Sacramento"], title: "Patio Covers In Sacramento | Aluminum Patio Covers | Clear Sky Awning", metaDescription: "Serving Fair Oaks and beyond." };
      const candidates = ["Fair Oaks", "Sacramento", "Folsom"];
      // Sacramento is in the H1 (weight 3) + title (2); Fair Oaks only in meta (1) → Sacramento wins.
      expect(dominantSiteCity(home, candidates)).toBe("Sacramento");
      // A city not among the served candidates is never returned, even if it's all over the home.
      expect(dominantSiteCity({ h1s: ["Roofing in Elk Grove"], title: "Elk Grove", metaDescription: "Elk Grove" }, candidates)).toBeNull();
      // No served city on the home → null (the intake order is kept as the fallback).
      expect(dominantSiteCity({ h1s: ["Patio Covers"], title: "Patio Covers", metaDescription: "" }, candidates)).toBeNull();
      expect(dominantSiteCity(null, candidates)).toBeNull();
    });

    // CodeRabbit on PR #48 (round 2): "West Sacramento" in the H1 also scores "Sacramento"
    // (its words contain it) — the tie must go to the specific city the site actually names.
    it("prefers the specific city when one candidate's name contains another's", () => {
      const home = { h1s: ["Plumber in West Sacramento"], title: "Plumber in West Sacramento", metaDescription: "" };
      expect(dominantSiteCity(home, ["Sacramento", "West Sacramento"])).toBe("West Sacramento");
      // Order-independent: the specific city wins from either side.
      expect(dominantSiteCity(home, ["West Sacramento", "Sacramento"])).toBe("West Sacramento");
      // And the plain city still wins when it is what the site says.
      expect(dominantSiteCity({ h1s: ["Plumber in Sacramento"], title: "Plumber in Sacramento", metaDescription: "" }, ["Sacramento", "West Sacramento"])).toBe("Sacramento");
      // An unrelated tie keeps the intake order (first candidate), as before.
      expect(dominantSiteCity({ h1s: ["Serving Folsom and Roseville"], title: "Folsom and Roseville", metaDescription: "" }, ["Folsom", "Roseville"])).toBe("Folsom");
    });

    it("sets Home to the site's focus city (Sacramento), overriding the business's own city (Fair Oaks)", () => {
      const withSite = draftPagePlan({ ...clearSky, siteHome: { h1s: ["Patio Covers in Sacramento"], title: "Patio Covers In Sacramento | Clear Sky Awning", metaDescription: "" } });
      const home = withSite.find((p) => p.kind === "home")!;
      expect(home.h1).toContain("Sacramento");
      expect(home.h1).not.toContain("Fair Oaks");
      // Without a current site, the business's own city (Fair Oaks) leads.
      const noSite = draftPagePlan(clearSky).find((p) => p.kind === "home")!;
      expect(noSite.h1).toContain("Fair Oaks");
      expect(noSite.h1).not.toContain("Sacramento");
    });

    // CodeRabbit on PR #48: only city areas may be focus candidates, so a wider place name
    // on the home page can't displace the base city.
    it("a state name on the home page never overrides the base city on a statewide plan", () => {
      const home = draftPagePlan({
        ...statewide,
        businessCity: "Sacramento",
        siteHome: { h1s: ["Plumber in California"], title: "Plumber in California", metaDescription: "Serving all of California." },
      }).find((p) => p.kind === "home")!;
      // The state is not a city candidate, so the base city stands.
      expect(home.h1).toBe("Plumber in Sacramento");
    });
  });

  // Audit F-025 (13 November 2026): the business's own city leads, not the first area typed.
  describe("the business's own city leads the titles (audit F-025)", () => {
    const fairOaks = {
      tier: "growth" as const,
      trade: "plumbing" as const,
      businessName: "Fair Oaks Plumbing",
      services: ["Drain cleaning", "Sewer line repair"],
      areas: { ...emptyIntake().serviceAreas, scope: "cities", cities: ["Lincoln", "Fair Oaks"], wantsIndividualCityPages: false } as never,
      businessState: "CA",
      businessCity: "Fair Oaks",
      keywords: [],
    };
    const homeOf = (over: Record<string, unknown>) => draftPagePlan({ ...fairOaks, ...over }).find((p) => p.kind === "home")!;

    it("uses Fair Oaks for the title, H1 and keyword when Lincoln is listed first", () => {
      const home = homeOf({});
      expect(home.h1).toBe("Plumber in Fair Oaks");
      expect(home.title).toBe("Plumber in Fair Oaks | Fair Oaks Plumbing");
      expect(home.mainKeyword).toContain("fair oaks");
      expect(home.mainKeyword).not.toContain("lincoln");
    });

    it("still uses Fair Oaks when the only area listed is Lincoln", () => {
      const areas = { ...emptyIntake().serviceAreas, scope: "cities", cities: ["Lincoln"], wantsIndividualCityPages: false } as never;
      expect(homeOf({ areas }).h1).toBe("Plumber in Fair Oaks");
    });

    // Fable's review: after keyword research, a measured keyword for another city must not lead a page titled for Fair Oaks.
    const measured = (keyword: string, area: string, searchVolume: number, service: string | null = null) => ({ keyword, service, area, searchVolume, difficulty: 10 });

    it("keeps the keyword on Fair Oaks when only Lincoln was measured", () => {
      const areas = { ...emptyIntake().serviceAreas, scope: "cities", cities: ["Lincoln"], wantsIndividualCityPages: false } as never;
      const plan = draftPagePlan({ ...fairOaks, areas, keywords: [measured("plumber lincoln", "Lincoln", 500), measured("drain cleaning lincoln", "Lincoln", 300, "Drain cleaning")] });
      expect(plan.find((p) => p.kind === "home")!.mainKeyword).toBe("plumber fair oaks");
      expect(plan.find((p) => p.name === "Drain cleaning")!.mainKeyword).toBe("drain cleaning fair oaks");
    });

    it("prefers Fair Oaks's own measured keyword over a busier Lincoln one", () => {
      const home = homeOf({ keywords: [measured("plumber lincoln", "Lincoln", 900), measured("plumber fair oaks", "Fair Oaks", 200)] });
      expect(home.mainKeyword).toBe("plumber fair oaks");
      expect(home.supportingKeywords).not.toContain("plumber lincoln");
    });

    it("still uses a keyword with no place in it (a state's plain words)", () => {
      const areas = { ...emptyIntake().serviceAreas, scope: "states", states: ["California"], wantsIndividualCityPages: false } as never;
      expect(homeOf({ areas, keywords: [measured("plumber", "California", 900)] }).mainKeyword).toBe("plumber");
    });

    it("on a counties plan keeps a county's measured 'near me' keyword, but never one naming the county", () => {
      const areas = { ...emptyIntake().serviceAreas, scope: "counties", counties: ["Placer, CA"], wantsIndividualCityPages: false } as never;
      const home = homeOf({ areas, keywords: [measured("plumber placer county", "Placer County", 900), measured("plumber near me", "Placer County", 400)] });
      expect(home.mainKeyword).toBe("plumber near me");
      expect(home.supportingKeywords).not.toContain("plumber placer county");
    });

    it("matches the main city whatever its letter case in the areas, and a place named inside it is not another city", () => {
      const areas = { ...emptyIntake().serviceAreas, scope: "cities", cities: ["fair oaks", "Oaks"], wantsIndividualCityPages: false } as never;
      expect(homeOf({ areas, keywords: [measured("plumber fair oaks", "fair oaks", 300), measured("plumber oaks", "Oaks", 900), measured("plumber near me", "fair oaks", 100)] }).mainKeyword).toBe("plumber fair oaks");
    });

    it("does not take a city whose name contains the main city's ('West Sacramento' beside 'Sacramento') for the main city", () => {
      const areas = { ...emptyIntake().serviceAreas, scope: "cities", cities: ["Sacramento", "West Sacramento"], wantsIndividualCityPages: false } as never;
      const home = homeOf({ businessCity: "Sacramento", areas, keywords: [measured("plumber west sacramento", "West Sacramento", 900), measured("plumber sacramento", "Sacramento", 300)] });
      expect(home.h1).toBe("Plumber in Sacramento");
      expect(home.mainKeyword).toBe("plumber sacramento");
      expect(home.supportingKeywords).not.toContain("plumber west sacramento");
    });

    it("takes the longest name where two start with the same word ('Orange Park' beside 'Orange')", () => {
      const areas = { ...emptyIntake().serviceAreas, scope: "cities", cities: ["Orange", "Orange Park"], wantsIndividualCityPages: false } as never;
      const home = homeOf({ businessCity: "Orange", areas, keywords: [measured("plumber orange park", "Orange Park", 900), measured("plumber orange", "Orange", 300)] });
      expect(home.mainKeyword).toBe("plumber orange");
    });

    // Jason, 13 November 2026: the business's own city leads whatever the scope.
    it("names Fair Oaks for a counties plan, while each county keeps its own page", () => {
      const areas = { ...emptyIntake().serviceAreas, scope: "counties", counties: ["Placer, CA"], wantsIndividualCityPages: true } as never;
      const plan = draftPagePlan({ ...fairOaks, areas });
      expect(plan.find((p) => p.kind === "home")!.h1).toBe("Plumber in Fair Oaks");
      expect(plan.filter((p) => p.kind === "city").map((p) => p.name)).toEqual(["Placer County"]);
    });

    it("names Fair Oaks for a TV-area plan", () => {
      const areas = { ...emptyIntake().serviceAreas, scope: "dmas", dmas: [{ id: "200862", name: "Sacramento-Stockton-Modesto CA", canonical: "Sacramento-Stockton-Modesto CA,California,United States" }], wantsIndividualCityPages: false } as never;
      expect(homeOf({ areas }).h1).toBe("Plumber in Fair Oaks");
    });

    it("falls back to the first area when there is no business city", () => {
      expect(homeOf({ businessCity: null }).h1).toBe("Plumber in Lincoln");
      expect(homeOf({ businessCity: undefined }).h1).toBe("Plumber in Lincoln");
    });

    it("takes only the city part of \"Fair Oaks, CA\"", () => {
      expect(homeOf({ businessCity: "Fair Oaks, CA" }).h1).toBe("Plumber in Fair Oaks");
    });

    it("ignores a blank or placeholder business city", () => {
      expect(homeOf({ businessCity: "   " }).h1).toBe("Plumber in Lincoln");
      expect(homeOf({ businessCity: ", CA" }).h1).toBe("Plumber in Lincoln");
      expect(homeOf({ businessCity: "[PLACEHOLDER: city]" }).h1).toBe("Plumber in Lincoln");
    });

    it("a makeover's focus city still beats the business city", () => {
      const siteHome = { h1s: ["Plumber in Lincoln"], title: "Plumber in Lincoln", metaDescription: "" };
      expect(homeOf({ siteHome }).h1).toBe("Plumber in Lincoln");
    });

    it("service pages use the same city", () => {
      const page = draftPagePlan(fairOaks).find((p) => p.name === "Drain cleaning")!;
      expect(page.h1).toBe("Drain cleaning in Fair Oaks");
    });
  });

  it("plans an About and an FAQ page only when the intake has something true for them", () => {
    const kinds = (pageFacts: { about: boolean; faq: boolean }) => draftPagePlan({ ...statewide, businessCity: "Sacramento", pageFacts }).map((p) => p.kind);
    expect(kinds({ about: false, faq: false })).not.toEqual(expect.arrayContaining(["about"]));
    expect(kinds({ about: false, faq: false })).not.toContain("faq");
    expect(kinds({ about: true, faq: true })).toEqual(expect.arrayContaining(["about", "faq"]));
  });

  it("reads those facts from the intake", () => {
    const bare = parseIntake({ business: { name: "Sample Plumbing Co.", phone: "(916) 235-7878" } });
    expect(pageFactsOf(bare)).toEqual({ about: false, faq: false });
    const full = parseIntake({ business: { name: "S", yearFounded: 2024, emergency247: true }, serviceAreas: { cities: ["Sacramento"] } });
    expect(pageFactsOf(full)).toEqual({ about: true, faq: true });
  });
});

describe("the wireframe's own sections", () => {
  it("never adds Reviews, adds Why choose us and an FAQ only with facts, and never a main-service placeholder", () => {
    const bare = draftWireframeSections(listIntakeFacts(parseIntake({ business: { name: "Bare Co", phone: "916-555-0100" }, services: { items: [{ id: "s1", name: "Drain cleaning", description: "" }] } }), []));
    const kinds = bare.map((s) => s.kind);
    expect(kinds).not.toContain("reviews");
    expect(kinds).not.toContain("why");
    expect(kinds).not.toContain("faq");
    expect(bare.find((s) => s.kind === "hero")!.lines[0]).toBe("Drain cleaning");
    expect(JSON.stringify(bare)).not.toContain("main service");

    const rich = draftWireframeSections(
      listIntakeFacts(
        parseIntake({ business: { name: "Rich Co", phone: "916-555-0100", yearFounded: 2001, emergency247: true, licenseNumbers: ["C36-123"] }, serviceAreas: { cities: ["Sacramento"] } }),
        [],
        { trade: "plumbing" },
      ),
    );
    expect(rich.map((s) => s.kind)).toEqual(expect.arrayContaining(["why", "faq"]));
    expect(rich.map((s) => s.kind)).not.toContain("reviews");
  });
});
