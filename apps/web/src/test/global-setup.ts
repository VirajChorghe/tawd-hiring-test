import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

/*
  The saved test database (Jason, 30 September 2026: the laptop kept
  running out of memory). Every migration is run once, here, before any
  test file; the migrated database is saved as a file, and each test gets
  a fresh copy of it (src/test/db.ts) instead of replaying all the
  migrations itself. Tests still run on a real PostgreSQL each, so the
  activity log's triggers are still proven.

  The file is named after a hash of the migrations, so a new or changed
  migration makes a new one; old ones are removed.
*/

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(here, "..", "..", "drizzle");
const cacheFolder = path.join(here, "..", "..", "node_modules", ".cache", "tawd-test-db");

function migrationsHash(): string {
  const hash = createHash("sha256");
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else hash.update(name).update(fs.readFileSync(full));
    }
  };
  walk(migrationsFolder);
  return hash.digest("hex").slice(0, 16);
}

export default async function setup(): Promise<void> {
  const file = path.join(cacheFolder, `migrated-${migrationsHash()}.tar.gz`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(cacheFolder, { recursive: true });
    for (const old of fs.readdirSync(cacheFolder)) fs.rmSync(path.join(cacheFolder, old), { force: true });
    const client = new PGlite();
    await migrate(drizzle(client), { migrationsFolder });
    const dump = await client.dumpDataDir("gzip");
    fs.writeFileSync(file, Buffer.from(await dump.arrayBuffer()));
    await client.close();
  }
  process.env.TAWD_TEST_DB_SNAPSHOT = file;
}
