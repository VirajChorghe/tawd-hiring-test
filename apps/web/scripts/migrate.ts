import path from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/*
  Runs on container start, before the web server accepts anything.

  If a migration fails the process exits non-zero, the container never starts
  serving, and Coolify marks the deploy failed with the previous version still
  running. That is the behaviour we want: a half-migrated database serving
  traffic is worse than a failed deploy.

  Migrations must stay backward-compatible. Coolify keeps the old container
  running while the new one starts, so for a moment the old code is talking to
  the new schema. Never rename or drop a column in the same deploy that stops
  using it: add the new one, deploy, move the code over, then remove the old
  one in a later deploy.
*/

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(here, "drizzle");

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Coolify provides it for tawd-db.");
    process.exit(1);
  }

  // A single connection, and no pooling: this runs once and exits.
  const client = postgres(url, { max: 1, onnotice: () => {} });

  try {
    console.log("Applying database migrations...");
    await migrate(drizzle(client), { migrationsFolder });
    console.log("Migrations are up to date.");
  } catch (error) {
    console.error("Migration failed. The container will not start.");
    console.error(error);
    process.exitCode = 1;
  } finally {
    await client.end({ timeout: 5 });
  }
}

await main();
