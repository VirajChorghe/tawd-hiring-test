"use client";

import type { JourneyFacts } from "@/lib/journey";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { moveToMockupsAction } from "@/app/actions";
import { ContinueToMockups } from "@/components/project/continue-button";
import { ProjectHeading } from "@/components/project/heading";
import { NextStepBar } from "@/components/project/next-step-bar";
import type { NextStep } from "@/lib/next-step";
import { Button } from "@/components/ui/button";
import type { ProjectStatus, TeamRole } from "@tawd/core/enums";
import type { Requirement } from "@tawd/core/intake";

/*
  The project header on the intake screen, and the gate that lives in it.
  Since 30 September 2026 the gate's button sits in the next-step bar at
  the bottom of the page (DESIGN.md "The next-step bar").

  While anything required is missing, the one primary action is the gated
  "Move to Design": disabled, with the reason written underneath rather
  than hidden in a tooltip. Missing items never block: "Move to Design"
  asks to continue without them, and says what is missing.
  Once everything is answered it becomes "Continue to Design".

  Nothing here decides anything: the server re-checks the gate, and refuses
  if this page is out of date or the person is not an admin after all.
*/

export interface ProjectHeaderProps {
  projectId: string;
  clientName: string;
  chips: string[];
  members: { id: string; name: string; roles: TeamRole[] }[];
  canEditTeam: boolean;
  status: ProjectStatus;
  /** The step bar's facts (lib/journey.ts). */
  journey: JourneyFacts;
  missing: Requirement[];
  totalRequired: number;
  canMove: boolean;
  canOverride: boolean;
  slackWarning?: string | null;
  /** The project's Next step, for the bar (lib/next-step.ts). */
  next?: NextStep | null;
}

export function ProjectHeader(props: ProjectHeaderProps) {
  const router = useRouter();
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isMoving, startMoving] = useTransition();

  const blocked = props.missing.length > 0;
  // The one item "Continue without these" can't skip (the current website, 30 September 2026).
  const hardStop = props.missing.some((m) => m.blocking);
  const inIntake = props.status === "intake";

  const move = (note?: string) => {
    setError(null);
    startMoving(async () => {
      const result = await moveToMockupsAction(props.projectId, {
        continueWithoutMissing: true,
        note: note ?? null,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOverrideOpen(false);
      router.push(`/projects/${props.projectId}/mockups`);
      router.refresh();
    });
  };

  let actions: React.ReactNode = null;

  if (inIntake && blocked) {
    // A warning, not a wall: the missing items become placeholders.
    actions = (
      <>
        {error ? (
          <p className="hint-error">{error}</p>
        ) : hardStop ? (
          <p className="hint-missing">Add the current website, or tick No current website: it decides where the mockup&rsquo;s words come from.</p>
        ) : (
          <p className="hint-missing">
            {props.missing.length} required {props.missing.length === 1 ? "item" : "items"} missing.
            You can continue; {props.missing.length === 1 ? "it shows" : "they show"} as placeholders.
          </p>
        )}
        {props.canMove ? (
          <Button variant="primary" disabled={hardStop} onClick={() => setOverrideOpen(true)}>
            Move to Design
          </Button>
        ) : null}
      </>
    );
  } else if (inIntake) {
    actions = (
      <>
        <p className="hint">
          Intake complete. All {props.totalRequired} required items answered.
        </p>
        <ContinueToMockups
          projectId={props.projectId}
          stillInIntake
          canMove={props.canMove}
        />
      </>
    );
  }

  return (
    <>
      <ProjectHeading
        slackWarning={props.slackWarning}
        projectId={props.projectId}
        clientName={props.clientName}
        chips={props.chips}
        members={props.members}
        canEditTeam={props.canEditTeam}
        journey={{ ...props.journey, intakeComplete: inIntake && !blocked }}
        viewing="intake"
      />

      <NextStepBar next={props.next ?? null} here={`/projects/${props.projectId}/intake`} actions={actions} />

      {overrideOpen ? (
        <OverrideDialog
          clientName={props.clientName}
          missing={props.missing}
          busy={isMoving}
          error={error}
          onCancel={() => {
            setOverrideOpen(false);
            setError(null);
          }}
          onConfirm={move}
        />
      ) : null}
    </>
  );
}

export function OverrideDialog({
  clientName,
  missing,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  clientName: string;
  missing: Requirement[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState("");

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="override-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="override-title" className="section-title">
          Continue without these?
        </h2>
        <p className="hint">
          {clientName} moves to Mockups with {missing.length} required{" "}
          {missing.length === 1 ? "item" : "items"} missing. Each concept shows{" "}
          {missing.length === 1 ? "it" : "them"} as a highlighted placeholder, and you can fill the
          intake in later.
        </p>

        <ul className="override-missing">
          {missing.map((item) => (
            <li key={item.key}>{item.label}</li>
          ))}
        </ul>

        <div className="field">
          <label className="field-label" htmlFor="override-reason">
            <span>Note</span>
            <span className="field-optional">Optional</span>
          </label>
          <textarea
            id="override-reason"
            className="textarea"
            value={note}
            placeholder="For example: the client is sending the license number tomorrow."
            onChange={(event) => setNote(event.target.value)}
          />
          <p className="hint">
            Recorded in the activity log with your name, the time and the missing items.
          </p>
        </div>

        {error ? <p className="hint-error">{error}</p> : null}

        <div className="modal-actions">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => onConfirm(note)} autoFocus>
            {busy ? "Moving..." : "Continue without these"}
          </Button>
        </div>
      </div>
    </div>
  );
}
