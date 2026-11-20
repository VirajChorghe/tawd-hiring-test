"use client";

import { useState, useTransition } from "react";

import { clientDoneAction } from "../actions";

interface Change {
  action: "add" | "change" | "remove";
  type: string;
  host: string;
  value: string;
  from?: string;
  why: string;
}

const WORD = { add: "Add", change: "Change", remove: "Remove" } as const;

/* The client's steps and the I've done it button (F3). */
export function ClientSteps(props: {
  token: string;
  domain: string;
  providerName: string;
  providerUrl: string | null;
  where: string[];
  watch: string[];
  changes: Change[];
  done: boolean;
  doneAt: string | null;
  instructions: string;
  access: string | null;
}) {
  const [busy, start] = useTransition();
  const [result, setResult] = useState<{ done: boolean; remaining: number } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(what);
  };

  if (props.done || result?.done) {
    return (
      <div className="client-card client-done">
        <p className="content-done-line">All set: {props.domain} points at your new website.</p>
        <p className="hint">We&rsquo;ll take it from here. You don&rsquo;t need to do anything else.</p>
      </div>
    );
  }

  return (
    <>
      <section className="client-card">
        <h2 className="section-title">
          1. Sign in at{" "}
          {props.providerUrl ? (
            <a href={props.providerUrl} target="_blank" rel="noreferrer">
              {props.providerName}
            </a>
          ) : (
            props.providerName
          )}
        </h2>
        <ol className="client-list">
          {props.where.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ol>
      </section>

      <section className="client-card">
        <h2 className="section-title">2. Make {props.changes.length === 1 ? "this change" : "these changes"}</h2>
        {props.changes.map((c, i) => (
          <div className="client-change" key={`${c.action}-${c.type}-${c.host}-${i}`}>
            <p>
              <strong>{WORD[c.action]}</strong> {c.action === "remove" ? "this record" : c.action === "change" ? "this record to" : "a record"}
            </p>
            <dl className="client-record">
              <dt>Type</dt>
              <dd>{c.type}</dd>
              <dt>Name</dt>
              <dd>
                <code>{c.host}</code>
              </dd>
              <dt>{c.action === "remove" ? "Value now" : "Value"}</dt>
              <dd>
                <code>{c.value}</code>{" "}
                {c.action !== "remove" ? (
                  <button type="button" className="btn btn-text" onClick={() => copy(c.value, `v${i}`)}>
                    {copied === `v${i}` ? "Copied" : "Copy"}
                  </button>
                ) : null}
              </dd>
              {c.from ? (
                <>
                  <dt>Now</dt>
                  <dd>{c.from}</dd>
                </>
              ) : null}
            </dl>
            <p className="hint">{c.why}</p>
          </div>
        ))}
        {props.watch.length ? (
          <div className="amber-box">
            <ul>
              {props.watch.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="hint">Leave everything else as it is, especially any MX or TXT records: those keep your email working.</p>
      </section>

      <section className="client-card">
        <h2 className="section-title">3. Tell us you&rsquo;re done</h2>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() =>
            start(async () => {
              const r = await clientDoneAction(props.token);
              setResult(r.ok ? { done: r.done, remaining: r.remaining } : { done: false, remaining: -1 });
            })
          }
        >
          {busy ? "Checking..." : "I've done it"}
        </button>
        {result && !result.done ? (
          <p className="hint-amber">
            {result.remaining < 0
              ? "This link has expired. Ask your Velocity Media Lab contact for a new one."
              : `Not yet: ${result.remaining} change${result.remaining === 1 ? "" : "s"} still to show. Changes can take up to an hour to show. We check every 15 minutes, so there's nothing else to do.`}
          </p>
        ) : props.doneAt ? (
          <p className="hint">You told us it&rsquo;s done. We check every 15 minutes, so there&rsquo;s nothing else to do.</p>
        ) : null}
      </section>

      <section className="client-card">
        <h2 className="section-title">Not the one to do it?</h2>
        <button type="button" className="btn btn-text" onClick={() => copy(props.instructions, "all")}>
          {copied === "all" ? "Copied" : "Copy these steps for your IT person"}
        </button>
        {props.access ? <p className="hint">Or give us access instead: {props.access}</p> : null}
      </section>
    </>
  );
}
