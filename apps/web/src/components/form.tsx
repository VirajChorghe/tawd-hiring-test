"use client";

import { useFormStatus } from "react-dom";

import { Banner } from "@/components/ui/banner";
import type { ActionState } from "@/lib/action-state";

/**
 * Disabled while the action is in flight, so a slow connection cannot produce
 * two accounts or two projects from one impatient click.
 */
export function SubmitButton({
  children,
  className,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      className={className ?? "btn btn-primary"}
      style={style}
      disabled={pending}
    >
      {pending ? "Working..." : children}
    </button>
  );
}

export function FieldError({
  state,
  name,
}: {
  state: ActionState;
  name: string;
}) {
  const messages = state.fieldErrors?.[name];
  if (!messages || messages.length === 0) return null;

  return <p className="hint-error">{messages.join(". ")}</p>;
}

export function FormError({ state }: { state: ActionState }) {
  const formLevel = state.fieldErrors?.form?.join(". ");
  const message = state.error ?? formLevel;
  if (!message) return null;

  return <Banner tone="error" title={message} />;
}

export function FormNotice({ state }: { state: ActionState }) {
  if (!state.notice && !state.secret) return null;

  return (
    <Banner tone="done" title={state.notice ?? "Done"}>
      {state.secret ? (
        <>
          {state.secret.label}:{" "}
          <code className="secret">{state.secret.value}</code>
        </>
      ) : null}
    </Banner>
  );
}
