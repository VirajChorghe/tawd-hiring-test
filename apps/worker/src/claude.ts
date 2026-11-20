import Anthropic from "@anthropic-ai/sdk";

import type { SkillId } from "@tawd/core/mockups";
import type { WorkerConfig } from "./config";
import { readSkillFile, runSkillSearch } from "./skills";
import { stubClient } from "./stub-claude";
import { requestSettings, withRollingCache } from "@tawd/core/mockups";

/*
  Talking to Claude.

  Streaming, because a homepage is a long answer and a non-streaming request
  that size risks an HTTP timeout. A manual tool loop rather than the SDK's
  runner, because the two tools are small and owning the loop keeps the
  token accounting and the logging in one readable place.

  The two tools can only read. See skills.ts.
*/

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** One-hour cache writes, charged at twice the input price. */
  cacheWrite1hTokens: number;
  /** How long the call took, when the client timed it (see replay.ts). */
  ms?: number;
}

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
  };
}

export function addUsage(into: Usage, from: Anthropic.Usage): void {
  into.inputTokens += from.input_tokens ?? 0;
  into.outputTokens += from.output_tokens ?? 0;
  into.cacheReadTokens += from.cache_read_input_tokens ?? 0;
  // The API splits writes by how long they are kept; the one-hour ones cost more.
  const oneHour = (from as { cache_creation?: { ephemeral_1h_input_tokens?: number } }).cache_creation?.ephemeral_1h_input_tokens ?? 0;
  into.cacheWriteTokens += (from.cache_creation_input_tokens ?? 0) - oneHour;
  into.cacheWrite1hTokens += oneHour;
  const ms = callMs(from);
  if (ms !== undefined) into.ms = (into.ms ?? 0) + ms;
}

/* The time the client stamped on an answer's usage (replay.ts), if any. */
export function callMs(usage: Anthropic.Usage): number | undefined {
  const ms = (usage as { tawd_ms?: unknown }).tawd_ms;
  return typeof ms === "number" ? ms : undefined;
}

export function createClient(_config: WorkerConfig): Anthropic {
  // HIRING-TEST COPY: always the canned stand-in, with no switch to turn it off. The real client is never built, so no call can leave this machine.
  return stubClient();
}

/*
  Checks the configured model actually exists before any work is queued.

  A wrong model name is otherwise a 400 on every concept, several minutes
  into a run, with a message nobody reads. This turns it into one clear line
  at startup naming the environment variable to change.
*/
export async function verifyModel(
  client: Anthropic,
  model: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await client.models.retrieve(model);
    return { ok: true };
  } catch (error) {
    if (error instanceof Anthropic.NotFoundError) {
      let available = "";
      try {
        const list = await client.models.list();
        available = list.data
          .map((m) => m.id)
          .slice(0, 12)
          .join(", ");
      } catch {
        // The list is a nicety; the important part is the name that failed.
      }
      return {
        ok: false,
        message:
          `The model "${model}" does not exist for this API key.\n` +
          `Set ANTHROPIC_MODEL in Coolify to one that does.` +
          (available ? `\nAvailable: ${available}` : ""),
      };
    }
    if (error instanceof Anthropic.AuthenticationError) {
      return {
        ok: false,
        message: "ANTHROPIC_API_KEY was rejected. Check the key in Coolify.",
      };
    }
    // A network wobble should not stop the worker booting.
    return { ok: true };
  }
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "read_skill_file",
    description:
      "Read a file from your design skill's own folder, such as one of its reference pages. Paths are relative to the skill folder, for example 'reference/craft-floor.md'. This tool can only read; nothing in a skill can be changed.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path relative to the skill folder.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "run_skill_search",
    description:
      "Search the UI UX Pro Max design database for a matching landing-page pattern, style, palette, font pairing or UX rules. Only useful when your skill is UI UX Pro Max.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for." },
        domain: {
          type: "string",
          description:
            "Optional: narrow to one domain, such as 'typography' or 'color'.",
        },
        variance: {
          type: "number",
          description: "Optional: 5 to 7. Never above 7 for TAWD.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

export interface CompleteInput {
  client: Anthropic;
  config: WorkerConfig;
  skillId: SkillId;
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  /** Called for each tool the model runs, so steps can show progress. */
  onToolUse?: (name: string) => void;
  /*
    For small edits such as a section fix: less thinking (which is billed
    as output), no skill tools, and a smaller ceiling.
  */
  light?: boolean;
  /*
    For editing parts of a page (the improvement round, Request changes):
    the usual effort, since these are design changes, but no skill tools
    and a ceiling sized for a few bands rather than a whole page.
  */
  edit?: boolean;
  /** The step's model (27 September 2026); the configured one when not given. */
  model?: string;
}

/** One answer from the model, exactly as it came back. */
export interface RawTurn {
  stopReason: string | null;
  content: Anthropic.ContentBlock[];
}

export interface CompleteResult {
  text: string;
  usage: Usage;
  /** The full exchange, so a follow-up turn keeps its own page in context. */
  messages: Anthropic.MessageParam[];
  /** Every answer the call was paid for, to be saved before anything reads it. */
  turns: RawTurn[];
}

/*
  A call that failed after the model had answered: the answers were paid
  for, so they travel with the error to be saved and charged.
*/
export class PaidCallError extends Error {
  usage: Usage;
  turns: RawTurn[];
  constructor(message: string, usage: Usage, turns: RawTurn[]) {
    super(message);
    this.name = "PaidCallError";
    this.usage = usage;
    this.turns = turns;
  }
}

export async function complete(input: CompleteInput): Promise<CompleteResult> {
  const usage = emptyUsage();
  const messages = [...input.messages];
  const turns: RawTurn[] = [];

  // A stuck model is a cost problem, not just a slow one.
  const MAX_TURNS = 12;

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const model = input.model ?? input.config.model;
    const stream = input.client.messages.stream({
      model,
      max_tokens: input.light ? 16_000 : input.edit ? 32_000 : 64_000,
      system: input.system,
      // The end of the conversation marked each turn: the next turn reads it all from cache.
      messages: withRollingCache(messages),
      ...(input.light || input.edit ? {} : { tools: TOOLS }),
      ...requestSettings(model, { effort: input.light ? "low" : input.config.effort, adaptiveThinking: true }),
    });

    const response = await stream.finalMessage();
    addUsage(usage, response.usage);
    turns.push({ stopReason: response.stop_reason, content: response.content });

    // Thinking blocks must go back unchanged, so append the whole content.
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "refusal") {
      throw new PaidCallError(
        `The model declined to build this concept (${response.stop_details?.category ?? "no category"}).`,
        usage,
        turns,
      );
    }

    if (response.stop_reason !== "tool_use") {
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");

      /*
        Out of room is never a finished page (9 November 2026, after the
        Sample Rooter run: a page cut off mid-document has unclosed tags, the
        browser nests everything after them inside the last open element,
        and the concept renders as its hero alone). Until this, only a
        reply of length zero counted as a failure and a half-written page
        was returned as a success.
      */
      if (response.stop_reason === "max_tokens") {
        throw new PaidCallError(
          text.length === 0
            ? "The model ran out of room before writing anything."
            : `The model ran out of room part-way through the page (${text.length.toLocaleString()} characters written). No page was saved: a page cut off mid-document is broken, not unfinished. The call itself is still recorded, so the spend is not lost.`,
          usage,
          turns,
        );
      }

      return { text, usage, messages, turns };
    }

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    // All results go back in one user message, or the model learns to stop
    // asking for several things at once.
    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const use of toolUses) {
      input.onToolUse?.(use.name);
      try {
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: await runTool(input, use),
        });
      } catch (error) {
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          is_error: true,
          content: error instanceof Error ? error.message : "Tool failed.",
        });
      }
    }

    messages.push({ role: "user", content: results });
  }

  throw new PaidCallError(
    `The model was still working after ${MAX_TURNS} turns. Stopped to avoid spending more.`,
    usage,
    turns,
  );
}

async function runTool(
  input: CompleteInput,
  use: Anthropic.ToolUseBlock,
): Promise<string> {
  // Tool inputs are parsed JSON, never matched as strings.
  const args = use.input as Record<string, unknown>;

  if (use.name === "read_skill_file") {
    const relativePath = String(args.path ?? "");
    return readSkillFile(input.config.skillsDir, input.skillId, relativePath);
  }

  if (use.name === "run_skill_search") {
    return runSkillSearch(input.config.skillsDir, String(args.query ?? ""), {
      domain: args.domain === undefined ? undefined : String(args.domain),
      variance:
        typeof args.variance === "number" ? args.variance : undefined,
    });
  }

  return `There is no tool called ${use.name}.`;
}
