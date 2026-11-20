import { eq } from "drizzle-orm";

import type { Database } from "../db";
import { project, projectSlack, user } from "../db/schema";
import { decryptSecret } from "./secrets";

/*
  Slack updates for a project (3d).

  One short line per event, with a link back to TAWD. What goes in is
  deliberately narrow: the business name, concept letters, stage names and
  team first names. Never anything the client said, never comment text,
  never a phone number, email or address, and never money - spend alerts
  stay in the app.

  Posting never blocks or undoes anything: it runs after the action, gives
  Slack five seconds, and a failure is logged and kept on the project so
  the team sees a warning until the next post gets through. This function
  never throws.
*/

export type SlackEvent =
  | { kind: "test"; by: string }
  | { kind: "concepts_ready"; count: number }
  | { kind: "needs_pm_review"; labels: string[] }
  // The 4.5 gate (8 October 2026): concepts held back, with why.
  | { kind: "concepts_held"; held: { label: string; reason: string }[]; shown: number }
  | { kind: "changes_ready"; conceptId: string; label: string; version: number }
  | { kind: "client_decision"; by: string; label: string; version: number; approved: boolean; designOnly?: boolean }
  | { kind: "stage_changed"; from: string; to: string }
  | { kind: "comment"; by: string; conceptId: string; label: string }
  | { kind: "design_imported"; frames: number; warnings: number }
  | { kind: "design_review_ready"; mustFix: number; shouldFix: number; recommendations: number; confirmFacts?: number }
  | { kind: "design_copy_ready"; match: number }
  | { kind: "design_improved"; changes: number; before: number | null; after: number | null }
  | { kind: "design_decisions_done"; by: string; accepted: number; pushedBack: number }
  | { kind: "design_decisions_version_ready"; accepted: number; pushedBack: number }
  | { kind: "design_on_board"; conceptId: string; version: number }
  // Phase 9, go-live (28 September 2026): each step, the switch, and a rollback.
  | { kind: "golive_step"; step: string }
  | { kind: "went_live"; url: string; version: number }
  | { kind: "rolled_back"; url: string; version: number }
  // Page drafts (28 September 2026): the chosen pages are drafted and waiting for Content's review.
  | { kind: "drafts_ready"; count: number }
  // Blocked sites (Part D): a paid route reached its monthly cap, so a blocked site wasn't read through it.
  | { kind: "blocked_route_capped"; route: string; capUsd: number }
  // A paid route stopped mid-read (out of credit, its key refused, limited): a person has to act.
  | { kind: "blocked_route_stopped"; route: string; reason: string };

const STAGE_NAMES: Record<string, string> = {
  intake: "Intake",
  mockups: "Design",
  content: "Content",
  build: "Build & preview",
  qa: "QA",
  live: "Live",
  paused: "Paused",
};

const SLACK_TIMEOUT_MS = 5_000;

/** Slack's markup treats &, < and > specially; everything else is literal. */
export function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function appBaseUrl(): string {
  const raw = process.env.TAWD_APP_URL ?? process.env.BETTER_AUTH_URL ?? "https://tawd.velocitymedialab.com";
  return raw.replace(/\/+$/, "");
}

/** The line Slack shows. Pure, so what may be said is easy to test. */
export function slackMessage(
  clientName: string,
  projectId: string,
  event: SlackEvent,
  baseUrl: string = appBaseUrl(),
): string {
  const name = `*${slackEscape(clientName)}*`;
  const projectUrl = `${baseUrl}/projects/${projectId}`;
  const mockupsUrl = `${projectUrl}/mockups`;
  const link = (url: string, label: string) => `<${url}|${label}>`;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  switch (event.kind) {
    case "test":
      return `${name}: test message from TAWD, sent by ${slackEscape(event.by)}. Updates for this project will appear here. ${link(projectUrl, "Open project")}`;
    case "concepts_ready":
      return `${name}: ${plural(event.count, "concept")} ready for team review. ${link(mockupsUrl, "Open Design")}`;
    case "needs_pm_review":
      return `${name}: Concept ${event.labels.join(" and ")} still scored under 3 after a rebuild and ${event.labels.length === 1 ? "needs" : "need"} a PM's look. ${link(mockupsUrl, "Open Design")}`;
    case "concepts_held":
      return `${name}: ${event.held.map((h) => `Concept ${h.label} is held (${slackEscape(h.reason)})`).join(" ")} Only concepts at 4.5 or above are shown${event.shown === 0 ? "; none reached it, so an admin can Show it anyway or build a new concept" : ""}. ${link(mockupsUrl, "Open Design")}`;
    case "changes_ready":
      return `${name}: Concept ${event.label} v${event.version} is ready, with the requested changes. ${link(`${mockupsUrl}/${event.conceptId}`, `Open Concept ${event.label}`)}`;
    case "client_decision":
      return event.approved
        ? `${name}: ${slackEscape(event.by)} recorded the client's decision: Concept ${event.label} v${event.version} approved. ${event.designOnly ? "Moved to Build (Design only)." : "Moved to Content."} ${link(mockupsUrl, "Open Design")}`
        : `${name}: ${slackEscape(event.by)} recorded the client's decision: changes requested on Concept ${event.label}, v${event.version + 1} being made. ${link(mockupsUrl, "Open Design")}`;
    case "stage_changed":
      return event.to === "live"
        ? `${name} is live. ${link(projectUrl, "Open project")}`
        : `${name} moved from ${STAGE_NAMES[event.from] ?? event.from} to ${STAGE_NAMES[event.to] ?? event.to}. ${link(projectUrl, "Open project")}`;
    case "comment":
      return `${name}: ${slackEscape(event.by)} commented on Concept ${event.label}. ${link(`${mockupsUrl}/${event.conceptId}`, "Read it in TAWD")}`;
    case "design_imported":
      return `${name}: the designer's design was imported from Figma: ${plural(event.frames, "frame")}${event.warnings > 0 ? `, ${plural(event.warnings, "warning")} to look at` : ""}. ${link(mockupsUrl, "Open Design")}`;
    case "design_review_ready":
      return `${name}: the Creative Director reviewed the designer's design: ${event.mustFix} must-fix, ${event.shouldFix} should-fix, ${plural(event.recommendations, "recommendation")}${event.confirmFacts ? `, ${plural(event.confirmFacts, "fact")} to confirm` : ""}. ${link(`${mockupsUrl}/design`, "Open the review")}`;
    case "blocked_route_capped":
      return `${name}: the current site blocks TAWD, and ${slackEscape(event.route)} has reached this month's cap of $${event.capUsd.toFixed(2)}, so it wasn't read through it. ${link(`${projectUrl}/intake?section=website`, "Open the Website section")}`;
    case "blocked_route_stopped":
      return `${name}: reading the current site, ${slackEscape(event.route)} stopped: ${slackEscape(event.reason)} ${link(`${projectUrl}/intake?section=website`, "Open the Website section")}`;
    case "drafts_ready":
      return `${name}: ${plural(event.count, "page draft")} ${event.count === 1 ? "is" : "are"} ready for Content to review. ${link(`${projectUrl}/content`, "Open the drafts")}`;
    case "design_copy_ready":
      return `${name}: the faithful copy of the designer's design is ready: it matches the design ${event.match}%. ${link(`${mockupsUrl}/design/copy`, "Open the copy")}`;
    case "design_improved":
      return `${name}: the improved design is ready: ${plural(event.changes, "tracked change")}${event.before !== null && event.after !== null ? `; the Creative Director's score went from ${event.before.toFixed(1)} to ${event.after.toFixed(1)} of 5` : ""}. ${link(`${mockupsUrl}/design/improved`, "Open the changes")}`;
    case "design_decisions_done":
      return `${name}: ${slackEscape(event.by)} decided on every change to the designer's design: ${event.accepted} accepted, ${event.pushedBack} pushed back. ${link(`${mockupsUrl}/design/improved`, "Open the changes")}`;
    case "design_decisions_version_ready":
      return `${name}: the version with the designer's decisions is ready (${event.accepted} accepted, ${event.pushedBack} pushed back). ${link(`${mockupsUrl}/design/improved`, "Open it")}`;
    case "design_on_board":
      return `${name}: the designer's design, improved, is on the concept board as Concept 1 (v${event.version}). ${link(`${mockupsUrl}/${event.conceptId}`, "Open Concept 1")}`;
    case "golive_step":
      return `${name}, going live: ${slackEscape(event.step)} ${link(`${projectUrl}/build`, "Open the Build page")}`;
    case "went_live":
      return `${name} is live at ${slackEscape(event.url)} (build v${event.version}). ${link(`${projectUrl}/build`, "Open the Build page")}`;
    case "rolled_back":
      return `${name} was rolled back to build v${event.version} at ${slackEscape(event.url)}. ${link(`${projectUrl}/build`, "Open the Build page")}`;
  }
}

/** A teammate's first name for a Slack line; "Someone" if unknown. */
export async function firstNameOf(db: Database, userId: string | null): Promise<string> {
  if (!userId) return "TAWD";
  const [row] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1);
  return row?.name?.trim().split(/\s+/)[0] || "Someone";
}

/* ---------- delivery ---------- */

type Fetch = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

let testFetch: Fetch | null = null;

/** Tests stand in for Slack. */
export function setSlackFetchForTesting(fetcher: Fetch | null): void {
  testFetch = fetcher;
}

export type SlackResult =
  | { ok: true }
  | { ok: false; reason: "not_connected" | "comments_off" }
  | { ok: false; reason: "failed"; message: string };

/** Posts one line to a webhook. Returns a plain-words failure, never throws. */
export async function sendToWebhook(url: string, text: string): Promise<string | null> {
  const fetcher: Fetch = testFetch ?? ((u, init) => fetch(u, init));
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    if (response.ok) return null;
    const body = (await response.text().catch(() => "")).slice(0, 60).trim();
    if (response.status === 404 || response.status === 410 || body === "no_service" || body === "channel_is_archived") {
      return `Slack refused the webhook (${body || response.status}). It may have been removed; connect a new one.`;
    }
    return `Slack answered with an error (${response.status}${body ? `: ${body}` : ""}).`;
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    return name === "TimeoutError" || name === "AbortError"
      ? "Slack didn't answer within 5 seconds."
      : "TAWD couldn't reach Slack.";
  }
}

export async function postProjectSlack(
  db: Database,
  projectId: string,
  event: SlackEvent,
): Promise<SlackResult> {
  try {
    const [row] = await db
      .select({
        clientName: project.clientName,
        webhook: projectSlack.webhookEncrypted,
        postComments: projectSlack.postComments,
      })
      .from(projectSlack)
      .innerJoin(project, eq(project.id, projectSlack.projectId))
      .where(eq(projectSlack.projectId, projectId))
      .limit(1);
    if (!row) return { ok: false, reason: "not_connected" };
    if (event.kind === "comment" && !row.postComments) return { ok: false, reason: "comments_off" };

    let failure: string | null;
    try {
      failure = await sendToWebhook(decryptSecret(row.webhook), slackMessage(row.clientName, projectId, event));
    } catch (error) {
      failure = error instanceof Error ? error.message : "The webhook could not be read.";
    }

    if (failure) {
      console.error(`Slack post for project ${projectId} (${event.kind}) failed: ${failure}`);
      await db
        .update(projectSlack)
        .set({ lastError: failure, lastErrorAt: new Date() })
        .where(eq(projectSlack.projectId, projectId));
      return { ok: false, reason: "failed", message: failure };
    }

    await db
      .update(projectSlack)
      .set({ lastPostAt: new Date(), lastError: null, lastErrorAt: null })
      .where(eq(projectSlack.projectId, projectId));
    return { ok: true };
  } catch (error) {
    // Even the bookkeeping failing must not reach the caller.
    console.error(`Slack post for project ${projectId} could not be recorded:`, error);
    return { ok: false, reason: "failed", message: "The Slack post could not be recorded." };
  }
}
