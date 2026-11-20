import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { latestAppliedMigration } from "@tawd/core/schema-version";
import { createTestDatabase, type TestHarness } from "./db";

/*
  The worker waits until the database has the migration it was built for
  (apps/worker/src/schema-ready.ts, 3 November 2026). This checks the reading
  half against real PostgreSQL migrated by drizzle: the newest applied
  migration is the newest entry in the journal the worker bundle reads.
*/

let h: TestHarness;
beforeEach(async () => {
  h = await createTestDatabase();
});
afterEach(async () => {
  await h.close();
});

describe("the newest migration the database has applied", () => {
  it("is the journal's newest, so a worker built from this journal starts at once", async () => {
    const journal = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "drizzle", "meta", "_journal.json"), "utf8")) as { entries: { when: number }[] };
    const newest = Math.max(...journal.entries.map((e) => e.when));
    expect(await latestAppliedMigration(h.db as never)).toBe(newest);
  });

  it("answers null, not an error, when the database has no migrations table", async () => {
    await h.client.exec("drop schema drizzle cascade");
    expect(await latestAppliedMigration(h.db as never)).toBeNull();
  });
});
