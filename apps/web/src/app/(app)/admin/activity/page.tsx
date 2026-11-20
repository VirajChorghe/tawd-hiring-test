import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getDb } from "@tawd/core/db";
import { SYSTEM_ACTOR_ID, checkActivityChainSince } from "@tawd/core/activity";
import {
  actionGroupLabels,
  actionLabels,
  describeAction,
  formatWhen,
} from "@/lib/labels";
import { can } from "@tawd/core/permissions";
import {
  listActivityFilterOptions,
  listFullActivityLog,
  type ActivityFilters,
} from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Activity - TAWD" };
export const dynamic = "force-dynamic";

const LIMIT = 200;

/*
  The filters are a plain GET form, so a filtered view is a URL: it can be
  bookmarked, shared with a colleague, and works with JavaScript off.
*/
function pick(value: string | string[] | undefined): string | undefined {
  const one = Array.isArray(value) ? value[0] : value;
  return one && one.trim() ? one.trim() : undefined;
}

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const current = await requireUser();
  if (!can(current, "activity.view_all")) redirect("/projects");

  const params = await searchParams;
  const q = pick(params.q);
  const filters: ActivityFilters = {
    actorUserId: pick(params.person),
    action: pick(params.action),
    projectId: pick(params.project),
    from: pick(params.from),
    to: pick(params.to),
    q,
    // So "signed in" finds login entries, not only the word "login".
    actionsMatchingQ: q
      ? Object.entries(actionLabels)
          .filter(([, label]) => label.toLowerCase().includes(q.toLowerCase()))
          .map(([key]) => key)
      : undefined,
  };
  const filtered = Boolean(
    filters.actorUserId ||
      filters.action ||
      filters.projectId ||
      filters.from ||
      filters.to ||
      filters.q,
  );

  const db = getDb();
  const [entries, chain, options] = await Promise.all([
    listFullActivityLog(db, current, LIMIT, filters),
    // Only what was added since the last check; the whole log is checked again daily by the worker.
    checkActivityChainSince(db),
    listActivityFilterOptions(db, current),
  ]);

  const groups = Object.entries(actionGroupLabels);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Activity log</h1>
          <p className="page-lede">
            Everything anyone did in TAWD, in order. Nobody can edit or delete
            it. Admins only.
          </p>
        </div>
      </div>

      <p className={chain.valid ? "notice" : "error"} role="status">
        {chain.valid
          ? chain.full
            ? `Verified: nothing has been altered. Last full check on ${formatWhen(new Date(chain.full.at))}, all ${chain.full.entries} entries; the newer ones are checked on every visit.`
            : `All ${chain.entriesChecked} entries verified. Nothing has been altered.`
          : `Entries do not verify from number ${chain.brokenAtSeq} onwards: ${chain.reason}. Tell someone.`}
      </p>

      <form method="get" className="card activity-filters" role="search">
        <div className="field activity-search">
          <label className="field-label" htmlFor="activity-q">
            <span>Search</span>
          </label>
          <input
            id="activity-q"
            name="q"
            type="search"
            className="input"
            defaultValue={filters.q ?? ""}
            placeholder="A name, a project, an action, or any recorded value"
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="activity-person">
            <span>Person</span>
          </label>
          <select
            id="activity-person"
            name="person"
            className="select"
            defaultValue={filters.actorUserId ?? ""}
          >
            <option value="">Anyone</option>
            <option value={SYSTEM_ACTOR_ID}>System (no one signed in)</option>
            {options.people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="activity-action">
            <span>Action</span>
          </label>
          <select
            id="activity-action"
            name="action"
            className="select"
            defaultValue={filters.action ?? ""}
          >
            <option value="">Any action</option>
            {groups.map(([group, groupLabel]) => (
              <optgroup key={group} label={groupLabel}>
                <option value={group}>All {groupLabel.toLowerCase()}</option>
                {Object.entries(actionLabels)
                  .filter(([key]) => key.startsWith(`${group}.`))
                  .map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="activity-project">
            <span>Project</span>
          </label>
          <select
            id="activity-project"
            name="project"
            className="select"
            defaultValue={filters.projectId ?? ""}
          >
            <option value="">Any project</option>
            {options.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="activity-from">
            <span>From</span>
          </label>
          <input
            id="activity-from"
            name="from"
            type="date"
            className="input"
            defaultValue={filters.from ?? ""}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="activity-to">
            <span>To</span>
          </label>
          <input
            id="activity-to"
            name="to"
            type="date"
            className="input"
            defaultValue={filters.to ?? ""}
          />
        </div>

        <div className="activity-filter-actions">
          <button type="submit" className="btn btn-primary">
            Apply filters
          </button>
          {filtered ? (
            <Link href="/admin/activity" className="btn btn-text">
              Clear
            </Link>
          ) : null}
        </div>
      </form>

      <p className="hint activity-count">
        {entries.length === LIMIT
          ? `Showing the most recent ${LIMIT} matching entries; narrow the filters to see older ones.`
          : `${entries.length} ${entries.length === 1 ? "entry" : "entries"}${filtered ? " match" : ""}.`}{" "}
        Dates are Pacific time.
      </p>

      {entries.length === 0 ? (
        <div className="card empty-state">
          <p className="card-title">No entries match</p>
          <p className="hint">Nothing in the log fits these filters.</p>
          <Link href="/admin/activity" className="btn btn-secondary">
            Clear filters
          </Link>
        </div>
      ) : (
        <div className="table-card">
          <table className="team-table activity-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What</th>
                <th>Record</th>
                <th>From</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.seq}>
                  <td className="activity-when">{formatWhen(entry.occurredAt)}</td>
                  <td>
                    {entry.actorName ??
                      (entry.actorEmail?.startsWith("system")
                        ? "TAWD"
                        : (entry.actorEmail ?? "TAWD"))}
                  </td>
                  <td>
                    <strong>{describeAction(entry.action)}</strong>
                  </td>
                  <td>
                    {entry.projectName && entry.entityId ? (
                      <Link href={`/projects/${entry.entityId}`}>
                        {entry.projectName}
                      </Link>
                    ) : entry.deletedProjectName ? (
                      <span>
                        <span className="hint">(deleted project)</span>{" "}
                        {entry.deletedProjectName}
                      </span>
                    ) : entry.userName ? (
                      <span>{entry.userName}</span>
                    ) : entry.entityType === "session" ? (
                      <span className="hint">Sign-in</span>
                    ) : entry.entityType === "setting" ? (
                      <span className="hint">Settings</span>
                    ) : (
                      <span className="hint">-</span>
                    )}
                  </td>
                  <td>{entry.ipAddress ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
