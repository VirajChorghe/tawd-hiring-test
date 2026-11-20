/*
  Client-safe labels for the mockup screens.

  Re-exported through here so a browser bundle never reaches for
  @tawd/core/mockups directly and picks up something server-side by
  accident. Nothing in this file touches the database or the queue.
*/
export {
  REVIEW_QUESTIONS,
  checkDesignLog,
  assignSkills,
  DESIGNER_CONCEPT,
  HTML_HOMEPAGE_CONCEPT,
  isGeneratedConcept,
  directionIds,
  directionInfo,
  directions,
  formatCost,
  skillLabels,
} from "@tawd/core/mockups";

export const pipelineStepLabels: Record<string, string> = {
  build: "Build",
  checks: "Quality checks",
  review: "Creative Director",
  improve: "Improve",
  final_checks: "Final checks",
};

export const runStatusLabels: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  needs_intake: "Needs intake info",
  checks_failed: "Checks failed",
  needs_pm_review: "Needs PM review",
  review_incomplete: "Review didn't finish",
  failed: "Failed",
  stopped: "Stopped",
};

/* A failed run that spent nothing never got going: "Failed to start", as on Spend. */
export function runStatusLabel(status: string, spent = true): string {
  if (status === "failed" && !spent) return "Failed to start";
  return runStatusLabels[status] ?? status;
}
