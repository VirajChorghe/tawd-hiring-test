import { and, eq } from "drizzle-orm";

import type { Database } from "../../db";
import { intakePrefill } from "../../db/schema";
import type { Viewer } from "../permissions";
import { PREFILL_LABELS, SITE_ONLY_PREFILL_KEYS, type PrefillKey } from "./prefill-fields";
import type { IntakeData } from "./schema";
import { loadIntake, type LoadedIntake } from "./service";

/*
  B3 (audit F-016, 12 November 2026): a claim lifted from the client's old
  website is not a fact until someone confirms it.

  After a site read, the first warranty phrase, offer phrase and mention of
  financing on the old home page are written into the intake, marked
  "From the current site" (status pending). Nothing that builds a page read
  that mark: the model was told to use the intake's facts exactly as
  written, and the claims guard treated the groups as backed. So an
  out-of-date "lifetime warranty" or "$500 off" went straight onto the new
  site.

  Now everything that writes a page, or checks one, loads the intake
  through loadIntakeForBuilding: a pending site claim is taken out of the
  data (so it is neither stated nor counted as backing a claim) and handed
  back separately as unconfirmed, so a prompt can say what the old site
  says and that it is not to be stated yet. The intake screen still shows
  it, with its mark, for the team to confirm or correct; the go-live
  checklist lists any still pending.

  Only the three claim fields: the other pre-filled answers (the phone, the
  address, the services) are read from the client's own site as facts, and
  a person corrects them on the intake screen.
*/

export interface UnconfirmedClaim {
  key: PrefillKey;
  label: string;
  /** What the old site says, as it was filled. */
  value: string;
}

export interface PrefillMark {
  fieldKey: string;
  status: string;
  origin: string;
  value: unknown;
}

const CLAIM_KEYS = new Set<string>(SITE_ONLY_PREFILL_KEYS);

/* The pending site claims of a set of marks. */
export function pendingSiteClaims(marks: PrefillMark[]): PrefillMark[] {
  return marks.filter((m) => m.status === "pending" && m.origin === "site" && CLAIM_KEYS.has(m.fieldKey));
}

/* The intake with each pending site claim taken out, and the claims on their own. */
export function withoutUnconfirmedClaims(data: IntakeData, marks: PrefillMark[]): { data: IntakeData; unconfirmed: UnconfirmedClaim[] } {
  const pending = pendingSiteClaims(marks);
  if (pending.length === 0) return { data, unconfirmed: [] };
  const out: IntakeData = { ...data, process: { ...data.process }, extras: { ...data.extras } };
  const unconfirmed: UnconfirmedClaim[] = [];
  for (const mark of pending) {
    const key = mark.fieldKey as (typeof SITE_ONLY_PREFILL_KEYS)[number];
    // Only while the field still holds what was filled: a person who typed over it corrected it (and the mark then says so).
    if (key === "process.guarantees" && out.process.guarantees === mark.value) {
      out.process.guarantees = "";
    } else if (key === "extras.currentOffers" && out.extras.currentOffers === mark.value) {
      out.extras.currentOffers = "";
    } else if (key === "extras.financingAvailable" && out.extras.financingAvailable === mark.value) {
      out.extras.financingAvailable = null;
    } else {
      continue;
    }
    unconfirmed.push({ key, label: PREFILL_LABELS[key], value: key === "extras.financingAvailable" ? "financing is offered" : String(mark.value) });
  }
  return { data: out, unconfirmed };
}

export type IntakeForBuilding = LoadedIntake & { unconfirmed: UnconfirmedClaim[] };

/* The intake as anything that writes or checks a page must read it. */
export async function loadIntakeForBuilding(db: Database, viewer: Viewer, projectId: string): Promise<IntakeForBuilding | null> {
  const intake = await loadIntake(db, viewer, projectId);
  if (!intake) return null;
  const marks = await db
    .select({ fieldKey: intakePrefill.fieldKey, status: intakePrefill.status, origin: intakePrefill.origin, value: intakePrefill.value })
    .from(intakePrefill)
    .where(and(eq(intakePrefill.projectId, projectId), eq(intakePrefill.status, "pending")));
  const { data, unconfirmed } = withoutUnconfirmedClaims(intake.data, marks);
  return { ...intake, data, unconfirmed };
}
