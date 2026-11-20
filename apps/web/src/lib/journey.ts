import { and, desc, eq } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import type { ProjectStatus } from "@tawd/core/enums";
import { designReview, figmaDesign, previewDecision, project, projectIntake, siteBuild } from "@tawd/core/schema";
import { hasCurrentWebsite, parseIntake, projectTypeOf, skipsContentStep, type ProjectType } from "@tawd/core/intake";
import type { Stage } from "./stages";

/*
  The project's steps, as the team sees them (Jason, 29 September 2026).

  The saved stage (project.status) is unchanged; this maps it, the lane and
  a few facts to the steps on screen. One source for the header bar, the
  Projects board and the Next step card.

  Lane 1: Intake, Design, Content, Build & preview, Go live.
  Lane 2: Intake, Client's design, Build & preview, Go live. Lane 2 builds
  and previews on the Design page, so its Build & preview step opens there.
  There is no QA step: its checks belong to Build & preview.
*/

export type StepKey = "intake" | "design" | "content" | "build" | "golive" | "updates";
export type StepState = "done" | "current" | "available" | "locked";

export interface JourneyFacts {
  lane: string;
  status: ProjectStatus;
  /** Every required intake answer is in (only matters at Intake). */
  intakeComplete: boolean;
  /** The client approved the latest preview (Build & preview is done). */
  previewApproved: boolean;
  /** Lane 2: the design is read and, for Option B, reviewed or the review skipped. */
  designReady: boolean;
  /** The project type (0.100.0): Design only has no Content step. */
  projectType?: ProjectType | null;
}

export interface JourneyStep {
  key: StepKey;
  label: string;
  state: StepState;
  /** One or two muted words under the label. */
  note: string;
  href: string | null;
  lockedReason: string | null;
}

const LABELS: Record<StepKey, string> = {
  intake: "Intake",
  design: "Design",
  content: "Content",
  build: "Build & preview",
  golive: "Go live",
  updates: "Updates",
};

export function stepLabel(key: StepKey, lane: string): string {
  return key === "design" && lane === "lane_2" ? "Client's design" : LABELS[key];
}

export function stepKeysFor(lane: string, type: ProjectType | null = null): StepKey[] {
  // Lane 2 takes its words from the design; Design only keeps the current site's words (0.100.0): neither has a Content step.
  return lane === "lane_2" || skipsContentStep(type) ? ["intake", "design", "build", "golive", "updates"] : ["intake", "design", "content", "build", "golive", "updates"];
}

const UNLOCKS: Record<StepKey, string> = {
  intake: "",
  design: "Unlocks when every required intake item is answered",
  content: "Unlocks after the client approves a concept",
  build: "Unlocks after the client approves the copy",
  golive: "Unlocks after the client approves the preview",
  updates: "Unlocks when the site goes live",
};

function unlockReason(key: StepKey, lane: string, type: ProjectType | null = null): string {
  if (key === "build" && skipsContentStep(type)) return "Unlocks after the client approves a concept";
  if (lane !== "lane_2") return UNLOCKS[key];
  if (key === "build") return "Unlocks once the design is read (and, for Option B, reviewed or the review skipped)";
  return UNLOCKS[key];
}

/* Where the project is, as a step. */
export function currentStep(facts: JourneyFacts): StepKey | "paused" {
  const { status, lane } = facts;
  if (status === "paused") return "paused";
  // Live: the site is up and the client's updates are the work (1 October 2026).
  if (status === "live") return "updates";
  if (status === "intake") return "intake";
  if (lane === "lane_2") {
    if (status === "mockups" || status === "content") return facts.designReady ? "build" : "design";
    return "golive";
  }
  if (status === "mockups") return "design";
  // Design only: a project saved at Content (before 0.100.0) is at Build.
  if (status === "content" && !skipsContentStep(facts.projectType ?? null)) return "content";
  return facts.previewApproved ? "golive" : "build";
}

export function stepHref(projectId: string, key: StepKey, lane: string): string {
  if (key === "intake") return `/projects/${projectId}/intake`;
  if (key === "design") return `/projects/${projectId}/mockups`;
  if (key === "content") return `/projects/${projectId}/content`;
  if (key === "build") return lane === "lane_2" ? `/projects/${projectId}/mockups#build` : `/projects/${projectId}/build`;
  if (key === "updates") return `/projects/${projectId}/updates`;
  return `/projects/${projectId}/build?part=golive`;
}

export function journeySteps(projectId: string, facts: JourneyFacts): JourneyStep[] {
  const keys = stepKeysFor(facts.lane, facts.projectType ?? null);
  const at = currentStep(facts);
  const make = (key: StepKey, state: StepState, note: string, reason: string | null = null): JourneyStep => ({
    key,
    label: stepLabel(key, facts.lane),
    state,
    note,
    href: state === "locked" ? null : stepHref(projectId, key, facts.lane),
    lockedReason: state === "locked" ? reason : null,
  });

  if (at === "paused") {
    return keys.map((k) => (k === "intake" || k === "design" ? make(k, "done", "Paused") : make(k, "locked", "", "This project is paused")));
  }

  const index = keys.indexOf(at);
  // The current step's own work is finished: only the intake knows that on its own.
  const currentDone = at === "intake" && facts.intakeComplete;
  return keys.map((key, i) => {
    if (i < index) return make(key, "done", "Done");
    if (i === index) return currentDone ? make(key, "done", "Done") : make(key, "current", "Now");
    if (i === index + 1 && currentDone) return make(key, "available", "Next");
    // Keyword research and the page plan can start while the client picks a concept.
    if (key === "content" && at === "design") return make(key, "available", "Can start early");
    return make(key, "locked", "", unlockReason(key, facts.lane, facts.projectType ?? null));
  });
}

/* Which step a screen belongs to, for the underline. */
export function viewingStep(stage: Stage | "updates" | undefined, facts: JourneyFacts): StepKey | undefined {
  if (!stage) return undefined;
  if (stage === "updates") return "updates";
  if (stage === "intake") return "intake";
  if (stage === "content") return skipsContentStep(facts.projectType ?? null) ? undefined : "content";
  if (stage === "mockups") {
    if (facts.lane !== "lane_2") return "design";
    const at = currentStep(facts);
    return at === "build" ? "build" : "design";
  }
  // The Build page holds Build & preview and Go live.
  return currentStep(facts) === "golive" || currentStep(facts) === "updates" ? "golive" : "build";
}

/* The facts, read from the database: a handful of small queries. */
export async function loadJourneyFacts(db: Database, projectId: string, intakeComplete = false): Promise<JourneyFacts | null> {
  const [row] = await db.select({ lane: project.lane, laneOption: project.laneOption, status: project.status }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!row) return null;
  const [decision] = await db.select({ outcome: previewDecision.outcome }).from(previewDecision).where(eq(previewDecision.projectId, projectId)).orderBy(desc(previewDecision.createdAt)).limit(1);
  let designReady = false;
  if (row.lane === "lane_2") {
    const [figma] = await db.select({ importStatus: figmaDesign.importStatus, skipped: figmaDesign.reviewSkippedAt }).from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
    const read = figma?.importStatus === "done";
    if (read && row.laneOption !== "b") designReady = true;
    else if (read) {
      const [review] = await db.select({ status: designReview.status }).from(designReview).where(eq(designReview.projectId, projectId)).orderBy(desc(designReview.createdAt)).limit(1);
      const [built] = await db.select({ id: siteBuild.id }).from(siteBuild).where(and(eq(siteBuild.projectId, projectId))).limit(1);
      designReady = Boolean(figma?.skipped) || review?.status === "done" || Boolean(built);
    }
  }
  // The project type (0.100.0), from the intake's content choice and current website.
  const [intake] = row.lane === "lane_2" ? [] : await db.select({ data: projectIntake.data }).from(projectIntake).where(eq(projectIntake.projectId, projectId)).limit(1);
  const data = intake ? parseIntake(intake.data) : null;
  return {
    lane: row.lane,
    status: row.status as ProjectStatus,
    intakeComplete,
    previewApproved: decision?.outcome === "approved",
    designReady,
    projectType: data ? projectTypeOf({ lane: row.lane, mode: data.content.mode, hasCurrentWebsite: hasCurrentWebsite(data.website) }) : null,
  };
}
