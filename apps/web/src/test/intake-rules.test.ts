import { describe, expect, it } from "vitest";

import {
  assessCompleteness,
  type CompletenessInput,
} from "@tawd/core/intake";
import {
  describeGateRefusal,
  evaluateGate,
  isLeavingIntake,
} from "@tawd/core/intake";
import { checkUpload, fileRules, formatBytes, imageTypeOfBytes } from "@tawd/core/intake";
import { emptyIntake, parseIntake } from "@tawd/core/intake";
import { STARTER_MAX_SERVICES, checkTier } from "@tawd/core/intake";

/*
  The rules, tested on their own. No database and no network: these are the
  decisions the whole phase turns on, so they should be readable and fast.
*/

function intakeWith(overrides: Record<string, unknown>) {
  return parseIntake(overrides);
}

/** Everything the gate needs, filled in. */
function completeInput(): CompletenessInput {
  return {
    projectTrade: "plumbing",
    intake: intakeWith({
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
      // The current website, or "No current website available" (30 September 2026).
      website: { currentWebsiteUrl: "https://sacdrainpros.example" },
      // With a current website, the project type (0.100.0).
      content: { mode: "auto" },
    }),
    files: [{ kind: "logo", status: "ready" }],
  };
}

describe("what the intake requires", () => {
  it("counts a blank intake as nothing done", () => {
    const result = assessCompleteness({
      projectTrade: null,
      intake: emptyIntake(),
      files: [],
    });

    expect(result.satisfiedCount).toBe(0);
    expect(result.percent).toBe(0);
    expect(result.isComplete).toBe(false);
    expect(result.missing).toHaveLength(result.totalCount);
  });

  it("is complete once every required answer is there", () => {
    const result = assessCompleteness(completeInput());

    expect(result.missing).toEqual([]);
    expect(result.isComplete).toBe(true);
    expect(result.percent).toBe(100);
  });

  it("names exactly what is missing", () => {
    const input = completeInput();
    input.intake.business.phone = "";
    input.intake.serviceAreas.cities = [];

    const result = assessCompleteness(input);
    const keys = result.missing.map((m) => m.key);

    expect(keys).toEqual(["business.phone", "serviceAreas.atLeastOne"]);
    expect(result.isComplete).toBe(false);
  });

  it("wants an address, unless it is a service-area business", () => {
    const withoutAddress = completeInput();
    withoutAddress.intake.business.streetAddress = "";

    expect(
      assessCompleteness(withoutAddress).missing.map((m) => m.key),
    ).toContain("business.address");

    withoutAddress.intake.business.isServiceAreaBusiness = true;
    expect(assessCompleteness(withoutAddress).isComplete).toBe(true);
  });

  it("does not accept a logo that never finished uploading", () => {
    const input = completeInput();
    input.files = [{ kind: "logo", status: "pending" }];

    expect(assessCompleteness(input).missing.map((m) => m.key)).toContain(
      "brand.logo",
    );
  });

  it("does not accept a brand guide in place of a logo", () => {
    const input = completeInput();
    input.files = [{ kind: "brand_guide", status: "ready" }];

    expect(assessCompleteness(input).missing.map((m) => m.key)).toContain(
      "brand.logo",
    );
  });

  it("takes the trade from the project rather than asking twice", () => {
    const input = completeInput();
    input.projectTrade = null;

    expect(assessCompleteness(input).missing.map((m) => m.key)).toContain(
      "project.trade",
    );
  });

  it("reports progress as a percentage for the bar", () => {
    const input = completeInput();
    input.intake.business.phone = "";

    const result = assessCompleteness(input);
    expect(result.percent).toBeGreaterThan(0);
    expect(result.percent).toBeLessThan(100);
    expect(result.satisfiedCount).toBe(result.totalCount - 1);
  });
});

describe("the gate out of Intake", () => {
  const complete = () => assessCompleteness(completeInput());
  const incomplete = () => {
    const input = completeInput();
    input.intake.business.phone = "";
    return assessCompleteness(input);
  };

  it("applies to every forward move, not only to Mockups", () => {
    for (const to of ["mockups", "content", "build", "qa", "live"] as const) {
      expect(isLeavingIntake("intake", to)).toBe(true);
    }
  });

  it("does not block pausing", () => {
    expect(isLeavingIntake("intake", "paused")).toBe(false);

    const decision = evaluateGate({
      from: "intake",
      to: "paused",
      completeness: incomplete(),
    });
    expect(decision.allowed).toBe(true);
  });

  it("does not interfere with moves that never touch Intake", () => {
    const decision = evaluateGate({
      from: "mockups",
      to: "content",
      completeness: incomplete(),
    });
    expect(decision.allowed).toBe(true);
  });

  it("lets a complete intake through", () => {
    const decision = evaluateGate({
      from: "intake",
      to: "mockups",
      completeness: complete(),
    });
    expect(decision).toEqual({ allowed: true, overrideUsed: false });
  });

  it("asks for an explicit choice when items are missing, and says which", () => {
    const decision = evaluateGate({
      from: "intake",
      to: "mockups",
      completeness: incomplete(),
    });

    expect(decision.allowed).toBe(false);
    expect(describeGateRefusal(decision)).toContain("Phone number");
    expect(describeGateRefusal(decision)).toContain("Continue without these");
  });
});

describe("continuing without the missing items", () => {
  const incomplete = () => {
    const input = completeInput();
    input.intake.business.phone = "";
    return assessCompleteness(input);
  };

  it("lets anyone who can move the stage continue, with no reason needed", () => {
    const decision = evaluateGate({
      from: "intake",
      to: "mockups",
      completeness: incomplete(),
      continueWithoutMissing: true,
    });

    expect(decision.allowed && decision.overrideUsed).toBe(true);
  });

  it("records what was skipped and any note", () => {
    const decision = evaluateGate({
      from: "intake",
      to: "mockups",
      completeness: incomplete(),
      continueWithoutMissing: true,
      note: "  Phone number follows on Monday.  ",
    });

    if (!decision.allowed || !decision.overrideUsed) {
      expect.unreachable("continuing should have been allowed");
    } else {
      expect(decision.reason).toBe("Phone number follows on Monday.");
      expect(decision.missing.map((m) => m.key)).toEqual(["business.phone"]);
    }
  });

  it("logs a plain default when no note is given", () => {
    const decision = evaluateGate({
      from: "intake",
      to: "mockups",
      completeness: incomplete(),
      continueWithoutMissing: true,
      note: "   ",
    });
    expect(decision.allowed && decision.overrideUsed && decision.reason).toBe("Continued without these");
  });

  it("needs no choice when the intake is complete", () => {
    const decision = evaluateGate({
      from: "intake",
      to: "mockups",
      completeness: assessCompleteness(completeInput()),
      continueWithoutMissing: true,
    });

    expect(decision).toEqual({ allowed: true, overrideUsed: false });
  });
});

describe("the tier warning", () => {
  it("says nothing about a tidy Starter project", () => {
    const intake = intakeWith({
      services: { items: [{ id: "a", name: "Drain cleaning" }] },
      serviceAreas: { cities: ["Sacramento"], wantsIndividualCityPages: false },
    });

    expect(checkTier("starter", intake)).toBeNull();
  });

  it("warns when there are more than five services", () => {
    const intake = intakeWith({
      services: {
        items: Array.from({ length: 6 }, (_, i) => ({
          id: `s${i}`,
          name: `Service ${i}`,
        })),
      },
    });

    const warning = checkTier("starter", intake);
    expect(warning?.needsAtLeast).toBe("growth");
    expect(warning?.reasons[0]).toContain("6 services");
  });

  it("does not warn at exactly five", () => {
    const intake = intakeWith({
      services: {
        items: Array.from({ length: STARTER_MAX_SERVICES }, (_, i) => ({
          id: `s${i}`,
          name: `Service ${i}`,
        })),
      },
    });

    expect(checkTier("starter", intake)).toBeNull();
  });

  it("warns when a page per city is wanted", () => {
    const intake = intakeWith({
      serviceAreas: {
        cities: ["Sacramento", "Elk Grove", "Roseville"],
        wantsIndividualCityPages: true,
      },
    });

    const warning = checkTier("starter", intake);
    expect(warning?.reasons[0]).toContain("3 cities");
  });

  it("gives both reasons when both apply", () => {
    const intake = intakeWith({
      services: {
        items: Array.from({ length: 8 }, (_, i) => ({
          id: `s${i}`,
          name: `Service ${i}`,
        })),
      },
      serviceAreas: { cities: ["Reno"], wantsIndividualCityPages: true },
    });

    expect(checkTier("starter", intake)?.reasons).toHaveLength(2);
  });

  it("stays quiet on Growth and Pro, which already cover it", () => {
    const intake = intakeWith({
      services: {
        items: Array.from({ length: 20 }, (_, i) => ({
          id: `s${i}`,
          name: `Service ${i}`,
        })),
      },
      serviceAreas: { wantsIndividualCityPages: true },
    });

    expect(checkTier("growth", intake)).toBeNull();
    expect(checkTier("pro", intake)).toBeNull();
  });
});

/*
  An iPhone photo whose type the browser does not know (Jason, 10 November
  2026: "I thought we fixed this").

  Gap 11 made TAWD accept HEIC and convert it to JPEG at ingress, and the
  message on the screen lists heic as allowed - but the gate is the
  CONTENT TYPE, and Windows and Chrome report no type at all for a .HEIC
  file. So file.type arrived empty, nothing matched, and the upload was
  refused by the very screen that said heic was fine. The name is the only
  thing that knows what the file is, so it is asked when the type cannot
  answer.
*/
describe("a file whose type the browser doesn't know", () => {
  it("takes the answer from the name when the content type is empty or generic", () => {
    expect(checkUpload("photo", "", 200_000, 0, "IMG_1126.HEIC").ok).toBe(true);
    expect(checkUpload("photo", "application/octet-stream", 200_000, 0, "IMG_1126.heic").ok).toBe(true);
    expect(checkUpload("photo", "", 200_000, 0, "patio.HEIF").ok).toBe(true);
    expect(checkUpload("logo", "", 200_000, 0, "logo.png").ok).toBe(true);
    expect(checkUpload("design_file", "application/octet-stream", 200_000, 0, "design.pdf").ok).toBe(true);
  });

  it("still refuses a file whose name is not an allowed kind", () => {
    expect(checkUpload("photo", "", 200_000, 0, "notes.txt").ok).toBe(false);
    expect(checkUpload("photo", "", 200_000, 0, "installer.exe").ok).toBe(false);
    expect(checkUpload("brand_guide", "", 200_000, 0, "guide.png").ok).toBe(false);
    // No name and no type: there is nothing to go on, so it is refused.
    expect(checkUpload("photo", "", 200_000, 0).ok).toBe(false);
    expect(checkUpload("photo", "", 200_000, 0, "photo").ok).toBe(false);
  });

  it("never lets the name override a content type the browser did give", () => {
    // A .jpg name on a file the browser says is a program is still refused.
    expect(checkUpload("photo", "application/x-msdownload", 200_000, 0, "photo.jpg").ok).toBe(false);
    // And a real type is enough on its own, whatever the name says.
    expect(checkUpload("photo", "image/jpeg", 200_000, 0, "photo.weird").ok).toBe(true);
  });

  it("recognises an SVG by its bytes past a long comment, stylesheet instruction or DOCTYPE subset", () => {
    const svg = (head: string) => imageTypeOfBytes(Buffer.from(`${head}<svg xmlns="http://www.w3.org/2000/svg"></svg>`));
    expect(svg("")).toBe("image/svg+xml");
    expect(svg(`<!-- ${"licence ".repeat(250)} -->\n`)).toBe("image/svg+xml");
    expect(svg('<?xml version="1.0"?>\n<?xml-stylesheet href="a.css" type="text/css"?>\n')).toBe("image/svg+xml");
    expect(svg('<!DOCTYPE svg [ <!ENTITY a "b"> ]>\n')).toBe("image/svg+xml");
    expect(svg('<?xml version="1.0"?><!-- x --><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">')).toBe("image/svg+xml");
    expect(imageTypeOfBytes(Buffer.from("just some notes about <svg> files"))).toBeNull();
    expect(imageTypeOfBytes(Buffer.from("<html><body><svg></svg></body></html>"))).toBeNull();
  });

  it("says which kinds are allowed, in the message", () => {
    const refused = checkUpload("photo", "", 200_000, 0, "notes.txt");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain("heic");
  });
});

describe("upload rules", () => {
  it("accepts a sensible logo", () => {
    expect(checkUpload("logo", "image/png", 200_000, 0).ok).toBe(true);
  });

  it("refuses a type that is not on the list", () => {
    const verdict = checkUpload("logo", "application/x-msdownload", 1000, 0);
    expect(verdict.ok).toBe(false);
  });

  it("refuses a PDF as a logo, and an image as a brand guide", () => {
    expect(checkUpload("logo", "application/pdf", 1000, 0).ok).toBe(false);
    expect(checkUpload("brand_guide", "image/png", 1000, 0).ok).toBe(false);
  });

  it("refuses a file over the limit and says the limit", () => {
    const verdict = checkUpload(
      "logo",
      "image/png",
      fileRules.logo.maxBytes + 1,
      0,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.message).toContain("5.0 MB");
  });

  it("accepts a file exactly on the limit", () => {
    expect(
      checkUpload("photo", "image/jpeg", fileRules.photo.maxBytes, 0).ok,
    ).toBe(true);
  });

  it("refuses an empty file", () => {
    expect(checkUpload("photo", "image/jpeg", 0, 0).ok).toBe(false);
  });

  it("allows only one logo", () => {
    expect(checkUpload("logo", "image/png", 1000, 0).ok).toBe(true);

    const second = checkUpload("logo", "image/png", 1000, 1);
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.message).toContain("Remove it first");
  });

  it("allows many photos, up to the cap", () => {
    expect(checkUpload("photo", "image/jpeg", 1000, 59).ok).toBe(true);
    expect(checkUpload("photo", "image/jpeg", 1000, 60).ok).toBe(false);
  });

  it("accepts the document types the content team actually receives", () => {
    for (const type of [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
      "text/markdown",
    ]) {
      expect(checkUpload("content_document", type, 1000, 0).ok).toBe(true);
    }
  });

  it("describes sizes in a way a person can read", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(25 * 1024 * 1024)).toBe("25 MB");
    expect(formatBytes(2048)).toBe("2 KB");
  });
});
