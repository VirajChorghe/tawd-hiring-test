/*
  Pointing at one element of the stored page, for the fixes a browser works
  out (contrast, the logo treatment).

  The browser sees the rendered page; the fix has to land on the stored
  source. Before rendering, every opening tag in the source is numbered
  (data-tawd-n). Embedding images changes no element, so the browser reads
  the number off the element it wants to fix, and the fix goes on the tag
  with that number in the source: a class, never a position. A class moves
  with its element when the layout or a section changes (the reviewer's
  note on nth-child selectors, 25 September 2026).
*/

const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*?\/?>/g;
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);

interface OpeningTag {
  start: number;
  end: number;
  name: string;
}

/* Every opening tag in document order, skipping comments and the text inside script, style, textarea and title. */
function openingTags(html: string): OpeningTag[] {
  const out: OpeningTag[] = [];
  const pattern = new RegExp(TAG.source, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    if (match[0].startsWith("<!--") || match[1] === "/") continue;
    const name = match[2]!.toLowerCase();
    out.push({ start: match.index, end: pattern.lastIndex, name });
    if (RAW_TEXT.has(name)) {
      const close = html.toLowerCase().indexOf(`</${name}`, pattern.lastIndex);
      if (close === -1) break;
      pattern.lastIndex = close;
    }
  }
  return out;
}

/** The source with every opening tag numbered, for the browser to read. */
export function numberElements(html: string): string {
  let out = "";
  let at = 0;
  openingTags(html).forEach((tag, n) => {
    const nameEnd = tag.start + 1 + tag.name.length;
    out += `${html.slice(at, nameEnd)} data-tawd-n="${n}"`;
    at = nameEnd;
  });
  return out + html.slice(at);
}

/** The classes on a tag, read from its class attribute. */
function classesOf(tag: string): string[] {
  const match = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i.exec(tag);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").split(/\s+/).filter(Boolean);
}

function withClasses(tag: string, classes: string[]): string {
  const value = `class="${classes.join(" ")}"`;
  const existing = /\sclass\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+)/i;
  if (existing.test(tag)) return tag.replace(existing, ` ${value}`);
  const name = /^<[a-zA-Z][\w-]*/.exec(tag)![0];
  return `${name} ${value}${tag.slice(name.length)}`;
}

/*
  Changes the classes on numbered tags of the source (numbered as
  numberElements does): drop any class matching `remove`, then add the
  given one. Tags not listed are left exactly as they are.

  `add` may name more than one class, separated by spaces: one element can
  need two fixes at once - text that cannot be read, inside a card whose
  line is invisible. Each class is added once however many times this runs,
  which comparing the whole string did not do: a second run would have left
  "tawd-fix-1 tawd-edge-1 tawd-fix-1 tawd-edge-1" and grown the attribute
  on every pass (10 November 2026).
*/
export function setElementClasses(
  html: string,
  changes: Map<number, { add: string; remove?: RegExp }>,
): string {
  if (changes.size === 0) return html;
  let out = "";
  let at = 0;
  openingTags(html).forEach((tag, n) => {
    const change = changes.get(n);
    if (!change) return;
    const original = html.slice(tag.start, tag.end);
    const adding = change.add.split(/\s+/).filter(Boolean);
    const kept = classesOf(original).filter((c) => !(change.remove?.test(c) ?? false) && !adding.includes(c));
    out += html.slice(at, tag.start) + withClasses(original, [...kept, ...adding]);
    at = tag.end;
  });
  return out + html.slice(at);
}

/** The classes on the numbered tag, or none. */
export function elementClasses(html: string, n: number): string[] {
  const tag = openingTags(html)[n];
  return tag ? classesOf(html.slice(tag.start, tag.end)) : [];
}
