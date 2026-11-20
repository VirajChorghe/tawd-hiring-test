import { describe, expect, it } from "vitest";

import {
  assessCompleteness,
  emptyIntake,
  goLiveFlags,
  isLicensedTrade,
  parseIntake,
  type CompletenessInput,
} from "@tawd/core/intake";
import { checkPlaceholderRule, describeFactsForPrompt, listIntakeFacts } from "@tawd/core/mockups";
import { splitWords } from "@/components/ui/chips-field";

/*
  Intake changes from the ABC Plumbers run: the license rule depends on the
  trade and can be "in progress", a new business can say it has no Google
  Business Profile yet, and mood words accept spaces and commas.
*/

function input(overrides: { trade?: string; business?: Record<string, unknown> } = {}): CompletenessInput {
  return {
    projectTrade: overrides.trade ?? "plumbing",
    intake: parseIntake({
      business: {
        name: "ABC Plumbers",
        phone: "916-555-0147",
        streetAddress: "1 Main Street",
        licenseNumbers: ["6291155686"],
        yearFounded: 2009,
        googleBusinessProfileUrl: "https://maps.google.com/example",
        ...overrides.business,
      },
      services: { items: [{ id: "s1", name: "Drain cleaning" }] },
      serviceAreas: { cities: ["Sacramento"] },
      // The current website, or "No current website available" (30 September 2026).
      website: { noCurrentWebsite: true },
    }),
    files: [{ kind: "logo", status: "ready" }],
  };
}

const missingKeys = (i: CompletenessInput) => assessCompleteness(i).missing.map((m) => m.key);

describe("the license rule", () => {
  it("applies to licensed trades, and not at all to legal, med spa or other", () => {
    for (const trade of ["plumbing", "hvac", "electrical", "roofing", "well_and_pump"]) {
      expect(isLicensedTrade(trade), trade).toBe(true);
      expect(missingKeys(input({ trade, business: { licenseNumbers: [] } }))).toContain("business.licenseNumber");
    }
    for (const trade of ["legal", "med_spa", "other"]) {
      expect(isLicensedTrade(trade), trade).toBe(false);
      const result = assessCompleteness(input({ trade, business: { licenseNumbers: [] } }));
      expect(result.requirements.map((r) => r.key)).not.toContain("business.licenseNumber");
      expect(result.isComplete).toBe(true);
    }
  });

  it("is answered by License in progress, and flagged for the founders at go-live", () => {
    const inProgress = input({ business: { licenseNumbers: [], licenseInProgress: true } });
    expect(missingKeys(inProgress)).not.toContain("business.licenseNumber");
    expect(goLiveFlags(inProgress)).toEqual([
      expect.objectContaining({ key: "business.licenseNumber", line: expect.stringContaining("in progress") }),
    ]);

    // A missing license is flagged too; a real one, or a legal practice, is not.
    expect(goLiveFlags(input({ business: { licenseNumbers: [] } }))).toHaveLength(1);
    expect(goLiveFlags(input())).toEqual([]);
    expect(goLiveFlags(input({ trade: "legal", business: { licenseNumbers: [] } }))).toEqual([]);
  });

  it("tells the builder to leave the license out while it is in progress", () => {
    const i = input({ business: { licenseNumbers: [], licenseInProgress: true } });
    const facts = listIntakeFacts(i.intake, [], { trade: "plumbing" });
    const license = facts.find((f) => f.key === "business.licenseNumbers")!;
    expect(license.tier).toBe("detail");
    expect(license.label).toContain("leave it out, no placeholder");
  });
});

describe("a new business with no Google Business Profile", () => {
  it("answers the requirement, and the concepts leave the reviews section out", () => {
    const i = input({ business: { googleBusinessProfileUrl: "", noGoogleBusinessProfile: true } });
    expect(missingKeys(i)).not.toContain("business.googleBusinessProfileUrl");

    const facts = listIntakeFacts(i.intake, [], { trade: "plumbing" });
    const prompt = describeFactsForPrompt(facts);
    expect(prompt.detail).toContain("leave the reviews section out entirely");

    // A reviews placeholder is now a detail to remove, not one to keep.
    const issues = checkPlaceholderRule("<p>[PLACEHOLDER: Google reviews]</p>", facts);
    expect(issues.map((i) => i.id)).toContain("placeholders.detail");
  });

  it("leaves reviews out for a business with a profile too, when it has none to show (8 October 2026)", () => {
    const facts = listIntakeFacts(input().intake, [], { trade: "plumbing" });
    expect(describeFactsForPrompt(facts).detail).toContain("Google rating and reviews");
  });

  it("defaults both new answers to off for existing intakes", () => {
    const blank = emptyIntake();
    expect(blank.business.noGoogleBusinessProfile).toBe(false);
    expect(blank.business.licenseInProgress).toBe(false);
  });
});

describe("mood words", () => {
  it("accept spaces and commas", () => {
    expect(splitWords("honest, fast, local")).toEqual(["honest", "fast", "local"]);
    expect(splitWords("family run,  no  nonsense ;local")).toEqual(["family run", "no nonsense", "local"]);
    expect(splitWords(" , ,")).toEqual([]);
  });
});
