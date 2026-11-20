"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { recordLogoApprovalAction, startLogoSwapAction } from "@/app/actions";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";

/*
  The logo after approval (27 September 2026), on the approved Mockups
  page: put a changed logo into the approved concept (free, no AI, a new
  version), and record the client's approval of the logo.
*/
export function LogoAfterApprovalCard(props: {
  projectId: string;
  conceptLabel: string;
  version: number;
  logoChanged: boolean;
  swap: { status: string; toVersion: number | null; failureReason: string | null } | null;
  markLine: string;
  marked: boolean;
  canAct: boolean;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState(false);
  const [channel, setChannel] = useState("phone");
  const [said, setSaid] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const working = props.swap?.status === "queued" || props.swap?.status === "working";

  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [working, router]);

  return (
    <div className="card content-card">
      <div className="content-card-head">
        <div>
          <h2 className="card-title">The logo</h2>
          <p className={props.marked ? "hint content-done" : "hint"}>{props.markLine}</p>
        </div>
        {props.canAct ? (
          <Button small disabled={busy} onClick={() => setDialog(true)}>
            Record logo approval
          </Button>
        ) : null}
      </div>

      {props.logoChanged ? (
        <Banner
          title={`The logo changed after the client approved Concept ${props.conceptLabel} v${props.version}`}
          action={
            props.canAct ? (
              <Button
                variant="primary"
                small
                disabled={busy}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const result = await startLogoSwapAction(props.projectId);
                    if (!result.ok) setError(result.message);
                    else router.refresh();
                  })
                }
              >
                Put the new logo into the approved concept
              </Button>
            ) : undefined
          }
        >
          Free, no AI: a new version with only the logo changed, which becomes the approved one. The client DESIGN.md is written again.
        </Banner>
      ) : null}
      {working ? <p className="hint content-warn">Putting the new logo in... this page refreshes itself.</p> : null}
      {props.swap?.status === "done" && props.swap.toVersion && !props.logoChanged ? (
        <p className="hint">The new logo is in: Concept {props.conceptLabel} v{props.swap.toVersion} is the approved version.</p>
      ) : null}
      {props.swap?.status === "failed" ? <p className="hint-error">The new logo couldn&rsquo;t be put in: {props.swap.failureReason}</p> : null}
      {error ? <p className="hint-error">{error}</p> : null}

      {dialog ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="logo-approval-title">
            <h2 className="section-title" id="logo-approval-title">
              Record the client&rsquo;s approval of the logo
            </h2>
            <p className="hint">
              On Concept {props.conceptLabel} v{props.version}. Saved to the timeline with your name and the time.
            </p>
            <div className="field">
              <label className="field-label" htmlFor="logo-channel">
                <span>How it came in</span>
              </label>
              <select id="logo-channel" className="select" value={channel} onChange={(e) => setChannel(e.target.value)}>
                <option value="phone">Phone call</option>
                <option value="email">Email</option>
                <option value="meeting">Meeting</option>
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="logo-said">
                <span>What the client said</span>
              </label>
              <textarea id="logo-said" className="textarea" rows={3} value={said} onChange={(e) => setSaid(e.target.value)} placeholder="For example: happy with the new logo as it is on the homepage." />
            </div>
            {error ? <p className="hint-error">{error}</p> : null}
            <div className="modal-actions">
              <Button onClick={() => setDialog(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy || said.trim().length < 3}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const result = await recordLogoApprovalAction(props.projectId, { channel, clientSaid: said });
                    if (!result.ok) {
                      setError(result.message);
                      return;
                    }
                    setDialog(false);
                    setSaid("");
                    router.refresh();
                  })
                }
              >
                {busy ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
