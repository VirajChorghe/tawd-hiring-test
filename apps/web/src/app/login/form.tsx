"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { signInAction } from "@/app/actions";
import { SubmitButton } from "@/components/form";
import { useProgressDoneOn } from "@/components/ui/top-progress";
import { emptyActionState } from "@/lib/action-state";

/*
  Sign in. Every rule is on the server: velocitymedialab.com addresses only,
  a pause after five failed tries, and the forced password change on a
  temporary password. This form shows what the server says.
*/
export function SignInForm({ initialError, initialNotice = null }: { initialError: string | null; initialNotice?: string | null }) {
  const [state, action] = useActionState(signInAction, emptyActionState);
  useProgressDoneOn(state);
  const [showPassword, setShowPassword] = useState(false);

  const error = state.error ?? (state === emptyActionState ? initialError : null);
  const emailError = state.fieldErrors?.email?.[0];
  const passwordError = state.fieldErrors?.password?.[0];

  return (
    <form action={action} className="signin-form" noValidate data-progress>
      <div>
        <h1 className="page-title">Sign in</h1>
        <p className="signin-lede">Use your velocitymedialab.com account.</p>
      </div>

      {!error && state === emptyActionState && initialNotice ? (
        <div className="alert-done" role="status">
          <span>{initialNotice}</span>
        </div>
      ) : null}

      {error ? (
        <div className="alert-error" role="alert">
          <AlertIcon />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="field">
        <label className="field-label" htmlFor="email">
          <span>Email</span>
        </label>
        <input
          id="email"
          name="email"
          type="email"
          className={emailError ? "input is-error" : "input"}
          autoComplete="username"
          placeholder="name@velocitymedialab.com"
          aria-invalid={emailError ? true : undefined}
          aria-describedby={emailError ? "email-error" : undefined}
          required
          autoFocus
        />
        {emailError ? (
          <p id="email-error" className="hint-error">
            {emailError}
          </p>
        ) : null}
      </div>

      <div className="field">
        <div className="signin-password-head">
          <label className="field-label" htmlFor="password">
            <span>Password</span>
          </label>
          <button
            type="button"
            className="btn btn-text btn-inline"
            aria-controls="password"
            aria-pressed={showPassword}
            onClick={() => setShowPassword((v) => !v)}
          >
            {showPassword ? "Hide" : "Show"}
          </button>
        </div>
        <input
          id="password"
          name="password"
          type={showPassword ? "text" : "password"}
          className={passwordError ? "input is-error" : "input"}
          autoComplete="current-password"
          aria-invalid={passwordError ? true : undefined}
          required
        />
        {passwordError ? <p className="hint-error">{passwordError}</p> : null}
        <Link className="signin-forgot" href="/forgot-password">
          Forgot password?
        </Link>
      </div>

      <SubmitButton className="btn btn-primary signin-submit">Sign in</SubmitButton>

      <p className="signin-help">
        New to the team? A TAWD admin creates your account.
      </p>
    </form>
  );
}

function AlertIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5" />
      <path d="M12 16.2v.3" />
    </svg>
  );
}
