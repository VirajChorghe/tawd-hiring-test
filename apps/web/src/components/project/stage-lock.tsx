import Link from "next/link";

import { lockedStage, type Stage } from "@/lib/stages";

/* A stage the project hasn't reached: why it's locked and what to do next (never "Page not found"). */
export function StageLock({ projectId, status, lane, stage, designOnly }: { projectId: string; status: string; lane: string; stage: Stage; designOnly?: boolean }) {
  const lock = lockedStage({ projectId, status: status as never, lane, stage, designOnly });
  if (!lock) return null;
  return (
    <div className="card stage-lock" role="status">
      <h2 className="card-title">Not yet: this stage is locked</h2>
      <p>{lock.why}</p>
      <p className="hint">{lock.next}</p>
      <Link className="btn btn-primary btn-small" href={lock.href}>
        {lock.label}
      </Link>
    </div>
  );
}
