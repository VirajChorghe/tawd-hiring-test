import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
  A Date beside a hand-written sql`` left side (12 November 2026, found live).

  Drizzle encodes a value against the column on the left of a comparison. When
  the left side is sql`coalesce(...)`, nothing encodes it, and a JavaScript
  Date reaches postgres-js raw, where the query throws ("Failed query" in the
  worker log). The stuck-build sweep from batch A failed that way every five
  minutes on the server, while every test passed: the tests run on PGlite,
  which takes a Date happily. So this scans the source instead: a comparison
  whose left side is sql`` must take its right side as sql`` too (an ISO
  string cast by Postgres), never a bare variable.
*/

const ROOTS = ["apps/worker/src", "apps/web/src/lib", "apps/web/src/app", "packages/core/src"].map((r) => path.resolve(__dirname, "../../../..", r));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      if (!/node_modules|dist|test/.test(name)) out.push(...sources(full));
    } else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

describe("Dates in hand-written SQL comparisons", () => {
  it("never compare a sql`` left side with a bare value", () => {
    const offenders: string[] = [];
    for (const file of ROOTS.flatMap(sources)) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(/\b(?:lt|gt|lte|gte|eq|ne)\(\s*sql`[^`]*`\s*,\s*([^)\s][^)]*)\)/g)) {
        if (/^sql`/.test(m[1]!.trim())) continue;
        offenders.push(`${path.relative(path.resolve(__dirname, "../../../.."), file)}: ${m[0].slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
