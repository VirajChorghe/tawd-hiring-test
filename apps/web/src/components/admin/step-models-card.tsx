"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { saveStepModelAction } from "@/app/actions";

/*
  Spend, "AI model per step" (27 September 2026): which Claude model each
  AI step runs on. Reading and checking steps default to a cheaper model;
  building, the Creative Director and critique and polish to Opus. A
  change saves at once, is logged, and applies from the step's next call.
*/
export function StepModelsCard(props: {
  models: { id: string; label: string; prices: string }[];
  rows: { step: string; label: string; group: string; model: string; defaultModel: string; choices: string[] }[];
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [saving, setSaving] = useState<string | null>(null);
  const [message, setMessage] = useState<{ step: string; text: string; error: boolean } | null>(null);
  const label = (id: string) => props.models.find((m) => m.id === id)?.label ?? id;

  return (
    <div className="card step-models-card">
      <div className="page-head" style={{ marginBottom: 12 }}>
        <h2 className="card-title">AI model per step</h2>
        <span className="hint">Changes apply from the step&rsquo;s next call and are logged</span>
      </div>
      <p className="hint step-models-prices">
        {props.models.map((m) => `${m.label}: ${m.prices}`).join(" · ")}. Reading and checking steps run on a cheaper model by default; building, the
        Creative Director and critique and polish on Opus.
      </p>
      <div className="table-card">
        <table className="spend-table">
          <thead>
            <tr>
              <th>Step</th>
              <th>Model</th>
              <th>Default</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row) => (
              <tr key={row.step}>
                <td>
                  <strong>{row.label}</strong> <span className="hint">{row.group}</span>
                  {message?.step === row.step ? <p className={message.error ? "hint-error" : "hint"}>{message.text}</p> : null}
                </td>
                <td>
                  <select
                    className="select step-model-select"
                    aria-label={`Model for ${row.label}`}
                    value={row.model}
                    disabled={busy && saving === row.step}
                    onChange={(e) => {
                      const model = e.target.value;
                      setSaving(row.step);
                      start(async () => {
                        const result = await saveStepModelAction(row.step, model);
                        setMessage(result.ok ? { step: row.step, text: `Saved: ${label(model)} from the next call.`, error: false } : { step: row.step, text: result.message, error: true });
                        setSaving(null);
                        router.refresh();
                      });
                    }}
                  >
                    {props.models.filter((m) => row.choices.includes(m.id)).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className={row.model === row.defaultModel ? "hint" : "hint content-warn"}>
                  {row.model === row.defaultModel ? label(row.defaultModel) : `${label(row.defaultModel)} (changed)`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
