import { asc, desc, eq, inArray } from "drizzle-orm";

import {
  concept,
  conceptChangeRequest,
  conceptComment,
  conceptVersion,
  mockupRun,
  project,
  user as userTable,
  userRole,
} from "@tawd/core/schema";
import { assertCan, can, type Viewer } from "@tawd/core/permissions";
import { getStorage } from "@tawd/core/intake/storage";
import { isRunActive } from "@tawd/core/queue";
import {
  HTML_HOMEPAGE_CONCEPT,
  PLACEHOLDER_PATTERN,
  bandsOnImage,
  isGeneratedConcept,
  directionInfo,
  readPageBands,
  skillLabels,
  type BandOnImage,
  type SkillId,
  type StoredReview,
  describeRunNotes,
  readRunNotes,
} from "@tawd/core/mockups";
import type { TeamRole } from "@tawd/core/enums";
import { getLimitState } from "@/lib/spend";
import { blockedMessage } from "@/lib/spend-report";
import { formatActivityWhen } from "@/lib/project-overview";
import { MAX_COMMENT_TRIES, SUPPLIED_NO_CHANGES, estimateChanges, pendingChangeRequest } from "@/lib/concept-review";
import { personLabel } from "@/lib/users";
import type { ServiceContext } from "@/lib/users";

/*
  Everything the concept detail screen shows, for one concept and the
  version being looked at. DESIGN.md, Mockup engine screens, 4.
*/

type Db = ServiceContext["db"];

export type VersionStage = "build" | "fix" | "cd_improve" | "rebuild" | "changes" | "logo_swap" | "polish";

export interface DetailVersion {
  version: number;
  stage: VersionStage;
  /** "v2, after review" */
  label: string;
  /** One line on how it came about. */
  note: string;
  when: string;
  checksPassed: boolean | null;
  /*
    A homepage the team supplied (HTML): no TAWD page check judged it, and
    what the reading took out or left out is listed here in full. Null for
    every other version.
  */
  supplied: { fileName: string; removed: string[]; warnings: string[] } | null;
  issues: { id: string; severity: string; message: string; needsIntake?: boolean }[];
  /* What TAWD's own code changed on this version, in plain sentences (stage 1 of docs/plans/self-check.md). */
  runNotes: string[];
  needsIntake: { key: string; label: string }[];
  placeholderCount: number | null;
  reviewAverage: number | null;
  imageUrl: string | null;
  /** Where each section sits on the picture, in percent, with its section number, for the outline under the mouse. */
  bands: BandOnImage[];
}

export interface DetailComment {
  id: string;
  number: number;
  version: number;
  author: string;
  roles: TeamRole[];
  body: string;
  pinX: number | null;
  pinY: number | null;
  when: string;
  resolved: boolean;
  tag: { kind: "not_sent" | "sending" | "sent"; version: number | null };
  /** The section the pin sits on, when it was placed on a measured version. */
  band: number | null;
  /** What the Creative Director found once it was sent. */
  outcome: { kind: "done" | "not_done"; version: number; reason?: string | null } | null;
  tries: number;
  /** Not done, sent once, still open: it can go again (asked for, never automatic). */
  canRetry: boolean;
  replies: { id: string; author: string; roles: TeamRole[]; body: string; when: string }[];
}

export interface ConceptDetail {
  projectId: string;
  clientName: string;
  inMockups: boolean;
  concept: {
    id: string;
    label: string;
    directionLabel: string;
    skillLabel: string;
    ready: boolean;
    /** The homepage file the team supplied: no skill built it, and TAWD's AI never changes or reviews it. */
    supplied: boolean;
  };
  versions: DetailVersion[];
  selected: DetailVersion;
  latestVersion: number;
  compare: DetailVersion | null;
  placeholders: string[];
  /** afterVersion: the version `after` scored, which is not the selected one when that was never scored. */
  review: { before: StoredReview | null; after: StoredReview | null; afterVersion: number | null };
  comments: DetailComment[];
  pending: { status: string; detail: string | null; nextVersion: number } | null;
  lastFailure: string | null;
  canAct: boolean;
  /** Why Request changes cannot be used right now, if it cannot. */
  changesBlocked: string | null;
  changesEstimate: string;
  /** The last finished round, in a line ("v5: all checks passed; ...; 2 of 3 comments done"). */
  lastResult: { version: number; detail: string } | null;
}

const STAGE_WORDS: Record<VersionStage, string> = {
  build: "as built",
  fix: "after a fix round",
  cd_improve: "after review",
  rebuild: "rebuilt",
  changes: "after requested changes",
  logo_swap: "with the new logo",
  polish: "after critique and polish",
};

export async function loadConceptDetail(
  db: Db,
  viewer: Viewer,
  projectId: string,
  conceptId: string,
  wanted: { version?: number; compare?: number },
): Promise<ConceptDetail | null> {
  assertCan(viewer, "project.view");

  const [row] = await db
    .select({
      id: concept.id,
      label: concept.label,
      direction: concept.direction,
      skillId: concept.skillId,
      status: concept.status,
      projectId: concept.projectId,
      runStatus: mockupRun.status,
      clientName: project.clientName,
      projectStatus: project.status,
    })
    .from(concept)
    .innerJoin(mockupRun, eq(mockupRun.id, concept.runId))
    .innerJoin(project, eq(project.id, concept.projectId))
    .where(eq(concept.id, conceptId))
    .limit(1);
  if (!row || row.projectId !== projectId) return null;

  const storage = getStorage();
  const versionRows = await db
    .select()
    .from(conceptVersion)
    .where(eq(conceptVersion.conceptId, conceptId))
    .orderBy(desc(conceptVersion.version));
  if (versionRows.length === 0) return null;

  const requests = await db
    .select()
    .from(conceptChangeRequest)
    .where(eq(conceptChangeRequest.conceptId, conceptId))
    .orderBy(desc(conceptChangeRequest.createdAt));

  const readChecks = (value: unknown) =>
    (value ?? {}) as {
      passed?: boolean;
      issues?: DetailVersion["issues"];
      needsIntake?: DetailVersion["needsIntake"];
      stage?: VersionStage;
      fixRound?: number | null;
      source?: string;
      fileName?: string;
      removed?: string[];
      warnings?: string[];
    };
  const readPasses = (value: unknown) => ((value ?? {}) as { passes?: StoredReview[] }).passes ?? [];

  const byVersion = new Map<number, (typeof versionRows)[number]>();
  for (const v of versionRows) byVersion.set(v.version, v);

  const toDetail = async (v: (typeof versionRows)[number], withImage: boolean): Promise<DetailVersion> => {
    const checks = readChecks(v.checks);
    const stage: VersionStage = checks.stage ?? (v.version === 1 ? "build" : "fix");
    const request = requests.find((r) => r.resultVersion === v.version);
    const passes = readPasses(v.review);
    const note =
      stage === "changes" && request
        ? `${request.source === "client" ? "From the client" : "From the team"}: ${request.notes || "the pinned comments"}`
        : stage === "logo_swap"
          ? "The client's new logo put in; nothing else changed (no AI)."
        : stage === "cd_improve"
          ? "The Creative Director's notes applied once."
          : stage === "rebuild"
            ? "Rebuilt from scratch after scoring under 3."
            : stage === "fix"
              ? `Automatic fixes for failed checks${checks.fixRound ? ` (round ${checks.fixRound})` : ""}.`
              : "The first build from the intake.";
    return {
      version: v.version,
      stage,
      label: `v${v.version}, ${STAGE_WORDS[stage]}`,
      note,
      when: formatActivityWhen(v.createdAt),
      checksPassed: checks.passed ?? null,
      supplied: checks.source === "html_homepage" ? { fileName: checks.fileName ?? "the supplied file", removed: checks.removed ?? [], warnings: checks.warnings ?? [] } : null,
      issues: checks.issues ?? [],
      runNotes: describeRunNotes(readRunNotes(v.checks)),
      needsIntake: checks.needsIntake ?? [],
      placeholderCount: v.placeholderCount,
      reviewAverage: passes.at(-1)?.average ?? null,
      imageUrl:
        withImage && v.pngKey
          ? await storage.signDownload(v.pngKey, `concept-${row.label.toLowerCase()}-v${v.version}.png`)
          : null,
      bands: (() => {
        const measured = readPageBands(v.checks);
        return bandsOnImage(measured.bands, measured.imageHeight);
      })(),
    };
  };

  const latestVersion = versionRows[0]!.version;
  const selectedRow = byVersion.get(wanted.version ?? latestVersion) ?? versionRows[0]!;
  const compareRow =
    wanted.compare !== undefined && wanted.compare !== selectedRow.version
      ? (byVersion.get(wanted.compare) ?? null)
      : null;

  const versions: DetailVersion[] = [];
  for (const v of versionRows) {
    versions.push(await toDetail(v, v.version === selectedRow.version || v.version === compareRow?.version));
  }
  const selected = versions.find((v) => v.version === selectedRow.version)!;
  const compare = compareRow ? versions.find((v) => v.version === compareRow.version)! : null;

  // Scores: the first pass this concept ever had, and the newest pass on
  // or before the version being looked at.
  const ascending = [...versionRows].reverse();
  const allPasses = ascending.flatMap((v) => readPasses(v.review).map((p) => ({ version: v.version, pass: p })));
  const before = allPasses[0]?.pass ?? null;
  const upTo = allPasses.filter((p) => p.version <= selectedRow.version);
  const after = upTo.at(-1)?.pass ?? null;
  // The version that newest pass scored: older than the one looked at when that one was never scored.
  const afterVersion = upTo.at(-1)?.version ?? null;

  // The placeholders still on the page, read from the version's source.
  let placeholders: string[] = [];
  if (selectedRow.htmlKey) {
    const source =
      (await storage.get(selectedRow.htmlKey.replace(/page\.html$/, "source.html"))) ??
      (await storage.get(selectedRow.htmlKey));
    if (source) {
      const found = source.toString("utf8").match(PLACEHOLDER_PATTERN) ?? [];
      placeholders = [
        ...new Set(found.map((p) => p.replace(/^\[PLACEHOLDER:\s*/i, "").replace(/\]$/, "").trim())),
      ];
    }
  }

  const comments = await loadComments(db, conceptId, requests);

  const pending = await pendingChangeRequest(db, conceptId);
  const lastFailure = requests[0]?.status === "failed" ? requests[0].failureReason : null;
  const lastDone = requests[0]?.status === "done" ? requests[0] : null;

  const canAct = can(viewer, "project.edit") && row.projectStatus === "mockups";
  const limit = await getLimitState(db);
  const supplied = row.skillId === HTML_HOMEPAGE_CONCEPT;
  const changesBlocked = !canAct
    ? null
    : supplied
      ? SUPPLIED_NO_CHANGES
      : pending
      ? `v${pending.baseVersion + 1} is being made. Wait for it to finish.`
      : isRunActive(row.runStatus)
        ? "Concepts are still generating."
        : row.status !== "ready"
          ? "This concept is not ready."
          : limit.blocked
            ? blockedMessage(limit)
            : null;

  return {
    projectId,
    clientName: row.clientName,
    inMockups: row.projectStatus === "mockups",
    concept: {
      id: row.id,
      label: row.label,
      directionLabel: directionInfo(row.direction).label,
      // The designer's design and the supplied homepage were built by no skill.
      skillLabel: isGeneratedConcept(row.skillId) ? (skillLabels[row.skillId as SkillId] ?? row.skillId) : "",
      ready: row.status === "ready",
      supplied,
    },
    versions,
    selected,
    latestVersion,
    compare,
    placeholders,
    review: { before, after, afterVersion },
    comments,
    pending: pending
      ? { status: pending.status, detail: pending.detail, nextVersion: pending.baseVersion + 1 }
      : null,
    lastFailure,
    canAct,
    changesBlocked,
    changesEstimate: (await estimateChanges(db)).label,
    lastResult:
      lastDone?.resultVersion && lastDone.detail ? { version: lastDone.resultVersion, detail: lastDone.detail } : null,
  };
}

async function loadComments(
  db: Db,
  conceptId: string,
  requests: { id: string; status: string; baseVersion: number }[],
): Promise<DetailComment[]> {
  const rows = await db
    .select()
    .from(conceptComment)
    .where(eq(conceptComment.conceptId, conceptId))
    .orderBy(asc(conceptComment.createdAt));
  if (rows.length === 0) return [];

  const authorIds = [...new Set(rows.map((r) => r.authorUserId))];
  const people = await db
    .select({ id: userTable.id, name: userTable.name, deletedAt: userTable.deletedAt })
    .from(userTable)
    .where(inArray(userTable.id, authorIds));
  const roles = await db
    .select({ userId: userRole.userId, role: userRole.role })
    .from(userRole)
    .where(inArray(userRole.userId, authorIds));

  const nameOf = (id: string) => {
    const person = people.find((p) => p.id === id);
    if (!person) return "Someone";
    // First names on a team of five, but a deleted person keeps the label.
    return person.deletedAt ? (personLabel(person.name, person.deletedAt) ?? "Someone") : person.name.split(" ")[0]!;
  };
  const rolesOf = (id: string) => roles.filter((r) => r.userId === id).map((r) => r.role as TeamRole);

  const top = rows.filter((r) => !r.parentId);
  return top.map((comment, index) => {
    const request = comment.changeRequestId
      ? requests.find((r) => r.id === comment.changeRequestId)
      : undefined;
    const working = request && (request.status === "queued" || request.status === "working");
    const tag: DetailComment["tag"] = working
      ? { kind: "sending", version: request.baseVersion + 1 }
      : comment.sentInVersion !== null
        ? { kind: "sent", version: comment.sentInVersion }
        : request
          ? { kind: "sending", version: request.baseVersion + 1 }
          : { kind: "not_sent", version: null };
    return {
      id: comment.id,
      number: index + 1,
      version: comment.version,
      author: nameOf(comment.authorUserId),
      roles: rolesOf(comment.authorUserId),
      body: comment.body,
      pinX: comment.pinX,
      pinY: comment.pinY,
      when: formatActivityWhen(comment.createdAt),
      resolved: comment.resolvedAt !== null,
      tag,
      band: comment.band,
      outcome:
        (comment.outcome === "done" || comment.outcome === "not_done") && comment.outcomeVersion !== null
          ? { kind: comment.outcome, version: comment.outcomeVersion, reason: comment.outcomeReason ?? null }
          : null,
      tries: comment.tries,
      canRetry:
        comment.outcome === "not_done" &&
        comment.resolvedAt === null &&
        comment.sentInVersion !== null &&
        comment.tries < MAX_COMMENT_TRIES,
      replies: rows
        .filter((r) => r.parentId === comment.id)
        .map((r) => ({
          id: r.id,
          author: nameOf(r.authorUserId),
          roles: rolesOf(r.authorUserId),
          body: r.body,
          when: formatActivityWhen(r.createdAt),
        })),
    };
  });
}
