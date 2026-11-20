import Link from "next/link";

import { ButtonLink } from "@/components/ui/button";
import type { ProjectNextView } from "@/lib/next-step";
import { initialsOf } from "./team-line";

/*
  The project page's Next step card and "Where things stand" (29 September
  2026, DESIGN.md "The project's steps and the Next step card"): what
  happens next, whose job it is, and one button to where the work is done.
*/

export function NextStepCard({ view, actions, extraLine }: { view: ProjectNextView; actions?: React.ReactNode; extraLine?: string | null }) {
  const { next } = view;
  return (
    <section className="card next-step" aria-labelledby="next-step-title">
      <div className="next-step-body">
        <p className="next-step-label">Next step</p>
        <h2 id="next-step-title" className="next-step-title">
          {next.title}
        </h2>
        <p className="next-step-line">{next.line}</p>
        {extraLine ? <p className="next-step-line">{extraLine}</p> : null}
        <p className="next-step-who">
          <span className="next-step-who-label">{next.who.label}:</span>
          {next.who.people.map((p) => (
            <span key={p.id} className="team-member">
              <span className="avatar avatar-small" aria-hidden="true">
                {initialsOf(p.name)}
              </span>
              {p.name}
            </span>
          ))}
          {next.who.text ? <span>{next.who.text}</span> : null}
        </p>
      </div>
      {actions ? <div className="next-step-actions">{actions}</div> : null}
      {!actions && (next.action || next.secondary) ? (
        <div className="next-step-actions">
          {next.action ? (
            <ButtonLink href={next.action.href} variant="primary">
              {next.action.label}
            </ButtonLink>
          ) : null}
          {next.secondary ? (
            <ButtonLink href={next.secondary.href} variant="secondary">
              {next.secondary.label}
            </ButtonLink>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function StandingCard({ view }: { view: ProjectNextView }) {
  return (
    <section className="card">
      <h2 className="card-title" style={{ marginBottom: 8 }}>
        Where things stand
      </h2>
      <ul className="standing-list">
        {view.standing.map((row) => (
          <li key={row.key} className="standing-row">
            <span className="standing-step">{row.label}</span>
            <span className={`standing-state is-${row.tone}`}>{row.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* Overview, Settings, History: links, so each tab has its own address. */
export function ProjectTabs({ projectId, tab }: { projectId: string; tab: "overview" | "settings" | "history" }) {
  const tabs = [
    { key: "overview", label: "Overview", href: `/projects/${projectId}` },
    { key: "settings", label: "Settings", href: `/projects/${projectId}?tab=settings` },
    { key: "history", label: "History", href: `/projects/${projectId}?tab=history` },
  ] as const;
  return (
    <nav className="project-tabs" aria-label="Project page">
      {tabs.map((t) => (
        <Link key={t.key} href={t.href} className={t.key === tab ? "project-tab is-active" : "project-tab"} aria-current={t.key === tab ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
