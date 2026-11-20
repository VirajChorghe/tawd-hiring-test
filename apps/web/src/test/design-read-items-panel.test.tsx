import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/*
  E4b-2b: what the "New design read" panel says about the words and pictures
  of a read, their corrections, and the free "Prepare the pictures again".
  Every sentence is checked against the data it describes.
*/

vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }), redirect: (to: string) => { throw new Error(`redirect ${to}`); } }));
vi.mock("@/app/actions", () => {
  const f = async () => ({ ok: true });
  return new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : f), has: () => true });
});

import type { NewReadView } from "@/lib/design-read-new";
import type { NewReadItems } from "@/lib/design-read-items";
import type { PrepareStatus } from "@tawd/core/figma/read-assets";
import { NewDesignRead } from "@/components/intake/new-design-read";

const RUN = "design-read-p1-1700000000000";

// No estimate: the paid read button is not on the page, so any dollar sign belongs to something else.
const view: NewReadView = {
  version: "upload-1",
  page: 1,
  height: 1200,
  estimate: null,
  status: { state: "done", runId: RUN, version: "upload-1", page: 1, startedAt: "2026-11-14T10:00:00Z", updatedAt: "2026-11-14T10:01:00Z", finishedAt: "2026-11-14T10:01:00Z", calls: 5, inputTokens: 5000, outputTokens: 1000, bands: 1, error: null },
  stalled: false,
  result: { runId: RUN, height: 1200, bands: [{ name: "Hero", role: "band", top: 120, bottom: 620, words: 2, pictures: 2, notes: [] }], colours: 4, notes: [] },
  assets: null,
};

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

const items: NewReadItems = {
  words: [
    { text: "Fast plumbing repairs", role: "heading", box: box(10, 20, 300, 40), band: "Hero", asRead: box(10, 20, 300, 40), corrected: null },
    { text: "Call n0w", role: "button", box: box(10, 80, 100, 30), unsure: true, band: "Hero", asRead: box(10, 80, 100, 30), corrected: null },
    { text: "Free quote", role: "link", box: box(10, 120, 100, 30), band: "Hero", asRead: box(10, 120, 100, 30), corrected: { by: "Jason", at: "2026-11-14T12:00:00.000Z", ids: ["c1"] } },
  ],
  pictures: [
    { id: "a1", kind: "photo", box: box(400, 20, 500, 300), band: "Hero", asRead: box(400, 20, 500, 300), corrected: null },
    { id: "a2", kind: "logo", box: box(10, 0, 120, 60), band: "Hero", asRead: box(10, 0, 120, 60), corrected: null },
  ],
  unmatched: [],
  problems: [],
};

const prep = (state: PrepareStatus["state"], extra: Partial<PrepareStatus> = {}): PrepareStatus => ({
  state,
  attempt: "a1",
  runId: RUN,
  startedAt: "2026-11-15T10:00:00Z",
  updatedAt: "2026-11-15T10:01:00Z",
  finishedAt: null,
  done: 0,
  total: null,
  error: null,
  ...extra,
});

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;|&rsquo;|’/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
const render = (props: { items?: NewReadItems | null; prepare?: { status: PrepareStatus; stalled: boolean } | null }) =>
  renderToStaticMarkup(<NewDesignRead projectId="p1" view={view} {...props} />);

describe("the words panel", () => {
  it("marks a word the read was unsure of, and only that one", () => {
    const said = text(render({ items }));
    expect(said).toContain("Call n0w (unsure: not every letter could be made out)");
    expect(said).not.toContain("Fast plumbing repairs (unsure");
    expect(said).toContain("A word marked unsure is one TAWD could not make every letter out of");
  });

  it("shows who corrected a word and when, and a Correct button on every word", () => {
    const html = render({ items });
    expect(text(html)).toContain("Free quote (corrected by Jason, Nov 14)");
    // 3 words + 2 pictures + 1 band
    expect(html.match(/>Correct<\/button>/g)).toHaveLength(6);
  });
});

describe("the pictures panel", () => {
  it("shows each picture's kind and where it sits", () => {
    const said = text(render({ items }));
    expect(said).toContain("Photo");
    expect(said).toContain("Logo");
    expect(said).toContain("500 × 300px at 400, 20");
  });
});

describe("Prepare the pictures again", () => {
  it("is free: no estimate, no dollar sign, and says so plainly", () => {
    const html = render({ items, prepare: null });
    const said = text(html);
    expect(said).toContain("This is free: it does not read the design again and uses no AI.");
    expect(html).not.toContain("$");
    expect(said).not.toContain("About $");
    expect(html).toContain("Prepare the pictures again</button>");
  });

  it("is disabled while working, and says how far it has got", () => {
    const html = render({ items, prepare: { status: prep("working", { done: 2, total: 5 }), stalled: false } });
    expect(text(html)).toContain("Preparing the pictures: 2 of 5.");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Prepare the pictures again<\/button>/);
  });

  it("is disabled while queued", () => {
    const html = render({ items, prepare: { status: prep("queued"), stalled: false } });
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Prepare the pictures again<\/button>/);
    expect(text(html)).toContain("Waiting for its turn");
  });

  it("shows why it failed, and can be started again", () => {
    const html = render({ items, prepare: { status: prep("failed", { error: "The design picture could not be loaded." }), stalled: false } });
    expect(text(html)).toContain("The design picture could not be loaded.");
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Prepare the pictures again<\/button>/);
  });

  it("says a stalled prepare stopped, and can be started again", () => {
    const html = render({ items, prepare: { status: prep("working", { done: 1, total: 5 }), stalled: true } });
    expect(text(html)).toContain("stopped without finishing. It can be started again.");
    expect(text(html)).not.toContain("Preparing the pictures: 1 of 5.");
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Prepare the pictures again<\/button>/);
  });
});

describe("without items", () => {
  it("shows none of the new panels", () => {
    const said = text(render({}));
    expect(said).not.toContain("Words from the design");
    expect(said).not.toContain("Prepare the pictures again");
  });

  it("lists corrections that no longer match, and problems", () => {
    const said = text(
      render({
        items: {
          ...items,
          unmatched: [{ what: "word", anchor: box(1, 2, 3, 4), by: "Jason", at: "2026-11-14T12:00:00.000Z", why: "gone" }],
          problems: ["A problem in plain words."],
        },
      }),
    );
    expect(said).toContain("The word 3 × 4px at 1, 2 (none of this read is in its place) (by Jason)");
    expect(said).toContain("A problem in plain words.");
  });
});

describe("the band table", () => {
  it("scrolls inside its card instead of overflowing it", () => {
    expect(render({})).toMatch(/<div class="table-scroll"><table class="spend-table">/);
  });
});
