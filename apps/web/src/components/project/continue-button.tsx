"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { moveToMockupsAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  "Continue to Design".

  While the project is still in Intake, continuing is a real step: it moves
  the project through the gate (which the server checks again) and then
  opens Mockups. Once it has moved, the same button is just a link.
*/

function Arrow() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  );
}

export function ContinueToMockups({
  projectId,
  stillInIntake,
  canMove,
  fullWidth = false,
  withArrow = true,
}: {
  projectId: string;
  stillInIntake: boolean;
  /** Whether this person may move the project on. */
  canMove: boolean;
  fullWidth?: boolean;
  withArrow?: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [moving, startMoving] = useTransition();
  const style = fullWidth ? { width: "100%" } : undefined;

  if (!stillInIntake) {
    return (
      <Link
        href={`/projects/${projectId}/mockups`}
        className="btn btn-primary"
        style={style}
      >
        Continue to Design
        {withArrow ? <Arrow /> : null}
      </Link>
    );
  }

  if (!canMove) return null;

  return (
    <>
      <Button
        variant="primary"
        disabled={moving}
        style={style}
        onClick={() => {
          setError(null);
          startMoving(async () => {
            const result = await moveToMockupsAction(projectId);
            if (!result.ok) {
              setError(result.message);
              return;
            }
            router.push(`/projects/${projectId}/mockups`);
            router.refresh();
          });
        }}
      >
        {moving ? "Moving..." : "Continue to Design"}
        {withArrow && !moving ? <Arrow /> : null}
      </Button>
      {error ? <p className="hint-error">{error}</p> : null}
    </>
  );
}
