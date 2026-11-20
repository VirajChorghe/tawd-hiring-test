"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { saveAddonPriceAction, savePackageAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  The price list (admins): each package's build fee and monthly fee, edited
  one row at a time, and "Add a package" for a new one. Every save is
  logged with the before and after. A project keeps the price it was
  created with, so a change here only reaches projects created afterwards.
*/

export interface PriceRow {
  key: string;
  name: string;
  buildFee: string;
  monthlyFee: string;
  /** "$199", or "Not set". */
  buildFeeText: string;
  monthlyFeeText: string;
  projects: number;
}

export function PriceList({ rows }: { rows: PriceRow[] }) {
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="table-card">
      <table className="spend-table">
        <thead>
          <tr>
            <th>Package</th>
            <th className="align-right">Build fee</th>
            <th className="align-right">Monthly fee</th>
            <th className="align-right">Projects on it</th>
            <th>
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) =>
            editing === row.key ? (
              <EditRow key={row.key} row={row} onDone={() => setEditing(null)} />
            ) : (
              <tr key={row.key}>
                <td>
                  <strong>{row.name}</strong>
                </td>
                <td className={row.buildFee ? "align-right" : "align-right money-unset"}>{row.buildFeeText}</td>
                <td className={row.monthlyFee ? "align-right" : "align-right money-unset"}>{row.monthlyFeeText}</td>
                <td className="align-right">{row.projects}</td>
                <td className="align-right">
                  <Button variant="text" small onClick={() => setEditing(row.key)} aria-label={`Edit ${row.name}`}>
                    Edit
                  </Button>
                </td>
              </tr>
            ),
          )}
          {editing === "new" ? <EditRow row={null} onDone={() => setEditing(null)} /> : null}
        </tbody>
      </table>
      {editing !== "new" ? (
        <div className="money-table-foot">
          <Button small onClick={() => setEditing("new")}>
            Add a package
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function EditRow({ row, onDone }: { row: PriceRow | null; onDone: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(row?.name ?? "");
  const [buildFee, setBuildFee] = useState(row?.buildFee ?? "");
  const [monthlyFee, setMonthlyFee] = useState(row?.monthlyFee ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const id = row?.key ?? "new";

  const save = () =>
    start(async () => {
      setError(null);
      const result = await savePackageAction({ key: row?.key ?? null, name, buildFee, monthlyFee });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onDone();
      router.refresh();
    });

  return (
    <tr className="money-edit-row">
      <td>
        <label className="visually-hidden" htmlFor={`package-name-${id}`}>
          Package name
        </label>
        <input
          id={`package-name-${id}`}
          className="input"
          value={name}
          placeholder="Package name"
          onChange={(e) => setName(e.target.value)}
        />
        {error ? <p className="hint-error">{error}</p> : null}
      </td>
      <td className="align-right">
        <MoneyInput id={`build-fee-${id}`} label="Build fee, in dollars" value={buildFee} onChange={setBuildFee} />
      </td>
      <td className="align-right">
        <MoneyInput id={`monthly-fee-${id}`} label="Monthly fee, in dollars" value={monthlyFee} onChange={setMonthlyFee} />
      </td>
      <td className="align-right">{row ? row.projects : ""}</td>
      <td className="align-right">
        <div className="money-row-actions">
          <Button small onClick={onDone} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" small onClick={save} disabled={busy}>
            {busy ? "Saving..." : row ? `Save ${row.name}` : "Add package"}
          </Button>
        </div>
      </td>
    </tr>
  );
}

export function MoneyInput(props: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  return (
    <span className="money-input">
      <label className="visually-hidden" htmlFor={props.id}>
        {props.label}
      </label>
      <span aria-hidden="true">$</span>
      <input
        id={props.id}
        className="input"
        inputMode="decimal"
        placeholder="Not set"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </span>
  );
}

/*
  Add-ons (26 September 2026): one-off extras with an admin-set price,
  each change logged. A project keeps the price an add-on had when it was
  added. Quoted add-ons have no list price.
*/
export interface AddonRow {
  key: string;
  name: string;
  price: string;
  priceText: string;
  quoted: boolean;
  /** Charged every month with the monthly fee (WordPress hosting). */
  monthly?: boolean;
  /** Priced per page of the client's design. */
  perPage?: boolean;
  projects: number;
}

export function AddonList({ rows }: { rows: AddonRow[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  return (
    <div className="table-card">
      <table className="spend-table">
        <thead>
          <tr>
            <th>Add-on</th>
            <th className="align-right">Price</th>
            <th className="align-right">Projects with it</th>
            <th>
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className={editing === row.key ? "money-edit-row" : undefined}>
              <td>
                <strong>{row.name}</strong>
                {row.monthly ? <span className="hint"> Monthly</span> : null}
                {row.perPage ? <span className="hint"> Per page</span> : null}
                {editing === row.key && error ? <p className="hint-error">{error}</p> : null}
              </td>
              <td className={row.price || row.quoted ? "align-right" : "align-right money-unset"}>
                {editing === row.key ? <MoneyInput id={`addon-${row.key}`} label={`${row.name} price, in dollars`} value={value} onChange={setValue} /> : row.quoted ? "Quoted case by case" : row.monthly && row.price ? `${row.priceText} a month` : row.perPage && row.price ? `${row.priceText} a page` : row.priceText}
              </td>
              <td className="align-right">{row.projects}</td>
              <td className="align-right">
                {row.quoted ? null : editing === row.key ? (
                  <div className="money-row-actions">
                    <Button small onClick={() => setEditing(null)} disabled={busy}>
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      small
                      disabled={busy}
                      onClick={() =>
                        start(async () => {
                          setError(null);
                          const result = await saveAddonPriceAction(row.key, value);
                          if (!result.ok) {
                            setError(result.message);
                            return;
                          }
                          setEditing(null);
                          router.refresh();
                        })
                      }
                    >
                      {busy ? "Saving..." : "Save"}
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="text"
                    small
                    aria-label={`Edit ${row.name}`}
                    onClick={() => {
                      setValue(row.price);
                      setError(null);
                      setEditing(row.key);
                    }}
                  >
                    Edit
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
