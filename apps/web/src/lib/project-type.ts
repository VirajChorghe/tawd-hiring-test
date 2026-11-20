import { eq, sql } from "drizzle-orm";

import { concept } from "@tawd/core/schema";
import { planWork } from "@tawd/core/site-read";
import type { ServiceContext } from "@/lib/users";
import type { TypeChangeWork } from "@/lib/project-type-words";

export type { TypeChangeWork } from "@/lib/project-type-words";

type Db = ServiceContext["db"];

/* What exists that a change of project type would touch: the plan's pages, how many are approved, and the concepts. */
export async function typeChangeWork(db: Db, projectId: string): Promise<TypeChangeWork> {
  const work = await planWork(db as never, projectId);
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(concept).where(eq(concept.projectId, projectId));
  return { pages: work.pages, approved: work.approved, concepts: row?.n ?? 0 };
}
