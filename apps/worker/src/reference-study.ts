import { and, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";

import { getDb } from "@tawd/core/db";
import { likedSiteShot } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { getStorage } from "@tawd/core/intake/storage";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import { loadIntake } from "@tawd/core/intake/service";
import { likedNoteFor } from "@tawd/core/intake";
import type { ReferenceStudyJobData } from "@tawd/core/queue";
import {
  CACHE_1H,
  ReferenceBriefError,
  buildReferenceStudySystemPrompt,
  buildReferenceStudyUserText,
  readReferenceBrief,
  type ReferenceBrief,
  type ReferenceOutline,
} from "@tawd/core/mockups";

import { imageBlock } from "./image-type";
import type { WorkerConfig } from "./config";
import { stepModel } from "./step-model";
import { requestSettings } from "@tawd/core/mockups";
import { recordCall } from "./pipeline";
import { usageOf } from "./review";

/*
  Reference study (27 September 2026): each reference site the team queued
  gets one AI call, with its first-screen screenshot and the outline read
  from it, and answers with a short brief of its structure and craft
  (never its identity). Saved before it is read; one retry if the reply
  can't be used. A site that fails keeps its screenshot and outline, which
  the builder still gets.
*/

export async function runReferenceStudyJob(job: ReferenceStudyJobData, config: WorkerConfig, client: Anthropic): Promise<void> {
  const db = getDb();
  const storage = getStorage();
  const rows = await db
    .select()
    .from(likedSiteShot)
    .where(and(eq(likedSiteShot.projectId, job.projectId), eq(likedSiteShot.briefStatus, "queued")));
  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: buildReferenceStudySystemPrompt(), cache_control: CACHE_1H }];
  // What the client likes about each site (0.99.0): the brief looks at those parts with care.
  const website = rows.length ? (await loadIntake(db, SYSTEM_ACTOR, job.projectId).catch(() => null))?.data.website : undefined;
  let studied = 0;

  for (const row of rows) {
    await db.update(likedSiteShot).set({ briefStatus: "working" }).where(eq(likedSiteShot.id, row.id));
    try {
      const image = row.imageKey ? await storage.get(row.imageKey) : null;
      const content: Anthropic.ContentBlockParam[] = [
        ...(image ? [imageBlock(image)] : []),
        { type: "text", text: buildReferenceStudyUserText(row.url, (row.outline as ReferenceOutline | null) ?? null, website ? likedNoteFor(website, row.url) : "") },
      ];
      const messages: Anthropic.MessageParam[] = [{ role: "user", content }];

      let brief: ReferenceBrief | null = null;
      for (let attempt = 1; attempt <= 2 && !brief; attempt += 1) {
        const model = await stepModel(db, "reference_study");
        const response = await client.messages
          .stream({ model, max_tokens: 4_000, system, messages, ...requestSettings(model, { effort: "low" }) })
          .finalMessage();
        await recordCall(db, {
          projectId: job.projectId,
          runId: row.id,
          conceptId: null,
          startedByUserId: job.startedByUserId,
          model,
          step: "reference_study",
          round: attempt,
          usage: usageOf(response.usage),
          turns: [{ stopReason: response.stop_reason, content: response.content }],
        });
        if (response.stop_reason === "refusal") throw new Error("The study was declined for this site.");
        const text = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join("");
        try {
          brief = readReferenceBrief(text);
        } catch (error) {
          if (!(error instanceof ReferenceBriefError) || attempt === 2) throw new Error(`The brief couldn't be used: ${error instanceof Error ? error.message : "unknown"}`, { cause: error });
          messages.push({ role: "assistant", content: response.content });
          messages.push({ role: "user", content: `That reply couldn't be used: ${error.message} Reply again with only the JSON object.` });
        }
      }
      await db
        .update(likedSiteShot)
        .set({ brief, briefStatus: "done", briefFailure: null, studiedAt: new Date() })
        .where(eq(likedSiteShot.id, row.id));
      studied += 1;
    } catch (error) {
      await db
        .update(likedSiteShot)
        .set({ briefStatus: "failed", briefFailure: error instanceof Error ? error.message.slice(0, 300) : "The study didn't finish." })
        .where(eq(likedSiteShot.id, row.id));
    }
  }

  if (studied > 0) {
    await recordActivity(db, {
      action: "mockups.references_studied",
      entityType: "project",
      entityId: job.projectId,
      ...actorFields(SYSTEM_ACTOR),
      valueAfter: { studied, of: rows.length },
      ipAddress: null,
      userAgent: null,
    });
  }
}
