import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

import { eachAtOnce } from "./at-once";
import { addUsage, callMs, emptyUsage } from "./claude";
import { usageOf } from "./review";
import { isReplaying, noteStep, replayingClient, replayServed, ReplayMissError, runWithReplay } from "./replay";

/*
  Replay (Jason, 28 September 2026): a job re-run on the saved AI answers of
  an earlier run, for $0. Calls are answered from the saved turns, step by
  step, in the order first given; nothing reaches Anthropic; a call with no
  saved answer ends the job instead of paying.
*/

const text = (t: string) => ({ stopReason: "end_turn", content: [{ type: "text", text: t, citations: null }] as unknown as Anthropic.ContentBlock[] });

function fakeClient() {
  const stream = vi.fn(() => ({ finalMessage: async () => ({ content: [{ type: "text", text: "paid" }] }) }));
  return { client: { messages: { stream }, models: { retrieve: vi.fn() } } as unknown as Anthropic, stream };
}

describe("replay", () => {
  it("answers each step's calls from its saved turns in order, and sends nothing", async () => {
    const { client, stream } = fakeClient();
    const wrapped = replayingClient(client);
    const turns = new Map([
      ["faithful_copy", [text("section 1"), text("section 2")]],
      ["faithful_check", [text("looks right")]],
    ]);
    const said: string[] = [];
    await runWithReplay(turns, async () => {
      expect(isReplaying()).toBe(true);
      for (const step of ["faithful_copy", "faithful_check", "faithful_copy_retry"]) {
        noteStep(step);
        const m = await wrapped.messages.stream({ model: "claude-sonnet-5", max_tokens: 10, messages: [] }).finalMessage();
        said.push((m.content[0] as Anthropic.TextBlock).text);
        expect(m.usage.input_tokens).toBe(0);
      }
      expect(replayServed()).toBe(3);
    });
    // A rebuild (faithful_copy_retry) is answered from the saved faithful_copy answers.
    expect(said).toEqual(["section 1", "looks right", "section 2"]);
    expect(stream).not.toHaveBeenCalled();
    expect(isReplaying()).toBe(false);
  });

  it("ends the job when there's no saved answer, and outside a replay the real client is used", async () => {
    const { client, stream } = fakeClient();
    const wrapped = replayingClient(client);
    await runWithReplay(new Map(), async () => {
      noteStep("design_read");
      expect(() => wrapped.messages.stream({ model: "m", max_tokens: 1, messages: [] })).toThrow(ReplayMissError);
    });
    await wrapped.messages.stream({ model: "m", max_tokens: 1, messages: [] }).finalMessage();
    expect(stream).toHaveBeenCalledTimes(1);
    await runWithReplay(null, async () => expect(isReplaying()).toBe(false));
  });

  it("times a real call, and the time reaches the usage the ledger records", async () => {
    vi.useFakeTimers();
    try {
      const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const stream = vi.fn(() => ({
        finalMessage: async () => {
          await vi.advanceTimersByTimeAsync(2_500);
          return { content: [], usage: { ...usage } };
        },
      }));
      const wrapped = replayingClient({ messages: { stream } } as unknown as Anthropic);
      const message = await wrapped.messages.stream({ model: "m", max_tokens: 1, messages: [] }).finalMessage();
      expect(callMs(message.usage)).toBe(2_500);
      expect(usageOf(message.usage)).toMatchObject({ inputTokens: 10, outputTokens: 20, ms: 2_500 });
      // A multi-turn call adds its turns' times up.
      const total = emptyUsage();
      addUsage(total, message.usage);
      addUsage(total, message.usage);
      expect(total.ms).toBe(5_000);
      // An answer the client didn't time (a replay, a test fake) has no time, not zero.
      expect(usageOf(usage as Anthropic.Usage).ms).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs work one at a time in a replay, so answers come back in their saved order", async () => {
    let inFlight = 0, most = 0;
    const work = async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    };
    await runWithReplay(new Map(), () => eachAtOnce([1, 2, 3, 4], 4, work));
    expect(most).toBe(1);
    most = 0;
    await eachAtOnce([1, 2, 3, 4], 4, work);
    expect(most).toBe(4);
  });
});
