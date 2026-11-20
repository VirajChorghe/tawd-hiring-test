/*
  TAWD's check after a Fix these (3c, 5 October 2026): free, by code, no AI.
  The fixed page is opened from the build's own files at computer and phone
  width, and only the parts that changed are measured (worker
  `page-fix-check.ts`) for what the first real fix got wrong: a phone number,
  a button or a menu link wrapping onto a second line, something sticking
  out past the edge of the page, and a picture that doesn't load. It is
  careful: a false alarm costs a paid retry, so anything unsure is left out.

  Here: what the measuring hands back, and the plain-English lines made
  from it (where the rules can be tested without a browser).
*/

export type FixCheckWidth = "computer" | "phone";

export interface FixCheckRaw {
  /** "header", "footer" or a section's number among <main>'s parts. */
  part: string;
  kind: "wrap" | "overflow" | "image";
  /** What wrapped or stuck out. */
  what: "phone number" | "button" | "menu link" | "part" | "element" | "picture";
  /** Its words (or a picture's file name), shortened. */
  text: string;
  /** Lines it takes (wrap). */
  lines?: number;
  /** Pixels past the edge of the page (overflow). */
  by?: number;
}

export const FIX_CHECK_WIDTHS: Record<FixCheckWidth, { width: number; height: number }> = {
  computer: { width: 1280, height: 900 },
  phone: { width: 390, height: 844 },
};

/* What a fix keeps of its check (page_fix.check_findings). */
export interface PageFixCheck {
  /** The version the fix made first, and what the check found on it. */
  firstVersion: number;
  first: string[];
  /** The version the comments ended in (the retry's, when it made one), and what the check found on it. */
  finalVersion: number;
  final: string[];
  /** Why the one retry made no version, when it didn't. */
  retryNote: string | null;
}

const NUMBER_WORDS =["", "one", "two", "three", "four", "five"];

export function fixPartName(part: string): string {
  return part === "header" ? "Header" : part === "footer" ? "Footer" : `Part ${Number(part) + 1}`;
}

/* What the check found, in plain English, each once (at most eight). */
export function describeFixCheck(results: { width: FixCheckWidth; found: FixCheckRaw[] }[]): string[] {
  const out: string[] = [];
  for (const { width, found } of results) {
    for (const f of found) {
      if (f.kind === "wrap" && (f.lines ?? 0) < 2) continue;
      if (f.kind === "overflow" && (f.by ?? 0) <= 2) continue;
      const where = `${fixPartName(f.part)} at ${width} width`;
      const lines = f.lines && f.lines < NUMBER_WORDS.length ? `${NUMBER_WORDS[f.lines]} lines` : `${f.lines} lines`;
      const quoted = f.text ? ` "${f.text}"` : "";
      const line =
        f.kind === "wrap"
          ? `${where}: the ${f.what}${quoted} wraps onto ${lines}.`
          : f.kind === "overflow"
            ? f.what === "part"
              ? `${where}: the ${f.part === "header" || f.part === "footer" ? f.part : "part"} is ${f.by} px wider than the page.`
              : `${where}:${quoted || " something"} sticks out ${f.by} px past the edge of the page.`
            : `${where}: a picture doesn't load${f.text ? ` (${f.text})` : ""}.`;
      if (!out.includes(line)) out.push(line);
    }
  }
  return out.slice(0, 8);
}
