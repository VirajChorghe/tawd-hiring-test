import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import * as schema from "@tawd/core/schema";

/*
  Tests run against a real PostgreSQL compiled to WebAssembly, in process.

  This matters more than it sounds. The append-only guarantee is a PostgreSQL
  trigger, so proving it works needs PostgreSQL, not a mock. Using the real
  migration files also means the tests fail if a migration is wrong, which a
  hand-built test schema would hide.

  There is no PostgreSQL installed on the development machine and no Docker,
  so this is also the only way these tests can run locally at all.
*/

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(here, "..", "..", "drizzle");

export type TestDatabase = ReturnType<typeof drizzle<typeof schema>>;

export interface TestHarness {
  db: TestDatabase;
  client: PGlite;
  close: () => Promise<void>;
}

/*
  Since 30 September 2026 the migrations run once, in global-setup.ts, and
  each test starts from a copy of the saved, migrated database: much less
  memory and time than migrating for every test. Read once per test file.
  Without the saved copy (a test run some other way) it migrates as before.
*/
let saved: Blob | null | undefined;
function savedDatabase(): Blob | null {
  if (saved === undefined) {
    const file = process.env.TAWD_TEST_DB_SNAPSHOT;
    saved = file && fs.existsSync(file) ? new Blob([fs.readFileSync(file)]) : null;
  }
  return saved;
}

export async function createTestDatabase(): Promise<TestHarness> {
  const snapshot = savedDatabase();
  const client = snapshot ? new PGlite({ loadDataDir: snapshot }) : new PGlite();
  const db = drizzle(client, { schema });

  if (!snapshot) await migrate(db, { migrationsFolder });

  return {
    db,
    client,
    close: async () => {
      await client.close();
      // Free the closed database's memory now, not whenever the collector gets to it.
      (globalThis as { gc?: () => void }).gc?.();
    },
  };
}
