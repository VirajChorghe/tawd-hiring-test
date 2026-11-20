"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";

import {
  attachNetlifyDomainAction,
  checkEmailRecordsAction,
  checkHttpsAction,
  checkNameserversAction,
  checkRegistryAction,
  confirmDomainAction,
  confirmEmailRecordsAction,
  goLiveNowAction,
  wpGoLiveAction,
  wpRollbackAction,
  wpUndoRollbackAction,
  readEmailRecordsAction,
  recordBuildFeePaidAction,
  recordGa4Action,
  rollBackAction,
  setUpCloudflareAction,
  undoBuildFeePaidAction,
} from "@/app/actions";
import { Banner } from "@/components/ui/banner";
import { ConnectLookup, PATH_TEXT, PointRecords, type ConnectCardProps } from "@/components/build/connect-panels";
import { WpCertificateStep, WpHostStep, WpLiveSteps, type WpGoLiveProps } from "@/components/build/wp-golive-panels";
import { Button } from "@/components/ui/button";

/*
  Phase 9, go-live (28 September 2026): the Build page's Go live card.
  A guided checklist since 30 September 2026 (DESIGN.md "Build split"):
  the steps in order, only the current one open, with whose job it is;
  then the Launch card (blockers in red, founder flags in amber), Go live
  for founders and admins, and a one-click rollback.
*/

type Result = { ok: true } | { ok: false; message: string };

export interface GoLiveCardProps {
  projectId: string;
  canEdit: boolean;
  canGoLive: boolean;
  canMoney: boolean;
  cloudflareMissing: string[];
  fee: { line: string } | null;
  domainFromIntake: string | null;
  steps: {
    domain: { done: boolean; line: string; domain: string | null; registrar: string; registrant: string };
    email: { done: boolean; line: string; records: string[]; selectors: string[] };
    cloudflare: { done: boolean; line: string; nameservers: string[] };
    check: { done: boolean; line: string; results: { record: string; ok: boolean }[] };
    confirm: { done: boolean; line: string };
    netlify: { done: boolean; line: string };
    switched: { done: boolean; line: string };
    /** From RDAP and public DNS (28 September 2026): where the switch is made, and whether DNSSEC stops it. */
    registry: { registrar: string | null; registrarUrl: string | null; nameservers: string[]; dnssec: boolean | null; checkedLine: string; blocker: string | null } | null;
    https: { done: boolean; line: string };
    ga4: { done: boolean; line: string };
  };
  gate: { ready: boolean; blockers: string[]; flags: string[] };
  live: { line: string; url: string | null } | null;
  canRollBack: boolean;
  lastError: string | null;
  /** The assigned PMs' names, or "A PM": whose job the current step is. */
  pmLine: string;
  /** F3, Connect the domain: what TAWD found, the way it connects, the records and their check. */
  connect?: ConnectCardProps;
  /** B3: the WordPress site's go-live on 20i (Hosting is WordPress). */
  wordpress?: WpGoLiveProps | null;
}

interface Guided {
  key: string;
  title: string;
  done: boolean;
  line: string;
  /** What the step found, shown once it is reached (records, nameservers). */
  shown?: ReactNode;
  /** Its form and buttons: open only on the current step, or a done one opened again. */
  controls?: ReactNode;
  /** Can be done again once done ("Do again"). */
  again?: boolean;
}

/* Before F3's look-up. */
const NOT_LOOKED_UP: ConnectCardProps = { path: null, found: null, wanted: [], changes: [], checkLine: null, recordsOk: false, okLine: null, clientLinkLine: null, clientDoneLine: null, instructions: null, access: null, emailLine: "", locked: false };

export function GoLiveCard(props: GoLiveCardProps) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"golive" | "rollback" | "undo" | "fee" | null>(null);
  const s = props.steps;
  const [domain, setDomain] = useState({ domain: s.domain.domain ?? props.domainFromIntake ?? "", registrar: s.domain.registrar, registrant: s.domain.registrant, inClientsName: s.domain.done });
  const [selectors, setSelectors] = useState(s.email.selectors.join(", "));
  const [confirm, setConfirm] = useState({ confirmedWithProvider: false, note: "" });
  const [ga4, setGa4] = useState({ propertyId: "", measurementId: "", vmlIsEditor: false });
  const [fee, setFee] = useState({ paidOn: new Date().toISOString().slice(0, 10), method: "card", note: "" });
  // A done step opened again with "Do again".
  const [again, setAgain] = useState<string | null>(null);

  const run = (action: () => Promise<Result>) =>
    start(async () => {
      setError(null);
      const result = await action();
      if (!result.ok) setError(result.message);
      else {
        setDialog(null);
        setAgain(null);
      }
      router.refresh();
    });
  const id = props.projectId;
  const edit = props.canEdit && !busy;

  // F3: the way the domain connects decides the steps. Records (or access): no email copy, no Cloudflare, no nameservers.
  const c = props.connect ?? NOT_LOOKED_UP;
  const wp = props.wordpress ?? null;
  // A WordPress site on 20i (5 October 2026) can use any path, VML's Cloudflare included; before a path is chosen, the records.
  const recordsPath = c.path === "records" || c.path === "access" || (Boolean(wp) && c.path !== "vml_dns");
  // A project that started the nameserver steps before F3 counts as connected that way.
  const connectDone = Boolean(c.path && c.found) || (!c.path && s.email.done);

  // The domain steps, in order. The build fee and GA4 don't wait their turn.
  const allSteps: Guided[] = [
    {
      key: "domain",
      title: "The domain, in the client's name",
      done: s.domain.done,
      line: s.domain.line,
      again: !props.live,
      controls:
        edit && !props.live ? (
          <div className="golive-form">
            <input className="input" aria-label="Domain" placeholder="finleypest.com" value={domain.domain} onChange={(e) => setDomain({ ...domain, domain: e.target.value })} />
            <input className="input" aria-label="Registrar" placeholder="Registrar (GoDaddy, Namecheap...)" value={domain.registrar} onChange={(e) => setDomain({ ...domain, registrar: e.target.value })} />
            <input className="input" aria-label="Registrant" placeholder="Registrant, as the registrar shows it" value={domain.registrant} onChange={(e) => setDomain({ ...domain, registrant: e.target.value })} />
            <label className="checkline">
              <input type="checkbox" checked={domain.inClientsName} onChange={(e) => setDomain({ ...domain, inClientsName: e.target.checked })} />
              Registered in the client&rsquo;s name (checked at the registrar)
            </label>
            <Button small variant="primary" onClick={() => run(() => confirmDomainAction(id, domain))}>
              {s.domain.done ? "Save the domain again" : "Confirm the domain"}
            </Button>
          </div>
        ) : null,
    },
    {
      key: "connect",
      title: "Connect the domain",
      done: connectDone,
      line: c.path && c.found ? `${PATH_TEXT[c.path].label}${c.found.dns ? ` (DNS at ${c.found.dns})` : ""}.${recordsPath ? ` Email${c.found.email ? ` (${c.found.email})` : ""} isn't touched.` : ""}` : connectDone ? "The nameserver steps, started before this step existed." : "Who runs the domain's DNS and email, and the best way to connect it.",
      again: !props.live,
      controls: s.domain.done ? <ConnectLookup projectId={id} canEdit={props.canEdit} connect={c} /> : null,
    },
    {
      key: "host",
      title: "Put the domain on 20i",
      done: Boolean(wp?.onHost),
      line: wp?.onHost ? (wp.onHostLine ?? "On the site's 20i package.") : "The domain (and www) added to the site's own 20i package.",
      controls: wp ? <WpHostStep projectId={id} canEdit={props.canEdit} wp={wp} /> : null,
    },
    {
      key: "point",
      title: "Point the domain at the new site",
      done: c.recordsOk,
      line: c.recordsOk ? (c.okLine ?? "Pointing at the new site.") : c.path === "access" ? "The PM makes the two changes with the access the client gave; TAWD checks them." : "The client makes the two changes at their DNS provider (TAWD gives them a private page with the steps); TAWD checks them.",
      shown: !c.recordsOk && c.clientDoneLine ? <p className="hint">{c.clientDoneLine}</p> : null,
      controls: <PointRecords projectId={id} canEdit={props.canEdit} connect={c} />,
    },
    {
      key: "email",
      title: "Read the client's email records",
      done: s.email.done,
      line: s.email.line,
      again: !s.switched.done,
      shown: s.email.records.length ? <RecordList items={s.email.records} /> : null,
      controls:
        edit && s.domain.done && !s.switched.done ? (
          <div className="golive-form">
            <input className="input" aria-label="DKIM selectors" placeholder="DKIM selectors from the email provider, if any (comma-separated)" value={selectors} onChange={(e) => setSelectors(e.target.value)} />
            <Button small variant="primary" onClick={() => run(() => readEmailRecordsAction(id, selectors.split(",").map((x) => x.trim()).filter(Boolean)))}>
              {s.email.done ? "Read again" : "Read the email records"}
            </Button>
            <span className="hint">Free: public DNS only (MX, SPF, DMARC, the common DKIM selectors, autodiscover).</span>
          </div>
        ) : null,
    },
    {
      key: "cloudflare",
      title: "Set up Cloudflare",
      done: s.cloudflare.done,
      line: s.cloudflare.line,
      again: !s.switched.done,
      shown: s.cloudflare.nameservers.length ? <RecordList items={s.cloudflare.nameservers.map((n) => `Nameserver: ${n}`)} /> : null,
      controls:
        edit && s.email.done && !s.switched.done ? (
          <Button small variant="primary" disabled={props.cloudflareMissing.length > 0} onClick={() => run(() => setUpCloudflareAction(id))}>
            {s.cloudflare.done ? "Set up again" : "Set up the zone on Cloudflare"}
          </Button>
        ) : null,
    },
    {
      key: "check",
      title: "Check the email records on Cloudflare",
      done: s.check.done,
      line: s.check.line,
      again: !s.switched.done,
      shown: s.check.results.length ? (
        <ul className="golive-records">
          {s.check.results.map((r) => (
            <li key={r.record}>
              <span className={r.ok ? "badge badge-done" : "badge badge-missing"}>{r.ok ? "Matches" : "Missing"}</span> <code>{r.record}</code>
            </li>
          ))}
        </ul>
      ) : null,
      controls:
        edit && s.cloudflare.done && !s.switched.done ? (
          <Button small variant="primary" onClick={() => run(() => checkEmailRecordsAction(id))}>
            {s.check.results.length ? "Check again" : "Check the records"}
          </Button>
        ) : null,
    },
    {
      key: "confirm",
      title: "Confirm with the client's email provider",
      done: s.confirm.done,
      line: s.confirm.line,
      controls:
        edit && s.check.done && !s.confirm.done ? (
          <div className="golive-form">
            <label className="checkline">
              <input type="checkbox" checked={confirm.confirmedWithProvider} onChange={(e) => setConfirm({ ...confirm, confirmedWithProvider: e.target.checked })} />
              Confirmed with the client&rsquo;s email provider
            </label>
            <input className="input" aria-label="Who confirmed it and how" placeholder="Who confirmed it and how (for example: Google Workspace admin, by phone)" value={confirm.note} onChange={(e) => setConfirm({ ...confirm, note: e.target.value })} />
            <Button small variant="primary" onClick={() => run(() => confirmEmailRecordsAction(id, confirm))}>
              Record the confirmation
            </Button>
          </div>
        ) : null,
    },
    {
      key: "netlify",
      title: "Put the domain on the Netlify site",
      done: s.netlify.done,
      line: s.netlify.line,
      controls:
        edit && (s.cloudflare.done || (recordsPath && connectDone)) && !s.netlify.done ? (
          <Button small variant="primary" onClick={() => run(() => attachNetlifyDomainAction(id))}>
            Add the domain to Netlify
          </Button>
        ) : null,
    },
    {
      key: "switched",
      title: "Switch the nameservers at the registrar",
      done: s.switched.done,
      line: s.switched.line,
      controls: (
        <>
          {!s.switched.done && s.domain.done ? (
            <div className="golive-registry">
              {s.registry ? (
                <>
                  <p className="hint">
                    Registered with{" "}
                    {s.registry.registrarUrl ? (
                      <a href={s.registry.registrarUrl} target="_blank" rel="noreferrer">
                        {s.registry.registrar ?? "the registrar"}
                      </a>
                    ) : (
                      <strong>{s.registry.registrar ?? "an unknown registrar (RDAP didn't say)"}</strong>
                    )}
                    . Nameservers now: {s.registry.nameservers.length ? s.registry.nameservers.join(", ") : "not listed"}.{" "}
                    <span className={s.registry.dnssec === true ? "badge badge-missing" : s.registry.dnssec === false ? "badge badge-done" : "badge badge-info"}>
                      {s.registry.dnssec === true ? "DNSSEC on" : s.registry.dnssec === false ? "DNSSEC off" : "DNSSEC unknown"}
                    </span>
                  </p>
                  {s.registry.blocker ? <p className="hint-error">{s.registry.blocker}</p> : null}
                  <p className="hint">{s.registry.checkedLine}</p>
                </>
              ) : (
                <p className="hint">Before the switch: where the domain is registered (that&rsquo;s where the switch is made) and whether DNSSEC is on, which has to be off first. Free.</p>
              )}
              {edit ? (
                <Button small variant="secondary" onClick={() => run(() => checkRegistryAction(id))}>
                  {s.registry ? "Check again" : "Check the registrar and DNSSEC"}
                </Button>
              ) : null}
            </div>
          ) : null}
          {!s.switched.done && s.cloudflare.nameservers.length ? (
            <p className="hint">
              {s.registry?.dnssec === true
                ? "Not yet: DNSSEC has to be off first (above)."
                : s.confirm.done
                  ? `At ${s.registry?.registrar || s.domain.registrar || "the registrar"}, the client (or the PM with their login) replaces the nameservers with: ${s.cloudflare.nameservers.join(" and ")}. Then check.`
                  : "Not yet: confirm the email records first. Switching before they're in place stops the client's email."}
            </p>
          ) : null}
          {edit && s.confirm.done && !s.switched.done ? (
            <Button small variant="primary" onClick={() => run(() => checkNameserversAction(id))}>
              Check the switch
            </Button>
          ) : null}
        </>
      ),
    },
    {
      key: "https",
      title: wp ? "HTTPS: the certificate" : "Confirm HTTPS",
      done: s.https.done,
      line: s.https.line,
      controls:
        wp ? (
          !s.https.done && wp.onHost ? <WpCertificateStep projectId={id} canEdit={props.canEdit} recordsOk={c.recordsOk || s.switched.done} wp={wp} /> : null
        ) : edit && (s.switched.done || c.recordsOk) && s.netlify.done && !s.https.done ? (
          <Button small variant="primary" onClick={() => run(() => checkHttpsAction(id))}>
            Check HTTPS
          </Button>
        ) : null,
    },
  ];
  const RECORDS_STEPS = wp ? ["domain", "connect", "host", "point", "https"] : ["domain", "connect", "netlify", "point", "https"];
  const NAMESERVER_STEPS = ["domain", "connect", "email", "cloudflare", "check", "confirm", wp ? "host" : "netlify", "switched", "https"];
  const domainSteps = (recordsPath ? RECORDS_STEPS : NAMESERVER_STEPS).map((key) => allSteps.find((x) => x.key === key)!);
  const currentKey = domainSteps.find((x) => !x.done)?.key ?? null;
  const done = domainSteps.filter((x) => x.done).length + (props.fee ? 1 : 0);
  const total = domainSteps.length + 1;

  return (
    <div className="golive-layout">
      <div className="card content-card golive-card">
        <div className="golive-head">
          <div>
            <h2 className="card-title">{props.live ? "Go live: done" : `Go live: ${done} of ${total} done`}</h2>
            <p className="hint">
              {wp && recordsPath
                ? "The client's domain, always registered in their name, stays where it is: two records point it at the WordPress site's own 20i package, and their email isn't touched. Each step is logged and posted to Slack."
                : wp
                ? "The client's domain, always registered in their name, moves to VML's Cloudflare and points at the WordPress site's 20i package. Their email records are copied and checked first. Each step is logged and posted to Slack."
                : recordsPath
                ? "The client's domain, always registered in their name, stays where it is: two records point it at the new site, and their email isn't touched. Each step is logged and posted to Slack."
                : "The client's domain, always registered in their name, moves to Cloudflare and points at the Netlify site. Their email records are copied and checked first. Each step is logged and posted to Slack."}
            </p>
          </div>
          {props.live ? <span className="badge badge-done">Live</span> : null}
        </div>

        {props.cloudflareMissing.length && !recordsPath ? (
          <Banner tone="warning" title="Cloudflare isn't set up yet">
            An admin adds {props.cloudflareMissing.join(" and ")} to the web app in Coolify.
          </Banner>
        ) : null}
        {error ? <Banner tone="error" title={error} /> : null}
        {props.lastError && !error ? <p className="hint hint-amber">{props.lastError}</p> : null}

        <ol className="golive-steps">
          <GuidedStep
            n={1}
            title="Build fee paid"
            line={props.fee ? props.fee.line : "Recorded by an admin or a founder when the $199 build fee is paid. The other steps can go ahead meanwhile."}
            state={props.fee ? "done" : "open"}
            who={props.fee ? null : "Waiting on: an admin or a founder"}
            extra={
              props.canMoney && props.fee ? (
                <Button small variant="text" disabled={busy} onClick={() => run(() => undoBuildFeePaidAction(id))}>
                  Take back
                </Button>
              ) : null
            }
          >
            {props.canMoney && !props.fee ? (
              <Button small variant="secondary" disabled={busy} onClick={() => setDialog("fee")}>
                Record build fee paid
              </Button>
            ) : null}
          </GuidedStep>
          {domainSteps.map((step, i) => {
            const state = step.done ? "done" : step.key === currentKey ? "current" : "later";
            const open = state === "current" || (state === "done" && again === step.key);
            return (
              <GuidedStep
                key={step.key}
                n={i + 2}
                title={step.title}
                line={step.line}
                state={state}
                who={state === "current" ? `Whose job: ${props.pmLine}` : null}
                extra={
                  state === "done" && step.again && step.controls && again !== step.key ? (
                    <Button small variant="text" onClick={() => setAgain(step.key)}>
                      Do again
                    </Button>
                  ) : null
                }
              >
                {state === "later" ? null : step.shown}
                {open ? step.controls : null}
              </GuidedStep>
            );
          })}
        </ol>

        <ol className="golive-steps golive-apart">
          <GuidedStep n={null} title="GA4: the client's property, VML as Editor" line={s.ga4.line} state={s.ga4.done ? "done" : "open"} who={null} badge="Not blocking">
            {edit && !s.ga4.done ? (
              <div className="golive-form">
                <input className="input" aria-label="GA4 property ID" placeholder="Property ID (digits)" value={ga4.propertyId} onChange={(e) => setGa4({ ...ga4, propertyId: e.target.value })} />
                <input className="input" aria-label="Measurement ID" placeholder="Measurement ID (G-...)" value={ga4.measurementId} onChange={(e) => setGa4({ ...ga4, measurementId: e.target.value })} />
                <label className="checkline">
                  <input type="checkbox" checked={ga4.vmlIsEditor} onChange={(e) => setGa4({ ...ga4, vmlIsEditor: e.target.checked })} />
                  The property is the client&rsquo;s own, and VML has Editor access
                </label>
                <Button small variant="secondary" onClick={() => run(() => recordGa4Action(id, ga4))}>
                  Record GA4
                </Button>
              </div>
            ) : null}
          </GuidedStep>
        </ol>
      </div>

      <div className="card content-card golive-launch">
        <h2 className="card-title">Launch</h2>
        <p className="hint">{props.live ? props.live.line : "Opens when every step is done."}</p>
        {props.gate.blockers.length ? (
          <div className="red-box">
            <p className="card-title">Before it can go live</p>
            <ul>
              {props.gate.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {props.gate.flags.length ? (
          <div className="amber-box">
            <p className="card-title">For the founders (not blocking)</p>
            <ul>
              {props.gate.flags.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {wp ? <WpLiveSteps wp={wp} /> : null}
        <div className="golive-actions">
          {props.canGoLive ? (
            <>
              <Button variant="primary" disabled={busy || !props.gate.ready} onClick={() => setDialog("golive")}>
                {props.live ? "Put the latest build live" : "Go live"}
              </Button>
              {wp ? (
                <>
                  {wp.hasBackup && wp.liveState === "live" ? (
                    <Button variant="danger" disabled={busy} onClick={() => setDialog("rollback")}>
                      Roll back
                    </Button>
                  ) : null}
                  {wp.undoLine && (wp.liveState === "live" || wp.liveState === "rolled_back") ? (
                    <Button variant="secondary" disabled={busy} onClick={() => setDialog("undo")}>
                      Undo the roll back
                    </Button>
                  ) : null}
                </>
              ) : props.canRollBack ? (
                <Button variant="secondary" disabled={busy} onClick={() => setDialog("rollback")}>
                  Roll back to the previous deploy
                </Button>
              ) : null}
            </>
          ) : (
            <p className="hint">Founders and admins press Go live.</p>
          )}
        </div>
      </div>

      {dialog === "golive" ? (
        <Dialog title="Put the site live?" onCancel={() => setDialog(null)}>
          <p className="hint">
            {wp
              ? `TAWD backs up the WordPress site (database and files), moves it from ${wp.previewHost} to https://${wp.domain ?? s.domain.domain}, and lets search engines in. Takes a few minutes; the card shows each step.`
              : `The latest build goes on ${s.domain.domain} with search engines allowed. Netlify keeps the previous deploy, so you can roll back in one click.`}
          </p>
          <Button variant="primary" disabled={busy} onClick={() => run(() => (wp ? wpGoLiveAction(id) : goLiveNowAction(id)))}>
            {busy ? "Going live..." : "Go live"}
          </Button>
        </Dialog>
      ) : null}
      {dialog === "rollback" ? (
        <Dialog title="Roll back the live site?" onCancel={() => setDialog(null)}>
          <p className="hint">
            {wp
              ? `Put the WordPress site back as it was ${wp.backupLine ?? "before the last change"}? Its database and files are restored from that backup${wp.backupLine?.includes("go-live") ? ", and it goes back to the preview address, hidden from search engines" : ""}. TAWD backs the site up as it is now first, so Undo the roll back can put it back.`
              : "Netlify publishes the previous live deploy again, straight away. The newer build stays in TAWD."}
          </p>
          <Button variant="danger" disabled={busy} onClick={() => run(() => (wp ? wpRollbackAction(id) : rollBackAction(id)))}>
            Roll back
          </Button>
        </Dialog>
      ) : null}
      {dialog === "undo" && wp ? (
        <Dialog title="Undo the roll back?" onCancel={() => setDialog(null)}>
          <p className="hint">Put the WordPress site back {wp.undoLine ?? "as it was before the Roll back"}? Its database and files are restored from the backup TAWD took just before the Roll back, on https://{wp.domain ?? s.domain.domain}.</p>
          <Button variant="danger" disabled={busy} onClick={() => run(() => wpUndoRollbackAction(id))}>
            Undo the roll back
          </Button>
        </Dialog>
      ) : null}
      {dialog === "fee" ? (
        <Dialog title="Record the build fee as paid?" onCancel={() => setDialog(null)}>
          <div className="golive-form">
            <input className="input" type="date" aria-label="Paid on" value={fee.paidOn} onChange={(e) => setFee({ ...fee, paidOn: e.target.value })} />
            <select className="select" aria-label="How it was paid" value={fee.method} onChange={(e) => setFee({ ...fee, method: e.target.value })}>
              {["card", "bank transfer", "check", "cash", "other"].map((m) => (
                <option key={m} value={m}>
                  {m.charAt(0).toUpperCase() + m.slice(1)}
                </option>
              ))}
            </select>
            <input className="input" aria-label="Note" placeholder="Note (optional: invoice number)" value={fee.note} onChange={(e) => setFee({ ...fee, note: e.target.value })} />
          </div>
          <Button variant="primary" disabled={busy} onClick={() => run(() => recordBuildFeePaidAction(id, fee))}>
            Record it
          </Button>
        </Dialog>
      ) : null}
    </div>
  );
}

/*
  One step of the guided checklist: done (a filled circle with a check),
  current (blue tint, whose job, its controls), later (muted, its name
  only), or open (the build fee and GA4, which don't wait their turn).
*/
function GuidedStep({
  n,
  title,
  line,
  state,
  who,
  badge,
  extra,
  children,
}: {
  n: number | null;
  title: string;
  line: string;
  state: "done" | "current" | "later" | "open";
  who: string | null;
  badge?: string;
  /** A text button beside the name ("Do again", "Take back"). */
  extra?: ReactNode;
  children?: ReactNode;
}) {
  const word = { done: "Done", current: "Now", later: "Later", open: "To do" }[state];
  return (
    <li className={`golive-step is-${state}`} aria-current={state === "current" ? "step" : undefined}>
      <span className={`golive-num is-${state}`} aria-hidden="true">
        {state === "done" ? <Check /> : (n ?? "")}
      </span>
      <div className="golive-step-body">
        <div className="golive-step-head">
          <span className="golive-step-name">{title}</span>
          {badge ? <span className="badge badge-info">{badge}</span> : null}
          <span className="visually-hidden">({word})</span>
          {extra}
        </div>
        {state === "later" ? null : <p className="hint">{line}</p>}
        {who ? <p className="golive-who">{who}</p> : null}
        {children}
      </div>
    </li>
  );
}

function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

function RecordList({ items }: { items: string[] }) {
  return (
    <ul className="golive-records">
      {items.map((r) => (
        <li key={r}>
          <code>{r}</code>
        </li>
      ))}
    </ul>
  );
}

function Dialog({ title, onCancel, children }: { title: string; onCancel: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="section-title">{title}</h2>
        {children}
        <div className="modal-actions">
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
