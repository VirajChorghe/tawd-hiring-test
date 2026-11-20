import type { ProjectStatus } from "@tawd/core/enums";

/*
  The stage strip as navigation.

  A stage is one of four things:
  - done: behind the project, or the current stage once its work is finished
    (an intake with every required answer). A link, with a check.
  - current: where the project is and still has work to do. A link.
  - available: the next stage, once the current one is done. A link, so
    "Continue" is never the only way forward.
  - locked: not reached. Not a link; a lock and a tooltip saying what
    unlocks it.

  Intake, Mockups and Content (from 7a: keyword research and the page
  plan) have their own screens. A reached stage
  without one links to the project page, which is where its status lives
  until that phase is built.
*/

export const STAGES = ["intake", "mockups", "content", "build", "qa", "live"] as const;
export type Stage = (typeof STAGES)[number];

export type StageState = "done" | "current" | "available" | "locked";

export interface StageItem {
  stage: Stage;
  state: StageState;
  href: string | null;
  /** Why a locked stage is locked, for the tooltip. */
  lockedReason: string | null;
}

const UNLOCKS: Record<Stage, string> = {
  intake: "",
  mockups: "Unlocks when every required intake item is answered",
  content: "Unlocks after the client approves a concept",
  build: "Unlocks after the client approves the copy",
  qa: "Unlocks after the build",
  live: "Unlocks after QA and the founders' go-ahead",
};

export const NEXT_STAGE: Partial<Record<Stage, Stage>> = {
  intake: "mockups",
  mockups: "content",
  content: "build",
  build: "qa",
  qa: "live",
};

export function stageHref(projectId: string, stage: Stage): string {
  if (stage === "intake") return `/projects/${projectId}/intake`;
  if (stage === "mockups") return `/projects/${projectId}/mockups`;
  if (stage === "content") return `/projects/${projectId}/content`;
  if (stage === "build") return `/projects/${projectId}/build`;
  return `/projects/${projectId}`;
}

/*
  A stage opened before the project reaches it (29 September 2026: a Build
  page answered "Page not found"): the page says why it's locked and what
  to do next, with a link to where the work is. Null when the stage is open.
*/
export function lockedStage(input: { projectId: string; status: ProjectStatus; lane: string; stage: Stage; designOnly?: boolean }): { why: string; next: string; href: string; label: string } | null {
  const { projectId, status, lane, stage } = input;
  // Design only (0.100.0) has no Content step: a project saved at Content is at Build.
  if (input.designOnly && status === "content" && stage === "build") return null;
  const label = (s: Stage) => ({ intake: "Intake", mockups: "Design", content: "Content", build: "Build & preview", qa: "Build & preview", live: "Go live" })[s];
  if (status === "paused") return { why: "This project is paused.", next: "A PM or an admin resumes it on the project page to carry on.", href: `/projects/${projectId}`, label: "Open the project" };
  // Sites built from a design (Lane 2) take their words from the design: there is no Content step.
  if (lane === "lane_2" && stage === "content") {
    return { why: "Sites built from the client's design take their words from the design, so there is no Content step.", next: "Build the site, preview it and record the client's approval on Design.", href: stageHref(projectId, "mockups"), label: "Go to Design" };
  }
  const at = STAGES.indexOf(status);
  const want = STAGES.indexOf(stage);
  if (at < 0 || want <= at) return null;
  const current = STAGES[at]!;
  const why =
    lane === "lane_2" && stage === "build"
      ? "Build unlocks when the client approves the preview of the site built from their design."
      : `${label(stage)} ${UNLOCKS[stage].charAt(0).toLowerCase()}${UNLOCKS[stage].slice(1)}.`;
  const next =
    lane === "lane_2" && stage === "build"
      ? "On Design: build the site, deploy the preview, and record the client's approval."
      : `The project is at ${label(current)}: finish it there first.`;
  return { why, next, href: stageHref(projectId, lane === "lane_2" && current === "content" ? "mockups" : current), label: `Go to ${label(lane === "lane_2" && current === "content" ? "mockups" : current)}` };
}

export function stageStates(input: {
  projectId: string;
  status: ProjectStatus;
  /** Whether the current stage's own work is finished. */
  currentStageDone: boolean;
}): StageItem[] {
  // A paused project has no position in the sequence; only the screens that
  // exist stay open, so the team can still read what is there.
  if (input.status === "paused") {
    return STAGES.map((stage) => {
      const open = stage === "intake" || stage === "mockups";
      return {
        stage,
        state: open ? "done" : "locked",
        href: open ? stageHref(input.projectId, stage) : null,
        lockedReason: open ? null : "This project is paused",
      };
    });
  }

  const at = STAGES.indexOf(input.status);

  return STAGES.map((stage, index) => {
    let state: StageState;
    if (index < at) state = "done";
    else if (index === at) state = input.currentStageDone ? "done" : "current";
    else if (index === at + 1 && input.currentStageDone) state = "available";
    else state = "locked";

    return {
      stage,
      state,
      href: state === "locked" ? null : stageHref(input.projectId, stage),
      lockedReason: state === "locked" ? UNLOCKS[stage] : null,
    };
  });
}
