import { describe, expect, it } from "vitest";

import {
  assessCompleteness,
  requirementIds,
  type CompletenessInput,
} from "@tawd/core/intake";
import { emptyIntake, intakeSectionKeys, parseIntake } from "@tawd/core/intake";
import { buildSectionStatuses, hasAnyContent } from "@tawd/core/intake";
import { checkTier } from "@tawd/core/intake";

/*
  The presentation rules the approved design depends on.

  These are pure functions on purpose: what each section's badge says, and
  what a field tells somebody when it is empty, are decisions worth pinning
  down rather than eyeballing in a browser.
*/

function completeInput(): CompletenessInput {
  return {
    projectTrade: "plumbing",
    intake: parseIntake({
      business: {
        name: "Sacramento Drain Pros",
        phone: "916-555-0142",
        streetAddress: "1 Main Street",
        licenseNumbers: ["C36-123456"],
        yearFounded: 2009,
        googleBusinessProfileUrl: "https://maps.google.com/example",
      },
      services: { items: [{ id: "s1", name: "Drain cleaning" }] },
      serviceAreas: { cities: ["Sacramento"] },
    }),
    files: [{ kind: "logo", status: "ready" }],
  };
}

function statusesFor(input: CompletenessInput, fileCounts = {}) {
  const completeness = assessCompleteness(input);
  const hasContent = Object.fromEntries(
    intakeSectionKeys.map((key) => [key, hasAnyContent(input.intake[key])]),
  ) as Record<(typeof intakeSectionKeys)[number], boolean>;

  return buildSectionStatuses({
    completeness,
    tierWarning: checkTier("starter", input.intake),
    fileCounts,
    hasContent,
  });
}

describe("what every required field tells you when it is empty", () => {
  const { requirements } = assessCompleteness({
    projectTrade: null,
    intake: emptyIntake(),
    files: [],
  });

  it("explains why each one matters, rather than only saying it is missing", () => {
    for (const requirement of requirements) {
      expect(
        requirement.whyItMatters,
        `${requirement.key} has no explanation`,
      ).toBeTruthy();
      expect(requirement.whyItMatters.length).toBeGreaterThan(20);
    }
  });

  it("names a field to focus, so the Required info card can jump to it", () => {
    for (const requirement of requirements) {
      expect(requirement.fieldId, `${requirement.key} has no field`).toBeTruthy();
    }
  });

  it("points every requirement at a real section of the form", () => {
    for (const requirement of requirements) {
      expect(intakeSectionKeys).toContain(requirement.section);
    }
  });

  it("uses field ids that the form actually renders", () => {
    const known = new Set<string>(Object.values(requirementIds));
    for (const requirement of requirements) {
      expect(known).toContain(requirement.fieldId);
    }
  });
});

describe("the section list badges", () => {
  it("counts what is missing in each section", () => {
    const input = completeInput();
    input.intake.business.phone = "";
    input.intake.business.yearFounded = null;
    input.intake.serviceAreas.cities = [];

    const statuses = statusesFor(input);
    const business = statuses.find((s) => s.key === "business");
    const areas = statuses.find((s) => s.key === "serviceAreas");

    expect(business?.badge).toBe("2 missing");
    expect(business?.kind).toBe("missing");
    expect(areas?.badge).toBe("1 missing");
  });

  it("says Done for a section that is filled in with nothing outstanding", () => {
    const statuses = statusesFor(completeInput());
    expect(statuses.find((s) => s.key === "business")?.badge).toBe("Done");
    expect(statuses.find((s) => s.key === "business")?.kind).toBe("done");
  });

  it("says Optional for a section nobody has touched", () => {
    const statuses = statusesFor(completeInput());
    const extras = statuses.find((s) => s.key === "extras");

    expect(extras?.badge).toBe("Optional");
    expect(extras?.kind).toBe("info");
  });

  it("does not congratulate an empty optional section as Done", () => {
    const input = completeInput();
    const statuses = statusesFor(input);

    for (const key of ["process", "extras"] as const) {
      expect(statuses.find((s) => s.key === key)?.badge).not.toBe("Done");
    }
  });

  it("says Needs Growth on the sections that caused it", () => {
    const input = completeInput();
    input.intake.services.items = Array.from({ length: 7 }, (_, i) => ({
      id: `s${i}`,
      name: `Service ${i}`,
      description: "",
    }));

    const statuses = statusesFor(input);
    expect(statuses.find((s) => s.key === "services")?.badge).toBe(
      "Needs Growth",
    );
    expect(statuses.find((s) => s.key === "services")?.kind).toBe("warning");
    // Not on unrelated sections.
    expect(statuses.find((s) => s.key === "brand")?.badge).not.toBe(
      "Needs Growth",
    );
  });

  it("puts missing answers ahead of a tier warning, since only one blocks", () => {
    const input = completeInput();
    input.intake.services.items = [];

    const statuses = statusesFor(input);
    expect(statuses.find((s) => s.key === "services")?.badge).toBe("1 missing");
  });

  it("counts photos rather than judging them", () => {
    const withPhotos = statusesFor(completeInput(), { photo: 3 });
    expect(withPhotos.find((s) => s.key === "photos")?.badge).toBe("3 photos");

    const withOne = statusesFor(completeInput(), { photo: 1 });
    expect(withOne.find((s) => s.key === "photos")?.badge).toBe("1 photo");

    const withNone = statusesFor(completeInput(), {});
    expect(withNone.find((s) => s.key === "photos")?.badge).toBe("Optional");
  });

  it("lists every section, in the order of the form", () => {
    const statuses = statusesFor(completeInput());
    expect(statuses.map((s) => s.key)).toEqual([...intakeSectionKeys]);
  });
});

describe("telling an empty section from a filled one", () => {
  it("treats blank strings, empty lists and nulls as empty", () => {
    expect(hasAnyContent({})).toBe(false);
    expect(hasAnyContent({ a: "", b: [], c: null })).toBe(false);
    expect(hasAnyContent({ a: "   " })).toBe(false);
    expect(hasAnyContent({ a: false })).toBe(false);
  });

  it("treats any real answer as content", () => {
    expect(hasAnyContent({ a: "yes" })).toBe(true);
    expect(hasAnyContent({ a: 0 })).toBe(true);
    expect(hasAnyContent({ a: true })).toBe(true);
    expect(hasAnyContent({ a: [{ b: "x" }] })).toBe(true);
  });

  it("does not count a list of empty rows as content", () => {
    expect(hasAnyContent({ cities: ["", ""] })).toBe(false);
  });
});
