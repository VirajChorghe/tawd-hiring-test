/*
  Why an AI step stopped, in words the team can act on.

  The worker stores the error exactly as it came back, which for the
  Anthropic API looks like: 400 {"type":"error","error":{"type":
  "invalid_request_error","message":"Your credit balance is too low..."}}.
  That is kept as the detail; the headline says what it means and what to
  do. Nothing is guessed: an error that matches none of these is shown as
  it was stored.
*/

export interface AiFailure {
  /** One plain sentence: what happened and what to do. */
  headline: string;
  /** The stored reason, cleaned of JSON wrapping, for whoever looks deeper. */
  detail: string;
  kind: "anthropic_limit" | "anthropic_busy" | "anthropic_auth" | "model" | "other";
}

/** The human-readable message inside an API error, if there is one. */
function innerMessage(raw: string): string {
  const start = raw.indexOf("{");
  if (start !== -1) {
    try {
      const parsed = JSON.parse(raw.slice(start)) as { error?: { message?: string }; message?: string };
      const message = parsed.error?.message ?? parsed.message;
      if (message) return message;
    } catch {
      // Not JSON after all; fall through to the raw text.
    }
  }
  return raw;
}

export function describeAiFailure(raw: string | null | undefined): AiFailure | null {
  if (!raw || !raw.trim()) return null;
  const detail = innerMessage(raw.trim());
  const text = `${raw} ${detail}`;

  if (/credit balance is too low|usage limit|spend(ing)? limit|billing|purchase credits|quota/i.test(text)) {
    return {
      kind: "anthropic_limit",
      headline:
        "Anthropic refused the request because the account's spending limit or credit balance was reached. Raise the limit or add credit in the Anthropic console, then run it again.",
      detail,
    };
  }
  if (/\b(429|529)\b|rate.?limit|overloaded/i.test(text)) {
    return {
      kind: "anthropic_busy",
      headline: "Anthropic was too busy to answer, and the one retry failed too. Run it again in a few minutes.",
      detail,
    };
  }
  if (/\b401\b|authentication|invalid x-api-key|api key/i.test(text)) {
    return {
      kind: "anthropic_auth",
      headline: "Anthropic did not accept TAWD's API key. An admin checks ANTHROPIC_API_KEY in Coolify.",
      detail,
    };
  }
  if (/model.*(not found|not available|does not exist)|not_found_error/i.test(text)) {
    return {
      kind: "model",
      headline: "The AI model TAWD is set to use is not available to this account. An admin checks ANTHROPIC_MODEL in Coolify.",
      detail,
    };
  }
  return { kind: "other", headline: detail, detail };
}
