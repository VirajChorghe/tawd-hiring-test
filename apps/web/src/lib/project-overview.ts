import { and, desc, eq, inArray } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import {
  activityLog,
  concept,
  conceptVersion,
  mockupRun,
  user as userTable,
} from "@tawd/core/schema";
import type { ProjectStatus } from "@tawd/core/enums";
import { loadIntake } from "@tawd/core/intake/service";
import { isRunActive } from "@tawd/core/queue";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { actionLabels, statusLabels } from "@/lib/labels";
import { listProjects, type ProjectSummary } from "@/lib/projects";

/*
  The Projects page: each project with what needs attention and what last
  happened, worked out from real state rather than stored.

  The rules are pure functions below the loader, so what "needs attention"
  means is one readable thing, tested on its own.
*/

/* ---------- needs attention ---------- */

export type AttentionTone = "warn" | "go" | "none";

export interface Attention {
  tone: AttentionTone;
  text: string;
}

export interface AttentionInput {
  status: ProjectStatus;
  /** Required intake items still missing, while in Intake. */
  missingRequired: number;
  latestRun: {
    status: string;
    /** Concepts whose newest version still fails its checks. */
    conceptsFailingChecks: number;
    conceptsNeedingPmReview: number;
  } | null;
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/*
  Most urgent first. Amber is for something a person has to fix; blue is
  the next step being ready; nothing at all is shown as a quiet dash.
*/
export function needsAttention(input: AttentionInput): Attention {
  if (input.status === "intake") {
    return input.missingRequired > 0
      ? { tone: "warn", text: `${plural(input.missingRequired, "required item")} missing` }
      : { tone: "go", text: "Ready for Design" };
  }

  if (input.status !== "mockups" || !input.latestRun) {
    return input.status === "mockups"
      ? { tone: "go", text: "Ready to generate concepts" }
      : { tone: "none", text: "" };
  }

  const run = input.latestRun;
  if (isRunActive(run.status)) return { tone: "go", text: "Generating concepts" };

  switch (run.status) {
    case "checks_failed":
      return {
        tone: "warn",
        text: `Checks failed on ${plural(Math.max(1, run.conceptsFailingChecks), "concept")}`,
      };
    case "needs_pm_review":
      return {
        tone: "warn",
        text:
          run.conceptsNeedingPmReview > 1
            ? `Needs PM review on ${run.conceptsNeedingPmReview} concepts`
            : "Needs PM review",
      };
    case "needs_intake":
      return { tone: "warn", text: "Needs intake info" };
    case "review_incomplete":
      return { tone: "warn", text: "Creative Director review didn't finish" };
    case "failed":
      return { tone: "warn", text: "Last run failed" };
    case "succeeded":
      return { tone: "go", text: "Ready to send to client" };
    default:
      return { tone: "none", text: "" };
  }
}

/* ---------- last activity ---------- */

export interface ActivityForSummary {
  action: string;
  actorName: string | null;
  valueAfter: unknown;
}

// "Sam (deleted user)" is kept whole; any other name is cut to the first word.
const firstName = (name: string | null) =>
  name?.endsWith("(deleted user)") ? name : (name?.trim().split(/\s+/)[0] ?? null);

/** One short line: "Jason ran 1 concept", "Creative Director review done". */
export function describeLastActivity(entry: ActivityForSummary): string {
  const who = firstName(entry.actorName);
  const after = (entry.valueAfter ?? {}) as Record<string, unknown>;
  const by = (text: string) => (who ? `${who} ${text}` : capitalize(text));

  switch (entry.action) {
    case "project.created":
      return by("created the project");
    case "project.updated":
      return by("edited the project");
    case "project.status_changed": {
      const status = after.status as ProjectStatus | undefined;
      return status ? `Moved to ${statusLabels[status] ?? status}` : "Stage changed";
    }
    case "project.members_changed":
      return by("changed the team");
    case "project.gate_overridden":
      return by("overrode the intake gate");
    case "intake.updated":
      return by("updated the intake");
    case "intake.file_added":
      return by("uploaded a file");
    case "intake.file_captioned":
      return by("captioned a photo");
    case "intake.file_removed":
      return by("removed a file");
    case "mockups.run_started": {
      const concepts = Array.isArray(after.concepts) ? after.concepts.length : null;
      return by(concepts ? `ran ${plural(concepts, "concept")}` : "started concepts");
    }
    case "mockups.directions_overridden":
      return by("changed concept directions");
    case "mockups.run_stopped":
      return by("stopped a run");
    case "mockups.concept_built":
      return typeof after.concept === "string" ? `Concept ${after.concept} built` : "Concept built";
    case "mockups.concept_failed":
      return typeof after.concept === "string" ? `Concept ${after.concept} failed` : "A concept failed";
    case "mockups.review_finished":
      return "Creative Director review done";
    case "mockups.run_finished":
      return "Concepts ready";
    default:
      return actionLabels[entry.action] ?? entry.action;
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const PACIFIC = "America/Los_Angeles";
const dayOf = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: PACIFIC }).format(d);

/** "Today, 12:10 PM", "Yesterday", "Sep 22", or "Sep 22, 2025", in Pacific time. */
export function formatActivityWhen(when: Date, now: Date = new Date()): string {
  const day = dayOf(when);
  const today = dayOf(now);
  const yesterday = dayOf(new Date(now.getTime() - 86_400_000));

  if (day === today) {
    return `Today, ${new Intl.DateTimeFormat("en-US", { timeZone: PACIFIC, hour: "numeric", minute: "2-digit" }).format(when)} PT`;
  }
  if (day === yesterday) return "Yesterday";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC,
    month: "short",
    day: "numeric",
    ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" } : {}),
  }).format(when);
}

/* ---------- the loader ---------- */

export interface ProjectOverviewRow extends ProjectSummary {
  attention: Attention;
  lastActivity: { text: string; when: string; at: Date } | null;
}

export async function listProjectOverview(
  db: Database,
  viewer: Viewer,
  now: Date = new Date(),
): Promise<ProjectOverviewRow[]> {
  assertCan(viewer, "project.view");

  const projects = await listProjects(db, viewer);
  if (projects.length === 0) return [];
  const ids = projects.map((p) => p.id);

  // The newest run per project.
  const runs = await db
    .selectDistinctOn([mockupRun.projectId], {
      id: mockupRun.id,
      projectId: mockupRun.projectId,
      status: mockupRun.status,
    })
    .from(mockupRun)
    .where(inArray(mockupRun.projectId, ids))
    .orderBy(mockupRun.projectId, desc(mockupRun.createdAt));

  // Each of those runs' concepts, with their newest version's checks and review.
  const runIds = runs.map((r) => r.id);
  const newestVersions =
    runIds.length === 0
      ? []
      : await db
          .selectDistinctOn([conceptVersion.conceptId], {
            runId: concept.runId,
            checks: conceptVersion.checks,
            review: conceptVersion.review,
          })
          .from(conceptVersion)
          .innerJoin(concept, eq(concept.id, conceptVersion.conceptId))
          .where(and(inArray(concept.runId, runIds), eq(concept.status, "ready")))
          .orderBy(conceptVersion.conceptId, desc(conceptVersion.version));

  // The newest activity entry per project.
  const activity = await db
    .selectDistinctOn([activityLog.entityId], {
      projectId: activityLog.entityId,
      action: activityLog.action,
      valueAfter: activityLog.valueAfter,
      occurredAt: activityLog.occurredAt,
      actorName: userTable.name,
      actorDeletedAt: userTable.deletedAt,
    })
    .from(activityLog)
    .leftJoin(userTable, eq(userTable.id, activityLog.actorUserId))
    .where(
      and(
        eq(activityLog.entityType, "project"),
        inArray(activityLog.entityId, ids),
      ),
    )
    .orderBy(activityLog.entityId, desc(activityLog.seq));

  const out: ProjectOverviewRow[] = [];
  for (const project of projects) {
    const run = runs.find((r) => r.projectId === project.id) ?? null;
    const versions = run ? newestVersions.filter((v) => v.runId === run.id) : [];

    let missingRequired = 0;
    if (project.status === "intake") {
      const intake = await loadIntake(db, viewer, project.id);
      missingRequired = intake?.completeness.missing.length ?? 0;
    }

    const latest = activity.find((a) => a.projectId === project.id);

    out.push({
      ...project,
      attention: needsAttention({
        status: project.status,
        missingRequired,
        latestRun: run
          ? {
              status: run.status,
              conceptsFailingChecks: versions.filter(
                (v) => (v.checks as { passed?: boolean } | null)?.passed === false,
              ).length,
              conceptsNeedingPmReview: versions.filter(
                (v) => (v.review as { needsPmReview?: boolean } | null)?.needsPmReview === true,
              ).length,
            }
          : null,
      }),
      lastActivity: latest
        ? {
            text: describeLastActivity({
              ...latest,
              actorName: latest.actorDeletedAt && latest.actorName
                ? `${latest.actorName.trim().split(/\s+/)[0]} (deleted user)`
                : latest.actorName,
            }),
            when: formatActivityWhen(latest.occurredAt, now),
            at: latest.occurredAt,
          }
        : null,
    });
  }

  return out;
}
