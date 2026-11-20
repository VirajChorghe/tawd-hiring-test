"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { checkRecordsAction, choosePathAction, detectDomainAction, makeClientLinkAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

type Path = "records" | "access" | "vml_dns";

export interface ConnectCardProps {
  path: Path | null;
  found: {
    dns: string | null;
    dnsUrl: string | null;
    email: string | null;
    pointsAt: string;
    advice: Path;
    adviceWhy: string;
    lookedUpLine: string;
  } | null;
  wanted: { type: string; host: string; value: string }[];
  changes: { action: "add" | "change" | "remove"; type: string; host: string; value: string; from?: string; why: string }[];
  checkLine: string | null;
  recordsOk: boolean;
  okLine: string | null;
  clientLinkLine: string | null;
  clientDoneLine: string | null;
  instructions: string | null;
  access: string | null;
  emailLine: string;
  locked: boolean;
  /** B3: a WordPress site (on 20i since 5 October 2026: every path works, VML's Cloudflare included). */
  wordpress?: boolean;
}

export const PATH_TEXT: Record<Path, { label: string; line: string }> = {
  records: { label: "The client points two records", line: "Two changes at their DNS provider; their email isn't touched." },
  access: { label: "VML points them (the client gives access)", line: "The client grants VML access without sharing a password; the PM makes the two changes." },
  vml_dns: { label: "VML runs the DNS (Cloudflare)", line: "The nameservers move to VML's Cloudflare, with the email records copied and checked first." },
};

function useRun() {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<{ ok: true } | { ok: false; message: string }>) =>
    start(async () => {
      setError(null);
      const result = await action();
      if (!result.ok) setError(result.message);
      router.refresh();
    });
  return { busy, error, setError, run, start };
}

/* F3, step "Connect the domain": the look-up and the way it connects. */
export function ConnectLookup(props: { projectId: string; canEdit: boolean; connect: ConnectCardProps }) {
  const { busy, error, run } = useRun();
  const c = props.connect;
  const [choice, setChoice] = useState<Path>(c.path ?? c.found?.advice ?? "records");
  const edit = props.canEdit && !busy && !c.locked;
  return (
    <div className="golive-form connect-lookup">
      {error ? <p className="hint-error">{error}</p> : null}
      {c.found ? (
        <>
          <dl className="connect-facts">
            <div>
              <dt>DNS at</dt>
              <dd>{c.found.dnsUrl ? <a href={c.found.dnsUrl} target="_blank" rel="noreferrer">{c.found.dns ?? "unknown"}</a> : (c.found.dns ?? "a provider TAWD doesn't know")}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>{c.found.email ?? "none found"}</dd>
            </div>
            <div>
              <dt>Points at now</dt>
              <dd>
                <code>{c.found.pointsAt}</code>
              </dd>
            </div>
          </dl>
          <p className="hint">
            {c.found.lookedUpLine}{" "}
            {edit ? (
              <button type="button" className="btn btn-text" onClick={() => run(() => detectDomainAction(props.projectId))}>
                Look up again
              </button>
            ) : null}
          </p>
          <fieldset className="field">
            <legend className="field-label">
              <span>How it connects</span>
            </legend>
            {(Object.keys(PATH_TEXT) as Path[]).map((p) => (
              <label className="radio-line" key={p}>
                <input type="radio" name="connect-path" checked={choice === p} disabled={!edit} onChange={() => setChoice(p)} />
                {PATH_TEXT[p].label}
                {p === c.found!.advice ? <span className="badge badge-info">Recommended</span> : null}
              </label>
            ))}
            <p className="hint">{c.found.adviceWhy}</p>
            <p className="hint">{PATH_TEXT[choice].line}</p>
          </fieldset>
          {edit && choice !== c.path ? (
            <Button small variant="secondary" onClick={() => run(() => choosePathAction(props.projectId, choice))}>
              Use this way
            </Button>
          ) : null}
        </>
      ) : (
        <>
          <p className="hint">TAWD looks up who runs the domain&rsquo;s DNS and its email, what it points at now, and anything in the way. Free.</p>
          {edit ? (
            <Button small variant="primary" onClick={() => run(() => detectDomainAction(props.projectId))}>
              Look up the domain
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

const ACTION_BADGE = { add: "badge badge-info", change: "badge badge-warning", remove: "badge badge-warning" } as const;
const ACTION_WORD = { add: "Add", change: "Change", remove: "Remove" } as const;

export function ChangeList({ changes }: { changes: ConnectCardProps["changes"] }) {
  return (
    <ul className="connect-changes">
      {changes.map((ch, i) => (
        <li key={`${ch.action}-${ch.type}-${ch.host}-${i}`}>
          <span className={ACTION_BADGE[ch.action]}>{ACTION_WORD[ch.action]}</span>{" "}
          <code>
            {ch.type} {ch.host} {ch.value}
          </code>
          {ch.from ? <span className="hint"> (now {ch.from})</span> : null}
          <p className="hint">{ch.why}</p>
        </li>
      ))}
    </ul>
  );
}

/* F3, step "Point the domain at the new site": the records, what to change, the client's link, the check. */
export function PointRecords(props: { projectId: string; canEdit: boolean; connect: ConnectCardProps }) {
  const { busy, error, setError, run, start } = useRun();
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const c = props.connect;
  const edit = props.canEdit && !busy;
  const copy = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(what);
  };
  return (
    <div className="golive-form connect-point">
      {error ? <p className="hint-error">{error}</p> : null}
      <table className="connect-records">
        <thead>
          <tr>
            <th>Type</th>
            <th>Name</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {c.wanted.map((w) => (
            <tr key={w.host}>
              <td>{w.type}</td>
              <td>
                <code>{w.host}</code>
              </td>
              <td>
                <code>{w.value}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {c.recordsOk ? (
        <p className="hint content-done-line">{c.okLine}</p>
      ) : (
        <>
          {c.changes.length ? (
            <>
              <p className="field-label">What to change</p>
              <ChangeList changes={c.changes} />
            </>
          ) : null}
          <p className="hint">{c.emailLine}</p>

          {c.path === "access" ? (
            <div className="connect-access">
              <p className="hint">{c.access ?? "Ask the client to add VML as a user who can manage DNS, if their provider allows it; otherwise they make the changes themselves (the other way)."}</p>
            </div>
          ) : (
            <div className="connect-link">
              {link ? (
                <div className="row">
                  <code className="secret-value">{link}</code>
                  <Button small onClick={() => copy(link, "link")}>
                    {copied === "link" ? "Copied" : "Copy"}
                  </Button>
                </div>
              ) : null}
              <p className="hint">Private, no login. It shows the client these changes with steps for their DNS provider, and an I&rsquo;ve done it button. Making a new link stops the old one.</p>
              {c.clientLinkLine ? <p className="hint">{c.clientLinkLine}</p> : null}
              <div className="row">
                {edit ? (
                  <Button
                    small
                    variant="secondary"
                    onClick={() =>
                      start(async () => {
                        setError(null);
                        const result = await makeClientLinkAction(props.projectId);
                        if (!result.ok) setError(result.message);
                        else setLink(result.url);
                      })
                    }
                  >
                    {c.clientLinkLine ? "Make a new link" : "Make the client's link"}
                  </Button>
                ) : null}
                {c.instructions ? (
                  <button type="button" className="btn btn-text" onClick={() => copy(c.instructions!, "steps")}>
                    {copied === "steps" ? "Copied" : "Copy the steps as text"}
                  </button>
                ) : null}
              </div>
            </div>
          )}

          {c.clientDoneLine ? (
            <p className="hint">
              <span className="badge badge-info">Client</span> {c.clientDoneLine}
            </p>
          ) : null}
          <p className={c.checkLine ? "hint-amber" : "hint"}>{c.checkLine ?? "Not checked yet."}</p>
          <p className="hint">Checked every 15 minutes by itself once the client has the link.</p>
          {edit ? (
            <Button small variant="primary" onClick={() => run(() => checkRecordsAction(props.projectId))}>
              Check now
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
