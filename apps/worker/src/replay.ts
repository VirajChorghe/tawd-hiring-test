import { AsyncLocalStorage } from "node:async_hooks";
import { asc, inArray, isNotNull, and } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";

import type { Database } from "@tawd/core/db";
import { getStorage } from "@tawd/core/intake/storage";
import { aiCall } from "@tawd/core/schema";

import type { RawTurn } from "./claude";

type MessageStream = ReturnType<Anthropic["messages"]["stream"]>;

/*
  Replay (Jason, 28 September 2026): re-run a step on the AI answers saved
  from an earlier run, for $0, so a fix is tested on a client's real data.

  A job whose data has `replay: { fromRunIds }` runs with those runs' saved
  answers: every call to Claude is answered from them, in the order they
  were first given, step by step. Nothing is sent to Anthropic, nothing is
  written to the spend ledger, and a call with no saved answer ends the job
  ("Replay: no saved answer for ...") rather than paying for one.
*/

export interface ReplayRequest {
  /** The runs whose saved answers are used (a copy's id, a concept run's id...). */
  fromRunIds: string[];
}

export class ReplayMissError extends Error {
  constructor(step: string, n: number) {
    super(`Replay: no saved answer for ${step} call ${n}; nothing was spent. Run it for real to get one.`);
    this.name = "ReplayMissError";
  }
}

interface ReplayState {
  /** Saved turns per recorded step, first answer first. */
  turns: Map<string, RawTurn[]>;
  used: Map<string, number>;
  step: string | null;
  served: number;
}

const current = new AsyncLocalStorage<ReplayState>();

/* The step a call is priced under versus the one its answer is recorded under. */
const RECORDED_AS: Record<string, string> = { faithful_copy_retry: "faithful_copy" };

export function isReplaying(): boolean {
  return current.getStore() !== undefined;
}

/** Called by stepModel before every call, so the next answer comes from the right step. */
export function noteStep(step: string): void {
  const state = current.getStore();
  if (state) state.step = RECORDED_AS[step] ?? step;
}

/** How many saved answers the replay has served so far (for its report). */
export function replayServed(): number {
  return current.getStore()?.served ?? 0;
}

/* Saved answers of the given runs, grouped by step, in the order they were given. */
export async function loadSavedTurns(db: Database, runIds: string[]): Promise<Map<string, RawTurn[]>> {
  const turns = new Map<string, RawTurn[]>();
  if (runIds.length === 0) return turns;
  const rows = await db
    .select({ step: aiCall.step, key: aiCall.responseKey })
    .from(aiCall)
    .where(and(inArray(aiCall.runId, runIds), isNotNull(aiCall.responseKey)))
    .orderBy(asc(aiCall.createdAt));
  for (const row of rows) {
    const body = await getStorage().get(row.key!);
    if (!body) continue;
    const saved = JSON.parse(body.toString("utf8")) as { turns?: RawTurn[] };
    const list = turns.get(row.step) ?? [];
    list.push(...(saved.turns ?? []));
    turns.set(row.step, list);
  }
  return turns;
}

/** Runs fn as a replay of the saved turns (or as usual when there is no replay). */
export function runWithReplay<T>(turns: Map<string, RawTurn[]> | null, fn: () => Promise<T>): Promise<T> {
  if (!turns) return fn();
  return current.run({ turns, used: new Map(), step: null, served: 0 }, fn);
}

/* The next saved turn for the step being asked, as the SDK's finished message. */
function nextMessage(state: ReplayState, model: string): Anthropic.Message {
  const step = state.step ?? "unknown";
  const list = state.turns.get(step) ?? [];
  const index = state.used.get(step) ?? 0;
  const turn = list[index];
  if (!turn) throw new ReplayMissError(step, index + 1);
  state.used.set(step, index + 1);
  state.served += 1;
  return {
    id: `replay-${step}-${index + 1}`,
    type: "message",
    role: "assistant",
    model,
    content: turn.content,
    stop_reason: turn.stopReason as Anthropic.Message["stop_reason"],
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as Anthropic.Message;
}

/*
  A real call is timed: its answer's usage carries tawd_ms, the time from
  the request to the last word, which the ledger keeps (8 October 2026).
*/
function timed(stream: MessageStream): MessageStream {
  const started = Date.now();
  const finalMessage = stream.finalMessage.bind(stream);
  stream.finalMessage = async () => {
    const message = await finalMessage();
    if (message.usage) (message.usage as { tawd_ms?: number }).tawd_ms = Date.now() - started;
    return message;
  };
  return stream;
}

/*
  The worker's one Claude client, wrapped: inside a replay, messages.stream
  answers from the saved turns; outside one, it is the real client.
*/
export function replayingClient(real: Anthropic): Anthropic {
  const messages = new Proxy(real.messages, {
    get(target, prop, receiver) {
      if (prop === "stream") {
        return (params: Anthropic.MessageStreamParams, options?: unknown) => {
          const state = current.getStore();
          if (!state) return timed((target.stream as (p: unknown, o?: unknown) => MessageStream).call(target, params, options));
          const message = nextMessage(state, params.model);
          return { finalMessage: async () => message, on: () => undefined, abort: () => undefined };
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "messages") return messages;
      return Reflect.get(target, prop, receiver);
    },
  });
}
