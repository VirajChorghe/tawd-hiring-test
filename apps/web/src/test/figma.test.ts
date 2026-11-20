import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, figmaDesign, figmaRead, projectAddon } from "@tawd/core/schema";
import {
  FigmaError,
  MAX_FIGMA_BYTES,
  checkReadiness,
  figmaApi,
  figmaErrorFor,
  isFinalPageName,
  parseFigmaLink,
  setFigmaForTesting,
  type FigmaFile,
} from "@tawd/core/figma";
import { figmaReadsThisMonth, importFigmaDesign } from "@tawd/core/figma/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { PermissionError } from "@tawd/core/permissions";
import { FIGMA_IMPORT_JOB } from "@tawd/core/queue";
import { setEncryptionKeyForTesting } from "@tawd/core/secrets";
import { setSlackFetchForTesting, slackMessage } from "@tawd/core/slack";
import { sweepStuckWork } from "@tawd/core/stuck-work";
import {
  FigmaDesignError,
  chooseFinalPage,
  designerDesignProps,
  figmaBadge,
  figmaSectionView,
  loadFigmaDesign,
  queueFigmaImport,
  recheckFigma,
  saveFigmaLink,
} from "@/lib/figma";
import { setQueueForTesting } from "@/lib/mockups";
import { deleteProject } from "@/lib/project-deletion";
import { createProject } from "@/lib/projects";
import { connectSlack } from "@/lib/slack-settings";
import { describeChanges } from "@/lib/timeline-text";

import { FILE_KEY, FILE_LINK, JPEG, PNG, daleRowanFile, fakeFigma } from "./figma-fakes";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

/*
  Figma part 1, stop 4a: the designer's Figma file linked in the intake,
  checked for free with warnings that never block, and imported as
  "Concept 1: Designer's design". No AI anywhere, and every Figma read is
  counted, because Figma limits how often the key may read.
*/

let h: Harness;
let r2: FakeR2;
let queued: { name: string; data: unknown }[];
let posts: string[];

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  r2 = new FakeR2();
  setStorageForTesting(r2);
  queued = [];
  setQueueForTesting({ add: async (name, data) => void queued.push({ name, data }), getJob: async () => null });
  setEncryptionKeyForTesting(randomBytes(32));
  posts = [];
  setSlackFetchForTesting(async (_url, init) => {
    posts.push((JSON.parse(String(init.body)) as { text: string }).text);
    return { ok: true, status: 200, text: async () => "ok" };
  });
});

afterEach(async () => {
  setFigmaForTesting(null);
  setSlackFetchForTesting(null);
  setEncryptionKeyForTesting(null);
  setQueueForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

async function seed(options: { lane?: "lane_1" | "lane_2"; laneOption?: "a" | "b" | null } = {}) {
  const admin = await seedAdmin(h);
  const projectId = await createProject(h.ctx, admin.viewer, {
    clientName: "Dale Rowan",
    trade: "well_and_pump",
    tier: "starter",
    lane: options.lane ?? "lane_2",
    laneOption: options.laneOption === undefined ? "b" : options.laneOption,
    conceptCount: 1,
    status: "intake",
    memberUserIds: [],
  });
  return { admin, projectId };
}

const row = async (projectId: string) =>
  (await h.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)))[0]!;
const logged = async (action: string) => h.db.select().from(activityLog).where(eq(activityLog.action, action));

/* ---------- reading the link ---------- */

describe("the Figma link", () => {
  it("takes the file from any link Figma gives, or the key alone", () => {
    for (const link of [
      FILE_LINK,
      `https://figma.com/file/${FILE_KEY}/Pat`,
      `https://www.figma.com/proto/${FILE_KEY}/Pat?page-id=2%3A1`,
      `https://www.figma.com/design/${FILE_KEY}`,
      `  ${FILE_KEY}  `,
    ]) {
      expect(parseFigmaLink(link)).toBe(FILE_KEY);
    }
  });

  it("refuses anything that is not a Figma file", () => {
    for (const link of [
      "",
      "not a link",
      `https://www.figma.com/board/${FILE_KEY}/Brainstorm`,
      `https://evil.example/design/${FILE_KEY}/x`,
      `https://figma.com.evil.example/design/${FILE_KEY}/x`,
      "https://www.figma.com/files/recents",
    ]) {
      expect(parseFigmaLink(link)).toBeNull();
    }
  });
});

/* ---------- the readiness check, from the file alone ---------- */

describe("the readiness check", () => {
  it("finds the final frames on the page named as final, and the homepage among them", () => {
    const readiness = checkReadiness(daleRowanFile());
    expect(readiness.finalPage).toEqual({ id: "2:1", name: "Final_Design", chosen: false });
    // The small Button component is not a page of the site.
    expect(readiness.frames.map((f) => [f.name, f.isHome, f.textLayers, f.images])).toEqual([
      ["Home", true, 4, 2],
      ["About", false, 1, 0],
    ]);
    expect(readiness.imageRefs).toEqual(["heroRef0001", "teamRef0002"]);
    expect(readiness.pages).toEqual([
      { id: "0:1", name: "Cover", frames: 0 },
      { id: "1:1", name: "Drafts", frames: 1 },
      { id: "2:1", name: "Final_Design", frames: 2 },
    ]);
  });

  it("knows a final page by its name, however it is written", () => {
    for (const name of ["Final_Design", "final", "FINAL - v3", "✅ Final", "Final-Design", "Designs (final)"]) {
      expect(isFinalPageName(name)).toBe(true);
    }
    for (const name of ["Drafts", "Finalist ideas", "Finalize later", "Cover"]) {
      expect(isFinalPageName(name)).toBe(false);
    }
  });

  it("names a font without a web license as a warning, and says the others are fine", () => {
    const readiness = checkReadiness(daleRowanFile());
    expect(readiness.fonts).toEqual([
      { family: "Arial", kind: "system", usable: true },
      { family: "Brandon Grotesque", kind: "other", usable: false },
      { family: "Montserrat", kind: "google", usable: true },
    ]);
    const fonts = readiness.items.find((i) => i.id === "fonts")!;
    expect(fonts).toMatchObject({ status: "warning", title: "Brandon Grotesque isn't a free web font" });
    expect(fonts.detail).toContain("the closest free font, for the designer to approve");
    expect(fonts.detail).toContain("Arial and Montserrat are fine.");
    // A hidden layer's font is not part of the design.
    expect(readiness.fonts.map((f) => f.family)).not.toContain("Comic Sans MS");
    expect(readiness.warnings).toBe(1);
  });

  it("warns, never blocks, when no page says final, and uses the page the PM chooses", () => {
    const file = daleRowanFile();
    file.document.children![2]!.name = "Web";
    const unnamed = checkReadiness(file);
    expect(unnamed.finalPage).toBeNull();
    expect(unnamed.frames).toEqual([]);
    expect(unnamed.items.find((i) => i.id === "final")).toMatchObject({
      status: "warning",
      title: "No page is named as the final design",
    });

    const chosen = checkReadiness(file, { chosenPageId: "2:1" });
    expect(chosen.finalPage).toEqual({ id: "2:1", name: "Web", chosen: true });
    expect(chosen.frames.map((f) => f.name)).toEqual(["Home", "About"]);
    expect(chosen.items.find((i) => i.id === "final")!.detail).toBe('Using the page "Web", chosen by the PM.');
  });

  it("warns about a frame with no text layers, and a frame that is one flat picture", () => {
    const file = daleRowanFile();
    const [home, about] = file.document.children![2]!.children!;
    about!.children = [];
    home!.children = [
      { id: "9:1", name: "Everything", type: "RECTANGLE", fills: [{ type: "IMAGE", imageRef: "flatRef" }], absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 5200 } },
      { id: "9:2", name: "Label", type: "TEXT", characters: "Home", style: { fontFamily: "Inter" } },
    ];
    const readiness = checkReadiness(file);
    expect(readiness.items.filter((i) => i.status === "warning").map((i) => i.title)).toEqual([
      '"Home" looks like one flat picture',
      '"About" has no text layers',
    ]);
  });

  it("takes the first frame as the homepage when none is named Home, and says so", () => {
    const file = daleRowanFile();
    file.document.children![2]!.children![0]!.name = "Desktop 1";
    const readiness = checkReadiness(file);
    expect(readiness.frames[0]!.isHome).toBe(true);
    expect(readiness.items.find((i) => i.id === "home")!.detail).toContain(
      'The homepage is "Desktop 1" (the first frame, since none is named Home)',
    );
  });
});

/* ---------- what goes wrong, in plain words ---------- */

describe("Figma's errors", () => {
  const headers = (values: Record<string, string> = {}) => ({ get: (name: string) => values[name.toLowerCase()] ?? null });

  it("says the key expired or was revoked, and what an admin does", () => {
    const error = figmaErrorFor(403, '{"status":403,"err":"Invalid token"}', headers());
    expect(error.kind).toBe("key_invalid");
    expect(error.message).toContain("TAWD's Figma key has expired, was revoked or is wrong");
    expect(error.message).toContain("replaces FIGMA_ACCESS_TOKEN in Coolify");
    expect(error.detail).toBe("Invalid token");
  });

  it("says the key can't open the file, and why that usually is", () => {
    for (const status of [403, 404]) {
      const error = figmaErrorFor(status, '{"status":404,"err":"Not found"}', headers());
      expect(error.kind).toBe("no_access");
      expect(error.message).toContain("shared with the Figma account the key belongs to");
    }
  });

  it("says the read limit was reached, and when to try again", () => {
    const low = figmaErrorFor(429, "{}", headers({ "x-figma-rate-limit-type": "low", "retry-after": "172800" }));
    expect(low.kind).toBe("rate_limited");
    expect(low.message).toContain("about 20 reads a month");
    expect(low.message).toContain("Try again in about 2 days.");
    const high = figmaErrorFor(429, "{}", headers({ "x-figma-rate-limit-type": "high", "retry-after": "60" }));
    expect(high.message).not.toContain("20 reads");
    expect(high.message).toContain("in about a minute");
  });

  it("says Figma didn't answer on a server error", () => {
    expect(figmaErrorFor(502, "Bad gateway", headers()).kind).toBe("unavailable");
  });

  it("says Figma isn't set up when the key is missing, without calling Figma", async () => {
    const saved = process.env.FIGMA_ACCESS_TOKEN;
    delete process.env.FIGMA_ACCESS_TOKEN;
    try {
      await expect(figmaApi.getFile(FILE_KEY)).rejects.toMatchObject({
        kind: "not_configured",
        message: expect.stringContaining("FIGMA_ACCESS_TOKEN is missing"),
      });
    } finally {
      if (saved !== undefined) process.env.FIGMA_ACCESS_TOKEN = saved;
    }
  });

  it("refuses an answer over the size limit without reading it, and reads a page by its id (13 October 2026)", async () => {
    const saved = process.env.FIGMA_ACCESS_TOKEN;
    process.env.FIGMA_ACCESS_TOKEN = "figd_test_only";
    const asked: string[] = [];
    let bodyRead = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url);
      if (url.includes("/nodes?")) {
        return new Response(JSON.stringify({ nodes: { "2:1": { document: { id: "2:1", name: "Final_Design", type: "CANVAS", children: [] } } } }));
      }
      const body = new ReadableStream({ pull: () => void (bodyRead = true) }, { highWaterMark: 0 });
      return new Response(body, { headers: { "content-length": String(MAX_FIGMA_BYTES + 1) } });
    }) as typeof fetch;
    try {
      await expect(figmaApi.getFile(FILE_KEY)).rejects.toMatchObject({ kind: "too_large" });
      expect(bodyRead).toBe(false);
      expect(await figmaApi.getPage(FILE_KEY, "2:1")).toMatchObject({ name: "Final_Design" });
      expect(asked.at(-1)).toBe(`https://api.figma.com/v1/files/${FILE_KEY}/nodes?ids=2%3A1`);
    } finally {
      globalThis.fetch = realFetch;
      if (saved === undefined) delete process.env.FIGMA_ACCESS_TOKEN;
      else process.env.FIGMA_ACCESS_TOKEN = saved;
    }
  });
});

/* ---------- linking and checking ---------- */

describe("linking the design in the intake", () => {
  it("reads the file once, keeps it, and stores what the check found", async () => {
    const { admin, projectId } = await seed();
    const figma = fakeFigma();
    setFigmaForTesting(figma.api);

    await saveFigmaLink(h.ctx, admin.viewer, projectId, FILE_LINK);

    expect(figma.reads()).toBe(1);
    const saved = await row(projectId);
    expect(saved).toMatchObject({ fileKey: FILE_KEY, checkStatus: "warnings", fileName: "Dale Rowan - Well & Pump", figmaVersion: "2213456789" });
    // The whole file is kept, so choosing a page or importing never reads it again.
    expect(JSON.parse(r2.objects.get(saved.fileJsonKey!)!.toString("utf8")).name).toBe("Dale Rowan - Well & Pump");
    expect(saved.fileJsonKey).toBe(`projects/${projectId}/figma/file-2213456789.json`);
    expect(await figmaReadsThisMonth(h.db)).toBe(1);

    const [linked] = await logged("figma.linked");
    expect(linked!.valueAfter).toEqual({ fileKey: FILE_KEY, url: FILE_LINK });
    const [checked] = await logged("figma.checked");
    expect(describeChanges("figma.checked", null, checked!.valueAfter, new Map())).toEqual([
      '"Dale Rowan - Well & Pump": 2 final frames, 1 warning',
      "Brandon Grotesque isn't a free web font",
    ]);
  });

  it("is only for Lane 2 (either option since 28 September 2026), and for PMs, web designers and admins (30 September 2026)", async () => {
    const { admin, projectId } = await seed({ lane: "lane_1", laneOption: null });
    setFigmaForTesting(fakeFigma().api);
    await expect(saveFigmaLink(h.ctx, admin.viewer, projectId, FILE_LINK)).rejects.toThrow(
      "A Figma design is only for Lane 2 (the client supplied a design).",
    );

    const optionB = await createProject(h.ctx, admin.viewer, {
      clientName: "Other Client",
      trade: "plumbing",
      tier: "starter",
      lane: "lane_2",
      laneOption: "b",
      conceptCount: 1,
      status: "intake",
      memberUserIds: [],
    });
    // The designer may link it (Jason, 29 September 2026); the content team may not.
    const designer = await seedUser(h, admin.viewer, { email: "designer@velocitymedialab.com", roles: ["web_designer"] });
    await saveFigmaLink(h.ctx, designer.viewer, optionB, FILE_LINK);
    const writer = await seedUser(h, admin.viewer, { email: "writer@velocitymedialab.com", roles: ["content"] });
    await expect(saveFigmaLink(h.ctx, writer.viewer, optionB, FILE_LINK)).rejects.toBeInstanceOf(PermissionError);
  });

  it("says plainly when the link is not a Figma file", async () => {
    const { admin, projectId } = await seed();
    await expect(saveFigmaLink(h.ctx, admin.viewer, projectId, "https://drive.google.com/x")).rejects.toThrow(
      /That isn't a Figma file link/,
    );
  });

  it("stores a failed read in plain words, never blocks, and counts it as a read", async () => {
    const { admin, projectId } = await seed();
    const figma = fakeFigma({
      fail: { getFile: new FigmaError("key_invalid", "TAWD's Figma key has expired, was revoked or is wrong.") },
    });
    setFigmaForTesting(figma.api);

    await saveFigmaLink(h.ctx, admin.viewer, projectId, FILE_LINK);
    expect(await row(projectId)).toMatchObject({
      checkStatus: "failed",
      failureKind: "key_invalid",
      failureMessage: "TAWD's Figma key has expired, was revoked or is wrong.",
    });
    expect((await h.db.select().from(figmaRead)).map((r) => [r.endpoint, r.ok])).toEqual([["file", false]]);
    await expect(queueFigmaImport(h.ctx, admin.viewer, projectId)).rejects.toThrow(/couldn't be read/);
  });

  it("does not count a missing key as a read: it never reached Figma", async () => {
    const { admin, projectId } = await seed();
    setFigmaForTesting(fakeFigma({ fail: { getFile: new FigmaError("not_configured", "Figma isn't set up.") } }).api);
    await saveFigmaLink(h.ctx, admin.viewer, projectId, FILE_LINK);
    expect(await h.db.select().from(figmaRead)).toHaveLength(0);
  });

  it("reads again only when asked, and starts over when the link is to a different file", async () => {
    const { admin, projectId } = await seed();
    const figma = fakeFigma();
    setFigmaForTesting(figma.api);
    await saveFigmaLink(h.ctx, admin.viewer, projectId, FILE_LINK);
    await recheckFigma(h.ctx, admin.viewer, projectId);
    expect(figma.reads()).toBe(2);
    // The same file again: no new "linked" entry.
    await saveFigmaLink(h.ctx, admin.viewer, projectId, `https://www.figma.com/design/${FILE_KEY}/Renamed`);
    expect(await logged("figma.linked")).toHaveLength(1);

    await chooseFinalPage(h.ctx, admin.viewer, projectId, "1:1");
    await saveFigmaLink(h.ctx, admin.viewer, projectId, "https://www.figma.com/design/AnotherFileKey12345/Other");
    const replaced = await row(projectId);
    expect(replaced).toMatchObject({ fileKey: "AnotherFileKey12345", chosenPageId: null, importStatus: null });
    const linked = await logged("figma.linked");
    expect(describeChanges("figma.linked", linked[1]!.valueBefore, linked[1]!.valueAfter, new Map())[0]).toBe(
      'Replaced "Dale Rowan - Well & Pump"',
    );
  });

  it("uses the page the PM chooses from the saved file, with no Figma read", async () => {
    const { admin, projectId } = await seed();
    const figma = fakeFigma();
    setFigmaForTesting(figma.api);
    await saveFigmaLink(h.ctx, admin.viewer, projectId, FILE_LINK);

    await chooseFinalPage(h.ctx, admin.viewer, projectId, "1:1");
    expect(figma.reads()).toBe(1);
    const readiness = (await row(projectId)).readiness as ReturnType<typeof checkReadiness>;
    expect(readiness.finalPage).toEqual({ id: "1:1", name: "Drafts", chosen: true });
    expect(readiness.frames.map((f) => f.name)).toEqual(["Old home"]);
    const [chosen] = await logged("figma.page_chosen");
    expect(describeChanges("figma.page_chosen", null, chosen!.valueAfter, new Map())).toEqual(['Page "Drafts"']);

    await expect(chooseFinalPage(h.ctx, admin.viewer, projectId, "99:9")).rejects.toBeInstanceOf(FigmaDesignError);
  });

  it("reads a file too large to read whole as its outline and the final page only (13 October 2026)", async () => {
    const { admin, projectId } = await seed();
    const figma = fakeFigma({ tooLarge: true });
    setFigmaForTesting(figma.api);
    await saveFigmaLink(h.ctx, admin.viewer, projectId, FILE_LINK);

    expect(figma.calls.map((c) => c.method)).toEqual(["getFile", "getOutline", "getPage"]);
    expect(figma.calls.at(-1)!.args).toEqual([FILE_KEY, "2:1"]);
    expect((await h.db.select().from(figmaRead)).map((r) => [r.endpoint, r.ok])).toEqual([["file", false], ["outline", true], ["page", true]]);
    const saved = await row(projectId);
    expect(saved.checkStatus).toBe("warnings");
    // The final page is whole (its frames' text is there); the other pages are listed with their frames.
    const readiness = saved.readiness as ReturnType<typeof checkReadiness>;
    expect(readiness.frames.map((f) => f.name)).toEqual(["Home", "About"]);
    expect(readiness.pages.find((p) => p.name === "Drafts")?.frames).toBe(1);
    const kept = JSON.parse(r2.objects.get(saved.fileJsonKey!)!.toString("utf8")) as FigmaFile;
    expect(kept.tawdFullPages).toEqual(["2:1"]);

    // Choosing another page reads that page, once.
    await chooseFinalPage(h.ctx, admin.viewer, projectId, "1:1");
    expect(figma.calls.at(-1)).toEqual({ method: "getPage", args: [FILE_KEY, "1:1"] });
    await chooseFinalPage(h.ctx, admin.viewer, projectId, "2:1");
    await chooseFinalPage(h.ctx, admin.viewer, projectId, "1:1");
    expect(figma.calls.filter((c) => c.method === "getPage")).toHaveLength(2);
  });

  it("says which page is too large when even the final page is over the limit", async () => {
    const { admin, projectId } = await seed();
    setFigmaForTesting(fakeFigma({ tooLarge: "page" }).api);
    await saveFigmaLink(h.ctx, admin.viewer, projectId, FILE_LINK);
    expect(await row(projectId)).toMatchObject({
      checkStatus: "failed",
      failureKind: "too_large",
      failureMessage: expect.stringContaining('The page "Final_Design" is too large'),
    });
    expect((await h.db.select().from(figmaRead)).map((r) => [r.endpoint, r.ok])).toEqual([["file", false], ["outline", true], ["page", false]]);
  });

  it("says what the designer can do when even the list of pages is too large (CodeRabbit, PR #10)", async () => {
    const { admin, projectId } = await seed();
    setFigmaForTesting(fakeFigma({ tooLarge: "outline" }).api);
    await saveFigmaLink(h.ctx, admin.viewer, projectId, FILE_LINK);
    expect(await row(projectId)).toMatchObject({
      checkStatus: "failed",
      failureKind: "too_large",
      failureMessage: expect.stringContaining("a copy of the file holding only the site's final page"),
    });
    expect((await h.db.select().from(figmaRead)).map((r) => [r.endpoint, r.ok])).toEqual([["file", false], ["outline", false]]);
  });
});

/* ---------- the import ---------- */

describe("importing the design", () => {
  async function linked() {
    const seeded = await seed();
    const figma = fakeFigma();
    setFigmaForTesting(figma.api);
    await saveFigmaLink(h.ctx, seeded.admin.viewer, seeded.projectId, FILE_LINK);
    return { ...seeded, figma };
  }

  it("queues the import for the worker, once", async () => {
    const { admin, projectId } = await linked();
    await queueFigmaImport(h.ctx, admin.viewer, projectId);
    expect(queued).toEqual([{ name: FIGMA_IMPORT_JOB, data: { projectId } }]);
    expect((await row(projectId)).importStatus).toBe("queued");
    await expect(queueFigmaImport(h.ctx, admin.viewer, projectId)).rejects.toThrow("The design is already being imported.");
    await expect(recheckFigma(h.ctx, admin.viewer, projectId)).rejects.toThrow(/being imported/);
  });

  it("renders the final frames and keeps the design's images, in two reads, with no AI", async () => {
    const { admin, projectId, figma } = await linked();
    await connectSlack(h.ctx, admin.viewer, projectId, "https://hooks.slack.com/services/T000/B000/XXXXXXXX");
    await queueFigmaImport(h.ctx, admin.viewer, projectId);

    await importFigmaDesign(h.db, projectId);

    // One read to check, then one to render and one for the image links.
    expect(figma.calls.filter((c) => c.method !== "download").map((c) => c.method)).toEqual([
      "getFile",
      "renderFrames",
      "imageFills",
    ]);
    expect(figma.calls.find((c) => c.method === "renderFrames")!.args).toEqual([FILE_KEY, ["2:10", "2:20"], 1]);

    const imported = await row(projectId);
    expect(imported).toMatchObject({ importStatus: "done", importedVersion: "2213456789", importWarnings: [] });
    const base = `projects/${projectId}/figma/2213456789/`;
    expect(imported.frames).toEqual([
      { id: "2:10", name: "Home", width: 1440, height: 5200, isHome: true, imageKey: `${base}frames/2-10.png`, scale: 1 },
      { id: "2:20", name: "About", width: 1440, height: 3000, isHome: false, imageKey: `${base}frames/2-20.png`, scale: 1 },
    ]);
    // The client-supplied design add-on, one per page of the design (27 September 2026).
    const [addon] = await h.db.select().from(projectAddon).where(eq(projectAddon.projectId, projectId));
    expect(addon).toMatchObject({ addonKey: "client_design", quantity: 2 });
    expect(imported.imageFiles).toEqual({
      heroRef0001: `${base}images/heroRef0001.png`,
      teamRef0002: `${base}images/teamRef0002.jpg`,
    });
    expect(r2.objects.get(`${base}frames/2-10.png`)).toEqual(PNG);
    expect(r2.objects.get(`${base}images/teamRef0002.jpg`)).toEqual(JPEG);

    const [done] = await logged("figma.imported");
    expect(describeChanges("figma.imported", null, done!.valueAfter, new Map())).toEqual([
      "2 frames (Home, About) and 2 images",
      "No logo and 0 icons kept for the faithful copy",
    ]);
    expect(posts.at(-1)).toContain("the designer's design was imported from Figma: 2 frames, 1 warning to look at.");
  });

  it("imports what it can, and warns about a frame Figma could not render and a missing image", async () => {
    const seeded = await seed();
    const figma = fakeFigma({
      renders: { "2:10": "https://figma-renders.example/home.png", "2:20": null },
      fills: { heroRef0001: "https://figma-images.example/hero", teamRef0002: null },
    });
    setFigmaForTesting(figma.api);
    await saveFigmaLink(h.ctx, seeded.admin.viewer, seeded.projectId, FILE_LINK);
    await queueFigmaImport(h.ctx, seeded.admin.viewer, seeded.projectId);
    await importFigmaDesign(h.db, seeded.projectId);

    const imported = await row(seeded.projectId);
    expect(imported.importStatus).toBe("done");
    expect(imported.importWarnings).toEqual([
      'Figma could not render "About", so it has no picture here. Try importing again, or check the frame in Figma.',
      "1 image is missing from the Figma file (placed in the design, but Figma has no file for it). Ask the designer to re-place it.",
    ]);
  });

  it("renders a very tall page smaller, since Figma refuses huge renders", async () => {
    const seeded = await seed();
    const figma = fakeFigma({
      file: () => {
        const file: FigmaFile = daleRowanFile();
        file.document.children![2]!.children![0]!.absoluteBoundingBox = { x: 0, y: 0, width: 1440, height: 30000 };
        return file;
      },
    });
    setFigmaForTesting(figma.api);
    await saveFigmaLink(h.ctx, seeded.admin.viewer, seeded.projectId, FILE_LINK);
    await queueFigmaImport(h.ctx, seeded.admin.viewer, seeded.projectId);
    await importFigmaDesign(h.db, seeded.projectId);
    expect(figma.calls.find((c) => c.method === "renderFrames")!.args[2]).toBe(0.76);
  });

  it("says why when the import fails, and can be run again", async () => {
    const seeded = await seed();
    const figma = fakeFigma({
      fail: { renderFrames: new FigmaError("rate_limited", "Figma's read limit for TAWD's key has been reached.") },
    });
    setFigmaForTesting(figma.api);
    await saveFigmaLink(h.ctx, seeded.admin.viewer, seeded.projectId, FILE_LINK);
    await queueFigmaImport(h.ctx, seeded.admin.viewer, seeded.projectId);
    await importFigmaDesign(h.db, seeded.projectId);

    expect(await row(seeded.projectId)).toMatchObject({
      importStatus: "failed",
      importFailure: "Figma's read limit for TAWD's key has been reached.",
    });
    const [failed] = await logged("figma.import_failed");
    expect(describeChanges("figma.import_failed", null, failed!.valueAfter, new Map())).toEqual([
      "Figma's read limit for TAWD's key has been reached.",
    ]);
    expect((await h.db.select().from(figmaRead)).map((r) => `${r.endpoint}:${r.ok}`)).toEqual(["file:true", "images:false"]);

    await queueFigmaImport(h.ctx, seeded.admin.viewer, seeded.projectId);
    expect((await row(seeded.projectId)).importStatus).toBe("queued");
  });

  it("settles an import the worker never finished", async () => {
    const { admin, projectId } = await linked();
    await queueFigmaImport(h.ctx, admin.viewer, projectId);
    await h.db.update(figmaDesign).set({ importQueuedAt: new Date(Date.now() - 2 * 3600_000) });
    const swept = await sweepStuckWork(h.db);
    expect(swept.imports).toEqual([projectId]);
    expect(await row(projectId)).toMatchObject({
      importStatus: "failed",
      importFailure: "The worker never picked up the import: nothing happened for over an hour. Import again when the worker is back.",
    });
  });
});

/* ---------- what the screens show ---------- */

describe("the screens' view of the design", () => {
  it("shows Not linked, then the check, then Concept 1 with its frames", async () => {
    const { admin, projectId } = await seed();
    expect(figmaBadge(null)).toEqual({ text: "Not linked", kind: "missing" });
    expect(designerDesignProps(projectId, null)).toMatchObject({ status: "not_linked", frames: [] });

    setFigmaForTesting(fakeFigma().api);
    await saveFigmaLink(h.ctx, admin.viewer, projectId, FILE_LINK);
    let view = (await loadFigmaDesign(h.db, projectId))!;
    expect(figmaBadge(view)).toEqual({ text: "1 warning", kind: "warning" });
    expect(designerDesignProps(projectId, view).status).toBe("not_imported");
    const section = figmaSectionView(view);
    expect(section).toMatchObject({ checkStatus: "warnings", frameCount: 2, importStatus: null });
    expect(section.items.map((i) => i.status)).toContain("warning");

    await queueFigmaImport(h.ctx, admin.viewer, projectId);
    expect(designerDesignProps(projectId, (await loadFigmaDesign(h.db, projectId))!).status).toBe("importing");

    await importFigmaDesign(h.db, projectId);
    view = (await loadFigmaDesign(h.db, projectId))!;
    const card = designerDesignProps(projectId, view);
    expect(card).toMatchObject({ status: "imported", fileName: "Dale Rowan - Well & Pump", warnings: 1, outOfDate: false });
    expect(card.frames.map((f) => [f.name, f.isHome, Boolean(f.imageUrl)])).toEqual([
      ["Home", true, true],
      ["About", false, true],
    ]);
    expect(figmaSectionView(view).importedLine).toMatch(/^2 frames, .* by Test Admin\.$/);
    expect(view.readsThisMonth).toBe(3);
  });

  it("says when the file has changed in Figma since it was imported", async () => {
    const { admin, projectId } = await seed();
    let version = "1";
    setFigmaForTesting(fakeFigma({ file: () => daleRowanFile(version) }).api);
    await saveFigmaLink(h.ctx, admin.viewer, projectId, FILE_LINK);
    await queueFigmaImport(h.ctx, admin.viewer, projectId);
    await importFigmaDesign(h.db, projectId);
    version = "2";
    await recheckFigma(h.ctx, admin.viewer, projectId);
    expect((await loadFigmaDesign(h.db, projectId))!.importOutOfDate).toBe(true);
  });

  it("words the Slack line without any of the design's content", () => {
    expect(slackMessage("Dale Rowan", "p1", { kind: "design_imported", frames: 3, warnings: 0 }, "https://tawd.example")).toBe(
      "*Dale Rowan*: the designer's design was imported from Figma: 3 frames. <https://tawd.example/projects/p1/mockups|Open Design>",
    );
  });
});

/* ---------- deleting the project ---------- */

describe("deleting the project", () => {
  it("removes the design and its files, and keeps the count of Figma reads", async () => {
    const { admin, projectId } = await seed();
    setFigmaForTesting(fakeFigma().api);
    await saveFigmaLink(h.ctx, admin.viewer, projectId, FILE_LINK);
    await queueFigmaImport(h.ctx, admin.viewer, projectId);
    await importFigmaDesign(h.db, projectId);
    expect([...r2.objects.keys()].some((k) => k.includes("/figma/"))).toBe(true);

    await deleteProject(h.ctx, admin.viewer, projectId, { confirmName: "Dale Rowan", reason: "Test project, no longer needed" });

    expect(await h.db.select().from(figmaDesign)).toHaveLength(0);
    expect([...r2.objects.keys()].some((k) => k.includes("/figma/"))).toBe(false);
    expect(await h.db.select().from(figmaRead)).toHaveLength(3);
  });
});
