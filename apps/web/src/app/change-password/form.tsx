"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { changePasswordAction } from "@/app/actions";
import { FieldError, SubmitButton } from "@/components/form";
import { useProgressDoneOn } from "@/components/ui/top-progress";
import { emptyActionState } from "@/lib/action-state";
import { MIN_PASSWORD_LENGTH } from "@/lib/validation";

/*
  Choosing your own password on first sign-in, or changing it later. The rules are checked on the
  server; the list here ticks as you type so nobody has to guess them.
*/
export function ChangePasswordForm({ email, forced }: { email: string; forced: boolean }) {
  const [state, action] = useActionState(changePasswordAction, emptyActionState);
  useProgressDoneOn(state);
  const [temporary, setTemporary] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [show, setShow] = useState(false);

  const rules = [
    { ok: password.length >= MIN_PASSWORD_LENGTH, text: `At least ${MIN_PASSWORD_LENGTH} characters` },
    { ok: password.length > 0 && password !== temporary, text: forced ? "Different from the temporary password" : "Different from your current password" },
    { ok: again.length > 0 && again === password, text: "Both new passwords match" },
  ];

  return (
    <form action={action} className="signin-form" noValidate data-progress>
      <div>
        <h1 className="page-title">{forced ? "Choose your password" : "Change your password"}</h1>
        <p className="signin-lede">
          {forced
            ? `You signed in as ${email} with a temporary password. Choose one only you know before going any further.`
            : `Signed in as ${email}. A new password signs you out on every other device.`}
        </p>
      </div>

      {state.notice ? (
        <div className="alert-done" role="status">
          <span>{state.notice}</span>
        </div>
      ) : null}

      {state.error ? (
        <div className="alert-error" role="alert">
          <span>{state.error}</span>
        </div>
      ) : null}

      <div className="field">
        <label className="field-label" htmlFor="currentPassword">
          <span>{forced ? "Temporary password" : "Current password"}</span>
        </label>
        <input
          id="currentPassword"
          name="currentPassword"
          type="password"
          className="input"
          autoComplete="current-password"
          value={temporary}
          onChange={(e) => setTemporary(e.target.value)}
          required
          autoFocus
        />
        <FieldError state={state} name="currentPassword" />
      </div>

      <div className="field">
        <div className="signin-password-head">
          <label className="field-label" htmlFor="newPassword">
            <span>New password</span>
          </label>
          <button
            type="button"
            className="btn btn-text btn-inline"
            aria-pressed={show}
            onClick={() => setShow((v) => !v)}
          >
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

      <p className="signin-help">
        Length matters more than symbols: a few unrelated words make a strong
        password.
      </p>

      <SubmitButton className="btn btn-primary signin-submit">{forced ? "Save and continue" : "Change password"}</SubmitButton>
      {forced ? null : (
        <p className="signin-help">
          <Link href="/projects">Back to TAWD</Link>
        </p>
      )}
    </form>
  );
}
