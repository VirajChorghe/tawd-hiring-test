"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { connectTeamSlackAction, copyProjectWebhookAction, disconnectTeamSlackAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  The team's Slack channel on System (29 September 2026): where TAWD posts
  a failed Site check after a deploy. One click copies the webhook the
  projects already use; the address is never shown.
*/
export function TeamSlackCard({ connected, hint, projectHint }: { connected: boolean; hint: string | null; projectHint: string | null }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const run = (action: () => Promise<{ ok: true } | { ok: false; message: string }>) =>
    start(async () => {
      setError(null);
      const result = await action();
      if (!result.ok) setError(result.message);
      else setUrl("");
      router.refresh();
    });

  return (
    <div className="card content-card" id="team-slack">
      <div className="content-card-head">
        <div>
          <h3 className="card-title">Team Slack channel</h3>
          <p className="hint">
            Where TAWD posts what belongs to no one project: today, only a Site check that fails after a deploy. Nothing is posted when it passes.
          </p>
        </div>
        <span className={connected ? "badge badge-done" : "badge badge-info"}>{connected ? "Connected" : "Not set"}</span>
      </div>

      {connected ? (
        <p className="hint">
          Webhook ending {hint}. Stored encrypted and never shown.{" "}
          <Button variant="text" small disabled={busy} onClick={() => run(() => disconnectTeamSlackAction())}>
            Disconnect
          </Button>
        </p>
      ) : null}

      {!connected && projectHint ? (
        <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <Button variant="primary" disabled={busy} onClick={() => run(() => copyProjectWebhookAction())}>
            Use the channel your projects post to (ending {projectHint})
          </Button>
          <span className="hint">or paste another webhook below.</span>
        </div>
      ) : null}

      <form
        className="row"
        style={{ gap: 8, marginTop: 12, flexWrap: "wrap" }}
        onSubmit={(event) => {
          event.preventDefault();
          run(() => connectTeamSlackAction(url));
        }}
      >
        <label className="visually-hidden" htmlFor="team-slack-url">
          Incoming webhook URL
        </label>
        <input
          id="team-slack-url"
          className="input"
          style={{ flex: "1 1 360px" }}
          placeholder="https://hooks.slack.com/services/..."
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          autoComplete="off"
        />
        <Button type="submit" disabled={busy || !url.trim()}>
          {connected ? "Replace webhook" : "Connect"}
        </Button>
      </form>
      {error ? <p className="hint-error">{error}</p> : null}
    </div>
  );
}
