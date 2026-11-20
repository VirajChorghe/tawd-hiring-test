"use client";

import { useState, useTransition } from "react";

import { answerLabAction } from "../../actions";

/* F4: In my Inbox, or In Spam or Junk. */
export function LabButtons({ token }: { token: string }) {
  const [busy, start] = useTransition();
  const [result, setResult] = useState<"done" | "expired" | null>(null);
  const answer = (where: "inbox" | "spam") =>
    start(async () => {
      const r = await answerLabAction(token, where);
      setResult(r ? "done" : "expired");
    });
  if (result) {
    return (
      <div className="client-card">
        <p className={result === "done" ? "content-done-line" : "hint"}>{result === "done" ? "Thanks, recorded." : "This link has expired."}</p>
      </div>
    );
  }
  return (
    <div className="client-card">
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => answer("inbox")}>
          In my Inbox
        </button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => answer("spam")}>
          In Spam or Junk
        </button>
      </div>
    </div>
  );
}
