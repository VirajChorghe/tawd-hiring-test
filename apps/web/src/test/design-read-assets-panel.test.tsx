import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/*
  E4b-1: what the "New design read" panel says about a read's pictures. Every
  sentence is checked here against the sheet it describes.
*/

vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }), redirect: (to: string) => { throw new Error(`redirect ${to}`); } }));
vi.mock("@/app/actions", () => {
  const f = async () => ({ ok: true });
  return new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : f), has: () => true });
});

import type { AssetSheet } from "@tawd/core/figma/read-assets";
import type { NewReadView } from "@/lib/design-read-new";
import { NewDesignRead } from "@/components/intake/new-design-read";

const base = "/projects/p1/intake/design-read-assets/design-read-p1-1700000000000/";

function view(assets: NewReadView["assets"]): NewReadView {
  return {
    version: "upload-1",
    page: 1,
    height: 1200,
    estimate: { cost: 0.2, bands: 4, model: "Sonnet", measured: false, label: "About $0.20" },
    status: { state: "done", runId: "design-read-p1-1700000000000", version: "upload-1", page: 1, startedAt: "2026-11-14T10:00:00Z", updatedAt: "2026-11-14T10:01:00Z", finishedAt: "2026-11-14T10:01:00Z", calls: 5, inputTokens: 5000, outputTokens: 1000, bands: 4, error: null },
    stalled: false,
    result: { runId: "design-read-p1-1700000000000", height: 1200, bands: [{ name: "Hero", role: "band", top: 120, bottom: 620, words: 1, pictures: 1, notes: [] }], colours: 4, notes: [] },
    assets,
  };
}

const sheet: AssetSheet = {
  runId: "design-read-p1-1700000000000",
  version: "upload-1",
  page: 1,
  preparedAt: "2026-11-14T10:01:00Z",
  error: null,
  assets: [
    { id: "b2-hero", kind: "background", box: { x: 0, y: 120, w: 1000, h: 500 }, file: "p1.png", width: 1000, height: 500, icon: null, patches: [{ box: { x: 100, y: 100, w: 400, h: 80 }, method: "soft", feather: 6, hid: "p1-hid1.png" }], transparentOn: null, fadedEdges: [], flags: ["b2-hero: smoothed over; upload the picture without the text."] },
    { id: "b3-drain", kind: "icon", box: { x: 40, y: 760, w: 40, h: 40 }, file: null, width: null, height: null, icon: { name: "droplet", by: "word" }, patches: [], transparentOn: null, fadedEdges: [], flags: [] },
    { id: "b4-logo", kind: "logo", box: { x: 30, y: 1040, w: 100, h: 60 }, file: "p3.png", width: 100, height: 60, icon: null, patches: [], transparentOn: "#282828", fadedEdges: [], flags: [] },
    { id: "b5-person", kind: "silhouette", box: { x: 600, y: 1000, w: 200, h: 200 }, file: "p4.png", width: 200, height: 200, icon: null, patches: [], transparentOn: "#ffffff", fadedEdges: ["left", "top"], flags: [] },
  ],
};

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;|&rsquo;|\u2019/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');

describe("the panel's pictures", () => {
  it("shows each picture from TAWD's own address, with what was done to it in plain words", () => {
    const html = renderToStaticMarkup(<NewDesignRead projectId="p1" view={view({ runId: sheet.runId, sheet, base })} />);
    const said = text(html);
    expect(html).toContain(`src="${base}p1.png"`);
    expect(html).toContain(`src="${base}p3.png"`);
    expect(html).toContain(`href="${base}p1-hid1.png"`);
    expect(said).toContain("The read named 4 pictures: 3 cut from the design and prepared by kind, 1 icon (never cut: icons come from TAWD's own set); 1 needs a look (see the notes on each).");
    expect(said).toContain("Patch 1: smoothed over (a guess), 400 × 80px at 100, 100 on the picture");
    expect(said).toContain("b2-hero: smoothed over; upload the picture without the text.");
    expect(said).toContain("Icon: droplet (TAWD's word rules matched the word beside it)");
    expect(said).toContain("No picture: matched to TAWD's icons");
    expect(said).toContain("Made see-through where it was #282828.");
    expect(said).toContain("Faded into the band on its left, top edges.");
  });

  it("says when the read's pictures were not prepared, or could not be, or there were none", () => {
    expect(text(renderToStaticMarkup(<NewDesignRead projectId="p1" view={view({ runId: sheet.runId, sheet: null, base })} />))).toContain("This read's pictures were not prepared");
    expect(text(renderToStaticMarkup(<NewDesignRead projectId="p1" view={view({ runId: sheet.runId, sheet: { ...sheet, assets: [], error: "The pictures could not be prepared (x)." }, base })} />))).toContain("The pictures could not be prepared (x).");
    expect(text(renderToStaticMarkup(<NewDesignRead projectId="p1" view={view({ runId: sheet.runId, sheet: { ...sheet, assets: [] }, base })} />))).toContain("The read found no pictures on this page.");
  });

  it("says the pictures are on their way while the read's own run is still preparing them, and never offers a paid re-run for that", () => {
    const v = view({ runId: sheet.runId, sheet: null, base });
    v.status = { ...v.status!, state: "working", phase: "pictures", finishedAt: null };
    const said = text(renderToStaticMarkup(<NewDesignRead projectId="p1" view={v} />));
    expect(said).toContain("Read (5 calls); now preparing its pictures from the design, with no AI.");
    expect(said).toContain("This read's pictures are being prepared (no AI). Open the page again in a minute to see them.");
    expect(said).not.toContain("paid read");
    // A newer start working is not this read's run: its pictures were simply not prepared.
    v.status = { ...v.status!, runId: "design-read-p1-1700000099999", phase: undefined };
    expect(text(renderToStaticMarkup(<NewDesignRead projectId="p1" view={v} />))).toContain("Preparing them means running the new read again, which is a paid read.");
    // The read's own run, but stopped (no news for 30 minutes): not on their way any more.
    const stopped = view({ runId: sheet.runId, sheet: null, base });
    stopped.status = { ...stopped.status!, state: "working", phase: "pictures", finishedAt: null };
    stopped.stalled = true;
    const saidStopped = text(renderToStaticMarkup(<NewDesignRead projectId="p1" view={stopped} />));
    expect(saidStopped).not.toContain("being prepared");
    expect(saidStopped).toContain("Preparing them means running the new read again, which is a paid read.");
    // The read finished; only the picture step stopped, and the status line says just that.
    expect(saidStopped).toContain("The last new read finished (5 calls), but preparing its pictures stopped without finishing (no news for over 30 minutes).");
    expect(saidStopped).not.toContain("stopped without finishing (no news for over 30 minutes; ");
    // After a worker restart in the picture step, the worker's own sentence stands alone.
    const restarted = view({ runId: sheet.runId, sheet: null, base });
    restarted.status = { ...restarted.status!, state: "failed", phase: "pictures", error: "The worker restarted while preparing the read's pictures. The read itself is complete and kept." };
    const saidRestarted = text(renderToStaticMarkup(<NewDesignRead projectId="p1" view={restarted} />));
    expect(saidRestarted).toContain("The worker restarted while preparing the read's pictures. The read itself is complete and kept.");
    expect(saidRestarted).not.toContain("The last new read stopped:");
  });

  it("does not say an icon was matched when none was", () => {
    const unmatched: AssetSheet = { ...sheet, assets: [{ ...sheet.assets[1]!, icon: { name: "dot", by: "unknown" }, flags: ["No icon in TAWD's set matches \"Gizmo\"."] }, { ...sheet.assets[1]!, id: "b3-blank", icon: null, flags: ["The icon b3-blank has no word beside it."] }] };
    const said = text(renderToStaticMarkup(<NewDesignRead projectId="p1" view={view({ runId: sheet.runId, sheet: unmatched, base })} />));
    expect(said).not.toContain("matched to TAWD's icons");
    expect(said.match(/No picture, and no icon matched \(see the note\)/g)).toHaveLength(2);
    expect(said).toContain("Icon: dot (no match: TAWD's plain dot)");
  });

  it("counts pictures that could not be cut apart from those that were", () => {
    const notCut: AssetSheet = { ...sheet, assets: [sheet.assets[0]!, { ...sheet.assets[2]!, id: "b4-off", file: null, width: null, height: null, flags: ["The box for b4-off is not fully inside the design, so it was not cut; correct the box."] }] };
    const said = text(renderToStaticMarkup(<NewDesignRead projectId="p1" view={view({ runId: sheet.runId, sheet: notCut, base })} />));
    expect(said).toContain("The read named 2 pictures: 1 cut from the design and prepared by kind, 1 that could not be cut; 2 need a look");
  });

  it("says the pictures couldn't be loaded, not that they were never prepared, when only reading them failed", () => {
    const said = text(renderToStaticMarkup(<NewDesignRead projectId="p1" view={view({ runId: sheet.runId, sheet: null, base, loadFailed: true })} />));
    expect(said).toContain("This read's pictures couldn't be loaded just now. Reload the page to try again.");
    expect(said).not.toContain("paid read");
  });

  it("shows no pictures section for a read saved before pictures were prepared", () => {
    expect(text(renderToStaticMarkup(<NewDesignRead projectId="p1" view={view(null)} />))).not.toContain("Pictures from the design");
  });
});
