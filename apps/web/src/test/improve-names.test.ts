import { describe, expect, it } from "vitest";

import { factsCheckLine, improveFactsCheck, namesOnPage } from "@tawd/core/content";

import { namesThatMustSurvive } from "@/lib/content-improve";

/*
  Names must survive the improvement (9 November 2026).

  The writer's rule names them first — "Keep every fact exactly as the
  current page states it: names, phone numbers, addresses, ... service
  areas" — but the check beside it only ever read numbers. So a client's
  improved Home page shortened "Carson City" to "Carson", one of the two
  service areas, and nothing in code noticed. Jason caught it by eye.
*/

const current = `# Plumbing in Sparks and Carson City

Swift Rooter Plumbing has served Sparks and Carson City since 1979. Call (775) 555-0119.

## Trenchless Sewer Repair

We repair sewer lines across Carson City without digging up the driveway.`;

const names = ["Swift Rooter Plumbing", "Carson City", "Trenchless Sewer Repair"];

describe("a name the improved words dropped", () => {
  it("catches a service area shortened to something else", () => {
    const improved = current.replace(/Carson City/g, "Carson");
    const check = improveFactsCheck(current, improved, "", names);
    expect(check.changedNames).toEqual(["Carson City"]);
    expect(factsCheckLine(check)).toContain("Carson City");
    expect(factsCheckLine(check)).toContain("Put it back exactly");
  });

  it("catches the business name being reworded", () => {
    const improved = current.replace(/Swift Rooter Plumbing/g, "Swift Rooter");
    expect(improveFactsCheck(current, improved, "", names).changedNames).toEqual(["Swift Rooter Plumbing"]);
  });

  it("says nothing when every name survives, however the words move around", () => {
    const improved = `# Plumbing in Sparks and Carson City\n\nSince 1979, Swift Rooter Plumbing has worked in Sparks and Carson City. Call (775) 555-0119.\n\n## Trenchless Sewer Repair\n\nSewer lines repaired across Carson City, no digging.`;
    const check = improveFactsCheck(current, improved, "", names);
    expect(check.changedNames).toEqual([]);
    expect(factsCheckLine(check)).toBeNull();
  });

  it("never asks for a name the current page didn't use", () => {
    const improved = current;
    expect(improveFactsCheck(current, improved, "", [...names, "Reno Nevada"]).changedNames).toEqual([]);
  });

  it("still reports a changed number, as it always did", () => {
    const improved = current.replace("1979", "1985");
    const check = improveFactsCheck(current, improved, "", names);
    expect(check.removed).toContain("1979");
    expect(check.added).toContain("1985");
  });

  it("reports a lost name and a lost number together in one line", () => {
    const improved = current.replace(/Carson City/g, "Carson").replace("(775) 555-0119", "(775) 555-0100");
    const line = factsCheckLine(improveFactsCheck(current, improved, "", names))!;
    expect(line).toContain("Carson City");
    expect(line).toContain("(775) 555-0119");
  });
});

describe("finding a name on a page", () => {
  it("reads past punctuation, case and line breaks", () => {
    expect([...namesOnPage("We work in CARSON\nCITY, Nevada.", ["Carson City"])]).toEqual(["Carson City"]);
  });

  it("does not match a name inside a longer word", () => {
    expect([...namesOnPage("Carsonville plumbing", ["Carson City"])]).toEqual([]);
  });
});

describe("the names taken from the intake", () => {
  const data = {
    business: { name: "Swift Rooter Plumbing", city: "Sparks" },
    serviceAreas: { cities: ["Sparks, NV", "Carson City, NV"], counties: ["Washoe County, NV"] },
    services: { items: [{ name: "Trenchless Sewer Repair" }, { name: "Drains" }] },
  } as never;

  it("drops the state code a city is written with", () => {
    expect(namesThatMustSurvive(data)).toContain("Carson City");
    expect(namesThatMustSurvive(data)).not.toContain("Carson City, NV");
  });

  it("keeps the business name, the counties and the multi-word services", () => {
    const names = namesThatMustSurvive(data);
    expect(names).toContain("Swift Rooter Plumbing");
    expect(names).toContain("Washoe County");
    expect(names).toContain("Trenchless Sewer Repair");
  });

  it("leaves one-word names out, which turn up inside other words too often", () => {
    const names = namesThatMustSurvive(data);
    expect(names).not.toContain("Sparks");
    expect(names).not.toContain("Drains");
  });

  it("has nothing to say without an intake", () => {
    expect(namesThatMustSurvive(undefined)).toEqual([]);
  });
});

/* Hand review, 9 Nov: the ways this check could have nagged about a name that was never lost. */
describe("names that only look different", () => {
  it("drops a trailing state written in full, not only its code", () => {
    const data = {
      business: { name: "Swift Rooter Plumbing", city: "Sparks" },
      serviceAreas: { cities: ["Carson City, Nevada"], counties: [] },
      services: { items: [] },
    } as never;
    expect(namesThatMustSurvive(data)).toContain("Carson City");
  });

  it("cuts at the comma wherever a place is typed, the business's own city included", () => {
    const data = {
      business: { name: "Swift Rooter Plumbing", city: "Carson City, NV" },
      serviceAreas: { cities: ["Lake Tahoe, CA and NV"], counties: ["Washoe County, Nevada"] },
      services: { items: [] },
    } as never;
    const names = namesThatMustSurvive(data);
    expect(names).toContain("Carson City");
    expect(names).toContain("Lake Tahoe");
    expect(names).toContain("Washoe County");
    expect(names.some((n) => n.includes(","))).toBe(false);
  });

  it("survives an intake with a place left blank", () => {
    const data = {
      business: { name: "Swift Rooter Plumbing", city: undefined },
      serviceAreas: { cities: [undefined], counties: [] },
      services: { items: [{ name: "Drain Cleaning" }] },
    } as never;
    expect(namesThatMustSurvive(data)).toEqual(["Swift Rooter Plumbing", "Drain Cleaning"]);
  });

  it("treats & and and as the same word", () => {
    const before = "We handle AEO & GEO for local businesses everywhere.";
    const after = "We handle AEO and GEO for local businesses everywhere.";
    expect(improveFactsCheck(before, after, "", ["AEO & GEO"]).changedNames).toEqual([]);
  });

  it("still catches a name that genuinely went", () => {
    expect(improveFactsCheck("We serve Carson City daily.", "We serve the area daily.", "", ["Carson City"]).changedNames).toEqual(["Carson City"]);
  });
});
