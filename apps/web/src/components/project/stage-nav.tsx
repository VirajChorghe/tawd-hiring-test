import Link from "next/link";

import { currentStep, journeySteps, viewingStep, type JourneyFacts } from "@/lib/journey";
import type { Stage } from "@/lib/stages";

/*
  The project's steps, as navigation: lane-aware, no QA (29 September
  2026). See lib/journey.ts for which step is in which state. The stage whose screen you are on is underlined.
*/

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export function StageNav({
  projectId,
  facts,
  viewing,
}: {
  projectId: string;
  facts: JourneyFacts;
  /** The stage whose screen this is, if any. Defaults to where the project is. */
  viewing?: Stage | "updates";
}) {
  const items = journeySteps(projectId, facts);
  const at = currentStep(facts);
  const active = viewing ? viewingStep(viewing, facts) : at === "paused" ? undefined : at;

  return (
    <nav className="stage-nav" aria-label="Project steps">
      {items.map((item, index) => {
        const isViewing = item.key === active;

        if (!item.href) {
          return (
            <span
              key={item.key}
              className="stage-link is-locked"
              title={item.lockedReason ?? undefined}
              aria-disabled="true"
            >
              <LockIcon />
              <span className="stage-text">
                {item.label}
              </span>
              <span className="visually-hidden">
                , locked. {item.lockedReason}
              </span>
            </span>
          );
        }

        return (
          <Link
            key={item.key}
            href={item.href}
            className={[
              "stage-link",
              `is-${item.state}`,
              isViewing ? "is-viewing" : null,
            ]
              .filter(Boolean)
              .join(" ")}
            aria-current={isViewing ? "page" : undefined}
          >
            <span className="stage-marker" aria-hidden="true">
              {item.state === "done" ? <CheckIcon /> : index + 1}
            </span>
            <span className="stage-text">
              {item.label}
              <span className="stage-note">{item.note}</span>
            </span>
            {item.state === "done" ? (
              <span className="visually-hidden">, done</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
