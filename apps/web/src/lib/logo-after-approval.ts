import { and, desc, eq, inArray } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { intakeFile, logoApproval, logoSwap } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { approvedMockupVersion } from "@tawd/core/approved";
import { HTML_HOMEPAGE_CONCEPT } from "@tawd/core/mockups";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { LOGO_SWAP_JOB, logoSwapJobId } from "@tawd/core/queue";
import { CHANNELS, channelLabels, type Channel } from "@/lib/concept-review";
import { getQueue } from "@/lib/mockups";
import type { ServiceContext } from "@/lib/users";

/*
  The logo after approval (Jason, 27 September 2026). When the intake's logo
  changes after the client approved a mockup, the team can put the new logo
  into the approved concept (free, no AI, a new version that becomes the
  approved one, and the client DESIGN.md is written again), and record the
  client's approval of the logo the way the mockup decision is recorded.
*/

type Db = Database;

export class LogoApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogoApprovalError";
  }
}

export interface LogoAfterApprovalView {
  conceptLabel: string;
  version: number;
  /** The intake's logo is newer than the approved version: offer the swap. */
  logoChanged: boolean;
  swap: { status: string; toVersion: number | null; failureReason: string | null } | null;
  /** The "Logo approved" mark: from the decision, or a later recorded approval. */
  mark: { approved: boolean | null; line: string };
}

export async function loadLogoAfterApproval(db: Db, projectId: string, names: Map<string, string>): Promise<LogoAfterApprovalView | null> {
  const approved = await approvedMockupVersion(db, projectId);
  if (!approved) return null;
  const [logo] = await db
    .select({ createdAt: intakeFile.createdAt })
    .from(intakeFile)
    .where(and(eq(intakeFile.projectId, projectId), eq(intakeFile.kind, "logo"), eq(intakeFile.status, "ready")))
    .orderBy(desc(intakeFile.createdAt))
    .limit(1);
  const [swap] = await db.select().from(logoSwap).where(eq(logoSwap.projectId, projectId)).orderBy(desc(logoSwap.createdAt)).limit(1);
  const [approval] = await db.select().from(logoApproval).where(eq(logoApproval.projectId, projectId)).orderBy(desc(logoApproval.createdAt)).limit(1);
  const working = swap && (swap.status === "queued" || swap.status === "working");
  // A supplied homepage (HTML) has no logo spot TAWD can swap: the offer is never made for it.
  const logoChanged = Boolean(logo && logo.createdAt > approved.version.createdAt && !working && approved.concept.skillId !== HTML_HOMEPAGE_CONCEPT);

  const mark =
    approval && approval.createdAt > approved.decision.createdAt
      ? {
          approved: true,
          line: `Logo approved by the client: recorded by ${names.get(approval.recordedByUserId) ?? "the team"} (${channelLabels[approval.channel as Channel]?.toLowerCase() ?? approval.channel}), "${approval.clientSaid}"${approval.version !== approved.version.version ? ` (on v${approval.version})` : ""}.`,
        }
      : approved.decision.logoApproved === true
        ? { approved: true, line: "Logo approved by the client, with the mockup decision." }
        : { approved: approved.decision.logoApproved === false ? false : null, line: "The client's approval of the logo isn't recorded yet." };

  return {
    conceptLabel: approved.concept.label,
    version: approved.version.version,
    logoChanged,
    swap: swap ? { status: swap.status, toVersion: swap.toVersion, failureReason: swap.failureReason } : null,
    mark,
  };
}

/* "Put the new logo into the approved concept": free, no AI, a new version. */
export async function startLogoSwap(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<string> {
  assertCan(actor, "project.edit");
  const approved = await approvedMockupVersion(ctx.db, projectId);
  if (!approved) throw new LogoApprovalError("The client hasn't approved a mockup yet.");
  if (approved.concept.skillId === HTML_HOMEPAGE_CONCEPT) throw new LogoApprovalError("The approved page is the homepage file the team supplied, which has no logo spot TAWD can swap. Change the logo in the HTML file, remove the old file on Intake and upload the new one.");
  const [running] = await ctx.db
    .select({ id: logoSwap.id })
    .from(logoSwap)
    .where(and(eq(logoSwap.projectId, projectId), inArray(logoSwap.status, ["queued", "working"])))
    .limit(1);
  if (running) throw new LogoApprovalError("The new logo is already going in.");
  const [row] = await ctx.db
    .insert(logoSwap)
    .values({ projectId, conceptId: approved.concept.id, fromVersion: approved.version.version, requestedByUserId: actor.id })
    .returning({ id: logoSwap.id });
  try {
    await getQueue().add(LOGO_SWAP_JOB, { swapId: row!.id, projectId }, { jobId: logoSwapJobId(row!.id) });
  } catch (error) {
    await ctx.db.update(logoSwap).set({ status: "failed", failureReason: "The queue refused the job.", finishedAt: new Date() }).where(eq(logoSwap.id, row!.id));
    throw new LogoApprovalError(`The swap could not be queued: ${error instanceof Error ? error.message : "the queue refused it"}.`);
  }
  await recordActivity(ctx.db, {
    action: "mockups.logo_swap_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { concept: approved.concept.label, version: approved.version.version },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return row!.id;
}

/* "Record logo approval": how it came in and what the client said, logged; updates the mark. */
export async function recordLogoApproval(ctx: ServiceContext, actor: Viewer, projectId: string, input: { channel: string; clientSaid: string }): Promise<void> {
  assertCan(actor, "project.edit");
  if (!(CHANNELS as readonly string[]).includes(input.channel)) throw new LogoApprovalError("Choose how the approval came in.");
  const said = input.clientSaid.trim();
  if (said.length < 3) throw new LogoApprovalError("Write what the client said.");
  const approved = await approvedMockupVersion(ctx.db, projectId);
  if (!approved) throw new LogoApprovalError("The client hasn't approved a mockup yet.");
  await ctx.db.insert(logoApproval).values({
    projectId,
    conceptId: approved.concept.id,
    version: approved.version.version,
    channel: input.channel,
    clientSaid: said.slice(0, 4000),
    recordedByUserId: actor.id,
  });
  await recordActivity(ctx.db, {
    action: "mockups.logo_approved",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { concept: approved.concept.label, version: approved.version.version, channel: channelLabels[input.channel as Channel].toLowerCase(), clientSaid: said.slice(0, 1000) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}
