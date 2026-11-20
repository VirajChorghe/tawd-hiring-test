"use client";

import { useState, useTransition } from "react";

import { sendTestEmailAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  Team page, admins only: which mail server TAWD sends through (never the
  password), and "Send a test email" to your own address, with any refusal
  in plain words and the server's own.
*/
export function EmailCheck({
  email,
  settings,
}: {
  email: string;
  settings: { configured: boolean; missing: string[]; through: string | null; from: string | null };
}) {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, start] = useTransition();

  return (
    <section className="card email-check" aria-label="Email">
      <div className="email-check-head">
        <div>
          <p className="card-title">Email</p>
          {settings.configured ? (
            <p className="hint">
              Sends through {settings.through}, from {settings.from}. Used for password reset links.
            </p>
          ) : (
            <p className="hint-missing">
              Not set up: {settings.missing.join(" and ")} {settings.missing.length === 1 ? "is" : "are"} missing in Coolify. Until then no email is sent; an admin can still reset a password here.
            </p>
          )}
        </div>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() =>
            start(async () => {
              setResult(null);
              setResult(await sendTestEmailAction());
            })
          }
        >
          {busy ? "Sending..." : "Send a test email"}
        </Button>
      </div>
      <p className="hint">The test goes to your own address, {email}.</p>
      {result ? (
        <div className={result.ok ? "alert-done" : "alert-error"} role={result.ok ? "status" : "alert"}>
          <span>{result.message}</span>
        </div>
      ) : null}
    </section>
  );
}
