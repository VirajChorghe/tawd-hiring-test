import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { mockupRun, polishPass, seoGoLiveCheck, siteBuild } from "@tawd/core/schema";

/*
  One start at a time (13 October 2026, the whole-code review): two clicks
  arriving together could both pass "nothing is running" and start two paid
  runs, and two site builds could get the same version number. The check and
  the new row now happen in one transaction holding a lock for that project
  and that kind of work, so the second click waits, then sees the first.
*/
async function withProjectLock<T>(db: Database, scope: string, projectId: string, run: (tx: Database) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${scope}:${projectId}`}))`);
    return run(tx as unknown as Database);
  });
}

type SiteBuildValues = Omit<typeof siteBuild.$inferInsert, "projectId" | "version" | "status">;

/*
  A new site build, queued with the next version number. Null when one is
  already queued or working, unless the caller builds on its own (a page
  fix, which runs its build itself): then only the version is claimed.
*/
export async function claimSiteBuild(
  db: Database,
  projectId: string,
  values: SiteBuildValues,
  options: { whileBusy?: boolean; firstVersion?: number } = {},
): Promise<{ id: string; version: number } | null> {
  return withProjectLock(db, "site_build", projectId, async (tx) => {
    if (!options.whileBusy) {
      const [busy] = await tx
        .select({ id: siteBuild.id })
        .from(siteBuild)
        .where(and(eq(siteBuild.projectId, projectId), inArray(siteBuild.status, ["queued", "working"])))
        .limit(1);
      if (busy) return null;
    }
    const [last] = await tx.select({ version: siteBuild.version }).from(siteBuild).where(eq(siteBuild.projectId, projectId)).orderBy(desc(siteBuild.version)).limit(1);
    const version = (last?.version ?? options.firstVersion ?? 0) + 1;
    const [row] = await tx
      .insert(siteBuild)
      .values({ ...values, projectId, version, status: "queued" })
      .returning({ id: siteBuild.id });
    return { id: row!.id, version };
  });
}

type PolishValues = Omit<typeof polishPass.$inferInsert, "projectId" | "conceptId" | "status">;

/* A polish of one concept, queued. Null when that concept is already queued or being polished. */
export async function claimPolishPass(db: Database, projectId: string, conceptId: string, values: PolishValues): Promise<{ id: string } | null> {
  return withProjectLock(db, "polish", conceptId, async (tx) => {
    const [busy] = await tx
      .select({ id: polishPass.id })
      .from(polishPass)
      .where(and(eq(polishPass.conceptId, conceptId), inArray(polishPass.status, ["queued", "working"])))
      .limit(1);
    if (busy) return null;
    const [row] = await tx
      .insert(polishPass)
      .values({ ...values, projectId, conceptId })
      .returning({ id: polishPass.id });
    return { id: row!.id };
  });
}

type SeoCheckValues = Omit<typeof seoGoLiveCheck.$inferInsert, "projectId" | "status">;

/* The SEO go-live check, queued. Null when one is already queued or working. */
export async function claimSeoGoLiveCheck(db: Database, projectId: string, values: SeoCheckValues): Promise<{ id: string } | null> {
  return withProjectLock(db, "seo_golive", projectId, async (tx) => {
    const [busy] = await tx
      .select({ id: seoGoLiveCheck.id })
      .from(seoGoLiveCheck)
      .where(and(eq(seoGoLiveCheck.projectId, projectId), inArray(seoGoLiveCheck.status, ["queued", "working"])))
      .limit(1);
    if (busy) return null;
    const [row] = await tx
      .insert(seoGoLiveCheck)
      .values({ ...values, projectId, status: "queued" })
      .returning({ id: seoGoLiveCheck.id });
    return { id: row!.id };
  });
}

type MockupRunValues =Omit<typeof mockupRun.$inferInsert, "projectId" | "status">;

/* A new concept run, queued. Null when one is already queued or running. */
export async function claimMockupRun(db: Database, projectId: string, values: MockupRunValues): Promise<{ id: string } | null> {
  return withProjectLock(db, "mockup_run", projectId, async (tx) => {
    const [busy] = await tx
      .select({ id: mockupRun.id })
      .from(mockupRun)
      .where(and(eq(mockupRun.projectId, projectId), inArray(mockupRun.status, ["queued", "running"])))
      .limit(1);
    if (busy) return null;
    const [row] = await tx
      .insert(mockupRun)
      .values({ ...values, projectId, status: "queued" })
      .returning({ id: mockupRun.id });
    return { id: row!.id };
  });
}
