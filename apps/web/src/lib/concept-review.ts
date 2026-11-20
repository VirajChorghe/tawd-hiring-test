import { and, asc, desc, eq, inArray, isNotNull, isNull, like, lt, ne, or, sql } from "drizzle-orm";
import { zipSync } from "fflate";
import { z } from "zod";

import {
  aiCall,
  clientDecision,
  concept,
  conceptChangeRequest,
  conceptComment,
  conceptStep,
  conceptVersion,
  mockupRun,
  project,
} from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { getStorage } from "@tawd/core/intake/storage";
import { addSectionExamples } from "@tawd/core/section-library";
import {
  CHANGES_JOB,
  REVIEW_JOB,
  changesJobId,
  isRunActive,
  reviewJobId,
  type ChangesJobData,
  type ReviewJobData,
} from "@tawd/core/queue";
import { HTML_HOMEPAGE_CONCEPT, DESIGNER_CONCEPT, isGeneratedConcept, costOf, formatCost, getModelConfig, modelLabel, scoringPassCost, RERUNNABLE_STEPS, REVIEW_UNFINISHED } from "@tawd/core/mockups";
import { stepModelConfig } from "@tawd/core/step-models";
import { MockupError, getQueue } from "@/lib/mockups";
import { SpendError, assertWithinMonthlyLimit } from "@/lib/spend";
import type { ServiceContext } from "@/lib/users";
import { notifySlack } from "@/lib/slack-notify";
import { makeClientDesignDoc } from "@/lib/client-design";
import { loadReferenceUse, type ConceptReferenceUse } from "@/lib/reference-use";
import { projectTypeFor } from "@tawd/core/site-read";
import { firstNameOf } from "@tawd/core/slack";

/*
  Phase 3c: what the team does with the concepts once they are ready.

  Comments stay with the team. Request changes sends notes and the open
  comments to TAWD, which makes the next version. The client's decision is
  recorded after the call or email: approved as is moves the project to
  Content, changes requested starts a new version of the chosen concept.
  The client pack is the ticked concepts as desktop images.
*/

type Db = ServiceContext["db"];

export const CHANNELS = ["phone", "email", "meeting"] as const;
export type Channel = (typeof CHANNELS)[number];
export const channelLabels: Record<Channel, string> = {
  phone: "Phone call",
  email: "Email",
  meeting: "Meeting",
};

const commentSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, "Write the comment first.")
    .max(2000, "Keep a comment under 2,000 characters."),
  pinX: z.number().min(0).max(100).nullable(),
  pinY: z.number().min(0).max(100).nullable(),
  band: z.number().int().min(0).max(200).nullable(),
});

const decisionSchema = z.object({
  channel: z.enum(CHANNELS, { message: "Choose how the decision came in." }),
  changesRequested: z.boolean(),
  clientSaid: z
    .string()
    .trim()
    .min(3, "Write what the client said.")
    .max(4000, "Keep it under 4,000 characters."),
  logoApproved: z.boolean().optional().default(false),
});

/* ---------- lookups ---------- */

async function loadConcept(db: Db, conceptId: string) {
  const [row] = await db
    .select({
      id: concept.id,
      label: concept.label,
      status: concept.status,
      projectId: concept.projectId,
      runId: concept.runId,
      skillId: concept.skillId,
      runStatus: mockupRun.status,
      projectStatus: project.status,
    })
    .from(concept)
    .innerJoin(mockupRun, eq(mockupRun.id, concept.runId))
    .innerJoin(project, eq(project.id, concept.projectId))
    .where(eq(concept.id, conceptId))
    .limit(1);
  if (!row) throw new MockupError("That concept no longer exists.");
  return row;
}

async function latestVersionOf(db: Db, conceptId: string) {
  const [row] = await db
    .select()
    .from(conceptVersion)
    .where(eq(conceptVersion.conceptId, conceptId))
    .orderBy(desc(conceptVersion.version))
    .limit(1);
  return row ?? null;
}

/** A change request still waiting or working for this concept, if any. */
export async function pendingChangeRequest(db: Db, conceptId: string) {
  const [row] = await db
    .select()
    .from(conceptChangeRequest)
    .where(
      and(
        eq(conceptChangeRequest.conceptId, conceptId),
        inArray(conceptChangeRequest.status, ["queued", "working"]),
      ),
    )
    .limit(1);
  return row ?? null;
}

/* ---------- comments ---------- */

export async function addComment(
  ctx: ServiceContext,
  actor: Viewer,
  input: {
    conceptId: string;
    version: number;
    body: string;
    pinX?: number | null;
    pinY?: number | null;
    /** The section of its version the pin sits on, from the version's measured bands. */
    band?: number | null;
    parentId?: string | null;
  },
): Promise<string> {
  assertCan(actor, "project.view");

  const parsed = commentSchema.safeParse({
    body: input.body,
    pinX: input.pinX ?? null,
    pinY: input.pinY ?? null,
    band: input.pinX !== null && input.pinX !== undefined ? (input.band ?? null) : null,
  });
  if (!parsed.success) throw new MockupError(parsed.error.issues[0]!.message);

  const row = await loadConcept(ctx.db, input.conceptId);

  let parentId: string | null = null;
  if (input.parentId) {
    const [parent] = await ctx.db
      .select()
      .from(conceptComment)
      .where(eq(conceptComment.id, input.parentId))
      .limit(1);
    if (!parent || parent.conceptId !== row.id) {
      throw new MockupError("That comment no longer exists.");
    }
    // One level of replies: a reply to a reply joins the same thread.
    parentId = parent.parentId ?? parent.id;
  }

  const [inserted] = await ctx.db
    .insert(conceptComment)
    .values({
      projectId: row.projectId,
      conceptId: row.id,
      parentId,
      version: input.version,
      authorUserId: actor.id,
      body: parsed.data.body,
      // A reply is never pinned; it belongs to its thread.
      pinX: parentId ? null : parsed.data.pinX,
      pinY: parentId ? null : parsed.data.pinY,
      band: parentId ? null : parsed.data.band,
    })
    .returning({ id: conceptComment.id });

  // Only new threads, not replies, and only if the project switched it on.
  if (!parentId) {
    notifySlack(ctx.db, row.projectId, {
      kind: "comment",
      by: await firstNameOf(ctx.db, actor.id),
      conceptId: row.id,
      label: row.label,
    });
  }

  return inserted!.id;
}

export async function setCommentResolved(
  ctx: ServiceContext,
  actor: Viewer,
  commentId: string,
  resolved: boolean,
): Promise<void> {
  assertCan(actor, "project.view");

  const [row] = await ctx.db
    .select()
    .from(conceptComment)
    .where(eq(conceptComment.id, commentId))
    .limit(1);
  if (!row) throw new MockupError("That comment no longer exists.");
  if (row.parentId) throw new MockupError("Resolve the comment the reply belongs to.");

  await ctx.db
    .update(conceptComment)
    .set(
      resolved
        ? { resolvedAt: new Date(), resolvedByUserId: actor.id }
        : { resolvedAt: null, resolvedByUserId: null },
    )
    .where(eq(conceptComment.id, commentId));
}

/** The open, top-level comments not yet sent, oldest first. */
export async function openUnsentComments(db: Db, conceptId: string) {
  return db
    .select()
    .from(conceptComment)
    .where(
      and(
        eq(conceptComment.conceptId, conceptId),
        isNull(conceptComment.parentId),
        isNull(conceptComment.resolvedAt),
        isNull(conceptComment.changeRequestId),
        // Sent before (a second try that didn't finish): it waits for Try again, not the next round.
        isNull(conceptComment.sentInVersion),
      ),
    )
    .orderBy(asc(conceptComment.createdAt));
}

/* ---------- Request changes ---------- */

export const SUPPLIED_NO_CHANGES =
  "This is the homepage file the team supplied, so TAWD does not change it with AI. To change it, edit the HTML file, remove the old one on Intake and upload the new one: it becomes a new version of this concept.";

/*
  Shared by Request changes and a client decision with changes: checks every
  rule, writes the request, marks the included comments, logs it, queues the
  job. If the queue refuses, the request is marked failed and the comments
  go back to "Not sent", so nothing is left waiting for a worker that will
  never come.
*/
async function createChangeRequest(
  ctx: ServiceContext,
  actor: Viewer,
  input: {
    conceptId: string;
    source: "team" | "client";
    notes: string;
    includeComments: boolean;
    /** Send exactly these comments (a second try), instead of the open unsent ones. */
    commentIds?: string[];
  },
): Promise<string> {
  assertCan(actor, "project.edit");
  const db = ctx.db;

  const row = await loadConcept(db, input.conceptId);
  if (row.projectStatus !== "mockups") {
    throw new MockupError("Changes can only be requested while the project is at Design.");
  }
  if (row.status !== "ready") {
    throw new MockupError("This concept is not ready, so it cannot be changed yet.");
  }
  // A supplied homepage is the team's own file: no skill built it and none can revise it, so no AI round ever starts on it.
  if (row.skillId === HTML_HOMEPAGE_CONCEPT) throw new MockupError(SUPPLIED_NO_CHANGES);
  if (isRunActive(row.runStatus)) {
    throw new MockupError("Concepts are still generating. Wait for them to finish.");
  }
  if (await pendingChangeRequest(db, row.id)) {
    throw new MockupError("A new version of this concept is already being made.");
  }

  // At 100% of the monthly AI limit, nothing new starts - changes included.
  try {
    await assertWithinMonthlyLimit(db, { projectId: row.projectId, estimate: (await estimateChanges(db)).high });
  } catch (error) {
    if (error instanceof SpendError) throw new MockupError(error.message);
    throw error;
  }

  const latest = await latestVersionOf(db, row.id);
  if (!latest) throw new MockupError("This concept has no version to change.");

  const notes = input.notes.trim();
  if (notes.length > 4000) throw new MockupError("Keep the notes under 4,000 characters.");

  const comments = input.commentIds
    ? input.commentIds.length > 0
      ? await db.select().from(conceptComment).where(inArray(conceptComment.id, input.commentIds))
      : []
    : input.includeComments
      ? await openUnsentComments(db, row.id)
      : [];
  if (!notes && comments.length === 0) {
    throw new MockupError("Write what should change, or include at least one open comment.");
  }

  const [request] = await db
    .insert(conceptChangeRequest)
    .values({
      projectId: row.projectId,
      conceptId: row.id,
      source: input.source,
      notes,
      requestedByUserId: actor.id,
      baseVersion: latest.version,
      status: "queued",
      detail: "Waiting its turn",
    })
    .returning({ id: conceptChangeRequest.id });
  const requestId = request!.id;

  if (comments.length > 0) {
    await db
      .update(conceptComment)
      // A second try keeps "Sent in vN" until the new version replaces it, so a failed try loses nothing.
      .set({ changeRequestId: requestId, tries: sql`${conceptComment.tries} + 1` })
      .where(inArray(conceptComment.id, comments.map((c) => c.id)));
  }

  await recordActivity(db, {
    action: "mockups.changes_requested",
    entityType: "project",
    entityId: row.projectId,
    ...actorFields(actor),
    valueAfter: {
      concept: row.label,
      baseVersion: latest.version,
      source: input.source,
      notes,
      comments: comments.length,
      ...(input.commentIds ? { secondTry: true } : {}),
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });

  try {
    await getQueue().add(
      CHANGES_JOB,
      { requestId, conceptId: row.id, projectId: row.projectId } satisfies ChangesJobData,
      // Not retried: a retry would pay for the build and the review again.
      { jobId: changesJobId(requestId), attempts: 1 },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : "the queue refused the job";
    await db
      .update(conceptChangeRequest)
      .set({ status: "failed", failureReason: reason, finishedAt: new Date() })
      .where(eq(conceptChangeRequest.id, requestId));
    await db
      .update(conceptComment)
      .set({ changeRequestId: null, tries: sql`greatest(${conceptComment.tries} - 1, 0)` })
      .where(eq(conceptComment.changeRequestId, requestId));
    throw new MockupError(
      `The changes could not be queued, so nothing has started: ${reason}.`,
    );
  }

  return requestId;
}

export async function requestChanges(
  ctx: ServiceContext,
  actor: Viewer,
  input: { conceptId: string; notes: string; includeComments: boolean },
): Promise<string> {
  return createChangeRequest(ctx, actor, { ...input, source: "team" });
}

/*
  The second try (Jason, 2 October 2026: asked for, never automatic): the
  open comments the Creative Director found not done on their first send
  go again, in a new version, with the estimate shown first. A comment
  gets one second try; after that the team rewords it or posts a new one.
*/
export const MAX_COMMENT_TRIES = 2;

export async function notDoneComments(db: Db, conceptId: string) {
  return db
    .select()
    .from(conceptComment)
    .where(
      and(
        eq(conceptComment.conceptId, conceptId),
        isNull(conceptComment.parentId),
        isNull(conceptComment.resolvedAt),
        eq(conceptComment.outcome, "not_done"),
        isNotNull(conceptComment.sentInVersion),
        lt(conceptComment.tries, MAX_COMMENT_TRIES),
      ),
    )
    .orderBy(asc(conceptComment.createdAt));
}

export async function retryNotDone(
  ctx: ServiceContext,
  actor: Viewer,
  input: { conceptId: string },
): Promise<string> {
  const comments = await notDoneComments(ctx.db, input.conceptId);
  if (comments.length === 0) throw new MockupError("No comment is waiting for a second try.");
  return createChangeRequest(ctx, actor, {
    conceptId: input.conceptId,
    source: "team",
    notes: "",
    includeComments: true,
    commentIds: comments.map((c) => c.id),
  });
}

/* ---------- the client's decision ---------- */

export async function recordClientDecision(
  ctx: ServiceContext,
  actor: Viewer,
  input: {
    conceptId: string;
    channel: string;
    changesRequested: boolean;
    clientSaid: string;
    /* The "Logo approved by the client" tick, recorded with the decision. */
    logoApproved?: boolean;
  },
): Promise<{ changeRequestId: string | null; movedToContent: boolean }> {
  assertCan(actor, "project.edit");
  const db = ctx.db;

  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) throw new MockupError(parsed.error.issues[0]!.message);

  const row = await loadConcept(db, input.conceptId);
  if (row.projectStatus !== "mockups") {
    throw new MockupError("This project is no longer at Design.");
  }
  if (row.status !== "ready") {
    throw new MockupError("Only a finished concept can be chosen.");
  }
  const latest = await latestVersionOf(db, row.id);
  if (!latest) throw new MockupError("This concept has no version yet.");

  // Design only (0.100.0) has no Content step: the kept pages are the client's own words, so the project goes to Build.
  const designOnly = (await projectTypeFor(db, row.projectId)) === "design_only";
  let changeRequestId: string | null = null;
  if (parsed.data.changesRequested && row.skillId === HTML_HOMEPAGE_CONCEPT) {
    // Recorded like any decision, but no AI round starts: the page is the supplied file, so the change is made in the file (SUPPLIED_NO_CHANGES).
    changeRequestId = null;
  } else if (parsed.data.changesRequested) {
    changeRequestId = await createChangeRequest(ctx, actor, {
      conceptId: row.id,
      source: "client",
      notes: parsed.data.clientSaid,
      includeComments: false,
    });
  } else {
    assertCan(actor, "project.change_status");
    await db
      .update(project)
      .set({ status: designOnly ? "build" : "content", updatedAt: new Date() })
      .where(eq(project.id, row.projectId));
  }

  await db.insert(clientDecision).values({
    projectId: row.projectId,
    conceptId: row.id,
    version: latest.version,
    channel: parsed.data.channel,
    changesRequested: parsed.data.changesRequested,
    clientSaid: parsed.data.clientSaid,
    logoApproved: parsed.data.logoApproved,
    changeRequestId,
    recordedByUserId: actor.id,
  });

  await recordActivity(db, {
    action: "mockups.client_decision",
    entityType: "project",
    entityId: row.projectId,
    ...actorFields(actor),
    valueAfter: {
      concept: row.label,
      version: latest.version,
      channel: channelLabels[parsed.data.channel].toLowerCase(),
      changesRequested: parsed.data.changesRequested,
      clientSaid: parsed.data.clientSaid,
      logoApproved: parsed.data.logoApproved,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });

  if (!parsed.data.changesRequested) {
    await recordActivity(db, {
      action: "project.status_changed",
      entityType: "project",
      entityId: row.projectId,
      ...actorFields(actor),
      valueBefore: { status: "mockups" },
      valueAfter: { status: designOnly ? "build" : "content", reason: `Client approved Concept ${row.label} v${latest.version}${designOnly ? " (Design only: no Content step)" : ""}` },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  }

  // The client's DESIGN.md, from what they approved. A failure is logged and never undoes the decision.
  if (!parsed.data.changesRequested) {
    try {
      await makeClientDesignDoc(ctx, actor, row.projectId);
    } catch (error) {
      await recordActivity(db, {
        action: "design_md.failed",
        entityType: "project",
        entityId: row.projectId,
        ...actorFields(actor),
        valueAfter: { reason: error instanceof Error ? error.message : "unknown" },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
    }
  }

  // One line for both outcomes; it says "Moved to Content" when approved.
  notifySlack(db, row.projectId, {
    kind: "client_decision",
    by: await firstNameOf(db, actor.id),
    label: row.label,
    version: latest.version,
    approved: !parsed.data.changesRequested,
    designOnly,
  });

  /*
    The approved-section library (8 October 2026): an approved pick's
    sections, scrubbed of the client's details, become examples for later
    builds. Free; never stops the decision.
  */
  if (!parsed.data.changesRequested) {
    try {
      // A supplied page is not one of TAWD's generated designs: its sections are the client's or supplier's own, so they are not copied into the shared example library.
      if (row.skillId !== HTML_HOMEPAGE_CONCEPT) await addSectionExamples(db, getStorage(), row.id);
    } catch (error) {
      console.warn("[section library] could not add the approved concept:", error instanceof Error ? error.message : error);
    }
  }

  return { changeRequestId, movedToContent: !parsed.data.changesRequested };
}

/*
  Show a held concept anyway (Jason, 8 October 2026). A concept under 4.5 is
  held: not on the board, in the client pack or the client's choice. An
  admin can show it anyway so a project is never stuck at Design; the
  score and why it was held are logged with who showed it.
*/
export async function showHeldConcept(ctx: ServiceContext, actor: Viewer, conceptId: string): Promise<void> {
  assertCan(actor, "money.manage");
  const row = await loadConcept(ctx.db, conceptId);
  const [current] = await ctx.db.select({ status: concept.status, reason: concept.failureReason }).from(concept).where(eq(concept.id, conceptId)).limit(1);
  if (current?.status !== "held") throw new MockupError("That concept isn't held.");

  await ctx.db.update(concept).set({ status: "ready", failureReason: null }).where(eq(concept.id, conceptId));

  await recordActivity(ctx.db, {
    action: "mockups.concept_shown_anyway",
    entityType: "project",
    entityId: row.projectId,
    ...actorFields(actor),
    valueBefore: { concept: row.label, held: current.reason },
    valueAfter: { concept: row.label, shown: true },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* ---------- the client pack ---------- */

export async function setSendToClient(
  ctx: ServiceContext,
  actor: Viewer,
  conceptId: string,
  send: boolean,
): Promise<void> {
  assertCan(actor, "project.edit");
  const row = await loadConcept(ctx.db, conceptId);

  await ctx.db.update(concept).set({ sendToClient: send }).where(eq(concept.id, conceptId));

  await recordActivity(ctx.db, {
    action: "mockups.send_to_client_changed",
    entityType: "project",
    entityId: row.projectId,
    ...actorFields(actor),
    valueAfter: { concept: row.label, sendToClient: send },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/*
  The ticked concepts of the latest run, each as its newest desktop render,
  named "Concept A.png" so nothing on them says which skill made them.
*/
export async function buildClientPack(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
): Promise<{ fileName: string; body: Uint8Array; labels: string[] }> {
  assertCan(actor, "project.edit");
  const db = ctx.db;

  const [projectRow] = await db.select().from(project).where(eq(project.id, projectId)).limit(1);
  if (!projectRow) throw new MockupError("That project no longer exists.");

  const [run] = await db
    .select()
    .from(mockupRun)
    .where(eq(mockupRun.projectId, projectId))
    .orderBy(desc(mockupRun.createdAt))
    .limit(1);
  if (!run) throw new MockupError("There are no concepts yet.");

  const concepts = await db
    .select()
    .from(concept)
    .where(and(eq(concept.runId, run.id), eq(concept.status, "ready"), eq(concept.sendToClient, true)))
    .orderBy(asc(concept.label));
  if (concepts.length === 0) {
    throw new MockupError("Tick Send to client on at least one concept first.");
  }

  const storage = getStorage();
  const files: Record<string, Uint8Array> = {};
  for (const row of concepts) {
    const latest = await latestVersionOf(db, row.id);
    if (!latest?.pngKey) continue;
    const png = await storage.get(latest.pngKey);
    if (!png) throw new MockupError(`Concept ${row.label}'s image is missing from storage.`);
    files[`Concept ${row.label}.png`] = new Uint8Array(png);
  }
  const labels = concepts.map((c) => c.label);

  // PNGs are already compressed; storing them is as small and much faster.
  const body = zipSync(files, { level: 0 });
  const safeName = projectRow.clientName.replace(/[^A-Za-z0-9 &'-]/g, "").trim() || "Concepts";

  await recordActivity(db, {
    action: "mockups.client_pack_downloaded",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { concepts: labels },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });

  return { fileName: `${safeName} concepts.zip`, body, labels };
}

/* ---------- what the concept cards show ---------- */

export interface ConceptCardExtras {
  sendToClient: boolean;
  /** A five-minute link to the newest desktop render. */
  imageUrl: string | null;
  /** The Creative Director's one-line summary of the newest scored version. */
  summary: string | null;
  openComments: number;
  pending: { status: string; detail: string | null; nextVersion: number } | null;
  lastFailure: string | null;
  /** How much of each reference site the newest version used (0.99.0); null without studied references. */
  references: ConceptReferenceUse | null;
}

export async function loadConceptCards(
  db: Db,
  viewer: Viewer,
  conceptIds: string[],
): Promise<Map<string, ConceptCardExtras>> {
  assertCan(viewer, "project.view");
  const out = new Map<string, ConceptCardExtras>();
  if (conceptIds.length === 0) return out;

  const rows = await db.select().from(concept).where(inArray(concept.id, conceptIds));
  const storage = getStorage();

  for (const row of rows) {
    const versions = await db
      .select()
      .from(conceptVersion)
      .where(eq(conceptVersion.conceptId, row.id))
      .orderBy(desc(conceptVersion.version));
    const latest = versions[0];
    const summary = versions.find((v) => v.summary)?.summary ?? null;

    const open = await db
      .select({ id: conceptComment.id })
      .from(conceptComment)
      .where(
        and(
          eq(conceptComment.conceptId, row.id),
          isNull(conceptComment.parentId),
          isNull(conceptComment.resolvedAt),
        ),
      );

    const pending = await pendingChangeRequest(db, row.id);
    const [lastRequest] = await db
      .select()
      .from(conceptChangeRequest)
      .where(eq(conceptChangeRequest.conceptId, row.id))
      .orderBy(desc(conceptChangeRequest.createdAt))
      .limit(1);

    out.set(row.id, {
      sendToClient: row.sendToClient,
      imageUrl: latest?.pngKey
        ? await storage.signDownload(latest.pngKey, `concept-${row.label.toLowerCase()}-v${latest.version}.png`)
        : null,
      summary,
      openComments: open.length,
      pending: pending
        ? { status: pending.status, detail: pending.detail, nextVersion: pending.baseVersion + 1 }
        : null,
      lastFailure: lastRequest?.status === "failed" ? lastRequest.failureReason : null,
      // The designer's own design (Option B) wasn't built from the references.
      references: latest && isGeneratedConcept(row.skillId) ? await loadReferenceUse(db, row.projectId, latest) : null,
    });
  }

  return out;
}

/** The newest recorded client decision for a project, for the approved banner. */
export async function latestClientDecision(db: Db, projectId: string) {
  const [row] = await db
    .select({
      conceptId: clientDecision.conceptId,
      conceptLabel: concept.label,
      version: clientDecision.version,
      channel: clientDecision.channel,
      changesRequested: clientDecision.changesRequested,
      clientSaid: clientDecision.clientSaid,
      logoApproved: clientDecision.logoApproved,
      createdAt: clientDecision.createdAt,
    })
    .from(clientDecision)
    .innerJoin(concept, eq(concept.id, clientDecision.conceptId))
    .where(eq(clientDecision.projectId, projectId))
    .orderBy(desc(clientDecision.createdAt))
    .limit(1);
  return row ?? null;
}

/* ---------- Run the review again ---------- */

/*
  The concepts of a run whose Creative Director review is missing: no
  re-score (or rebuild score) on any version yet. Those are the only ones
  "Run the review again" reviews; a finished review is never paid twice.
*/
export async function conceptsMissingReview(db: Db, runId: string): Promise<{ id: string; label: string }[]> {
  const rows = await db
    .select({ id: concept.id, label: concept.label })
    .from(concept)
    // The designer's Concept 1 (Option B) is never part of a run's review.
    // A concept held because its review didn't finish (B4) is still missing its review.
    .where(
      and(
        eq(concept.runId, runId),
        or(eq(concept.status, "ready"), and(eq(concept.status, "held"), like(concept.failureReason, `${REVIEW_UNFINISHED}%`))),
        ne(concept.skillId, DESIGNER_CONCEPT),
        ne(concept.skillId, HTML_HOMEPAGE_CONCEPT),
      ),
    )
    .orderBy(asc(concept.label));
  const out: { id: string; label: string }[] = [];
  for (const row of rows) {
    const versions = await db
      .select({ review: conceptVersion.review })
      .from(conceptVersion)
      .where(eq(conceptVersion.conceptId, row.id));
    const passes = versions.flatMap(
      (v) => ((v.review ?? {}) as { passes?: { pass: string }[] }).passes ?? [],
    );
    const finished = passes.some((p) => p.pass === "after" || p.pass === "rebuild");
    if (!finished) out.push(row);
  }
  return out;
}

/*
  What a review run again costs: per concept, a score, perhaps one
  improvement round, and a re-score. Whole dollars, from the rates.
*/
export function rerunReviewEstimate(concepts: number): string {
  const config = getModelConfig();
  const review = costOf({ inputTokens: 40_000, outputTokens: 5_000 }, config);
  const improve = costOf({ inputTokens: 45_000, outputTokens: 30_000 }, config);
  const low = concepts * 2 * review;
  const high = concepts * (2 * review + improve);
  return `About $${Math.max(1, Math.floor(low))} to $${Math.max(2, Math.ceil(high))} of AI`;
}

export async function rerunReview(
  ctx: ServiceContext,
  actor: Viewer,
  runId: string,
): Promise<{ concepts: string[] }> {
  assertCan(actor, "project.edit");
  const db = ctx.db;

  const [run] = await db
    .select({ id: mockupRun.id, status: mockupRun.status, projectId: mockupRun.projectId, projectStatus: project.status })
    .from(mockupRun)
    .innerJoin(project, eq(project.id, mockupRun.projectId))
    .where(eq(mockupRun.id, runId))
    .limit(1);
  if (!run) throw new MockupError("That run no longer exists.");
  if (run.projectStatus !== "mockups") throw new MockupError("This project is no longer at Design.");
  if (isRunActive(run.status)) throw new MockupError("The review is already running.");

  const missing = await conceptsMissingReview(db, runId);
  if (missing.length === 0) throw new MockupError("Every concept in this run already has its review.");

  try {
    await assertWithinMonthlyLimit(db, { projectId: run.projectId, estimate: rerunReviewCost(missing.length) });
  } catch (error) {
    if (error instanceof SpendError) throw new MockupError(error.message);
    throw error;
  }

  // The generating screen shows it working, only for the concepts involved.
  const previous = { status: run.status };
  await db.update(mockupRun).set({ status: "running", failureReason: null, finishedAt: null }).where(eq(mockupRun.id, runId));
  for (const c of missing) {
    for (const step of ["review", "improve", "final_checks"]) {
      await db
        .update(conceptStep)
        .set({ status: "waiting", detail: step === "review" ? "Waiting to run the review again" : null })
        .where(and(eq(conceptStep.conceptId, c.id), eq(conceptStep.step, step), inArray(conceptStep.status, [...RERUNNABLE_STEPS])));
    }
  }

  await recordActivity(db, {
    action: "mockups.review_rerun",
    entityType: "project",
    entityId: run.projectId,
    ...actorFields(actor),
    valueAfter: { concepts: missing.map((c) => c.label) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });

  try {
    await getQueue().add(
      REVIEW_JOB,
      { runId, projectId: run.projectId, retry: true } satisfies ReviewJobData,
      // Its own id, so it is never mistaken for the first review; not
      // retried automatically, since a retry would pay for the calls again.
      { jobId: reviewJobId(runId, `retry-${Date.now()}`), attempts: 1 },
    );
  } catch (error) {
    await db.update(mockupRun).set({ status: previous.status }).where(eq(mockupRun.id, runId));
    const reason = error instanceof Error ? error.message : "the queue refused the job";
    throw new MockupError(`The review could not be queued, so nothing has started: ${reason}.`);
  }

  return { concepts: missing.map((c) => c.label) };
}

/*
  What one round of changes costs (2 October 2026): measured from the
  rounds so far (finding the sections, the edit with its pictures, any fix
  round), plus one Creative Director scoring. Edits go section by section,
  so a round is cents, not dollars; the old guess priced a whole page.
  `high` (twice the estimate) is what the monthly cap is checked against.
*/
export const CHANGES_GUESS = {
  locate: { inputTokens: 3_000, outputTokens: 300 },
  edit: { inputTokens: 16_000, outputTokens: 6_000 },
};

export async function estimateChanges(db: Db): Promise<{ cost: number; high: number; label: string }> {
  const config = await stepModelConfig(db, "changes");
  const fixConfig = await stepModelConfig(db, "fix");
  const review = scoringPassCost(await stepModelConfig(db, "review"));
  /*
    The finished rounds' own calls, totalled in the database: the edit and
    the locate call (step "changes") and the fix rounds they needed (step
    "fix", on the same concept while the request was working). Failed
    rounds are left out of both sides.
  */
  const totals = await db
    .select({
      step: aiCall.step,
      inputTokens: sql<number>`coalesce(sum(${aiCall.inputTokens}), 0)::float8`,
      outputTokens: sql<number>`coalesce(sum(${aiCall.outputTokens}), 0)::float8`,
      cacheReadTokens: sql<number>`coalesce(sum(${aiCall.cacheReadTokens}), 0)::float8`,
      cacheWriteTokens: sql<number>`coalesce(sum(${aiCall.cacheWriteTokens}), 0)::float8`,
      cacheWrite1hTokens: sql<number>`coalesce(sum(${aiCall.cacheWrite1hTokens}), 0)::float8`,
    })
    .from(aiCall)
    .innerJoin(
      conceptChangeRequest,
      and(
        eq(conceptChangeRequest.conceptId, aiCall.conceptId),
        eq(conceptChangeRequest.status, "done"),
        sql`${aiCall.createdAt} >= ${conceptChangeRequest.createdAt}`,
        sql`${aiCall.createdAt} <= ${conceptChangeRequest.finishedAt}`,
      ),
    )
    .where(inArray(aiCall.step, ["changes", "fix"]))
    .groupBy(aiCall.step);
  const [rounds] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(conceptChangeRequest)
    .where(eq(conceptChangeRequest.status, "done"));
  const n = Number(rounds?.n ?? 0);
  const model = modelLabel(config.model);
  const spent = totals.reduce((sum, t) => sum + costOf(t, t.step === "fix" ? fixConfig : config), 0);
  if (n > 0 && spent > 0) {
    const cost = spent / n + review;
    return {
      cost,
      high: cost * 2,
      label: `About ${formatCost(cost)} of AI on ${model}, from the ${n} round${n === 1 ? "" : "s"} so far (finding the sections, the edit, a fix round if needed and one scoring)`,
    };
  }
  const cost = costOf(CHANGES_GUESS.locate, config) + costOf(CHANGES_GUESS.edit, config) + review;
  return {
    cost,
    high: cost * 2,
    label: `About ${formatCost(cost)} of AI on ${model} (a first guess until a round has run): finding the sections, the edit and one scoring`,
  };
}

function rerunReviewCost(concepts: number): number {
  const config = getModelConfig();
  return concepts * (2 * costOf({ inputTokens: 40_000, outputTokens: 5_000 }, config) + costOf({ inputTokens: 45_000, outputTokens: 30_000 }, config));
}
