"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { setProjectCapAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  Test project and AI cap (Jason, 28 September 2026), admins only: a run
  that would take the project's AI spend past the cap doesn't start. A test
  project's cap is $5 unless another is set; any project can have one.
*/
export function ProjectCapCard(props: { projectId: string; isTest: boolean; capCents: number | null; spent: string; capLine: string }) {
  const router = useRouter();
  const [isTest, setIsTest] = useState(props.isTest);
  const [cap, setCap] = useState(props.capCents === null ? "" : (props.capCents / 100).toFixed(2));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, start] = useTransition();

  return (
    <div className="card project-cap">
      <div className="content-card-head">
        <div>
          <h2 className="card-title">Test project and AI cap</h2>
          <p className="hint">Admins only. A run that would take this project&rsquo;s AI spend past the cap doesn&rsquo;t start. {props.capLine}</p>
        </div>
      </div>
      <div className="project-cap-row">
        <label className="checkline">
          <input type="checkbox" checked={isTest} onChange={(e) => setIsTest(e.target.checked)} />
          Test project
        </label>
        <div className="field project-cap-amount">
          <label className="field-label" htmlFor={`cap-${props.projectId}`}>
            <span>AI cap</span>
            <span className="field-optional">{isTest ? "Blank is $5" : "Blank is none"}</span>
          </label>
          <input id={`cap-${props.projectId}`} className="input" inputMode="decimal" placeholder={isTest ? "5.00" : "No cap"} value={cap} onChange={(e) => setCap(e.target.value)} />
        </div>
        <p className="hint">Spent so far: {props.spent}</p>
        <Button
          small
          disabled={busy}
          onClick={() =>
            start(async () => {
              setError(null);
              setSaved(false);
              const result = await setProjectCapAction(props.projectId, { isTest, capDollars: cap });
              if (!result.ok) {
                setError(result.message);
                return;
              }
              setSaved(true);
              router.refresh();
            })
          }
        >
          {busy ? "Saving..." : "Save"}
        </Button>
      </div>
      {error ? <p className="hint-error">{error}</p> : saved ? <p className="hint">Saved and logged.</p> : null}
    </div>
  );
}
