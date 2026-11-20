import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/*
  E4b-2: what the "New design read" panel says about corrections to the band
  list. Every sentence is checked against the corrections it describes.
*/

vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }), redirect: (to: string) => { throw new Error(`redirect ${to}`); } }));
vi.mock("@/app/actions", () => {
  const f = async () => ({ ok: true });
  return new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : f), has: () => true });
});

import type { NewReadView } from "@/lib/design-read-new";
import type { NewReadCorrections } from "@/lib/design-read-corrections";
import { NewDesignRead, describeChange } from "@/components/intake/new-design-read";

const band = (name: string, role: "header" | "band" | "footer", top: number, bottom: number) => ({ name, role, top, bottom, words: 2, pictures: 1, notes: [] as string[] });

const view: NewReadView = {
  version: "upload-1",
  page: 1,
  height: 1200,
  estimate: { cost: 0.2, bands: 4, model: "Sonnet", measured: false, label: "About $0.20" },
  status: { state: "done", runId: "design-read-p1-1700000000000", version: "upload-1", page: 1, startedAt: "2026-11-14T10:00:00Z", updatedAt: "2026-11-14T10:01:00Z", finishedAt: "2026-11-14T10:01:00Z", calls: 5, inputTokens: 5000, outputTokens: 1000, bands: 4, error: null },
  stalled: false,
  result: { runId: "design-read-p1-1700000000000", height: 1200, bands: [band("Header", "header", 0, 120), band("Hero", "band", 120, 620), band("Services", "band", 620, 1000), band("Footer", "footer", 1000, 1200)], colours: 4, notes: [] },
  assets: null,
};

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;|&rsquo;|\u2019/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&ldquo;|&rdquo;|\u201c|\u201d/g, '"');

describe("the band list with corrections", () => {
  it("shows the corrected band list, who corrected a band and when, and a Correct button on every band", () => {
    const corrections: NewReadCorrections = {
      bands: [
        { ...band("Header", "header", 0, 120), asRead: { top: 0, bottom: 120 }, corrected: null },
        { ...band("Hero with form", "header", 120, 650), asRead: { top: 120, bottom: 620 }, corrected: { by: "Jason", at: "2026-11-14T12:00:00.000Z", ids: ["c1"] } },
        { ...band("Services", "band", 650, 1000), asRead: { top: 620, bottom: 1000 }, corrected: null },
        { ...band("Footer", "footer", 1000, 1200), asRead: { top: 1000, bottom: 1200 }, corrected: null },
      ],
      unmatched: [],
      problems: [],
    };
    const html = renderToStaticMarkup(<NewDesignRead projectId="p1" view={view} corrections={corrections} />);
    const said = text(html);
    expect(said).toContain("Hero with form (corrected by Jason, Nov 14)");
    expect(said).toContain("Bands marked corrected show a person's correction, kept if the design is read again; words and pictures are counted as read.");
    expect(said).toContain("650px");
    expect(html.match(/>Correct<\/button>/g)).toHaveLength(4);
  });

  it("lists corrections that no band matches any more, says they are kept, and shows problems", () => {
    const corrections: NewReadCorrections = {
      bands: view.result!.bands.map((b) => ({ ...b, asRead: { top: b.top, bottom: b.bottom }, corrected: null })),
      unmatched: [
        { anchor: { top: 120, bottom: 620 }, change: { name: "Hero with form", role: "header" }, by: "Jason", at: "2026-11-14T12:00:00.000Z", why: "gone" },
        { anchor: { top: 620, bottom: 1000 }, change: { name: "What we do" }, by: null, at: "2026-11-14T12:05:00.000Z", why: "tied" },
      ],
      problems: ['The correction of "Hero" (120 to 620 px) was not applied to its edges: the first band starts at the top of the page.'],
    };
    const said = text(renderToStaticMarkup(<NewDesignRead projectId="p1" view={view} corrections={corrections} />));
    expect(said).toContain("These corrections don't match one band of this read (the band list changed when the design was read again). They are kept, not applied:");
    expect(said).toContain('The band at 120 to 620px: named "Hero with form", made a header (no band of this read is in its place) (by Jason)');
    expect(said).toContain('The band at 620 to 1000px: named "What we do" (two bands of this read are in its place equally)');
    expect(said).toContain('was not applied to its edges: the first band starts at the top of the page.');
    expect(said).not.toContain("Bands marked corrected");
  });

  it("says each kind of change in plain words", () => {
    expect(describeChange({ name: "Top bar" })).toBe('named "Top bar"');
    expect(describeChange({ role: "footer", top: 900, bottom: 1200 })).toBe("made a footer, top at 900px, bottom at 1200px");
    expect(describeChange({})).toBe("no change");
  });
});
