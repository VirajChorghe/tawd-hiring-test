"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  resendFormMessageAction,
  sendTestMessagesAction,
  viewFormMessageAction,
} from "@/app/actions";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";

export interface FormMessagesCardProps {
  projectId: string;
  canEdit: boolean;
  setupMissing: string[];
  recipients: {
    email: string;
    state: "confirmed" | "sent" | "bounced" | "failed" | "none";
    line: string | null;
  }[];
  messages: {
    id: string;
    when: string;
    form: string;
    visitor: string | null;
    status: string;
    detail: string | null;
  }[];
  alert: string | null;
}

const RECIPIENT_BADGE = {
  confirmed: { cls: "badge badge-done", text: "Confirmed" },
  sent: { cls: "badge badge-info", text: "Test sent" },
  bounced: { cls: "badge badge-missing", text: "Bounced" },
  failed: { cls: "badge badge-missing", text: "Not sent" },
  none: { cls: "badge badge-info", text: "No test yet" },
} as const;

const MESSAGE_BADGE: Record<string, { cls: string; text: string }> = {
  delivered: { cls: "badge badge-done", text: "Delivered" },
  sent: { cls: "badge badge-info", text: "Sent" },
  queued: { cls: "badge badge-info", text: "Sending" },
  bounced: { cls: "badge badge-missing", text: "Bounced" },
  spam: { cls: "badge badge-missing", text: "Marked as spam" },
  failed: { cls: "badge badge-missing", text: "Failed" },
};

/*
  F2 (1 October 2026): the site's form messages, through TAWD. Who gets
  them and whether they confirmed the test; the latest messages and what
  happened to each (contents only on View, which is logged).
*/
export function FormMessagesCard(props: FormMessagesCardProps) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState<{
    id: string;
    fields: { label: string; value: string }[];
    files: { name: string; url: string }[];
  } | null>(null);

  const run = (
    work: () => Promise<{ ok: boolean; message?: string }>,
    done?: string,
  ) =>
    start(async () => {
      setError(null);
      setNote(null);
      const r = await work();
      if (!r.ok) setError(r.message ?? "It didn't work.");
      else if (done) setNote(done);
      router.refresh();
    });

  return (
    <div className="card content-card" id="form-messages">
      <div className="content-card-head">
        <div>
          <h2 className="card-title">Form messages</h2>
          <p className="hint">
            Every message from the site&rsquo;s forms comes to TAWD, which
            emails it to the client from VML&rsquo;s address and checks it
            arrived. Kept 90 days.
          </p>
        </div>
      </div>
      {props.setupMissing.length ? (
        <Banner tone="warning" title="Postmark isn't set up yet">
          The site&rsquo;s forms email the client directly, as before. An admin
          adds {props.setupMissing.join(" and ")} to the web app in Coolify.
        </Banner>
      ) : (
        <>
          {props.alert ? <Banner tone="error" title={props.alert} /> : null}
          {error ? <p className="hint-error">{error}</p> : null}
          <section className="fm-section">
            <h3 className="fm-heading">Sent to</h3>
            {props.recipients.length ? (
              <ul className="seo-checks seo-checks-states">
                {props.recipients.map((r) => (
                  <li key={r.email}>
                    <span className={RECIPIENT_BADGE[r.state].cls}>
                      {RECIPIENT_BADGE[r.state].text}
                    </span>
                    <div>
                      <p className="seo-check-label">{r.email}</p>
                      {r.line ? <p className="hint">{r.line}</p> : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint-amber">
                No address yet: add one under Website forms (Intake), or the
                business email.
              </p>
            )}
            <div className="fm-test">
              {props.canEdit ? (
                <Button
                  small
                  variant="secondary"
                  disabled={busy || props.recipients.length === 0}
                  onClick={() =>
                    run(
                      () => sendTestMessagesAction(props.projectId),
                      `Test sent to ${props.recipients.length} address${props.recipients.length === 1 ? "" : "es"}.`,
                    )
                  }
                >
                  Send a test message
                </Button>
              ) : null}
              <p className="hint">
                {note ??
                  "The client clicks I got it in the test email. Go-live waits for one confirmation."}
              </p>
            </div>
          </section>

          <section className="fm-section">
            <h3 className="fm-heading">Latest messages</h3>
            {props.messages.length ? (
              <ul className="seo-checks seo-checks-states">
                {props.messages.map((m) => {
                  const badge = MESSAGE_BADGE[m.status] ?? MESSAGE_BADGE.sent!;
                  return (
                    <li key={m.id}>
                      <span className={badge.cls}>{badge.text}</span>
                      <div>
                        <p className="seo-check-label">
                          {m.form}
                          {m.visitor ? `, ${m.visitor}` : ""}
                        </p>
                        <p className="hint">{m.when}</p>
                        {m.detail && m.status !== "delivered" ? (
                          <p className="hint">{m.detail}</p>
                        ) : null}
                        {props.canEdit ? (
                          <div className="fm-actions">
                            <button
                              type="button"
                              className="btn btn-text btn-small"
                              disabled={busy}
                              onClick={() =>
                                start(async () => {
                                  const r = await viewFormMessageAction(
                                    props.projectId,
                                    m.id,
                                  );
                                  if (r.ok)
                                    setOpen({
                                      id: m.id,
                                      fields: r.message.fields,
                                      files: r.message.files,
                                    });
                                  else setError(r.message);
                                })
                              }
                            >
                              View
                            </button>
                            {m.status === "failed" || m.status === "bounced" ? (
                              <button
                                type="button"
                                className="btn btn-text btn-small"
                                disabled={busy}
                                onClick={() =>
                                  run(() =>
                                    resendFormMessageAction(
                                      props.projectId,
                                      m.id,
                                    ),
                                  )
                                }
                              >
                                Send again
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                        {open?.id === m.id ? (
                          <dl className="client-record">
                            {open.fields.map((f) => (
                              <div
                                key={f.label}
                                style={{ display: "contents" }}
                              >
                                <dt>{f.label}</dt>
                                <dd>{f.value}</dd>
                              </div>
                            ))}
                            {open.files.map((f) => (
                              <div key={f.url} style={{ display: "contents" }}>
                                <dt>Photo</dt>
                                <dd>
                                  <a
                                    href={f.url}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {f.name}
                                  </a>
                                </dd>
                              </div>
                            ))}
                          </dl>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="hint">No messages yet.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
