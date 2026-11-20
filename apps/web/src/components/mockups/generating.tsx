"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { stopRunAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { directionInfo, pipelineStepLabels, skillLabels } from "@/lib/mockup-labels";
import type { DirectionId, SkillId } from "@tawd/core/mockups";

/*
  Mockups 2: generating. DESIGN.md, Mockup engine screens.

  One row per concept, one column per step, each cell Done, Working or
  Waiting with a short note from the worker. The page refreshes itself
  every few seconds while the run is working.
*/

export interface ProgressConcept {
  id: string;
  label: string;
  direction: DirectionId;
  skillId: SkillId;
  status: string;
  failureReason: string | null;
  steps: { step: string; status: string; detail: string | null }[];
}

export interface ProgressRun {
  id: string;
  status: string;
  conceptCount: number;
  concepts: ProgressConcept[];
  stepsDone: number;
  stepsTotal: number;
  /** "Started 12 minutes ago by Jason." */
  startedLine: string;
  /** Only the review is running (Run the review again), not a build. */
  reviewOnly?: boolean;
}

const STEP_ORDER = ["build", "checks", "review", "improve", "final_checks"];

/*
  What each step's state is called (Jason, 9 November 2026: "Failed" in red
  reads like a crash to anyone glancing at the screen, and a step that
  stopped is not an error — a concept held under 4.5 is a normal outcome).
  "Didn't finish" is the word the concepts screen already uses for the same
  state, and the colour follows DESIGN.md's status rule: blue for done,
  amber for anything needing attention, grey otherwise. No red.
*/
const STATUS_WORD: Record<string, string> = {
  waiting: "Waiting",
  working: "Working",
  done: "Done",
  failed: "Didn't finish",
  /*
    A step that finished and found fixes outstanding (10 November 2026).
    It used to be written as "failed", so this column said "Didn't finish"
    about a page that was finished, built and reviewed.
  */
  needs_fixes: "Checks to fix",
  not_run: "Not run",
  skipped: "Skipped",
};

export function GeneratingRun({
  run,
  projectId,
  canStop,
}: {
  run: ProgressRun;
  projectId: string;
  canStop: boolean;
}) {
  const router = useRouter();
  const [stopping, startStopping] = useTransition();
  const [error, setError] = useState<string | null>(null);

  /*
    Polling rather than a live connection. A run takes minutes, the table
    changes every half minute or so, and the team is usually somewhere else
    entirely. A WebSocket would be a lot of machinery for that.
  */
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(timer);
  }, [router]);

  const percent = run.stepsTotal === 0 ? 0 : Math.round((run.stepsDone / run.stepsTotal) * 100);
  const plural = run.conceptCount === 1 ? "" : "s";

  return (
    <div className="card generating">
      <div className="generating-head">
        <div>
          <h2 className="setup-title">
            {run.reviewOnly ? "Running the review again" : `Generating ${run.conceptCount} concept${plural}`}
          </h2>
          <p className="page-lede">
            {run.startedLine} You can leave this page; everyone assigned sees it on the project.
          </p>
          {error ? <p className="hint-error">{error}</p> : null}
        </div>
        {canStop ? (
          <Button
            variant="secondary"
            disabled={stopping}
            onClick={() =>
              startStopping(async () => {
                setError(null);
                const result = await stopRunAction(projectId, run.id);
                if (!result.ok) setError(result.message);
                router.refresh();
              })
            }
          >
            {stopping ? "Stopping..." : "Stop"}
          </Button>
        ) : null}
      </div>

      <div className="generating-overall">
        <span className="field-label">
          <span>Overall</span>
        </span>
        <span className="generating-count">
          {run.stepsDone} of {run.stepsTotal} steps
        </span>
      </div>
      <div
        className="progress generating-bar"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Generation progress"
      >
        <span style={{ width: `${percent}%` }} />
      </div>

      <div className="table-card generating-table">
        <table>
          <thead>
            <tr>
              <th>Concept</th>
              {STEP_ORDER.map((step, index) => (
                <th key={step}>
                  {index + 1} {pipelineStepLabels[step] ?? step}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {run.concepts.map((concept) => (
              <tr key={concept.id}>
                <td>
                  <strong>Concept {concept.label}</strong>
                  <div className="hint">
                    {directionInfo(concept.direction).label}, {skillLabels[concept.skillId]}
                  </div>
                  {concept.failureReason ? (
                    <div className="hint-error">{concept.failureReason}</div>
                  ) : null}
                </td>
                {STEP_ORDER.map((name) => {
                  const step = concept.steps.find((s) => s.step === name);
                  const status = step?.status ?? "waiting";
                  return (
                    <td key={name}>
                      <span className={`step-state is-${status}`}>
                        <span className="step-dot" aria-hidden="true" />
                        {STATUS_WORD[status] ?? status}
                      </span>
                      {step?.detail ? <div className="step-note">{step.detail}</div> : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="info-note">
        <InfoIcon />
        Concepts render one at a time to protect the server. If a step fails twice, TAWD stops that
        concept and tells you why; the other concepts carry on.
      </p>
    </div>
  );
}

function InfoIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-5M12 8h.01" />
    </svg>
  );
}
