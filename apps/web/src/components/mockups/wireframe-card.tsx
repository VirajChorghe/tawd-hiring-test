"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { approveWireframeAction, resetWireframeAction, saveWireframeAction, setWireframeEnabledAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { ADDABLE_KINDS, WIREFRAME_KIND_INFO, type WireframeKind, type WireframeSection } from "@tawd/core/mockups";

/*
  The wireframe (3 October 2026, DESIGN.md "The wireframe"): on Growth and
  Pro, before the Home page words and the concepts. The site's pages, and
  the home page's sections in order as grey boxes, made by TAWD from the
  intake for free. The team reorders, adds, removes, renames and notes
  them, then approves; Generate waits for it and every concept follows it.
*/

export interface WireframeCardProps {
  projectId: string;
  /** PMs, the Web Designer and admins edit and approve. */
  canEdit: boolean;
  /** PMs and admins switch it on or off. */
  canSwitch: boolean;
  applies: boolean;
  /** Design only: no wireframe (0.100.0). */
  designOnly?: boolean;
  tier: string;
  /** The PM's choice, or null when it follows the tier. */
  enabled: boolean | null;
  sections: WireframeSection[];
  drafted: boolean;
  sitemap: { source: "plan" | "draft"; pages: { name: string; slug: string; parentSlug: string | null }[] };
  /** "Approved by Sam, today, 10:12 AM", or null. */
  approvedLine: string | null;
}

export function WireframeCard(props: WireframeCardProps) {
  const router = useRouter();
  const [sections, setSections] = useState(props.sections);
  const [adding, setAdding] = useState<WireframeKind>("about");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const tierOn = props.tier === "growth" || props.tier === "pro";
  const changed = JSON.stringify(sections) !== JSON.stringify(props.sections);

  const run = (action: () => Promise<{ ok: true } | { ok: false; message: string }>) =>
    start(async () => {
      setError(null);
      const result = await action();
      if (!result.ok) setError(result.message);
      router.refresh();
    });

  const switchButton = (on: boolean) =>
    props.canSwitch ? (
      <Button small variant="secondary" disabled={busy} onClick={() => run(() => setWireframeEnabledAction(props.projectId, on))}>
        {on ? "Switch the wireframe on" : "Switch it off for this project"}
      </Button>
    ) : null;

  if (!props.applies && props.designOnly) {
    return (
      <section className="card content-card" id="wireframe" aria-labelledby="wireframe-title">
        <h2 className="card-title" id="wireframe-title">
          Wireframe
        </h2>
        <p className="hint">Not needed for Design only: the new design keeps the current home page&rsquo;s sections, in their order.</p>
      </section>
    );
  }

  if (!props.applies) {
    return (
      <section className="card content-card" id="wireframe" aria-labelledby="wireframe-title">
        <h2 className="card-title" id="wireframe-title">
          Wireframe
        </h2>
        <p className="hint">
          {props.enabled === false
            ? "Switched off for this project: the concepts choose their own sections."
            : "Off for Starter: the concepts choose their own sections. Switch it on to settle the pages and the home page's sections first (free)."}
        </p>
        {error ? <p className="hint-error">{error}</p> : null}
        {switchButton(true)}
      </section>
    );
  }

  const move = (i: number, by: number) =>
    setSections((all) => {
      const next = [...all];
      const [item] = next.splice(i, 1);
      next.splice(i + by, 0, item!);
      return next;
    });
  const update = (i: number, change: Partial<WireframeSection>) => setSections((all) => all.map((s, n) => (n === i ? { ...s, ...change } : s)));
  const add = () =>
    setSections((all) => {
      const id = `${adding}-${Math.max(0, ...all.map((s) => Number(s.id.split("-").pop()) || 0)) + 1}`;
      const section: WireframeSection = { id, kind: adding, name: WIREFRAME_KIND_INFO[adding].name, lines: [], note: "" };
      return [...all.slice(0, -1), section, all.at(-1)!];
    });
  const children = (slug: string) => props.sitemap.pages.filter((p) => p.parentSlug === slug);

  return (
    <section className="card content-card wireframe" id="wireframe" aria-labelledby="wireframe-title">
      <div className="content-card-head">
        <div>
          <h2 className="card-title" id="wireframe-title">
            Wireframe
          </h2>
          <p className="hint">
            The site&rsquo;s pages and the home page&rsquo;s sections in order, made by TAWD from the intake (free). Reorder, add or remove sections, then approve:
            every concept is built in this order, and the Home page words follow these sections when TAWD writes them.
          </p>
        </div>
        <span className="badge badge-info">{props.enabled ? "Switched on" : tierOn ? `On for ${props.tier === "pro" ? "Pro" : "Growth"}` : "On"}</span>
      </div>

      <div className="wireframe-grid">
        <div>
          <h3 className="wireframe-heading">Pages</h3>
          <p className="hint">{props.sitemap.source === "plan" ? "From the page plan." : "As Content would draft them from the intake; Content can change them later."}</p>
          <ul className="wireframe-pages">
            {props.sitemap.pages
              .filter((p) => !p.parentSlug || !props.sitemap.pages.some((q) => q.slug === p.parentSlug))
              .map((p) => (
                <li key={p.slug}>
                  {p.name}
                  {children(p.slug).length ? (
                    <ul>
                      {children(p.slug).map((c) => (
                        <li key={c.slug}>{c.name}</li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
          </ul>
        </div>

        <div>
          <h3 className="wireframe-heading">Home page, top to bottom</h3>
          <ol className="wireframe-sections">
            {sections.map((s, i) => {
              const fixed = s.kind === "header" || s.kind === "footer";
              return (
                <li key={s.id} className={`wireframe-box wireframe-${s.kind}`}>
                  <div className="wireframe-box-head">
                    <label className="visually-hidden" htmlFor={`wf-name-${s.id}`}>
                      Section {i + 1} name
                    </label>
                    <input id={`wf-name-${s.id}`} className="input wireframe-name" value={s.name} disabled={!props.canEdit} onChange={(e) => update(i, { name: e.target.value })} />
                    {props.canEdit && !fixed ? (
                      <span className="wireframe-controls">
                        <Button small variant="text" disabled={i <= 1} aria-label={`Move ${s.name} up`} onClick={() => move(i, -1)}>
                          Up
                        </Button>
                        <Button small variant="text" disabled={i >= sections.length - 2} aria-label={`Move ${s.name} down`} onClick={() => move(i, 1)}>
                          Down
                        </Button>
                        <Button small variant="text" aria-label={`Remove ${s.name}`} onClick={() => setSections((all) => all.filter((x) => x.id !== s.id))}>
                          Remove
                        </Button>
                      </span>
                    ) : null}
                  </div>
                  <p className="hint">{WIREFRAME_KIND_INFO[s.kind].what}</p>
                  {s.lines.length ? (
                    <ul className="wireframe-lines">
                      {s.lines.map((line, n) => (
                        <li key={n} className={line.includes("[PLACEHOLDER") ? "is-placeholder" : undefined}>
                          {line}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {props.canEdit ? (
                    <>
                      <label className="visually-hidden" htmlFor={`wf-note-${s.id}`}>
                        Note for {s.name}
                      </label>
                      <textarea
                        id={`wf-note-${s.id}`}
                        className="textarea wireframe-note"
                        rows={1}
                        value={s.note}
                        placeholder="A note for the designer (optional)"
                        onChange={(e) => update(i, { note: e.target.value })}
                      />
                    </>
                  ) : s.note ? (
                    <p className="hint">Note: {s.note}</p>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {props.canEdit ? (
            <div className="row wireframe-add">
              <label className="visually-hidden" htmlFor="wf-add">
                Section to add
              </label>
              <select id="wf-add" className="select" value={adding} onChange={(e) => setAdding(e.target.value as WireframeKind)}>
                {ADDABLE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {WIREFRAME_KIND_INFO[k].name}
                  </option>
                ))}
              </select>
              <Button small onClick={add}>
                Add before the footer
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      {props.approvedLine && !changed ? (
        <p className="hint content-done">{props.approvedLine}</p>
      ) : (
        <p className="hint">{changed && props.approvedLine ? "Changed since it was approved: approve it again." : "Not approved yet: Generate waits for the wireframe."}</p>
      )}
      {error ? <p className="hint-error">{error}</p> : null}
      {props.canEdit ? (
        <div className="money-row-actions edit-actions">
          <Button disabled={busy || !changed} onClick={() => run(() => saveWireframeAction(props.projectId, sections))}>
            Save
          </Button>
          <Button variant="primary" disabled={busy || (Boolean(props.approvedLine) && !changed)} onClick={() => run(() => approveWireframeAction(props.projectId, sections))}>
            {busy ? "Saving..." : "Approve the wireframe"}
          </Button>
        </div>
      ) : null}
      {props.canEdit || props.canSwitch ? (
        <details className="hint">
          <summary>More</summary>
          <div className="money-row-actions edit-actions">
            {props.canEdit && !props.drafted ? (
              <Button small variant="secondary" disabled={busy} onClick={() => run(() => resetWireframeAction(props.projectId))}>
                Start again from the intake
              </Button>
            ) : null}
            {switchButton(false)}
          </div>
        </details>
      ) : null}
    </section>
  );
}
