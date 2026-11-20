"use client";

import { StopButton } from "@/components/ui/stop-button";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { applySafeFixesAction, signOffSeoAction, startSeoGoLiveCheckAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  The Senior SEO Manager's check before go-live (26 September 2026): the
  built pages checked (titles, descriptions, headings, schema, links, the
  sitemap, name/address/phone, alt text, speed, each page's keyword), safe
  fixes made for the team, the rest listed, and the SEO team's sign-off.
*/

export interface FindingView {
  key: string;
  page: string;
  problem: string;
  fix: string;
  safe: boolean;
  fixed: boolean;
}

export function SeoCheckCard(props: {
  projectId: string;
  canRun: boolean;
  canFix: boolean;
  canSignOff: boolean;
  hasBuild: boolean;
  estimateLine: string;
  state: "none" | "queued" | "working" | "done" | "failed";
  checkId: string | null;
  /** "Version 2, checked when." */
  doneLine: string | null;
  stale: boolean;
  summary: string | null;
  failure: string | null;
  findings: FindingView[];
  /** "Signed off by Sam, when: note". */
  signedOffLine: string | null;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"run" | "signoff" | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const working = props.state === "queued" || props.state === "working";

  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [working, router]);

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

  const safeOpen = props.findings.filter((f) => f.safe && !f.fixed).length;
  const forTeam = props.findings.filter((f) => !f.safe);

  return (
    <div className="card content-card">
      <div className="content-card-head">
        <div>
          <h2 className="card-title">SEO check before go-live</h2>
          <p className="hint">
            The Senior SEO Manager checks the built site: titles, descriptions, headings, schema, internal links, the sitemap,
            name/address/phone, alt text, speed, and whether each page targets its planned keyword. Safe fixes are made for
            you; the rest are listed. The SEO team signs off before go-live.
          </p>
        </div>
        {props.canRun && props.hasBuild && !working ? (
          <Button variant={props.state === "done" ? "secondary" : "primary"} disabled={busy} onClick={() => setDialog("run")}>
            {props.state === "done" ? "Check again" : "Run the SEO check"}
          </Button>
        ) : null}
      </div>
      {!props.hasBuild ? <p className="hint">Build the site first.</p> : null}
      {props.state !== "done" && !working && props.hasBuild ? <p className="hint">{props.estimateLine}</p> : null}
      {working ? (
        <div className="stop-line">
          <p className="hint content-warn">Checking the site... this page refreshes itself.</p>
          {props.canRun ? <StopButton projectId={props.projectId} kind="seo_golive" what="the SEO check" /> : null}
        </div>
      ) : null}
      {props.state === "failed" && props.failure ? <p className="hint-error">{props.failure}</p> : null}
      {error ? <p className="hint-error">{error}</p> : null}

      {props.state === "done" ? (
        <>
          {props.doneLine ? <p className="content-done-line">{props.doneLine}</p> : null}
          {props.stale ? <p className="hint content-warn">A newer build exists: check it again before signing off.</p> : null}
          {props.summary ? <p>{props.summary}</p> : null}
          <ul className="seo-checks seo-checks-wide">
            {props.findings.map((f) => (
              <li key={f.key}>
                <span className={f.fixed ? "badge badge-done" : f.safe ? "badge badge-warning" : "badge badge-missing"}>{f.fixed ? "Fixed" : f.safe ? "Safe fix" : "For the team"}</span>
                <div>
                  <p className="seo-check-label">
                    {f.page}: {f.problem}
                  </p>
                  <p className="hint">{f.fix}</p>
                </div>
              </li>
            ))}
            {props.findings.length === 0 ? <li className="hint">Nothing found.</li> : null}
          </ul>
          <div className="copy-pack">
            <div>
              <p className="copy-pack-title">{props.signedOffLine ? "Signed off" : "Sign-off"}</p>
              <p className={props.signedOffLine ? "hint content-done" : "hint"}>
                {props.signedOffLine ??
                  `${safeOpen ? `${safeOpen} safe fix${safeOpen === 1 ? "" : "es"} to make (titles and descriptions go into the plan; content goes into a monthly-edit request). ` : ""}${forTeam.length ? `${forTeam.length} for the team to judge. ` : ""}The SEO team signs off this version before go-live.`}
              </p>
            </div>
            <div className="money-row-actions">
              {props.canFix && safeOpen > 0 && props.checkId ? (
                <Button small disabled={busy} onClick={() => run(() => applySafeFixesAction(props.projectId, props.checkId!))}>
                  Apply the safe fixes
                </Button>
              ) : null}
              {props.canSignOff && !props.signedOffLine && !props.stale && props.checkId ? (
                <Button variant="primary" small disabled={busy} onClick={() => setDialog("signoff")}>
                  Sign off for go-live
                </Button>
              ) : null}
            </div>
          </div>
        </>
      ) : null}

      {dialog === "run" ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="seo-check-title">
            <h2 className="section-title" id="seo-check-title">
              Run the SEO check?
            </h2>
            <p className="hint">TAWD&rsquo;s checks run on the built pages first (free), then the Senior SEO agent reviews them with each page&rsquo;s planned keyword.</p>
            <p className="hint">{props.estimateLine}</p>
            <div className="modal-actions">
              <Button onClick={() => setDialog(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => run(() => startSeoGoLiveCheckAction(props.projectId))}>
                {busy ? "Starting..." : "Run it"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {dialog === "signoff" ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="signoff-title">
            <h2 className="section-title" id="signoff-title">
              Sign off this version for go-live?
            </h2>
            <p className="hint">Recorded with your name, the time and the version. A later build needs checking and signing off again.</p>
            <div className="field">
              <label className="field-label" htmlFor="signoff-note">
                <span>Note (optional)</span>
              </label>
              <textarea id="signoff-note" className="textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            {error ? <p className="hint-error">{error}</p> : null}
            <div className="modal-actions">
              <Button onClick={() => setDialog(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => run(() => signOffSeoAction(props.projectId, props.checkId!, note))}>
                {busy ? "Signing off..." : "Sign off"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
