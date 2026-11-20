import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

/*
  Migration 0086 (one read of the current site, 0.96.0) on 0.94.0-shaped
  rows: a home page read copied onto the pages read of the same address; a
  project with only a home page read gets a 'home-only' row (a cut-off read
  becomes failed); a read waiting for the Internet Archive fails with the
  blocked site's message; retry_at and tries are gone; prefill marks are
  'design' by default.
*/

const here = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.join(here, "..", "..", "drizzle");

describe("migration 0086", () => {
  it("moves 0.94.0's two reads into one row each, and ends the archive's waiting reads", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tawd-0086-"));
    fs.mkdirSync(path.join(dir, "meta"));
    const journal = JSON.parse(fs.readFileSync(path.join(drizzleDir, "meta", "_journal.json"), "utf8"));
    const before = journal.entries.filter((e: { idx: number }) => e.idx <= 85);
    for (const e of before) fs.copyFileSync(path.join(drizzleDir, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
    fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: before }));

    const client = new PGlite();
    try {
      await migrate(drizzle(client), { migrationsFolder: dir });
      const ids = { keep: "11111111-1111-1111-1111-111111111111", home: "22222222-2222-2222-2222-222222222222", cut: "33333333-3333-3333-3333-333333333333", waiting: "44444444-4444-4444-4444-444444444444", beside: "55555555-5555-5555-5555-555555555555" };
      for (const [name, id] of Object.entries(ids)) {
        await client.query(`INSERT INTO project (id, client_name, trade, tier, lane) VALUES ($1, $2, 'pest_control', $3, 'lane_1')`, [id, name, name === "home" ? "growth" : "pro"]);
      }
      const result = JSON.stringify({ title: "Acme", menu: [], sections: [{ kind: "hero", heading: "Hi", words: "Hello" }], phones: [], testimonials: [] });
      await client.query(`INSERT INTO current_site_read (project_id, url, status, result, read_at) VALUES ($1, 'https://acme.example', 'done', $2, now())`, [ids.keep, result]);
      await client.query(`INSERT INTO site_import (project_id, url, status, page_limit) VALUES ($1, 'https://acme.example', 'done', 50)`, [ids.keep]);
      await client.query(`INSERT INTO current_site_read (project_id, url, status, result, read_at) VALUES ($1, 'https://rio.example', 'done', $2, now())`, [ids.home, result]);
      await client.query(`INSERT INTO current_site_read (project_id, url, status) VALUES ($1, 'https://cut.example', 'working')`, [ids.cut]);
      await client.query(`INSERT INTO site_import (project_id, url, status, page_limit, tries, retry_at) VALUES ($1, 'https://www.harborpest.com/', 'waiting', 50, 1, now())`, [ids.waiting]);

      // A failed home read beside a pages read of the same address (Fable's review L2): its reason is kept as home_failure.
      await client.query(`INSERT INTO current_site_read (project_id, url, status, failure_reason) VALUES ($1, 'https://beside.example', 'failed', 'The site didn''t finish loading within 30 seconds.')`, [ids.beside]);
      await client.query(`INSERT INTO site_import (project_id, url, status, page_limit) VALUES ($1, 'https://beside.example', 'done', 50)`, [ids.beside]);

      const sql = fs.readFileSync(path.join(drizzleDir, "0086_one_site_read.sql"), "utf8");
      for (const statement of sql.split("--> statement-breakpoint")) if (statement.trim()) await client.exec(statement);

      const rows = (await client.query<{ project_id: string; status: string; source: string | null; home: { title: string } | null; failure_reason: string | null; page_limit: number }>(`SELECT project_id, status, source, home, failure_reason, page_limit FROM site_import`)).rows;
      const by = (id: string) => rows.find((r) => r.project_id === id)!;
      expect(by(ids.keep)).toMatchObject({ status: "done", home: { title: "Acme" } });
      expect(by(ids.home)).toMatchObject({ status: "done", source: "home-only", home: { title: "Acme" }, page_limit: 20 });
      expect(by(ids.cut)).toMatchObject({ status: "failed", source: "home-only", home: null, failure_reason: "The read was cut off. Read again." });
      expect(by(ids.beside)).toMatchObject({ status: "done", home: null });
      expect((await client.query<{ home_failure: string }>(`SELECT home_failure FROM site_import WHERE project_id = $1`, [ids.beside])).rows[0]?.home_failure).toBe("The site didn't finish loading within 30 seconds.");
      expect(by(ids.waiting)).toMatchObject({ status: "failed", failure_reason: "harborpest.com blocks TAWD's server, so its pages can't be read from here. Reading again won't change that." });
      const columns = (await client.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'site_import'`)).rows.map((r) => r.column_name);
      expect(columns).not.toContain("retry_at");
      expect(columns).not.toContain("tries");
      expect(columns).toEqual(expect.arrayContaining(["home", "home_failure", "home_read_at", "kept_plan", "heartbeat_at"]));
      const origin = (await client.query<{ column_default: string }>(`SELECT column_default FROM information_schema.columns WHERE table_name = 'intake_prefill' AND column_name = 'origin'`)).rows[0];
      expect(origin?.column_default).toContain("design");
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
