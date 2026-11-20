import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Shutterstock previews in mockups (26 September 2026, overnight), with a
  stand-in for Shutterstock: nothing here calls the real service. Frames
  the builder marks with a search phrase are filled with a watermarked
  preview and a visible label; each phrase is looked up once per project;
  without the keys nothing changes.
*/

import { setDbForTesting, type Database } from "@tawd/core/db";
import { stockPicture } from "@tawd/core/schema";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import {
  SITE_PHOTO_CAPTION,
  STOCK_LABEL,
  applyStockPictures,
  buildSharedSystemPrompt,
  normalizeStockQuery,
  stampStockPicks,
  stockPicks,
  stockQueries,
} from "@tawd/core/mockups";
import { createProject } from "@/lib/projects";
import { deleteProject } from "@/lib/project-deletion";

import { conceptFinalHtml, withImages } from "../../../worker/src/pipeline";
import {
  StockPictures,
  isShutterstockPreviewUrl,
  setStockClientForTesting,
  shutterstockClient,
  stockClientFromEnv,
  subjectScore,
  type StockClient,
} from "../../../worker/src/stock";

import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

let h: Harness;
let r2: FakeR2;

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  r2 = new FakeR2();
  setStorageForTesting(r2);
});

afterEach(async () => {
  setStockClientForTesting(undefined);
  vi.unstubAllGlobals();
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const PAGE = `<!doctype html><html><head><style>.frame{aspect-ratio:4/3}</style></head><body>
<header><img src="tawd-asset:logo" alt="Logo"></header>
<section><div class="frame" data-tawd-photo="Plumber repairing kitchen sink" style="border:2px dashed #999">
  <span>Photo: plumber at work under a sink</span><div><b>nested</b></div>
</div></section>
<section><figure class="frame" data-tawd-photo="plumber repairing  kitchen sink">Photo: the same kind of shot</figure>
<div class="frame">Photo: the crew and their truck</div>
<img data-tawd-photo="water heater" src="x.png" alt=""></section>
</body></html>`;

function fakeClient(answers: Record<string, string | null | Error>) {
  const calls: string[] = [];
  const client: StockClient = {
    async search(query) {
      calls.push(query);
      const answer = answers[query];
      if (answer instanceof Error) throw answer;
      return answer ? { id: answer, description: `A picture of ${query}`, previewUrl: `https://image.shutterstock.com/${answer}.jpg` } : null;
    },
    async download() {
      return JPEG;
    },
  };
  return { client, calls };
}

describe("the frames on the page", () => {
  it("reads each phrase once, tidied, and never from an img", () => {
    expect(normalizeStockQuery("  Plumber &amp; Truck, at  WORK! ")).toBe("plumber & truck at work");
    expect(stockQueries(PAGE)).toEqual(["plumber repairing kitchen sink"]);
  });

  it("fills a frame with the preview and a visible label, keeping its own style, and leaves the rest", () => {
    const out = applyStockPictures(PAGE, { "plumber repairing kitchen sink": { id: "123", dataUri: "data:image/jpeg;base64,AAA" } });
    expect(out.match(/data-tawd-stock="123"/g)).toHaveLength(2);
    expect(out.match(new RegExp(STOCK_LABEL, "g"))).toHaveLength(2);
    expect(out).toContain('style="border:2px dashed #999;position:relative;overflow:hidden;min-height:200px;border:0;"');
    expect(out).not.toContain("Photo: plumber at work under a sink");
    expect(out).not.toContain("<b>nested</b>");
    expect(out).toContain("not the client's photo");
    // Frames for the client's own crew, and anything that isn't a phrase frame, are untouched.
    expect(out).toContain('<div class="frame">Photo: the crew and their truck</div>');
    expect(out).toContain('<img data-tawd-photo="water heater" src="x.png" alt="">');
    expect(out).toContain("</section>\n</body></html>");
    expect(applyStockPictures(PAGE, {})).toBe(PAGE);
  });

  it("tells the builder to mark general scenes only, and never the client's own people or premises", () => {
    const system = buildSharedSystemPrompt("profile");
    expect(system).toContain('data-tawd-photo="a short stock photo search phrase"');
    expect(system).toContain("own people, premises, vehicles or finished work");
  });
});

describe("gap 14: a concept's rendered page carries the site photo's old alt, by code", () => {
  // The token source storeVersion saves beside the render is its input `html`, untouched (a separate
  // write that needs a browser to exercise); this test covers the rendered half, conceptFinalHtml.
  it("the rendered page gets the old alt and the inlined image", () => {
    const assets = [
      { token: "tawd-asset:photo-site-1", kind: "photo" as const, caption: `${SITE_PHOTO_CAPTION}: Patio awning in Folsom`, fileName: "s.jpg", width: 800, height: 600, dataUri: "data:image/jpeg;base64,AAA" },
    ];
    const source = '<html><body><img src="tawd-asset:photo-site-1" alt="builder wrote this"></body></html>';
    const rendered = conceptFinalHtml(source, assets as never);
    expect(rendered).toContain('alt="Patio awning in Folsom"');
    expect(rendered).toContain("data:image/jpeg;base64,AAA");
    expect(rendered).not.toContain("builder wrote this");
  });
});

describe("looking pictures up", () => {
  it("searches each phrase once per project, keeps the preview under the project, and remembers it for the next run", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, {
      clientName: "Sacramento Drain Pros",
      trade: "plumbing",
      tier: "starter",
      lane: "lane_1",
      laneOption: null,
      conceptCount: 3,
      status: "mockups",
      memberUserIds: [],
    });
    const { client, calls } = fakeClient({ "plumber repairing kitchen sink": "555" });
    const first = new StockPictures(h.db as never, r2 as never, id, client);
    await first.ensure(PAGE);
    await first.ensure(PAGE);
    expect(calls).toEqual(["plumber repairing kitchen sink"]);
    expect(r2.objects.has(`projects/${id}/stock/555.jpg`)).toBe(true);
    expect(withImages(PAGE, [], first)).toContain("data:image/jpeg;base64,");

    // A later run reads what was found; Shutterstock isn't asked again.
    const { client: again, calls: againCalls } = fakeClient({});
    const second = new StockPictures(h.db as never, r2 as never, id, again);
    await second.ensure(PAGE);
    expect(againCalls).toEqual([]);
    expect(second.apply(PAGE)).toContain('data-tawd-stock="555"');

    // Deleting the project removes the rows and the pictures.
    await deleteProject(h.ctx, admin.viewer, id, { confirmName: "Sacramento Drain Pros", reason: "Test project, not a client" });
    expect(await h.db.select().from(stockPicture)).toEqual([]);
    expect([...r2.objects.keys()].some((k) => k.includes("/stock/"))).toBe(false);
  });

  it("remembers no match, tries a failed search again, and leaves the frame as it was meanwhile", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, {
      clientName: "Rio Glass",
      trade: "glass_and_windows",
      tier: "starter",
      lane: "lane_1",
      laneOption: null,
      conceptCount: 3,
      status: "mockups",
      memberUserIds: [],
    });
    const page = '<html><body><section><div data-tawd-photo="glass shower door">Photo</div><div data-tawd-photo="storefront window repair">Photo</div></section></body></html>';
    const { client, calls } = fakeClient({ "glass shower door": null, "storefront window repair": new Error("Shutterstock search answered 503.") });
    const box = new StockPictures(h.db as never, r2 as never, id, client);
    await box.ensure(page);
    expect(box.apply(page)).toBe(page);
    const rows = await h.db.select().from(stockPicture).where(eq(stockPicture.projectId, id));
    expect(rows.map((r) => [r.query, r.status, r.failureReason]).sort()).toEqual([
      ["glass shower door", "none", null],
      ["storefront window repair", "failed", "Shutterstock search answered 503."],
    ]);

    const { client: later, calls: laterCalls } = fakeClient({ "storefront window repair": "777" });
    const next = new StockPictures(h.db as never, r2 as never, id, later);
    await next.ensure(page);
    expect(laterCalls).toEqual(["storefront window repair"]);
    expect(next.apply(page)).toContain('data-tawd-stock="777"');
    // "glass shower door" found nothing, so its last words were tried too (8 October 2026).
    expect(calls).toEqual(["glass shower door", "shower door", "storefront window repair"]);
  });

  // #2 from a client run (7 November 2026): "lattice patio cover" came back a wooden
  // garden trellis — the pick was the first non-clashing hit, never checked against the subject.
  it("picks the hit whose description matches the frame's subject, but never trades a brand clash for it", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, {
      clientName: "Clear Sky Awning",
      trade: "plumbing",
      tier: "starter",
      lane: "lane_1",
      laneOption: null,
      conceptCount: 3,
      status: "mockups",
      memberUserIds: [],
    });
    const hit = (hid: string, description: string) => ({ id: hid, description, previewUrl: `https://image.shutterstock.com/${hid}.jpg` });
    const byQuery: Record<string, ReturnType<typeof hit>[]> = {
      // Shutterstock's own order puts the wrong subject first; the description that matches the label must win.
      "aluminum lattice patio cover": [hit("1", "Wooden garden trellis with climbing roses"), hit("2", "Aluminum lattice patio cover over a backyard seating area")],
      // The best subject match wears a red uniform (not a brand colour): the clean weaker match wins instead.
      "roof mount awning": [hit("9", "Technician in red uniform fixing a roof mount awning"), hit("8", "Striped awning over a shop window")],
      // CodeRabbit on PR #50: the full phrase finds nothing, so the LAST-TWO-WORDS fallback is asked —
      // the hits must still be ranked against the FULL original label ("steel lattice"), not the fallback.
      "terrace cover": [hit("3", "Terrace cover in a garden"), hit("4", "Steel lattice terrace cover in a garden")],
    };
    const client: StockClient = {
      async search(query) {
        return byQuery[query]?.[0] ?? null;
      },
      async searchAll(query) {
        return byQuery[query] ?? [];
      },
      async download() {
        return JPEG;
      },
    };
    const page =
      '<html><body><div data-tawd-photo="aluminum lattice patio cover">Photo</div><div data-tawd-photo="roof mount awning">Photo</div></body></html>';
    const box = new StockPictures(h.db as never, r2 as never, id, client, { colors: ["#12305A"], competitors: [] });
    await box.ensure(page);
    const out = box.apply(page);
    expect(out).toContain('data-tawd-stock="2"');
    expect(out).toContain('data-tawd-stock="8"');
    expect(out).not.toContain('data-tawd-stock="1"');
    expect(out).not.toContain('data-tawd-stock="9"');
    // The chosen pictures are clean, so nothing is flagged for the team.
    expect(box.issues(page)).toEqual([]);

    // "steel lattice terrace cover" finds nothing; the fallback search asks "terrace cover" —
    // and its hits are still ranked against the full original label, so the steel lattice wins.
    const fallbackPage = '<html><body><div data-tawd-photo="steel lattice terrace cover">Photo</div></body></html>';
    await box.ensure(fallbackPage);
    const fallbackOut = box.apply(fallbackPage);
    expect(fallbackOut).toContain('data-tawd-stock="4"');
    expect(fallbackOut).not.toContain('data-tawd-stock="3"');
  });

  it("scores a hit by the label's own distinctive words: filler dropped, plurals folded, no description is zero", () => {
    expect(subjectScore("Aluminum lattice patio cover over a seating area", "aluminum lattice patio cover")).toBe(4);
    expect(subjectScore("Patio covers in a sunny backyard", "aluminum lattice patio cover")).toBe(2);
    expect(subjectScore("Wooden garden trellis with climbing roses", "aluminum lattice patio cover")).toBe(0);
    expect(subjectScore(null, "aluminum lattice patio cover")).toBe(0);
    // Filler carries no weight: only the subject words count.
    expect(subjectScore("Over and over with the same thing", "over with the works")).toBe(0);
  });

  it("does nothing without the keys", async () => {
    vi.stubEnv("SHUTTERSTOCK_CLIENT_ID", "");
    vi.stubEnv("SHUTTERSTOCK_CLIENT_SECRET", "");
    expect(stockClientFromEnv()).toBeNull();
    vi.unstubAllEnvs();
    const box = new StockPictures(h.db as never, r2 as never, "00000000-0000-4000-8000-000000000000", null);
    await box.ensure(PAGE);
    expect(box.apply(PAGE)).toBe(PAGE);
  });
});

describe("the Shutterstock client", () => {
  it("searches photos with the keys, takes the 1000px watermarked preview, and downloads only from Shutterstock", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url, auth: headers.get("Authorization") });
      if (url.startsWith("https://api.shutterstock.com/")) {
        return new Response(
          JSON.stringify({ data: [{ id: "98765", description: "Plumber fixing a sink", assets: { preview: { url: "https://image.shutterstock.com/small.jpg" }, preview_1000: { url: "https://ak.picdn.net/shutterstock/photos/98765/watermark_1000.jpg" } } }] }),
          { status: 200 },
        );
      }
      return new Response(JPEG, { status: 200 });
    });
    const client = shutterstockClient("id-1", "secret-2");
    const hit = await client.search("plumber repairing kitchen sink");
    expect(hit).toEqual({ id: "98765", description: "Plumber fixing a sink", previewUrl: "https://ak.picdn.net/shutterstock/photos/98765/watermark_1000.jpg" });
    const search = new URL(seen[0]!.url);
    expect(search.pathname).toBe("/v2/images/search");
    expect(search.searchParams.get("query")).toBe("plumber repairing kitchen sink");
    expect(search.searchParams.get("image_type")).toBe("photo");
    expect(search.searchParams.get("safe")).toBe("true");
    expect(seen[0]!.auth).toBe(`Basic ${Buffer.from("id-1:secret-2").toString("base64")}`);
    expect(await client.download(hit!.previewUrl)).toEqual(JPEG);
    // The keys go to the search only, never to the picture's host.
    expect(seen[1]!.auth).toBeNull();

    await expect(client.download("https://evil.example/x.jpg")).rejects.toThrow("not on a Shutterstock address");
    expect(isShutterstockPreviewUrl("http://image.shutterstock.com/x.jpg")).toBe(false);
    expect(isShutterstockPreviewUrl("https://shutterstock.com.evil.example/x.jpg")).toBe(false);
  });

  it("says plainly when Shutterstock refuses the keys", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));
    await expect(shutterstockClient("a", "b").search("x")).rejects.toThrow("Shutterstock refused the keys");
  });
});

/*
  Stage 1 of docs/plans/self-check.md: the stock picker says what it settled.

  A frame can be given a picture that answers a simpler question than it
  asked (the fallback searches), or one whose description shares no word
  with the frame at all. Both were silent, so the Creative Director saw a
  photo that did not suit its place and marked the concept down for a
  choice the builder never made.
*/
function describingClient(answers: Record<string, { id: string; description: string } | null>) {
  const calls: string[] = [];
  const client: StockClient = {
    async search(query) {
      calls.push(query);
      const answer = answers[query];
      return answer ? { id: answer.id, description: answer.description, previewUrl: `https://image.shutterstock.com/${answer.id}.jpg` } : null;
    },
    async download() {
      return JPEG;
    },
  };
  return { client, calls };
}

describe("what the stock picker says it did", () => {
  const project = async () => {
    const admin = await seedAdmin(h);
    return createProject(h.ctx, admin.viewer, {
      clientName: "Clear Sky Awning",
      trade: "home_services",
      tier: "starter",
      lane: "lane_1",
      laneOption: null,
      conceptCount: 2,
      status: "mockups",
      memberUserIds: [],
    });
  };

  /*
    CodeRabbit on PR #64, and it was right: when this was recorded only while
    searching, the note appeared on the version that searched and silently
    vanished from every later one - a reporting mechanism that stops
    reporting. It is worked out from the picture's saved description now.
  */
  it("still says it on a later run, when the picture is loaded rather than searched for", async () => {
    const id = await project();
    const page = '<html><body><div data-tawd-photo="retractable awning">Photo</div></body></html>';
    const { client } = describingClient({ "retractable awning": { id: "904", description: "A wooden garden trellis in summer" } });
    const first = new StockPictures(h.db as never, r2 as never, id, client);
    await first.ensure(page);
    expect(first.runNotes(page)).toHaveLength(1);

    // A later version of the same concept: nothing is searched, and the note must still be there.
    const { client: quiet, calls } = describingClient({});
    const later = new StockPictures(h.db as never, r2 as never, id, quiet);
    await later.ensure(page);
    expect(calls).toEqual([]);
    expect(later.runNotes(page)).toEqual(first.runNotes(page));
  });

  it("says when the picture it used matches none of the frame's own words", async () => {
    const id = await project();
    const page = '<html><body><div data-tawd-photo="retractable awning">Photo</div></body></html>';
    const { client } = describingClient({ "retractable awning": { id: "902", description: "A wooden garden trellis in summer" } });
    const box = new StockPictures(h.db as never, r2 as never, id, client);
    await box.ensure(page);
    const notes = box.runNotes(page);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.action).toBe("chose");
    // CodeRabbit on PR #64: subjectScore drops short words, so "shares no word" was an
    // overstatement - a frame "AC repair" and a picture "AC technician" do share one.
    expect(notes[0]!.with).toContain("none of that phrase's own subject words");
    // CodeRabbit on PR #64: it must not claim no matching answer existed - one can be passed
    // over for a brand clash - so it says only what is true of the picture TAWD used.
    expect(notes[0]!.why).toContain("the best of the answers TAWD could use");
    expect(notes[0]!.why).not.toContain("no answer");
  });

  it("says nothing when the frame's own phrase found a picture of its subject", async () => {
    const id = await project();
    const page = '<html><body><div data-tawd-photo="retractable awning">Photo</div></body></html>';
    const { client } = describingClient({ "retractable awning": { id: "903", description: "A retractable awning over a patio" } });
    const box = new StockPictures(h.db as never, r2 as never, id, client);
    await box.ensure(page);
    expect(box.runNotes(page)).toEqual([]);
  });

  it("says nothing about a frame that never got a picture", async () => {
    const id = await project();
    const page = '<html><body><div data-tawd-photo="retractable awning">Photo</div></body></html>';
    const { client } = describingClient({ "retractable awning": null });
    const box = new StockPictures(h.db as never, r2 as never, id, client);
    await box.ensure(page);
    expect(box.runNotes(page)).toEqual([]);
  });
});

/*
  F28 (a client's site, 9 November 2026): two concepts in one project were handed
  the same photograph for the same phrase. The search is saved per project
  and only its winner was kept, so the second concept had nothing else to
  take - a code-level guarantee that the concepts looked alike.

  The search now keeps every answer it got, each concept takes a different
  one, and the concept's own pick is written into its stored page, so a
  later render loads that one without knowing which concept it is.
*/
describe("two concepts asking for the same photograph", () => {
  const PHRASE = "lattice patio cover";
  const page = `<html><body><div data-tawd-photo="${PHRASE}">Photo</div></body></html>`;

  const threeHits = () => {
    const hit = (hid: string, description: string) => ({ id: hid, description, previewUrl: `https://image.shutterstock.com/${hid}.jpg` });
    const hits = [hit("1", "Lattice patio cover over a deck"), hit("2", "Lattice patio cover in a backyard"), hit("3", "Lattice patio cover at dusk")];
    let searches = 0;
    const client: StockClient = {
      async search() {
        searches += 1;
        return hits[0]!;
      },
      async searchAll() {
        searches += 1;
        return hits;
      },
      async download() {
        return JPEG;
      },
    };
    return { client, searches: () => searches };
  };

  const projectFor = async () => {
    const admin = await seedAdmin(h);
    return createProject(h.ctx, admin.viewer, {
      clientName: "Clear Sky Awning",
      trade: "home_services",
      tier: "starter",
      lane: "lane_1",
      laneOption: null,
      conceptCount: 2,
      status: "mockups",
      memberUserIds: [],
    });
  };

  it("gives each concept a different picture, and asks Shutterstock only once", async () => {
    const id = await projectFor();
    const { client, searches } = threeHits();

    const a = new StockPictures(h.db as never, r2 as never, id, client, undefined, "concept-a");
    await a.ensure(page);
    const b = new StockPictures(h.db as never, r2 as never, id, client, undefined, "concept-b");
    await b.ensure(page);

    expect(a.picks()[PHRASE]).toBe("1");
    expect(b.picks()[PHRASE]).toBe("2");
    // The second concept cost nothing: the first search's other answers were kept.
    expect(searches()).toBe(1);
  });

  it("keeps a concept's own picture on a later run, so a fix round never swaps the photographs", async () => {
    const id = await projectFor();
    const { client } = threeHits();
    const first = new StockPictures(h.db as never, r2 as never, id, client, undefined, "concept-b");
    await first.ensure(page);
    const mine = first.picks()[PHRASE];

    const again = new StockPictures(h.db as never, r2 as never, id, client, undefined, "concept-b");
    await again.ensure(page);
    expect(again.picks()[PHRASE]).toBe(mine);
  });

  it("loads what the stored page says it took, whoever is asking", async () => {
    const id = await projectFor();
    const { client } = threeHits();
    // Concept A takes the search's winner first, so B's own pick is the second answer.
    const a = new StockPictures(h.db as never, r2 as never, id, client, undefined, "concept-a");
    await a.ensure(page);
    const b = new StockPictures(h.db as never, r2 as never, id, client, undefined, "concept-b");
    await b.ensure(page);
    const stamped = stampStockPicks(page, b.picks());
    expect(stockPicks(stamped)[PHRASE]).toBe("2");

    // The review and the polish pass have no concept in hand; the page tells them.
    const anyone = new StockPictures(h.db as never, r2 as never, id, client);
    await anyone.ensure(stamped);
    expect(anyone.picks()[PHRASE]).toBe("2");
    expect(anyone.apply(stamped)).toContain('data-tawd-stock="2"');
  });

  it("shares a picture again rather than leaving a frame empty when the answers run out", async () => {
    const id = await projectFor();
    const { client } = threeHits();
    for (const concept of ["a", "b", "c"]) {
      const box = new StockPictures(h.db as never, r2 as never, id, client, undefined, `concept-${concept}`);
      await box.ensure(page);
      expect(box.picks()[PHRASE]).toBeTruthy();
    }
    const fourth = new StockPictures(h.db as never, r2 as never, id, client, undefined, "concept-d");
    await fourth.ensure(page);
    // Three answers, four concepts: the fourth repeats rather than showing a blank box.
    expect(["1", "2", "3"]).toContain(fourth.picks()[PHRASE]);
  });
});

/*
  The second run, which is where my hand reviews keep missing things
  (Jason, 9 November 2026). Everything written while a page is being made
  has to still be true when that page is loaded back, and has to still be
  true for the concept beside it.
*/
describe("F28 on a later run, not just the first", () => {
  const PHRASE = "lattice patio cover";
  const page = `<html><body><div data-tawd-photo="${PHRASE}">Photo</div></body></html>`;
  const hit = (hid: string) => ({ id: hid, description: `Lattice patio cover number ${hid}`, previewUrl: `https://image.shutterstock.com/${hid}.jpg` });

  const silent = () => {
    const calls: string[] = [];
    const client: StockClient = {
      async search(query) {
        calls.push(query);
        return hit("1");
      },
      async searchAll(query) {
        calls.push(query);
        return [hit("1"), hit("2"), hit("3")];
      },
      async download() {
        return JPEG;
      },
    };
    return { client, calls };
  };

  const projectFor = async () => {
    const admin = await seedAdmin(h);
    return createProject(h.ctx, admin.viewer, {
      clientName: "Clear Sky Awning",
      trade: "home_services",
      tier: "starter",
      lane: "lane_1",
      laneOption: null,
      conceptCount: 2,
      status: "mockups",
      memberUserIds: [],
    });
  };

  /*
    The state this guards is a project whose concepts were built before the
    picks were written down: the row has its answers but nobody is recorded
    as having taken one, while a concept's page already names its own. If
    reading the page does not also write it down, the sibling sees nothing
    spoken for and takes the same photograph - F28 let back in through the
    path that reads the page.

    Proved to fail without the write, not assumed to.
  */
  it("writes down a pick it read off the page, so a sibling can't take the same picture", async () => {
    const id = await projectFor();
    const { client } = silent();

    // One concept's work, then the record of who took what is wiped: a row from before this change.
    const a = new StockPictures(h.db as never, r2 as never, id, client, undefined, "concept-a");
    await a.ensure(page);
    const mine = a.picks()[PHRASE]!;
    await h.db.update(stockPicture).set({ takenBy: {} }).where(eq(stockPicture.projectId, id));

    // A later render of concept A, resolving from its own stamped page.
    const stampedA = stampStockPicks(page, { [PHRASE]: mine });
    const aAgain = new StockPictures(h.db as never, r2 as never, id, client, undefined, "concept-a");
    await aAgain.ensure(stampedA);
    expect(aAgain.picks()[PHRASE]).toBe(mine);

    // Now the sibling asks. It must not be handed concept A's photograph.
    const b = new StockPictures(h.db as never, r2 as never, id, client, undefined, "concept-b");
    await b.ensure(page);
    expect(b.picks()[PHRASE]).not.toBe(mine);
  });

  it("asks Shutterstock nothing on a later run, however many concepts render", async () => {
    const id = await projectFor();
    const { client, calls } = silent();
    for (const name of ["concept-a", "concept-b"]) {
      const box = new StockPictures(h.db as never, r2 as never, id, client, undefined, name);
      await box.ensure(page);
    }
    const searched = calls.length;

    // Every later render: the review, the polish pass, a changes run.
    for (const name of [null, "concept-a", "concept-b"]) {
      const box = new StockPictures(h.db as never, r2 as never, id, client, undefined, name ?? undefined);
      await box.ensure(page);
      expect(box.picks()[PHRASE]).toBeTruthy();
    }
    expect(calls.length).toBe(searched);
  });
});

/*
  CodeRabbit on PR #65, and it was right where a comment of mine was wrong.
  CONCEPT_QUEUE runs two concept jobs at once by default
  (TAWD_CONCEPTS_AT_ONCE), so two siblings can read the same empty taken_by,
  pick the same picture and overwrite each other. F28 would have passed
  every sequential test and still failed in production. Choosing happens
  inside a transaction on a locked row now.

  WHAT THIS TEST DOES AND DOES NOT PROVE. It proves the choosing logic and
  the stored record agree when two siblings ask without waiting for each
  other. It does NOT prove the row lock: these tests run on PGlite, which is
  one in-process connection, so two transactions cannot truly interleave and
  this test passes with the lock removed (checked). The lock is argued from
  the queue's concurrency and the code, not from here. A real proof needs
  two connections to a real Postgres, which this suite does not have.
*/
describe("two concepts choosing without waiting for each other", () => {
  const PHRASE = "lattice patio cover";
  const page = `<html><body><div data-tawd-photo="${PHRASE}">Photo</div></body></html>`;

  it("gives them different pictures, and the record agrees with what each shows", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, {
      clientName: "Clear Sky Awning",
      trade: "home_services",
      tier: "starter",
      lane: "lane_1",
      laneOption: null,
      conceptCount: 2,
      status: "mockups",
      memberUserIds: [],
    });
    const hit = (hid: string) => ({ id: hid, description: `Lattice patio cover ${hid}`, previewUrl: `https://image.shutterstock.com/${hid}.jpg` });
    const client: StockClient = {
      async search() {
        return hit("1");
      },
      async searchAll() {
        return [hit("1"), hit("2"), hit("3")];
      },
      async download() {
        return JPEG;
      },
    };

    // One search first, so both siblings are choosing from the same stored answers.
    const seed = new StockPictures(h.db as never, r2 as never, id, client, undefined, "concept-seed");
    await seed.ensure(page);

    const a = new StockPictures(h.db as never, r2 as never, id, client, undefined, "concept-a");
    const b = new StockPictures(h.db as never, r2 as never, id, client, undefined, "concept-b");
    await Promise.all([a.ensure(page), b.ensure(page)]);

    expect(a.picks()[PHRASE]).toBeTruthy();
    expect(b.picks()[PHRASE]).toBeTruthy();
    expect(a.picks()[PHRASE]).not.toBe(b.picks()[PHRASE]);

    // And the record agrees with what each of them is showing.
    const [row] = await h.db.select().from(stockPicture).where(eq(stockPicture.projectId, id));
    const taken = (row!.takenBy ?? {}) as Record<string, string>;
    expect(taken["concept-a"]).toBe(a.picks()[PHRASE]);
    expect(taken["concept-b"]).toBe(b.picks()[PHRASE]);
  });
});
