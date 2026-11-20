"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { initialsOf } from "@/components/project/team-line";
import type { ProjectStatus, TeamRole, Trade } from "@tawd/core/enums";
import { roleLabels, statusLabels, tradeLabels } from "@/lib/labels";
import type { Attention } from "@/lib/project-overview";

/*
  The Projects list. A handful of projects for a team of five, so filtering
  and sorting happen here in the browser, instantly, with no round trip.
*/

export interface BoardProject {
  id: string;
  name: string;
  trade: Trade;
  tradeLabel: string;
  tierLabel: string;
  status: ProjectStatus;
  /** The lane's steps, in order: done, current, available or locked. */
  steps: string[];
  /** Where the project is, as a step ("Build & preview", "Go live", "Live"). */
  stepName: string;
  members: { id: string; name: string; roles: TeamRole[] }[];
  attention: Attention;
  lastActivity: { text: string; when: string } | null;
  lastActivityAt: number;
}

/* The saved stages, in order. QA is no step any more (29 September 2026): a project there counts as Build. */
const STAGES: ProjectStatus[] = ["intake", "mockups", "content", "build", "live", "paused"];
const TILE_LABELS: Partial<Record<ProjectStatus, string>> = { build: "Build & go live" };
const tileOf = (status: ProjectStatus): ProjectStatus => (status === "qa" ? "build" : status);
type StageFilter = "all" | ProjectStatus;
type Sort = "activity" | "name" | "stage";

export function ProjectsBoard({
  projects,
  currentUserId,
  canCreate,
  initial,
}: {
  projects: BoardProject[];
  currentUserId: string;
  canCreate: boolean;
  initial?: { stage: string; q: string; trade: string; mine: boolean };
}) {
  const [stage, setStage] = useState<StageFilter>(
    (STAGES as string[]).includes(initial?.stage ?? "") ? (initial!.stage as ProjectStatus) : "all",
  );
  const [query, setQuery] = useState(initial?.q ?? "");
  const [trade, setTrade] = useState<"" | Trade>(
    projects.some((p) => p.trade === initial?.trade) ? (initial!.trade as Trade) : "",
  );
  const [mine, setMine] = useState(initial?.mine ?? false);
  const [sort, setSort] = useState<Sort>("activity");

  const counts = Object.fromEntries(
    STAGES.map((s) => [s, projects.filter((p) => tileOf(p.status) === s).length]),
  ) as Record<ProjectStatus, number>;

  const trades = [...new Set(projects.map((p) => p.trade))].sort((a, b) =>
    tradeLabels[a].localeCompare(tradeLabels[b]),
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = projects.filter(
      (p) =>
        (stage === "all" || tileOf(p.status) === stage) &&
        (!trade || p.trade === trade) &&
        (!mine || p.members.some((m) => m.id === currentUserId)) &&
        (!q || p.name.toLowerCase().includes(q)),
    );
    return [...list].sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : sort === "stage"
          ? stageIndex(b.status) - stageIndex(a.status) || a.name.localeCompare(b.name)
          : b.lastActivityAt - a.lastActivityAt,
    );
  }, [projects, stage, trade, mine, query, sort, currentUserId]);

  const filtered = stage !== "all" || trade !== "" || mine || query.trim() !== "";

  return (
    <>
      <div className="page-head projects-head">
        <div>
          <h1 className="page-title">Projects</h1>
          <p className="page-lede">Every website in progress, and where each one stands.</p>
        </div>
        {canCreate && projects.length > 0 ? (
          <Link href="/projects/new" className="btn btn-primary">
            <PlusIcon />
            New project
          </Link>
        ) : null}
      </div>

      {projects.length === 0 ? (
        // Nothing to filter yet: one line and the main action.
        <div className="card empty-state">
          <p className="card-title">No projects yet</p>
          <p className="hint">
            {canCreate
              ? "Create the first one and its intake opens straight away."
              : "A PM or admin creates projects. They will show up here."}
          </p>
          {canCreate ? (
            <Link href="/projects/new" className="btn btn-primary">
              <PlusIcon />
              New project
            </Link>
          ) : null}
        </div>
      ) : (
        <>
          <div className="stage-tiles" role="group" aria-label="Filter by stage">
            <StageTile label="All projects" count={projects.length} active={stage === "all"} onClick={() => setStage("all")} />
            {STAGES.filter((s) => s !== "paused" || counts.paused > 0).map((s) => (
              <StageTile
                key={s}
                label={TILE_LABELS[s] ?? statusLabels[s]}
                count={counts[s]}
                active={stage === s}
                onClick={() => setStage(s)}
              />
            ))}
          </div>

          <div className="projects-toolbar">
            <label className="search-field projects-search">
              <span className="visually-hidden">Search projects</span>
              <SearchIcon />
              <input
                type="search"
                className="input"
                placeholder="Search by business name"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>

            <label className="visually-hidden" htmlFor="projects-trade">
              Trade
            </label>
            <select
              id="projects-trade"
              className="select projects-trade"
              value={trade}
              onChange={(e) => setTrade(e.target.value as "" | Trade)}
            >
              <option value="">All trades</option>
              {trades.map((t) => (
                <option key={t} value={t}>
                  {tradeLabels[t]}
                </option>
              ))}
            </select>

            <label className="check-label projects-mine">
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
              Assigned to me
            </label>

            <div className="projects-sort">
              <label htmlFor="projects-sort">Sort</label>
              <select
                id="projects-sort"
                className="select"
                value={sort}
                onChange={(e) => setSort(e.target.value as Sort)}
              >
                <option value="activity">Last activity</option>
                <option value="name">Name</option>
                <option value="stage">Stage</option>
              </select>
            </div>
          </div>

          <div className="projects-table" role="table" aria-label="Projects">
            <div className="projects-row projects-row-head" role="row">
              <div role="columnheader">Project</div>
              <div role="columnheader">Stage</div>
              <div role="columnheader">Needs attention</div>
              <div role="columnheader">Team</div>
              <div role="columnheader">Last activity</div>
              <div role="columnheader">
                <span className="visually-hidden">Open</span>
              </div>
            </div>

            {shown.length === 0 ? (
              <div className="projects-none" role="row">
                <div role="cell">
                  <p className="card-title">No projects match</p>
                  <p className="hint">
                    Nothing fits these filters.{" "}
                    {filtered ? (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => {
                          setStage("all");
                          setTrade("");
                          setMine(false);
                          setQuery("");
                        }}
                      >
                        Clear filters
                      </button>
                    ) : null}
                  </p>
                </div>
              </div>
            ) : (
              shown.map((p) => <ProjectRow key={p.id} project={p} />)
            )}
          </div>
        </>
      )}
    </>
  );
}

function stageIndex(status: ProjectStatus): number {
  const i = STAGES.indexOf(tileOf(status));
  return i === -1 ? -1 : i;
}

function StageTile({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="stage-tile" aria-pressed={active} onClick={onClick}>
      <span className="stage-tile-label">{label}</span>
      <span className={count === 0 ? "stage-tile-count is-zero" : "stage-tile-count"}>{count}</span>
    </button>
  );
}

function ProjectRow({ project: p }: { project: BoardProject }) {
  return (
    <Link href={`/projects/${p.id}`} className="projects-row" role="row">
      <div role="cell">
        <div className="projects-name">{p.name}</div>
        <div className="projects-chips">
          <span className="meta-chip meta-chip-small">{p.tradeLabel}</span>
          <span className="meta-chip meta-chip-small">{p.tierLabel}</span>
        </div>
      </div>

      <div role="cell">
        <div className="stage-bar" aria-hidden="true">
          {p.steps.map((state, i) => (
            <span
              key={i}
              className={state === "done" ? "is-done" : state === "current" ? "is-current" : undefined}
            />
          ))}
        </div>
        <span className="projects-stage">{p.stepName}</span>
      </div>

      <div role="cell">
        {p.attention.tone === "none" ? (
          <span className="hint" aria-label="Nothing needs attention">
            -
          </span>
        ) : (
          <span className={`attention is-${p.attention.tone}`}>
            <span className="attention-dot" aria-hidden="true" />
            {p.attention.text}
          </span>
        )}
      </div>

      <div role="cell">
        {p.members.length === 0 ? (
          <span className="hint">Nobody yet</span>
        ) : (
          <div className="avatar-stack">
            {p.members.map((m) => (
              <span
                key={m.id}
                className="avatar avatar-row"
                title={`${m.name}${m.roles.length ? ` (${m.roles.map((r) => roleLabels[r]).join(", ")})` : ""}`}
              >
                {initialsOf(m.name)}
              </span>
            ))}
          </div>
        )}
      </div>

      <div role="cell">
        {p.lastActivity ? (
          <>
            <div className="projects-activity">{p.lastActivity.text}</div>
            <div className="projects-when">{p.lastActivity.when}</div>
          </>
        ) : (
          <span className="hint">No activity yet</span>
        )}
      </div>

      <div role="cell" className="projects-chevron" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </div>
    </Link>
  );
}

function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}
