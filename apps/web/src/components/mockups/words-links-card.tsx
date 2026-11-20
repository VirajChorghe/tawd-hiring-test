"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { saveLinkRulesAction, startSiteTidyAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import type { TidyView } from "@/lib/site-tidy";

/*
  Words and links (Jason, 29 September 2026), on Option A's Mockups page:
  one $0 pass over every page's copy (garbled button names from the card
  they're in, Terms of Use and Disclaimer out, the footer's privacy and
  cookie links, Contact out, links pointed at their pages), what it
  changed, and the links still without a place, grouped by their words,
  each with a choice.
*/
export function WordsLinksCard({ projectId, view, canEdit }: { projectId: string; view: TidyView; canEdit: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [choices, setChoices] = useState<Record<string, string>>(Object.fromEntries(view.unresolved.map((u) => [u.words, u.chosen])));

  const run = () =>
    start(async () => {
      setError(null);
      const result = await startSiteTidyAction(projectId);
      if (!result.ok) setError(result.message);
      else setStarted(true);
      router.refresh();
    });
  const save = () =>
    start(async () => {
      setError(null);
      const result = await saveLinkRulesAction(projectId, Object.entries(choices).map(([words, to]) => ({ words, to })));
      if (!result.ok) setError(result.message);
      else setStarted(true);
      router.refresh();
    });

  return (
    <div className="card words-links">
      <div className="exact-head">
        <div>
          <h2 className="card-title">Words and links</h2>
          <p className="hint">
            Every page&rsquo;s copy, fixed by code: a &ldquo;MEET&rdquo; button with a garbled name takes the name in its card; Terms of Use and Disclaimer come out and the footer
            links TAWD&rsquo;s privacy and cookie pages; Contact comes out (there is no contact page); each link goes to the page its words name. $0, no AI.
          </p>
        </div>
        {canEdit ? (
          <Button small disabled={busy} onClick={run}>
            {view.ran ? "Fix them again ($0)" : "Fix the words and links ($0)"}
          </Button>
        ) : null}
      </div>
      {error ? <p className="hint-error">{error}</p> : null}
      {started ? <p className="hint content-warn">Fixing every page... it takes about a minute; refresh the page to see what changed.</p> : null}
      {view.ran ? (
        <>
          <ul className="kit-misses">
            {view.pages
              .filter((p) => p.changes.length)
              .map((p) => (
                <li key={p.name}>
                  <strong>{p.name}:</strong> {p.changes.join("; ")}
                </li>
              ))}
          </ul>
          {view.unresolved.length ? (
            <div>
              <p className="hint-amber">
                {view.unresolved.reduce((n, u) => n + u.count, 0)} links don&rsquo;t say where they go. Choose for each, then save: the pages are fixed again with your choices.
              </p>
              <table className="kit-fonts">
                <thead>
                  <tr>
                    <th>Link</th>
                    <th>On</th>
                    <th>Goes to</th>
                  </tr>
                </thead>
                <tbody>
                  {view.unresolved.map((u) => (
                    <tr key={u.words}>
                      <td>
                        &ldquo;{u.words}&rdquo; {u.count > 1 ? <span className="hint">x{u.count}</span> : null}
                      </td>
                      <td className="hint">{u.pages.join(", ")}</td>
                      <td>
                        <select
                          className="select"
                          aria-label={`Where "${u.words}" goes`}
                          value={choices[u.words] ?? ""}
                          disabled={!canEdit || busy}
                          onChange={(e) => setChoices({ ...choices, [u.words]: e.target.value })}
                        >
                          {view.options.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                              {o.value && o.value === u.suggestion ? " (suggested)" : ""}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {canEdit ? (
                <Button small variant="primary" disabled={busy} onClick={save}>
                  Save and fix the pages ($0)
                </Button>
              ) : null}
            </div>
          ) : (
            <p className="hint">Every link goes to a page.</p>
          )}
        </>
      ) : null}
    </div>
  );
}
