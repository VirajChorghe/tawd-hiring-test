"use client";

import { useState, useTransition } from "react";

import { confirmTestAction } from "../../actions";

/* F2: the client's one click, and what it means for them. */
export function ConfirmButton({ token }: { token: string }) {
  const [busy, start] = useTransition();
  const [result, setResult] = useState<{ recipient: string; site: string } | "expired" | null>(null);

  if (result === "expired") {
    return (
      <div className="client-card">
        <p className="hint">This link has expired. Ask your Velocity Media Lab contact for a new test message.</p>
      </div>
    );
  }
  if (result) {
    return (
      <div className="client-card">
        <p className="content-done-line">Thanks, we&rsquo;ve recorded that you got it.</p>
        <p className="hint">
          Website messages from {result.site} will come to {result.recipient} from Velocity Media Lab&rsquo;s address. If one ever lands in spam, mark it Not spam.
        </p>
      </div>
    );
  }
  return (
    <div className="client-card">
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy}
        onClick={() =>
          start(async () => {
            const r = await confirmTestAction(token);
            setResult(r ?? "expired");
          })
        }
      >
        {busy ? "Saving..." : "Yes, I got it"}
      </button>
    </div>
  );
}
