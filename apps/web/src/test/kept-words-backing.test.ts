import { describe, expect, it } from "vitest";

import { emptyIntake } from "@tawd/core/intake";
import { confirmedFactsFrom, factIssues, findClaimIssues } from "@tawd/core/mockups";

/*
  Batch B review, H2: on a makeover that keeps the client's current-site
  words, those words are the client's own. Checked against the intake alone,
  every real fact in them failed, a fix round rewrote the client's own copy
  and go-live was blocked. Approved kept words now count as the client's.
*/

const kept = "Founded by Dana Whitfield. Drain clearing is $149. 25 years of experience. Family owned. We serve Shelbyville and Ogdenville.";
const page = `<!doctype html><html><head><title>T</title></head><body><main><h1>Plumber</h1><p>${kept}</p></main></body></html>`;

function intake() {
  const data = emptyIntake();
  data.business.name = "Example Plumbing";
  data.business.phone = "(916) 555-0142";
  data.serviceAreas.cities = ["Springfield"] as never;
  return data;
}

describe("the client's kept words back the facts in them", () => {
  it("reports them when the kept words are not passed (the intake alone)", () => {
    const f = confirmedFactsFrom(intake());
    expect(factIssues(page, f, { year: 2026 }).length).toBeGreaterThan(0);
    expect(findClaimIssues(page, f.claims).length).toBeGreaterThan(0);
  });

  it("finds nothing once they are", () => {
    const f = confirmedFactsFrom(intake(), { keptWords: kept });
    expect(factIssues(page, f, { year: 2026 })).toEqual([]);
    expect(findClaimIssues(page, f.claims)).toEqual([]);
  });

  it("still catches a fact that is in neither", () => {
    const f = confirmedFactsFrom(intake(), { keptWords: kept });
    expect(factIssues(page.replace("$149", "$89"), f, { year: 2026 }).map((i) => i.id)).toContain("facts.price");
  });
});
