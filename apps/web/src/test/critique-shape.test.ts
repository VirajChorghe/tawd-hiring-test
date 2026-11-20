import { describe, expect, it } from "vitest";

import { CRITIQUE_LIMITS, MAX_POLISH_FIXES, PolishCritiqueError, buildPolishCritiqueSystemPrompt, readPolishCritique } from "@tawd/core/mockups";

/*
  The critique (9 November 2026). Bold Marketing's whole polish pass was lost
  to "The critique couldn't be used: The reply didn't list the fixes" — a
  sentence naming neither the field nor the rule it broke, sent back to a
  model that had never been told the limits. The real critiques that run
  have fixes of 300 to 400 characters, so running over was a matter of
  time. Long text is trimmed now; only a reply of the wrong shape is
  refused and paid for again.
*/

const fix = (over: Partial<Record<string, unknown>> = {}) => ({
  band: 4,
  area: "spacing rhythm",
  problem: "The gap between the strip and the heading is about 210px.",
  fix: "Drop the top border and cut the strip's bottom padding to 0.",
  ...over,
});

const reply = (value: unknown) => `Here is the critique:\n${JSON.stringify(value)}`;

describe("a critique that runs long", () => {
  it("trims a long problem and change instead of throwing the pass away", () => {
    const critique = readPolishCritique(reply({ fixes: [fix({ problem: "p".repeat(900), fix: "f".repeat(900) })], summary: "" }), 10);
    expect(critique.fixes).toHaveLength(1);
    expect(critique.fixes[0]!.problem).toHaveLength(CRITIQUE_LIMITS.problem);
    expect(critique.fixes[0]!.fix).toHaveLength(CRITIQUE_LIMITS.fix);
  });

  it("trims a long area and summary", () => {
    const critique = readPolishCritique(reply({ fixes: [fix({ area: "a".repeat(200) })], summary: "s".repeat(2000) }), 10);
    expect(critique.fixes[0]!.area).toHaveLength(CRITIQUE_LIMITS.area);
    expect(critique.summary).toHaveLength(CRITIQUE_LIMITS.summary);
  });

  it("keeps no more fixes than a polish pass can apply", () => {
    const many = Array.from({ length: MAX_POLISH_FIXES + 6 }, () => fix());
    expect(readPolishCritique(reply({ fixes: many, summary: "" }), 10).fixes).toHaveLength(MAX_POLISH_FIXES);
  });

  it("reads a band the model wrote as text", () => {
    expect(readPolishCritique(reply({ fixes: [fix({ band: "4" })], summary: "" }), 10).fixes[0]!.band).toBe(4);
  });

  it("still drops a fix pointing past the end of the page", () => {
    expect(readPolishCritique(reply({ fixes: [fix({ band: 99 })], summary: "" }), 10).fixes).toEqual([]);
  });
});

describe("a critique that can't be used", () => {
  it("names the field that is missing", () => {
    const withoutChange: Record<string, unknown> = { ...fix() };
    delete withoutChange.fix;
    expect(() => readPolishCritique(reply({ fixes: [withoutChange], summary: "" }), 10)).toThrow(PolishCritiqueError);
    expect(() => readPolishCritique(reply({ fixes: [withoutChange], summary: "" }), 10)).toThrow(/is missing/);
  });

  it("names a field of the wrong kind", () => {
    expect(() => readPolishCritique(reply({ fixes: "none", summary: "" }), 10)).toThrow(/"fixes"/);
  });

  it("still refuses a reply with no JSON at all", () => {
    expect(() => readPolishCritique("The page looks fine to me.", 10)).toThrow(/no JSON object/);
  });

  it("accepts a critique with nothing to fix", () => {
    expect(readPolishCritique(reply({ fixes: [], summary: "Nothing worth changing." }), 10).fixes).toEqual([]);
  });
});

describe("the critique prompt", () => {
  it("tells the model the limits it is held to", () => {
    const prompt = buildPolishCritiqueSystemPrompt("(the method)");
    expect(prompt).toContain(`${CRITIQUE_LIMITS.problem}`);
    expect(prompt).toContain("Anything longer is cut");
    expect(prompt).toContain("Every fix needs all four fields");
  });
});
