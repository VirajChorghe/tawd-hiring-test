"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { setHostingAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { WpPreviewSection, type WpPreviewSectionProps } from "@/components/build/wp-preview-section";
import { FormPluginChoice } from "@/components/build/form-plugin-choice";

type Hosting = "netlify" | "wordpress";

const LABEL: Record<Hosting, string> = {
  netlify: "Static site on Netlify (Build A)",
  wordpress: "WordPress on 20i (Build B)",
};

const WHAT: Record<Hosting, string> = {
  netlify: "Plain HTML and CSS files on VML's Netlify account. The default.",
  wordpress: "The same design and copy as a WordPress site with native blocks, in its own 20i hosting package on VML's account. VML makes every edit; the client has no WordPress login.",
};

/*
  Build B, 4b (27 September 2026): where the client's site lives. PMs and
  admins change it (logged); locked once the site is live. Choosing
  WordPress on a tier other than Pro adds the monthly WordPress hosting
  add-on, and says so first.
*/
export function HostingCard(props: {
  projectId: string;
  hosting: Hosting;
  canChange: boolean;
  locked: boolean;
  isPro: boolean;
  /** Admins see prices; everyone else sees that the add-on is there. */
  showPrices: boolean;
  /** "$20.00" or null while the add-on has no price. */
  addonPrice: string | null;
  /** The add-on on this project: "WordPress hosting: $20.00 a month" for admins, its name for others; null when it isn't on. */
  addonLine: string | null;
  changedLine: string | null;
  /** B1: the WordPress package of the last finished build (href null before any build). */
  wpPackage?: { version: number | null; href: string | null };
  /** WordPress sites: the form plugin, and whether the worker has the Gravity Forms licence key. */
  formPlugin?: { value: "cf7" | "gravityforms"; keyMissing: boolean };
  /** B2: the WordPress preview (on 20i since 5 October 2026). */
  wpPreview?: Omit<WpPreviewSectionProps, "projectId"> | null;
  /** Opened with a choice made (for screenshots). */
  startOpenWith?: Hosting;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [open, setOpen] = useState(Boolean(props.startOpenWith));
  const [choice, setChoice] = useState<Hosting>(props.startOpenWith ?? props.hosting);
  const [error, setError] = useState<string | null>(null);

  const addonNote =
    choice === "wordpress" && props.hosting !== "wordpress" && !props.isPro
      ? `This project isn't Pro, so the monthly WordPress hosting add-on is added to its price${
          !props.showPrices ? "." : props.addonPrice ? `: ${props.addonPrice} a month.` : ": no price is set yet (an admin sets it on the Pricing page)."
        }`
      : choice === "netlify" && props.addonLine
        ? "The WordPress hosting add-on comes off its price."
        : null;

  return (
    <div className="card content-card">
      <div className="content-card-head">
        <div>
          <h2 className="card-title">Hosting</h2>
          <p className="hint">Where the client&rsquo;s site lives. Build A is always made first; Build B is made from it.</p>
        </div>
        {props.canChange && !props.locked ? (
          <Button
            disabled={busy}
            onClick={() => {
              setChoice(props.hosting);
              setError(null);
              setOpen(true);
            }}
          >
            Change hosting
          </Button>
        ) : null}
      </div>
      <p className="content-done-line">{LABEL[props.hosting]}</p>
      <p className="hint">{WHAT[props.hosting]}</p>
      {props.hosting === "wordpress" ? (
        <p className="hint">
          {props.isPro
            ? "Pro includes WordPress hosting."
            : props.addonLine
              ? `Not a Pro project: ${props.addonLine}.`
              : "Not a Pro project, but the WordPress hosting add-on isn't on its price (it was removed on the project page)."}
        </p>
      ) : null}
      {props.hosting === "wordpress" && props.formPlugin ? (
        <FormPluginChoice projectId={props.projectId} formPlugin={props.formPlugin.value} canChange={props.canChange} locked={props.locked} keyMissing={props.formPlugin.keyMissing} />
      ) : null}
      {props.hosting === "wordpress" && props.wpPackage ? (
        <div className="hosting-package">
          <p className="content-done-line">WordPress package</p>
          {props.wpPackage.href ? (
            <>
              <p className="hint">
                Made from version {props.wpPackage.version}: the client&rsquo;s block theme, every page as WordPress blocks, the contact form, the pictures and the installer. Free, made by
                code, nothing is sent anywhere.
              </p>
              {props.canChange ? (
                <a className="btn btn-secondary" href={props.wpPackage.href} download>
                  Download the WordPress package
                </a>
              ) : null}
            </>
          ) : (
            <p className="hint">Build the site first: the package is made from the finished build.</p>
          )}
        </div>
      ) : null}
      {props.hosting === "wordpress" && props.wpPreview ? <WpPreviewSection projectId={props.projectId} {...props.wpPreview} /> : null}
      {props.locked ? <p className="hint">Locked: the site is live.</p> : null}
      {props.changedLine ? <p className="hint">{props.changedLine}</p> : null}

      {open ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="hosting-title">
            <h2 className="section-title" id="hosting-title">
              Change where the site lives?
            </h2>
            <fieldset className="field">
              <legend className="field-label">
                <span>Hosting</span>
              </legend>
              {(["netlify", "wordpress"] as const).map((h) => (
                <label className="radio-line" key={h}>
                  <input type="radio" name="hosting" checked={choice === h} onChange={() => setChoice(h)} />
                  {LABEL[h]}
                </label>
              ))}
            </fieldset>
            <p className="hint">{WHAT[choice]}</p>
            {addonNote ? <p className="hint-amber">{addonNote}</p> : null}
            <p className="hint">Recorded in the activity log. It can change until the site goes live.</p>
            {error ? <p className="hint-error">{error}</p> : null}
            <div className="modal-actions">
              <Button onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy || choice === props.hosting}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const result = await setHostingAction(props.projectId, choice);
                    if (!result.ok) {
                      setError(result.message);
                      return;
                    }
                    setOpen(false);
                    router.refresh();
                  })
                }
              >
                {busy ? "Saving..." : "Save hosting"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
