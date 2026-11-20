import { describe, expect, it } from "vitest";

import { emptyIntake, parseIntake } from "@tawd/core/intake";
import {
  assetTokensUsed,
  MAX_FIX_ROUNDS,
  buildConceptUserPrompt,
  buildSectionFixPrompt,
  buildSharedSystemPrompt,
  checkAssets,
  checkPlaceholderRule,
  conceptSpend,
  embedAssets,
  fieldsForPlaceholder,
  listIntakeFacts,
  logoToken,
  photoToken,
  requiredFieldsStillMissing,
  runHtmlChecks,
  type CheckFacts,
  type PageAsset,
} from "@tawd/core/mockups";

/*
  The fixes that came out of the first real concept (Dale Rowan).

  It showed the logo's file name instead of the logo, around 35
  placeholders including several for things the intake may well have had,
  and a cost that counted its build twice. These tests pin each of those.
*/

/* Every field on the form filled in, so nothing has an excuse to be missing. */
const FULL = parseIntake({
  business: {
    name: "Example Well & Pump",
    phone: "(530) 555-0199",
    email: "office@examplewell.example",
    streetAddress: "14 Mill Road",
    city: "Grass Valley",
    state: "CA",
    googleBusinessProfileUrl: "https://maps.google.com/?cid=12345",
    licenseNumbers: ["C57-998877"],
    yearFounded: 1987,
    hours: [{ day: "monday", closed: false, open: "7:00", close: "17:00" }],
    emergency247: true,
    certifications: ["NGWA Certified Well Driller"],
  },
  services: {
    items: [
      { id: "s1", name: "Well drilling", description: "New residential wells" },
      { id: "s2", name: "Pump repair", description: "" },
    ],
    mainServiceId: "s1",
  },
  serviceAreas: { cities: ["Grass Valley", "Nevada City"] },
  brand: { colors: ["#1f5f4f"], fonts: "Barlow" },
  content: { toneOfVoice: "Plain and direct", suppliedCopy: "We drill wells." },
  process: {
    scheduling: "Call and we book a visit within two days",
    quotingAndPricing: "Free written quote after a site visit",
    guarantees: "One-year workmanship guarantee",
  },
  extras: { currentOffers: "Free water test with any pump repair", financingAvailable: true },
});

const FILES = [{ kind: "logo" }, { kind: "photo" }];

/*
  One realistic placeholder a model might write for each fact. The test
  below insists every fact has one, so a field added to the intake later
  cannot slip past this check unnoticed.
*/
const SAMPLE_PLACEHOLDER: Record<string, string> = {
  "business.name": "[PLACEHOLDER: business name]",
  "business.phone": "[PLACEHOLDER: phone number]",
  "business.email": "[PLACEHOLDER: email address]",
  "business.streetAddress": "[PLACEHOLDER: street address]",
  "business.city": "[PLACEHOLDER: city, state]",
  "business.state": "[PLACEHOLDER: state]",
  "business.googleBusinessProfileUrl": "[PLACEHOLDER: Google Business Profile link]",
  "business.licenseNumbers": "[PLACEHOLDER: license number]",
  "business.yearFounded": "[PLACEHOLDER: year founded]",
  "business.hours": "[PLACEHOLDER: opening hours]",
  "business.emergency247": "[PLACEHOLDER: 24/7 availability]",
  "business.certifications": "[PLACEHOLDER: certifications]",
  "services.items": "[PLACEHOLDER: list of services]",
  "services.main": "[PLACEHOLDER: main service]",
  "serviceAreas.cities": "[PLACEHOLDER: service areas]",
  "brand.logo": "[PLACEHOLDER: logo]",
  photos: "",
  "brand.colors": "",
  "brand.fonts": "",
  "content.toneOfVoice": "",
  "content.suppliedCopy": "",
  "process.scheduling": "",
  "process.quotingAndPricing": "",
  "process.guarantees": "[PLACEHOLDER: guarantee]",
  "extras.currentOffers": "[PLACEHOLDER: current offer]",
  "extras.financingAvailable": "[PLACEHOLDER: financing options]",
};

function checkFacts(
  intake = FULL,
  files: { kind: string }[] = FILES,
): CheckFacts {
  return {
    phones: [intake.business.phone].filter(Boolean),
    licenseNumbers: intake.business.licenseNumbers,
    yearFounded: intake.business.yearFounded,
    businessName: intake.business.name,
    cities: intake.serviceAreas.cities,
    intakeFacts: listIntakeFacts(intake, files),
  };
}

function page(body: string): string {
  return `<!doctype html><html><head><title>Wells</title></head><body>${body}</body></html>`;
}

describe("what the intake knows", () => {
  it("has a value for every fact when every field is filled", () => {
    const empty = listIntakeFacts(FULL, FILES).filter((f) => f.value === null);
    expect(empty.map((f) => f.label)).toEqual([]);
  });

  it("has no value for anything when the intake is blank", () => {
    const known = listIntakeFacts(emptyIntake(), []).filter((f) => f.value !== null);
    expect(known.map((f) => f.label)).toEqual([]);
  });

  it("counts a service-area business as having answered the address", () => {
    const intake = parseIntake({ business: { isServiceAreaBusiness: true } });
    const address = listIntakeFacts(intake, []).find(
      (f) => f.key === "business.streetAddress",
    );
    expect(address?.value).not.toBeNull();
  });
});

describe("every filled intake field reaches the build prompt", () => {
  const prompt = buildConceptUserPrompt({
    brief: { skillId: "impeccable", direction: "rugged_craftsman", conceptLabel: "A" },
    project: { clientName: "Dale Rowan", trade: "home_services", tier: "starter" },
    intake: FULL,
    assets: [],
    facts: listIntakeFacts(FULL, FILES),
  });

  const values = [
    "Example Well & Pump",
    "(530) 555-0199",
    "office@examplewell.example",
    "14 Mill Road",
    "Grass Valley",
    "CA",
    "https://maps.google.com/?cid=12345",
    "C57-998877",
    "1987",
    "NGWA Certified Well Driller",
    "Well drilling",
    "Nevada City",
    "One-year workmanship guarantee",
    "Free water test with any pump repair",
  ];

  it.each(values)("includes %s in the checklist of known facts", (value) => {
    const checklist = prompt.split("# The facts, as a checklist")[1]!.split(
      "Everything below is NOT in the intake",
    )[0]!;
    expect(checklist).toContain(value);
  });

  it("says nothing is missing when nothing is", () => {
    expect(prompt).toContain("every required field is filled");
  });

  it("lists what is missing, by name, when something is", () => {
    const intake = parseIntake({ business: { name: "Example Well & Pump" } });
    const sparse = buildConceptUserPrompt({
      brief: { skillId: "impeccable", direction: "rugged_craftsman", conceptLabel: "A" },
      project: { clientName: "Dale Rowan", trade: "home_services", tier: "starter" },
      intake,
      assets: [],
      facts: listIntakeFacts(intake, []),
    });
    const missing = sparse.split("Everything below is NOT in the intake")[1]!;
    expect(missing).toContain("- Phone number");
    expect(missing).not.toContain("- Business name");
  });
});

describe("a filled intake field never appears as a placeholder", () => {
  it("has a sample placeholder for every fact, so none is untested", () => {
    for (const fact of listIntakeFacts(FULL, FILES)) {
      expect(SAMPLE_PLACEHOLDER, `no sample for ${fact.key}`).toHaveProperty(fact.key);
    }
  });

  const cases = Object.entries(SAMPLE_PLACEHOLDER).filter(([, sample]) => sample);

  it.each(cases)("fails the checks for a placeholder standing in for %s", (key, sample) => {
    expect(fieldsForPlaceholder(sample)).toContain(key);

    const outcome = runHtmlChecks(page(`<h1>Wells</h1><p>${sample}</p>`), checkFacts());
    const flagged = outcome.issues.filter((i) => i.id === "house.placeholder.filled");
    expect(flagged.map((i) => i.where)).toContain(key);
    expect(outcome.passed).toBe(false);
  });

  it.each(cases)("accepts the same placeholder for %s when the intake is empty", (_key, sample) => {
    const outcome = runHtmlChecks(
      page(`<h1>Wells</h1><p>${sample}</p>`),
      checkFacts(emptyIntake(), []),
    );
    expect(outcome.issues.map((i) => i.id)).not.toContain("house.placeholder.filled");
  });

  it("the headline from the first run is caught when the city is known", () => {
    const outcome = runHtmlChecks(
      page("<h1>Well drilling in [PLACEHOLDER: city, state]</h1>"),
      checkFacts(),
    );
    const flagged = outcome.issues.filter((i) => i.id === "house.placeholder.filled");
    expect(flagged.map((i) => i.where)).toEqual(
      expect.arrayContaining(["business.city", "business.state"]),
    );
    expect(flagged[0]!.message).toContain("Grass Valley");
  });

  it("leaves genuine gaps alone", () => {
    // Reviews are not an intake field, so they can never count as "filled".
    expect(fieldsForPlaceholder("[PLACEHOLDER: real Google review]")).toEqual([
      "page.reviews",
    ]);
    for (const gap of [
      "[PLACEHOLDER: crew photo]",
      "[PLACEHOLDER: what happens when you call]",
    ]) {
      expect(fieldsForPlaceholder(gap), gap).toEqual([]);
    }
  });

  it("does not take an email address for a street address, or service areas for the city", () => {
    expect(fieldsForPlaceholder("[PLACEHOLDER: email address]")).toEqual(["business.email"]);
    expect(fieldsForPlaceholder("[PLACEHOLDER: service area cities]")).toEqual([
      "serviceAreas.cities",
    ]);
  });
});

describe("needs intake info", () => {
  it("names a required field that is empty and still a placeholder", () => {
    const intake = parseIntake({ business: { name: "Example Well & Pump" } });
    const needs = requiredFieldsStillMissing(
      "<p>Call [PLACEHOLDER: phone number]. License [PLACEHOLDER: license number].</p>",
      listIntakeFacts(intake, []),
    );
    expect(needs.map((n) => n.label)).toEqual(["Phone number", "License numbers"]);
  });

  it("ignores optional fields and genuine gaps", () => {
    const needs = requiredFieldsStillMissing(
      "<p>[PLACEHOLDER: email address] [PLACEHOLDER: real Google review]</p>",
      listIntakeFacts(emptyIntake(), []),
    );
    expect(needs).toEqual([]);
  });

  it("does not list a required field the intake has; that is a failed check instead", () => {
    const needs = requiredFieldsStillMissing(
      "<p>[PLACEHOLDER: phone number]</p>",
      listIntakeFacts(FULL, FILES),
    );
    expect(needs).toEqual([]);
  });
});

describe("the client's images", () => {
  const assets: PageAsset[] = [
    { token: logoToken(), kind: "logo", caption: null, fileName: "download-4.webp", width: 600, height: 200 },
    {
      token: photoToken(0),
      kind: "photo",
      caption: "two founders receiving an award",
      fileName: "award.jpg",
      width: 1600,
      height: 1067,
    },
  ];

  it("numbers photos from 1", () => {
    expect(photoToken(0)).toBe("tawd-asset:photo-1");
  });

  it("swaps every token for its image, in img tags and in CSS", () => {
    const html = `<img src="tawd-asset:logo" alt="Logo"><div style="background-image:url('tawd-asset:photo-1')"></div>`;
    const out = embedAssets(html, {
      "tawd-asset:logo": "data:image/png;base64,AAA",
      "tawd-asset:photo-1": "data:image/jpeg;base64,BBB",
    });
    expect(out).toContain('src="data:image/png;base64,AAA"');
    expect(out).toContain("url('data:image/jpeg;base64,BBB')");
    expect(assetTokensUsed(out)).toEqual([]);
  });

  it("fails a page that shows the logo's file name instead of the logo", () => {
    const issues = checkAssets(
      `<div class="frame">download-4.webp</div><img src="tawd-asset:photo-1" alt="Award">`,
      assets,
    );
    expect(issues.map((i) => i.id)).toEqual(["images.logo.unused"]);
  });

  it("fails a page that uses none of the uploaded photos", () => {
    const issues = checkAssets(
      `<img src="tawd-asset:logo" alt="Logo"><div>two founders receiving an award</div>`,
      assets,
    );
    expect(issues.map((i) => i.id)).toEqual(["images.photos.unused"]);
  });

  it("fails a token that matches no upload", () => {
    const issues = checkAssets(
      `<img src="tawd-asset:logo" alt=""><img src="tawd-asset:photo-1" alt=""><img src="tawd-asset:photo-9" alt="">`,
      assets,
    );
    expect(issues.map((i) => i.id)).toEqual(["images.unknownAsset"]);
  });

  it("passes a page that uses the logo and a photo", () => {
    expect(
      checkAssets(`<img src="tawd-asset:logo" alt=""><img src="tawd-asset:photo-1" alt="">`, assets),
    ).toEqual([]);
  });

  it("tells the model each image's token, caption and shape, and no longer says frames for everything", () => {
    const prompt = buildConceptUserPrompt({
      brief: { skillId: "impeccable", direction: "rugged_craftsman", conceptLabel: "A" },
      project: { clientName: "Dale Rowan", trade: "home_services", tier: "starter" },
      intake: FULL,
      assets,
      facts: listIntakeFacts(FULL, FILES),
    });
    expect(prompt).toContain("tawd-asset:logo - the client's logo");
    expect(prompt).toContain('tawd-asset:photo-1 - photo, captioned by the team: "two founders receiving an award" (1600 x 1067, landscape)');
    // The bytes never go to the model.
    expect(prompt).not.toContain("base64");

    const system = buildSharedSystemPrompt("profile");
    expect(system).toContain("Only when the client has no photos at all, or none fits");
    expect(system).toContain("never an empty image box");
    expect(system).toContain("Never write an image's file name or caption");
  });
});

describe("what a concept cost", () => {
  it("is the newest version's running total, not the sum of versions", () => {
    const spend = conceptSpend([
      { version: 1, inputTokens: 10_000, outputTokens: 30_000 },
      { version: 2, inputTokens: 45_000, outputTokens: 58_000, cacheReadTokens: 9_000 },
    ]);
    expect(spend).toEqual({
      inputTokens: 45_000,
      outputTokens: 58_000,
      cacheReadTokens: 9_000,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
    });
  });

  it("does not depend on the order the rows arrive in", () => {
    const a = { version: 1, inputTokens: 1, outputTokens: 1 };
    const b = { version: 2, inputTokens: 5, outputTokens: 5 };
    expect(conceptSpend([b, a])).toEqual(conceptSpend([a, b]));
  });

  it("is nothing for a concept with no versions", () => {
    expect(conceptSpend([]).outputTokens).toBe(0);
  });
});

/*
  The placeholder rule (2026-09-24, after the second real run):
  required and empty - a placeholder; important and empty - one placeholder,
  once; small details - left out; and with every required field filled, no
  more than five placeholders in all.
*/
describe("the placeholder rule", () => {
  // Every required field filled, nothing optional: the case the budget is for.
  const REQUIRED_ONLY = parseIntake({
    business: {
      name: "Example Well & Pump",
      phone: "(530) 555-0199",
      streetAddress: "14 Mill Road",
      googleBusinessProfileUrl: "https://maps.google.com/?cid=12345",
      licenseNumbers: ["C57-998877"],
      yearFounded: 1987,
    },
    services: { items: [{ id: "s1", name: "Well drilling", description: "" }] },
    serviceAreas: { cities: ["Grass Valley"] },
  });
  const factsFor = (intake = REQUIRED_ONLY, files = [{ kind: "logo" }]) =>
    listIntakeFacts(intake, files);

  const ruleIssues = (body: string, facts = factsFor()) =>
    checkPlaceholderRule(`<p>${body}</p>`, facts);

  // Jason, 8 October 2026: optional fields left blank get no placeholder; no reviews, no reviews section.
  it.each(["[PLACEHOLDER: Google reviews]", "[PLACEHOLDER: how scheduling works]", "[PLACEHOLDER: how quoting works]"])(
    "fails %s (optional) and says to leave it out",
    (placeholder) => {
      const issues = ruleIssues(placeholder);
      expect(issues.map((i) => i.id)).toEqual(["placeholders.detail"]);
      expect(issues[0]!.message).toContain("leave that element out entirely");
    },
  );

  it("fails reviews as three cards once, naming each", () => {
    const issues = ruleIssues("[PLACEHOLDER: real Google review] [PLACEHOLDER: real Google review] [PLACEHOLDER: customer reviews]");
    expect(issues.map((i) => i.id)).toEqual(["placeholders.detail"]);
    expect(issues[0]!.message).toContain("[PLACEHOLDER: real Google review], [PLACEHOLDER: customer reviews]");
  });

  it("fails a placeholder for something the intake never asks, and says to leave it out", () => {
    const issues = ruleIssues("[PLACEHOLDER: how often service visits happen]");
    expect(issues.map((i) => i.id)).toEqual(["placeholders.notRequired"]);
    expect(issues[0]!.message).toContain("Only an empty required field gets a placeholder");
  });

  it("leaves a picture's frame to the photo plan", () => {
    expect(ruleIssues("[PLACEHOLDER: photo of the rig] [PLACEHOLDER: a picture of a finished well]")).toEqual([]);
  });

  // Jason, 1 October 2026: no hours or service areas in the intake, none on the page, not even a placeholder.
  it.each(["[PLACEHOLDER: opening hours]", "[PLACEHOLDER: service areas]"])("fails %s when the intake has none, and says to leave it out", (placeholder) => {
    const sparse = parseIntake({ business: { name: "Example Well & Pump" } });
    const issues = ruleIssues(placeholder, factsFor(sparse, []));
    expect(issues.map((i) => i.id)).toEqual(["placeholders.detail"]);
  });

  it.each([
    "[PLACEHOLDER: current offer]",
    "[PLACEHOLDER: guarantee details]",
    "[PLACEHOLDER: financing options]",
    "[PLACEHOLDER: callback times]",
    "[PLACEHOLDER: certifications]",
    "[PLACEHOLDER: founders' names]",
    "[PLACEHOLDER: company history]",
  ])("fails a placeholder for a small detail, %s, and says to leave it out", (placeholder) => {
    const issues = ruleIssues(placeholder);
    expect(issues.map((i) => i.id)).toEqual(["placeholders.detail"]);
    expect(issues[0]!.message).toContain("leave that element out entirely");
  });

  it("keeps placeholders for empty required fields, as many as the page needs", () => {
    const sparse = parseIntake({ business: { name: "Example Well & Pump" } });
    const issues = ruleIssues(
      [
        "[PLACEHOLDER: phone number]",
        "[PLACEHOLDER: phone number]",
        "[PLACEHOLDER: license number]",
        "[PLACEHOLDER: year founded]",
        "[PLACEHOLDER: street address]",
      ].join(" "),
      factsFor(sparse, []),
    );
    expect(issues).toEqual([]);
  });

  it("is part of the ordinary checks, so it fails the concept", () => {
    const outcome = runHtmlChecks(
      page("<h1>Wells</h1><p>[PLACEHOLDER: current offer]</p>"),
      { ...checkFacts(REQUIRED_ONLY, [{ kind: "logo" }]) },
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.issues.map((i) => i.id)).toContain("placeholders.detail");
  });

  it("tells the model which group each missing fact is in", () => {
    const prompt = buildConceptUserPrompt({
      brief: { skillId: "impeccable", direction: "rugged_craftsman", conceptLabel: "A" },
      project: { clientName: "Dale Rowan", trade: "well_and_pump", tier: "starter" },
      intake: REQUIRED_ONLY,
      assets: [],
      facts: factsFor(),
    });
    expect(prompt).not.toContain("**Important, but missing.**");
    const detail = prompt.split("**Optional, and missing.**")[1]!.split("# The client's images")[0]!;

    // Every optional field, reviews, scheduling and pricing included, is left out (8 October 2026).
    for (const line of ["- Google rating and reviews", "- Opening hours", "- How scheduling works", "- Quoting and pricing", "- Current offers", "- Founders' or staff names"]) expect(detail).toContain(line);
    expect(detail).toContain("Leave the element out entirely");
    expect(detail).toContain("With no reviews, the page has no reviews section");
    expect(prompt).toContain("These are the only placeholders the page may have");
    expect(prompt).not.toContain("placeholders or fewer");
  });
});

describe("the fix rounds", () => {
  it("allows two", () => {
    expect(MAX_FIX_ROUNDS).toBe(2);
  });

  it("hands each round the exact failing items with their targets", () => {
    const text = buildSectionFixPrompt({
      clientName: "ABC Plumbers",
      directionLabel: "Classic Trust",
      sections: [{ index: 0, html: "<header>ABC</header>" }],
      issues: [
        { message: "The title is 81 characters; it must be 60 or fewer." },
        { message: "The page has 7 placeholders besides empty required fields; it must have 5 or fewer." },
      ],
      factsKnown: "",
      round: 2,
      totalRounds: 2,
    });
    expect(text).toContain("fix round 2 of 2");
    expect(text).toContain("1. The title is 81 characters; it must be 60 or fewer.");
    expect(text).toContain("2. The page has 7 placeholders");
  });

  it("fails a long title with the target, so a round fixes it", () => {
    const long = "A".repeat(81);
    const outcome = runHtmlChecks(
      `<html><head><title>${long}</title></head><body><h1>x</h1></body></html>`,
      checkFacts(),
    );
    const title = outcome.issues.find((i) => i.id === "seo.title.long");
    expect(title?.severity).toBe("fail");
    expect(title?.message).toBe("The title is 81 characters; it must be 60 or fewer.");
  });
});
