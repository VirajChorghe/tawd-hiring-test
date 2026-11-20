import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  14 November 2026: someone opens the intake form, TAWD fills answers while
  it is open (a design read, or the current site's read), and Save used to
  write the form's out-of-date copy over them, counting them as corrected
  by a person so TAWD never filled them again. A save from such a form is
  now refused, nothing written, naming how many answers TAWD filled.
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
vi.mock("@/lib/session", () => ({ requireUser: async () => null }));
vi.mock("@/app/actions", () => {
  const f = async () => ({ ok: true });
  return new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : f), has: () => true });
});

import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, intakePrefill, project, projectIntake } from "@tawd/core/schema";
import { setFigmaForTesting, type FigmaFile, type FigmaNode } from "@tawd/core/figma";
import { importFigmaDesign } from "@tawd/core/figma/service";
import { runDesignPrefill, setAutomaticDesignPrefillForTesting } from "@tawd/core/figma/design-prefill";
import { StaleIntakeError, loadIntake, lockIntakeForFills, saveIntakeSection } from "@tawd/core/intake/service";
import { latestPrefillStamp } from "@tawd/core/intake/prefill";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { applySitePrefill } from "@tawd/core/site-read";
import type { ImportedPageSummary } from "@tawd/core/site";
import { queueFigmaImport, saveFigmaLink } from "@/lib/figma";
import { setQueueForTesting } from "@/lib/mockups";
import { createProject } from "@/lib/projects";

import { FILE_LINK, daleRowanFile, fakeFigma } from "./figma-fakes";
import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

let h: Harness;

beforeEach(async () => {
  setAutomaticDesignPrefillForTesting(false);
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setStorageForTesting(new FakeR2());
  setQueueForTesting({ add: async () => undefined, getJob: async () => null });
});

afterEach(async () => {
  setAutomaticDesignPrefillForTesting(true);
  setFigmaForTesting(null);
  setQueueForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

let n = 0;
const text = (characters: string, x: number, y: number, size = 16, weight = 400, width = 400): FigmaNode => ({
  id: `6:${++n}`,
  name: characters.slice(0, 20),
  type: "TEXT",
  characters,
  style: { fontFamily: "Inter", fontSize: size, fontWeight: weight },
  absoluteBoundingBox: { x, y, width, height: size * 1.4 },
});
const frame = (name: string, y: number, children: FigmaNode[], height = 400): FigmaNode => ({
  id: `6:${++n}`,
  name,
  type: "FRAME",
  absoluteBoundingBox: { x: 0, y, width: 1440, height },
  children,
});

function design(): FigmaFile {
  const file = daleRowanFile();
  file.document.children![2]!.children![0] = {
    id: "2:10",
    name: "Home",
    type: "FRAME",
    absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 4000 },
    children: [
      frame("Header", 0, [text("Example Well & Pump", 80, 30, 26, 700), text("Call (530) 555-0199", 1200, 36, 17, 700)], 100),
      frame("Footer", 3600, [text("info@examplewell.com", 80, 3650), text("© 2026 Example Well & Pump. All rights reserved.", 80, 3710, 13)], 400),
    ],
  };
  return file;
}

const sitePage = (tel: string, email: string) =>
  ({ path: "/", url: "https://acme.example/", kind: "home", name: "Home", title: "Acme", phones: [], contact: { tels: [tel], emails: [email], addresses: [] } }) as unknown as ImportedPageSummary;

/* The two ways TAWD fills answers by itself, split in two: what has to happen first (the design imported), and the fill itself on a given database or transaction. */
const fillsOn = {
  design: {
    prepare: async (projectId: string, admin: Awaited<ReturnType<typeof seedAdmin>>) => {
      setFigmaForTesting(fakeFigma({ file: design }).api);
      await saveFigmaLink(h.ctx, admin.viewer, projectId, FILE_LINK);
      await queueFigmaImport(h.ctx, admin.viewer, projectId);
      await importFigmaDesign(h.db, projectId);
    },
    run: (db: Database, projectId: string, admin: Awaited<ReturnType<typeof seedAdmin>>) => runDesignPrefill(db, projectId, { actor: admin.viewer, by: "Test", automatic: false }),
  },
  site: {
    prepare: async () => undefined,
    run: (db: Database, projectId: string) => applySitePrefill(db, projectId, [sitePage("9165550142", "office@acme.example")], "https://acme.example/"),
  },
};

/* Each fills Business answers after the form was opened. */
const sources = {
  design: async (projectId: string, admin: Awaited<ReturnType<typeof seedAdmin>>) => {
    await fillsOn.design.prepare(projectId, admin);
    await fillsOn.design.run(h.db as Database, projectId, admin);
  },
  site: async (projectId: string) => {
    await fillsOn.site.run(h.db as Database, projectId);
  },
};

async function newProject({ saveFirst = true }: { saveFirst?: boolean } = {}) {
  const admin = await seedAdmin(h);
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
  // The person already typed a city, so the fills leave it alone.
  if (saveFirst) await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", { city: "Reno" });
  return { admin, projectId };
}

const businessNow = async (projectId: string, admin: Awaited<ReturnType<typeof seedAdmin>>) => (await loadIntake(h.db, admin.viewer, projectId))!.data.business;
const marks = (projectId: string) => h.db.select().from(intakePrefill).where(eq(intakePrefill.projectId, projectId));
const updatedLogs = async () => (await h.db.select().from(activityLog).where(eq(activityLog.action, "intake.updated"))).length;

for (const [name, fill] of Object.entries(sources) as [keyof typeof sources, (p: string, a: Awaited<ReturnType<typeof seedAdmin>>) => Promise<void>][]) {
  describe(`a form opened before TAWD filled answers (${name} fill)`, () => {
    /* The form as it was opened: Business with the empty answers, and the stamp the page gave it. */
    async function openForm() {
      const { admin, projectId } = await newProject();
      const stamp = await latestPrefillStamp(h.db, projectId);
      const form = await businessNow(projectId, admin);
      await fill(projectId, admin);
      const filled = (await marks(projectId)).filter((m) => m.fieldKey.startsWith("business."));
      expect(filled.length).toBeGreaterThan(0);
      return { admin, projectId, stamp, form, filled };
    }

    it("refuses a save that would write the form's old copy over them, names how many, and writes nothing", async () => {
      const { admin, projectId, stamp, form, filled } = await openForm();
      expect(stamp).toBeNull();
      const logsBefore = await updatedLogs();
      const before = await businessNow(projectId, admin);

      const error = await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", { ...form, city: "Sparks" }, { prefillStamp: stamp }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(StaleIntakeError);
      expect((error as StaleIntakeError).count).toBe(filled.length);
      expect((error as StaleIntakeError).message).toBe(`TAWD filled in ${filled.length} ${filled.length === 1 ? "answer" : "answers"} while you were editing — reload to see them`);
      expect(await businessNow(projectId, admin)).toEqual(before);
      expect(before.city).toBe("Reno");
      expect(await updatedLogs()).toBe(logsBefore);
    });

    it("does not count a refused save as a person correcting the answers", async () => {
      const { admin, projectId, stamp, form } = await openForm();
      await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", { ...form, city: "Sparks" }, { prefillStamp: stamp }).catch(() => undefined);

      expect((await marks(projectId)).filter((m) => m.status === "corrected")).toEqual([]);
      expect((await h.db.select().from(activityLog).where(eq(activityLog.action, "intake.prefill_corrected"))).length).toBe(0);
    });

    it("saves the same edit after a reload", async () => {
      const { admin, projectId, form } = await openForm();
      // Reload: the page reads the stamp and the answers again.
      const stamp = await latestPrefillStamp(h.db, projectId);
      const reloaded = await businessNow(projectId, admin);
      expect(reloaded).not.toEqual(form);

      const result = await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", { ...reloaded, city: "Sparks" }, { prefillStamp: stamp });

      expect(result.changedPaths).toEqual(["city"]);
      expect(result.prefillStamp).toBe(stamp);
      expect((await businessNow(projectId, admin)).city).toBe("Sparks");
      expect((await marks(projectId)).filter((m) => m.status === "corrected")).toEqual([]);
    });

    it("saves a stale form's edit to another section", async () => {
      const { admin, projectId, stamp } = await openForm();
      const result = await saveIntakeSection(h.ctx, admin.viewer, projectId, "process", { guarantees: "1-year labour warranty" }, { prefillStamp: stamp });
      expect(result.changedPaths).toEqual(["guarantees"]);
      expect((await loadIntake(h.db, admin.viewer, projectId))!.data.process.guarantees).toBe("1-year labour warranty");
    });

    it("saves a stale form's edit that keeps TAWD's value for every answer it filled", async () => {
      const { admin, projectId, stamp } = await openForm();
      const now = await businessNow(projectId, admin);

      const result = await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", { ...now, city: "Sparks" }, { prefillStamp: stamp });

      expect(result.changedPaths).toEqual(["city"]);
      expect((await marks(projectId)).filter((m) => m.status === "corrected")).toEqual([]);
    });

    // Fable's review of #93: the lock used to be the intake row, which a never-saved intake doesn't have yet. This covers the whole path on such a project; the lock itself is proved in "the lock a checked save and both fills take".
    it("refuses the same way on a project whose intake was never saved", async () => {
      const { admin, projectId } = await newProject({ saveFirst: false });
      expect(await h.db.select().from(projectIntake).where(eq(projectIntake.projectId, projectId))).toEqual([]);
      const stamp = await latestPrefillStamp(h.db, projectId);
      const form = await businessNow(projectId, admin);
      await fill(projectId, admin);

      const error = await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", { ...form, city: "Sparks" }, { prefillStamp: stamp }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(StaleIntakeError);
      expect((await businessNow(projectId, admin)).city).not.toBe("Sparks");
    });

    it("does not count an answer a person had already corrected", async () => {
      const { admin, projectId, stamp, form } = await openForm();
      await h.db.update(intakePrefill).set({ status: "corrected" }).where(and(eq(intakePrefill.projectId, projectId), eq(intakePrefill.status, "pending")));

      const result = await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", { ...form, city: "Sparks" }, { prefillStamp: stamp });

      expect(result.changedPaths.includes("city")).toBe(true);
    });
  });
}

describe("the stamp compares fill times, not clocks", () => {
  it("refuses only an answer filled after the stamp, and not one filled at the stamp", async () => {
    const { admin, projectId } = await newProject();
    await sources.site(projectId);
    const stamp = (await latestPrefillStamp(h.db, projectId))!;
    const form = await businessNow(projectId, admin);
    // The form here shows the phone a person typed over TAWD's; TAWD's own record still says the filled one.
    await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", { ...form, phone: "(916) 555-0100" });
    await h.db.update(intakePrefill).set({ status: "pending", value: "(916) 555-0142" }).where(and(eq(intakePrefill.projectId, projectId), eq(intakePrefill.fieldKey, "business.phone")));
    const edit = { ...(await businessNow(projectId, admin)), city: "Sparks" };

    // Filled at the stamp: not after it, so the save goes through.
    await expect(saveIntakeSection(h.ctx, admin.viewer, projectId, "business", edit, { prefillStamp: stamp })).resolves.toBeTruthy();

    await h.db.update(intakePrefill).set({ status: "pending", value: "(916) 555-0142", filledAt: new Date(Date.parse(stamp) + 1000) }).where(and(eq(intakePrefill.projectId, projectId), eq(intakePrefill.fieldKey, "business.phone")));
    const error = await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", { ...edit, city: "Elko" }, { prefillStamp: stamp }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StaleIntakeError);
    expect((error as StaleIntakeError).count).toBe(1);
  });

  it("does not check a save sent without a stamp (TAWD's own saves)", async () => {
    const { admin, projectId } = await newProject();
    await sources.site(projectId);
    await expect(saveIntakeSection(h.ctx, admin.viewer, projectId, "business", { city: "Sparks" })).resolves.toBeTruthy();
  });

});

/*
  A fill that waited for the lock must not be dated from when its transaction began (now(), the column's default), or it
  could sort before a fill that ran first. Each fill runs inside a transaction that began 200 ms earlier: a time taken
  from now() would be that start. (Going back to the app's own new Date() can't be caught on one machine, where both
  clocks are the same one; the comment on latestPrefillStamp says why it matters across containers.)
*/
describe("a fill is dated when it is written, not when its transaction began", () => {
  for (const [name, filler] of Object.entries(fillsOn) as [keyof typeof fillsOn, (typeof fillsOn)[keyof typeof fillsOn]][]) {
    for (const path of ["first fill", "refill"] as const) {
      it(`${name} fill, ${path}`, async () => {
        const { admin, projectId } = await newProject();
        await filler.prepare(projectId, admin);
        if (path === "refill") {
          // Filled once, then the answers emptied again with their marks still pending: the next fill writes over the same marks.
          await filler.run(h.db, projectId, admin);
          await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", { city: "Reno" });
          await h.db.update(intakePrefill).set({ status: "pending", filledAt: new Date("2000-01-01T00:00:00Z") }).where(eq(intakePrefill.projectId, projectId));
        }
        const before = (await marks(projectId)).length;
        await h.db.transaction(async (txn) => {
          const tx = txn as unknown as Database;
          const [began] = await tx.select({ ms: sql<string>`extract(epoch from now()) * 1000` }).from(project).where(eq(project.id, projectId));
          await new Promise((resolve) => setTimeout(resolve, 200));
          await filler.run(tx, projectId, admin);
          const rows = (await tx.select().from(intakePrefill).where(eq(intakePrefill.projectId, projectId))).filter((r) => r.fieldKey.startsWith("business."));
          expect(rows.length).toBeGreaterThan(0);
          if (path === "refill") expect(rows.length).toBeLessThanOrEqual(before);
          for (const row of rows) expect(row.filledAt.getTime()).toBeGreaterThanOrEqual(Number(began!.ms) + 150);
        });
      });
    }
  }
});

describe("the lock a checked save and both fills take", () => {
  // A locked row carries the locking transaction's id in xmax; a plain read, or a lock on another table, leaves it alone.
  it("locks the project's row, also before the intake was ever saved", async () => {
    const { projectId } = await newProject({ saveFirst: false });
    await h.db.transaction(async (txn) => {
      const tx = txn as unknown as Database;
      const xmax = async () => (await tx.select({ x: sql<string>`xmax::text` }).from(project).where(eq(project.id, projectId)))[0]!.x;
      await lockIntakeForFills(tx, projectId);
      const [me] = await tx.select({ id: sql<string>`pg_current_xact_id()::text` }).from(project).where(eq(project.id, projectId));
      expect(await xmax()).toBe(me!.id);
    });
  });

  it("refuses a project that no longer exists", async () => {
    await h.db.transaction(async (txn) => {
      await expect(lockIntakeForFills(txn as unknown as Database, "00000000-0000-0000-0000-000000000000")).rejects.toThrow("This project no longer exists.");
    });
  });
});
