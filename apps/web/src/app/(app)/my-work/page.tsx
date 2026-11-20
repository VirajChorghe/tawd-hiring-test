import type { Metadata } from "next";
import Link from "next/link";

import { getDb } from "@tawd/core/db";
import { ButtonLink } from "@/components/ui/button";
import { tierLabels, tradeLabels } from "@/lib/labels";
import { loadMyWork } from "@/lib/my-work";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "My work - TAWD" };
export const dynamic = "force-dynamic";

/* What's waiting on you, across every project (29 September 2026). */
export default async function MyWorkPage() {
  const current = await requireUser();
  const view = await loadMyWork(getDb(), current, {
    trade: (t) => tradeLabels[t as keyof typeof tradeLabels] ?? t,
    tier: (t) => tierLabels[t as keyof typeof tierLabels]?.split(" (")[0] ?? t,
  });

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">My work</h1>
          <p className="page-lede">What&rsquo;s waiting on you, across every project.</p>
        </div>
      </div>

      <div className="stack">
        {view.mine.length === 0 ? (
          <div className="card empty-state">
            <p className="card-title">Nothing is waiting on you right now.</p>
            <p className="hint">
              Every project and where it stands is on <Link href="/projects">Projects</Link>.
            </p>
          </div>
        ) : (
          <section className="card my-work-card" aria-labelledby="mine-title">
            <h2 id="mine-title" className="card-title">
              Waiting on you ({view.mine.length})
            </h2>
            <table className="my-work-table">
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col">Next step</th>
                  <th scope="col">Step</th>
                  <th scope="col">Last activity</th>
                  <th scope="col">
                    <span className="visually-hidden">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.mine.map((row) => (
                  <tr key={row.projectId}>
                    <td>
                      <div className="projects-name">{row.name}</div>
                      <div className="projects-chips">
                        <span className="meta-chip meta-chip-small">{row.tradeLabel}</span>
                        <span className="meta-chip meta-chip-small">{row.tierLabel}</span>
                      </div>
                    </td>
                    <td>
                      <div className="my-work-next">{row.next.title}</div>
                      <div className="hint">{row.next.line}</div>
                    </td>
                    <td>{row.step}</td>
                    <td className="hint">{row.lastActivity ? `${row.lastActivity.text}, ${row.lastActivity.when}` : "-"}</td>
                    <td>
                      <ButtonLink href={row.next.action?.href ?? `/projects/${row.projectId}`} variant="primary" small>
                        Open
                      </ButtonLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {view.others.length > 0 ? (
          <section className="card" aria-labelledby="others-title">
            <h2 id="others-title" className="card-title" style={{ marginBottom: 8 }}>
              Waiting on someone else
            </h2>
            <ul className="standing-list">
              {view.others.map((row) => (
                <li key={row.projectId} className="standing-row">
                  <Link href={`/projects/${row.projectId}`} className="standing-step">
                    {row.name}
                  </Link>
                  <span className="standing-state is-later">
                    {row.next.title} ({row.next.who.people.length ? row.next.who.people.map((p) => p.name).join(", ") : row.next.who.text})
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
