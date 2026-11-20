/*
  Two clean-ups for words read off a client's design (E4a-1, Lane 2,
  14 November 2026; audit finding L-05). Pure text and numbers, no AI.

  1. SPACED CAPITALS. A design drawn with wide letter spacing comes out of a
     PDF's text layer as "W H AT W E D O" or "A L E GAC Y O F S E RV I C E":
     the letters sit apart, and the reader breaks the text wherever the
     spacing pairs happen to fall. A text is treated as spaced capitals only
     when ALL of this holds, so ordinary text is never touched:
       - it is made only of capital letters, in chunks of at most 3 letters
         separated by spaces (digits and "&" are left alone: "1 2 3 4 5" is a
         list and "J & J P L U M B I N G" a name, not spaced letters; Fable's
         review of E4a);
       - at least 4 of the chunks are a single character, and single
         characters are at least half of all the chunks.
     Then it is rebuilt like this:
       - If the text has a wider gap (two or more spaces) anywhere, the
         wider gaps are the word breaks: each group between them is joined
         into one word.
       - Otherwise there is no gap to trust, so the words are found by
         fitting the joined letters to a small list of common words (the
         words of a local-service website: what, we, do, water, solutions...).
         A fit is used only when EVERY letter lands in a listed word, and the
         fit with the fewest, longest words wins. Only the spaces change; no
         letter is added, dropped or changed.
       - If the letters do not fit the list, the fallback is: single letters
         are joined together, and a chunk of two or three letters marks a
         word boundary on each side of it, kept as it is.
     What it cannot recover: where a word break fell between letters when the
     words are not in the list ("ALEGACY" may stay "ALE GAC YOF..." in the
     fallback), and the break between two words when the list can read the
     same letters two ways (the fewest, longest words win, which is right
     for headings but not always). Spaced capitals inside a longer sentence
     of other text are left alone.

  2. DOUBLED TEXT. A heading drawn with a shadow is read twice, one run on
     top of the other ("PUMP AND WELL", "PUMP AND WELL"). Two items with the
     same text (trimmed, any case, spaces collapsed) whose boxes overlap by
     at least half of the smaller box are one: the first is kept, the later
     one is dropped. Same text far apart (a repeated button) is kept.
*/

export interface TextBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Common words of a local-service website's headings, capitals. Only used to place spaces in letters that are already there. */
const WORDS = [
  "A", "I", "ABOUT", "ADVICE", "AIR", "ALL", "AN", "AND", "ARE", "AS", "AT", "BEST", "BOOK", "BY", "CALL", "CARE", "CHOOSE", "CLEAN", "COMMERCIAL", "COMPANY", "COMPLETE", "CONDITIONING", "CONTACT", "COOLING", "COMFORT", "CUSTOMER", "CUSTOMERS", "DO", "DRAIN", "DRILLING", "ELECTRIC", "ELECTRICAL", "EMERGENCY", "ESTIMATE", "EXPERIENCE", "EXPERT", "EXPERTS", "FAMILY", "FOR", "FREE", "FROM", "GET", "GLASS", "GOOD", "GREAT", "HEATING", "HELP", "HOME", "HOMES", "HOW", "HVAC", "IN", "INSTALLATION", "IS", "IT", "LEGACY", "LEGAL", "LET", "LOCAL", "LOCALLY", "MEET", "MORE", "NEAR", "NEED", "NEW", "NO", "NOW", "OF", "ON", "ONE", "OR", "OUR", "OWNED", "PLUMBING", "PROFESSIONAL", "PROJECTS", "PUMP", "PUMPS", "QUALITY", "QUOTE", "READ", "REASONS", "RELIABLE", "REPAIR", "REPAIRS", "RESIDENTIAL", "REVIEWS", "ROOF", "ROOFING", "SAME", "SEE", "SERVICE", "SERVICES", "SOLUTIONS", "SPECIALISTS", "SYSTEMS", "TEAM", "THE", "THEIR", "THIS", "TO", "TODAY", "TRUST", "TRUSTED", "US", "WANT", "WATER", "WE", "WELL", "WELLS", "WHAT", "WHEN", "WHERE", "WHO", "WHY", "WITH", "WORK", "YEARS", "YOU", "YOUR",
];
const WORD_SET = new Set(WORDS);
const LONGEST = Math.max(...WORDS.map((w) => w.length));

function isSpacedCapitals(text: string): boolean {
  const chunks = text.trim().split(/\s+/);
  if (chunks.length < 4) return false;
  if (!chunks.every((c) => /^[A-Z]{1,3}$/.test(c))) return false;
  const singles = chunks.filter((c) => c.length === 1).length;
  return singles >= 4 && singles * 2 >= chunks.length;
}

/** Fit the letters to listed words, or null when any letter falls outside them. Fewest unknown (none allowed), then most letters in long words. */
function fitWords(letters: string): string[] | null {
  const n = letters.length;
  const best: Array<{ score: number; words: string[] } | null> = new Array(n + 1).fill(null);
  best[0] = { score: 0, words: [] };
  for (let i = 1; i <= n; i += 1) {
    for (let len = 1; len <= Math.min(LONGEST, i); len += 1) {
      const from = best[i - len];
      if (!from) continue;
      const word = letters.slice(i - len, i);
      if (!WORD_SET.has(word)) continue;
      const score = from.score + len * len;
      if (!best[i] || score > best[i]!.score) best[i] = { score, words: [...from.words, word] };
    }
  }
  return best[n]?.words ?? null;
}

/** The fallback: single letters join, a 2-3 letter chunk stands as its own word. */
function joinByChunks(chunks: string[]): string {
  const words: string[] = [];
  let run = "";
  for (const c of chunks) {
    if (c.length === 1) {
      run += c;
    } else {
      if (run) words.push(run);
      run = "";
      words.push(c);
    }
  }
  if (run) words.push(run);
  return words.join(" ");
}

/** One text, rejoined when it is spaced capitals; any other text comes back exactly as it was. */
export function tidySpacedCapitals(text: string): string {
  if (!isSpacedCapitals(text)) return text;
  const trimmed = text.trim();
  const groups = trimmed.split(/\s{2,}/);
  if (groups.length > 1) return groups.map((g) => g.split(/\s+/).join("")).join(" ");
  const chunks = trimmed.split(/\s+/);
  const fit = fitWords(chunks.join(""));
  return fit ? fit.join(" ") : joinByChunks(chunks);
}

function overlapArea(a: TextBox, b: TextBox): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return norm(a) === norm(b);
}

/** Drops a later item that repeats an earlier one's text on top of it (a heading and its shadow); the first is kept, the order is unchanged. */
export function dropDoubledText<T>(items: T[], textOf: (item: T) => string, boxOf: (item: T) => TextBox): T[] {
  const kept: T[] = [];
  for (const item of items) {
    const text = textOf(item);
    const box = boxOf(item);
    const doubled = kept.some((k) => {
      if (!sameText(textOf(k), text)) return false;
      const other = boxOf(k);
      const smaller = Math.min(box.w * box.h, other.w * other.h);
      return smaller > 0 && overlapArea(box, other) * 2 >= smaller;
    });
    if (!doubled) kept.push(item);
  }
  return kept;
}
