"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { deployPreviewAction, recordPreviewDecisionAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  Build A, 8b: the go-live checklist of the latest build, and its preview
  on Netlify with the client's decision on the link.
*/

export function ChecklistCard(props: {
  version: number;
  items: { key: string; label: string; ok: boolean; detail: string; blocksGoLive: boolean; every?: string[] }[];
}) {
  const open = props.items.filter((i) => !i.ok);
  const blocking = open.filter((i) => i.blocksGoLive).length;
  return (
    <div className="card content-card">
      <h2 className="card-title">Go-live checklist</h2>
      <p className={blocking ? "hint content-warn" : "hint content-done"}>
        Version {props.version}: {props.items.length - open.length} of {props.items.length} done.
        {blocking ? ` ${blocking} still stop${blocking === 1 ? "s" : ""} the site going live; a preview can still go to the client.` : " Nothing stops it going live."}
      </p>
      <ul className="seo-checks">
        {props.items.map((item) => (
          <li key={item.key}>
            <span className={item.ok ? "badge badge-done" : item.blocksGoLive ? "badge badge-missing" : "badge badge-warning"}>{item.ok ? "Done" : item.blocksGoLive ? "To do" : "Check"}</span>
            <div>
              <p className="seo-check-label">{item.label}</p>
              <p className="hint">{item.detail}</p>
              {item.every?.length ? (
                <details className="hint">
                  <summary>All {item.every.length} changes, in full</summary>
                  <ul>
                    {item.every.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PreviewCard(props: {
  projectId: string;
  canDeploy: boolean;
  /** Coolify variables still missing. */
  missing: string[];
  hasBuild: boolean;
  /** "Version 2 is the latest build; the preview shows version 1." */
  staleLine: string | null;
  /** Staged builds (6 October 2026): "12 of 49 pages built in version 4: the others show a "Coming soon" page..." */
  partialLine?: string | null;
  uploading: boolean;
  deploys: { id: string; line: string; url: string | null; state: "uploading" | "ready" | "failed"; error: string | null; warning?: string | null }[];
  site: { url: string; formEmails: string[] } | null;
  decisionLine: string | null;
  decisionChanges: boolean;
  /*
    A WordPress project (8 October 2026): no Netlify preview here (it was
    an unused second copy that invited the wrong deploy); this card keeps
    only the client's decision, on the WordPress preview.
  */
  wordpress?: { ready: boolean } | null;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"deploy" | "decision" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, start] = useTransition();
  const [decision, setDecision] = useState({ outcome: "approved" as "approved" | "changes_requested", channel: "phone call", clientSaid: "" });

  useEffect(() => {
    if (!props.uploading) return;
    const timer = window.setInterval(() => router.refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [props.uploading, router]);

  const run = (action: () => Promise<{ ok: true } | { ok: false; message: string }>) =>
    start(async () => {
      setError(null);
      const result = await action();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setDialog(null);
      router.refresh();
    });
  const wp = props.wordpress ?? null;
  const latest = props.deploys[0];
  const ready = wp ? wp.ready : latest?.state === "ready";
  // What the client opens: the finished deploy's own address (29 September 2026).
  const shareUrl = (ready ? latest?.url : null) ?? props.site?.url ?? "";

  const decisionDialog = () => (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="preview-decision-title">
            <h2 className="section-title" id="preview-decision-title">
              Record the client&rsquo;s decision on the preview
            </h2>
            <fieldset className="field">
              <legend className="field-label">
                <span>What did the client decide?</span>
              </legend>
              <label className="radio-line">
                <input type="radio" name="preview-outcome" checked={decision.outcome === "approved"} onChange={() => setDecision((d) => ({ ...d, outcome: "approved" }))} />
                Approved the site
              </label>
              <label className="radio-line">
                <input type="radio" name="preview-outcome" checked={decision.outcome === "changes_requested"} onChange={() => setDecision((d) => ({ ...d, outcome: "changes_requested" }))} />
                Asked for changes
              </label>
            </fieldset>
            <div className="field">
              <label className="field-label" htmlFor="preview-channel">
                <span>How it came in</span>
              </label>
              <select id="preview-channel" className="select" value={decision.channel} onChange={(e) => setDecision((d) => ({ ...d, channel: e.target.value }))}>
                <option value="phone call">Phone call</option>
                <option value="email">Email</option>
                <option value="meeting">Meeting</option>
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="preview-said">
                <span>What the client said</span>
                <span className="field-required">Required</span>
              </label>
              <textarea id="preview-said" className="textarea" rows={3} value={decision.clientSaid} onChange={(e) => setDecision((d) => ({ ...d, clientSaid: e.target.value }))} />
              <p className="hint">Recorded in the activity log with the version they saw, your name and the time.</p>
            </div>
            {error ? <p className="hint-error">{error}</p> : null}
            <div className="modal-actions">
              <Button onClick={() => setDialog(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy || decision.clientSaid.trim().length < 3} onClick={() => run(() => recordPreviewDecisionAction(props.projectId, decision))}>
                {busy ? "Saving..." : "Record the decision"}
              </Button>
            </div>
          </div>
        </div>
  );

  if (wp) {
    return (
      <div className="card content-card">
        <h2 className="card-title">The client&rsquo;s decision on the preview</h2>
        {ready ? (
          <div className="copy-pack">
            <div>
              <p className="hint">Send the client the WordPress preview link (above), then record what they said. It&rsquo;s kept with the version they saw.</p>
              {props.decisionLine ? <p className={props.decisionChanges ? "hint content-warn" : "hint content-done"}>{props.decisionLine}</p> : null}
            </div>
            {props.canDeploy ? (
              <Button variant="primary" small onClick={() => setDialog("decision")}>
                Record the client&rsquo;s decision
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="hint">Deploy the WordPress preview first: the client decides on what they can open.</p>
        )}
        {error ? <p className="hint-error">{error}</p> : null}
        {dialog === "decision" ? decisionDialog() : null}
      </div>
    );
  }

  return (
    <div className="card content-card">
      <div className="content-card-head">
        <div>
          <h2 className="card-title">Preview</h2>
          <p className="hint">
            The site on Netlify, for the team and the client to check before go-live. Kept out of search engines until then. Free:
            no AI.
          </p>
        </div>
        {props.canDeploy && !props.uploading ? (
          <Button variant={props.deploys.length ? "secondary" : "primary"} disabled={busy || props.missing.includes("NETLIFY_AUTH_TOKEN") || !props.hasBuild} onClick={() => setDialog("deploy")}>
            {props.deploys.length ? "Deploy again" : "Deploy a preview"}
          </Button>
        ) : null}
      </div>
      {props.missing.map((name) => (
        <p key={name} className="hint content-warn">
          {name === "NETLIFY_AUTH_TOKEN" ? "Netlify isn't set up yet: an admin adds NETLIFY_AUTH_TOKEN in Coolify." : "Form emails won't copy VML until an admin adds NETLIFY_FORM_COPY_EMAIL in Coolify."}
        </p>
      ))}
      {!props.hasBuild ? <p className="hint">Build the site first.</p> : null}
      {props.staleLine ? <p className="hint content-warn">{props.staleLine}</p> : null}
      {props.partialLine ? <p className="hint content-warn">{props.partialLine}</p> : null}
      {props.uploading ? <p className="hint content-warn">Uploading to Netlify... this page refreshes itself.</p> : null}
      {error ? <p className="hint-error">{error}</p> : null}

      {props.site ? (
        <p className="hint">
          Netlify site: <a href={props.site.url} target="_blank" rel="noopener">{props.site.url}</a> (it shows the site only from go-live; each preview has its own address). Form messages go to {props.site.formEmails.length ? props.site.formEmails.join(" and ") : "nobody yet (no email in the intake)"}.
        </p>
      ) : null}

      {props.deploys.length ? (
        <ul className="deploy-list">
          {props.deploys.slice(0, 5).map((d) => (
            <li key={d.id}>
              <span className={d.state === "ready" ? "badge badge-done" : d.state === "failed" ? "badge badge-missing" : "badge badge-warning"}>
                {d.state === "ready" ? "Live preview" : d.state === "failed" ? "Failed" : "Uploading"}
              </span>
              <span>{d.line}</span>
              {d.url ? (
                <a href={d.url} target="_blank" rel="noopener">
                  Open
                </a>
              ) : null}
              {d.error ? <span className="hint-error">{d.error}</span> : null}
              {d.warning ? <span className="hint content-warn">{d.warning}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {ready && (latest?.url ?? props.site) ? (
        <div className="share-review">
          <p className="copy-pack-title">Share for review</p>
          <p className="hint">
            Send this link to the client or the team: only people with it can see the preview, and it&rsquo;s kept out of search engines until go-live.
          </p>
          <p className="share-review-row">
            <code>{shareUrl}</code>
            <Button
              small
              onClick={() => {
                void navigator.clipboard?.writeText(shareUrl).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy the link"}
            </Button>
          </p>
        </div>
      ) : null}

      {ready ? (
        <div className="copy-pack">
          <div>
            <p className="copy-pack-title">The client&rsquo;s decision on the preview</p>
            <p className="hint">Send the client the preview link, then record what they said. It&rsquo;s kept with the version they saw.</p>
            {props.decisionLine ? <p className={props.decisionChanges ? "hint content-warn" : "hint content-done"}>{props.decisionLine}</p> : null}
          </div>
          {props.canDeploy ? (
            <Button variant="primary" small onClick={() => setDialog("decision")}>
              Record the client&rsquo;s decision
            </Button>
          ) : null}
        </div>
      ) : null}

      {dialog === "deploy" ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="deploy-title">
            <h2 className="section-title" id="deploy-title">
              Deploy the latest build as a preview?
            </h2>
            <p className="hint">
              {props.site ? "It replaces what the preview link shows; Netlify keeps the earlier deploys." : "The client's site is created on VML's Netlify account, with form detection on and form messages emailed to the client and VML."}{" "}
              Not public in search engines. Free: no AI.
            </p>
            <div className="modal-actions">
              <Button onClick={() => setDialog(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => run(() => deployPreviewAction(props.projectId))}>
                {busy ? "Starting..." : "Deploy"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {dialog === "decision" ? decisionDialog() : null}
    </div>
  );
}
