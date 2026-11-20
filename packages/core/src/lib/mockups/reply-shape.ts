import type { z } from "zod";

/*
  Saying why a reply couldn't be used (9 November 2026).

  Three steps had the same fault on the same day: the reference study
  ("The reply didn't have the brief's fields"), the critique ("The reply
  didn't list the fixes") and the brief's own retry. Each held the model
  to a shape with hard character limits, none of which the prompt ever
  stated; when a reply broke one, the error named neither the field nor
  the rule, and the retry — which is sent that same sentence — made the
  same mistake at full price. New Dawn Awning's three reference sites each
  failed twice that way, and Sample Marketing Co.'s whole polish pass was lost.

  Two rules come out of it, and both live here:

  1. Say which field and why, in words the model can act on.
  2. Trim what is merely too long. An over-long craft note is a usable
     brief; a missing one is not. Only a reply that is the wrong shape,
     or that says nothing at all, is worth refusing and paying again for.
*/

/** Zod's complaint as a sentence the model can act on: which field, and what was wrong with it. */
export function describeZodIssues(error: z.ZodError, limit = 4): string {
  return error.issues
    .slice(0, limit)
    .map((issue) => {
      const field = issue.path.length ? issue.path.join(".") : "the object";
      const message = issue.message.toLowerCase();
      // Zod words a missing field as "expected string, received undefined"; the model needs the plainer version.
      return message.includes("received undefined") ? `"${field}" is missing` : `"${field}" ${message}`;
    })
    .join("; ");
}

/** One line of text, trimmed of its edges and cut to a length. */
export function trimTo(text: string, limit: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}
