"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { setIncludedHoursAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/* The included hours a month, per tier (Updates, 1 October 2026). Admins; each change logged. */

const TIERS = [
  { key: "starter", label: "Starter" },
  { key: "growth", label: "Growth" },
  { key: "pro", label: "Pro" },
] as const;

export function IncludedHoursCard({ hours }: { hours: Record<"starter" | "growth" | "pro", number> }) {
  const router = useRouter();
  const [values, setValues] = useState({ starter: String(hours.starter), growth: String(hours.growth), pro: String(hours.pro) });
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, start] = useTransition();

  return (
    <section className="card content-card" aria-label="Included hours a month">
      <p className="hint">
        The hours of updates each plan includes every month, on Updates. Anything over is quoted at Hours over the plan; unused hours don&rsquo;t carry over.
      </p>
      <div className="money-dialog-fees">
        {TIERS.map((t) => (
          <div className="field" key={t.key}>
            <label className="field-label" htmlFor={`hours-${t.key}`}>
              <span>{t.label}</span>
            </label>
            <div className="row" style={{ gap: 8 }}>
              <input id={`hours-${t.key}`} className="input" inputMode="decimal" style={{ maxWidth: 110 }} value={values[t.key]} onChange={(e) => setValues((v) => ({ ...v, [t.key]: e.target.value }))} />
              <Button
                small
                disabled={busy || values[t.key] === String(hours[t.key])}
                onClick={() =>
                  start(async () => {
                    setMessage(null);
                    const result = await setIncludedHoursAction(t.key, values[t.key]);
                    setMessage(result.ok ? { tone: "ok", text: `${t.label}: ${values[t.key]} hours a month. Saved and logged.` } : { tone: "error", text: result.message });
                    if (result.ok) router.refresh();
                  })
                }
              >
                Save {t.label}
              </Button>
            </div>
          </div>
        ))}
      </div>
      {message ? <p className={message.tone === "ok" ? "hint content-done" : "hint-error"}>{message.text}</p> : null}
    </section>
  );
}
