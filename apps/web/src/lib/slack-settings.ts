import { eq } from "drizzle-orm";

import { project, projectSlack } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { SecretsError, encryptSecret, hasEncryptionKey } from "@tawd/core/secrets";
import { firstNameOf, postProjectSlack } from "@tawd/core/slack";
import type { ServiceContext } from "@/lib/users";
import { formatActivityWhen } from "@/lib/project-overview";

/*
  The Slack card on the project page. PMs and admins connect, replace or
  disconnect a project's incoming webhook and send a test message. The URL
  is encrypted as it is saved and never leaves the server again; the card
  shows only its last four characters.
*/

type Db = ServiceContext["db"];

export class SlackSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackSettingsError";
  }
}

const WEBHOOK_PATTERN = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/;

export interface SlackStatus {
  /** Whether the server has the encryption key at all. */
  available: boolean;
  connected: boolean;
  /** "x9Kq", the webhook's last four characters. */
  hint: string | null;
  postComments: boolean;
  lastPostAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
}

export async function getSlackStatus(db: Db, projectId: string): Promise<SlackStatus> {
  const [row] = await db.select().from(projectSlack).where(eq(projectSlack.projectId, projectId)).limit(1);
  return {
    available: hasEncryptionKey(),
    connected: Boolean(row),
    hint: row?.webhookHint ?? null,
    postComments: row?.postComments ?? false,
    lastPostAt: row?.lastPostAt ?? null,
    lastError: row?.lastError ?? null,
    lastErrorAt: row?.lastErrorAt ?? null,
  };
}

/** The warning line for the project header, or null when all is well. */
export async function slackWarningFor(db: Db, projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ lastError: projectSlack.lastError, lastErrorAt: projectSlack.lastErrorAt })
    .from(projectSlack)
    .where(eq(projectSlack.projectId, projectId))
    .limit(1);
  if (!row?.lastError || !row.lastErrorAt) return null;
  return `A Slack update didn't go through (${formatActivityWhen(row.lastErrorAt)}): ${row.lastError}`;
}

async function requireProject(db: Db, projectId: string) {
  const [row] = await db.select({ id: project.id }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!row) throw new SlackSettingsError("That project no longer exists.");
}

export async function connectSlack(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
  webhookUrl: string,
): Promise<void> {
  assertCan(actor, "project.edit");
  await requireProject(ctx.db, projectId);

  const url = webhookUrl.trim();
  if (!WEBHOOK_PATTERN.test(url)) {
    throw new SlackSettingsError(
      "That isn't a Slack incoming webhook. It starts with https://hooks.slack.com/services/ and comes from the Incoming Webhooks app in Slack.",
    );
  }

  let encrypted: string;
  try {
    encrypted = encryptSecret(url);
  } catch (error) {
    if (error instanceof SecretsError) {
      throw new SlackSettingsError("Slack isn't set up on the server yet: the encryption key is missing.");
    }
    throw error;
  }

  const [existing] = await ctx.db
    .select({ projectId: projectSlack.projectId })
    .from(projectSlack)
    .where(eq(projectSlack.projectId, projectId))
    .limit(1);

  const values = {
    webhookEncrypted: encrypted,
    webhookHint: url.slice(-4),
    connectedByUserId: actor.id,
    connectedAt: new Date(),
    lastError: null,
    lastErrorAt: null,
  };
  if (existing) {
    await ctx.db.update(projectSlack).set(values).where(eq(projectSlack.projectId, projectId));
  } else {
    await ctx.db.insert(projectSlack).values({ projectId, ...values });
  }

  await recordActivity(ctx.db, {
    action: existing ? "slack.replaced" : "slack.connected",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    // Never the URL itself, not even in the log.
    valueAfter: { webhook: `ending ${url.slice(-4)}` },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

export async function disconnectSlack(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  assertCan(actor, "project.edit");
  const deleted = await ctx.db
    .delete(projectSlack)
    .where(eq(projectSlack.projectId, projectId))
    .returning({ hint: projectSlack.webhookHint });
  if (deleted.length === 0) return;

  await recordActivity(ctx.db, {
    action: "slack.disconnected",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueBefore: { webhook: `ending ${deleted[0]!.hint}` },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

export async function setSlackComments(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
  on: boolean,
): Promise<void> {
  assertCan(actor, "project.edit");
  const updated = await ctx.db
    .update(projectSlack)
    .set({ postComments: on })
    .where(eq(projectSlack.projectId, projectId))
    .returning({ projectId: projectSlack.projectId });
  if (updated.length === 0) throw new SlackSettingsError("Connect Slack first.");
}

/** Sends the test line and says plainly whether it arrived. */
export async function sendSlackTest(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  assertCan(actor, "project.edit");
  const result = await postProjectSlack(ctx.db, projectId, {
    kind: "test",
    by: await firstNameOf(ctx.db, actor.id),
  });
  if (result.ok) return { ok: true };
  return {
    ok: false,
    message: result.reason === "failed" ? result.message : "Connect Slack first.",
  };
}
