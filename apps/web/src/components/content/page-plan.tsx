"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { makePagePlanAction, movePlanPageAction, removePlanPageAction, savePlanPageAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  The page plan (7a): the site's pages in menu order, each with its main
  keyword, supporting keywords, title, meta description and H1. Made free
  from the tier and the keyword research; the team renames, adds, removes
  and reorders. Every change is logged. The tier check only warns.
*/

export interface PlanRow {
  id: string;
  kind: string;
  kindLabel: string;
  /** "In the Air conditioning hub", for a detailed page whose hub is in the plan (28 September 2026). */
  hubLine?: string | null;
  name: string;
  slug: string;
  mainKeyword: string;
  supportingKeywords: string[];
  title: string;
  metaDescription: string;
  h1: string;
}

type Result = { ok: true } | { ok: false; message: string };

export function PagePlan(props: {
  projectId: string;
  canEdit: boolean;
  pages: PlanRow[];
  kinds: { value: string; label: string }[];
  /** "9 pages, within Starter's 10." */
  countLine: string;
  tierWarning: string | null;
  /** "No page in the plan has a main keyword": the pages would compete with each other. */
  keywordWarning?: string | null;
  hasResearch: boolean;
  titleLimit: number;
  metaLimit: number;
  /** Keep all content as is (0.96.0): the plan comes from the current site by itself, so it isn't made or remade here. */
  keep?: boolean;
  /** Prepare the content shows above (8 October 2026): it makes the plan too, so it is the starting button. */
  prepareFirst?: boolean;
  /** The home page is a design the team supplied: the plan comes from its menu, and the home page is never drafted. */
  suppliedHome?: boolean;
  /** What making the plan again would delete, in words ("This deletes 12 approved pages."), or "" (0.100.0). */
  remakeDeletes?: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ kind: "remake" } | { kind: "remove"; page: PlanRow } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const run = (action: () => Promise<Result>, done?: () => void) =>
    start(async () => {
      setError(null);
      const result = await action();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setDialog(null);
      done?.();
      router.refresh();
    });

  if (props.pages.length === 0) {
    return (
      <div className="card content-card">
        <div className="content-card-head">
          <div>
            <h2 className="card-title">Page plan</h2>
            <p className="hint">
              The site&rsquo;s pages for this tier, each with its main keyword, supporting keywords, title, meta
              description and H1, ready for the team to change. Free: no AI and no lookups.
              {props.keep ? " Design only and Design + content: the plan makes itself from the current site's pages when TAWD has read them." : props.prepareFirst ? (props.suppliedHome ? " Prepare the content (above) makes it, from the menu of the design the client approved." : " Prepare the content (above) makes it and then drafts the Home page, in one go.") : props.hasResearch ? "" : " Look up keywords first for keywords with real search numbers; without them the plan uses the intake's words."}
            </p>
          </div>
          {props.canEdit && !props.keep ? (
            <div className="money-row-actions">
              {props.prepareFirst ? (
                <a className="btn btn-primary" href="#prepare">
                  Prepare the content
                </a>
              ) : null}
              <Button variant={props.prepareFirst ? "secondary" : "primary"} disabled={busy} onClick={() => run(() => makePagePlanAction(props.projectId))}>
                {busy ? "Making it..." : props.prepareFirst ? "Only the page plan" : "Make the page plan"}
              </Button>
            </div>
          ) : null}
        </div>
        {error ? <p className="hint-error">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="card content-card">
      <div className="content-card-head">
        <div>
          <h2 className="card-title">Page plan</h2>
          <p className="hint">{props.countLine} In menu order; Home is always first.</p>
        </div>
        {props.canEdit && !props.keep ? (
          <Button disabled={busy} onClick={() => setDialog({ kind: "remake" })}>
            Make it again
          </Button>
        ) : null}
      </div>
      {props.tierWarning ? <p className="hint content-warn">{props.tierWarning}</p> : null}
      {props.keywordWarning ? <p className="hint content-warn">{props.keywordWarning}</p> : null}
      {error ? <p className="hint-error">{error}</p> : null}

      <ol className="plan-list">
        {props.pages.map((page, index) =>
          editing === page.id ? (
            <li key={page.id} className="plan-row is-editing">
              <PageForm {...props} page={page} busy={busy} onCancel={() => setEditing(null)} onSave={(input) => run(() => savePlanPageAction(props.projectId, page.id, input), () => setEditing(null))} />
            </li>
          ) : (
            <li key={page.id} className="plan-row">
              <span className="plan-number" aria-hidden="true">
                {index + 1}
              </span>
              <div className="plan-body">
                <p className="plan-name">
                  <strong>{page.name}</strong> <span className="badge badge-info">{page.kindLabel}</span>{" "}
                  <span className="plan-slug">/{page.slug}</span>
                  {page.hubLine ? <span className="hint"> {page.hubLine}</span> : null}
                </p>
                <dl className="plan-facts">
                  <div>
                    <dt>Main keyword</dt>
                    <dd>{page.mainKeyword || <span className="plan-empty">None yet</span>}</dd>
                  </div>
                  <div>
                    <dt>Supporting</dt>
                    <dd>{page.supportingKeywords.length ? page.supportingKeywords.join(", ") : <span className="plan-empty">None</span>}</dd>
                  </div>
                  <div>
                    <dt>Title</dt>
                    <dd>
                      {page.title} <Length value={page.title} limit={props.titleLimit} />
                    </dd>
                  </div>
                  <div>
                    <dt>Meta description</dt>
                    <dd>
                      {page.metaDescription} <Length value={page.metaDescription} limit={props.metaLimit} />
                    </dd>
                  </div>
                  <div>
                    <dt>H1</dt>
                    <dd>{page.h1}</dd>
                  </div>
                </dl>
              </div>
              {props.canEdit ? (
                <div className="plan-actions">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Move ${page.name} up`}
                    disabled={busy || page.kind === "home" || index <= 1}
                    onClick={() => run(() => movePlanPageAction(props.projectId, page.id, "up"))}
                  >
                    <ArrowIcon up />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Move ${page.name} down`}
                    disabled={busy || page.kind === "home" || index === props.pages.length - 1}
                    onClick={() => run(() => movePlanPageAction(props.projectId, page.id, "down"))}
                  >
                    <ArrowIcon />
                  </button>
                  <Button variant="text" small onClick={() => setEditing(page.id)} aria-label={`Edit ${page.name}`}>
                    Edit
                  </Button>
                  {page.kind !== "home" ? (
                    <Button variant="text" small onClick={() => setDialog({ kind: "remove", page })} aria-label={`Remove ${page.name}`}>
                      Remove
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          ),
        )}
        {editing === "new" ? (
          <li className="plan-row is-editing">
            <PageForm {...props} page={null} busy={busy} onCancel={() => setEditing(null)} onSave={(input) => run(() => savePlanPageAction(props.projectId, null, input), () => setEditing(null))} />
          </li>
        ) : null}
      </ol>
      {props.canEdit && editing !== "new" ? (
        <div className="plan-foot">
          <Button small onClick={() => setEditing("new")}>
            Add a page
          </Button>
        </div>
      ) : null}

      {dialog ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="plan-dialog-title">
            <h2 className="section-title" id="plan-dialog-title">
              {dialog.kind === "remake" ? "Make the page plan again?" : `Remove ${dialog.page.name} from the plan?`}
            </h2>
            <p className="hint">
              {dialog.kind === "remake"
                ? `A fresh plan from ${props.suppliedHome ? "the menu of the design the client approved" : "the tier, the intake and the latest keyword research"} replaces this one, including any pages you added or changed.${props.remakeDeletes ? ` ${props.remakeDeletes}` : ""} Recorded in the activity log.`
                : "It comes off the plan and the menu. You can add it back later. Recorded in the activity log."}
            </p>
            <div className="modal-actions">
              <Button onClick={() => setDialog(null)} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  dialog.kind === "remake"
                    ? run(() => makePagePlanAction(props.projectId))
                    : run(() => removePlanPageAction(props.projectId, dialog.page.id))
                }
              >
                {dialog.kind === "remake" ? "Make it again" : "Remove the page"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Length({ value, limit }: { value: string; limit: number }) {
  const over = value.length > limit;
  return (
    <span className={over ? "plan-length is-over" : "plan-length"}>
      {value.length}/{limit}
      {over ? " (too long for search results)" : ""}
    </span>
  );
}

function PageForm(props: {
  page: PlanRow | null;
  kinds: { value: string; label: string }[];
  busy: boolean;
  titleLimit: number;
  metaLimit: number;
  onCancel: () => void;
  onSave: (input: { kind: string; name: string; slug: string; mainKeyword: string; supportingKeywords: string; title: string; metaDescription: string; h1: string }) => void;
}) {
  const p = props.page;
  const [values, setValues] = useState({
    kind: p?.kind ?? "service",
    name: p?.name ?? "",
    slug: p?.slug ?? "",
    mainKeyword: p?.mainKeyword ?? "",
    supportingKeywords: p?.supportingKeywords.join(", ") ?? "",
    title: p?.title ?? "",
    metaDescription: p?.metaDescription ?? "",
    h1: p?.h1 ?? "",
  });
  const id = p?.id ?? "new";
  const set = (key: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));
  const field = (key: keyof typeof values, label: string, extra?: React.ReactNode, textarea = false) => (
    <div className="field">
      <label className="field-label" htmlFor={`plan-${key}-${id}`}>
        <span>{label}</span>
      </label>
      {textarea ? (
        <textarea id={`plan-${key}-${id}`} className="textarea" rows={2} value={values[key]} onChange={set(key)} />
      ) : (
        <input id={`plan-${key}-${id}`} className="input" value={values[key]} onChange={set(key)} />
      )}
      {extra}
    </div>
  );

  return (
    <div className="plan-form">
      <div className="plan-form-grid">
        {field("name", "Page name")}
        <div className="field">
          <label className="field-label" htmlFor={`plan-kind-${id}`}>
            <span>Kind of page</span>
          </label>
          <select id={`plan-kind-${id}`} className="select" value={values.kind} onChange={set("kind")} disabled={p?.kind === "home"}>
            {props.kinds.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        {values.kind !== "home" ? field("slug", "Address", <p className="hint">The part after the domain, such as drain-cleaning. Made from the name when blank.</p>) : null}
        {field("mainKeyword", "Main keyword")}
        {field("supportingKeywords", "Supporting keywords", <p className="hint">Separated by commas.</p>)}
        {field("h1", "H1")}
      </div>
      {field("title", "Title", <Length value={values.title} limit={props.titleLimit} />)}
      {field("metaDescription", "Meta description", <Length value={values.metaDescription} limit={props.metaLimit} />, true)}
      <div className="modal-actions">
        <Button onClick={props.onCancel} disabled={props.busy}>
          Cancel
        </Button>
        <Button variant="primary" disabled={props.busy || !values.name.trim()} onClick={() => props.onSave(values)}>
          {props.busy ? "Saving..." : p ? `Save ${p.name}` : "Add the page"}
        </Button>
      </div>
    </div>
  );
}

function ArrowIcon({ up = false }: { up?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {up ? <path d="M12 19V5M5 12l7-7 7 7" /> : <path d="M12 5v14M5 12l7 7 7-7" />}
    </svg>
  );
}
