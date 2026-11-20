import { describe, expect, it } from "vitest";

/*
  The page plan's hub rule (Jason, 28 September 2026): 3 or more services
  in one of the trade playbook's families get a hub page that links to
  them (group, don't merge); only true duplicates with the same search
  intent become one page; hubs count toward the tier's page limit.
*/

import { buildDraftUserPrompt, groupServices, serviceIntent } from "@tawd/core/content";
import { draftPagePlan, planTierWarning } from "@/lib/seo-plan";

const noAreas = { scope: "cities" as const, cities: ["Reno"], states: [], radius: { miles: null, address: "" }, wantsIndividualCityPages: false };

describe("the trade playbooks", () => {
  it("groups an HVAC company's services into heating, air conditioning and air quality, and folds true duplicates", () => {
    const g = groupServices(["AC repair", "Air conditioning repair", "AC installation", "Furnace repair", "Heating installation", "Heat pumps", "Mini-split systems", "Duct cleaning", "Water heater repair"], "hvac");
    expect(g.duplicates).toEqual([{ kept: "AC repair", folded: ["Air conditioning repair"] }]);
    expect(g.hubs.map((h) => [h.family.hub, h.services])).toEqual([
      ["Heating", ["Furnace repair", "Heating installation", "Heat pumps"]],
      ["Air conditioning", ["AC repair", "AC installation", "Mini-split systems"]],
    ]);
    // A water heater is plumbing, not heating; one duct service is no family of 3.
    expect(g.kept).toContain("Water heater repair");
    expect(serviceIntent("A/C Installation Services", "hvac")).toBe(serviceIntent("air conditioning install", "hvac"));
    expect(serviceIntent("AC repair", "hvac")).not.toBe(serviceIntent("AC installation", "hvac"));
  });

  it("covers the other trades named: pest control, legal, med spa, roofing, electrical, plumbing", () => {
    expect(groupServices(["Ant control", "Roach control", "Spider control", "Termite inspection"], "pest_control").hubs.map((h) => h.family.hub)).toEqual(["Insects"]);
    expect(groupServices(["Car accidents", "Truck accidents", "Slip and fall", "Divorce", "Wills"], "legal").hubs.map((h) => h.family.hub)).toEqual(["Personal injury"]);
    expect(groupServices(["Botox", "Lip filler", "Dysport", "HydraFacial"], "med_spa").hubs.map((h) => h.family.hub)).toEqual(["Injectables"]);
    expect(groupServices(["Shingle roofs", "Metal roofs", "Tile roofs", "Gutters"], "roofing").hubs.map((h) => h.family.hub)).toEqual(["Roofing materials"]);
    expect(groupServices(["Panel upgrades", "Rewiring", "Breaker repair", "EV chargers"], "electrical").hubs.map((h) => h.family.hub)).toEqual(["Panels and wiring"]);
    expect(groupServices(["Drain cleaning", "Sewer line repair", "Hydro jetting"], "plumbing").hubs.map((h) => h.family.hub)).toEqual(["Drains and sewers"]);
    // A trade with no families in its playbook gets no hubs.
    expect(groupServices(["Portraits", "Weddings", "Pets"], "photography").hubs).toEqual([]);
    // "Roach control" and "Cockroach extermination" are the same search.
    expect(groupServices(["Roach control", "Cockroach extermination"], "pest_control").duplicates).toEqual([{ kept: "Roach control", folded: ["Cockroach extermination"] }]);
  });
});

describe("the page plan", () => {
  const input = {
    tier: "growth" as const,
    trade: "hvac" as const,
    businessName: "Reno Comfort Air",
    services: ["AC repair", "AC installation", "Air conditioning repair", "Furnace repair", "Heating installation", "Heat pumps", "Mini-split systems", "Duct cleaning"],
    areas: noAreas,
    businessState: "NV",
    keywords: [
      { keyword: "air conditioning reno", service: "AC repair", area: "Reno", searchVolume: 900, difficulty: 30 },
      { keyword: "ac repair reno", service: "AC repair", area: "Reno", searchVolume: 1300, difficulty: 25 },
    ],
  };

  it("puts a hub before its detailed pages, each detailed page keeps its own keyword, and duplicates fold in", () => {
    const pages = draftPagePlan(input);
    expect(pages.map((p) => [p.kind, p.name, p.parentSlug ?? null])).toEqual([
      ["home", "Home", null],
      ["hub", "Air conditioning", null],
      ["service", "AC repair", "air-conditioning"],
      ["service", "AC installation", "air-conditioning"],
      ["service", "Mini-split systems", "air-conditioning"],
      ["hub", "Heating", null],
      ["service", "Furnace repair", "heating"],
      ["service", "Heating installation", "heating"],
      ["service", "Heat pumps", "heating"],
      ["service", "Duct cleaning", null],
      ["service_areas", "Service areas", null],
      ["about", "About", null],
      ["faq", "FAQ", null],
      ["contact", "Contact", null],
    ]);
    const hub = pages.find((p) => p.name === "Air conditioning")!;
    expect(hub).toMatchObject({ slug: "air-conditioning", mainKeyword: "air conditioning reno", h1: "Air conditioning in Reno" });
    expect(pages.find((p) => p.name === "AC repair")!.mainKeyword).toBe("ac repair reno");
    // "Air conditioning repair" folded into AC repair as a supporting keyword, not a page of its own.
    expect(pages.some((p) => p.name === "Air conditioning repair")).toBe(false);
    expect(pages.find((p) => p.name === "AC repair")!.supportingKeywords).toContain("air conditioning repair reno");
    // Hubs count toward the tier's page limit.
    expect(pages.length).toBe(14);
    expect(planTierWarning(pages.length, "starter")).toContain("14 pages");
  });

  it("gives the writer the hub's pages, or the page's hub", () => {
    const base = {
      clientName: "Reno Comfort Air",
      tradeLabel: "hvac",
      otherPages: [],
      facts: { known: "", required: "", important: "", detail: "" },
      services: [],
      serviceArea: "Reno",
      tone: "",
      approvedConcept: null,
      suppliedCopy: null,
      designerNotes: "",
      redraftNote: null,
      previousDraft: null,
    };
    const hub = buildDraftUserPrompt({
      ...base,
      page: { name: "Air conditioning", kind: "hub", mainKeyword: "air conditioning reno", supportingKeywords: [], h1: "", title: "" },
      family: { role: "hub", pages: [{ name: "AC repair", slug: "ac-repair" }, { name: "AC installation", slug: "ac-installation" }] },
    });
    expect(hub).toContain("This is a hub page");
    expect(hub).toContain("AC repair: /ac-repair/; AC installation: /ac-installation/");
    const member = buildDraftUserPrompt({ ...base, page: { name: "AC repair", kind: "service", mainKeyword: "", supportingKeywords: [], h1: "", title: "" }, family: { role: "member", hub: { name: "Air conditioning", slug: "air-conditioning" } } });
    expect(member).toContain("belongs to the Air conditioning hub: link back to it once (/air-conditioning/)");
  });
});
