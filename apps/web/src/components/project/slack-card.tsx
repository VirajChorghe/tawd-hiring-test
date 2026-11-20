"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  connectSlackAction,
  disconnectSlackAction,
  sendSlackTestAction,
  setSlackCommentsAction,
} from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  The project's Slack channel (3d). PMs and admins paste an incoming
  webhook; after saving, only its last four characters are ever shown.
  Everyone else sees whether Slack is connected, and nothing to change.
*/

export interface SlackCardStatus {
  available: boolean;
  connected: boolean;
  hint: string | null;
  postComments: boolean;
  lastPost: string | null;
  lastError: string | null;
  lastErrorWhen: string | null;
}

export function SlackCard({
  projectId,
  status,
  canEdit,
}: {
  projectId: string;
  status: SlackCardStatus;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, startBusy] = useTransition();

  const run = (action: () => Promise<{ ok: true } | { ok: false; message: string }>, done: string, after?: () => void) =>
    startBusy(async () => {
      setMessage(null);
      const result = await action();
      if (!result.ok) {
        setMessage({ tone: "error", text: result.message });
        return;
      }
      setMessage({ tone: "ok", text: done });
      after?.();
      router.refresh();
    });

  const showForm = canEdit && status.available && (!status.connected || editing);

  return (
    <div className="card slack-card">
      <div className="slack-head">
        <div>
          <h2 className="card-title">Slack</h2>
          <p className="hint">
            {!status.connected
              ? "Slack not connected. Updates for this project stay in TAWD."
              : `Posting to Slack through the webhook ending ${status.hint}.`}
          </p>
        </div>
        <span className={status.connected ? "status-pill is-on" : "status-pill"}>
          <span className="step-dot" aria-hidden="true" />
          {status.connected ? "Connected" : "Not connected"}
        </span>
      </div>

      {status.connected && status.lastError ? (
        <p className="hint-missing">
          The last update didn&rsquo;t go through ({status.lastErrorWhen}): {status.lastError}
        </p>
      ) : status.connected && status.lastPost ? (
        <p className="hint">Last update sent {status.lastPost}.</p>
      ) : null}

      {!status.available && canEdit ? (
        <p className="hint-missing">
          Slack isn&rsquo;t set up on the server yet: the encryption key is missing. An admin adds
          TAWD_ENCRYPTION_KEY in Coolify.
        </p>
      ) : null}

      {showForm ? (
        <div className="slack-form">
          <div className="field">
            <label className="field-label" htmlFor="slack-webhook">
              <span>{status.connected ? "New webhook URL" : "Incoming webhook URL"}</span>
            </label>
            <input
              id="slack-webhook"
              className="input"
              type="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://hooks.slack.com/services/..."
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <p className="hint">
              In Slack, add the Incoming Webhooks app to the project&rsquo;s channel and paste its URL
              here. It is stored encrypted and never shown again.
            </p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {status.connected ? (
              <Button variant="secondary" onClick={() => setEditing(false)} disabled={busy}>
                Cancel
              </Button>
            ) : null}
            <Button
              variant="primary"
              disabled={busy || url.trim() === ""}
              onClick={() =>
                run(() => connectSlackAction(projectId, url), "Saved. Send a test message to check it.", () => {
                  setUrl("");
                  setEditing(false);
                })
              }
            >
              {busy ? "Saving..." : status.connected ? "Replace webhook" : "Connect Slack"}
            </Button>
          </div>
        </div>
      ) : null}

      {status.connected && canEdit && !editing ? (
        <>
          <label className="check-label check-label-wrap">
            <input
              type="checkbox"
              checked={status.postComments}
              disabled={busy}
              onChange={(event) =>
                run(
                  () => setSlackCommentsAction(projectId, event.target.checked),
                  event.target.checked ? "New comments will be posted." : "New comments won't be posted.",
                )
              }
            />
            Also post new team comments (who commented and on which concept, never the text)
          </label>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <Button variant="secondary" disabled={busy} onClick={() => run(() => sendSlackTestAction(projectId), "Test message sent. Check the channel.")}>
              Send test message
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setEditing(true)}>
              Replace
            </Button>
            <Button variant="text" disabled={busy} onClick={() => run(() => disconnectSlackAction(projectId), "Slack disconnected.")}>
              Disconnect
            </Button>
          </div>
        </>
      ) : null}

      {message ? (
        <p className={message.tone === "ok" ? "hint slack-ok" : "hint-error"} role="status">
          {message.text}
        </p>
      ) : null}

      <p className="hint">
        Posts: concepts ready, Needs PM review, a new version from requested changes, the client&rsquo;s
        decision, stage changes and going live. No client details and no money.
      </p>
    </div>
  );
}
