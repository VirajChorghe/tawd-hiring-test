"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { setProjectCancelledAction, setProjectPriceAction } from "@/app/actions";
import { MoneyInput } from "@/components/money/price-list";
import { Button } from "@/components/ui/button";

/*
  Price and billing, on the project overview (admins only). The project
  keeps the price it was created with; Change price sets another one with a
  reason, and Mark cancelled stops the monthly fee after the month of the
  date given. Both are logged. No card or payment data.
*/

export function ProjectMoney(props: {
  projectId: string;
  packageKey: string | null;
  packageName: string | null;
  buildFee: string;
  monthlyFee: string;
  buildFeeText: string;
  monthlyFeeText: string;
  /** "Sep 26, 2026", or null while not live. */
  liveOn: string | null;
  cancelledOn: string | null;
  cancelledOnText: string | null;
  cancelReason: string | null;
  packages: { key: string; name: string; buildFee: string; monthlyFee: string }[];
  today: string;
  /** One-off add-ons, counted with the build fee: "Logo design: $150". */
  addons?: string[];
  /** Monthly add-ons, counted with the monthly fee: "WordPress hosting: $20.00 a month". */
  monthlyAddons?: string[];
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"price" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const run = (action: () => Promise<{ ok: true } | { ok: false; message: string }>) =>
    start(async () => {
      setError(null);
      const result = await action();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setDialog(null);
      router.refresh();
    });

  return (
    <div className="card money-card">
      <div className="money-card-head">
        <div>
          <h2 className="card-title">Price and billing</h2>
          <p className="hint">Admins only. Going live counts as paid. No card or payment details are kept in TAWD.</p>
        </div>
        <div className="money-row-actions">
          {props.cancelledOn ? (
            <Button variant="text" small disabled={busy} onClick={() => run(() => setProjectCancelledAction(props.projectId, null))}>
              Undo cancellation
            </Button>
          ) : (
            <Button small onClick={() => setDialog("cancel")}>
              Mark cancelled
            </Button>
          )}
          <Button small onClick={() => setDialog("price")}>
            Change price
          </Button>
        </div>
      </div>

      <dl className="money-facts">
        <div>
          <dt>Package</dt>
          <dd>{props.packageName ?? "None"}</dd>
        </div>
        <div>
          <dt>Build fee</dt>
          <dd className={props.buildFee ? undefined : "money-unset"}>{props.buildFeeText}</dd>
        </div>
        <div>
          <dt>Monthly fee</dt>
          <dd className={props.monthlyFee ? undefined : "money-unset"}>{props.monthlyFeeText}</dd>
        </div>
        <div>
          <dt>Went live</dt>
          <dd className={props.liveOn ? undefined : "money-unset"}>{props.liveOn ?? "Not live yet"}</dd>
        </div>
        <div>
          <dt>Cancelled</dt>
          <dd className={props.cancelledOn ? undefined : "money-unset"}>
            {props.cancelledOnText ? `${props.cancelledOnText}: ${props.cancelReason ?? ""}` : "No"}
          </dd>
        </div>
      </dl>
      {props.addons?.length ? <p className="hint money-addons">Add-ons, with the build fee: {props.addons.join("; ")}.</p> : null}
      {props.monthlyAddons?.length ? <p className="hint money-addons">Monthly add-ons, with the monthly fee: {props.monthlyAddons.join("; ")}.</p> : null}
      {!props.buildFee && !props.monthlyFee ? (
        <p className="hint money-warn">No price is recorded for this project: it counts as $0 in Revenue until one is set.</p>
      ) : null}
      {error && !dialog ? <p className="hint-error">{error}</p> : null}

      {dialog === "price" ? (
        <PriceDialog {...props} busy={busy} error={error} onCancel={() => { setDialog(null); setError(null); }} onSave={(input) => run(() => setProjectPriceAction(props.projectId, input))} />
      ) : null}
      {dialog === "cancel" ? (
        <CancelDialog today={props.today} busy={busy} error={error} onCancel={() => { setDialog(null); setError(null); }} onSave={(input) => run(() => setProjectCancelledAction(props.projectId, input))} />
      ) : null}
    </div>
  );
}

function PriceDialog(props: {
  packageKey: string | null;
  buildFee: string;
  monthlyFee: string;
  packages: { key: string; name: string; buildFee: string; monthlyFee: string }[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (input: { packageKey: string; buildFee: string; monthlyFee: string; reason: string }) => void;
}) {
  const [packageKey, setPackageKey] = useState(props.packageKey ?? props.packages[0]?.key ?? "");
  const [buildFee, setBuildFee] = useState(props.buildFee);
  const [monthlyFee, setMonthlyFee] = useState(props.monthlyFee);
  const [reason, setReason] = useState("");

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="price-title">
        <h2 className="section-title" id="price-title">
          Change this project&rsquo;s price?
        </h2>
        <p className="hint">Only this project changes; the price list stays as it is. Recorded in the activity log with your name, the time and the reason.</p>
        <div className="field">
          <label className="field-label" htmlFor="price-package">
            <span>Package</span>
          </label>
          <select
            id="price-package"
            className="select"
            value={packageKey}
            onChange={(e) => {
              setPackageKey(e.target.value);
              const chosen = props.packages.find((p) => p.key === e.target.value);
              if (chosen) {
                setBuildFee(chosen.buildFee);
                setMonthlyFee(chosen.monthlyFee);
              }
            }}
          >
            {props.packages.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="money-dialog-fees">
          <div className="field">
            <span className="field-label">
              <span>Build fee</span>
            </span>
            <MoneyInput id="price-build" label="Build fee, in dollars" value={buildFee} onChange={setBuildFee} />
          </div>
          <div className="field">
            <span className="field-label">
              <span>Monthly fee</span>
            </span>
            <MoneyInput id="price-monthly" label="Monthly fee, in dollars" value={monthlyFee} onChange={setMonthlyFee} />
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="price-reason">
            <span>Why is it changing?</span>
            <span className="field-required">Required</span>
          </label>
          <textarea id="price-reason" className="textarea" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        {props.error ? <p className="hint-error">{props.error}</p> : null}
        <div className="modal-actions">
          <Button onClick={props.onCancel} disabled={props.busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={props.busy || reason.trim().length < 5}
            onClick={() => props.onSave({ packageKey, buildFee, monthlyFee, reason })}
          >
            {props.busy ? "Saving..." : "Save the price"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CancelDialog(props: {
  today: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (input: { on: string; reason: string }) => void;
}) {
  const [on, setOn] = useState(props.today);
  const [reason, setReason] = useState("");

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="cancel-title">
        <h2 className="section-title" id="cancel-title">
          Mark this project cancelled?
        </h2>
        <p className="hint">
          The monthly fee still counts in the month of the date you give, and stops after it. The site and the project stay
          as they are. You can undo this.
        </p>
        <div className="field">
          <label className="field-label" htmlFor="cancel-on">
            <span>Cancelled on</span>
            <span className="field-required">Required</span>
          </label>
          <input id="cancel-on" type="date" className="input" value={on} onChange={(e) => setOn(e.target.value)} style={{ maxWidth: 200 }} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="cancel-reason">
            <span>Why?</span>
            <span className="field-required">Required</span>
          </label>
          <textarea id="cancel-reason" className="textarea" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          <p className="hint">Recorded in the activity log with your name and the time.</p>
        </div>
        {props.error ? <p className="hint-error">{props.error}</p> : null}
        <div className="modal-actions">
          <Button onClick={props.onCancel} disabled={props.busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={props.busy || !on || reason.trim().length < 3} onClick={() => props.onSave({ on, reason })}>
            {props.busy ? "Saving..." : "Mark cancelled"}
          </Button>
        </div>
      </div>
    </div>
  );
}
