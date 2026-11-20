import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { checkPageRules } from "@tawd/core/mockups";
import { describeChanges, describeEach, joinSentences, formatPhonesInHtml, isKeptMain, keepMainThrough, keptPhoneStyle, passOverPage, restampKept, sharedPartsNote, textChanges, visibleWordsLine, visibleWords, wordpressPackage, MAX_COMPARE_CELLS } from "@tawd/core/site";
import { formatSitePhones, sharedPartsNotes, tidySitePages } from "../../../worker/src/site-build";

/*
  A kept page (a supplied homepage) keeps every word the visitor reads
  (Jason, 16 November 2026). These are the pieces that make that so, and the
  passes that run over a finished site (the "second run": a rebuild or a
  speed-up of an old version must not undo it).
*/

const KEPT = `<main id="main" data-tawd-kept><h1>Call 530-227-2479</h1><a class="btn" href="#contact">Start with a conversation</a></main>`;
const PAGE = (main: string) => `<!doctype html><html><head><title>t</title></head><body><header><p>Phone 530.227.2479</p></header>${main}<footer><p>530.227.2479</p></footer></body></html>`;

describe("the words a visitor reads", () => {
  it("are the text between tags, a placeholder and a button's value, never scripts, styles or attributes", () => {
    const html = `<head><title>No</title></head><body><h1> Hello   there </h1><script>var no=1</script><style>.a{}</style><svg><title>No</title></svg><input placeholder="Your name" alt="No"><input type="submit" value="Send it"><img alt="No" src="x"><!-- no --></body>`;
    expect(visibleWords(html)).toEqual(["Hello there", "Your name", "Send it"]);
  });

  it("compare by words and their order, not by how the tags split them", () => {
    expect(visibleWordsLine("<p>Call <b>us</b> now</p>")).toBe(visibleWordsLine("<p>Call us now</p>"));
    expect(visibleWordsLine("<p>Call us now</p>")).not.toBe(visibleWordsLine("<p>Now call us</p>"));
  });
});

describe("what differs between two pages' words", () => {
  it("pairs what was replaced, counts repeats, and says what was added or removed", () => {
    const changes = textChanges(["A", "Start", "B", "Start", "C", "Gone"], ["A", "Request", "B", "Request", "C", "New", "More"]);
    expect(changes).toEqual([
      { from: "Start", to: "Request", count: 2 },
      { from: "Gone", to: "New", count: 1 },
      { from: "", to: "More", count: 1 },
    ]);
    expect(textChanges(["A", "B"], ["A", "B"])).toEqual([]);
  });

  it("is told to the team in plain words", () => {
    expect(describeChanges([{ from: "Start", to: "Request a quote", count: 3 }, { from: "Gone", to: "", count: 1 }])).toBe('"Start" would have become "Request a quote", in 3 places; "Gone" would have been taken out');
  });
});

describe("a pass over a kept page", () => {
  it("never reaches the kept <main>, still reaches the header and footer, and says what it would have changed", () => {
    const out = passOverPage(PAGE(KEPT), (page) => formatPhonesInHtml(page));
    expect(out.html).toContain(KEPT);
    expect(out.html).toContain("<header><p>Phone (530) 227-2479</p></header>");
    expect(out.html).toContain("<footer><p>(530) 227-2479</p></footer>");
    expect(out.wouldChange).toEqual([{ from: "Call 530-227-2479", to: "Call (530) 227-2479", count: 1 }]);
  });

  it("is an ordinary pass on any other page", () => {
    const other = PAGE(KEPT.replace(" data-tawd-kept", ""));
    expect(isKeptMain(other)).toBe(false);
    const out = passOverPage(other, (page) => formatPhonesInHtml(page));
    expect(out.html).toBe(formatPhonesInHtml(other));
    expect(out.wouldChange).toEqual([]);
  });

  it("only counts the mark on the <main> tag itself, as a whole attribute", () => {
    expect(isKeptMain(KEPT)).toBe(true);
    expect(isKeptMain(`<main id="x" data-tawd-kept="">a</main>`)).toBe(true);
    expect(isKeptMain(`<main data-tawd-kept-not>a</main>`)).toBe(false);
    expect(isKeptMain(`<main><p data-tawd-kept>a</p></main>`)).toBe(false);
  });

  it("gives the page back untouched when a pass loses its place, and keeps a page's own $& and $1", () => {
    const lost = keepMainThrough(PAGE(KEPT), (page) => page.replace("<!--tawd-kept-main-->", ""));
    expect(lost.html).toBe(PAGE(KEPT));
    const dollars = `<main id="main" data-tawd-kept><p>Save $& and $1</p></main>`;
    expect(keepMainThrough(PAGE(dollars), (page) => page).html).toBe(PAGE(dollars));
  });

  it("the look-and-see run does not spend what the real run uses", () => {
    const seen: boolean[] = [];
    keepMainThrough(PAGE(KEPT), (page, forReal) => {
      seen.push(forReal);
      return page;
    });
    expect(seen).toEqual([true, false]);
  });
});

describe("the passes over a finished site, run again later", () => {
  it("the phone layout (also run when an old version is sped up) leaves a kept page's own number alone and tells the team", async () => {
    const dist = await mkdtemp(path.join(tmpdir(), "tawd-kept-"));
    try {
      await mkdir(path.join(dist, "about"), { recursive: true });
      await writeFile(path.join(dist, "index.html"), PAGE(KEPT));
      await writeFile(path.join(dist, "about", "index.html"), PAGE(`<main id="main"><p>Call 530-227-2479</p></main>`));
      const told: string[] = [];
      expect(await formatSitePhones(dist, (file) => told.push(file))).toBe(2);
      const home = await readFile(path.join(dist, "index.html"), "utf8");
      expect(home).toContain(KEPT);
      expect(home).toContain("<header><p>Phone 530-227-2479</p></header>");
      expect(home).toContain("<footer><p>530-227-2479</p></footer>");
      expect(await readFile(path.join(dist, "about", "index.html"), "utf8")).toContain("<p>Call (530) 227-2479</p>");
      expect(told).toEqual([]);
    } finally {
      await rm(dist, { recursive: true, force: true });
    }
  });

  it("the tidy-up rules leave a kept page's words, buttons and frames alone, tidy every other page, and report", async () => {
    const dist = await mkdtemp(path.join(tmpdir(), "tawd-kept-"));
    const body = `<h1>Drains</h1><a class="btn" href="#contact">Start with a conversation</a><div data-tawd-photo="van">Photo: the van</div>`;
    try {
      await mkdir(path.join(dist, "about"), { recursive: true });
      await writeFile(path.join(dist, "index.html"), PAGE(`<main id="main" data-tawd-kept>${body}</main>`));
      await writeFile(path.join(dist, "about", "index.html"), PAGE(`<main id="main">${body}</main>`));
      const { kept, notes } = await tidySitePages(dist, { trade: "plumbing", businessName: "Pat Rivera Plumbing" });
      expect(await readFile(path.join(dist, "index.html"), "utf8")).toContain(`<main id="main" data-tawd-kept>${body}</main>`);
      const about = await readFile(path.join(dist, "about", "index.html"), "utf8");
      expect(about).toContain("Request a quote");
      expect(about).not.toContain("Start with a conversation");
      // The notes of what was fixed count the other page only; the kept page's would-have list is separate.
      expect(notes.join(" ")).toContain('1 form button now "Request a quote"');
      expect(kept).toHaveLength(1);
      expect(kept[0]!.file).toBe("index.html");
      expect(describeChanges(kept[0]!.changes)).toContain('"Start with a conversation" would have become "Request a quote"');
    } finally {
      await rm(dist, { recursive: true, force: true });
    }
  });
});

/* ---------- the cold review's fixes (16 November 2026) ---------- */

describe("a very large page can never exhaust memory (H1)", () => {
  const pieces = (n: number, tag = "w") => Array.from({ length: n }, (_, i) => `${tag}${i}`);

  it("answers at once, using almost no memory, when nothing changed, however many pieces", () => {
    const big = pieces(60_000);
    const before = process.memoryUsage().arrayBuffers;
    const t0 = performance.now();
    expect(textChanges(big, [...big])).toEqual([]);
    const ms = performance.now() - t0;
    const grew = process.memoryUsage().arrayBuffers - before;
    // The old matrix for 60,000 pieces was 14 GB. Now there is no matrix at all.
    expect(grew).toBeLessThan(5_000_000);
    expect(ms).toBeLessThan(500);
  });

  it("finds one change in the middle of a 60,000-piece page without a matrix", () => {
    const before = pieces(60_000);
    const after = [...before];
    after[30_000] = "Request a quote";
    const t0 = performance.now();
    expect(textChanges(before, after)).toEqual([{ from: "w30000", to: "Request a quote", count: 1 }]);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it("says plainly that a page was too large to compare when what differs is itself huge, never 'no changes'", () => {
    const side = Math.ceil(Math.sqrt(MAX_COMPARE_CELLS)) + 50;
    const out = textChanges(pieces(side, "a"), pieces(side, "b"));
    expect(out).toHaveLength(1);
    expect(out[0]!.notice).toMatch(/too many pieces of text to compare/);
    expect(describeChanges(out)).toMatch(/could not be listed/);
  });

  it("still reports a change on a kept page of 20,000 text pieces (the size that took 4.1 GB)", () => {
    const body = Array.from({ length: 20_000 }, (_, i) => `<p>Line ${i}</p>`).join("");
    const html = `<main id="main" data-tawd-kept>${body}<a class="btn" href="#c">Start with a conversation</a></main>`;
    const t0 = performance.now();
    const out = passOverPage(PAGE(html), (page) => page.replace("Start with a conversation", "Request a quote"));
    expect(out.wouldChange).toEqual([{ from: "Start with a conversation", to: "Request a quote", count: 1 }]);
    expect(out.html).toContain("Start with a conversation");
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});

describe("the <main> the guard looks for is the real element (M3, L1)", () => {
  const body = `<h1>Call 530-227-2479</h1>`;
  it("is not fooled by a custom element whose name starts with main", () => {
    const html = `<header><main-menu x="1">a</main-menu><p>530.227.2479</p></header><main id="main" data-tawd-kept>${body}</main>`;
    expect(isKeptMain(html)).toBe(true);
    const out = passOverPage(html, (page) => formatPhonesInHtml(page));
    expect(out.html).toContain(`<main id="main" data-tawd-kept>${body}</main>`);
    // The header text after the custom element is outside the kept <main> and is still tidied.
    expect(out.html).toContain("</main-menu><p>(530) 227-2479</p></header>");
    expect(isKeptMain(`<main-menu data-tawd-kept>a</main-menu><main id="m">x</main>`)).toBe(false);
  });

  it("finds the closing tag as written: spaces, a line break, capitals, and an İ before it", () => {
    for (const close of ["</main >", "</MAIN\n>", "</main>"]) {
      const html = `<header>İİİ 530.227.2479</header><main id="main" data-tawd-kept>${body}${close}<footer>530.227.2479</footer>`;
      const out = passOverPage(html, (page) => formatPhonesInHtml(page));
      expect(out.html, close).toContain(`${body}${close}<footer>(530) 227-2479</footer>`);
      expect(out.html, close).toContain("<header>İİİ (530) 227-2479</header>");
      expect(out.applied, close).toBe(true);
    }
  });
});

describe("a pass that could not be run around a kept page is not silent (L4)", () => {
  it("a page that already holds the plain hold comment is still passed over, safely", () => {
    const html = PAGE(KEPT).replace("<header>", "<header><!--tawd-kept-main-->");
    const out = keepMainThrough(html, (page) => formatPhonesInHtml(page));
    expect(out.applied).toBe(true);
    expect(out.html).toContain(KEPT);
    expect(out.html).toContain("<footer><p>(530) 227-2479</p></footer>");
  });

  it("a pass that loses its place says so, and the tidy-up's counters do not count work never applied", async () => {
    const lost = keepMainThrough(PAGE(KEPT), (page) => page.replace(/<!--tawd-kept-main[^>]*-->/, ""));
    expect(lost.applied).toBe(false);
    expect(describeChanges(lost.wouldChange)).toMatch(/were not run on this page at all/);
    // A kept page with no closing </main>: given back untouched, told, not counted.
    const dist = await mkdtemp(path.join(tmpdir(), "tawd-kept-"));
    try {
      const broken = `<!doctype html><html><head><title>t</title></head><body><header><p>x</p></header><main id="main" data-tawd-kept><h1>Drains</h1><a class="btn" href="#c">Start with a conversation</a><footer><p>x</p></footer></body></html>`;
      await writeFile(path.join(dist, "index.html"), broken);
      const { kept, notes } = await tidySitePages(dist, { trade: "plumbing", businessName: "Pat Rivera Plumbing" });
      expect(await readFile(path.join(dist, "index.html"), "utf8")).toBe(broken);
      expect(notes).toEqual([]);
      expect(kept).toHaveLength(1);
      expect(describeChanges(kept[0]!.changes)).toMatch(/were not run on this page at all/);
      const told: string[] = [];
      await formatSitePhones(dist, (file, changes) => told.push(`${file}: ${describeChanges(changes)}`));
      expect(told.join(" ")).toMatch(/were not run on this page at all/);
    } finally {
      await rm(dist, { recursive: true, force: true });
    }
  });
});

describe("the shared header and footer are said to be TAWD's own (M1)", () => {
  it("tells the team, naming a phone number written two ways", () => {
    const html = PAGE(KEPT).replace("530.227.2479", "(530) 227-2479").replace("530.227.2479", "(530) 227-2479");
    const note = sharedPartsNote(html)!;
    expect(note).toContain("TAWD's own");
    expect(note).toContain('"(530) 227-2479" in them and "530-227-2479" on the supplied page');
  });
  it("says it without the phone sentence when they agree, and nothing on an ordinary page", () => {
    const same = `<header><p>530-227-2479</p></header>${KEPT}<footer>x</footer>`;
    expect(sharedPartsNote(same)).toContain("may differ");
    expect(sharedPartsNote(same)).not.toContain("phone");
    expect(sharedPartsNote(PAGE(KEPT.replace(" data-tawd-kept", "")))).toBeNull();
  });
  it("is gathered over a built site, kept pages only", async () => {
    const dist = await mkdtemp(path.join(tmpdir(), "tawd-kept-"));
    try {
      await mkdir(path.join(dist, "about"), { recursive: true });
      await writeFile(path.join(dist, "index.html"), PAGE(KEPT));
      await writeFile(path.join(dist, "about", "index.html"), PAGE(`<main id="main"><p>x</p></main>`));
      const notes = await sharedPartsNotes(dist);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain("index.html");
    } finally {
      await rm(dist, { recursive: true, force: true });
    }
  });
});

describe("a kept page's header and footer use its own phone style (Option A)", () => {
  it("takes the style of the kept <main>, and TAWD's standard for a page that is not kept", () => {
    expect(keptPhoneStyle(PAGE(`<main id="main" data-tawd-kept><p>Call 530.227.2479</p></main>`))).toBe("dot");
    expect(keptPhoneStyle(PAGE(`<main id="main" data-tawd-kept><p>Call us today</p></main>`))).toBe("paren");
    expect(keptPhoneStyle(PAGE(KEPT.replace(" data-tawd-kept", "")))).toBe("paren");
  });
  it("writes the header and footer in that style, and leaves the kept words exactly as they were", () => {
    const html = PAGE(`<main id="main" data-tawd-kept><p>Call 530-227-2479</p></main>`);
    const style = keptPhoneStyle(html);
    const out = passOverPage(html, (page) => formatPhonesInHtml(page, style));
    expect(out.html).toContain("<header><p>Phone 530-227-2479</p></header>");
    expect(out.html).toContain("<footer><p>530-227-2479</p></footer>");
    expect(out.html).toContain(`<main id="main" data-tawd-kept><p>Call 530-227-2479</p></main>`);
    expect(out.wouldChange).toEqual([]);
  });
});

describe("an edit cannot drop the kept mark (M2)", () => {
  it("puts the mark back on the model's <main> when the page had it", () => {
    const after = `<main id="main"><h1>New</h1></main>`;
    expect(restampKept(KEPT, after)).toBe(`<main data-tawd-kept id="main"><h1>New</h1></main>`);
    expect(isKeptMain(restampKept(KEPT, after))).toBe(true);
  });
  it("leaves an already marked reply, and every ordinary page, as it is", () => {
    expect(restampKept(KEPT, KEPT)).toBe(KEPT);
    const plain = `<main id="main"><h1>x</h1></main>`;
    expect(restampKept(plain, plain)).toBe(plain);
  });
});

describe("Build B does not rewrite a kept page's words (M4)", () => {
  const enc = (t: string) => new TextEncoder().encode(t);
  const wrap = (main: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body><header><nav><a href="/">Home</a></nav><p>530.227.2479</p></header>${main}<footer><p>Website by Velocity Media Lab</p></footer></body></html>`;
  const run = (main: string) => {
    const { files, report } = wordpressPackage({ clientName: "Harbor Plumbing", buildVersion: 1, files: new Map([["index.html", enc(wrap(main))]]), formEmails: { to: [], copy: null } });
    return { home: new TextDecoder().decode(files.get("content/pages/home.html")!), report };
  };
  it("keeps the phone in a kept <main> as written, and its header and footer follow that style; an ordinary page is reformatted as before", () => {
    const kept = run(`<main id="main" data-tawd-kept><h1>Harbor</h1><p>Call 530-227-2479</p></main>`);
    expect(kept.home).toContain("Call 530-227-2479");
    expect(kept.home).not.toContain("(530) 227-2479");
    expect(kept.report.notes.join(" ")).not.toContain("would have become");
    const plain = run(`<main id="main"><h1>Harbor</h1><p>Call 530-227-2479</p></main>`);
    expect(plain.home).toContain("Call (530) 227-2479");
    expect(plain.report.notes.join(" ")).not.toContain("would have become");
  });
});

describe("more of what a visitor reads (visibleWords gaps)", () => {
  it("reads words drawn in an svg, foreignObject content, noscript text, tooltips, prefilled and reset values, dropdown labels, datalists and caption labels", () => {
    const html =
      `<svg><title>No</title><desc>No</desc><circle r="1"/><text x="1">Since 1998</text><foreignObject><p>Inside <b>html</b></p></foreignObject></svg>` +
      `<noscript><p>Turn scripts on</p></noscript><a href="/x" title="Opens the map">Map</a>` +
      `<input type="reset" value="Clear it"><input type="text" value="Prefilled"><input type="hidden" value="secret"><input type="checkbox" value="chk"><input type="password" value="pw">` +
      `<select><optgroup label="Sacramento"><option label="Elk Grove" value="v1">raw</option><option value="v2">Folsom</option></optgroup></select>` +
      `<datalist id="d"><option value="Suggestion"></option></datalist><video><track label="English" src="a.vtt"></video>`;
    expect(visibleWords(html)).toEqual([
      "Since 1998",
      "Inside",
      "html",
      "Turn scripts on",
      "Opens the map",
      "Map",
      "Clear it",
      "Prefilled",
      "Sacramento",
      "Elk Grove",
      "raw",
      "Folsom",
      "Suggestion",
      "English",
    ]);
  });
  it("an element with the hidden attribute (a form's honeypot) is not read", () => {
    expect(visibleWords(`<p hidden><label>Leave this empty: <input name="bot-field" value="x"></label></p><p>Yes</p>`)).toEqual(["Yes"]);
  });
  it("the page-level title, an svg's own title and desc, and a path never count", () => {
    expect(visibleWords(`<head><title>No</title></head><svg><path d="M0"/><title>No</title></svg><p>Yes</p>`)).toEqual(["Yes"]);
  });
});

/* ---------- what TAWD says about a kept page (16 November 2026) ---------- */

describe("what the page rules say about a kept page", () => {
  const facts = { businessName: "Pat Rivera Plumbing", cities: [], phones: ["530-227-2479"] };
  const FORM_BUTTON = `<main><a class="btn" href="#contact">Start with a conversation</a><section id="contact"></section></main>`;
  const CALL_BUTTON = `<main><a class="button" href="tel:+15302272479">Ring the office</a></main>`;

  it("a kept page's finding says TAWD left it, never that it rewords it", () => {
    const message = checkPageRules(FORM_BUTTON, { ...facts, kept: true }).find((i) => i.id === "copy.formButton")!.message;
    expect(message).toBe(`A button that leads to the form isn't worded "Request a quote"; the supplied page is kept as written, so TAWD left it as it is.`);
    const call = checkPageRules(CALL_BUTTON, { ...facts, kept: true }).find((i) => i.id === "copy.callButton")!.message;
    expect(call).toBe(`A button that calls isn't worded "Call" and the number; the supplied page is kept as written, so TAWD left it as it is.`);
  });

  it("an ordinary page's findings are worded exactly as before", () => {
    expect(checkPageRules(FORM_BUTTON, facts).find((i) => i.id === "copy.formButton")!.message).toBe(`A button that leads to the form isn't worded "Request a quote"; TAWD rewords it.`);
    expect(checkPageRules(CALL_BUTTON, facts).find((i) => i.id === "copy.callButton")!.message).toBe(`A button that calls isn't worded "Call" and the number; TAWD rewords it.`);
  });

  it("the finished site's Page rules finding for a kept page says the same", async () => {
    const dist = await mkdtemp(path.join(tmpdir(), "tawd-kept-"));
    try {
      await writeFile(path.join(dist, "index.html"), PAGE(`<main id="main" data-tawd-kept><a class="btn" href="#contact">Start with a conversation</a><section id="contact"></section></main>`));
      const { findings } = await tidySitePages(dist, { trade: "plumbing", businessName: "Pat Rivera Plumbing" });
      const messages = findings.flatMap((f) => f.messages);
      expect(messages).toContain(`A button that leads to the form isn't worded "Request a quote"; the supplied page is kept as written, so TAWD left it as it is.`);
      expect(messages.join(" ")).not.toContain("rewords");
    } finally {
      await rm(dist, { recursive: true, force: true });
    }
  });
});

describe("telling the team every change", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ from: `Old ${i}`, to: `New ${i}`, count: 1 }));

  it("lists all of them unless the caller cuts the list and says where the rest is", () => {
    expect(describeChanges(many).split("; ")).toHaveLength(12);
    expect(describeChanges(many)).not.toMatch(/more/);
    expect(describeChanges(many, 4, ", listed below")).toMatch(/; and 8 more, listed below$/);
    expect(describeEach(many)).toHaveLength(12);
    expect(describeEach(many)[11]).toBe('"Old 11" would have become "New 11"');
  });

  it("one full stop between notes and one at the end, whatever the notes already end in", () => {
    expect(joinSentences(["A", "B."])).toBe("A. B.");
    expect(joinSentences(["A.", "B.", "C"])).toBe("A. B. C.");
    expect(joinSentences(["It is on the supplied page.", "Next"])).toBe("It is on the supplied page. Next.");
    expect(joinSentences([])).toBe("");
    // The real note that caused it: it ends with a full stop of its own.
    const note = sharedPartsNote(PAGE(`<main id="main" data-tawd-kept><p>Call 530-227-2479</p></main>`))!;
    expect(note.endsWith(".")).toBe(true);
    expect(joinSentences(["The form: x", note])).not.toMatch(/\.\./);
  });
});
