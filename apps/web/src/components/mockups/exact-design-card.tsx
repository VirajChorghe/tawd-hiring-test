"use client";

import { StopButton } from "@/components/ui/stop-button";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import {
  approveExactDesignAction,
  confirmDesignPagesAction,
  decideMobileAction,
  renameDesignPagesAction,
  startExactCopiesAction,
  startMobileVersionsAction,
  startPhonesByCodeAction,
} from "@/app/actions";
import { PaidStepButton } from "@/components/mockups/paid-step";
import { AcceptCopyButton } from "@/components/mockups/accept-copy";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import type { ExactDesignView, ExactPageView } from "@/lib/exact-design";

/*
  Lane 2, Option A (28 September 2026): the client-approved design, built
  exactly. The design's pages (each desktop frame, with its mobile frame
  when there is one), confirmed by the PM; then every page copied, each
  with its fidelity to the design, the lowest section named.
*/
export function ExactDesignCard({ projectId, view, canEdit, canDecide = false }: { projectId: string; view: ExactDesignView; canEdit: boolean; canDecide?: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [pages, setPages] = useState(view.pages.map((p) => ({ id: p.id, name: p.name, slug: p.slug })));
  const [approving, setApproving] = useState(false);
  // Names and addresses can change after the pages are confirmed, until go-live (29 September 2026).
  const [renaming, setRenaming] = useState(false);
  const editing = canEdit && (!view.confirmed || renaming);
  const [approval, setApproval] = useState({ channel: "", clientSaid: "" });

  useEffect(() => {
    if (!view.working && !view.mobileWorking) return;
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [view.working, view.mobileWorking, router]);

  const decide = (copyId: string, decision: "accepted" | "pushed_back", note: string) =>
    start(async () => {
      setError(null);
      const result = await decideMobileAction(projectId, copyId, { decision, note });
      if (!result.ok) setError(result.message);
      router.refresh();
    });

  if (!view.imported) {
    return (
      <div className="card exact-design">
        <h2 className="card-title">Build the design exactly</h2>
        <p className="hint">Import the Figma design or read the uploaded one first (the intake&rsquo;s Design section). Each page of it becomes a page of the site.</p>
      </div>
    );
  }

  return (
    <div className="card exact-design">
      <div className="exact-head">
        <div>
          <h2 className="card-title">Build the design exactly</h2>
          <p className="hint">
            The client approved this design, so nothing is redesigned. Each desktop frame is a page of the site, copied exactly and scored against the design
            section by section. {view.mobileFrames ? `${view.mobileFrames} mobile frame${view.mobileFrames === 1 ? "" : "s"} set the phone versions.` : "There are no mobile frames: each page gets a responsive version for the designer to review."}
          </p>
        </div>
        {view.confirmed ? <span className="badge badge-done">Pages confirmed</span> : <span className="badge badge-warning">Confirm the pages</span>}
      </div>
      {error ? <Banner tone="error" title={error} /> : null}

      <table className="exact-pages">
        <thead>
          <tr>
            <th>Page</th>
            <th>Address</th>
            <th>Frame</th>
            <th>Phone</th>
            <th>Copy</th>
          </tr>
        </thead>
        <tbody>
          {view.pages.map((page, i) => {
            const edit = pages[i]!;
            const copy = page.copy;
            return (
              <tr key={page.id}>
                <td>
                  {editing ? (
                    <input className="input" aria-label={`Name of ${page.frameName}`} value={edit.name} onChange={(e) => setPages(pages.map((p, k) => (k === i ? { ...p, name: e.target.value } : p)))} />
                  ) : copy && (copy.status === "done" || copy.status === "needs_cleanup") ? (
                    <a className="plain-link" href={`/projects/${projectId}/mockups/design/copy?copy=${copy.id}`}>
                      <strong>{page.name}</strong>
                    </a>
                  ) : (
                    <strong>{page.name}</strong>
                  )}
                </td>
                <td>
                  {page.isHome ? (
                    <span className="hint">/ (home)</span>
                  ) : editing ? (
                    <input className="input" aria-label={`Address of ${page.frameName}`} value={edit.slug} onChange={(e) => setPages(pages.map((p, k) => (k === i ? { ...p, slug: e.target.value } : p)))} />
                  ) : (
                    <code>/{page.slug}/</code>
                  )}
                </td>
                <td className="hint">{page.frameName}</td>
                <td className="hint">
                  <PhoneCell page={page} canDecide={canDecide && !busy} onDecide={decide} />
                </td>
                <td>
                  {!copy ? (
                    <span className="badge badge-info">Not copied</span>
                  ) : copy.status === "queued" || copy.status === "working" ? (
                    <>
                      <CopyProgress copy={copy} />
                      {canEdit || canDecide ? <StopButton projectId={projectId} kind="copies" copyId={copy.id} label="Stop this page" what={`copying ${page.name}`} /> : null}
                    </>
                  ) : copy.status === "failed" ? (
                    <span className="hint-error">{copy.failureReason ?? "The copy didn't finish."}</span>
                  ) : (
                    <a
                      className={`copy-open ${copy.overall !== null && copy.overall >= 90 ? "badge badge-done" : copy.overall !== null && copy.overall >= 80 ? "badge badge-info" : "badge badge-warning"}`}
                      href={`/projects/${projectId}/mockups/design/copy?copy=${copy.id}`}
                      title="Open the copy: the design and the copy side by side, section by section"
                    >
                      {copy.overall !== null ? `Matches ${copy.overall}%` : "Copied"}
                      {copy.lowest && copy.lowest.score < 90 ? `, lowest "${copy.lowest.name}" ${copy.lowest.score}%` : ""}
                    </a>
                  )}
                  {copy?.status === "needs_cleanup" ? (
                    <div className="copy-still-off">
                      <p className="hint-amber">{view.upload ? "Some sections still differ after the rebuild." : "Some sections still differ after the rebuild; clean the frame in Figma, or accept it."}</p>
                      {canEdit || canDecide ? <AcceptCopyButton projectId={projectId} copyId={copy.id} pageName={page.name} /> : null}
                    </div>
                  ) : copy?.accepted ? (
                    <p className="hint">Accepted as it is</p>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {canEdit ? (
        <div className="exact-actions">
          {view.confirmed && renaming ? (
            <>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const result = await renameDesignPagesAction(projectId, pages);
                    if (!result.ok) setError(result.message);
                    else setRenaming(false);
                    router.refresh();
                  })
                }
              >
                Save names and addresses
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  setPages(view.pages.map((p) => ({ id: p.id, name: p.name, slug: p.slug })));
                  setRenaming(false);
                }}
              >
                Cancel
              </Button>
            </>
          ) : view.confirmed ? (
            <Button small disabled={busy} onClick={() => setRenaming(true)}>
              Change page names and addresses
            </Button>
          ) : null}
          {!view.confirmed ? (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const result = await confirmDesignPagesAction(projectId, pages);
                  if (!result.ok) setError(result.message);
                  router.refresh();
                })
              }
            >
              Confirm the pages
            </Button>
          ) : view.toBuild > 0 ? (
            <>
              <ExactCopiesButton projectId={projectId} view={view} />
              {view.working ? <StopButton projectId={projectId} kind="copies" label="Stop all copies" what="all the copies" /> : null}
            </>
          ) : view.mobileToMake > 0 || view.mobileWorking ? (
            <PaidStepButton
              id="mobile-versions"
              variant="primary"
              label={`Make the phone version${view.mobileToMake === 1 ? "" : "s"}`}
              confirmTitle="Make the phone versions?"
              confirmText="For each copied page, CSS for screens under 768px only: from the design's mobile frame where there is one, otherwise a responsive version for the designer to review. The desktop page and every word stay as designed. Each is then checked at 390px wide."
              estimateLine={view.mobileEstimate.label}
              working={view.mobileWorking}
              run={() => startMobileVersionsAction(projectId)}
              stop={{ projectId, kind: "phone_versions", what: "the phone versions" }}
            />
          ) : view.approved ? null : (
            <Button variant="primary" disabled={busy || view.approvalProblems.length > 0} onClick={() => setApproving(true)}>
              Record the client&rsquo;s approval
            </Button>
          )}
          {view.confirmed && view.toBuild === 0 && !view.mobileWorking && view.pages.some((p) => p.copy && (p.copy.status === "done" || p.copy.status === "needs_cleanup")) ? (
            <Button
              small
              disabled={busy}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const result = await startPhonesByCodeAction(projectId);
                  if (!result.ok) setError(result.message);
                  router.refresh();
                })
              }
            >
              Make the phone versions by code ($0)
            </Button>
          ) : null}
        </div>
      ) : null}

      {view.approved ? (
        <p className="hint exact-approved">
          <span className="badge badge-done">Approved</span> The client approved this design ({view.approved.channel}): &ldquo;{view.approved.clientSaid}&rdquo;. The site is built from these pages exactly on the Build page.
        </p>
      ) : view.confirmed && view.toBuild === 0 && view.approvalProblems.length > 0 && !view.working && !view.mobileWorking ? (
        <div className="amber-box">
          <p className="card-title">Before the approval can be recorded</p>
          <ul>
            {view.approvalProblems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {approving ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="exact-approve-title">
            <h2 className="section-title" id="exact-approve-title">
              Record the client&rsquo;s approval?
            </h2>
            <p className="hint">The client approved this design before TAWD had it. Record how, and what they said; the project then moves to Build, where the site is built from these pages exactly (free, no AI).</p>
            <label className="field-label" htmlFor="exact-channel">
              How it came in
            </label>
            <select id="exact-channel" className="select" value={approval.channel} onChange={(e) => setApproval({ ...approval, channel: e.target.value })}>
              <option value="">Choose</option>
              <option value="phone">Phone call</option>
              <option value="email">Email</option>
              <option value="meeting">Meeting</option>
            </select>
            <label className="field-label" htmlFor="exact-said">
              What the client said
            </label>
            <textarea id="exact-said" className="input" rows={3} value={approval.clientSaid} onChange={(e) => setApproval({ ...approval, clientSaid: e.target.value })} />
            <div className="modal-actions">
              <Button onClick={() => setApproving(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy || !approval.channel || approval.clientSaid.trim().length < 3}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const result = await approveExactDesignAction(projectId, approval);
                    if (!result.ok) setError(result.message);
                    else setApproving(false);
                    router.refresh();
                  })
                }
              >
                Record the approval
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* The phone column: where the phone version comes from, how it's doing, and the designer's call on a responsive one. */
function PhoneCell({ page, canDecide, onDecide }: { page: ExactPageView; canDecide: boolean; onDecide: (copyId: string, decision: "accepted" | "pushed_back", note: string) => void }) {
  const [pushing, setPushing] = useState(false);
  const [note, setNote] = useState("");
  const mobile = page.copy?.mobile;
  const source = page.mobileFrameName ? `From "${page.mobileFrameName}"` : "Responsive, for the designer's review";
  if (!mobile || !mobile.status) return <>{source}</>;
  if (mobile.status === "queued" || mobile.status === "working") return <span className="hint-amber">Making the phone version...</span>;
  if (mobile.status === "failed") return <span className="hint-error">{mobile.failure ?? "The phone version didn't finish."}</span>;
  return (
    <span className="exact-phone">
      <span>
        {mobile.from === "mobile frame" ? `From "${page.mobileFrameName ?? "the mobile frame"}"` : mobile.from === "code" ? "By code" : "Responsive"}
        {mobile.overflow ? <span className="hint-error"> Scrolls sideways at 390px.</span> : null}
        {mobile.from === "code" ? (
          mobile.problems.length ? (
            <span className="hint-amber" title={mobile.problems.join("\n")}>
              {" "}
              Phone check: {mobile.problems.length} to fix ({mobile.problems.slice(0, 2).join("; ")}
              {mobile.problems.length > 2 ? "; ..." : ""})
            </span>
          ) : (
            <span className="hint"> Phone check passed.</span>
          )
        ) : null}
        {mobile.pngUrl ? (
          <>
            {" "}
            <a href={mobile.pngUrl} target="_blank" rel="noreferrer">
              View
            </a>
          </>
        ) : null}
      </span>
      {mobile.from === "responsive" || mobile.from === "code" ? (
        mobile.decision ? (
          <span className={mobile.decision === "accepted" ? "badge badge-done" : "badge badge-warning"}>{mobile.decision === "accepted" ? "Designer accepted" : "Designer pushed back"}</span>
        ) : canDecide && page.copy && pushing ? (
          <span className="exact-decide">
            <input className="input" aria-label={`What should change in the phone version of ${page.name}`} placeholder="What should change" value={note} onChange={(e) => setNote(e.target.value)} />
            <button type="button" className="btn btn-secondary" disabled={note.trim().length < 3} onClick={() => onDecide(page.copy!.id, "pushed_back", note)}>
              Send
            </button>
          </span>
        ) : canDecide && page.copy ? (
          <span className="exact-decide">
            <button type="button" className="btn btn-text" onClick={() => onDecide(page.copy!.id, "accepted", "")}>
              Accept
            </button>
            <button type="button" className="btn btn-text" onClick={() => setPushing(true)}>
              Push back
            </button>
          </span>
        ) : (
          <span className="badge badge-info">Waiting for the designer</span>
        )
      ) : null}
    </span>
  );
}

/* The same wording as the server's formatCost, for the running estimate. */
function dollars(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return "under $0.01";
  if (value < 10) return `$${value.toFixed(2)}`;
  return `$${Math.round(value)}`;
}

/*
  Build the exact copies (27 September 2026): a box per page not copied
  yet, so a PM can copy the home page first, check its match, then the
  rest. The estimate follows the boxes.
*/
export function ExactCopiesButton({ projectId, view, startOpen = false }: { projectId: string; view: ExactDesignView; startOpen?: boolean }) {
  const router = useRouter();
  const waiting = view.pages.filter((p) => !p.copy || p.copy.status === "failed");
  const [open, setOpen] = useState(startOpen);
  const [chosen, setChosen] = useState<string[]>(waiting.map((p) => p.frameId));
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  useEffect(() => {
    if (!view.working) return;
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [view.working, router]);

  const home = waiting.find((p) => p.isHome);
  const count = waiting.filter((p) => chosen.includes(p.frameId)).length;
  const detail = /\((.*)\)/.exec(view.perPage.label)?.[1] ?? "";
  const estimate = count ? `About ${dollars(view.perPage.cost * count)} of AI for ${count} page${count === 1 ? "" : "s"}${detail ? ` (${detail})` : ""}.` : "Choose at least one page.";
  const set = (ids: string[]) => setChosen([...new Set(ids)]);

  return (
    <>
      <Button
        small
        variant="primary"
        disabled={busy || view.working}
        onClick={() => {
          set(waiting.map((p) => p.frameId));
          setError(null);
          setOpen(true);
        }}
      >
        {view.working ? "Working..." : view.pages.some((p) => p.copy) ? `Copy the ${waiting.length} remaining page${waiting.length === 1 ? "" : "s"}` : "Build the exact copies"}
      </Button>
      {error && !open ? <p className="hint-error">{error}</p> : null}
      {open ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="exact-copies-title">
            <h2 className="section-title" id="exact-copies-title">
              Copy the design&rsquo;s pages?
            </h2>
            <p className="hint">
              Each page is rebuilt as a web page exactly as designed, a few sections at a time, then compared with its frame section by section. Nothing is changed or improved:
              the client approved this design.
            </p>
            <fieldset className="field design-read-pages">
              <legend className="field-label">
                <span>Pages to copy</span>
              </legend>
              <div className="design-read-quick">
                {home ? (
                  <Button small variant="text" onClick={() => set([home.frameId])}>
                    Only the home page
                  </Button>
                ) : null}
                <Button small variant="text" onClick={() => set(waiting.map((p) => p.frameId))}>
                  Every page not copied yet
                </Button>
              </div>
              {waiting.map((p) => (
                <label className="checkline" key={p.frameId}>
                  <input type="checkbox" checked={chosen.includes(p.frameId)} onChange={(e) => set(e.target.checked ? [...chosen, p.frameId] : chosen.filter((id) => id !== p.frameId))} />
                  <span>
                    {p.name}
                    {p.isHome ? " (home)" : ""} <span className="hint">{p.copy?.status === "failed" ? "the last copy failed" : `/${p.slug === "" ? "" : p.slug}`}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <p className={count ? "hint" : "hint-amber"}>{estimate}</p>
            {error ? <p className="hint-error">{error}</p> : null}
            <div className="modal-actions">
              <Button onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy || count === 0}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const result = await startExactCopiesAction(projectId, chosen);
                    if (!result.ok) {
                      setError(result.message);
                      return;
                    }
                    setOpen(false);
                    router.refresh();
                  })
                }
              >
                {busy ? "Starting..." : `Copy ${count} page${count === 1 ? "" : "s"}`}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/* "1st", "2nd", "3rd", "4th", "11th", "21st". */
function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

/*
  A page waiting or being copied (28 September 2026): its place in line,
  or which section it's on, the look at it, then the rebuilds.
*/
export function CopyProgress({ copy }: { copy: NonNullable<ExactPageView["copy"]> }) {
  if (copy.status === "queued") return <span className="hint hint-amber">{copy.inLine ? `Waiting (${ordinal(copy.inLine)} in line)` : "Waiting"}</span>;
  const p = copy.progress;
  const line = !p
    ? "Starting..."
    : p.stage === "building"
      ? `Copying: ${p.done} of ${p.total} section${p.total === 1 ? "" : "s"} built`
      : p.stage === "checking"
        ? `Checking all ${p.total} sections against the design`
        : `Rebuilding ${p.total} low-scoring section${p.total === 1 ? "" : "s"}: ${p.done} of ${p.total} done`;
  const percent = !p ? 0 : p.stage === "building" ? Math.round((p.done / Math.max(1, p.total)) * 80) : p.stage === "checking" ? 85 : 85 + Math.round((p.done / Math.max(1, p.total)) * 15);
  return (
    <span className="copy-progress" role="status">
      <span className="progress" role="progressbar" aria-label="Copying the page" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span style={{ width: `${Math.max(percent, 3)}%` }} />
      </span>
      <span className="hint hint-amber">{line}</span>
    </span>
  );
}
