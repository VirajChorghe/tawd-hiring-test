import { Badge } from "@/components/ui/badge";
import { formatCost, runStatusLabel } from "@/lib/mockup-labels";

/* Earlier runs of a project, so a run is never silently replaced. */

export interface PastRunRow {
  id: string;
  status: string;
  conceptCount: number;
  model: string;
  createdAt: string;
  cost: number;
  conceptLabels: string[];
}

export function PastRuns({ runs }: { runs: PastRunRow[] }) {
  if (runs.length === 0) return null;

  return (
    <div className="card">
      <h2 className="section-title" style={{ marginBottom: 12 }}>
        Earlier runs
      </h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th>Concepts</th>
              <th>Status</th>
              <th>Model</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td>{run.createdAt}</td>
                <td>
                  {run.conceptCount}
                  {run.conceptLabels.length > 0
                    ? ` (${run.conceptLabels.join(", ")})`
                    : ""}
                </td>
                <td>
                  <Badge
                    kind={
                      run.status === "succeeded"
                        ? "done"
                        : run.status === "failed"
                          ? "missing"
                          : run.status === "needs_intake" ||
                              run.status === "checks_failed" ||
                              run.status === "needs_pm_review" ||
                              run.status === "review_incomplete"
                            ? "warning"
                            : "info"
                    }
                  >
                    {runStatusLabel(run.status, run.cost > 0)}
                  </Badge>
                </td>
                <td>{run.model}</td>
                <td>{run.cost > 0 ? formatCost(run.cost) : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
