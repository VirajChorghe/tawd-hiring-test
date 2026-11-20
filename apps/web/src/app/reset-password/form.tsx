"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { resetPasswordAction } from "@/app/actions";
import { FieldError, SubmitButton } from "@/components/form";
import { useProgressDoneOn } from "@/components/ui/top-progress";
import { emptyActionState } from "@/lib/action-state";
import { MIN_PASSWORD_LENGTH } from "@/lib/validation";

/* Setting a new password from the emailed link: the same rules as choosing one, ticking as you type. */
export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action] = useActionState(resetPasswordAction, emptyActionState);
  useProgressDoneOn(state);
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [show, setShow] = useState(false);

  if (!token) {
    return (
      <div className="signin-form">
        <div>
          <h1 className="page-title">This link isn&rsquo;t complete</h1>
          <p className="signin-lede">Open the link from the email again, or ask for a new one.</p>
        </div>
        <Link className="btn btn-primary signin-submit" href="/forgot-password">
          Ask for a new link
        </Link>
      </div>
    );
  }

  const rules = [
    { ok: password.length >= MIN_PASSWORD_LENGTH, text: `At least ${MIN_PASSWORD_LENGTH} characters` },
    { ok: again.length > 0 && again === password, text: "Both passwords match" },
  ];

  return (
    <form action={action} className="signin-form" noValidate data-progress>
      <input type="hidden" name="token" value={token} />
      <div>
        <h1 className="page-title">Set a new password</h1>
        <p className="signin-lede">Choose a password only you know. Saving it signs you out on every device.</p>
      </div>

      {state.error ? (
        <div className="alert-error" role="alert">
          <span>
            {state.error} <Link href="/forgot-password">Ask for a new link</Link>
          </span>
        </div>
      ) : null}

      <div className="field">
        <div className="signin-password-head">
          <label className="field-label" htmlFor="newPassword">
            <span>New password</span>
          </label>
          <button type="button" className="btn btn-text btn-inline" aria-pressed={show} onClick={() => setShow((v) => !v)}>
            {show ? "Hide" : "Show"}
          </button>
        </div>
        <input
          id="newPassword"
          name="newPassword"
          type={show ? "text" : "password"}
          className="input"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-describedby="password-rules"
          required
          autoFocus
        />
        <FieldError state={state} name="newPassword" />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="confirmPassword">
          <span>New password again</span>
        </label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type={show ? "text" : "password"}
          className="input"
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          required
        />
        <FieldError state={state} name="confirmPassword" />
      </div>

      <ul className="password-rules" id="password-rules" aria-live="polite">
        {rules.map((rule) => (
          <li key={rule.text} className={rule.ok ? "is-met" : undefined}>
            <span className="password-rule-mark" aria-hidden="true">
              {rule.ok ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12l5 5L20 7" />
                </svg>
              ) : null}
            </span>
            {rule.text}
            <span className="visually-hidden">{rule.ok ? ", done" : ", not yet"}</span>
          </li>
        ))}
      </ul>

      <p className="signin-help">Length matters more than symbols: a few unrelated words make a strong password.</p>

      <SubmitButton className="btn btn-primary signin-submit">Save the new password</SubmitButton>
    </form>
  );
}
