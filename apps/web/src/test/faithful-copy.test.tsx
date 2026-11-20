import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Lane 2, Option B: the faithful copy. The logo and icons rendered at
  import in the same Figma request; the homepage rebuilt as a web page with
  nothing changed (one AI call per group of sections, saved before it is read,
  put together by TAWD, checked by eye and by text, off sections rebuilt once); a free comparison
  with the Figma frame; the copy page and the page itself.
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
vi.mock("@/app/actions", () => {
  const f = async () => ({ ok: true });
  return new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : f), has: () => true });
});

import { eq } from "drizzle-orm";
import { costOf, priceConfigFor } from "@tawd/core/mockups";
import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, aiCall, designCopy, figmaDesign, project as projectTable, siteBuild } from "@tawd/core/schema";
import {
  assembleFaithfulPage,
  buildFaithfulSystemPrompt,
  cleanFrame,
  describeFrameProblems,
  compareCopyText,
  designTextsBySection,
  groupSections,
  readVisualCheck,
  sectionNotes,
  describeFrameForBuild,
  designAssetNodes,
  findNode,
  frameSections,
  setFigmaForTesting,
  visibleTree,
  type FigmaFile,
  type FigmaNode,
} from "@tawd/core/figma";
import { importFigmaDesign } from "@tawd/core/figma/service";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { PermissionError } from "@tawd/core/permissions";
import { FAITHFUL_COPY_JOB } from "@tawd/core/queue";
import { setEncryptionKeyForTesting } from "@tawd/core/secrets";
import { setSlackFetchForTesting, slackMessage } from "@tawd/core/slack";
import { sweepStuckWork } from "@tawd/core/stuck-work";
import MockupsPage from "@/app/(app)/projects/[id]/mockups/page";
import DesignCopyPage from "@/app/(app)/projects/[id]/mockups/design/copy/page";
import { GET as livePage } from "@/app/(app)/projects/[id]/mockups/design/copy/live/route";
import { DesignCopyError, copySummary, estimateDesignCopy, splitNote, startDesignCopy } from "@/lib/design-copy";
import { queueFigmaImport, saveFigmaLink } from "@/lib/figma";
import { setQueueForTesting } from "@/lib/mockups";
import { deleteProject } from "@/lib/project-deletion";
import { createProject } from "@/lib/projects";
import { connectSlack } from "@/lib/slack-settings";
import { describeChanges } from "@/lib/timeline-text";

import { markDesignCopyFailed, runFaithfulCopyJob } from "../../../worker/src/faithful-copy";
import { runDesignMobileJob } from "../../../worker/src/design-mobile";
import { runSiteBuildJob } from "../../../worker/src/site-build";
import { approveExactDesign, confirmDesignPages, loadExactDesign, startExactCopies } from "@/lib/exact-design";
import { siteReadiness, startSiteBuild } from "@/lib/site-builds";
import type { WorkerConfig } from "../../../worker/src/config";

import { FILE_LINK, daleRowanFile, fakeFigma } from "./figma-fakes";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2, fakeBrowser, fakeClaude, lastUserText, turn } from "./worker-fakes";
import { randomBytes } from "node:crypto";

let h: Harness;
let r2: FakeR2;
let queued: { name: string; data: unknown }[];
let posts: string[];

const config: WorkerConfig = {
  databaseUrl: "unused",
  redisUrl: "unused",
  anthropicApiKey: "unused",
  model: "claude-opus-5-5",
  skillsDir: path.resolve(__dirname, "../../../../skills"),
  effort: "high",
};

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

/* ---------- a homepage with a logo and icons ---------- */

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const vector = (id: string, x: number, y: number, size = 24): FigmaNode => ({ id, name: "Vector", type: "VECTOR", absoluteBoundingBox: box(x, y, size, size) });

function designWithDrawings(): FigmaFile {
  const file = daleRowanFile();
  const home = file.document.children![2]!.children![0]!;
  home.children = [
    {
      id: "7:1",
      name: "Header",
      type: "FRAME",
      absoluteBoundingBox: box(0, 0, 1440, 100),
      fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }],
      children: [
        // The logo: drawn shapes at the top left, not named "logo".
        { id: "7:2", name: "Mark", type: "GROUP", absoluteBoundingBox: box(80, 20, 180, 60), children: [vector("7:3", 80, 20), vector("7:4", 110, 20)] },
        { id: "7:5", name: "Call", type: "TEXT", characters: "Call (530) 555-0199", style: { fontFamily: "Montserrat", fontSize: 17, fontWeight: 700 }, absoluteBoundingBox: box(1200, 36, 180, 24) },
      ],
    },
    {
      id: "7:6",
      name: "Services",
      type: "FRAME",
      absoluteBoundingBox: box(0, 100, 1440, 600),
      children: [
        // Two icons, and a drawing too big to be an icon.
        { id: "7:7", name: "Drop icon", type: "GROUP", absoluteBoundingBox: box(100, 200, 48, 48), children: [vector("7:8", 100, 200, 48)] },
        vector("7:9", 400, 200, 40),
        vector("7:10", 0, 300, 1200),
        { id: "7:11", name: "Well drilling", type: "TEXT", characters: "Well drilling", style: { fontFamily: "Georgia", fontSize: 22, fontWeight: 700 }, absoluteBoundingBox: box(100, 260, 300, 30) },
        { id: "7:12", name: "Photo", type: "RECTANGLE", fills: [{ type: "IMAGE", imageRef: "heroRef0001" }], absoluteBoundingBox: box(700, 200, 600, 400) },
      ],
    },
  ];
  home.absoluteBoundingBox = box(0, 0, 1440, 700);
  return file;
}

describe("the logo and icons", () => {
  it("picks the logo at the top left and the icons, outermost only, never text, photos or big drawings", () => {
    const found = designAssetNodes(designWithDrawings(), [{ id: "2:10", isHome: true }]);
    expect(found.map((a) => [a.id, a.kind])).toEqual([
      ["7:2", "logo"],
      ["7:7", "icon"],
      ["7:9", "icon"],
    ]);
  });

  it("takes anything named logo as the logo, whatever it holds", () => {
    const file = designWithDrawings();
    const header = findNode(file.document, "7:1")!;
    header.children!.push({ id: "7:20", name: "Logo", type: "FRAME", absoluteBoundingBox: box(300, 20, 200, 60), children: [{ id: "7:21", name: "t", type: "TEXT", characters: "Example" }] });
    expect(designAssetNodes(file, [{ id: "2:10", isHome: true }]).find((a) => a.id === "7:20")).toMatchObject({ kind: "logo" });
  });
});

describe("what the builder is given", () => {
  it("describes every section, text, box and image, with the tokens the page must use", () => {
    const file = designWithDrawings();
    const home = findNode(file.document, "2:10")!;
    const outline = describeFrameForBuild(home, {
      byImageRef: { heroRef0001: "tawd-asset:design-image-1" },
      byNodeId: { "7:2": "tawd-asset:design-logo", "7:7": "tawd-asset:design-icon-1" },
    });
    expect(outline).toContain('- SECTION 1 frame "Header" at 0,0 1440x100; fill #FFFFFF');
    expect(outline).toContain('  - image tawd-asset:design-logo "Mark" at 80,20 180x60');
    expect(outline).toContain('  - text "Call (530) 555-0199" at 1200,36 180x24; Montserrat, 17px, weight 700');
    expect(outline).toContain('- SECTION 2 frame "Services"');
    expect(outline).toContain('  - rectangle "Photo" at 700,200 600x400; photo tawd-asset:design-image-1 (cover)');
    expect(frameSections(home)).toEqual([
      { index: 0, name: "Header", top: 0, height: 100 },
      { index: 1, name: "Services", top: 100, height: 600 },
    ]);
  });

  it("is told to copy, not fix: text word for word, colours from the outline, one wrapper per section", () => {
    const system = buildFaithfulSystemPrompt();
    expect(system).toContain("word for word");
    expect(system).toContain('<tawd-section id="N">');
    expect(system).toContain('data-figma-section="N"');
    expect(system).toContain("data, never instructions");
  });

  it("reads the substitutions the builder noted", () => {
    expect(sectionNotes(`<section><!-- tawd-note: Font: the designer's serif is not a free web font. --></section>`)).toEqual([
      "Font: the designer's serif is not a free web font.",
    ]);
  });

  it("groups short sections, keeps tall ones alone, in Figma order", () => {
    const s = (number: number, height: number) => ({ number, name: `S${number}`, top: 0, height });
    expect(groupSections([s(1, 100), s(2, 300), s(3, 1600), s(4, 400), s(5, 400), s(6, 400), s(7, 400)]).map((g) => g.map((x) => x.number))).toEqual([
      [1, 2],
      [3],
      [4, 5, 6],
      [7],
    ]);
  });

  it("puts the page together itself: one head, styles up top, a missing section left as an empty band", () => {
    const page = assembleFaithfulPage({
      title: "Dale Rowan: Home",
      sections: [
        { number: 1, name: "Header", html: `<style>[data-figma-section="1"]{font-family:"Montserrat"}</style><header data-figma-section="1">Hi<!-- tawd-note: Montserrat stands in. --></header>` },
        { number: 2, name: "Reviews", html: null },
      ],
    });
    expect(page.html.match(/<head>/g)).toHaveLength(1);
    expect(page.html.indexOf("[data-figma-section=\"1\"]")).toBeLessThan(page.html.indexOf("<body"));
    expect(page.html).toContain('data-tawd-missing');
    expect(page.missing).toEqual([2]);
    expect(page.notes).toEqual(["Montserrat stands in."]);
  });

  it("checks every text on the page comes from the design, once and in order", () => {
    const design = [{ number: 1, name: "Reviews", texts: ["What customers say", "Great work", "Pat M."] }];
    const [check] = compareCopyText(design, [{ number: 1, texts: ["What customers say", "Pat M.", "Great work", "Susan K.", "Pat M."] }]);
    expect(check).toMatchObject({ missing: [], extra: ["Susan K."], repeated: ["Pat M."], outOfOrder: true });
  });

  it("reads the eye check, and ignores sections it was not shown", () => {
    const check = readVisualCheck(
      JSON.stringify({ summary: "Close.", sections: [{ section: 1, verdict: "off", differences: ["The red band is missing."] }, { section: 9, verdict: "off", differences: [] }] }),
      [1, 2],
    );
    expect(check!.sections).toEqual([{ section: 1, verdict: "off", differences: ["The red band is missing."] }]);
    expect(readVisualCheck("not json", [1])).toBeNull();
  });

  it("reads a row of tiles tile by tile, and a header row left to right despite uneven baselines", () => {
    const t = (id: string, characters: string, x: number, y: number): FigmaNode => ({ id, name: id, type: "TEXT", characters, absoluteBoundingBox: box(x, y, 200, 24) });
    const tile = (id: string, x: number, title: string, body: string): FigmaNode => ({
      id,
      name: id,
      type: "FRAME",
      absoluteBoundingBox: box(x, 1100, 400, 200),
      children: [t(`${id}b`, body, x + 20, 1160), t(`${id}t`, title, x + 20, 1120)],
    });
    const frame: FigmaNode = {
      id: "f",
      name: "Home",
      type: "FRAME",
      absoluteBoundingBox: box(0, 0, 1440, 1400),
      children: [
        { id: "h", name: "Header", type: "FRAME", absoluteBoundingBox: box(0, 0, 1440, 100), children: [t("n", "Services", 700, 30), t("l", "Example", 80, 36)] },
        { id: "s", name: "Services", type: "FRAME", absoluteBoundingBox: box(0, 1000, 1440, 400), children: [tile("b", 520, "Pump repair", "Same day."), tile("a", 80, "Well drilling", "New wells."), t("g", "Our services", 80, 1020)] },
      ],
    };
    expect(designTextsBySection(frame).map((s) => s.texts)).toEqual([
      ["Example", "Services"],
      ["Our services", "Well drilling", "New wells.", "Pump repair", "Same day."],
    ]);
  });

  it("takes the text of each section from the visible layers only", () => {
    const home = visibleTree(findNode(designWithDrawings().document, "2:10")!);
    expect(designTextsBySection(home).map((s) => [s.number, s.texts])).toEqual([
      [1, ["Call (530) 555-0199"]],
      [2, ["Well drilling"]],
    ]);
  });
});

/* ---------- import and build, end to end ---------- */

async function seedImported(file: () => FigmaFile = designWithDrawings) {
  const admin = await seedAdmin(h);
  state.user = admin.viewer;
  const projectId = await createProject(h.ctx, admin.viewer, {
    clientName: "Dale Rowan",
    trade: "well_and_pump",
    tier: "starter",
    lane: "lane_2",
    laneOption: "b",
    conceptCount: 1,
    status: "intake",
    memberUserIds: [],
  });
  await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", { name: "Example Well & Pump", phone: "(530) 555-0199", city: "Grass Valley" });
  await h.db.update(projectTable).set({ status: "mockups" }).where(eq(projectTable.id, projectId));
  const figma = fakeFigma({ file });
  setFigmaForTesting(figma.api);
  await saveFigmaLink(h.ctx, admin.viewer, projectId, FILE_LINK);
  await queueFigmaImport(h.ctx, admin.viewer, projectId);
  await importFigmaDesign(h.db, projectId);
  queued = [];
  return { admin, projectId, figma };
}

/* The builder's answer to a call, by the sections it asks for. */
const SECTIONS: Record<number, string> = {
  1: `<style>[data-figma-section="1"]{display:flex;background:#FFFFFF}</style><header data-figma-section="1"><img src="tawd-asset:design-logo" alt="Example Well &amp; Pump"><a href="tel:+15305550199">Call (530) 555-0199</a><!-- tawd-note: Font: Brandon Grotesque is not a free web font; Montserrat is used instead. --></header>`,
  2: `<section data-figma-section="2"><h1>Well drilling</h1><img src="tawd-asset:design-image-1" alt="A well head"></section>`,
};
function asked(params: Record<string, unknown>): number[] {
  return [...lastUserText(params).matchAll(/- Section (\d+) of/g)].map((m) => Number(m[1]));
}
const sectionBuilder = (params: Record<string, unknown>) =>
  turn(asked(params).map((n) => `<tawd-section id="${n}">${SECTIONS[n] ?? ""}</tawd-section>`).join("\n"), "end_turn");
const lookedClose = () => [{ summary: "The copy is close to the design.", sections: [{ section: 1, verdict: "close", differences: [] }, { section: 2, verdict: "close", differences: [] }] }];

describe("importing the logo and icons", () => {
  it("renders them in the same Figma request as the frames, and keeps them", async () => {
    const { projectId, figma } = await seedImported();
    const render = figma.calls.find((c) => c.method === "renderFrames")!;
    expect(render.args[1]).toEqual(["2:10", "2:20", "7:2", "7:7", "7:9"]);
    expect(figma.calls.filter((c) => c.method === "renderFrames")).toHaveLength(1);
    const [row] = await h.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId));
    expect((row!.designAssets as { id: string; kind: string }[]).map((a) => [a.id, a.kind])).toEqual([
      ["7:2", "logo"],
      ["7:7", "icon"],
      ["7:9", "icon"],
    ]);
    const [log] = await h.db.select().from(activityLog).where(eq(activityLog.action, "figma.imported"));
    expect(describeChanges("figma.imported", null, log!.valueAfter, new Map())).toContain("The logo and 2 icons kept for the faithful copy");
  });
});

describe("building the faithful copy", () => {
  it("queues one copy of the imported homepage, with the estimate logged", async () => {
    const { admin, projectId } = await seedImported();
    const copyId = await startDesignCopy(h.ctx, admin.viewer, projectId);
    expect(queued).toEqual([{ name: FAITHFUL_COPY_JOB, data: { copyId, projectId } }]);
    const [log] = await h.db.select().from(activityLog).where(eq(activityLog.action, "design.copy_started"));
    expect(describeChanges("design.copy_started", null, log!.valueAfter, new Map())[1]).toMatch(/a first guess until a real copy has been built/);
    await expect(startDesignCopy(h.ctx, admin.viewer, projectId)).rejects.toThrow("The copy is already being built.");
  });

  it("builds section by section from the pictures and the outline, puts the page together, checks it, and saves every answer", async () => {
    const { admin, projectId } = await seedImported();
    await connectSlack(h.ctx, admin.viewer, projectId, "https://hooks.slack.com/services/T000/B000/XXXXXXXX");
    const copyId = await startDesignCopy(h.ctx, admin.viewer, projectId);
    const claude = fakeClaude(lookedClose, { builder: sectionBuilder });

    await runFaithfulCopyJob({ copyId, projectId }, config, claude.client, fakeBrowser());

    // The two short sections go in one build call, then one cheap look.
    expect(claude.calls.map((c) => c.kind)).toEqual(["builder", "review"]);
    const call = claude.calls[0]!;
    expect(call.params.tools).toBeUndefined();
    expect(call.params.max_tokens).toBe(32_000);
    const content = (call.params.messages as { content: { type: string; text?: string }[] }[])[0]!.content;
    expect(content.filter((b) => b.type === "image").length).toBe(2);
    const text = content.map((b) => b.text ?? "").join("\n");
    expect(text).toContain('- SECTION 1 frame "Header"');
    expect(text).toContain("- Section 1 of 2");
    expect(text).toContain("- tawd-asset:design-logo: the designer's logo");
    expect(text).toContain("- tawd-asset:design-image-1: a photo from the design");
    const look = claude.calls[1]!;
    expect((look.params.output_config as { effort: string }).effort).toBe("low");

    const [row] = await h.db.select().from(designCopy).where(eq(designCopy.id, copyId));
    expect(row).toMatchObject({ status: "done", notes: ["Font: Brandon Grotesque is not a free web font; Montserrat is used instead."] });
    expect(row!.fidelity).toMatchObject({ overall: 87, sections: [{ name: "Hero", score: 91 }, { name: "Our services", score: 78 }] });
    const checks = row!.checks as { rebuilt: number[]; text: { extra: string[]; missing: string[] }[]; visual: { summary: string } };
    expect(checks.rebuilt).toEqual([]);
    expect(checks.text.every((t) => t.extra.length === 0 && t.missing.length === 0)).toBe(true);
    expect(checks.visual.summary).toBe("The copy is close to the design.");
    // The page keeps its tokens in the source, and has the images in for viewing.
    const source = r2.objects.get(row!.sourceKey!)!.toString("utf8");
    expect(source).toContain("tawd-asset:design-logo");
    expect(source.indexOf('data-figma-section="1"')).toBeLessThan(source.indexOf('data-figma-section="2"'));
    const page = r2.objects.get(row!.htmlKey!)!.toString("utf8");
    expect(page).not.toContain("tawd-asset:");
    expect(page).toContain("data:image/");

    const ledger = await h.db.select().from(aiCall).where(eq(aiCall.runId, copyId));
    expect(ledger.map((l) => l.step)).toEqual(["faithful_copy", "faithful_check"]);
    expect(ledger.every((l) => r2.objects.has(l.responseKey!))).toBe(true);
    const [log] = await h.db.select().from(activityLog).where(eq(activityLog.action, "design.copy_built"));
    expect(describeChanges("design.copy_built", null, log!.valueAfter, new Map())[0]).toBe('"Home": matches the design 87%');
    expect(posts.at(-1)).toContain("the faithful copy of the designer's design is ready: it matches the design 87%.");
  });

  it("rebuilds once the sections the look calls off, or with text that isn't the design's, with the differences as guidance", async () => {
    const { admin, projectId } = await seedImported();
    const copyId = await startDesignCopy(h.ctx, admin.viewer, projectId);
    let calls = 0;
    const claude = fakeClaude(
      () => [{ summary: "The header is off.", sections: [{ section: 1, verdict: "off", differences: ["The header background should be red."] }, { section: 2, verdict: "close", differences: [] }] }],
      {
        builder: (params) => {
          calls += 1;
          // The first build of section 2 has a review from another version of the design.
          if (calls === 1) {
            return turn(
              `<tawd-section id="1">${SECTIONS[1]}</tawd-section><tawd-section id="2"><section data-figma-section="2"><h1>Well drilling</h1><p>Susan K.</p></section></tawd-section>`,
              "end_turn",
            );
          }
          return sectionBuilder(params);
        },
      },
    );
    await runFaithfulCopyJob({ copyId, projectId }, config, claude.client, fakeBrowser());

    expect(claude.calls.map((c) => c.kind)).toEqual(["builder", "review", "builder", "builder"]);
    const retries = claude.calls.slice(2).map((c) => lastUserText(c.params));
    expect(retries[0]).toContain("- Section 1 of 2");
    expect(retries[0]).toContain("- The header background should be red.");
    expect(retries[1]).toContain("- Section 2 of 2");
    expect(retries[1]).toContain('- This text is not in the design and must go: "Susan K."');
    const [row] = await h.db.select().from(designCopy).where(eq(designCopy.id, copyId));
    expect((row!.checks as { rebuilt: number[] }).rebuilt).toEqual([1, 2]);
    // The copies list's progress, as the worker last left it: both rebuilds done (they run at once, 28 September 2026).
    expect(row!.progress).toEqual({ stage: "rebuilding", done: 2, total: 2 });
    expect(r2.objects.get(row!.sourceKey!)!.toString("utf8")).not.toContain("Susan K.");
    const rounds = await h.db.select().from(aiCall).where(eq(aiCall.runId, copyId));
    expect(rounds.filter((r) => r.step === "faithful_copy").map((r) => r.round)).toEqual([1, 2, 2]);
    // Sonnet builds first; the sections rebuilt after a bad look or a low score go to Opus (Jason, 27 September 2026).
    expect(rounds.filter((r) => r.step === "faithful_copy").map((r) => [r.round, r.model])).toEqual([
      [1, "claude-sonnet-5"],
      [2, "claude-opus-5-5"],
      [2, "claude-opus-5-5"],
    ]);
  });

  it("tries a missing section once more on its own, and leaves it as an empty band if it still doesn't come", async () => {
    const { admin, projectId } = await seedImported();
    const copyId = await startDesignCopy(h.ctx, admin.viewer, projectId);
    const claude = fakeClaude(lookedClose, { builder: () => turn(`<tawd-section id="1">${SECTIONS[1]}</tawd-section>`, "end_turn") });
    await runFaithfulCopyJob({ copyId, projectId }, config, claude.client, fakeBrowser());
    // Both at once, section 2 alone, the look, section 2 rebuilt.
    expect(claude.calls.map((c) => c.kind)).toEqual(["builder", "builder", "review", "builder"]);
    const [row] = await h.db.select().from(designCopy).where(eq(designCopy.id, copyId));
    expect(row!.notes).toContain('Section 2 ("Services") could not be built; it is left empty.');
  });

  it("fails plainly when nothing comes back, and records why", async () => {
    const { admin, projectId } = await seedImported();
    const copyId = await startDesignCopy(h.ctx, admin.viewer, projectId);
    const claude = fakeClaude(() => [], { builder: () => turn('<tawd-section id="1"><header data-figma-sec', "max_tokens") });
    await expect(runFaithfulCopyJob({ copyId, projectId }, config, claude.client, fakeBrowser())).rejects.toThrow(
      "No section of the copy came back. Build the copy again.",
    );
    // Still charged and saved: the group, then each section alone.
    expect(await h.db.select().from(aiCall).where(eq(aiCall.runId, copyId))).toHaveLength(3);
    await markDesignCopyFailed(copyId, "No section of the copy came back. Build the copy again.");
    const [row] = await h.db.select().from(designCopy).where(eq(designCopy.id, copyId));
    expect(row).toMatchObject({ status: "failed" });
  });

  it("needs an imported Option B design and a PM or admin", async () => {
    const { admin, projectId } = await seedImported();
    const designer = await seedUser(h, admin.viewer, { email: "designer@velocitymedialab.com", roles: ["web_designer"] });
    await expect(startDesignCopy(h.ctx, designer.viewer, projectId)).rejects.toBeInstanceOf(PermissionError);
    await h.db.update(figmaDesign).set({ importStatus: null });
    await expect(startDesignCopy(h.ctx, admin.viewer, projectId)).rejects.toBeInstanceOf(DesignCopyError);
  });

  it("estimates from past copies once there are some", async () => {
    const { admin, projectId } = await seedImported();
    const copyId = await startDesignCopy(h.ctx, admin.viewer, projectId);
    await runFaithfulCopyJob({ copyId, projectId }, config, fakeClaude(lookedClose, { builder: sectionBuilder }).client, fakeBrowser());
    const measured = await estimateDesignCopy(h.db);
    expect(measured.label).toMatch(/from the copies so far$/);
    // It counts the whole copy: every section call and the visual check, the check at Sonnet's rates (27 September 2026).
    const calls = await h.db.select().from(aiCall).where(eq(aiCall.runId, copyId));
    expect(calls.map((c) => c.step)).toContain("faithful_check");
    expect(calls.find((c) => c.step === "faithful_check")!.model).toBe("claude-sonnet-5");
    // The first build and the look on Sonnet, sections rebuilt after a low score on Opus.
    const modelOf = (c: (typeof calls)[number]) => (c.step === "faithful_copy" && (c.round ?? 1) > 1 ? "claude-opus-5-5" : "claude-sonnet-5");
    expect(measured.cost).toBeCloseTo(calls.reduce((n, c) => n + costOf(c, priceConfigFor(modelOf(c))), 0), 6);
    expect(measured.label).toContain("on Sonnet 5, sections rebuilt after a low score on Opus 5.5, look check on Sonnet 5");
  });

  it("ignores the old one-call copies, which cost far less than a copy built section by section", async () => {
    const { projectId } = await seedImported();
    await h.db.insert(aiCall).values({ projectId, runId: crypto.randomUUID(), model: "m", step: "faithful_copy", inputTokens: 1000, outputTokens: 1000 });
    expect((await estimateDesignCopy(h.db)).measured).toBe(false);
  });

  it("settles a copy the worker never picked up, and goes with the project", async () => {
    const { admin, projectId } = await seedImported();
    const copyId = await startDesignCopy(h.ctx, admin.viewer, projectId);
    await h.db.update(designCopy).set({ createdAt: new Date(Date.now() - 2 * 3600_000) });
    // Picked up late (a worker restart) and mid-way through its first AI call: running, never marked failed (13 October 2026).
    await h.db.update(designCopy).set({ status: "working", startedAt: new Date(Date.now() - 5 * 60_000) });
    expect((await sweepStuckWork(h.db)).designCopies).toEqual([]);
    expect((await h.db.select().from(designCopy))[0]!.status).toBe("working");
    // Started over an hour ago with the worker silent since: stuck.
    await h.db.update(designCopy).set({ startedAt: new Date(Date.now() - 90 * 60_000) });
    expect((await sweepStuckWork(h.db)).designCopies).toEqual([copyId]);
    await deleteProject(h.ctx, admin.viewer, projectId, { confirmName: "Dale Rowan", reason: "Test project, no longer needed" });
    expect(await h.db.select().from(designCopy)).toHaveLength(0);
  });
});

/* ---------- the screens and the page ---------- */

describe("the screens", () => {
  async function built() {
    const seeded = await seedImported();
    const copyId = await startDesignCopy(h.ctx, seeded.admin.viewer, seeded.projectId);
    await runFaithfulCopyJob(
      { copyId, projectId: seeded.projectId },
      config,
      fakeClaude(lookedClose, { builder: sectionBuilder }).client,
      fakeBrowser(),
    );
    return seeded;
  }

  it("shows Lane 2's three steps on Mockups (29 September 2026), the copy tools folded away for admins", async () => {
    const { projectId } = await seedImported();
    const html = renderToStaticMarkup((await MockupsPage({ params: Promise.resolve({ id: projectId }), searchParams: Promise.resolve({}) })) as React.ReactElement);
    // Option B starts with the review (paid, on Sonnet 5, the estimate shown) or its $0 skip; Build waits for one of them.
    expect(html).toContain("Review &amp; suggestions");
    // One step bar only: the header's (29 September 2026).
    expect(html).not.toContain("flow-steps");
    expect(html).toMatch(/About \$\d+\.\d\d of AI on Sonnet 5 \(a first guess until a real review has run\)/);
    expect(html).toContain("Skip the review ($0)");
    expect(html).toContain(">Build site<");
    expect(html).toContain("Building opens once the review is done (or skipped).");
    expect(html).toContain("Advanced (admins)");
    expect(html).not.toContain("Build the faithful copy");
    // Option B's earlier screen stays one link away for admins.
    expect(html).toContain(`href="/projects/${projectId}/mockups?classic=1"`);
  });

  it("shows the match, the sections and the two side by side on the copy page", async () => {
    const { projectId } = await built();
    const node = await DesignCopyPage({ params: Promise.resolve({ id: projectId }) });
    const html = renderToStaticMarkup(node as React.ReactElement);
    expect(html).toContain("Matches the design: 87%");
    expect(html).toContain("1. Hero");
    expect(html).toContain("78%");
    expect(html).toContain("Font: Brandon Grotesque is not a free web font");
    expect(html).toContain("The designer’s Figma frame");
    expect(html).toContain("TAWD’s copy, as a web page");
    expect(html).toContain(`/projects/${projectId}/mockups/design/copy/live`);
    expect(html).toContain("Back to Design");
    // The order: the match and one plain sentence, the two side by side, the sections, then the boxes.
    expect(html).toContain("Close to the design, with small differences; the biggest difference is in “Our services” (78%).");
    const at = (text: string) => html.indexOf(text);
    expect(at("Matches the design")).toBeLessThan(at("The designer’s Figma frame"));
    expect(at("The designer’s Figma frame")).toBeLessThan(at("Section by section"));
    expect(at("Section by section")).toBeLessThan(at("Notes from the build"));
    expect(html).toContain("Looks close");
    expect(html).toMatch(/<details class="card copy-box"><summary>Notes from the build/);
    expect(html).toContain("every text matches the design");
  });

  it("leaves out the section list when the sections didn't line up, and shows what the look and the text check found", async () => {
    const { projectId } = await built();
    await h.db.update(designCopy).set({
      fidelity: { overall: 71, sections: [], method: "page", designHeight: 1300, copyHeight: 1500 },
      checks: {
        passed: true,
        issues: [],
        text: [{ number: 2, name: "Services", missing: ["Well drilling"], extra: ["Susan K."], repeated: [], outOfOrder: false }],
        visual: null,
        rebuilt: [2],
        firstMatch: 56,
      },
      notes: ["The top bar text is set a little smaller so it stays on one line. Details: Rectangle 12 at 0,0 1440x48, 15px instead of 16px"],
    });
    const html = renderToStaticMarkup((await DesignCopyPage({ params: Promise.resolve({ id: projectId }) })) as React.ReactElement);
    expect(html).not.toContain("Section by section");
    expect(html).toContain("Recognisably the design, with clear differences.");
    expect(html).toContain("1 section was rebuilt after the first look (the first build matched 56%).");
    expect(html).toContain("1 section to look at");
    expect(html).toContain("missing “Well drilling”");
    expect(html).toContain("not in the design “Susan K.”");
    expect(html).toContain("The top bar text is set a little smaller so it stays on one line.<details");
    expect(html).toContain("<summary>Details</summary><p>Rectangle 12 at 0,0 1440x48, 15px instead of 16px</p>");
  });

  it("keeps a note's layer names and sizes behind Details", () => {
    expect(splitNote("The logo is a little wider (Group 7, 212x60 instead of 200x60).")).toEqual({
      text: "The logo is a little wider.",
      details: "Group 7, 212x60 instead of 200x60",
    });
    expect(splitNote("Font: Brandon Grotesque is not a free web font; Montserrat is used instead.")).toEqual({
      text: "Font: Brandon Grotesque is not a free web font; Montserrat is used instead.",
      details: null,
    });
    expect(copySummary(93, [{ name: "Hero", score: 95 }])).toBe("Very close to the design.");
    expect(copySummary(40, [])).toBe("Far from the design.");
  });

  it("serves the copy as a page in a sandbox, and nothing before one is built", async () => {
    const empty = await seedImported();
    expect((await livePage(new Request("http://x"), { params: Promise.resolve({ id: empty.projectId }) })).status).toBe(404);
    await h.close();
    h = await createHarness();
    setDbForTesting(h.db as Database);
    const { projectId } = await built();
    const response = await livePage(new Request("http://x"), { params: Promise.resolve({ id: projectId }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toMatch(/^sandbox;/);
    const body = await response.text();
    expect(body).toContain('<a href="tel:+15305550199">Call (530) 555-0199</a>');
    expect(body).not.toContain("tawd-asset:");
  });

  it("sends the copy page back to Mockups until a copy is built", async () => {
    const { projectId } = await seedImported();
    await expect(DesignCopyPage({ params: Promise.resolve({ id: projectId }) })).rejects.toThrow(`redirect /projects/${projectId}/mockups`);
  });

  it("words the Slack line without the design's content", () => {
    expect(slackMessage("Dale Rowan", "p1", { kind: "design_copy_ready", match: 92 }, "https://t.example")).toBe(
      "*Dale Rowan*: the faithful copy of the designer's design is ready: it matches the design 92%. <https://t.example/projects/p1/mockups/design/copy|Open the copy>",
    );
  });
});

describe("only what is really in the frame", () => {
  it("leaves out hidden layers, transparent ones, and anything parked outside the frame or a clipping box", () => {
    const frame: FigmaNode = {
      id: "1:1",
      name: "Home",
      type: "FRAME",
      absoluteBoundingBox: box(0, 0, 1440, 2000),
      children: [
        { id: "1:2", name: "Reviews", type: "FRAME", absoluteBoundingBox: box(0, 800, 1440, 400), children: [{ id: "1:3", name: "r", type: "TEXT", characters: "Real review" }] },
        // A second version of the reviews, parked to the right of the frame.
        { id: "1:4", name: "Reviews v2", type: "FRAME", absoluteBoundingBox: box(1600, 800, 1440, 400), children: [{ id: "1:5", name: "s", type: "TEXT", characters: "Susan K." }] },
        { id: "1:6", name: "We Serve", type: "FRAME", visible: false, absoluteBoundingBox: box(0, 1200, 1440, 300) },
        { id: "1:7", name: "Ghost", type: "RECTANGLE", opacity: 0, absoluteBoundingBox: box(0, 0, 100, 100) },
        {
          id: "1:8",
          name: "Carousel",
          type: "FRAME",
          absoluteBoundingBox: box(0, 1500, 1440, 300),
          children: [
            { id: "1:9", name: "Slide 1", type: "FRAME", absoluteBoundingBox: box(0, 1500, 1440, 300) },
            // Scrolled out of the clipping carousel.
            { id: "1:10", name: "Slide 2", type: "FRAME", absoluteBoundingBox: box(1440, 1500, 1440, 300) },
          ],
        },
        {
          id: "1:11",
          name: "Loose group",
          type: "GROUP",
          absoluteBoundingBox: box(0, 1800, 1440, 200),
          children: [{ id: "1:12", name: "Inside", type: "FRAME", absoluteBoundingBox: box(0, 1800, 1440, 200) }],
        },
      ],
    };
    const ids: string[] = [];
    const walk = (n: FigmaNode) => {
      ids.push(n.id);
      (n.children ?? []).forEach(walk);
    };
    walk(visibleTree(frame));
    expect(ids).toEqual(["1:1", "1:2", "1:3", "1:8", "1:9", "1:11", "1:12"]);
  });

  it("gives the builder none of a hidden second version's text or images", () => {
    const file = designWithDrawings();
    const home = findNode(file.document, "2:10")!;
    home.children!.push({
      id: "8:1",
      name: "Reviews v2",
      type: "FRAME",
      absoluteBoundingBox: box(1600, 100, 1440, 400),
      children: [{ id: "8:2", name: "s", type: "TEXT", characters: "Susan K.", absoluteBoundingBox: box(1700, 150, 200, 30) }],
    });
    const outline = describeFrameForBuild(visibleTree(home), { byImageRef: {}, byNodeId: {} });
    expect(outline).not.toContain("Susan K.");
    expect(outline).not.toContain("Reviews v2");
  });
});

/* ---------- the Dale Rowan design at 66%: covered, stacked and leftover content (27 September 2026) ---------- */

const solid = { type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } };
const t = (id: string, characters: string, x: number, y: number): FigmaNode => ({ id, name: characters, type: "TEXT", characters, style: { fontFamily: "Montserrat", fontSize: 18 }, absoluteBoundingBox: box(x, y, 400, 30) });

/* The saved Pat frame, with what the 66% copy picked up: layers in Figma's list order, not the page's. */
function patLeftovers(): FigmaFile {
  const file = daleRowanFile();
  const home = file.document.children![2]!.children![0]!;
  home.absoluteBoundingBox = box(0, 0, 1440, 5200);
  home.children = [
    // A flattened picture of the old page, parked at the bottom (the blurry leftover).
    { id: "9:1", name: "Home 1", type: "RECTANGLE", absoluteBoundingBox: box(0, 3000, 1440, 2200), fills: [{ type: "IMAGE", imageRef: "heroRef0001" }] },
    { id: "9:2", name: "Services", type: "FRAME", absoluteBoundingBox: box(0, 1000, 1440, 800), fills: [solid], children: [t("9:3", "Our services", 80, 1040), t("9:4", "Well drilling", 80, 1100)] },
    // The old reviews, still "visible" but covered by the new block painted above them.
    { id: "9:5", name: "Reviews old", type: "FRAME", absoluteBoundingBox: box(0, 1800, 1440, 600), fills: [solid], children: [t("9:6", "Susan K.", 80, 1850), t("9:7", "Stewart B.", 80, 1900)] },
    { id: "9:8", name: "Reviews", type: "FRAME", absoluteBoundingBox: box(0, 1800, 1440, 600), fills: [solid], children: [t("9:9", "What customers say", 80, 1850), t("9:10", "Pat M.", 80, 1900)] },
    { id: "9:11", name: "Header", type: "FRAME", absoluteBoundingBox: box(0, 0, 1440, 1000), fills: [solid], children: [t("9:12", "Well drilling and pump repair in Grass Valley", 80, 300)] },
    // A second copy of the services, stacked on the first and see-through (no fill), so it isn't a cover.
    { id: "9:13", name: "Services copy", type: "FRAME", absoluteBoundingBox: box(0, 1000, 1440, 800), children: [t("9:14", "Our services", 80, 1040), t("9:15", "Well drilling", 80, 1100)] },
    { id: "9:16", name: "Footer", type: "FRAME", absoluteBoundingBox: box(0, 2400, 1440, 600), fills: [solid], children: [t("9:17", "No water? Call us", 80, 2450)] },
  ];
  return file;
}

describe("covered, stacked and leftover content", () => {
  it("leaves out covered layers, stacked copies and a flattened leftover picture, and reads sections top to bottom, each once", () => {
    const home = patLeftovers().document.children![2]!.children![0]!;
    const { frame, problems } = cleanFrame(home);
    expect(frame.children!.map((c) => c.name)).toEqual(["Header", "Services copy", "Reviews", "Footer"]);
    expect(problems).toEqual([
      { kind: "covered", name: "Reviews old" },
      { kind: "flattened_image", name: "Home 1" },
      { kind: "stacked", name: "Services" },
    ]);
    const texts = designTextsBySection(frame).flatMap((s) => s.texts);
    expect(texts).not.toContain("Susan K.");
    expect(texts.filter((x) => x === "Our services")).toHaveLength(1);
    expect(frameSections(frame).map((s) => s.name)).toEqual(["Header", "Services copy", "Reviews", "Footer"]);
    expect(describeFrameProblems("Home", problems)).toBe(
      'The frame "Home" contains stacked or covered content: 1 covered layer ("Reviews old"); 1 section stacked under another ("Services"); a large flattened picture ("Home 1"). TAWD leaves these out, but it\'s safer to clean the frame in Figma and import again.',
    );
  });

  it("keeps a design that has none of these as it is, and never treats text as a cover", () => {
    const frame: FigmaNode = {
      id: "1:1",
      name: "Home",
      type: "FRAME",
      absoluteBoundingBox: box(0, 0, 1440, 1200),
      children: [
        { id: "1:2", name: "Hero", type: "FRAME", absoluteBoundingBox: box(0, 0, 1440, 600), fills: [solid], children: [{ id: "1:3", name: "Photo", type: "RECTANGLE", absoluteBoundingBox: box(0, 0, 1440, 600), fills: [{ type: "IMAGE", imageRef: "x" }] }, t("1:4", "Headline over the photo", 80, 200)] },
        { id: "1:5", name: "Band", type: "FRAME", absoluteBoundingBox: box(0, 600, 1440, 600), fills: [solid], children: [t("1:6", "More", 80, 650)] },
      ],
    };
    const { frame: cleaned, problems } = cleanFrame(frame);
    expect(problems).toEqual([]);
    expect(designTextsBySection(cleaned).flatMap((s) => s.texts)).toEqual(["Headline over the photo", "More"]);
  });

  it("warns at import, builds only the clean sections in page order, and calls a copy that still differs 'not done' with the reason", async () => {
    const { admin, projectId } = await seedImported(patLeftovers);
    const [figma] = await h.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId));
    expect((figma!.importWarnings as string[]).join(" ")).toContain('The frame "Home" contains stacked or covered content');

    const copyId = await startDesignCopy(h.ctx, admin.viewer, projectId);
    const asks: string[] = [];
    // A builder that keeps putting the old reviews back, even after its rebuild.
    const claude = fakeClaude(() => [{ summary: "Off.", sections: [] }], {
      builder: (params) => {
        const text = lastUserText(params);
        asks.push(text);
        return turn(
          asked(params)
            .map((n) => `<tawd-section id="${n}"><section data-figma-section="${n}"><h2>Section ${n}</h2>${n === 3 ? "<p>What customers say</p><p>Pat M.</p><p>Susan K.</p>" : ""}</section></tawd-section>`)
            .join("\n"),
          "end_turn",
        );
      },
    });
    await runFaithfulCopyJob({ copyId, projectId }, config, claude.client, fakeBrowser());

    // Four sections, top to bottom, none of them the leftovers.
    expect(asks[0]).toContain("of 4");
    expect(asks.join("\n")).not.toContain("Stewart B.");
    const [row] = await h.db.select().from(designCopy).where(eq(designCopy.id, copyId));
    expect(row!.status).toBe("needs_cleanup");
    expect(row!.failureReason).toMatch(/^This design file has overlapping or leftover content\. Clean the frame in Figma, then re-import\. Still different after a rebuild: .*"Reviews"/);
    expect((row!.checks as { frameProblems: { kind: string }[] }).frameProblems.map((p) => p.kind)).toEqual(["covered", "flattened_image", "stacked"]);

    // The copy's own page (an admin's tool since 29 September 2026) says why it isn't done.
    const html = renderToStaticMarkup((await DesignCopyPage({ params: Promise.resolve({ id: projectId }) })) as React.ReactElement);
    expect(html).toContain("Not done: This design file has overlapping or leftover content. Clean the frame in Figma, then re-import.");
  });
});

/* ---------- the phone version (Option A, 28 September 2026) ---------- */

describe("the phone version of a copied page", () => {
  it("adds CSS for phones only, keeps the desktop page, and waits for the designer when there's no mobile frame", async () => {
    const { admin, projectId } = await seedImported();
    const copyId = await startDesignCopy(h.ctx, admin.viewer, projectId);
    await runFaithfulCopyJob({ copyId, projectId }, config, fakeClaude(lookedClose, { builder: sectionBuilder }).client, fakeBrowser());
    const [before] = await h.db.select().from(designCopy).where(eq(designCopy.id, copyId));
    const desktop = r2.objects.get(before!.sourceKey!)!.toString("utf8");
    await h.db.update(designCopy).set({ mobileStatus: "queued" }).where(eq(designCopy.id, copyId));

    let asked = "";
    const claude = fakeClaude(() => [], {
      builder: (params) => {
        asked = JSON.stringify(params);
        return turn("@media (max-width: 767px) { header { display: block; } h1 { font-size: 32px; } }", "end_turn");
      },
    });
    await runDesignMobileJob({ copyId, projectId }, config, claude.client as never, fakeBrowser());

    expect(asked).toContain("make a clean responsive version");
    const [after] = await h.db.select().from(designCopy).where(eq(designCopy.id, copyId));
    expect(after).toMatchObject({ mobileStatus: "done", mobileFrom: "responsive", mobileOverflow: false, mobileDecision: null });
    const source = r2.objects.get(after!.sourceKey!)!.toString("utf8");
    expect(source).toContain('<style data-tawd-mobile>');
    // Everything the desktop page had is still there, unchanged.
    expect(source.replace(/<style data-tawd-mobile>[\s\S]*?<\/style>\s*/, "")).toBe(desktop);
    expect(r2.objects.has(after!.mobilePngKey!)).toBe(true);
    expect(await h.db.select().from(aiCall).where(eq(aiCall.step, "design_mobile"))).toHaveLength(1);
  });
});

/* ---------- Option A: approved, then built exactly (28 September 2026) ---------- */

describe("building an Option A design exactly, end to end", () => {
  it("copies every page, records the client's approval, and builds the site from the copies with no AI", async () => {
    const { admin, projectId } = await seedImported();
    await h.db.update(projectTable).set({ laneOption: "a", conceptCount: null }).where(eq(projectTable.id, projectId));
    let view = await loadExactDesign(h.db, projectId);
    await confirmDesignPages(h.ctx, admin.viewer, projectId, view.pages.map((p) => ({ id: p.id, name: p.name, slug: p.slug })));
    await startExactCopies(h.ctx, admin.viewer, projectId);
    for (const job of queued.filter((q) => q.name === FAITHFUL_COPY_JOB)) {
      await runFaithfulCopyJob(job.data as never, config, fakeClaude(lookedClose, { builder: sectionBuilder }).client, fakeBrowser());
    }
    view = await loadExactDesign(h.db, projectId);
    await h.db.update(designCopy).set({ status: "done" }).where(eq(designCopy.projectId, projectId));
    expect((await loadExactDesign(h.db, projectId)).approvalProblems.join(" ")).toContain("no phone version yet");
    await h.db.update(designCopy).set({ mobileStatus: "done", mobileFrom: "responsive" }).where(eq(designCopy.projectId, projectId));
    expect((await loadExactDesign(h.db, projectId)).approvalProblems.join(" ")).toContain("hasn't accepted the responsive phone version");
    await h.db.update(designCopy).set({ mobileDecision: "accepted" }).where(eq(designCopy.projectId, projectId));
    expect((await loadExactDesign(h.db, projectId)).approvalProblems).toEqual([]);

    await expect(approveExactDesign(h.ctx, admin.viewer, projectId, { channel: "email", clientSaid: "" })).rejects.toThrow("what the client said");
    await approveExactDesign(h.ctx, admin.viewer, projectId, { channel: "email", clientSaid: "Approved in Figma last week; build it as is." });
    const [proj] = await h.db.select().from(projectTable).where(eq(projectTable.id, projectId));
    expect(proj!.status).toBe("build");
    const readiness = await siteReadiness(h.db, projectId);
    expect(readiness).toMatchObject({ exact: true, ready: true, clientApprovedCopy: true });

    queued = [];
    await startSiteBuild(h.ctx, admin.viewer, projectId);
    const [started] = await h.db.select().from(activityLog).where(eq(activityLog.action, "site.build_started"));
    expect((started!.valueAfter as { estimate: string }).estimate).toContain("Free: the approved design's pages");
    const claude = fakeClaude(() => [], { builder: () => turn("should not be asked", "end_turn") });
    await runSiteBuildJob(queued[0]!.data as never, config, claude.client as never, fakeBrowser());
    expect(claude.calls).toHaveLength(0);

    const [build] = await h.db.select().from(siteBuild).where(eq(siteBuild.projectId, projectId));
    expect(build!.status).toBe("done");
    const prefix = `projects/${projectId}/site/v1/`;
    const home = r2.objects.get(`${prefix}index.html`)!.toString("utf8");
    expect(home).toContain("<h1>Well drilling</h1>");
    expect(home).toContain("<title>");
    expect(home).not.toContain("tawd-asset:");
    expect(home).toMatch(/src="\/images\/home\/design-(image|logo)/);
    expect(r2.objects.get(`${prefix}robots.txt`)!.toString("utf8")).toContain("Disallow: /");
    // The pages TAWD adds wear the design's own header.
    expect(r2.objects.get(`${prefix}404.html`)!.toString("utf8")).toContain('data-figma-section="1"');
    expect(r2.objects.has(`${prefix}thank-you/index.html`)).toBe(true);
    expect((build!.pages as { path: string }[]).map((p) => p.path)[0]).toBe("/");
  });
});

/*
  Parallel copying, measured (28 September 2026): a Nora-sized page (11
  sections) with every AI call held for the same time, one call at a time
  (as before) and six at once (now). What changes is only how many calls
  wait on each other; the real minutes come from a real run.
*/
describe("parallel copying, measured", () => {
  function elevenSections(): FigmaFile {
    const file = daleRowanFile();
    const home = file.document.children![2]!.children![0]!;
    home.children = Array.from({ length: 11 }, (_, i) => ({
      id: `9:${i + 1}`,
      name: `Band ${i + 1}`,
      type: "FRAME",
      absoluteBoundingBox: box(0, i * 500, 1440, 500),
      children: [{ id: `9:${i + 1}:t`, name: "Heading", type: "TEXT", characters: `Heading ${i + 1}`, style: { fontFamily: "Georgia", fontSize: 32, fontWeight: 700 }, absoluteBoundingBox: box(100, i * 500 + 40, 600, 40) }],
    })) as FigmaNode[];
    home.absoluteBoundingBox = box(0, 0, 1440, 5500);
    return file;
  }

  it("builds the sections and the rebuilds at once: fewer calls waiting on each other", async () => {
    const CALL_MS = 200;
    const { admin, projectId } = await seedImported(elevenSections);
    const timeRun = async (atOnce: number) => {
      process.env.TAWD_SECTION_CALLS_AT_ONCE = String(atOnce);
      const copyId = await startDesignCopy(h.ctx, admin.viewer, projectId);
      // The look calls two sections off, so two are rebuilt, as on a real page.
      const claude = fakeClaude(
        () => [{ summary: "Mostly close.", sections: Array.from({ length: 11 }, (_, i) => ({ section: i + 1, verdict: i === 2 || i === 6 ? "off" : "close", differences: i === 2 || i === 6 ? ["Spacing."] : [] })) }],
        { builder: (params) => turn(asked(params).map((n) => `<tawd-section id="${n}"><section data-figma-section="${n}"><h2>Heading ${n}</h2></section></tawd-section>`).join("\n"), "end_turn") },
      );
      let inFlight = 0;
      let most = 0;
      const slow = {
        messages: {
          stream: (params: Record<string, unknown>) => {
            const inner = (claude.client as unknown as { messages: { stream: (p: Record<string, unknown>) => { finalMessage: () => Promise<unknown> } } }).messages.stream(params);
            return {
              finalMessage: async () => {
                inFlight += 1;
                most = Math.max(most, inFlight);
                await new Promise((resolve) => setTimeout(resolve, CALL_MS));
                inFlight -= 1;
                return inner.finalMessage();
              },
            };
          },
        },
      };
      const started = Date.now();
      await runFaithfulCopyJob({ copyId, projectId }, config, slow as never, fakeBrowser());
      return { ms: Date.now() - started, calls: claude.calls.length, most };
    };
    try {
      const before = await timeRun(1);
      const after = await timeRun(6);
      console.log(`[measured] 11 sections, ${CALL_MS} ms a call: one at a time ${before.ms} ms (${before.calls} calls); at once ${after.ms} ms (${after.calls} calls, ${after.most} in flight)`);
      expect(after.calls).toBe(before.calls);
      expect(before.most).toBe(1);
      expect(after.most).toBeGreaterThanOrEqual(4);
      // Groups at once, then the look, then the rebuilds at once: about three calls' worth instead of seven.
      expect(after.ms).toBeLessThan(before.ms * 0.6);
    } finally {
      delete process.env.TAWD_SECTION_CALLS_AT_ONCE;
    }
  });
});
