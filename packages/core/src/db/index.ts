import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

/*
  Typed against Drizzle's shared PostgreSQL base class rather than the
  postgres-js driver specifically.

  Production connects over postgres-js; tests run the same code against
  PGlite, a real PostgreSQL in the test process. Both are genuine PostgreSQL
  and differ only in how the driver reports results, so the service layer is
  written once against what they have in common.
*/
export type Database = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

let client: ReturnType<typeof postgres> | null = null;
let database: Database | null = null;

/*
  Created on first use, not at import time, so `next build` can import route
  modules in a container that has no DATABASE_URL.

  The pool is small on purpose: TAWD shares its droplet with Velocity Reports,
  and a handful of team members needs nothing more.
*/
export function getDb(): Database {
  if (database) return database;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Coolify provides it for tawd-db.",
    );
  }

  client = postgres(url, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  database = drizzle(client, { schema });
  return database;
}

/** Only for tests, which supply their own in-process database. */
export function setDbForTesting(testDatabase: Database | null): void {
  database = testDatabase;
}
