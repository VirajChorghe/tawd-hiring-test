import { describe, expect, it } from "vitest";

import { isFixable } from "@tawd/core/mockups";

import { checkRows } from "@/components/mockups/concept-detail";

/*
  Every check reaches the team (Jason's run, 10 November 2026).

  The Checks tab listed thirteen groups and dropped any issue whose id
  matched none of them, with no row and no count: the card said "Some
  checks failed" and the list showed nothing wrong. Twenty ids were in that
  position - among them the claims guard, which can stop a go-live, and the
  colour-rhythm checks.

  This is the same fault as icons.* in #62, found then by eye. The fix is
  not a longer list: it is that anything unmatched lands in a last row, so a
  check can be unlabelled but never invisible.
*/

const issue = (id: string, severity = "fail") => ({ id, severity, message: `about ${id}` });

const rowFor = (id: string, severity = "fail") =>
  checkRows([issue(id, severity)]).find((row) => row.issues.length > 0);

describe("the Checks tab's rows", () => {
  it("shows the claims guard, which blocks a go-live", () => {
    for (const id of ["house.claim.unsupported", "house.claim.overreach", "house.claim.superlative", "house.section.unsupported"]) {
      expect(rowFor(id)?.label, `${id} is not shown anywhere`).toBe("No invented facts");
    }
  });

  it("shows the families that used to have no row at all", () => {
    expect(rowFor("structure.truncated")?.label).toBe("The page is whole");
    expect(rowFor("design.colourRhythm")?.label).toBe("Colour, rhythm and lines");
    expect(rowFor("design.invisibleRule", "warn")?.label).toBe("Colour, rhythm and lines");
    expect(rowFor("copy.hollowReviews")?.label).toBe("Button labels and wording");
    expect(rowFor("content.siteFeatures", "warn")?.label).toBe("What the current site already says");
  });

  it("puts a check nobody has grouped in a last row rather than dropping it", () => {
    const rows = checkRows([issue("something.nobodyGroupedYet")]);
    const last = rows[rows.length - 1]!;
    expect(last.label).toBe("Other checks");
    expect(last.issues.map((i) => i.id)).toEqual(["something.nobodyGroupedYet"]);
  });

  it("adds no last row when every check is grouped", () => {
    expect(checkRows([issue("a11y.contrast")]).some((row) => row.label === "Other checks")).toBe(false);
    expect(checkRows([]).some((row) => row.label === "Other checks")).toBe(false);
  });

  /*
    Proved because it would be expensive if it were ever wrong (the lesson
    of batch 3a): a line nobody can see is a warning, so it cannot fail the
    checks and cannot buy a paid fix round. Code fixes it for nothing.
  */
  it("a line nobody can see never fails the checks and never costs a fix round", () => {
    expect(isFixable({ id: "design.invisibleRule", severity: "warn", message: "x" })).toBe(false);
    expect(isFixable({ id: "icons.noIcon", severity: "warn", message: "x" })).toBe(false);
    // And the same check as a fail WOULD cost one, which is why its severity matters.
    expect(isFixable({ id: "design.invisibleRule", severity: "fail", message: "x" })).toBe(true);
  });

  it("leaves what only the intake can answer to its own box", () => {
    const rows = checkRows([{ id: "conversion.callButton", severity: "fail", message: "no phone", needsIntake: true }]);
    expect(rows.every((row) => row.issues.length === 0)).toBe(true);
  });

  it("every check id TAWD can raise is shown somewhere", () => {
    /*
      The list is every id a real run has produced, from the engine and the
      rendered checks. A new id added without a row lands in "Other checks"
      by the rule above, so this test is about the ones we already know.
    */
    const ids = [
      "a11y.contrast", "a11y.labels", "a11y.alt", "a11y.tapTargets",
      "conversion.callButton", "conversion.form",
      "house.phone.invented", "house.license.invented", "house.year.invented", "house.reviews.invented",
      "house.claim.unsupported", "house.claim.overreach", "house.claim.superlative", "house.section.unsupported",
      "house.filler", "placeholders.hidden", "images.empty", "images.logo.invisible", "images.stockOutOfPlace",
      "icons.unfilled", "icons.noIcon", "layout.overflow", "layout.headingOneColumn", "layout.headingWrap",
      "layout.gridOrphan", "render.footer", "render.sections", "render.clipped", "render.faceText",
      "stock.outOfPlace", "seo.title", "seo.description", "structure.truncated", "structure.h1.missing",
      "structure.h1.multiple", "structure.collapsed", "structure.unbalanced", "design.colourRhythm",
      "design.colourRhythm.flatRun", "design.photoBand", "design.invisibleRule", "copy.callButton",
      "copy.formButton", "copy.hollowReviews", "copy.labels", "copy.repeats", "content.siteFeatures",
      "content.siteFeaturesLeftOut",
    ];
    for (const id of ids) {
      const row = rowFor(id);
      expect(row, `${id} reaches no row`).toBeTruthy();
      expect(row!.label, `${id} is only in the catch-all row; give it a group`).not.toBe("Other checks");
    }
  });
});
