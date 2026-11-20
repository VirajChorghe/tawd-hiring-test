import { desc, eq, sql } from "drizzle-orm";

import type { Database } from "../../db";
import { clientDecision, concept, conceptVersion, project, projectIntake, sectionExample } from "../../db/schema";
import { parseIntake } from "../intake/schema";
import type { FileStorage } from "../intake/storage";
import { intakePhones } from "./facts";
import { examplesFromPage, pickExamples, type LibraryRow } from "./section-library";

/*
  The approved-section library's storage (8 October 2026). A client's pick
  adds the concept's newest version, scrubbed of the client's details; a
  build reads the examples for its direction. Never throws into the work
  that called it: a library that can't be added to just doesn't grow.
*/

type Storage = Pick<FileStorage, "get">;

/*
  Off unless TAWD_SECTION_LIBRARY is "on" (audit F-001, 12 November 2026).
  The scrub removes a client's name, phones, email and street address, but
  not licence numbers, owners' names, customer quotes, prices or ratings,
  and every concept's prompt was shown other clients' sections. While off,
  nothing is added, nothing is seeded and nothing is read; rows stored
  before stay in the table, unread. Checked on every call, so a change to
  the setting needs no restart.
*/
export function sectionLibraryOn(): boolean {
  return process.env.TAWD_SECTION_LIBRARY?.trim().toLowerCase() === "on";
}

/* The concept's newest version, copied into the library. Returns how many sections were added. */
export async function addSectionExamples(db: Database, storage: Storage, conceptId: string): Promise<number> {
  if (!sectionLibraryOn()) return 0;
  const [row] = await db
    .select({ projectId: concept.projectId, direction: concept.direction, trade: project.trade })
    .from(concept)
    .innerJoin(project, eq(project.id, concept.projectId))
    .where(eq(concept.id, conceptId))
    .limit(1);
  if (!row) return 0;

  const [latest] = await db
    .select({ version: conceptVersion.version, htmlKey: conceptVersion.htmlKey, review: conceptVersion.review })
    .from(conceptVersion)
    .where(eq(conceptVersion.conceptId, conceptId))
    .orderBy(desc(conceptVersion.version))
    .limit(1);
  if (!latest?.htmlKey) return 0;

  const body = await storage.get(latest.htmlKey);
  if (!body) return 0;
  const html = body.toString("utf8");

  const [intakeRow] = await db.select({ data: projectIntake.data }).from(projectIntake).where(eq(projectIntake.projectId, row.projectId)).limit(1);
  const intake = intakeRow ? parseIntake(intakeRow.data) : null;
  const details = {
    businessName: intake?.business.name ?? "",
    phones: intake ? intakePhones(intake) : [],
    emails: [intake?.business.email ?? ""].filter(Boolean) as string[],
    streetAddress: intake?.business.streetAddress ?? null,
  };

  const passes = (latest.review as { passes?: { average?: number | null }[] } | null)?.passes ?? [];
  const average = passes.at(-1)?.average ?? null;
  const bands = examplesFromPage(html, details);
  if (bands.length === 0) return 0;

  const inserted = await db
    .insert(sectionExample)
    .values(
      bands.map((b) => ({
        projectId: row.projectId,
        conceptId,
        version: latest.version,
        bandIndex: b.bandIndex,
        direction: row.direction,
        trade: row.trade,
        kind: b.kind,
        html: b.html,
        css: b.css,
        score: average === null ? null : Math.round(average * 10),
      })),
    )
    .onConflictDoNothing()
    .returning({ id: sectionExample.id });
  return inserted.length;
}

/*
  The library's start: when it is empty, every concept a client picked
  before (the newest decision per project), scoring 4.0 or above on its
  newest version, is added. Finley Pest Control's concept B is the first.
*/
export async function seedSectionLibrary(db: Database, storage: Storage): Promise<number> {
  if (!sectionLibraryOn()) return 0;
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(sectionExample);
  if (Number(count?.n ?? 0) > 0) return 0;

  const decisions = await db
    .select({ projectId: clientDecision.projectId, conceptId: clientDecision.conceptId, createdAt: clientDecision.createdAt })
    .from(clientDecision)
    .orderBy(desc(clientDecision.createdAt));
  const newestPerProject = new Map<string, string>();
  for (const d of decisions) if (!newestPerProject.has(d.projectId)) newestPerProject.set(d.projectId, d.conceptId);

  let added = 0;
  for (const conceptId of newestPerProject.values()) {
    const [latest] = await db
      .select({ review: conceptVersion.review })
      .from(conceptVersion)
      .where(eq(conceptVersion.conceptId, conceptId))
      .orderBy(desc(conceptVersion.version))
      .limit(1);
    const average = ((latest?.review as { passes?: { average?: number | null }[] } | null)?.passes ?? []).at(-1)?.average ?? null;
    if (average === null || average < 4) continue;
    try {
      added += await addSectionExamples(db, storage, conceptId);
    } catch (error) {
      console.warn(`[section library] could not add concept ${conceptId}:`, error instanceof Error ? error.message : error);
    }
  }
  return added;
}

/* The examples for a build in this direction (the newest 60 rows considered). */
export async function examplesFor(db: Database, direction: string, excludeProjectId?: string): Promise<LibraryRow[]> {
  if (!sectionLibraryOn()) return [];
  const rows = await db
    .select({
      kind: sectionExample.kind,
      direction: sectionExample.direction,
      html: sectionExample.html,
      css: sectionExample.css,
      score: sectionExample.score,
      projectId: sectionExample.projectId,
    })
    .from(sectionExample)
    .orderBy(desc(sectionExample.createdAt))
    .limit(60);
  return pickExamples(
    rows.filter((r) => r.projectId !== excludeProjectId).map((r) => ({ kind: r.kind, direction: r.direction, html: r.html, css: r.css, score: r.score === null ? null : r.score / 10 })),
    direction,
  );
}
