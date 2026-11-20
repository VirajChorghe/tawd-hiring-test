import crypto from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";

import { getDb } from "@tawd/core/db";
import { getStorage } from "@tawd/core/intake/storage";
import { reusableDesignAnswers, type SavedDesignAnswer } from "@tawd/core/saved-answers";

import type { RawTurn } from "./claude";

/* A question's fingerprint: the system prompt and the prompt, pictures included, as sent. */
export function requestHash(system: Anthropic.TextBlockParam[], prompt: string | Anthropic.ContentBlockParam[]): string {
  const strip = (blocks: Anthropic.TextBlockParam[]) => blocks.map((b) => b.text);
  return crypto.createHash("sha256").update(JSON.stringify({ system: strip(system), prompt })).digest("hex");
}

/*
  The answers a build may reuse for $0 (see @tawd/core/saved-answers): each
  one is used at most once, for the same step and page, and, when it was
  saved with a fingerprint, only for the very same question.
*/
export class ReusePool {
  private readonly left: SavedDesignAnswer[];
  used = 0;

  constructor(answers: SavedDesignAnswer[]) {
    this.left = [...answers];
  }

  static async load(projectId: string, buildId: string): Promise<ReusePool> {
    return new ReusePool(await reusableDesignAnswers(getDb(), getStorage(), projectId, buildId));
  }

  take(step: string, label: string, hash: string): RawTurn | null {
    const index = this.left.findIndex((a) => a.step === step && a.label === label && (a.hash === null || a.hash === hash));
    if (index < 0) return null;
    const [answer] = this.left.splice(index, 1);
    this.used += 1;
    return answer!.turns[answer!.turns.length - 1] as unknown as RawTurn;
  }
}
