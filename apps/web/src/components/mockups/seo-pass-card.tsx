"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { approveSeoAction, startSeoSuggestAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import type { SeoPassView, SeoValues } from "@/lib/seo-pass";

/*
  The minimal SEO pass (Jason, 29 September 2026), on Option A's Mockups
  page: code's suggestions for every page ($0), each page's title,
  description, H1 and picture descriptions editable, approved page by page.
  The design and the page's words don't change; the build uses what's
  approved.
*/
export function SeoPassCard({ projectId, view, canEdit }: { projectId: string; view: SeoPassView; canEdit: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const initial = (p: SeoPassView["pages"][number]): SeoValues => {
    const from = p.approved ?? p.suggested;
    return { title: from?.title ?? "", description: from?.description ?? "", h1: from?.h1 ?? "", alts: from?.alts ?? [] };
  };
  const [values, setValues] = useState<Record<string, SeoValues>>(Object.fromEntries(view.pages.map((p) => [p.id, initial(p)])));
  const approvedCount = view.pages.filter((p) => p.approved).length;

  return (
    <div className="card seo-pass">
      <div className="exact-head">
        <div>
          <h2 className="card-title">SEO basics</h2>
          <p className="hint">
            For each page: its title and description in search results, its main heading (H1) and a description of each picture (alt text). Suggested by code from the page&rsquo;s
            own words; change anything, then approve each page. The design and the words on the page stay as they are. $0, no AI.
          </p>
        </div>
        {canEdit ? (
          <Button
            small
            disabled={busy}
            onClick={() =>
              start(async () => {
                setError(null);
                const result = await startSeoSuggestAction(projectId);
                if (!result.ok) setError(result.message);
                else setStarted(true);
                router.refresh();
              })
            }
          >
            {view.suggestedAny ? "Suggest again ($0)" : "Suggest the SEO basics ($0)"}
          </Button>
        ) : null}
      </div>
      {error ? <p className="hint-error">{error}</p> : null}
      {started ? <p className="hint content-warn">Suggesting... about a minute; refresh the page to see them.</p> : null}
      {view.suggestedAny ? <p className="hint">{approvedCount} of {view.pages.length} pages approved.</p> : null}
      {view.suggestedAny ? (
        <ul className="seo-pages">
          {view.pages.map((p) => {
            const v = values[p.id]!;
            const set = (patch: Partial<SeoValues>) => setValues({ ...values, [p.id]: { ...v, ...patch } });
            return (
              <li key={p.id}>
                <div className="seo-page-head">
                  <strong>{p.name}</strong> <code>{p.path}</code>{" "}
                  {p.approved ? <span className="badge badge-done">Approved</span> : p.suggested ? <span className="badge badge-warning">To approve</span> : <span className="badge badge-info">No suggestion yet</span>}{" "}
                  {p.suggested ? (
                    <button type="button" className="btn btn-text" onClick={() => setOpen(open === p.id ? null : p.id)}>
                      {open === p.id ? "Close" : "Review"}
                    </button>
                  ) : null}
                </div>
                {open === p.id && p.suggested ? (
                  <div className="seo-page-body">
                    {p.suggested.headingNotes.map((n) => (
                      <p key={n} className="hint-amber">
                        {n}
                      </p>
                    ))}
                    <div className="field">
                      <label className="field-label" htmlFor={`seo-title-${p.id}`}>
                        <span>Title</span>
                        <span className="field-optional">{v.title.length} of about 60</span>
                      </label>
                      <input id={`seo-title-${p.id}`} className="input" value={v.title} disabled={!canEdit} onChange={(e) => set({ title: e.target.value })} />
                    </div>
                    <div className="field">
                      <label className="field-label" htmlFor={`seo-desc-${p.id}`}>
                        <span>Description</span>
                        <span className="field-optional">{v.description.length} of about 155</span>
                      </label>
                      <textarea id={`seo-desc-${p.id}`} className="textarea" rows={2} value={v.description} disabled={!canEdit} onChange={(e) => set({ description: e.target.value })} />
                    </div>
                    <div className="field">
                      <label className="field-label" htmlFor={`seo-h1-${p.id}`}>
                        <span>Main heading (H1)</span>
                        <span className="field-optional">Now: {p.suggested.h1Now}</span>
                      </label>
                      <input id={`seo-h1-${p.id}`} className="input" value={v.h1} disabled={!canEdit} onChange={(e) => set({ h1: e.target.value })} />
                    </div>
                    {v.alts.length ? (
                      <div className="field">
                        <span className="field-label">
                          <span>Picture descriptions (alt text)</span>
                          <span className="field-optional">{v.alts.length} without one</span>
                        </span>
                        {v.alts.map((a, i) => (
                          <input
                            key={a.src}
                            className="input seo-alt"
                            aria-label={`Description of picture ${i + 1}`}
                            value={a.alt}
                            disabled={!canEdit}
                            onChange={(e) => set({ alts: v.alts.map((x, k) => (k === i ? { ...x, alt: e.target.value } : x)) })}
                          />
                        ))}
                      </div>
                    ) : null}
                    {canEdit ? (
                      <Button
                        small
                        variant="primary"
                        disabled={busy}
                        onClick={() =>
                          start(async () => {
                            setError(null);
                            const result = await approveSeoAction(projectId, p.id, v);
                            if (!result.ok) setError(result.message);
                            else setOpen(null);
                            router.refresh();
                          })
                        }
                      >
                        Approve this page
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
