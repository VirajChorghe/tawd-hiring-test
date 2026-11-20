/*
  Run notes: what TAWD's own code changed (9 November 2026).

  Approved as stage 1 of docs/plans/self-check.md. Fifteen steps pass work
  down a chain, and until now each one trusted the step before it and told
  the step after it nothing. The cost of that was not theoretical: code
  quietly overruled the model (every unresolved icon word became a house,
  the contrast fixer injected a shade of a colour that was already wrong,
  the stock picker handed two concepts the same photograph), and then the
  Creative Director reviewed the result and wrote fixes the model could not
  make. The score did not move, every round of that review was paid for,
  and it read as the AI failing.

  So any step that changes or substitutes something by code says so, in one
  small typed note. The notes are stored on the version, shown to the team
  as "What TAWD did to this page", and handed to the Creative Director with
  a line telling it these were not the builder's choices.

  Notes are evidence, not decoration: the icon notes are how we learn which
  words TAWD's icon set is actually missing, from real runs instead of from
  anybody's guess.
*/

/*
  What a step did. "substituted" is the one that matters most — code put
  something other than what was asked for — and is the one the Creative
  Director is told never to blame the builder for.
*/
export type RunNoteAction = "substituted" | "left out" | "changed" | "chose";

export interface RunNote {
  /** The step that did it, in the team's words: "icons", "contrast", "stock", "photos". */
  step: string;
  action: RunNoteAction;
  /** What it was about: the word, the element, the frame. */
  what: string;
  /** What went in instead, when something did. */
  with?: string;
  /** Why, in a few words a person can act on. */
  why: string;
}

/* Long enough for every distinct substitution on a page, short enough to never crowd a prompt. */
export const RUN_NOTES_KEPT = 40;
const FIELD = 120;

const cut = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, FIELD);

/** A note with its fields tidied; `what` or `why` empty means there is nothing to report. */
export function runNote(note: RunNote): RunNote | null {
  const what = cut(note.what);
  const why = cut(note.why);
  if (!what || !why) return null;
  const withIt = note.with ? cut(note.with) : undefined;
  return { step: cut(note.step), action: note.action, what, why, ...(withIt ? { with: withIt } : {}) };
}

/** A note and how many times the same thing happened on the page. */
export interface CountedRunNote extends RunNote {
  times: number;
}

/*
  Every list of notes from a run, in one list: identical notes counted
  rather than repeated (one page can name the same unknown word in three
  bands), and capped. The order steps reported in is kept, because it is
  the order the work happened in.
*/
export function mergeRunNotes(...lists: (RunNote[] | null | undefined)[]): CountedRunNote[] {
  const seen = new Map<string, CountedRunNote>();
  for (const list of lists) {
    for (const raw of list ?? []) {
      const note = runNote(raw);
      if (!note) continue;
      const key = `${note.step}|${note.action}|${note.what}|${note.with ?? ""}|${note.why}`;
      const already = seen.get(key);
      if (already) already.times += 1;
      else if (seen.size < RUN_NOTES_KEPT) seen.set(key, { ...note, times: 1 });
    }
  }
  return [...seen.values()];
}

/*
  The notes stored on a version, read back from its `checks` jsonb. Anything
  that isn't a note is dropped rather than trusted: old versions were stored
  before run notes existed, and the column is free-form.
*/
export function readRunNotes(checks: unknown): CountedRunNote[] {
  const raw = (checks as { runNotes?: unknown } | null | undefined)?.runNotes;
  if (!Array.isArray(raw)) return [];
  const notes: CountedRunNote[] = [];
  for (const item of raw) {
    const note = item as Partial<CountedRunNote>;
    if (typeof note?.step !== "string" || typeof note?.what !== "string" || typeof note?.why !== "string") continue;
    if (note.action !== "substituted" && note.action !== "left out" && note.action !== "changed" && note.action !== "chose") continue;
    const tidied = runNote(note as RunNote);
    if (tidied) notes.push({ ...tidied, times: typeof note.times === "number" && note.times > 1 ? Math.floor(note.times) : 1 });
    if (notes.length >= RUN_NOTES_KEPT) break;
  }
  return notes;
}

const SAID: Record<RunNoteAction, string> = {
  substituted: "used",
  "left out": "left out",
  changed: "changed",
  chose: "chose",
};

/** One note as a sentence: what the step did, to what, and why. */
export function describeRunNote(note: CountedRunNote | RunNote): string {
  const times = "times" in note && note.times > 1 ? ` (${note.times} times)` : "";
  const withIt = note.with ? ` ${note.with} for` : "";
  return `${note.step}: ${SAID[note.action]}${withIt} ${note.what}${times} — ${note.why}.`;
}

export function describeRunNotes(notes: (CountedRunNote | RunNote)[]): string[] {
  return notes.map(describeRunNote);
}

/*
  The block given to the Creative Director. The instruction is the point of
  the whole mechanism: without it the review spends itself writing fixes
  for things no model can change, and the concept's score cannot move.
*/
export function runNotesForReviewer(notes: (CountedRunNote | RunNote)[]): string {
  if (notes.length === 0) return "";
  return `What TAWD's own code did to this page after the builder wrote it:
${describeRunNotes(notes)
  .map((line) => `- ${line}`)
  .join("\n")}

These were done by code, not by the builder. Never write a note asking for one of them to be changed — the builder cannot undo them. Where one of them is the problem, say so plainly in the note's text so a person reads it, and score what a visitor actually sees.`;
}
