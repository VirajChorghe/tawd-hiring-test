import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
  Checks the Drizzle migration chain before a merge (Fable's code review of
  the 20i branch, finding 4): every journal entry in order with no gap, its
  SQL file and snapshot present, and each snapshot's prevId pointing at the
  snapshot before it. A snapshot made on an older base (a branch that
  predates a migration on main) fails here, and the next `drizzle-kit
  generate` would otherwise repeat the missing migration's changes.

  Run from apps/web:  node scripts/check-migrations.mjs
  Exit code 0 when the chain is whole, 1 with the problems listed.
*/
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "..", "drizzle");
const journal = JSON.parse(readFileSync(path.join(dir, "meta", "_journal.json"), "utf8"));
const problems = [];
let previous = null;
let lastWhen = 0;

journal.entries.forEach((entry, i) => {
  if (entry.idx !== i) problems.push(`Journal entry ${i} has idx ${entry.idx} (a gap or a duplicate).`);
  if (entry.when <= lastWhen) problems.push(`${entry.tag}: its "when" (${entry.when}) isn't later than the entry before (${lastWhen}).`);
  lastWhen = entry.when;
  if (!existsSync(path.join(dir, `${entry.tag}.sql`))) problems.push(`${entry.tag}.sql is missing.`);
  const number = entry.tag.split("_")[0];
  const snapshotPath = path.join(dir, "meta", `${number}_snapshot.json`);
  if (!existsSync(snapshotPath)) {
    problems.push(`${number}_snapshot.json is missing.`);
    previous = null;
    return;
  }
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  if (previous && snapshot.prevId !== previous.id) problems.push(`${number}_snapshot.json: prevId ${snapshot.prevId} is not the id of ${previous.number}_snapshot.json (${previous.id}).`);
  previous = { number, id: snapshot.id };
});

if (problems.length) {
  console.error(`The migration chain has ${problems.length} problem(s):\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`The migration chain is whole: ${journal.entries.length} migrations, latest ${journal.entries.at(-1)?.tag}.`);
