import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

import { PaidCallError, complete } from "./claude";
import type { WorkerConfig } from "./config";

/*
  Out of room is never a finished page (9 November 2026, after the Easy
  Rooter run). Until this, a reply that hit the output ceiling was returned
  as a success whenever it had written anything at all, so a page cut off
  mid-document — unclosed tags, every band after them swallowed by the last
  open element — was stored as the concept and shown to the team.
*/

function clientReturning(stopReason: string, text: string): Anthropic {
  return {
    messages: {
      stream: vi.fn(() => ({
        finalMessage: async () => ({
          stop_reason: stopReason,
          content: text ? [{ type: "text", text, citations: null }] : [],
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
      })),
    },
  } as unknown as Anthropic;
}

const config = { model: "claude-opus-5-5", effort: "medium" } as unknown as WorkerConfig;

const input = (client: Anthropic) => ({
  client,
  config,
  skillId: "ui-ux-pro-max" as never,
  system: [{ type: "text" as const, text: "system" }],
  messages: [{ role: "user" as const, content: "build the page" }],
  edit: true,
});

describe("a reply that ran out of room", () => {
  it("refuses a half-written page instead of returning it", async () => {
    const half = `<!doctype html><html><head><title>t</title></head><body><header>…</header><section><h1>24/7 Emergency Plumbing</h1>`;
    await expect(complete(input(clientReturning("max_tokens", half)))).rejects.toThrow(PaidCallError);
    await expect(complete(input(clientReturning("max_tokens", half)))).rejects.toThrow(/ran out of room part-way/);
  });

  it("says how much was written, so the reason is obvious in the log", async () => {
    const error = await complete(input(clientReturning("max_tokens", "x".repeat(1234)))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaidCallError);
    expect((error as Error).message).toContain("1,234 characters");
    expect((error as Error).message).toContain("No page was saved");
  });

  it("still refuses a reply that wrote nothing at all", async () => {
    await expect(complete(input(clientReturning("max_tokens", "")))).rejects.toThrow(/before writing anything/);
  });

  it("returns a reply that finished normally", async () => {
    const whole = `<!doctype html><html><body><section>all of it</section></body></html>`;
    const result = await complete(input(clientReturning("end_turn", whole)));
    expect(result.text).toBe(whole);
  });

  it("keeps what the call cost on the error, so the spend is still recorded", async () => {
    const error = (await complete(input(clientReturning("max_tokens", "half a page"))).catch((e: unknown) => e)) as PaidCallError;
    expect(error.usage.inputTokens).toBe(10);
    expect(error.usage.outputTokens).toBe(20);
  });
});
