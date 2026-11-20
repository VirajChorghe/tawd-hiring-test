import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  activityLog,
  aiUsageArchive,
  clientDesignDoc,
  concept,
  conceptVersion,
  deletedProject,
  intakeFile,
  mockupRun,
  project,
  projectIntake,
  siteBuild,
} from "@tawd/core/schema";
import { verifyActivityChain } from "@tawd/core/activity";
import {
  projectStoragePrefix,
  setStorageForTesting,
  type FileStorage,
  type StoredObject,
} from "@tawd/core/intake/storage";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { PermissionError } from "@tawd/core/permissions";
import {
  ProjectDeleteError,
  RUNNING_WORK_HOURS,
  deleteProject,
  runningWork,
  listArchivedAiUsage,
} from "@/lib/project-deletion";
import { createProject, listFullActivityLog } from "@/lib/projects";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";

/*
  Deleting a project: who may, what it takes, what goes and what stays.

  Storage is a stand-in for R2 that behaves like it for the calls that
  matter here - put, head, list and remove - so the tests can prove the
  files are really gone, and that nobody else's are.
*/
class FakeR2 implements FileStorage {
  objects = new Map<string, StoredObject>();
  /** Keys that refuse to delete, to prove a failed cleanup keeps the project. */
  stuck = new Set<string>();

  async signUpload(key: string) {
    return `https://fake-r2.test/${key}`;
  }
  async signDownload(key: string) {
    return `https://fake-r2.test/${key}`;
  }
  async head(key: string) {
    return this.objects.get(key) ?? null;
  }
  async remove(key: string) {
    if (!this.stuck.has(key)) this.objects.delete(key);
  }
  async put(key: string, body: Buffer, contentType: string) {
    this.objects.set(key, { sizeBytes: body.length, contentType });
  }
  async get() {
    return null;
  }
  async copy(from: string, to: string) {
    const object = this.objects.get(from);
    if (object) this.objects.set(to, { ...object });
  }
  async list(prefix: string) {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix));
  }
}

let h: Harness;
let r2: FakeR2;

beforeEach(async () => {
  h = await createHarness();
  r2 = new FakeR2();
  setStorageForTesting(r2);
});

afterEach(async () => {
  setStorageForTesting(null);
  await h.close();
});

const NAME = "Dale Rowan";
const REASON = "Duplicate created by mistake during testing";

const base = {
  trade: "well_and_pump" as const,
  tier: "starter" as const,
  lane: "lane_1" as const,
  laneOption: null,
  conceptCount: 2,
  status: "mockups" as const,
  memberUserIds: [] as string[],
};

/* A project with an intake, two uploads, a run with two built concepts, and its files in R2. */
async function seedProject(
  admin: Awaited<ReturnType<typeof seedAdmin>>,
  clientName = NAME,
) {
  const id = await createProject(h.ctx, admin.viewer, { ...base, clientName });
  await saveIntakeSection(h.ctx, admin.viewer, id, "business", {
    name: `${clientName} Pump & Well`,
  });

  const prefix = projectStoragePrefix(id);
  const logoKey = `${prefix}logo/l1-logo.png`;
  const photoKey = `${prefix}photo/p1-crew.jpg`;
  await h.db.insert(intakeFile).values([
    { projectId: id, kind: "logo", storageKey: logoKey, fileName: "logo.png", contentType: "image/png", status: "ready" },
    { projectId: id, kind: "photo", storageKey: photoKey, fileName: "crew.jpg", contentType: "image/jpeg", status: "ready" },
  ]);

  const [run] = await h.db
    .insert(mockupRun)
    .values({ projectId: id, conceptCount: 2, status: "succeeded", model: "claude-opus-5-5" })
    .returning();

  const artefacts: string[] = [logoKey, photoKey];
  for (const label of ["A", "B"]) {
    const [row] = await h.db
      .insert(concept)
      .values({
        runId: run!.id,
        projectId: id,
        label,
        direction: "rugged_craftsman",
        skillId: "impeccable",
        status: "ready",
      })
      .returning();
    for (const version of [1, 2]) {
      const vbase = `${prefix}concepts/${row!.id}/v${version}`;
      await h.db.insert(conceptVersion).values({
        conceptId: row!.id,
        version,
        htmlKey: `${vbase}/page.html`,
        pngKey: `${vbase}/full.png`,
        foldPngKey: `${vbase}/fold.png`,
        // Running totals, as the worker stores them.
        inputTokens: version * 10_000,
        outputTokens: version * 30_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 9_000,
      });
      artefacts.push(`${vbase}/page.html`, `${vbase}/full.png`, `${vbase}/fold.png`);
    }
  }

  for (const key of artefacts) {
    await r2.put(key, Buffer.from("x"), "application/octet-stream");
  }

  return { id, prefix, artefacts, runId: run!.id };
}

describe("who can delete a project", () => {
  it("refuses a PM, even one who can edit the project", async () => {
    const admin = await seedAdmin(h);
    const pm = await seedUser(h, admin.viewer, {
      email: "pm@velocitymedialab.com",
      roles: ["pm"],
    });
    const { id } = await seedProject(admin);

    await expect(
      deleteProject(h.ctx, pm.viewer, id, { confirmName: NAME, reason: REASON }),
    ).rejects.toBeInstanceOf(PermissionError);

    const [still] = await h.db.select().from(project).where(eq(project.id, id));
    expect(still).toBeDefined();
  });

  it("lets an admin", async () => {
    const admin = await seedAdmin(h);
    const { id } = await seedProject(admin);

    await expect(
      deleteProject(h.ctx, admin.viewer, id, { confirmName: NAME, reason: REASON }),
    ).resolves.toMatchObject({ clientName: NAME });
  });
});

describe("confirming the deletion", () => {
  it.each([
    ["a different name", "Pat Rivera"],
    ["different capitals", "dale rowan"],
    ["nothing at all", ""],
  ])("refuses %s", async (_why, typed) => {
    const admin = await seedAdmin(h);
    const { id, artefacts } = await seedProject(admin);

    await expect(
      deleteProject(h.ctx, admin.viewer, id, { confirmName: typed, reason: REASON }),
    ).rejects.toThrow(/does not match/);

    // Nothing was touched: the rows and every file are still there.
    const [still] = await h.db.select().from(project).where(eq(project.id, id));
    expect(still).toBeDefined();
    for (const key of artefacts) expect(await r2.head(key)).not.toBeNull();
  });

  it("accepts the exact name with stray spaces around it", async () => {
    const admin = await seedAdmin(h);
    const { id } = await seedProject(admin);
    await expect(
      deleteProject(h.ctx, admin.viewer, id, { confirmName: `  ${NAME} `, reason: REASON }),
    ).resolves.toBeDefined();
  });

  it("requires a reason", async () => {
    const admin = await seedAdmin(h);
    const { id } = await seedProject(admin);
    await expect(
      deleteProject(h.ctx, admin.viewer, id, { confirmName: NAME, reason: "  oops " }),
    ).rejects.toThrow(/reason of at least/);
  });
});

describe("what cannot be deleted", () => {
  it("refuses a live project and says why", async () => {
    const admin = await seedAdmin(h);
    const { id, artefacts } = await seedProject(admin);
    await h.db.update(project).set({ status: "live" }).where(eq(project.id, id));

    const attempt = deleteProject(h.ctx, admin.viewer, id, {
      confirmName: NAME,
      reason: REASON,
    });
    await expect(attempt).rejects.toBeInstanceOf(ProjectDeleteError);
    await expect(attempt).rejects.toThrow(/Live projects cannot be deleted/);

    for (const key of artefacts) expect(await r2.head(key)).not.toBeNull();
  });

  it("refuses a project that has gone live, even once paused (Jason, 13 October 2026)", async () => {
    const admin = await seedAdmin(h);
    const { id, artefacts } = await seedProject(admin);
    await h.db.update(project).set({ status: "paused", liveAt: new Date() }).where(eq(project.id, id));

    const attempt = deleteProject(h.ctx, admin.viewer, id, { confirmName: NAME, reason: REASON });
    await expect(attempt).rejects.toThrow(/has gone live, so it cannot be deleted/);
    for (const key of artefacts) expect(await r2.head(key)).not.toBeNull();
    expect(await h.db.select().from(project).where(eq(project.id, id))).toHaveLength(1);
  });

  it("refuses while concepts are still generating", async () => {
    const admin = await seedAdmin(h);
    const { id, runId } = await seedProject(admin);
    await h.db.update(mockupRun).set({ status: "running" }).where(eq(mockupRun.id, runId));

    await expect(
      deleteProject(h.ctx, admin.viewer, id, { confirmName: NAME, reason: REASON }),
    ).rejects.toThrow(/still generating/);
  });

  it("refuses while other work is still running, and says which", async () => {
    const admin = await seedAdmin(h);
    const { id, artefacts } = await seedProject(admin);
    const [build] = await h.db.insert(siteBuild).values({ projectId: id, version: 1, status: "working" }).returning();

    await expect(
      deleteProject(h.ctx, admin.viewer, id, { confirmName: NAME, reason: REASON }),
    ).rejects.toThrow("Work is still running for this project (a site build). Wait for it to finish, then delete.");
    for (const key of artefacts) expect(await r2.head(key)).not.toBeNull();

    // A job left "working" by a worker that died long ago never blocks deletion for good.
    const old = new Date(Date.now() - (RUNNING_WORK_HOURS + 1) * 3_600_000);
    await h.db.update(siteBuild).set({ createdAt: old }).where(eq(siteBuild.id, build!.id));
    expect(await runningWork(h.db, id)).toEqual([]);
    await deleteProject(h.ctx, admin.viewer, id, { confirmName: NAME, reason: REASON });
  });
});

describe("what deleting removes", () => {
  it("removes every file in R2, and only this project's", async () => {
    const admin = await seedAdmin(h);
    const doomed = await seedProject(admin);
    const other = await seedProject(admin, "Sacramento Drain Pros");
    // A stray object under the prefix that no row mentions.
    await r2.put(`${doomed.prefix}orphan/leftover.pdf`, Buffer.from("x"), "application/pdf");

    const result = await deleteProject(h.ctx, admin.viewer, doomed.id, {
      confirmName: NAME,
      reason: REASON,
    });

    expect(await r2.list(doomed.prefix)).toEqual([]);
    for (const key of doomed.artefacts) expect(await r2.head(key)).toBeNull();
    // 2 uploads + 2 concepts x 2 versions x 3 files + the orphan.
    expect(result.filesRemoved).toBe(2 + 12 + 1);

    // The neighbour is untouched.
    for (const key of other.artefacts) expect(await r2.head(key)).not.toBeNull();
  });

  it("removes the project's data", async () => {
    const admin = await seedAdmin(h);
    const { id } = await seedProject(admin);
    await h.db.insert(clientDesignDoc).values({ projectId: id, version: 1, source: "concept", markdown: "# DESIGN.md" });

    await deleteProject(h.ctx, admin.viewer, id, { confirmName: NAME, reason: REASON });

    expect(await h.db.select().from(project).where(eq(project.id, id))).toEqual([]);
    expect(await h.db.select().from(clientDesignDoc).where(eq(clientDesignDoc.projectId, id))).toEqual([]);
    expect(await h.db.select().from(projectIntake).where(eq(projectIntake.projectId, id))).toEqual([]);
    expect(await h.db.select().from(intakeFile).where(eq(intakeFile.projectId, id))).toEqual([]);
    expect(await h.db.select().from(mockupRun).where(eq(mockupRun.projectId, id))).toEqual([]);
    expect(await h.db.select().from(concept).where(eq(concept.projectId, id))).toEqual([]);
    expect(await h.db.select().from(conceptVersion)).toEqual(
      [], // only this project had versions
    );
  });

  it("keeps the project if any file refuses to go", async () => {
    const admin = await seedAdmin(h);
    const { id, artefacts } = await seedProject(admin);
    r2.stuck.add(artefacts[3]!);

    await expect(
      deleteProject(h.ctx, admin.viewer, id, { confirmName: NAME, reason: REASON }),
    ).rejects.toThrow(/1 file is still in storage/);

    const [still] = await h.db.select().from(project).where(eq(project.id, id));
    expect(still).toBeDefined();
    const deleted = await h.db.select().from(deletedProject);
    expect(deleted).toEqual([]);
  });

  it("refuses a malformed id rather than deleting under a broad prefix", () => {
    expect(() => projectStoragePrefix("")).toThrow();
    expect(() => projectStoragePrefix("../")).toThrow();
    expect(projectStoragePrefix("0b0c1f8e-2f5b-4a55-9a1d-2d8f0a6c3e11")).toBe(
      "projects/0b0c1f8e-2f5b-4a55-9a1d-2d8f0a6c3e11/",
    );
  });
});

describe("what deleting keeps", () => {
  it("keeps every activity entry, names the project as deleted, and records the deletion", async () => {
    const admin = await seedAdmin(h);
    const { id } = await seedProject(admin);

    const before = await h.db.select().from(activityLog).where(eq(activityLog.entityId, id));
    expect(before.length).toBeGreaterThan(0);

    await deleteProject(h.ctx, admin.viewer, id, { confirmName: NAME, reason: REASON });

    const after = await h.db.select().from(activityLog).where(eq(activityLog.entityId, id));
    // Every earlier entry, plus exactly one new one.
    expect(after.length).toBe(before.length + 1);
    for (const entry of before) {
      expect(after.find((a) => a.seq === entry.seq)?.hash).toBe(entry.hash);
    }

    const deletion = after.find((a) => a.action === "project.deleted");
    expect(deletion?.actorEmail).toBe(admin.viewer.email);
    expect(deletion?.valueBefore).toMatchObject({ clientName: NAME, status: "mockups" });
    expect(deletion?.valueAfter).toEqual({
      reason: REASON,
      filesRemoved: 14,
      conceptsArchived: 2,
    });

    const log = await listFullActivityLog(h.db, admin.viewer, 200, { projectId: id });
    expect(log.length).toBe(after.length);
    expect(log.every((e) => e.deletedProjectName === NAME)).toBe(true);
    expect(log.every((e) => e.projectName === null)).toBe(true);

    expect((await verifyActivityChain(h.db)).valid).toBe(true);
  });

  it("records who deleted it, when and why", async () => {
    const admin = await seedAdmin(h);
    const { id } = await seedProject(admin);
    await deleteProject(h.ctx, admin.viewer, id, { confirmName: NAME, reason: REASON });

    const [row] = await h.db.select().from(deletedProject).where(eq(deletedProject.id, id));
    expect(row).toMatchObject({
      clientName: NAME,
      statusAtDeletion: "mockups",
      reason: REASON,
      filesRemoved: 14,
      deletedByUserId: admin.viewer.id,
    });
    expect(row!.deletedAt).toBeInstanceOf(Date);
  });

  it("keeps the AI spend per concept, queryable after the project is gone", async () => {
    const admin = await seedAdmin(h);
    const { id } = await seedProject(admin);
    await deleteProject(h.ctx, admin.viewer, id, { confirmName: NAME, reason: REASON });

    const rows = await listArchivedAiUsage(h.ctx, admin.viewer, id);
    expect(rows.map((r) => r.conceptLabel).sort()).toEqual(["A", "B"]);
    for (const row of rows) {
      // The newest version's running total, not the sum of both versions.
      expect(row).toMatchObject({
        clientName: NAME,
        model: "claude-opus-5-5",
        versions: 2,
        inputTokens: 20_000,
        outputTokens: 60_000,
        cacheWriteTokens: 9_000,
      });
    }

    const all = await h.db.select().from(aiUsageArchive);
    expect(all).toHaveLength(2);
  });
});
