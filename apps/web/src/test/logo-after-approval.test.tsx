import path from "node:path";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  The logo after approval (27 September 2026): a new logo put into the
  approved concept (free, no AI, a new version that becomes the approved
  one, the DESIGN.md written again), and the client's approval of the logo
  recorded like the mockup decision.
*/

const state: { user: unknown } = { user: null };
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/projects",
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("@/lib/session", () => ({ requireUser: async () => state.user }));

import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, concept, conceptVersion, intakeFile, logoApproval, logoSwap, mockupRun, project as projectTable } from "@tawd/core/schema";
import { approvedMockupVersion } from "@tawd/core/approved";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { PermissionError } from "@tawd/core/permissions";
import { LOGO_SWAP_JOB, type LogoSwapJobData } from "@tawd/core/queue";
import { loadClientDesignDoc } from "@/lib/client-design";
import { recordClientDecision } from "@/lib/concept-review";
import { loadLogoAfterApproval, recordLogoApproval, startLogoSwap } from "@/lib/logo-after-approval";
import { setQueueForTesting } from "@/lib/mockups";
import { ProjectDeleteError, deleteProject } from "@/lib/project-deletion";
import { createProject } from "@/lib/projects";

import { runLogoSwapJob } from "../../../worker/src/logo-swap";
import type { WorkerConfig } from "../../../worker/src/config";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2, fakeBrowser } from "./worker-fakes";

let h: Harness;
let r2: FakeR2;
let queued: { name: string; data: LogoSwapJobData }[];

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
  setQueueForTesting({ add: async (name, data) => void queued.push({ name, data: data as LogoSwapJobData }), getJob: async () => null });
});

afterEach(async () => {
  setQueueForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

const SOURCE = `<!doctype html><html><head><style>body{background:#fafaf7;color:#1d232b}.btn{background:#1f4e79;color:#fff}</style></head><body><header><img src="tawd-asset:logo" alt="Glow Med Spa"><a class="btn" href="tel:9165550142">Call</a></header><section><h1>Calm, clinical care</h1></section></body></html>`;

async function logo(projectId: string, name: string, at: Date) {
  const key = `projects/${projectId}/intake/${name}`;
  r2.objects.set(key, Buffer.from(`png-${name}`));
  await h.db.insert(intakeFile).values({ projectId, kind: "logo", storageKey: key, fileName: name, contentType: "image/png", status: "ready", createdAt: at } as never);
}

async function approved() {
  const admin = await seedAdmin(h);
  const projectId = await createProject(h.ctx, admin.viewer, { clientName: "Glow Med Spa", trade: "med_spa", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 1, status: "intake", memberUserIds: [] });
  await h.db.update(projectTable).set({ status: "mockups" }).where(eq(projectTable.id, projectId));
  await logo(projectId, "old-logo.png", new Date("2026-09-20T10:00:00Z"));
  const [run] = await h.db.insert(mockupRun).values({ projectId, conceptCount: 1, status: "succeeded", model: "m", startedByUserId: admin.viewer.id }).returning();
  const [c] = await h.db.insert(concept).values({ runId: run!.id, projectId, label: "B", direction: "clinical_calm", skillId: "ui_ux_pro_max", status: "ready" }).returning();
  const base = `projects/${projectId}/concepts/${c!.id}/v2`;
  await h.db.insert(conceptVersion).values({ conceptId: c!.id, version: 2, htmlKey: `${base}/page.html`, checks: { passed: true, issues: [], stage: "cd_improve" }, createdAt: new Date("2026-09-21T10:00:00Z") } as never);
  r2.objects.set(`${base}/source.html`, Buffer.from(SOURCE));
  await recordClientDecision(h.ctx, admin.viewer, { conceptId: c!.id, channel: "meeting", changesRequested: false, clientSaid: "B, please." });
  return { admin, projectId, conceptId: c!.id };
}

describe("a new logo after the client approved a mockup", () => {
  it("is offered for the approved concept, put in as a new version with no AI, and the DESIGN.md is written again", async () => {
    const { admin, projectId, conceptId } = await approved();
    const names = new Map<string, string>();
    expect((await loadLogoAfterApproval(h.db, projectId, names))!.logoChanged).toBe(false);

    await logo(projectId, "new-logo.png", new Date());
    expect(await loadLogoAfterApproval(h.db, projectId, names)).toMatchObject({ conceptLabel: "B", version: 2, logoChanged: true });

    const designer = await seedUser(h, admin.viewer, { email: "seo@velocitymedialab.com", roles: ["seo"] });
    await expect(startLogoSwap(h.ctx, designer.viewer, projectId)).rejects.toThrow(PermissionError);
    await startLogoSwap(h.ctx, admin.viewer, projectId);
    await expect(startLogoSwap(h.ctx, admin.viewer, projectId)).rejects.toThrow("already going in");
    expect(queued[0]!.name).toBe(LOGO_SWAP_JOB);

    await runLogoSwapJob(queued[0]!.data, config, fakeBrowser() as never);
    const [swap] = await h.db.select().from(logoSwap).where(eq(logoSwap.projectId, projectId));
    expect(swap).toMatchObject({ status: "done", fromVersion: 2, toVersion: 3 });
    const [v3] = await h.db.select().from(conceptVersion).where(eq(conceptVersion.version, 3));
    expect(v3!.conceptId).toBe(conceptId);
    expect((v3!.checks as { stage: string }).stage).toBe("logo_swap");
    // Only the logo changed: the source is the approved page, word for word.
    expect(r2.objects.get(v3!.htmlKey!.replace("page.html", "source.html"))!.toString()).toBe(SOURCE);
    expect((await approvedMockupVersion(h.db, projectId))!.version.version).toBe(3);

    const doc = await loadClientDesignDoc(h.db, projectId);
    expect(doc).toMatchObject({ version: 2, conceptVersion: 3 });
    expect(doc!.markdown).toContain("Concept B v3, with the new logo");
    expect((await loadLogoAfterApproval(h.db, projectId, names))!.logoChanged).toBe(false);
    const actions = (await h.db.select().from(activityLog)).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["mockups.logo_swap_started", "mockups.logo_swapped", "design_md.created"]));
  });

  it("records the client's approval of the logo, logged, and updates the mark", async () => {
    const { admin, projectId } = await approved();
    const names = new Map([[admin.viewer.id, "Sam"]]);
    expect((await loadLogoAfterApproval(h.db, projectId, names))!.mark).toEqual({ approved: false, line: "The client's approval of the logo isn't recorded yet." });
    await expect(recordLogoApproval(h.ctx, admin.viewer, projectId, { channel: "fax", clientSaid: "Yes" })).rejects.toThrow("how the approval came in");
    await expect(recordLogoApproval(h.ctx, admin.viewer, projectId, { channel: "email", clientSaid: "" })).rejects.toThrow("what the client said");
    await recordLogoApproval(h.ctx, admin.viewer, projectId, { channel: "email", clientSaid: "The new logo looks right." });
    expect((await loadLogoAfterApproval(h.db, projectId, names))!.mark).toEqual({ approved: true, line: 'Logo approved by the client: recorded by Sam (email), "The new logo looks right.".' });
    const [log] = (await h.db.select().from(activityLog)).filter((l) => l.action === "mockups.logo_approved");
    expect(log!.valueAfter).toMatchObject({ concept: "B", version: 2, channel: "email" });
  });

  it("shows on the approved Mockups page, and goes with the project", async () => {
    const { admin, projectId } = await approved();
    await logo(projectId, "new-logo.png", new Date());
    state.user = admin.viewer;
    const { default: MockupsPage } = await import("@/app/(app)/projects/[id]/mockups/page");
    const html = renderToStaticMarkup(await MockupsPage({ params: Promise.resolve({ id: projectId }), searchParams: Promise.resolve({}) } as never));
    expect(html).toContain("The logo changed after the client approved Concept B v2");
    expect(html).toContain("Put the new logo into the approved concept");
    expect(html).toContain("Record logo approval");

    await recordLogoApproval(h.ctx, admin.viewer, projectId, { channel: "phone", clientSaid: "Fine." });
    await startLogoSwap(h.ctx, admin.viewer, projectId);
    // The swap is still queued, so deletion waits for it.
    const input = { confirmName: "Glow Med Spa", reason: "Test project, removing it" };
    await expect(deleteProject(h.ctx, admin.viewer, projectId, input)).rejects.toThrow(ProjectDeleteError);
    await h.db.update(logoSwap).set({ status: "failed" }).where(eq(logoSwap.projectId, projectId));
    await deleteProject(h.ctx, admin.viewer, projectId, input);
    expect(await h.db.select().from(logoSwap)).toEqual([]);
    expect(await h.db.select().from(logoApproval)).toEqual([]);
  });
});
