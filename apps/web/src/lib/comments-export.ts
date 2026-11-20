import { and, asc, eq } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { directionInfo, readPageBands } from "@tawd/core/mockups";
import { concept, conceptComment, conceptVersion, project } from "@tawd/core/schema";

import { csvCell } from "./spend-report";
import { listPeopleNames } from "./users";

/*
  Comments and fixes (8 October 2026, run notes #24): every team comment on
  a concept, by project, concept and section, and whether the Creative
  Director found it done, with its reason. Read together, the most common
  hand fixes show which ones should become a rule or a check. Admins only,
  from Spend. Free: no AI.
*/

export interface CommentRow {
  project: string;
  test: boolean;
  concept: string;
  direction: string;
  version: number;
  section: string;
  reply: boolean;
  author: string;
  comment: string;
  sentInVersion: number | null;
  outcome: string;
  outcomeReason: string;
  resolved: boolean;
  createdAt: Date;
}

const OUTCOME: Record<string, string> = { done: "Done", not_done: "Not done" };

export async function loadCommentRows(db: Database): Promise<CommentRow[]> {
  const rows = await db
    .select({
      comment: conceptComment,
      clientName: project.clientName,
      isTest: project.isTest,
      label: concept.label,
      direction: concept.direction,
      checks: conceptVersion.checks,
    })
    .from(conceptComment)
    .innerJoin(project, eq(project.id, conceptComment.projectId))
    .innerJoin(concept, eq(concept.id, conceptComment.conceptId))
    .leftJoin(conceptVersion, and(eq(conceptVersion.conceptId, conceptComment.conceptId), eq(conceptVersion.version, conceptComment.version)))
    .orderBy(asc(project.clientName), asc(concept.label), asc(conceptComment.createdAt));
  const people = await listPeopleNames(db);
  return rows.map((r) => {
    const c = r.comment;
    // The section's name from the bands measured with that version's render; a general comment has none.
    const band = c.band === null ? null : (readPageBands(r.checks).bands[c.band] ?? null);
    return {
      project: r.clientName,
      test: r.isTest,
      concept: r.label,
      direction: directionInfo(r.direction).label,
      version: c.version,
      section: c.band === null ? (c.pinX === null ? "General" : "Pinned (section unknown)") : (band?.label ?? `Section ${c.band + 1}`),
      reply: c.parentId !== null,
      author: people.get(c.authorUserId) ?? "a team member",
      comment: c.body,
      sentInVersion: c.sentInVersion,
      outcome: c.outcome ? (OUTCOME[c.outcome] ?? c.outcome) : c.sentInVersion ? "Not checked" : "Not sent",
      outcomeReason: c.outcomeReason ?? "",
      resolved: c.resolvedAt !== null,
      createdAt: c.createdAt,
    };
  });
}

export function commentsCsv(rows: CommentRow[], when: (d: Date) => string): string {
  const head = ["Project", "Test project", "Concept", "Direction", "On version", "Section", "Reply", "By", "Comment", "Sent in version", "Done or not", "Why", "Resolved", "When"];
  const lines = rows.map((r) =>
    [r.project, r.test ? "yes" : "no", r.concept, r.direction, r.version, r.section, r.reply ? "yes" : "no", r.author, r.comment, r.sentInVersion ?? "", r.outcome, r.outcomeReason, r.resolved ? "yes" : "no", when(r.createdAt)].map(csvCell).join(","),
  );
  return [head.join(","), ...lines].join("\r\n") + "\r\n";
}
