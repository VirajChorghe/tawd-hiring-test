import { and, eq, inArray, like } from "drizzle-orm";

import type { Database } from "../../db";
import { intakePrefill } from "../../db/schema";
import { SYSTEM_ACTOR_ID, actorFields, recordActivity } from "../activity";
import type { Viewer } from "../permissions";
import type { IntakeData, IntakeSectionKey } from "./schema";
import type { PrefillKey } from "./prefill-fields";

/*
  Intake fields filled from the designer's Figma design stay marked "from
  the design" until the PM confirms them or saves something different.
  These helpers say which fields are empty (the only ones ever filled),
  read and write a field by its key, and settle the markers when a section
  is saved.
*/

export type PrefillFieldKey = PrefillKey;

type Service = { name: string; description: string };

/* The field's value, in the form it is compared in (services without their ids). */
export function prefillValueAt(data: IntakeData, key: PrefillFieldKey): unknown {
  switch (key) {
    case "services.items":
      return data.services.items.map((s) => ({ name: s.name, description: s.description }));
    case "serviceAreas.cities":
      return data.serviceAreas.cities;
    case "process.guarantees":
      return data.process.guarantees;
    case "extras.currentOffers":
      return data.extras.currentOffers;
    case "extras.financingAvailable":
      return data.extras.financingAvailable;
    default: {
      const field = key.split(".")[1] as keyof IntakeData["business"];
      return data.business[field];
    }
  }
}

/* Empty: nothing typed, no year, an empty list. Only these are ever filled. */
export function isPrefillFieldEmpty(data: IntakeData, key: PrefillFieldKey): boolean {
  const value = prefillValueAt(data, key);
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/* The section's data with the field set. Services get fresh ids; the first becomes the main one. */
export function withPrefill(data: IntakeData, key: PrefillFieldKey, value: unknown, newId: () => string, options: { setMainService?: boolean } = {}): IntakeData {
  switch (key) {
    case "services.items": {
      const items = (value as Service[]).map((s) => ({ id: newId(), name: s.name, description: s.description }));
      // The main service is a choice a site doesn't prove (Fable's review L9): left to the team for the site's services.
      const main = options.setMainService === false ? data.services.mainServiceId : (data.services.mainServiceId ?? items[0]?.id ?? null);
      return { ...data, services: { ...data.services, items, mainServiceId: main } };
    }
    case "serviceAreas.cities":
      return { ...data, serviceAreas: { ...data.serviceAreas, cities: value as string[] } };
    case "process.guarantees":
      return { ...data, process: { ...data.process, guarantees: value as string } };
    case "extras.currentOffers":
      return { ...data, extras: { ...data.extras, currentOffers: value as string } };
    case "extras.financingAvailable":
      return { ...data, extras: { ...data.extras, financingAvailable: value as boolean | null } };
    default: {
      const field = key.split(".")[1]!;
      return { ...data, business: { ...data.business, [field]: value } };
    }
  }
}

export function sectionOfPrefill(key: PrefillFieldKey): IntakeSectionKey {
  return key.split(".")[0] as IntakeSectionKey;
}

/*
  After a section is saved: any field still marked "from the design" whose
  value is now different was corrected by the PM, so its mark comes off
  and the correction is logged. An unchanged field keeps its mark until
  someone confirms it.
*/
export async function settlePrefillsAfterSave(
  db: Database,
  actor: Viewer,
  projectId: string,
  section: IntakeSectionKey,
  data: IntakeData,
  context: { ipAddress: string | null; userAgent: string | null },
): Promise<void> {
  const pending = await db
    .select()
    .from(intakePrefill)
    .where(
      and(
        eq(intakePrefill.projectId, projectId),
        // A confirmed answer the team later changes is corrected too, so a re-read never fills it again (Fable's review L7).
        inArray(intakePrefill.status, ["pending", "confirmed"]),
        like(intakePrefill.fieldKey, `${section}.%`),
      ),
    );
  const corrected = pending.filter(
    (row) => JSON.stringify(prefillValueAt(data, row.fieldKey as PrefillFieldKey)) !== JSON.stringify(row.value),
  );
  if (corrected.length === 0) return;

  for (const row of corrected) {
    await db
      .update(intakePrefill)
      .set({ status: "corrected", resolvedByUserId: actor.id === SYSTEM_ACTOR_ID ? null : actor.id, resolvedAt: new Date() })
      .where(and(eq(intakePrefill.projectId, projectId), eq(intakePrefill.fieldKey, row.fieldKey)));
  }
  await recordActivity(db, {
    action: "intake.prefill_corrected",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { fields: corrected.map((row) => row.fieldKey) },
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });
}

/* ---------- a form opened before TAWD filled answers ---------- */

/*
  A person opens the intake form and TAWD fills answers while it is open
  (a design read, or the current site's read, finishing). Their form still
  shows those answers empty, and a Save would write the empty copy over
  what TAWD filled, and then count the answers as "corrected" by a person,
  so TAWD would never fill them again.

  The page records the newest fill time for the project when it loads (the
  stamp). Every save sends it back. Every fill time is written by the
  database's clock_timestamp() while the fill holds lockIntakeForFills, so
  the times follow the order the fills really ran in: one clock only, and
  never now(), which is when the transaction began, before it waited for
  the lock. Times are compared to the millisecond (the stamp travels as an
  ISO string); a fill landing in the same millisecond as the one before it
  would not count as newer. That is not ruled out, only unlikely: a fill
  makes several writes after it gets the lock, before its own times.
*/
export async function latestPrefillStamp(db: Database, projectId: string): Promise<string | null> {
  const rows = await db.select({ at: intakePrefill.filledAt }).from(intakePrefill).where(eq(intakePrefill.projectId, projectId));
  if (rows.length === 0) return null;
  return new Date(Math.max(...rows.map((r) => r.at.getTime()))).toISOString();
}

export class StaleIntakeError extends Error {
  readonly count: number;
  constructor(count: number) {
    super(`TAWD filled in ${count} ${count === 1 ? "answer" : "answers"} while you were editing — reload to see them`);
    this.name = "StaleIntakeError";
    this.count = count;
  }
}

/*
  Answers in this section that TAWD filled after the form was loaded and
  that the save would change from TAWD's value. Answers a person already
  corrected are theirs and are not counted. `data` is the whole intake as
  it would be after the save. Run inside the transaction that holds the
  lockIntakeForFills, so no fill lands between this check and the write.
*/
export async function answersFilledSince(
  db: Database,
  projectId: string,
  section: IntakeSectionKey,
  data: IntakeData,
  stamp: string | null,
): Promise<number> {
  const since = stamp === null ? null : Date.parse(stamp);
  const rows = await db
    .select()
    .from(intakePrefill)
    .where(
      and(
        eq(intakePrefill.projectId, projectId),
        inArray(intakePrefill.status, ["pending", "confirmed"]),
        like(intakePrefill.fieldKey, `${section}.%`),
      ),
    );
  return rows.filter(
    (row) =>
      (since === null || row.filledAt.getTime() > since) &&
      JSON.stringify(prefillValueAt(data, row.fieldKey as PrefillFieldKey)) !== JSON.stringify(row.value),
  ).length;
}
