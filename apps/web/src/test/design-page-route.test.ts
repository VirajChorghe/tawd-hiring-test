import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setDbForTesting, type Database } from "@tawd/core/db";
import { figmaDesign } from "@tawd/core/schema";
import { setStorageForTesting, projectStoragePrefix } from "@tawd/core/intake/storage";
import { readAssetKeys } from "@tawd/core/figma/read-assets";
import { readPageKeys } from "@tawd/core/figma/read-page";
import { createProject } from "@/lib/projects";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

/*
  E5a: the route that shows a built page inside TAWD.

  It exists mostly to be careful about two things, and both are tested
  here. The page is written by the AI and served on TAWD's own address, so
  nothing in it may run or be fetched from anywhere else. And the page's
  own `<img src="p3.png">` has to resolve to a picture of THIS read, which
  is why the page is served at ".../<page>/index.html" and not one level
  up: served there, every picture on every built page 404s, which is what
  Fable's review of E5a found.
*/

let h: Harness;
let r2: FakeR2;
let current: { id: string; isAdmin: boolean } | null = null;

vi.mock("@/lib/session", () => ({
  requireUser: async () => {
    if (!current) throw new Error("not signed in");
    return current;
  },
}));

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  r2 = new FakeR2();
  setStorageForTesting(r2);
});
afterEach(async () => {
  setStorageForTesting(null);
  setDbForTesting(null);
  current = null;
  await h.close();
});

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

async function lane2WithPage() {
  const admin = await seedAdmin(h);
  const id = await createProject(h.ctx, admin.viewer, {
    clientName: "Test Client",
    trade: "plumbing",
    tier: "growth",
    lane: "lane_2",
    laneOption: "a",
    conceptCount: 1,
    status: "intake",
    memberUserIds: [],
  } as never);
  const version = "upload-1";
  await h.db.insert(figmaDesign).values({ projectId: id, url: "upload", fileKey: version, source: "upload", fileName: "design.pdf", importStatus: "done" });
  const runId = `design-read-${id}-1700000000000`;
  await r2.put(
    `${projectStoragePrefix(id)}design-upload/${version}/read-v2/page-1.json`,
    Buffer.from(JSON.stringify({ runId, width: 1000, height: 800, colours: [], notes: [], bands: [] })),
  );
  await r2.put(readPageKeys(id, version, 1, runId).html, Buffer.from('<!doctype html><html><body><img src="p3.png"></body></html>'));
  await r2.put(readAssetKeys(id, version, 1, runId).file("p3.png"), PNG);
  return { admin, id, version, runId };
}

const get = async (id: string, version: string, path: string[]) => {
  const { GET } = await import("@/app/(app)/projects/[id]/design-page/[version]/[page]/[[...path]]/route");
  return GET(new Request("http://localhost/x"), { params: Promise.resolve({ id, version, page: "1", path }) });
};

describe("who may see a built page", () => {
  it("shows it to an admin", async () => {
    const { admin, id, version } = await lane2WithPage();
    current = { id: admin.viewer.id, isAdmin: true };
    const res = await get(id, version, ["index.html"]);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<img src=\"p3.png\">");
  });

  it("gives nothing to anyone else, and does not say the page exists", async () => {
    const { id, version, admin } = await lane2WithPage();
    const member = await seedUser(h, admin.viewer, { email: "designer@example.com", roles: ["web_designer"] });
    current = { id: member.viewer.id, isAdmin: false };
    const res = await get(id, version, ["index.html"]);
    expect(res.status).toBe(404);
  });
});

describe("the page's own pictures", () => {
  /*
    The page writes a plain relative name. Served at ".../1/index.html" the
    browser asks for ".../1/p3.png", which is this route with path
    ["p3.png"]. Served at ".../1" it would ask for ".../upload-1/p3.png"
    instead, and every picture would be missing.
  */
  it("are served from beside the page, which is how the page's own src resolves", async () => {
    const { admin, id, version } = await lane2WithPage();
    current = { id: admin.viewer.id, isAdmin: true };
    const res = await get(id, version, ["p3.png"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  });

  /*
    The asset sheet sits in the same folder as the pictures and really is
    there, so this proves the name rule rather than the file simply being
    absent: without it, "list.json" would be served, and with it the read's
    own sheet stays out of reach of the address bar.
  */
  it("refuse a file that is really there but is not a picture the page may draw", async () => {
    const { admin, id, version, runId } = await lane2WithPage();
    current = { id: admin.viewer.id, isAdmin: true };
    await r2.put(readAssetKeys(id, version, 1, runId).file("list.json"), Buffer.from('{"secret":true}'));
    await r2.put(readAssetKeys(id, version, 1, runId).file("preparing.json"), Buffer.from("{}"));
    for (const name of ["list.json", "preparing.json"]) {
      expect((await get(id, version, [name])).status).toBe(404);
    }
    // And a picture that IS allowed still comes back, so the rule is not simply refusing everything.
    expect((await get(id, version, ["p3.png"])).status).toBe(200);
  });

  it("refuse a name that is not a picture name at all", async () => {
    const { admin, id, version } = await lane2WithPage();
    current = { id: admin.viewer.id, isAdmin: true };
    for (const name of ["../../secret.json", "p3.png.txt", "index.js"]) {
      expect((await get(id, version, [name])).status).toBe(404);
    }
  });

  it("refuse a picture of another read", async () => {
    const { admin, id, version } = await lane2WithPage();
    current = { id: admin.viewer.id, isAdmin: true };
    // A file under a different read's folder is not reachable: the runId comes from the saved read.
    await r2.put(readAssetKeys(id, version, 1, `design-read-${id}-1600000000000`).file("p9.png"), PNG);
    expect((await get(id, version, ["p9.png"])).status).toBe(404);
  });
});

describe("what the page is allowed to do", () => {
  it("may not run anything or fetch anything from elsewhere", async () => {
    const { admin, id, version } = await lane2WithPage();
    current = { id: admin.viewer.id, isAdmin: true };
    const csp = (await get(id, version, ["index.html"])).headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("sandbox allow-same-origin");
    expect(csp).not.toContain("allow-scripts");
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src 'self' data:");
  });
});

describe("when there is nothing to show", () => {
  it("says so plainly rather than failing", async () => {
    const { admin, id, version, runId } = await lane2WithPage();
    current = { id: admin.viewer.id, isAdmin: true };
    await r2.remove(readPageKeys(id, version, 1, runId).html);
    const res = await get(id, version, ["index.html"]);
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/No page has been built/);
  });

  it("gives nothing when the design has not been read", async () => {
    const { admin, id } = await lane2WithPage();
    current = { id: admin.viewer.id, isAdmin: true };
    expect((await get(id, "another-upload", ["index.html"])).status).toBe(404);
  });

  /*
    A runId names the project it belongs to. One that names a different
    project cannot be this read's, however it got into the saved file, and
    must never be used to build a storage key.
  */
  it("gives nothing when the saved read names another project's read", async () => {
    const { admin, id, version } = await lane2WithPage();
    current = { id: admin.viewer.id, isAdmin: true };
    const other = "design-read-11111111-2222-3333-4444-555555555555-1700000000000";
    await r2.put(
      `${projectStoragePrefix(id)}design-upload/${version}/read-v2/page-1.json`,
      Buffer.from(JSON.stringify({ runId: other, width: 1000, height: 800, colours: [], notes: [], bands: [] })),
    );
    await r2.put(readPageKeys(id, version, 1, other).html, Buffer.from("<!doctype html><html></html>"));
    expect((await get(id, version, ["index.html"])).status).toBe(404);
  });
});
