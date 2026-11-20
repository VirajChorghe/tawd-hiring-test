import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  F-033 and F-052 (audit, November 2026): a NUL byte or half an emoji in a
  scraped page made the jsonb write throw, so the read failed for good with
  "stopped unexpectedly"; an empty page was blamed on JavaScript; and every
  page was decoded as UTF-8 whatever it declared. No network, no AI.
*/

const state: { user: unknown } = { user: null };
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/projects",
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("@/lib/session", () => ({ requireUser: async () => state.user }));

import { eq } from "drizzle-orm";
import { setDbForTesting, type Database } from "@tawd/core/db";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { SITE_READ_JOB, type SiteReadJobData } from "@tawd/core/queue";
import { siteImport } from "@tawd/core/schema";
import { storable, storableText } from "@tawd/core/text-safe";
import { setQueueForTesting } from "@/lib/mockups";
import { createProject } from "@/lib/projects";
import { syncSiteRead } from "@/lib/site-read";
import { runSiteReadJob, setSiteReadStandInsForTesting, type HomeLooker } from "../../../worker/src/site-read";
import { decodeBody } from "../../../worker/src/read-limited";
import { setLookupForTesting } from "../../../worker/src/liked-sites";
import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

let h: Harness;
let r2: FakeR2;
let queued: { name: string; data: SiteReadJobData }[];

const look: HomeLooker = async () => ({ title: "Acme", menu: [], sections: [], phones: [], testimonials: [] });
const SITE = "https://www.acmepest.example";

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  r2 = new FakeR2();
  setStorageForTesting(r2);
  queued = [];
  setQueueForTesting({ add: async (name, data) => void queued.push({ name, data: data as SiteReadJobData }), getJob: async () => null });
  setLookupForTesting(async () => ["93.184.216.34"]);
});

afterEach(async () => {
  state.user = null;
  setQueueForTesting(null);
  setLookupForTesting(null);
  setSiteReadStandInsForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

/** A one-page site answering with the given bytes and content type for every address except robots and sitemaps. */
function oneSite(bytes: Buffer, contentType: string): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (/robots|sitemap/.test(url)) return new Response("", { status: 404, headers: { "content-type": "text/plain" } });
    return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": contentType } });
  }) as typeof fetch;
}

const body = (title: string, heading: string, text: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${heading}</h1><p>${text}</p><p>Licensed technicians inspect your home, treat the problem at its source and come back at no extra charge if pests return.</p></main></body></html>`;

async function readWith(fetchStand: typeof fetch) {
  const admin = await seedAdmin(h);
  state.user = admin.viewer;
  const id = await createProject(h.ctx, admin.viewer, { clientName: "Acme Pest Control", trade: "pest_control", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 1, status: "content", memberUserIds: [] } as never);
  await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Acme Pest Control" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "website", { currentWebsiteUrl: SITE });
  await saveIntakeSection(h.ctx, admin.viewer, id, "content", { mode: "auto" });
  setSiteReadStandInsForTesting({ fetch: fetchStand, wait: async () => undefined, look });
  await syncSiteRead(h.ctx, id);
  await runSiteReadJob(queued.filter((q) => q.name === SITE_READ_JOB).at(-1)!.data);
  const [row] = await h.db.select().from(siteImport).where(eq(siteImport.projectId, id));
  return row!;
}

describe("storable text", () => {
  it("removes NUL bytes and lone surrogates and keeps real emoji, accents and everything else", () => {
    expect(storableText("Home\u0000page")).toBe("Homepage");
    expect(storableText("Home \ud83d page")).toBe("Home  page");
    expect(storableText("Home \ude00 page")).toBe("Home  page");
    expect(storableText("Home 🚰 café “quoted”")).toBe("Home 🚰 café “quoted”");
    expect(storableText("a\ud83d")).toBe("a");
  });

  it("cleans every string in an object, array or key, and leaves numbers, booleans and null alone", () => {
    const value = { "k\u0000ey": ["a\u0000", { n: 1, ok: true, none: null, s: "x\ud83dy" }] };
    expect(storable(value)).toEqual({ key: ["a", { n: 1, ok: true, none: null, s: "xy" }] });
  });
});

describe("decoding by the declared charset", () => {
  const cafe1252 = Buffer.concat([Buffer.from("<p>caf"), Buffer.from([0xe9]), Buffer.from(" "), Buffer.from([0x93]), Buffer.from("quoted"), Buffer.from([0x94]), Buffer.from("</p>")]);
  const want = "<p>café “quoted”</p>";

  it("uses the Content-Type charset", () => {
    expect(decodeBody(cafe1252, "text/html; charset=windows-1252")).toBe(want);
    expect(decodeBody(cafe1252, 'text/html; charset="Windows-1252"')).toBe(want);
    expect(decodeBody(Buffer.from([0x63, 0x61, 0x66, 0xe9]), "text/html; charset=iso-8859-1")).toBe("café");
  });

  it("uses the page's meta charset or http-equiv in the first 1024 bytes when the header has none", () => {
    const meta = Buffer.concat([Buffer.from('<html><head><meta charset="windows-1252"></head>'), cafe1252]);
    expect(decodeBody(meta, "text/html")).toContain("café “quoted”");
    const equiv = Buffer.concat([Buffer.from('<html><head><meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1"></head>'), Buffer.from([0x63, 0x61, 0x66, 0xe9])]);
    expect(decodeBody(equiv, "")).toContain("café");
    expect(decodeBody(equiv, null)).toContain("café");
  });

  it("the header wins over the page, and UTF-8 is the default (including for unknown labels)", () => {
    const utf8 = Buffer.from("<p>café 🚰</p>", "utf8");
    expect(decodeBody(utf8, "text/html")).toBe("<p>café 🚰</p>");
    expect(decodeBody(utf8, "text/html; charset=utf-8")).toBe("<p>café 🚰</p>");
    expect(decodeBody(utf8, "text/html; charset=no-such-charset")).toBe("<p>café 🚰</p>");
    const confused = Buffer.concat([Buffer.from('<meta charset="windows-1252">'), utf8]);
    expect(decodeBody(confused, "text/html; charset=utf-8")).toContain("café 🚰");
    // Past the first 1024 bytes a meta tag isn't looked for.
    const late = Buffer.concat([Buffer.alloc(1100, 32), Buffer.from('<meta charset="windows-1252">'), utf8]);
    expect(decodeBody(late, "text/html")).toContain("café 🚰");
  });
});

describe("a read of odd pages", () => {
  it("a NUL byte and half an emoji in a title or heading: the read is done and the words are saved clean", async () => {
    const page = Buffer.from(body("Acme\u0000 Pest", "Pest Control \ud83d in Folsom", "We treat ants, spiders and rodents all year round \u0000 for local homes."), "utf8");
    const done = await readWith(oneSite(page, "text/html; charset=utf-8"));
    expect(done.status).toBe("done");
    expect(done.failureReason).toBeNull();
    const text = JSON.stringify(done.pages);
    expect(text).toContain("Acme Pest");
    expect(text).not.toContain("\\u0000");
    expect(text).not.toMatch(/\\ud83d(?!\\ude)/i);
    for (const [key, saved] of r2.objects) {
      if (key.endsWith(".json")) expect(saved.toString("utf8")).not.toContain("\\u0000");
    }
  });

  it("a page served as windows-1252 keeps its accents and curly quotes", async () => {
    const html = body("Café Pest", "Café pest control in Folsom", "We say “no pests” and mean it — licensed, local, insured, and ready to treat your home this week.");
    const latin = Buffer.from(html.replace(/“/g, "\x93").replace(/”/g, "\x94").replace(/—/g, "\x97").replace(/é/g, "\xe9"), "latin1");
    const done = await readWith(oneSite(latin, "text/html; charset=windows-1252"));
    expect(done.status).toBe("done");
    const first = (done.pages as { title: string; h1s: string[] }[])[0]!;
    expect(first.title).toBe("Café Pest");
    expect(first.h1s[0]).toBe("Café pest control in Folsom");
    const kept = [...r2.objects].filter(([key]) => key.endsWith(".json")).map(([, v]) => v.toString("utf8")).join("");
    expect(kept).toContain("“no pests”");
    expect(kept).not.toContain("�");
  });

  it("a page with nothing on it is reported as empty, not as JavaScript", async () => {
    const done = await readWith(oneSite(Buffer.from("<html><head></head><body></body></html>"), "text/html"));
    expect(done.status).toBe("failed");
    expect(done.failureReason).toMatch(/empty/i);
    expect(done.failureReason).not.toMatch(/JavaScript/);
  });

  it("a page with a title but no words is still blamed on JavaScript", async () => {
    const done = await readWith(oneSite(Buffer.from("<html><head><title>Acme</title></head><body><div id=root></div></body></html>"), "text/html"));
    expect(done.status).toBe("failed");
    expect(done.failureReason).toMatch(/draws its words with JavaScript/);
  });
});
