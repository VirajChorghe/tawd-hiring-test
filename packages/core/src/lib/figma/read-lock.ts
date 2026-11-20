import { sql } from "drizzle-orm";

import type { Database } from "../../db";

/*
  One lock per project for the new design read (E4b-2a, CodeRabbit's review
  of #97). Taken, inside a transaction, by a correction save for its whole
  check, insert and activity entry, and by the worker while it saves a new
  read. So two saves never both pass on the same band list, and a save can
  never check against one read while another is published under it.

  A transaction-scoped advisory lock: released when the transaction ends,
  and separate from every row lock (the intake's own lock is the project
  row, lockIntakeForFills), so it holds nothing else up.
*/
export async function lockDesignRead(tx: Database, projectId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`design-read:${projectId}`}))`);
}
