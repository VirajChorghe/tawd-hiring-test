import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

import type { Database } from "../../db";
import { aiCall, figmaDesign, siteBuild } from "../../db/schema";
import type { DesignBuildOptions } from "./design-build";

/*
  A retry reuses what was paid for (Jason, 29 September 2026: the sample client's first
  build was charged $0.48 and then stopped on a missing picture folder).
  The answers of a design build that didn't finish are offered to the next
  one: the same step and page, from a build after the design's last import
  and after the last finished design build. An answer saved with its
  question's fingerprint is used only for the very same question; the ones
  saved before fingerprints existed only from the latest unfinished build.
*/

export const DESIGN_ANSWER_STEPS = ["design_site_parts", "design_site_page", "design_site_rework"] as const;

export interface SavedDesignAnswer {
  step: string;
  label: string;
  /** The question's fingerprint; null for answers saved before 29 September 2026. */
  hash: string | null;
  turns: { stopReason: string | null; content: unknown[] }[];
  buildId: string;
}

interface Storage {
  get(key: string): Promise<Buffer | null>;
}

export async function reusableDesignAnswers(db: Database, storage: Storage, projectId: string, excludeBuildId?: string): Promise<SavedDesignAnswer[]> {
  const [figma] = await db.select({ importedAt: figmaDesign.importedAt }).from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  if (!figma?.importedAt) return [];
  const builds = (await db.select().from(siteBuild).where(eq(siteBuild.projectId, projectId)).orderBy(desc(siteBuild.version))).filter(
    (b) => (b.options as DesignBuildOptions | null)?.kind === "design" && b.id !== excludeBuildId,
  );
  // Only the unfinished builds since the last finished one, and since the design was imported.
  const since: typeof builds = [];
  for (const b of builds) {
    if (b.status === "done") break;
    if (b.status === "failed" && b.createdAt >= figma.importedAt) since.push(b);
  }
  if (since.length === 0) return [];
  const rows = await db
    .select({ runId: aiCall.runId, step: aiCall.step, key: aiCall.responseKey, createdAt: aiCall.createdAt })
    .from(aiCall)
    .where(and(eq(aiCall.projectId, projectId), inArray(aiCall.runId, since.map((b) => b.id)), inArray(aiCall.step, [...DESIGN_ANSWER_STEPS]), isNotNull(aiCall.responseKey)))
    .orderBy(desc(aiCall.createdAt));
  const newest = since[0]!.id;
  const seen = new Set<string>();
  const out: SavedDesignAnswer[] = [];
  for (const row of rows) {
    const body = await storage.get(row.key!).catch(() => null);
    if (!body) continue;
    let saved: { label?: string | null; requestHash?: string | null; turns?: SavedDesignAnswer["turns"] };
    try {
      saved = JSON.parse(body.toString("utf8"));
    } catch {
      continue;
    }
    const hash = saved.requestHash ?? null;
    if (!saved.label || !saved.turns?.length) continue;
    // An answer without a fingerprint: only from the latest unfinished build.
    if (!hash && row.runId !== newest) continue;
    const id = `${row.runId}|${row.step}|${saved.label}|${hash ?? ""}`;
    if (seen.has(id)) continue; // the newest answer of a call (its retry round, if it had one)
    seen.add(id);
    out.push({ step: row.step, label: saved.label, hash, turns: saved.turns, buildId: row.runId });
  }
  return out;
}
