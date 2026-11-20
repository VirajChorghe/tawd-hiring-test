import path from "node:path";
import { and, eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  A model per AI step, the compact design read and reading chosen pages
  (Jason, 27 September 2026: design reading was too expensive on Opus).
  Stand-ins for Chromium and Claude; no AI spending.
*/

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
vi.mock("@/app/actions", () => {
  const f = async () => ({ ok: true });
  return new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : f), has: () => true });
});

import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, aiCall, figmaDesign, intakeFile, projectAddon } from "@tawd/core/schema";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { PermissionError } from "@tawd/core/permissions";
import { callCost, costOf, defaultModelFor, getModelConfig, modelForStep, priceConfigFor, requestSettings } from "@tawd/core/mockups";
import { stepModelConfig } from "@tawd/core/step-models";
import { createProject } from "@/lib/projects";
import { setQueueForTesting } from "@/lib/mockups";
import { planDesignUpload, startDesignUpload } from "@/lib/design-upload";
import { loadStepModelRows, saveStepModel, StepModelError } from "@/lib/step-models";
import { buildSpendReport, type CallRow } from "@/lib/spend-report";
import { resolvePeriod } from "@/lib/spend-report";
import { DesignReadButton } from "@/components/intake/figma-section";
import { StepModelsCard } from "@/components/admin/step-models-card";

import { runDesignUploadJob } from "../../../worker/src/design-upload";
import { runJobWithStops } from "../../../worker/src/stop";
import { stopWork } from "@/lib/stops";
import type { WorkerConfig } from "../../../worker/src/config";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2, fakeClaude, messageText, turn } from "./worker-fakes";

let h: Harness;
let r2: FakeR2;
let queued: { name: string; data: never }[];

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
  setQueueForTesting({ add: async (name, data) => void queued.push({ name, data: data as never }), getJob: async () => null });
});

afterEach(async () => {
  setQueueForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

describe("a model per step", () => {
  it("reads and checks on Sonnet by default, builds and reviews on Opus, and lets only admins change a step, logged", async () => {
    // The copies moved to Sonnet first (their low-scoring sections rebuilt on Opus) later the same day.
    expect(["design_read", "photo_text", "faithful_check", "reference_study", "faithful_copy"].map((s) => defaultModelFor(s))).toEqual(Array(5).fill("claude-sonnet-5"));
    expect(["build", "review", "polish", "polish_critique", "site_page", "faithful_copy_retry"].map((s) => defaultModelFor(s))).toEqual(Array(6).fill("claude-opus-5-5"));
    // A saved choice that isn't a known model is ignored.
    expect(modelForStep("design_read", { design_read: "gpt-4" })).toBe("claude-sonnet-5");

    const admin = await seedAdmin(h);
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    await expect(saveStepModel(h.ctx, pm.viewer, "photo_text", "claude-haiku-4-5")).rejects.toBeInstanceOf(PermissionError);
    await expect(saveStepModel(h.ctx, admin.viewer, "photo_text", "claude-3-opus")).rejects.toBeInstanceOf(StepModelError);
    await saveStepModel(h.ctx, admin.viewer, "photo_text", "claude-haiku-4-5");
    const rows = await loadStepModelRows(h.db);
    expect(rows.find((r) => r.step === "photo_text")).toMatchObject({ model: "claude-haiku-4-5", defaultModel: "claude-sonnet-5" });
    expect((await stepModelConfig(h.db, "photo_text")).outputPricePerMTok).toBe(5);
    const [logged] = await h.db.select().from(activityLog).where(eq(activityLog.action, "settings.step_model_changed"));
    expect(logged).toMatchObject({ valueBefore: { step: "Photo text check", model: "claude-sonnet-5" }, valueAfter: { step: "Photo text check", model: "claude-haiku-4-5" } });

    const models = [
      { id: "claude-opus-5-5", label: "Opus 5.5", prices: "$4 in, $20 out" },
      { id: "claude-sonnet-5", label: "Sonnet 5", prices: "$2 in, $10 out" },
      { id: "claude-haiku-4-5", label: "Haiku 4.5", prices: "$1 in, $5 out" },
    ];
    const card = renderToStaticMarkup(<StepModelsCard models={models} rows={rows} />);
    expect(card).toContain("AI model per step");
    // Photo text check: now Haiku, its default Sonnet marked as changed.
    expect(card).toContain("Sonnet 5 (changed)");
  });

  it("sends Haiku no effort or adaptive thinking, and keeps a structured output format", () => {
    expect(requestSettings("claude-opus-5-5", { effort: "high", adaptiveThinking: true })).toEqual({ output_config: { effort: "high" }, thinking: { type: "adaptive" } });
    expect(requestSettings("claude-haiku-4-5", { effort: "high", adaptiveThinking: true })).toEqual({});
    expect(requestSettings("claude-haiku-4-5", { effort: "low", format: { type: "json_schema" } })).toEqual({ output_config: { format: { type: "json_schema" } } });
  });

  it("prices each call at its own model's rates on Spend", () => {
    const base = getModelConfig();
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(callCost({ ...usage, model: "claude-opus-5-5" }, base)).toBe(24);
    expect(callCost({ ...usage, model: "claude-sonnet-5" }, base)).toBe(12);
    expect(callCost({ ...usage, model: "claude-haiku-4-5" }, base)).toBe(6);
    expect(costOf(usage, priceConfigFor("claude-sonnet-5", base))).toBe(12);

    const period = resolvePeriod({ kind: "month", month: "2026-09" }, "2026-09-27");
    const call = (model: string, step: string): CallRow => ({ model, runId: "r1", projectId: "p1", conceptId: null, step, scope: null, startedByUserId: "u1", day: "2026-09-27", inputTokens: 0, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const report = buildSpendReport({
      period,
      calls: [call("claude-sonnet-5", "design_read"), call("claude-opus-5-5", "build")],
      runs: [],
      runCalls: [],
      projects: new Map([["p1", { name: "Nora", deleted: false }]]),
      people: new Map(),
      config: base,
      monthlyLimit: 20,
      monthToDate: 0,
    });
    expect(report.summary.spent).toBeCloseTo(1 + 2);
    const reading = report.byStep.find((s) => s.key === "inputs")!;
    expect(reading).toMatchObject({ label: "Reading and inputs", models: "Sonnet 5" });
    expect(reading.total).toBeCloseTo(1);
  });
});

describe("reading the design on its step's model, the home page first", () => {
  async function threePages() {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Nora Happy Beagle Lady", trade: "photography", tier: "growth", lane: "lane_2", laneOption: "b", conceptCount: 1, status: "intake", memberUserIds: [] });
    for (const n of [1, 2, 3]) {
      const key = `projects/${id}/intake/page${n}.png`;
      await r2.put(key, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x70, 0x6e, 0x67]));
      await h.db.insert(intakeFile).values({ projectId: id, kind: "design_file", storageKey: key, fileName: `page${n}.png`, contentType: "image/png", status: "ready", sizeBytes: 1000 + n, createdAt: new Date(Date.now() + n * 1000) });
    }
    const page = {
      // The page cap listens for close (locked-context.ts); a fake page gives its slot back at once.
      once: (_event: string, give: () => void) => give(),
      route: async () => undefined,
      setContent: async () => undefined,
      evaluate: async (_fn: unknown, arg: Record<string, unknown>) => ("boxes" in arg ? (arg.boxes as unknown[]).map(() => "data:image/png;base64,iVBORw0KGgo=") : { width: 1440, height: 1200, png: "data:image/png;base64,iVBORw0KGgo=" }),
    };
    const browser = { newContext: async () => ({ once: (_event: string, give: () => void) => give(), route: async () => undefined, newPage: async () => page, close: async () => undefined }) } as never;
    return { admin, id, browser };
  }

  // The compact reply the prompt now asks for.
  const compact = (n: number) => JSON.stringify({ c: ["#ffffff", "#111111"], f: [], b: 0, s: [[`Page ${n}`, 0, 1200, 0]], t: [[`Heading on page ${n}`, 80, 100, 600, 60, 48, 1, 700]], i: [[700, 300, 500, 400, "p"]] });

  it("reads only the chosen pages on Sonnet, keeps them, and reads the rest later", async () => {
    const { admin, id, browser } = await threePages();
    const asked: { page: number; model: unknown; output: unknown; system: string }[] = [];
    const claude = fakeClaude(() => [], {
      builder: (params) => {
        const n = Number(/^Page (\d)/.exec(messageText((params.messages as { content: unknown }[])[0]!.content))![1]);
        asked.push({ page: n, model: params.model, output: params.output_config, system: JSON.stringify(params.system) });
        return turn(compact(n), "end_turn");
      },
    });

    // First: the home page only.
    await startDesignUpload(h.ctx, admin.viewer, id, { pages: [1] });
    expect(queued[0]!.data).toMatchObject({ pages: [1] });
    await runDesignUploadJob(queued[0]!.data, config, claude.client as never, browser);
    expect(asked.map((a) => [a.page, a.model])).toEqual([[1, "claude-sonnet-5"]]);
    expect(asked[0]!.output).toEqual({ effort: "low" });
    expect(asked[0]!.system).toContain('\\"t\\": [texts]');
    let [row] = await h.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, id));
    expect(row!.importStatus).toBe("done");
    expect((row!.frames as { name: string }[]).map((f) => f.name)).toEqual(["Home"]);
    expect(row!.importWarnings).toContain("Pages 2, 3 aren't read yet, so the design has 1 of 3 pages. Read the rest from the intake's Design section.");
    const [call] = await h.db.select().from(aiCall).where(and(eq(aiCall.projectId, id), eq(aiCall.step, "design_read")));
    expect(call!.model).toBe("claude-sonnet-5");

    // The dialog: page 1 kept, 2 and 3 ticked, the estimate on Sonnet for those two.
    const plan = await planDesignUpload(h.db, id);
    // An image's slices are a guess (3) until it is drawn.
    expect(plan.pageList).toEqual([
      { number: 1, slices: 3, kept: true },
      { number: 2, slices: 3, kept: false },
      { number: 3, slices: 3, kept: false },
    ]);
    expect(plan.perSlice).toMatchObject({ model: "Sonnet 5", measured: true });
    const html = renderToStaticMarkup(
      <DesignReadButton
        projectId={id}
        working={false}
        label="Read the design again"
        startOpen
        upload={{ files: [], pages: 3, visionPages: 3, estimateLine: plan.estimate.label, keptPages: plan.keptPages, pageList: plan.pageList, perSlice: plan.perSlice, figmaLinkAllowed: true }}
      />,
    );
    expect(html).toContain("Read the uploaded design again?");
    expect(html).toContain("Only the home page");
    expect(html).toContain("read before and kept");
    expect(html).toContain("of AI on Sonnet 5 for 2 pages read from the picture");
    expect(html).toContain("Read 2 pages");

    // Then the rest: only pages 2 and 3 are read; the design has all three.
    asked.length = 0;
    await startDesignUpload(h.ctx, admin.viewer, id, { pages: [2, 3] });
    await runDesignUploadJob(queued[1]!.data, config, claude.client as never, browser);
    expect(asked.map((a) => a.page)).toEqual([2, 3]);
    [row] = await h.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, id));
    expect((row!.frames as { name: string }[]).map((f) => f.name)).toEqual(["Home", "Heading on page 2", "Heading on page 3"]);
    expect((row!.pagesRead as { pages: number[] }).pages).toEqual([1, 2, 3]);
    // The client-supplied design add-on counts every page of the upload, read yet or not (27 September 2026).
    const [addon] = await h.db.select().from(projectAddon).where(eq(projectAddon.projectId, id));
    expect(addon).toMatchObject({ addonKey: "client_design", quantity: 3 });
    expect(await h.db.select().from(projectAddon).where(eq(projectAddon.projectId, id))).toHaveLength(1);
  });

  it("runs on Haiku without an effort setting when an admin chooses it", async () => {
    const { admin, id, browser } = await threePages();
    await saveStepModel(h.ctx, admin.viewer, "design_read", "claude-haiku-4-5");
    const seen: unknown[] = [];
    const claude = fakeClaude(() => [], {
      builder: (params) => {
        seen.push([params.model, params.output_config, params.thinking]);
        return turn(compact(1), "end_turn");
      },
    });
    await startDesignUpload(h.ctx, admin.viewer, id, { pages: [1] });
    await runDesignUploadJob(queued[0]!.data, config, claude.client as never, browser);
    expect(seen).toEqual([["claude-haiku-4-5", undefined, undefined]]);
    expect((await planDesignUpload(h.db, id)).estimate.label).toContain("of AI on Haiku 4.5");
  });
});

describe("Stop during a design read (28 September 2026)", () => {
  it("ends before the next page's AI call and keeps the page already read", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Nora Happy Beagle Lady", trade: "photography", tier: "growth", lane: "lane_2", laneOption: "b", conceptCount: 1, status: "intake", memberUserIds: [] });
    for (const n of [1, 2]) {
      const key = `projects/${id}/intake/page${n}.png`;
      await r2.put(key, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x70, 0x6e, 0x67]));
      await h.db.insert(intakeFile).values({ projectId: id, kind: "design_file", storageKey: key, fileName: `page${n}.png`, contentType: "image/png", status: "ready", sizeBytes: 1000 + n, createdAt: new Date(Date.now() + n * 1000) });
    }
    const page = {
      // The page cap listens for close (locked-context.ts); a fake page gives its slot back at once.
      once: (_event: string, give: () => void) => give(),
      route: async () => undefined,
      setContent: async () => undefined,
      evaluate: async (_fn: unknown, arg: Record<string, unknown>) => ("boxes" in arg ? (arg.boxes as unknown[]).map(() => "data:image/png;base64,iVBORw0KGgo=") : { width: 1440, height: 1200, png: "data:image/png;base64,iVBORw0KGgo=" }),
    };
    const browser = { newContext: async () => ({ once: (_event: string, give: () => void) => give(), route: async () => undefined, newPage: async () => page, close: async () => undefined }) } as never;
    const claude = fakeClaude(() => [], { builder: () => turn(JSON.stringify({ c: ["#ffffff"], f: [], b: 0, s: [["Page", 0, 1200, 0]], t: [["Heading", 80, 100, 600, 60, 48, 0]], i: [] }), "end_turn") });
    let calls = 0;
    // The PM presses Stop while page 1 is being read.
    const client = {
      messages: {
        stream: (params: Record<string, unknown>) => {
          const inner = (claude.client as unknown as { messages: { stream: (p: Record<string, unknown>) => { finalMessage: () => Promise<unknown> } } }).messages.stream(params);
          return {
            finalMessage: async () => {
              calls += 1;
              if (calls === 1) await stopWork(h.ctx, admin.viewer, id, "design_read");
              return inner.finalMessage();
            },
          };
        },
      },
    };
    await startDesignUpload(h.ctx, admin.viewer, id);
    const failure = await runJobWithStops({ name: "design-upload-read", data: queued[0]!.data, timestamp: Date.now() - 1000 }, () => runDesignUploadJob(queued[0]!.data, config, client as never, browser)).catch((e: Error) => e);
    expect(String(failure)).toContain("Stopped by Test Admin before the next AI call");
    expect(calls).toBe(1);
    const [row] = await h.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, id));
    expect((row!.pagesRead as { pages: number[] }).pages).toEqual([1]);
  });
});
