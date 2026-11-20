import Link from "next/link";

import { Banner } from "@/components/ui/banner";
import type { CompletenessResult } from "@tawd/core/intake";
import { describeFitWarning, describeTierWarning, type FitWarning, type TierWarning } from "@tawd/core/intake";

/*
  The compact version shown on the project page. The full Required info card
  with its jump-to-field buttons lives in the intake workspace.
*/
export function CompletenessSummary({
  completeness,
  href,
}: {
  completeness: CompletenessResult;
  href: string;
}) {
  const { percent, satisfiedCount, totalCount, missing, isComplete } =
    completeness;

  return (
    <div className="card">
      <div className="page-head" style={{ marginBottom: 16 }}>
        <h2 className="card-title">
          {isComplete ? "Intake complete" : "Intake in progress"}
        </h2>
        <span className="hint">
          {satisfiedCount} of {totalCount} required answers
        </span>
      </div>

      <div
        className="progress"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Required intake answers complete"
      >
        <span style={{ width: `${percent}%` }} />
      </div>

      {isComplete ? (
        <p className="hint" style={{ color: "var(--blue-text)", fontWeight: 600 }}>
          Everything required is answered. This project can move on to Mockups.
        </p>
      ) : (
        <p className="hint">
          Still missing: {missing.map((item) => item.label).join(", ")}.{" "}
          <Link href={href}>Open the intake</Link>
        </p>
      )}
    </div>
  );
}

export function TierWarningPanel({ warning }: { warning: TierWarning }) {
  return (
    <Banner title="This project needs the Growth tier">
      {describeTierWarning(warning)}
    </Banner>
  );
}

/* "Better as a custom VML build": the TAWD fit check. A warning, never a block. */
export function FitWarningPanel({ warning }: { warning: FitWarning }) {
  return <Banner title={warning.title}>{describeFitWarning(warning)}</Banner>;
}
