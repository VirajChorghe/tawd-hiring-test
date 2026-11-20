import { describe, expect, it } from "vitest";

import { buildSectionStatuses, checkTawdFit, describeFitWarning, emptyIntake, intakeSectionKeys, parseIntake } from "@tawd/core/intake";

/*
  The "TAWD fit" check (26 September 2026): something outside TAWD is
  flagged "Better as a custom VML build" with the reason. A warning only.
*/

function intakeWith(patch: Record<string, unknown>) {
  return parseIntake({ ...emptyIntake(), ...patch });
}

describe("the TAWD fit check", () => {
  it("is quiet for an ordinary service business", () => {
    const intake = intakeWith({
      services: { items: [{ id: "s1", name: "Drain cleaning", description: "Same-day drain cleaning." }], mainServiceId: "s1" },
      extras: { currentOffers: "$50 off your first visit" },
    });
    expect(checkTawdFit(intake)).toBeNull();
  });

  it("flags a ticked feature with its reason", () => {
    const warning = checkTawdFit(intakeWith({ extras: { specialFeatures: ["online_store", "member_logins"] } }));
    expect(warning?.title).toBe("Better as a custom VML build");
    expect(warning?.reasons.map((r) => r.feature)).toEqual(["online_store", "member_logins"]);
    expect(describeFitWarning(warning!)).toMatch(/online store.*ticked in Extras.*A warning only/);
  });

  it("finds a need in the intake's own words when nothing is ticked", () => {
    const warning = checkTawdFit(
      intakeWith({
        services: { items: [{ id: "s1", name: "Botox", description: "Clients book and log in to their account to see treatment plans." }] },
        process: { quotingAndPricing: "They want an instant quote tool on the site." },
      }),
    );
    expect(warning?.reasons.map((r) => r.feature)).toEqual(["member_logins", "custom_app"]);
    expect(warning?.reasons[0]!.source).toBe('mentioned in the service "Botox"');
  });

  it("hears a login need in plain words", () => {
    expect(checkTawdFit(intakeWith({ extras: { specialFeaturesNote: "They would like clients to log in to see their treatment plans." } }))?.reasons.map((r) => r.feature)).toEqual(["member_logins"]);
  });

  it("does not flag a link to an existing shop or portal", () => {
    expect(checkTawdFit(intakeWith({ extras: { currentOffers: "Gift cards sold in our Square shop" } }))).toBeNull();
  });

  it("marks the Extras section in the intake nav, without blocking anything", () => {
    const intake = intakeWith({ extras: { specialFeatures: ["custom_app"] } });
    const statuses = buildSectionStatuses({
      completeness: { missing: [], isComplete: true, percent: 100, satisfiedCount: 1, totalCount: 1 } as never,
      tierWarning: null,
      fitWarning: checkTawdFit(intake),
      fileCounts: {},
      hasContent: Object.fromEntries(intakeSectionKeys.map((k) => [k, false])) as never,
    });
    expect(statuses.find((s) => s.key === "extras")).toMatchObject({ badge: "Custom build?", kind: "warning", missingCount: 0 });
  });
});
