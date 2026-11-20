"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { chooseCertPathAction, choosePackageTypeAction, forgetServerKeyAction, makeTwentyiKeyAction, startTwentyiCheckAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  Build B on 20i (5 October 2026): System's 20i section, for admins. TAWD's
  own SSH key for 20i, Check the 20i account (a worker job: the API key is
  on the worker only), the package type TAWD makes sites with, how
  WordPress sites get HTTPS, and the server keys TAWD has remembered.
*/

type Result = { ok: true } | { ok: false; message: string };

function useRun() {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<Result>, after?: () => void) =>
    start(async () => {
      setError(null);
      const result = await action();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      after?.();
      router.refresh();
    });
  return { busy, error, run };
}

function Confirm(props: { id: string; title: string; body: string; action: string; busy: boolean; error: string | null; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={props.id}>
        <h2 className="section-title" id={props.id}>
          {props.title}
        </h2>
        <p className="hint">{props.body}</p>
        {props.error ? <p className="hint-error">{props.error}</p> : null}
        <div className="modal-actions">
          <Button onClick={props.onCancel} disabled={props.busy}>
            Cancel
          </Button>
          <Button variant="danger" disabled={props.busy} onClick={props.onConfirm}>
            {props.action}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* TAWD's SSH key for 20i: made here; each package gets it by API at its deploy (or Jason adds it once in My20i). */
export function TwentyiKeyCard(props: { publicKey: string | null; fingerprint: string | null; madeLine: string | null }) {
  const { busy, error, run } = useRun();
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="card content-card">
      <div className="content-card-head">
        <div>
          <h2 className="card-title">TAWD&rsquo;s 20i SSH key</h2>
          <p className="hint">
            TAWD signs in to each site&rsquo;s 20i package with its own key, never a password. The private half stays in TAWD, encrypted; it is never shown and never given to an AI.
            Each deploy adds the public half to the site&rsquo;s package through 20i&rsquo;s API.
          </p>
        </div>
        {props.publicKey ? (
          <Button disabled={busy} onClick={() => setConfirming(true)}>
            Replace the key
          </Button>
        ) : (
          <Button variant="primary" disabled={busy} onClick={() => run(() => makeTwentyiKeyAction(false))}>
            {busy ? "Making..." : "Make the key"}
          </Button>
        )}
      </div>
      {error && !confirming ? <p className="hint-error">{error}</p> : null}

      {props.publicKey ? (
        <div className="secret-box">
          <p className="field-label">
            <span>Public key</span>
          </p>
          <div className="row host-key-row">
            <code className="secret-value host-public-key">{props.publicKey}</code>
            <Button
              small
              onClick={() => {
                void navigator.clipboard?.writeText(props.publicKey!).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="hint host-fingerprint">
            Fingerprint <code>{props.fingerprint}</code>. {props.madeLine}
          </p>
          <p className="hint">If 20i only takes keys for the whole account (checked on the first day), add this public key once in My20i, Security, SSH keys. 20i says a new key can take up to 30 minutes to work.</p>
        </div>
      ) : null}

      {confirming ? (
        <Confirm
          id="twentyi-replace-title"
          title="Replace TAWD's 20i SSH key?"
          body="The current key stops working for TAWD at once. Each site's package gets the new key at its next deploy (Deploy again); if 20i only takes keys for the whole account, replace it in My20i too."
          action={busy ? "Replacing..." : "Replace the key"}
          busy={busy}
          error={error}
          onCancel={() => setConfirming(false)}
          onConfirm={() => run(() => makeTwentyiKeyAction(true), () => setConfirming(false))}
        />
      ) : null}
    </div>
  );
}

export interface CheckItemView {
  key: string;
  label: string;
  state: "yes" | "no" | "warn";
  detail: string;
}

const BADGE: Record<CheckItemView["state"], { cls: string; text: string }> = {
  yes: { cls: "badge badge-done", text: "Yes" },
  warn: { cls: "badge badge-warning", text: "Check" },
  no: { cls: "badge badge-missing", text: "No" },
};

/* "Check the 20i account": read-only calls to 20i's API, run by the worker; then the package type TAWD uses. */
export function TwentyiCheckCard(props: {
  keySet: boolean | null;
  state: "queued" | "working" | "done" | "failed" | null;
  doneLine: string | null;
  failure: string | null;
  items: CheckItemView[];
  types: { id: string; label: string }[];
  chosen: { id: string; label: string } | null;
  chosenLine: string | null;
}) {
  const router = useRouter();
  const { busy, error, run } = useRun();
  const working = props.state === "queued" || props.state === "working";
  const [typeId, setTypeId] = useState(props.chosen?.id ?? props.types[0]?.id ?? "");

  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [working, router]);

  return (
    <div className="card content-card">
      <div className="content-card-head">
        <div>
          <h2 className="card-title">Check the 20i account</h2>
          <p className="hint">The worker asks 20i&rsquo;s API, changing nothing: does TAWD&rsquo;s API key work, how many of VML&rsquo;s plan&rsquo;s packages are used, and which package types there are. Free, no AI.</p>
        </div>
        {!working ? (
          <Button variant={props.state === "done" ? "secondary" : "primary"} disabled={busy} onClick={() => run(() => startTwentyiCheckAction())}>
            {props.state === "done" ? "Check again" : "Check the 20i account"}
          </Button>
        ) : null}
      </div>
      {props.keySet === false ? <p className="hint-amber">The worker doesn&rsquo;t report TWENTYI_API_KEY yet: an admin adds it in Coolify on tawd-worker-new only (never the web app), then redeploys the worker.</p> : null}
      {working ? <p className="hint content-warn">Checking the account... this page refreshes itself.</p> : null}
      {props.state === "failed" && props.failure ? <p className="hint-error">{props.failure}</p> : null}
      {error ? <p className="hint-error">{error}</p> : null}

      {props.state === "done" ? (
        <>
          {props.doneLine ? <p className="content-done-line">{props.doneLine}</p> : null}
          <ul className="seo-checks seo-checks-wide">
            {props.items.map((item) => (
              <li key={item.key}>
                <span className={BADGE[item.state].cls}>{BADGE[item.state].text}</span>
                <div>
                  <p className="seo-check-label">{item.label}</p>
                  <p className="hint">{item.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {props.types.length ? (
        <div className="host-choice">
          <p className="field-label">
            <span>The package type TAWD makes sites with</span>
          </p>
          <select className="input" aria-label="Package type" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            {props.types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <div className="row">
            <Button small variant="primary" disabled={busy || !typeId} onClick={() => run(() => choosePackageTypeAction(typeId))}>
              {props.chosen ? "Save the choice" : "Use this type"}
            </Button>
          </div>
          {props.chosenLine ? <p className="hint">{props.chosenLine}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/* How WordPress sites get HTTPS (plan 3.4: decided on the first day with 20i). */
export function CertPathCard(props: { path: string; paths: { id: string; label: string; detail: string }[]; previewDomain: string | null; acmeStaging: boolean }) {
  const { busy, error, run } = useRun();
  return (
    <div className="card content-card">
      <h2 className="card-title">HTTPS for WordPress sites</h2>
      <p className="hint">
        20i&rsquo;s free certificate needs 20i&rsquo;s nameservers, which clients keep, so each site&rsquo;s certificate comes one of these ways. Whichever it is, TAWD&rsquo;s Check HTTPS on the Go live card confirms it, and TAWD warns 14 and 7 days before one runs out.
      </p>
      <fieldset className="field">
        <legend className="field-label">
          <span>The way TAWD uses</span>
        </legend>
        {props.paths.map((p) => (
          <label className="radio-line" key={p.id}>
            <input type="radio" name="cert-path" checked={props.path === p.id} disabled={busy} onChange={() => run(() => chooseCertPathAction(p.id))} />
            {p.label} <span className="hint">{p.detail}</span>
          </label>
        ))}
      </fieldset>
      {props.acmeStaging ? <p className="hint-amber">TWENTYI_ACME_STAGING is on: Let&rsquo;s Encrypt issues test certificates that browsers don&rsquo;t trust (first trials only).</p> : null}
      <p className="hint">
        {props.previewDomain
          ? `Previews live under ${props.previewDomain} (WP_PREVIEW_DOMAIN) with their own certificate, so the speed gate measures 20i's real servers.`
          : "No preview domain is set (WP_PREVIEW_DOMAIN): previews use 20i's staging address, which the speed gate can't measure."}
      </p>
      {error ? <p className="hint-error">{error}</p> : null}
    </div>
  );
}

/* The SSH servers TAWD has remembered (one key per server, required after the first sign-in). */
export function ServerKeysCard(props: { keys: { host: string; fingerprint: string; firstSeenAt: string; line: string }[] }) {
  const { busy, error, run } = useRun();
  const [forgetting, setForgetting] = useState<string | null>(null);
  return (
    <div className="card content-card">
      <h2 className="card-title">The servers TAWD trusts</h2>
      <p className="hint">Every 20i package in a data centre is reached through the same SSH server. TAWD remembers its key at the first sign-in and refuses any other after that, so nobody in between can pretend to be it.</p>
      {props.keys.length === 0 ? <p className="hint">None yet: the first deploy remembers it.</p> : null}
      {props.keys.map((k) => (
        <div className="host-host-key" key={k.host}>
          <p className="hint">{k.line}</p>
          <Button small variant="text" disabled={busy} onClick={() => setForgetting(k.host)}>
            Forget this server&rsquo;s key
          </Button>
        </div>
      ))}
      {forgetting ? (
        <Confirm
          id="server-forget-title"
          title={`Forget ${forgetting}'s key?`}
          body="Only when 20i says the server really changed. The next sign-in trusts whichever server answers, so check with 20i first. Logged."
          action={busy ? "Forgetting..." : "Forget it"}
          busy={busy}
          error={error}
          onCancel={() => setForgetting(null)}
          onConfirm={() => run(() => forgetServerKeyAction(forgetting), () => setForgetting(null))}
        />
      ) : null}
    </div>
  );
}
