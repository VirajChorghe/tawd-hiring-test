"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { startImproveAction } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/*
  Design + content (0.100.0): improve each page's words from the current
  site's. The Home page first (rule 8): the others unlock once its improved
  words are approved, or it's put back to the current site's words. Each
  page is compared and approved on its own review, under the next step.
*/

export interface ImproveCardRow {
  pageId: string;
  name: string;
  href: string;
  words: number;
  isHome: boolean;
  stateLabel: string;
  improvable: boolean;
  suggested: boolean;
  why: string | null;
  /** This page's estimate in dollars (by its length, or from the improved pages so far). */
  cost: number;
}

export function ImproveCard(props: {
  projectId: string;
  canRun: boolean;
  rows: ImproveCardRow[];
  restUnlocked: boolean;
  /** "Sonnet 5", and whether the estimate is measured or a first guess. */
  model: string;
  measured: boolean;
  working: boolean;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>(() => props.rows.filter((r) => r.improvable && r.suggested && !r.isHome).map((r) => r.pageId));
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const costOf = (ids: string[]) => props.rows.filter((r) => ids.includes(r.pageId)).reduce((n, r) => n + r.cost, 0);
  const money = (usd: number) => (usd < 0.01 ? "under a cent" : `$${usd.toFixed(2)}`);
  const home = props.rows.find((r) => r.isHome) ?? null;

  useEffect(() => {
    if (!props.working) return;
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [props.working, router]);

  const run = (pageIds: string[]) =>
    start(async () => {
      setError(null);
      const result = await startImproveAction(props.projectId, pageIds);
      if (!result.ok) setError(result.message);
      else setConfirm(null);
      router.refresh();
    });

  const others = props.rows.filter((r) => !r.isHome);
  return (
    <div className="card content-card" id="improve">
      <div className="content-card-head">
        <div>
          <h2 className="card-title">Improve the words</h2>
          <p className="hint">
            TAWD improves each page from the current site&rsquo;s words: clearer and tighter, the page plan&rsquo;s keywords worked in,
            every fact kept. Each page is compared with the current words and approved on its review.
          </p>
        </div>
      </div>
      {props.working ? <p className="hint content-warn">Improving... about a minute a page. This page refreshes itself.</p> : null}
      {error ? <p className="hint-error">{error}</p> : null}

      {home && home.improvable && props.canRun ? (
        <div className="money-row-actions">
          <Button variant="primary" disabled={busy || props.working} onClick={() => setConfirm([home.pageId])}>
            Improve the Home page first
          </Button>
          <span className="hint">
            About {money(home.cost)} of AI on {props.model}.
          </span>
        </div>
      ) : null}

      {others.length ? (
        <>
          <p className="hint">
            {props.restUnlocked
              ? "Choose the other pages to improve. Blog articles and very short pages stay as they are unless you tick them."
              : "The other pages unlock once the Home page's improved words are approved (or it's put back to the current site's words)."}
          </p>
          <ul className="improve-list">
            {others.map((row) => (
              <li key={row.pageId}>
                <label className="checkline">
                  <input
                    type="checkbox"
                    checked={picked.includes(row.pageId)}
                    disabled={!row.improvable || !props.restUnlocked || !props.canRun || busy}
                    onChange={(e) => setPicked((p) => (e.target.checked ? [...p, row.pageId] : p.filter((id) => id !== row.pageId)))}
                  />
                  <Link href={row.href}>{row.name}</Link>
                  <span className="hint">{row.words} words</span>
                  <Badge kind="info">{row.stateLabel}</Badge>
                </label>
                {row.why ? <span className="hint">{row.why}</span> : null}
              </li>
            ))}
          </ul>
          {props.restUnlocked && props.canRun ? (
            <div className="money-row-actions">
              <Button variant="primary" disabled={busy || props.working || picked.length === 0} onClick={() => setConfirm(picked)}>
                Improve {picked.length} page{picked.length === 1 ? "" : "s"}
              </Button>
              <span className="hint">
                About {money(costOf(picked))} of AI on {props.model}.
              </span>
            </div>
          ) : null}
        </>
      ) : null}

      {confirm ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="improve-title">
            <h2 className="section-title" id="improve-title">
              Improve {confirm.length === 1 ? props.rows.find((r) => r.pageId === confirm[0])?.name ?? "this page" : `${confirm.length} pages`}?
            </h2>
            <p className="hint">
              About {money(costOf(confirm))} of AI on {props.model}
              {props.measured ? ", from the improved pages so far" : " (a first guess by each page's length until a real one has run)"}. One call a page, about a minute each.
            </p>
            <p className="hint">
              The cheaper way: keep a page&rsquo;s current words (free), or put this step on a cheaper model on Spend. Each improved page comes back
              for Content to compare with the current words and approve; nothing reaches the client before that, and any page can be put back to the
              current words.
            </p>
            {error ? <p className="hint-error">{error}</p> : null}
            <div className="modal-actions">
              <Button onClick={() => setConfirm(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => run(confirm)}>
                {busy ? "Starting..." : "Improve"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
