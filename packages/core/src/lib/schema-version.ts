import { sql } from "drizzle-orm";

import type { Database } from "../db";

/*
  The newest migration the database has applied (3 November 2026): the largest
  `created_at` in drizzle.__drizzle_migrations, which drizzle's migrator sets to
  each migration's journal `when`. Null when it can't tell (no migrations table
  yet, no answer). The worker compares it with the migration it was built for
  before taking jobs (apps/worker/src/schema-ready.ts).
*/
export async function latestAppliedMigration(db: Database): Promise<number | null> {
  try {
    const result = (await db.execute(sql`select max(created_at) as latest from drizzle.__drizzle_migrations`)) as unknown;
    // postgres-js answers an array of rows; PGlite and node-postgres answer { rows }.
    const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as { latest: unknown }[];
    const latest = rows[0]?.latest;
    return latest === null || latest === undefined ? null : Number(latest);
  } catch {
    return null;
  }
}
