import { describe, expect, it } from "vitest";

import { describeAiFailure } from "@/lib/ai-failure";

/* Why an AI step stopped, in words the team can act on. */

describe("describing an AI failure", () => {
  it("says plainly when Anthropic's spending limit or credit ran out", () => {
    const raw = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';
    const failure = describeAiFailure(raw)!;
    expect(failure.kind).toBe("anthropic_limit");
    expect(failure.headline).toMatch(/spending limit or credit balance was reached/);
    expect(failure.detail).toBe("Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.");

    expect(describeAiFailure("400 You have reached your specified API usage limits.")!.kind).toBe("anthropic_limit");
  });

  it("recognizes a busy API, a bad key and a missing model", () => {
    expect(describeAiFailure('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')!.kind).toBe("anthropic_busy");
    expect(describeAiFailure('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}')!.kind).toBe("anthropic_auth");
    expect(describeAiFailure('404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-x"}}')!.kind).toBe("model");
  });

  it("shows anything else exactly as stored, and nothing for no reason", () => {
    const failure = describeAiFailure("The review could not be used: The answer was not valid JSON.")!;
    expect(failure).toMatchObject({ kind: "other", headline: "The review could not be used: The answer was not valid JSON." });
    expect(describeAiFailure(null)).toBeNull();
    expect(describeAiFailure("  ")).toBeNull();
  });
});
