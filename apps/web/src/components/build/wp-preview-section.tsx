"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { showWpLoginAction, wpPreviewAction, checkPreviewFormAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { TWENTYI_PLAN } from "@tawd/core/twentyi-plan";

export interface WpPreviewStepView {
  key: string;
  label: string;
  state: "waiting" | "working" | "done" | "failed" | "warn";
  detail: string | null;
}

export interface WpPreviewSectionProps {
  projectId: string;
  state: "none" | "deploying" | "ready" | "failed" | "removing" | "removed";
  /** The address the team opens; null until the package exists (no preview domain). */
  host: string | null;
  /** 20i's own address (reduced-capacity servers): a fallback link. */
  stagingHost?: string | null;
  /** The preview is 20i's staging address: the speed gate can't measure it. */
  onStaging?: boolean;
  /** Its package is named after the client's domain: Remove, then Deploy again, reaches the preview domain (0.119.0). */
  needsFreshPackage?: boolean;
  /** The same, but the client's domain is already on the package: it stays where it is. */
  keepsLegacyPackage?: boolean;
  /** WP_PREVIEW_DOMAIN, when set. */
  previewDomain?: string | null;
  ipv4?: string | null;
  version: number | null;
  deployedVersion: number | null;
  latestBuild: number | null;
  https: boolean;
  steps: WpPreviewStepView[];
  /** The last run was a removal (its steps are the removal's). */
  removing: boolean;
  blockers: string[];
  canDeploy: boolean;
  isAdmin: boolean;
  /** "Deploying version 4, started by Jason Braganza." / "Version 4 is on the preview, deployed ... by ..." */
  statusLine: string | null;
  /** B3: the client's domain once the site is live on it. */
  liveDomain?: string | null;
  /** Gravity Forms sites: the form check by hand (the weekly check's own), and its last result. */
  formCheck?: { status: string; at: string; detail: string | null } | null;
  gravityForms?: boolean;
  /** 20i: suspended by an admin (a client who stopped paying). */
  suspended?: boolean;
  suspendedLine?: string | null;
  /** The preview domain's own certificate (D1 option B). */
  previewCert?: { state: "requested" | "installing" | "ok" | "failed"; note: string | null; expires: string | null; /** A lost request, or TAWD's certificate still not served two hours after it was installed. */ retry?: boolean } | null;
  /** A new package now would go past VML's 20i plan: an admin confirms the price first. */
  needsLimitConfirm?: boolean;
  packagesUsed?: number | null;
  /** VML's 20i plan: its name, its limit and the plan past it with its price ("Reseller 50 ($39.99 a month)"). */
  plan?: { name: string; limit: number; next: string };
  /** A preview left from Bluehost (5 October 2026). */
  fromBluehost?: boolean;
  /** Suspend or Restore asked for and not answered yet. */
  suspendPending?: "suspend" | "restore" | null;
  /** 20i refused the last Suspend or Restore: why. */
  suspendRefused?: string | null;
  /** The last move between 20i's address and the preview domain (12 October 2026). */
  move?: { state: "checking" | "loads" | "moved_back" | "refused" | "move_back_failed"; to: string | null; reason: string | null } | null;
}

const STEP_BADGE: Record<WpPreviewStepView["state"], { cls: string; text: string }> = {
  done: { cls: "badge badge-done", text: "Done" },
  working: { cls: "badge badge-info", text: "Working" },
  waiting: { cls: "badge badge-info", text: "Waiting" },
  failed: { cls: "badge badge-missing", text: "Failed" },
  warn: { cls: "badge badge-warning", text: "Check" },
};

type Act = "deploy" | "remove" | "https" | "preview_cert" | "confirm_limit" | "suspend" | "restore" | "purge";

/*
  Build B, B2 (1 October 2026): the WordPress preview, inside the Hosting
  card; on 20i since 5 October 2026, each site in its own hosting package.
  Deploy, deploy again, remove; the steps as the worker does them; Check
  HTTPS; the WordPress login for admins (logged each time it's shown);
  admins also confirm a package past VML's 20i plan, suspend or restore the site, and
  purge 20i's cache.
*/
export function WpPreviewSection(props: WpPreviewSectionProps) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<null | "remove" | "suspend" | "limit">(null);
  const [login, setLogin] = useState<{ url: string; user: string; password: string } | null>(null);
  const working = props.state === "deploying" || props.state === "removing";

  // Also while a Suspend or Restore is with 20i, so the answer shows without a reload.
  const waiting = working || Boolean(props.suspendPending);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => router.refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [waiting, router]);

  const act = (what: Act) =>
    start(async () => {
      setError(null);
      const result = await wpPreviewAction(props.projectId, what);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setConfirming(null);
      router.refresh();
    });

  const blocked = props.blockers.length > 0;
  const atHost = props.state === "ready" || (props.state === "failed" && !props.removing && props.deployedVersion !== null);
  const showSteps = working || props.state === "failed" || (props.state === "ready" && props.steps.some((s) => s.state === "warn"));
  const address = props.liveDomain ?? props.host;
  const certWaiting = props.previewCert && props.previewCert.state !== "ok";

  return (
    <div className="hosting-package">
      <p className="content-done-line">{props.liveDomain ? "WordPress site (live)" : "WordPress preview"}</p>
      {props.state === "none" || props.state === "removed" ? (
        <p className="hint">
          Makes the site its own 20i hosting package
          {props.host ? ` at ${props.host}` : " (at 20i's private address for it)"}: its own files, database and WordPress, hidden from search engines. Free (it uses one of the {TWENTYI_PLAN.limit} packages on VML&rsquo;s {TWENTYI_PLAN.name} plan), no AI, about 3 to 5 minutes.
        </p>
      ) : null}
      {props.fromBluehost ? <p className="hint-amber">This preview was on Bluehost, which TAWD no longer uses. Remove it here (nothing is called), then deploy it again on 20i.</p> : null}
      {props.statusLine ? <p className="hint">{props.statusLine}</p> : null}
      {props.suspendedLine ? <p className="hint-amber">{props.suspendedLine}</p> : null}

      {props.state === "ready" && address ? (
        <>
          <div className="row">
            <a className="btn btn-secondary" href={`https://${address}/`} target="_blank" rel="noopener">
              {props.liveDomain ? "Open the site ↗" : "Open the preview ↗"}
            </a>
            {props.stagingHost && props.stagingHost !== address && !props.liveDomain && (!props.https || certWaiting) ? (
              <a className="btn btn-text" href={`https://${props.stagingHost}/`} target="_blank" rel="noopener">
                20i&rsquo;s own address ↗
              </a>
            ) : null}
          </div>
          {props.ipv4 ? <p className="hint">At 20i, IP {props.ipv4}.</p> : null}
          {props.move?.state === "checking" && props.move.to === address ? (
            <p className="hint">
              Moved here from 20i&rsquo;s address. TAWD opens it every 5 minutes for up to an hour (half an hour more while a new certificate shows) and gets a failed certificate again by itself; if it doesn&rsquo;t load over HTTPS by then, TAWD moves it back to 20i&rsquo;s address by itself.
            </p>
          ) : null}
          {props.move?.state === "move_back_failed" && props.move.to === address ? <p className="hint-error">TAWD couldn&rsquo;t move this preview back to 20i&rsquo;s address: {props.move.reason}. Deploy again.</p> : null}
          {props.onStaging && props.needsFreshPackage ? (
            <p className="hint-amber">
              This preview is on 20i&rsquo;s staging address, which runs on slower servers: the Speed check can&rsquo;t measure it, so a founder lets the build go live.
              Its 20i package is named after the client&rsquo;s domain, and 20i says the preview address can&rsquo;t be added to it. To put it on {props.previewDomain}:
              Remove the preview (Hosting), then Deploy again. TAWD makes a package named after the preview address, with the same pages and pictures ($0, no AI).
            </p>
          ) : props.onStaging && props.keepsLegacyPackage ? (
            <p className="hint-amber">
              This preview is on 20i&rsquo;s staging address, which runs on slower servers: the Speed check can&rsquo;t measure it, so a founder lets the build go live.
              Its 20i package is named after the client&rsquo;s domain, and that domain is already on the package, so TAWD leaves it where it is. Don&rsquo;t remove
              it to move it: the client&rsquo;s records and the certificate would have to be done again.
            </p>
          ) : props.onStaging && (props.move?.state === "moved_back" || props.move?.state === "refused") ? (
            <p className="hint-amber">
              {props.move.state === "moved_back" ? `TAWD moved this preview back to 20i's address: ${props.move.reason ?? "it didn't load"}. ` : `This preview stayed on 20i's address:${props.move.reason ? ` ${props.move.reason}` : ""} `}
              Deploy again tries {props.move.to ?? "the preview domain"} again. On 20i&rsquo;s address the Speed check can&rsquo;t measure it, so a founder lets the build go live.
            </p>
          ) : props.onStaging ? (
            <p className="hint-amber">
              This preview is on 20i&rsquo;s staging address, which runs on slower servers: the Speed check can&rsquo;t measure it, so a founder lets the build go live.{" "}
              {props.previewDomain ? `Deploy again moves it to ${props.previewDomain}, on 20i's real servers.` : "A VML preview domain (WP_PREVIEW_DOMAIN) puts previews on the real servers."}
            </p>
          ) : null}
          {props.https && !certWaiting ? (
            <p className="hint">HTTPS is on{props.previewCert?.expires ? ` (certificate until ${props.previewCert.expires})` : ""}.</p>
          ) : (
            <p className="hint-amber">
              {props.previewCert?.note ?? "HTTPS isn't confirmed on the preview yet."}{" "}
              {props.canDeploy ? (
                <button type="button" className="btn btn-text" disabled={busy} onClick={() => act("https")}>
                  Check HTTPS
                </button>
              ) : null}
              {props.canDeploy && (props.previewCert?.state === "failed" || props.previewCert?.retry) ? (
                <button type="button" className="btn btn-text" disabled={busy} onClick={() => act("preview_cert")}>
                  Get the certificate again
                </button>
              ) : null}
            </p>
          )}
        </>
      ) : null}

      {showSteps ? (
        <ul className="seo-checks seo-checks-wide">
          {props.steps.map((s) => (
            <li key={s.key}>
              <span className={STEP_BADGE[s.state].cls}>{STEP_BADGE[s.state].text}</span>
              <div>
                <p className="seo-check-label">{s.label}</p>
                {s.detail ? <p className={s.state === "failed" ? "hint-error" : "hint"}>{s.detail}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {working ? <p className="hint">This page refreshes itself.</p> : null}

      {blocked && !working && props.canDeploy ? <p className="hint-amber">{props.blockers[0]}</p> : null}
      {props.needsLimitConfirm && !working ? (
        <p className="hint-amber">
          VML&rsquo;s 20i account has {props.packagesUsed} of {props.plan?.limit} packages: this site would move it to {props.plan?.next}.{" "}
          {props.isAdmin ? (
            <button type="button" className="btn btn-text" disabled={busy} onClick={() => setConfirming("limit")}>
              Confirm site {(props.plan?.limit ?? 0) + 1}
            </button>
          ) : (
            "An admin confirms it here first."
          )}
        </p>
      ) : null}
      {error ? <p className="hint-error">{error}</p> : null}
      {props.suspendRefused && !props.suspendPending ? <p className="hint-error">{props.suspendRefused}</p> : null}

      {props.canDeploy && !working ? (
        <div className="row">
          {props.state === "none" || props.state === "removed" ? (
            <Button variant="primary" disabled={busy || blocked || props.needsLimitConfirm} onClick={() => act("deploy")}>
              {busy ? "Starting..." : "Deploy the WordPress preview"}
            </Button>
          ) : props.state === "failed" ? (
            <Button variant="primary" disabled={busy || (blocked && !props.removing)} onClick={() => act(props.removing ? "remove" : "deploy")}>
              {busy ? "Starting..." : props.removing ? "Try removing again" : "Deploy again (carries on)"}
            </Button>
          ) : props.fromBluehost ? null : (
            <Button disabled={busy || blocked || props.suspended} onClick={() => act("deploy")}>
              {props.latestBuild !== null && props.deployedVersion !== null && props.latestBuild > props.deployedVersion ? `Deploy version ${props.latestBuild}` : "Deploy again"}
            </Button>
          )}
          {props.liveDomain && props.state === "ready" ? <p className="hint">Backs up the live site first (to TAWD&rsquo;s storage).</p> : null}
          {(atHost || props.fromBluehost) && (!props.liveDomain || props.isAdmin) ? (
            <button type="button" className="btn btn-text btn-danger" disabled={busy} onClick={() => setConfirming("remove")}>
              {props.liveDomain ? "Remove the site" : "Remove the preview"}
            </button>
          ) : null}
        </div>
      ) : null}

      {props.state === "ready" && !props.fromBluehost && (props.isAdmin || props.canDeploy) ? (
        <div className="row">
          {props.canDeploy ? (
            <button type="button" className="btn btn-text" disabled={busy} onClick={() => act("purge")}>
              Purge 20i&rsquo;s cache
            </button>
          ) : null}
          {props.isAdmin && props.suspendPending ? (
            <p className="hint">Asking 20i to {props.suspendPending} the site&hellip; refresh in a minute.</p>
          ) : props.isAdmin ? (
            props.suspended ? (
              <button type="button" className="btn btn-text" disabled={busy} onClick={() => act("restore")}>
                Restore the site
              </button>
            ) : (
              <button type="button" className="btn btn-text btn-danger" disabled={busy} onClick={() => setConfirming("suspend")}>
                Suspend the site
              </button>
            )
          ) : null}
        </div>
      ) : null}

      {props.state === "ready" ? (
        props.isAdmin ? (
          login ? (
            <div className="secret-box">
              <p className="hint">
                Login page: <a href={login.url} target="_blank" rel="noopener">{login.url}</a>
              </p>
              <p className="hint">
                User name: <code>{login.user}</code>
              </p>
              <div className="row">
                <code className="secret-value">{login.password}</code>
                <Button onClick={() => void navigator.clipboard?.writeText(login.password)}>Copy</Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-text"
              disabled={busy}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const result = await showWpLoginAction(props.projectId);
                  if (!result.ok) setError(result.message);
                  else setLogin(result.login);
                })
              }
            >
              Show the WordPress login
            </button>
          )
        ) : (
          <p className="hint">An admin can show the WordPress login.</p>
        )
      ) : null}

      {props.state === "ready" && props.gravityForms && !props.liveDomain ? (
        <div className="hosting-package">
          <p className="hint">
            {props.formCheck?.status === "received"
              ? `Form check: arrived in TAWD, ${props.formCheck.at}.`
              : props.formCheck?.status === "failed"
                ? `Form check: didn't go through, ${props.formCheck.at}. ${props.formCheck.detail ?? ""}`
                : props.formCheck?.status === "preview"
                  ? `Form check: sent ${props.formCheck.at}, waiting for it to arrive (refresh in a minute).`
                  : "Check the form: TAWD sends the weekly check through the preview's Gravity Forms form and sees it arrive. It isn't emailed to anyone and leaves no entry."}
          </p>
          {props.canDeploy ? (
            <button
              type="button"
              className="btn btn-text"
              disabled={busy}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const result = await checkPreviewFormAction(props.projectId);
                  if (!result.ok) setError(result.message);
                  router.refresh();
                })
              }
            >
              Check the form
            </button>
          ) : null}
        </div>
      ) : null}

      {confirming ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="wp-confirm-title">
            <h2 className="section-title" id="wp-confirm-title">
              {confirming === "remove" ? (props.liveDomain ? "Take the live WordPress site down?" : "Remove the WordPress preview?") : confirming === "suspend" ? "Suspend the WordPress site?" : `Confirm site ${(props.plan?.limit ?? 0) + 1} on 20i?`}
            </h2>
            <p className="hint">
              {confirming === "remove"
                ? props.fromBluehost
                  ? "Nothing is called: the preview is marked removed. If its folder and database are still in Bluehost's cPanel, remove them by hand."
                  : `Its 20i package goes, with its files, database and SSH access${props.liveDomain ? `, and ${props.liveDomain} stops working until it's put live again. The project leaves Live (it becomes Paused), so it can then be deleted if the client has left` : ""}. A 20i certificate bought for it has to be cancelled in My20i (20i's API can't; the step says so). The site in TAWD and its backups stay.`
                : confirming === "suspend"
                  ? "20i switches the package off: visitors don't see the site, and TAWD's daily and weekly checks skip it. Restore switches it back on. Logged."
                  : `VML's ${props.plan?.name} holds ${props.plan?.limit} packages. This site moves the account to ${props.plan?.next}, from 20i's next bill. Logged.`}
            </p>
            {error ? <p className="hint-error">{error}</p> : null}
            <div className="modal-actions">
              <Button onClick={() => setConfirming(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant={confirming === "limit" ? "primary" : "danger"} disabled={busy} onClick={() => act(confirming === "remove" ? "remove" : confirming === "suspend" ? "suspend" : "confirm_limit")}>
                {busy ? "Working..." : confirming === "remove" ? (props.liveDomain ? "Take it down" : "Remove the preview") : confirming === "suspend" ? "Suspend it" : "Confirm ($69.99 a month)"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
