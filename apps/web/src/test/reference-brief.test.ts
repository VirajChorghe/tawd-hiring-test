import { describe, expect, it } from "vitest";

import { BRIEF_LIMITS, ReferenceBriefError, buildReferenceStudySystemPrompt, readReferenceBrief } from "@tawd/core/mockups";

/*
  The reference brief (9 November 2026).

  All three of Clear Sky Awning's reference sites failed, twice each, with
  "The reply didn't have the brief's fields." The prompt never stated a
  length limit, so the model had no way to know it had broken one, and the
  error sent back named neither the field nor the rule — so the retry made
  the same mistake and the run paid for six calls and kept nothing.
*/

const whole = {
  sectionOrder: ["hero with photo and two calls to action", "trust bar", "services grid"],
  heroPattern: "Full-width photo behind a left-aligned headline, phone top right.",
  trustElements: ["licence and insurance badges", "review stars near the top"],
  serviceLayout: "Three cards with photos and short descriptions.",
  craftNotes: ["Generous spacing", "One accent colour"],
  closestDirection: null,
};

const reply = (value: unknown) => `Here is the brief:\n${JSON.stringify(value)}`;

describe("a brief that runs long", () => {
  it("trims instead of rejecting: a long note is a usable brief", () => {
    const brief = readReferenceBrief(reply({ ...whole, craftNotes: ["x".repeat(500)] }));
    expect(brief.craftNotes[0]).toHaveLength(BRIEF_LIMITS.note);
  });

  it("trims the hero and the services layout the same way", () => {
    const brief = readReferenceBrief(reply({ ...whole, heroPattern: "y".repeat(900), serviceLayout: "z".repeat(900) }));
    expect(brief.heroPattern).toHaveLength(BRIEF_LIMITS.hero);
    expect(brief.serviceLayout).toHaveLength(BRIEF_LIMITS.services);
  });

  it("keeps only as many bands and notes as the brief holds", () => {
    const brief = readReferenceBrief(reply({ ...whole, sectionOrder: Array(40).fill("a band"), craftNotes: Array(40).fill("a note") }));
    expect(brief.sectionOrder).toHaveLength(BRIEF_LIMITS.sections);
    expect(brief.craftNotes).toHaveLength(BRIEF_LIMITS.notes);
  });
});

describe("a brief that can't be used", () => {
  it("names the field that is missing, so the retry can fix it", () => {
    const withoutHero: Record<string, unknown> = { ...whole };
    delete withoutHero.heroPattern;
    expect(() => readReferenceBrief(reply(withoutHero))).toThrow(ReferenceBriefError);
    expect(() => readReferenceBrief(reply(withoutHero))).toThrow(/"heroPattern" is missing/);
  });

  it("names a field of the wrong kind", () => {
    expect(() => readReferenceBrief(reply({ ...whole, trustElements: "badges" }))).toThrow(/"trustElements"/);
  });

  it("refuses a reply shaped right but empty", () => {
    expect(() => readReferenceBrief(reply({ ...whole, heroPattern: "  ", sectionOrder: [] }))).toThrow(/said nothing/);
  });

  it("still refuses a reply with no JSON at all", () => {
    expect(() => readReferenceBrief("I had trouble reading that site.")).toThrow(/no JSON object/);
  });
});

describe("a brief that is fine", () => {
  it("reads every field", () => {
    const brief = readReferenceBrief(reply(whole));
    expect(brief.sectionOrder).toHaveLength(3);
    expect(brief.heroPattern).toContain("Full-width photo");
    expect(brief.trustElements).toHaveLength(2);
    expect(brief.closestDirection).toBeNull();
  });

  it("keeps a direction it knows and drops one it doesn't", () => {
    expect(readReferenceBrief(reply({ ...whole, closestDirection: "not-a-direction" })).closestDirection).toBeNull();
  });

  it("reads a brief that left closestDirection out rather than paying for it twice", () => {
    const withoutIt: Record<string, unknown> = { ...whole };
    delete withoutIt.closestDirection;
    expect(readReferenceBrief(reply(withoutIt)).closestDirection).toBeNull();
  });
});

describe("the prompt", () => {
  it("tells the model the limits it is held to", () => {
    const prompt = buildReferenceStudySystemPrompt();
    expect(prompt).toContain(`${BRIEF_LIMITS.note}`);
    expect(prompt).toContain(`${BRIEF_LIMITS.hero}`);
    expect(prompt).toContain("Anything longer is cut");
    expect(prompt).toContain("Every field must be there");
  });
});
