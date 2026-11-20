import { desc, eq, isNotNull } from "drizzle-orm";

import { SYSTEM_ACTOR_ID, actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { appSetting, projectSlack } from "@tawd/core/schema";
import { SecretsError, decryptSecret, encryptSecret } from "@tawd/core/secrets";
import { sendToWebhook } from "@tawd/core/slack";
import type { ServiceContext } from "./users";

/*
  The team's Slack channel (Jason, 29 September 2026): where TAWD posts
  what belongs to no one project, today only a failed Site check after a
  deploy. VML uses one webhook for every project, so it can be copied from
  a project in one click; the address is stored encrypted and never shown.
*/

type Db = ServiceContext["db"];
const KEY = "team_slack";
const WEBHOOK_PATTERN = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]+$/;

export class TeamSlackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamSlackError";
  }
}

interface Stored {
  webhookEncrypted: string;
  hint: string;
  connectedAt: string;
}

export interface TeamSlackView {
  connected: boolean;
  hint: string | null;
  /** A project's webhook to copy, when the team channel isn't set (its last four characters). */
  projectHint: string | null;
}

async function stored(db: Db): Promise<Stored | null> {
  const [row] = await db.select().from(appSetting).where(eq(appSetting.key, KEY)).limit(1);
  return (row?.value as Stored | undefined) ?? null;
}

export async function loadTeamSlack(db: Db): Promise<TeamSlackView> {
  const value = await stored(db);
  const [project] = value ? [] : await latestProjectWebhook(db);
  return { connected: Boolean(value), hint: value?.hint ?? null, projectHint: project?.webhookHint ?? null };
}

async function latestProjectWebhook(db: Db) {
  return db.select({ webhookEncrypted: projectSlack.webhookEncrypted, webhookHint: projectSlack.webhookHint }).from(projectSlack).where(isNotNull(projectSlack.webhookEncrypted)).orderBy(desc(projectSlack.connectedAt)).limit(1);
}

async function save(ctx: ServiceContext, actor: Viewer, value: Stored, from: string): Promise<void> {
  const existed = Boolean(await stored(ctx.db));
  await ctx.db
    .insert(appSetting)
    .values({ key: KEY, value, updatedByUserId: actor.id })
    .onConflictDoUpdate({ target: appSetting.key, set: { value, updatedByUserId: actor.id, updatedAt: new Date() } });
  await recordActivity(ctx.db, {
    action: existed ? "team_slack.replaced" : "team_slack.connected",
    entityType: "setting",
    entityId: KEY,
    ...actorFields(actor),
    // Never the address itself, not even in the log.
    valueAfter: { webhook: `ending ${value.hint}`, from },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* A webhook typed in. */
export async function connectTeamSlack(ctx: ServiceContext, actor: Viewer, webhookUrl: string): Promise<void> {
  assertCan(actor, "settings.manage");
  const url = webhookUrl.trim();
  if (!WEBHOOK_PATTERN.test(url)) {
    throw new TeamSlackError("That isn't a Slack incoming webhook. It starts with https://hooks.slack.com/services/ and comes from the Incoming Webhooks app in Slack.");
  }
  let encrypted: string;
  try {
    encrypted = encryptSecret(url);
  } catch (error) {
    if (error instanceof SecretsError) throw new TeamSlackError("Slack isn't set up on the server yet: the encryption key is missing.");
    throw error;
  }
  await save(ctx, actor, { webhookEncrypted: encrypted, hint: url.slice(-4), connectedAt: new Date().toISOString() }, "typed");
}

/* The same channel the projects post to, copied as it is stored (encrypted). */
export async function copyProjectWebhook(ctx: ServiceContext, actor: Viewer): Promise<void> {
  assertCan(actor, "settings.manage");
  const [project] = await latestProjectWebhook(ctx.db);
  if (!project?.webhookEncrypted) throw new TeamSlackError("No project is connected to Slack yet. Paste the team channel's webhook instead.");
  await save(ctx, actor, { webhookEncrypted: project.webhookEncrypted, hint: project.webhookHint ?? "????", connectedAt: new Date().toISOString() }, "a project's webhook");
}

export async function disconnectTeamSlack(ctx: ServiceContext, actor: Viewer): Promise<void> {
  assertCan(actor, "settings.manage");
  const deleted = await ctx.db.delete(appSetting).where(eq(appSetting.key, KEY)).returning();
  if (deleted.length) {
    await recordActivity(ctx.db, { action: "team_slack.disconnected", entityType: "setting", entityId: KEY, ...actorFields(actor), ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
  }
}

/*
  A new project starts connected to the team channel (Jason, 3 November
  2026): the stored, encrypted webhook is copied as it is (never decrypted
  here), with comments off as on any new connection. The team can change or
  disconnect it on the project. Never throws: a failure is logged and the
  project is simply created without Slack. The connection and its log entry
  are written together, so neither exists without the other. The server log
  gets a fixed sentence and the error's name and code only: a database
  error's message lists the query's values, the encrypted address among them
  (hand review of PR #22, 3 November 2026).
*/
export async function connectTeamSlackToProject(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<boolean> {
  try {
    const value = await stored(ctx.db);
    if (!value) return false;
    if (typeof value.webhookEncrypted !== "string" || !value.webhookEncrypted || typeof value.hint !== "string") {
      console.error("[team slack] a new project wasn't connected: the team channel setting is incomplete; connect it again on System.");
      return false;
    }
    return await ctx.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(projectSlack)
        .values({
          projectId,
          webhookEncrypted: value.webhookEncrypted,
          webhookHint: value.hint,
          connectedByUserId: actor.id === SYSTEM_ACTOR_ID ? null : actor.id,
          connectedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning({ projectId: projectSlack.projectId });
      if (inserted.length === 0) return false;
      await recordActivity(tx as unknown as Db, {
        action: "slack.connected",
        entityType: "project",
        entityId: projectId,
        ...actorFields(actor),
        // Never the address itself, not even in the log.
        valueAfter: { webhook: `ending ${value.hint}`, from: "team channel" },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
    });
    return true;
    });
  } catch (error) {
    const code = (error as { cause?: { code?: unknown }; code?: unknown } | null)?.cause?.code ?? (error as { code?: unknown } | null)?.code;
    console.error(`[team slack] a new project wasn't connected to the team channel (${error instanceof Error ? error.name : "unknown error"}${typeof code === "string" ? `, code ${code}` : ""}).`);
    return false;
  }
}

/* Posts one line to the team channel. Never throws: the reason comes back, or null when it went through (or no channel is set). */
export async function postTeamSlack(db: Db, text: string): Promise<string | null> {
  const value = await stored(db);
  if (!value) return null;
  try {
    return await sendToWebhook(decryptSecret(value.webhookEncrypted), text);
  } catch (error) {
    return error instanceof Error ? error.message : "The team Slack post failed.";
  }
}
