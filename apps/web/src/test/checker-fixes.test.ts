import { describe, expect, it } from "vitest";

import {
  buildConceptUserPrompt,
  embedAssets,
  intakePhones,
  isFixable,
  listIntakeFacts,
  runHtmlChecks,
  type CheckFacts,
} from "@tawd/core/mockups";
import { businessSchema, emptyIntake } from "@tawd/core/intake";

/*
  Fixes from the ABC Plumbers test run: the invented-facts check mistook a
  license number for a phone number and read "License" as the license
  "ense", which cost Concept A two fix rounds.
*/

const facts = (overrides: Partial<CheckFacts> = {}): CheckFacts => ({
  phones: ["(916) 555-0147"],
  licenseNumbers: ["6291155686"],
  yearFounded: null,
  businessName: "ABC Plumbers",
  cities: ["Sacramento"],
  ...overrides,
});

const page = (body: string) =>
  `<!doctype html><html lang="en"><head><title>ABC Plumbers in Sacramento</title></head><body><h1>ABC Plumbers</h1>${body}</body></html>`;

const ids = (html: string, f = facts()) => runHtmlChecks(page(html), f).issues.map((i) => i.id);

describe("invented facts", () => {
  it("does not mistake the intake's license number for a phone number", () => {
    expect(ids("<p>License: 6291155686</p>")).not.toContain("house.phone.invented");
    expect(ids("<p>CA License # 6291155686</p>")).not.toContain("house.license.invented");
  });

  it("never reads any number written after License as a phone number", () => {
    const found = ids("<p>Lic. 6291155699</p>", facts({ licenseNumbers: [] }));
    expect(found).not.toContain("house.phone.invented");
    // It is still an invented license, though.
    expect(found).toContain("house.license.invented");
  });

  it("reports the real number, never 'ense' from the word License", () => {
    for (const text of ["License: 7777777", "License 7777777", "LICENSE NO. 7777777", "License number 7777777"]) {
      const issues = runHtmlChecks(page(`<p>${text}</p>`), facts({ licenseNumbers: [] })).issues;
      const license = issues.filter((i) => i.id === "house.license.invented");
      expect(license, text).toHaveLength(1);
      expect(license[0]!.message).toContain('"7777777"');
      expect(issues.some((i) => /"ense/i.test(i.message))).toBe(false);
    }
  });

  /*
    Found by the canary's very first run (10 November 2026): a California
    contractor's licence is often typed as a classification and a number,
    "C-36 998811". The pattern stopped at the space, so it read "C-36",
    normalised that to "C36", compared it with "C36998811" and reported the
    page as INVENTING a licence - a client stating their own licence
    correctly failed the house rule for it.
  */
  it("reads a licence written with a space in it, as a contractor's licence usually is", () => {
    const spaced = facts({ licenseNumbers: ["C-36 998811"] });
    for (const text of ["License C-36 998811", "Licence: C-36 998811", "CSLB C-36 998811", "License #C-36 998811"]) {
      expect(ids(`<p>${text}</p>`, spaced), text).not.toContain("house.license.invented");
    }
    // Written without the space, it is the same licence.
    expect(ids("<p>License C-36998811</p>", spaced)).not.toContain("house.license.invented");
  });

  it("still catches a wrong number after a licence that starts right", () => {
    const spaced = facts({ licenseNumbers: ["C-36 998811"] });
    // The classification is right and the number is not: that is an invented licence.
    expect(ids("<p>License C-36 111222</p>", spaced)).toContain("house.license.invented");
    // And the classification alone is not the licence.
    expect(ids("<p>License C-36 and insured</p>", spaced)).toContain("house.license.invented");
  });

  it("never swallows a sentence looking for the rest of a licence", () => {
    const issues = runHtmlChecks(page("<p>License 1234567 and fully insured statewide</p>"), facts({ licenseNumbers: [] })).issues;
    const license = issues.filter((i) => i.id === "house.license.invented");
    expect(license).toHaveLength(1);
    expect(license[0]!.message).toContain('"1234567"');
    expect(license[0]!.message).not.toMatch(/insured|statewide/i);
  });

  it("ignores words with no digits, like Licensed and insured", () => {
    expect(ids("<p>Licensed and insured. License pending.</p>", facts({ licenseNumbers: [] }))).not.toContain(
      "house.license.invented",
    );
  });

  it("still catches a phone number the intake doesn't have", () => {
    expect(ids("<p>Call (916) 555-9999 now</p>")).toContain("house.phone.invented");
    expect(ids("<p>Call (916) 555-0147 now</p>")).not.toContain("house.phone.invented");
  });

  it("still accepts the intake's own license in its usual forms", () => {
    expect(ids("<p>Lic. #6291155686</p>")).not.toContain("house.license.invented");
    expect(ids("<p>CSLB 6291155686</p>")).not.toContain("house.license.invented");
  });
});

describe("fixable or needs intake info", () => {
  it("spends fix rounds only on failures the builder can fix", () => {
    expect(isFixable({ id: "seo.title.long", severity: "fail", message: "" })).toBe(true);
    expect(isFixable({ id: "conversion.tel.missing", severity: "fail", message: "", needsIntake: true })).toBe(false);
    expect(isFixable({ id: "seo.description.long", severity: "warn", message: "" })).toBe(false);
    expect(isFixable({ id: "a11y.tapTargets", severity: "info", message: "" })).toBe(false);
  });
});

describe("the logo", () => {
  it("is marked where it goes on the page, so the rendered check can find it", () => {
    const html = embedAssets(
      `<header><img class="logo" src="tawd-asset:logo" alt="ABC"></header><img src="tawd-asset:photo-1" alt="">`,
      { "tawd-asset:logo": "data:image/png;base64,AAA", "tawd-asset:photo-1": "data:image/png;base64,BBB" },
    );
    expect(html).toContain('<img data-tawd-logo class="logo" src="data:image/png;base64,AAA"');
    expect(html.match(/data-tawd-logo/g)).toHaveLength(1);
  });

  it("tells the builder how the logo reads, so it is never placed where it vanishes", () => {
    const prompt = (tone: "dark" | "light") =>
      buildConceptUserPrompt({
        brief: { skillId: "impeccable", direction: "modern_clean", conceptLabel: "A" },
        project: { clientName: "ABC Plumbers", trade: "plumbing", tier: "starter" },
        intake: emptyIntake(),
        assets: [{ token: "tawd-asset:logo", kind: "logo", caption: null, fileName: "logo.png", width: 400, height: 120, tone }],
        facts: [],
      });
    expect(prompt("dark")).toContain("its marks are dark on a transparent background");
    expect(prompt("dark")).toContain("brightness(0) invert(1)");
    expect(prompt("light")).toContain("put it on a dark background");
  });
});

describe("a year next to a phone number", () => {
  it("reads the year and the phone apart, and knows the phone", () => {
    const outcome = runHtmlChecks(
      `<!doctype html><html lang="en"><head><title>Example Well and Pump in Reno</title></head><body><h1>Wells</h1><p>Since 1981 775-555-0118</p><a href="tel:+17755550118">775-555-0118</a></body></html>`,
      { phones: ["775-555-0118"], licenseNumbers: [], yearFounded: 1981, businessName: "Example", cities: [] },
    );
    expect(outcome.issues.find((i) => i.id === "house.phone.invented")).toBeUndefined();
  });

  it("still flags a phone number the intake doesn't have", () => {
    const outcome = runHtmlChecks(
      `<!doctype html><html lang="en"><head><title>t</title></head><body><h1>x</h1><p>Call 775-555-0100 today</p></body></html>`,
      { phones: ["775-555-0118"], licenseNumbers: [], yearFounded: null, businessName: "Example", cities: [] },
    );
    expect(outcome.issues.find((i) => i.id === "house.phone.invented")?.evidence).toBe("775-555-0100");
  });
});

describe("a business with more than one office", () => {
  const withOffices = () => {
    const intake = emptyIntake();
    intake.business = businessSchema.parse({
      name: "Example Well & Pump",
      phone: "775-555-0118",
      city: "Reno",
      locations: [
        { name: "Bishop", phone: "(760) 555-0142", streetAddress: "12 Line St", city: "Bishop", state: "CA" },
        { name: "Winnemucca", phone: "775-555-0177" },
        { name: "", phone: "" },
      ],
    });
    return intake;
  };

  it("keeps each filled-in location, drops empty rows, and knows every phone", () => {
    const intake = withOffices();
    expect(intake.business.locations).toHaveLength(2);
    // Saved as (916) 555-0142 however they were typed (6 October 2026).
    expect(intakePhones(intake)).toEqual(["(775) 555-0118", "(760) 555-0142", "(775) 555-0177"]);
    const fact = listIntakeFacts(intake, []).find((f) => f.key === "business.locations");
    expect(fact?.value).toBe("Bishop: (760) 555-0142, 12 Line St, Bishop, CA; Winnemucca: (775) 555-0177");
  });

  it("doesn't flag a location's phone on the page as invented", () => {
    const outcome = runHtmlChecks(
      `<!doctype html><html lang="en"><head><title>t</title></head><body><h1>x</h1><p>Reno 775-555-0118</p><p>Bishop (760) 555-0142</p><p>Winnemucca 775-555-0177</p></body></html>`,
      facts({ phones: intakePhones(withOffices()) }),
    );
    expect(outcome.issues.find((i) => i.id === "house.phone.invented")).toBeUndefined();
  });
});
