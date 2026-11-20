"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { attachWpDomainAction, checkWpHttpsAction, confirmPaidCertificateAction, requestWpCertificateAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

export interface WpGoLiveProps {
  domain: string | null;
  previewHost: string;
  /** The domain is on the site's own 20i package. */
  onHost: boolean;
  onHostLine: string | null;
  /** 20i's reason when it didn't add the domain. */
  note: string | null;
  liveState: string | null;
  liveSteps: { key: string; label: string; state: "waiting" | "working" | "done" | "failed" | "warn"; detail: string | null }[];
  hasBackup: boolean;
  backupLine: string | null;
  /** Undo the roll back: the site as it was just before the last Roll back (null: nothing to undo). */
  undoLine?: string | null;
  /** How WordPress sites get HTTPS (System, 20i). */
  certPath: "letsencrypt" | "twentyi_paid" | "manual";
  /** The client's domain's certificate, as TAWD last saw it. */
  cert: { state: "requested" | "installing" | "ok" | "failed"; line: string; note: string | null; paidId: string | null; /** A lost request, or TAWD's own certificate still not served hours after it was installed: it can be asked for again. */ retry?: boolean } | null;
  /** 20i's certificate, per site and year. */
  paidPrice: number;
  isAdmin: boolean;
  /** The daily IP watch found the domain pointing somewhere else than 20i's current IP. */
  ipLine: string | null;
  suspended: boolean;
}

const BADGE = {
  done: { cls: "badge badge-done", text: "Done" },
  working: { cls: "badge badge-info", text: "Working" },
  waiting: { cls: "badge badge-info", text: "Waiting" },
  failed: { cls: "badge badge-missing", text: "Failed" },
  warn: { cls: "badge badge-warning", text: "Check" },
} as const;

function useRun() {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (work: () => Promise<{ ok: boolean; message?: string }>, after?: () => void) =>
    start(async () => {
      setError(null);
      const r = await work();
      if (!r.ok) setError(r.message ?? "It didn't work.");
      else after?.();
      router.refresh();
    });
  return { busy, error, run, router };
}

/* B3 on 20i, step "Put the domain on 20i": TAWD adds it (and www) to the site's own package. */
export function WpHostStep(props: { projectId: string; canEdit: boolean; wp: WpGoLiveProps }) {
  const { busy, error, run, router } = useRun();
  const w = props.wp;
  const attaching = w.liveState === "attaching";
  useEffect(() => {
    if (!attaching) return;
    const t = window.setInterval(() => router.refresh(), 4000);
    return () => window.clearInterval(t);
  }, [attaching, router]);
  if (w.onHost) return null;
  return (
    <div className="golive-form connect-point">
      {error ? <p className="hint-error">{error}</p> : null}
      <p className="hint">TAWD adds {w.domain ?? "the domain"} and www to the site&rsquo;s own 20i package: the same WordPress as the preview, not a copy.</p>
      {attaching ? <p className="hint">Adding it at 20i&hellip; this page refreshes itself.</p> : null}
      {w.note ? <p className="hint-error">{w.note}</p> : null}
      {props.canEdit && !attaching ? (
        <Button small variant="primary" disabled={busy} onClick={() => run(() => attachWpDomainAction(props.projectId))}>
          {w.note ? "Try again" : "Put the domain on 20i"}
        </Button>
      ) : null}
    </div>
  );
}

/*
  B3 on 20i, "HTTPS": the certificate for the client's domain, the way an
  admin chose on System, then Check HTTPS (TAWD opens the site as a browser
  would). 20i's paid certificate is bought only after an admin's confirm
  with its price (rule 9).
*/
export function WpCertificateStep(props: { projectId: string; canEdit: boolean; recordsOk: boolean; wp: WpGoLiveProps }) {
  const { busy, error, run } = useRun();
  const [buying, setBuying] = useState(false);
  const w = props.wp;
  const c = w.cert;
  const domain = w.domain ?? "the domain";
  // A request older than half an hour is taken as lost (the worker restarted): Try again shows instead (Fable's code review, finding 3).
  const working = c?.state === "requested" && !c.retry;
  const again = Boolean(c?.retry);
  return (
    <div className="golive-form connect-point">
      {error ? <p className="hint-error">{error}</p> : null}
      {c ? <p className={c.state === "failed" ? "hint-error" : c.state === "ok" ? "hint" : "hint-amber"}>{c.line}</p> : null}
      {c?.note && c.state !== "ok" ? <p className="hint">{c.note}</p> : null}
      {working ? <p className="hint">TAWD is getting the certificate; refresh in a minute.</p> : null}

      {w.certPath === "letsencrypt" ? (
        <>
          {!c ? <p className="hint">TAWD gets a free certificate from Let&rsquo;s Encrypt for {domain} and www once the records point at the site (it asks by itself when they first do), and installs it at 20i. 20i can take up to 30 minutes to show it.</p> : null}
          {props.canEdit && !working && (!c || c.state === "failed" || again) ? (
            <Button small variant="primary" disabled={busy || !props.recordsOk} onClick={() => run(() => requestWpCertificateAction(props.projectId))}>
              {c?.state === "installing" ? "Get the certificate again" : c?.state === "failed" || again ? "Try again" : "Get the certificate"}
            </Button>
          ) : null}
          {c?.state === "installing" && again ? <p className="hint">20i still isn&rsquo;t serving the certificate TAWD installed two hours ago: Get the certificate again issues and installs a new one.</p> : null}
        </>
      ) : w.certPath === "twentyi_paid" ? (
        <>
          {!c || c.state === "failed" ? (
            <p className="hint">This site uses 20i&rsquo;s certificate: ${w.paidPrice.toFixed(2)} a year, renewed by 20i until it&rsquo;s cancelled (20i&rsquo;s API can&rsquo;t cancel it: when the site is removed, an admin cancels it in My20i). An admin buys it.</p>
          ) : null}
          {w.isAdmin && props.canEdit && !working && (!c || c.state === "failed" || (again && c.state === "requested")) ? (
            <Button small variant="primary" disabled={busy} onClick={() => setBuying(true)}>
              Buy 20i&rsquo;s certificate (${w.paidPrice.toFixed(2)} a year)
            </Button>
          ) : null}
        </>
      ) : (
        <p className="hint">Certificates are installed by hand (System, 20i): in My20i, Manage hosting, SSL/TLS, install one for {domain} and www.{domain}, then Check HTTPS here.</p>
      )}

      {/* Only once the records point at the package: before that, https://{domain} is the client's old site (Fable's code review, finding 2). */}
      {props.canEdit && w.onHost && props.recordsOk && !working && c?.state !== "ok" ? (
        <Button small disabled={busy} onClick={() => run(() => checkWpHttpsAction(props.projectId))}>
          Check HTTPS
        </Button>
      ) : null}
      {!props.recordsOk && c?.state !== "ok" ? <p className="hint">The records have to point at the site first (Point the domain, above): until then {domain} still shows whatever answers there now.</p> : null}
      <p className="hint">Check HTTPS opens https://{domain} as a browser would and reads its certificate, once the records point at the site. TAWD also looks again once a day.</p>

      {buying ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="wp-cert-buy-title">
            <h2 className="section-title" id="wp-cert-buy-title">
              Buy 20i&rsquo;s certificate for {domain}?
            </h2>
            <p className="hint">
              ${w.paidPrice.toFixed(2)} a year on VML&rsquo;s 20i account, renewed by 20i every year until it&rsquo;s cancelled. TAWD can&rsquo;t cancel it through 20i&rsquo;s API: when this site is removed, an admin cancels it in My20i.
            </p>
            <p className="hint">The free way (TAWD&rsquo;s own Let&rsquo;s Encrypt certificate) is chosen on System, 20i.</p>
            {error ? <p className="hint-error">{error}</p> : null}
            <div className="modal-actions">
              <Button onClick={() => setBuying(false)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => run(() => confirmPaidCertificateAction(props.projectId), () => setBuying(false))}>
                {busy ? "Ordering..." : `Buy it ($${w.paidPrice.toFixed(2)} a year)`}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* B3: the go-live (or rollback) steps, as the worker does them, in the Launch card. */
export function WpLiveSteps({ wp }: { wp: WpGoLiveProps }) {
  const router = useRouter();
  const working = wp.liveState === "going_live" || wp.liveState === "rolling_back";
  useEffect(() => {
    if (!working) return;
    const t = window.setInterval(() => router.refresh(), 4000);
    return () => window.clearInterval(t);
  }, [working, router]);
  return (
    <>
      {wp.ipLine ? <p className="hint-amber">{wp.ipLine}</p> : null}
      {wp.suspended ? <p className="hint-amber">This site is suspended at 20i: visitors don&rsquo;t see it. An admin restores it (Hosting).</p> : null}
      {wp.liveSteps.length && (working || wp.liveState === "failed" || wp.liveState === "live" || wp.liveState === "rolled_back") ? (
        <>
          <ul className="seo-checks seo-checks-states">
            {wp.liveSteps.map((s) => (
              <li key={s.key}>
                <span className={BADGE[s.state].cls}>{BADGE[s.state].text}</span>
                <div>
                  <p className="seo-check-label">{s.label}</p>
                  {s.detail ? <p className={s.state === "failed" ? "hint-error" : "hint"}>{s.detail}</p> : null}
                </div>
              </li>
            ))}
          </ul>
          {working ? <p className="hint">This page refreshes itself.</p> : null}
        </>
      ) : null}
    </>
  );
}
