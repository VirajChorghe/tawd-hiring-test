"use client";

import Link from "next/link";
import { useActionState } from "react";

import { requestPasswordResetAction } from "@/app/actions";
import { SubmitButton } from "@/components/form";
import { emptyActionState } from "@/lib/action-state";

/*
  Asking for a reset link. The answer is the same whether or not the
  address has an account, so the form never tells anyone who works here.
*/
export function ForgotPasswordForm() {
  const [state, action] = useActionState(requestPasswordResetAction, emptyActionState);
  const emailError = state.fieldErrors?.email?.[0];

  if (state.notice) {
    return (
      <div className="signin-form">
        <div>
          <h1 className="page-title">Check your email</h1>
          <p className="signin-lede">{state.notice}</p>
        </div>
        <p className="signin-help">
          Nothing after a few minutes? Check your spam folder, or ask a TAWD admin to reset your password from the Team
          page.
        </p>
        <Link className="btn btn-secondary signin-submit" href="/login">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form action={action} className="signin-form" noValidate>
      <div>
        <h1 className="page-title">Forgot password?</h1>
        <p className="signin-lede">
          Enter your velocitymedialab.com email. We&rsquo;ll send a link to set a new password; it works once, for 30
          minutes.
        </p>
      </div>

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

      <SubmitButton className="btn btn-primary signin-submit">Send the link</SubmitButton>

      <p className="signin-help">
        <Link href="/login">Back to sign in</Link>
      </p>
    </form>
  );
}
