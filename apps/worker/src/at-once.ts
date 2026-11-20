import { isReplaying } from "./replay";

/*
  Doing work at once, with a limit (28 September 2026: parallel copying).

  AI calls only wait on the network, so several can be in flight together;
  the limit keeps a page from firing dozens of requests at Anthropic's rate
  limits at the same moment. Browser work stays one at a time elsewhere.
*/

/** Section calls in flight at once for one page (TAWD_SECTION_CALLS_AT_ONCE, default 6; 1 is the old one-after-another). */
export function sectionCallsAtOnce(): number {
  return Math.max(1, Number(process.env.TAWD_SECTION_CALLS_AT_ONCE) || 6);
}

/* Runs fn over every item, at most `limit` at a time; the first failure is thrown once all have settled. */
export async function eachAtOnce<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<unknown>): Promise<void> {
  // A replay gives the saved answers back in the order they were first given: one at a time.
  if (isReplaying()) limit = 1;
  let next = 0;
  let failure: unknown = null;
  const lane = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        await fn(items[index]!, index);
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failure) throw failure;
}
