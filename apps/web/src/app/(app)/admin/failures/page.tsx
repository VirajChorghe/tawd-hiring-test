import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getDb } from "@tawd/core/db";
import { can } from "@tawd/core/permissions";
import { formatWhen } from "@/lib/labels";
import { FAILURE_LIMIT, listJobFailures } from "@/lib/job-failures";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Failed jobs - TAWD" };
export const dynamic = "force-dynamic";

/*
  Failed jobs (audit F-040, 12 November 2026): the last hundred jobs the
  worker could not finish, with the error's class, message and stack. They
  are written when the job fails, so they survive a redeploy. Read-only;
  admins only (the same permission as System).
*/
export default async function FailedJobsPage() {
  const current = await requireUser();
  if (!can(current, "settings.manage")) redirect("/projects");

  const rows = await listJobFailures(getDb());

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Failed jobs</h1>
          <p className="page-lede">
            The last {FAILURE_LIMIT} jobs the worker could not finish, newest first. Tokens, keys and passwords in the usual forms (key=, token=, password=, a Bearer, Basic or Token header, a password in an address, an address&rsquo;s query string) are removed before they are saved. Admins only.
          </p>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="notice" role="status">No failed jobs recorded.</p>
      ) : (
        <div className="table-card">
          <table className="spend-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Queue and job</th>
                <th>Project</th>
                <th>What failed</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{formatWhen(row.occurredAt)}</td>
                  <td>
                    <strong>{row.jobName}</strong> <span className="hint">{row.queue}{row.jobId ? ` #${row.jobId}` : ""}</span>
                  </td>
                  <td>
                    {row.projectId ? (
                      row.projectName ? <Link href={`/projects/${row.projectId}`}>{row.projectName}</Link> : <span className="hint">Deleted project</span>
                    ) : (
                      <span className="hint">None</span>
                    )}
                  </td>
                  <td>{row.label}</td>
                  <td>
                    <strong>{row.errorClass}</strong>: {row.message}
                    {row.lastAiCallId ? <p className="hint">Last AI call: {row.lastAiCallId}</p> : null}
                    {row.stack ? (
                      <details>
                        <summary className="hint">Stack</summary>
                        <pre className="hint" style={{ whiteSpace: "pre-wrap" }}>{row.stack}</pre>
                      </details>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
