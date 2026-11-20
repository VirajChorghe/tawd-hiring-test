"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { saveTrackingAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { TRACKING_FORMATS, checkTrackingIds, consentModeLabels, consentModes, trackingKeys, type ConsentMode, type TrackingConfig } from "@tawd/core/site";

/*
  Tracking on the project page (Todd's request, 26 September 2026): IDs
  only. TAWD writes the code into every page of the built site, loaded only
  after the visitor's consent, with a consent banner and a "Do not sell or
  share my information" link. Changes reach the site on its next build.
*/
export function TrackingCard(props: { projectId: string; initial: TrackingConfig; canEdit: boolean; savedLine: string | null }) {
  const router = useRouter();
  const [values, setValues] = useState<TrackingConfig>(props.initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, start] = useTransition();
  const problems = checkTrackingIds(values);
  const dirty = JSON.stringify(values) !== JSON.stringify(props.initial);

  return (
    <div className="card content-card">
      <div>
        <h2 className="card-title">Tracking</h2>
        <p className="hint">
          IDs only: TAWD writes the code into every page. Nothing loads before the visitor&rsquo;s consent, and every page has a
          consent banner and a &ldquo;Do not sell or share my information&rdquo; link. The banner also follows the strictest
          consent rule among the project&rsquo;s states (the Run book has the details): the choice below may be stricter than the
          state&rsquo;s rule, never weaker. CallRail&rsquo;s ID is the &ldquo;company/key&rdquo; from its own snippet address.
          Changes reach the site on its next build.
        </p>
      </div>
      <div className="field-grid">
        {trackingKeys.map((key) => {
          const problem = problems.find((p) => p.key === key);
          return (
            <div key={key} className="field">
              <label className="field-label" htmlFor={`tracking-${key}`}>
                <span>{TRACKING_FORMATS[key].label}</span>
                <span className="field-optional">Optional</span>
              </label>
              <input
                id={`tracking-${key}`}
                className="input"
                value={values[key]}
                disabled={!props.canEdit}
                placeholder={TRACKING_FORMATS[key].example}
                onChange={(event) => {
                  setSaved(false);
                  setValues({ ...values, [key]: event.target.value.trim() });
                }}
              />
              {problem ? <p className="hint-error">{problem.message}</p> : null}
            </div>
          );
        })}
      </div>
      <fieldset className="choice-group">
        <legend className="field-label">
          <span>Consent banner</span>
        </legend>
        <div className="radio-row">
          {consentModes.map((mode) => (
            <label key={mode} className="check-label">
              <input
                type="radio"
                name="consent-mode"
                disabled={!props.canEdit}
                checked={values.consentMode === mode}
                onChange={() => {
                  setSaved(false);
                  setValues({ ...values, consentMode: mode as ConsentMode });
                }}
              />
              {consentModeLabels[mode]}
            </label>
          ))}
        </div>
        <p className="hint">
          Ask first suits visitors from places with strict consent laws. Either way, a browser sending Global Privacy Control is
          treated as opted out, and the visitor can change their mind at any time.
        </p>
      </fieldset>
      {error ? <p className="hint-error">{error}</p> : null}
      <div className="row" style={{ gap: 12, alignItems: "center" }}>
        {props.canEdit ? (
          <Button
            variant="primary"
            disabled={busy || !dirty || problems.length > 0}
            onClick={() =>
              start(async () => {
                setError(null);
                const result = await saveTrackingAction(props.projectId, values);
                if (!result.ok) {
                  setError(result.message);
                  return;
                }
                setSaved(true);
                router.refresh();
              })
            }
          >
            {busy ? "Saving..." : "Save tracking"}
          </Button>
        ) : null}
        <span className="hint">{saved ? "Saved." : props.savedLine}</span>
      </div>
    </div>
  );
}
