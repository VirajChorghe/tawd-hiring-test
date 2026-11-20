"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { setFormPluginAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

type FormPlugin = "cf7" | "gravityforms";

const LABEL: Record<FormPlugin, string> = { cf7: "Contact Form 7 (free)", gravityforms: "Gravity Forms (VML's licence)" };
const WHAT: Record<FormPlugin, string> = {
  cf7: "Keeps the site's own form markup; photos go with WordPress's own email.",
  gravityforms: "Gravity Forms' fields in the site's own classes; messages are kept in WordPress (Forms, Entries) as well as in TAWD; photos go as links.",
};

/* Build B (1 October 2026): a WordPress site's form plugin, in the Hosting card. */
export function FormPluginChoice(props: { projectId: string; formPlugin: FormPlugin; canChange: boolean; locked: boolean; keyMissing: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<FormPlugin>(props.formPlugin);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  return (
    <div className="hosting-package">
      <p className="content-done-line">Forms: {LABEL[props.formPlugin]}</p>
      <p className="hint">{WHAT[props.formPlugin]}</p>
      {props.formPlugin === "gravityforms" && props.keyMissing ? (
        <p className="hint-amber">The worker needs GRAVITY_FORMS_LICENSE_KEY (Coolify, tawd-worker-new) to install Gravity Forms.</p>
      ) : null}
      {changed ? <p className="hint">Deploy the WordPress preview again to switch the forms.</p> : null}
      {error ? <p className="hint-error">{error}</p> : null}
      {open ? (
        <fieldset className="field">
          <legend className="field-label">
            <span>Form plugin</span>
          </legend>
          {(Object.keys(LABEL) as FormPlugin[]).map((p) => (
            <label className="radio-line" key={p}>
              <input type="radio" name="form-plugin" checked={choice === p} onChange={() => setChoice(p)} />
              {LABEL[p]}
            </label>
          ))}
          <p className="hint">{WHAT[choice]}</p>
          <div className="row">
            <Button small onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              small
              variant="primary"
              disabled={busy || choice === props.formPlugin}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const r = await setFormPluginAction(props.projectId, choice);
                  if (!r.ok) setError(r.message);
                  else {
                    setOpen(false);
                    setChanged(true);
                  }
                  router.refresh();
                })
              }
            >
              Save
            </Button>
          </div>
        </fieldset>
      ) : props.canChange && !props.locked ? (
        <Button small variant="secondary" onClick={() => setOpen(true)}>
          Change
        </Button>
      ) : null}
    </div>
  );
}
