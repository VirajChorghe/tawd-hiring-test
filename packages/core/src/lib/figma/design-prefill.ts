import { eq, sql } from "drizzle-orm";

import type { Database } from "../../db";
import { figmaDesign, intakePrefill, project } from "../../db/schema";
import { actorFields, recordActivity } from "../activity";
import { SYSTEM_ACTOR, type Viewer } from "../permissions";
import { phoneProblem } from "../phone";
import { isPrefillFieldEmpty, prefillValueAt, sectionOfPrefill, withPrefill, type PrefillFieldKey } from "../intake/prefill";
import { PREFILL_KEYS, PREFILL_LABELS, SITE_ONLY_PREFILL_KEYS, type PrefillKey } from "../intake/prefill-fields";
import { loadIntake, lockIntakeForFills, saveIntakeSection } from "../intake/service";
import { prefillFromDesign } from "./intake-from-design";
import type { Readiness } from "./readiness";
import { savedFigmaFile } from "./service";

/*
  Pre-filling the intake from the design's own text: code only, no AI and no
  Figma read. Only empty answers are filled, each marked "from the design"
  until a person confirms or corrects it.

  Two ways in:
  - The "Pre-fill the intake" button (web lib/figma.ts), as before.
  - By itself at the end of every design read (E0(c), audit batch E, 13
    November 2026): the Figma import (figma/service.ts) and the upload read
    (worker design-upload.ts) call prefillAfterDesignRead. In the paid Lane 2
    run nobody pressed the button, so the built footer showed placeholders
    for facts the design itself showed. Run where the read finishes, not when
    a page opens: nothing is mid-render, existing projects are untouched
    until their design is read again, and each read runs it once. Run by
    TAWD it never refills an answer a person corrected or cleared after TAWD
    had filled it (an answer a person typed and later cleared carries no
    such mark, so it counts as empty).

  Everything is written in one transaction holding lockIntakeForFills (as
  the current-site pre-fill does): the answers, their marks, the result and
  the log, or nothing. A person's checked save, or another fill, at the same
  moment waits for it, also on a project whose intake was never saved: the
  lock is the project's row, which always exists (Fable's review of #93).
*/

export interface DesignPrefillResult {
  at: string;
  by: string | null;
  /** The design version this pre-fill read. */
  version?: string | null;
  /** True when TAWD ran it by itself after a read (no person pressed the button). */
  automatic?: boolean;
  filled: { key: PrefillKey; label: string; value: string }[];
  alreadyFilled: string[];
  notFound: string[];
}

/* A value in words, for the result list and the log. */
export function prefillText(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((v) => {
        if (typeof v !== "object" || !v || !("name" in v)) return String(v);
        // A location reads "Bishop (760) 555-0142"; a service just its name.
        const { name, phone } = v as { name: string; phone?: string };
        return phone ? `${name} ${phone}` : name;
      })
      .join(", ");
  }
  return String(value);
}

export class DesignPrefillError extends Error {}

export async function runDesignPrefill(
  db: Database,
  projectId: string,
  who: { actor: Viewer; by: string | null; automatic: boolean; ipAddress?: string | null; userAgent?: string | null },
): Promise<DesignPrefillResult> {
  const [row] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  if (!row || row.importStatus !== "done") throw new DesignPrefillError("Import the design first; the intake is filled from the imported frames.");
  const file = await savedFigmaFile(row);
  const readiness = row.readiness as Readiness | null;
  if (!file || !readiness) throw new DesignPrefillError("The saved Figma file is missing. Check the file and import it again.");
  const proposals = prefillFromDesign(file, readiness.frames);

  return db.transaction(async (txn) => {
    const tx = txn as unknown as Database;
    await lockIntakeForFills(tx, projectId);
    const intake = await loadIntake(tx, SYSTEM_ACTOR, projectId);
    if (!intake) throw new DesignPrefillError("This project has no intake.");
    // Answers a person corrected (or cleared): TAWD on its own never fills them again; the button still can.
    const corrected = who.automatic
      ? new Set((await tx.select({ fieldKey: intakePrefill.fieldKey, status: intakePrefill.status }).from(intakePrefill).where(eq(intakePrefill.projectId, projectId))).filter((m) => m.status === "corrected").map((m) => m.fieldKey))
      : new Set<string>();

    let data = intake.data;
    const filled: DesignPrefillResult["filled"] = [];
    const alreadyFilled: string[] = [];
    const leftAsCorrected: string[] = [];
    // A design's number nobody could dial (a designer's "123-4567"): never filled in, or the save refuses it and the rest is lost (B5 review, M3).
    const undiallable: string[] = [];
    for (const proposal of proposals) {
      const key = proposal.key as PrefillFieldKey;
      if (!isPrefillFieldEmpty(data, key)) {
        alreadyFilled.push(PREFILL_LABELS[proposal.key]);
        continue;
      }
      // Empty because a person corrected or cleared what TAWD filled: left as they left it, and not called "already filled" (Fable's re-read).
      if (corrected.has(proposal.key)) {
        leftAsCorrected.push(PREFILL_LABELS[proposal.key]);
        continue;
      }
      if (key === "business.phone" && phoneProblem(String(proposal.value ?? ""))) {
        undiallable.push(`${PREFILL_LABELS[proposal.key]} (the design shows ${String(proposal.value)}, which can't be dialled)`);
        continue;
      }
      if (key === "business.locations" && Array.isArray(proposal.value)) {
        proposal.value = (proposal.value as { phone?: string }[]).map((l) => (l.phone && phoneProblem(l.phone) ? { ...l, phone: "" } : l)) as typeof proposal.value;
      }
      data = withPrefill(data, key, proposal.value, () => crypto.randomUUID());
      filled.push({ key: proposal.key, label: PREFILL_LABELS[proposal.key], value: prefillText(proposal.value) });
    }
    // Most businesses have one office, so no other locations is nothing to report;
    // the site-only facts (guarantee, offer, financing) a design can't carry are left out too.
    const siteOnly = new Set<PrefillKey>(SITE_ONLY_PREFILL_KEYS);
    const notFound = [
      ...PREFILL_KEYS.filter((key) => key !== "business.locations" && !siteOnly.has(key) && !proposals.some((p) => p.key === key)).map((key) => PREFILL_LABELS[key]),
      ...undiallable,
    ];

    const ctx = { db: tx, ipAddress: who.ipAddress ?? null, userAgent: who.userAgent ?? null };
    // Each section once, through the normal save, so validation and the intake log apply as usual.
    for (const section of [...new Set(filled.map((f) => sectionOfPrefill(f.key as PrefillFieldKey)))]) {
      await saveIntakeSection(ctx, who.actor, projectId, section, data[section]);
    }
    const filledBy = who.automatic ? null : who.actor.id;
    for (const f of filled) {
      const proposal = proposals.find((p) => p.key === f.key)!;
      const value = prefillValueAt(data, f.key as PrefillFieldKey);
      await tx
        .insert(intakePrefill)
        .values({ projectId, fieldKey: f.key, value, source: proposal.from, origin: "design", status: "pending", filledByUserId: filledBy, filledAt: sql`clock_timestamp()` })
        .onConflictDoUpdate({
          target: [intakePrefill.projectId, intakePrefill.fieldKey],
          // clock_timestamp (latestPrefillStamp says why).
          set: { value, source: proposal.from, origin: "design", status: "pending", filledByUserId: filledBy, filledAt: sql`clock_timestamp()`, resolvedByUserId: null, resolvedAt: null },
        });
    }

    const result: DesignPrefillResult = { at: new Date().toISOString(), by: who.by, version: row.importedVersion, automatic: who.automatic, filled, alreadyFilled, notFound };
    await tx.update(figmaDesign).set({ prefillResult: result }).where(eq(figmaDesign.projectId, projectId));
    await recordActivity(tx, {
      action: "intake.prefilled",
      entityType: "project",
      entityId: projectId,
      ...actorFields(who.actor),
      valueAfter: {
        filled: filled.map((f) => `${f.label}: ${f.value}`),
        alreadyFilled,
        notFound,
        ...(leftAsCorrected.length ? { leftAsCorrected } : {}),
        ...(who.automatic ? { automatic: true } : {}),
      },
      ipAddress: who.ipAddress ?? null,
      userAgent: who.userAgent ?? null,
    });
    return result;
  });
}

/** Who the result names when TAWD ran it by itself. */
export const AUTOMATIC_PREFILL_BY = "TAWD, automatically after the design was read";

let automaticEnabled = true;
/** Only for tests that exercise the button on its own. */
export function setAutomaticDesignPrefillForTesting(enabled: boolean): void {
  automaticEnabled = enabled;
}

/*
  Called where a design read finishes. Never throws: a pre-fill that can't
  run is logged and the read still finishes (the button stays for a retry).
  Lane 2 only.
*/
export async function prefillAfterDesignRead(db: Database, projectId: string): Promise<DesignPrefillResult | null> {
  if (!automaticEnabled) return null;
  try {
    const [p] = await db.select({ lane: project.lane }).from(project).where(eq(project.id, projectId)).limit(1);
    if (p?.lane !== "lane_2") return null;
    return await runDesignPrefill(db, projectId, { actor: SYSTEM_ACTOR, by: AUTOMATIC_PREFILL_BY, automatic: true });
  } catch (error) {
    console.error(`[design prefill ${projectId}]`, error);
    return null;
  }
}
