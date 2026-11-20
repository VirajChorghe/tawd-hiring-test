/*
  Prompt caching (26 September 2026). The console showed a 17% cache hit
  rate. Three causes, three rules:

  1. A multi-turn call (a build with its skill lookups and fix rounds, a
     retry) marked only its system prompt, so every turn paid full price
     again for the whole conversation so far. Now the end of the
     conversation is marked on every turn (a rolling breakpoint), so the
     next turn reads everything before it from cache.
  2. The stable instructions (the shared rules, the reviewer's and the site
     builder's) were cached for five minutes, less than the gap between
     concepts. They now use the one-hour cache.
  3. What repeats goes first, always in the same order: the rules, then the
     project (its facts and pictures, the same for every concept in a run),
     then what differs (the skill and the brief for this concept).

  At most four breakpoints a request: the system (1), the project (1) and
  the rolling end of the conversation (1) leave one spare.

  No SDK types here, so core stays free of the Anthropic package: the
  shapes are the Messages API's own.
*/

export const CACHE_5M = { type: "ephemeral" } as const;
export const CACHE_1H = { type: "ephemeral", ttl: "1h" } as const;

type Block = { type: string; cache_control?: unknown; [key: string]: unknown };
type Message = { role: string; content: string | Block[] };

/*
  The conversation with its last block marked for caching, and any older
  rolling mark taken off. The messages given are not changed: the ones
  kept for the next turn and saved in the ledger stay as they were.
*/
export function withRollingCache<T>(given: T[]): T[] {
  const messages = given as unknown as Message[];
  return messages.map((message, index) => {
    const last = index === messages.length - 1;
    if (typeof message.content === "string") {
      return (last ? { ...message, content: [{ type: "text", text: message.content, cache_control: CACHE_5M }] } : message) as unknown as T;
    }
    const blocks = message.content.map((block, i) => {
      const isEnd = last && i === message.content.length - 1;
      // Thinking blocks can't carry a mark; nor can an empty text block.
      if (isEnd && block.type !== "thinking" && block.type !== "redacted_thinking") return { ...block, cache_control: CACHE_5M };
      // An older rolling mark comes off (a one-hour mark placed on purpose stays).
      if (block.cache_control && (block.cache_control as { ttl?: string }).ttl !== "1h") {
        const { cache_control: _dropped, ...rest } = block;
        return rest as Block;
      }
      return block;
    });
    return { ...message, content: blocks } as unknown as T;
  }) as T[];
}

/* A system prompt of stable instructions, cached for an hour. */
export function stableSystem(...texts: string[]): { type: "text"; text: string; cache_control?: typeof CACHE_1H }[] {
  return texts.map((text, i) => (i === texts.length - 1 ? { type: "text" as const, text, cache_control: CACHE_1H } : { type: "text" as const, text }));
}

/* The share of input read from cache: what Spend shows as the hit rate. */
export function cacheHitRate(usage: { inputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; cacheWrite1hTokens?: number }): number | null {
  const total = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.cacheWrite1hTokens ?? 0);
  return total > 0 ? (usage.cacheReadTokens ?? 0) / total : null;
}
