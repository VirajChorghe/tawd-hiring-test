"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { fillFromTemplatesAction, repairCopiesAction, setKitFontAction, startStyleKitAction } from "@/app/actions";
import type { RepairSummary } from "@/lib/copy-repair";
import { Button } from "@/components/ui/button";
import type { StyleKitView } from "@/lib/style-kit";

/*
  The style kit card (Jason, 28 September 2026), on Option A's Mockups
  page: the design's colours, fonts, panels, boxes, buttons, ribbons and
  icons, found by code ($0, no AI), which every copy uses. The home page
  put together from the kit alone sits beside the design, with its match
  and the element check's misses by name. A font can be swapped for one of
  the matched alternatives, which builds the kit again.
*/

const PART_WORDS: Record<string, [string, string]> = {
  panel: ["panel style", "panel styles"],
  card: ["card style", "card styles"],
  box: ["bordered box style", "bordered box styles"],
  button: ["button style", "button styles"],
  ribbon: ["ribbon shape", "ribbon shapes"],
  divider: ["divider style", "divider styles"],
};

export function StyleKitCard({ projectId, view, repair = null, hasCopies = false }: { projectId: string; view: StyleKitView; repair?: RepairSummary | null; hasCopies?: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const working = view.status === "queued" || view.status === "working" || (repair?.working ?? 0) > 0;

  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [working, router]);

  const build = () =>
    start(async () => {
      setError(null);
      const result = await startStyleKitAction(projectId);
      if (!result.ok) setError(result.message);
      router.refresh();
    });
  const repairAll = () =>
    start(async () => {
      setError(null);
      const result = await repairCopiesAction(projectId);
      if (!result.ok) setError(result.message);
      router.refresh();
    });
  const fillAll = () =>
    start(async () => {
      setError(null);
      const result = await fillFromTemplatesAction(projectId);
      if (!result.ok) setError(result.message);
      router.refresh();
    });
  const swap = (role: string, family: string) =>
    start(async () => {
      setError(null);
      const result = await setKitFontAction(projectId, role, family);
      if (!result.ok) setError(result.message);
      router.refresh();
    });

  return (
    <div className="card style-kit">
      <div className="exact-head">
        <div>
          <h2 className="card-title">Style kit</h2>
          <p className="hint">
            The design&rsquo;s colours, fonts, panels, boxes, buttons, ribbons and icons, found by code from its pages. Every copy is built with it, and each copy is checked
            item by item against it. $0, no AI.
          </p>
        </div>
        {view.canBuild && !working ? (
          <Button small variant={view.status === "done" && !view.outOfDate ? undefined : "primary"} disabled={busy || !view.designReady} onClick={build}>
            {busy ? "Starting..." : view.status === "none" ? "Build the style kit ($0)" : "Build it again ($0)"}
          </Button>
        ) : null}
      </div>
      {error ? <p className="hint-error">{error}</p> : null}
      {view.status === "none" ? <p className="hint">Not built yet. It takes about a minute.</p> : null}
      {working ? <p className="hint content-warn">Building the style kit... about a minute. This page refreshes itself.</p> : null}
      {view.status === "failed" ? <p className="hint-error">The style kit didn&rsquo;t finish: {view.failureReason ?? "unknown reason"}</p> : null}
      {view.outOfDate ? <p className="hint-amber">The design was read again since this kit was built. Build it again so the copies match the latest design.</p> : null}

      {view.status === "done" ? (
        <>
          <div className="kit-swatches" aria-label="Colours">
            {view.colors.map((c) => (
              <span key={c.hex} className="kit-swatch" title={`${c.hex}: ${c.uses.join(", ")}`}>
                <span style={{ background: c.hex }} />
                {c.hex}
              </span>
            ))}
          </div>

          <table className="kit-fonts">
            <thead>
              <tr>
                <th>Lettering</th>
                <th>Font</th>
                <th>Match</th>
              </tr>
            </thead>
            <tbody>
              {view.fonts.map((f) => (
                <tr key={f.role}>
                  <td>{f.label}</td>
                  <td>
                    {view.canBuild ? (
                      <select className="select" aria-label={`Font for ${f.label.toLowerCase()}`} value={f.family} disabled={busy} onChange={(e) => swap(f.role, e.target.value)}>
                        {[f.family, ...f.alternatives.filter((a) => a !== f.family)].map((family) => (
                          <option key={family} value={family}>
                            {family}
                          </option>
                        ))}
                      </select>
                    ) : (
                      f.family
                    )}
                    {f.chosenByDesigner ? <span className="hint"> Chosen by the team</span> : null}
                    {!f.fetched ? <span className="hint-amber"> Its file couldn&rsquo;t be fetched</span> : null}
                  </td>
                  <td className="hint">{f.chosenByDesigner ? "-" : `${f.match}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="hint">
            {view.parts.map((p) => `${p.count} ${PART_WORDS[p.kind]![p.count === 1 ? 0 : 1]}`).join(", ")}
            {view.parts.length ? "; " : ""}
            {view.icons.matched > 0 ? `${view.icons.matched} icons matched to official marks (${view.icons.brands.join(", ")}), ` : ""}
            {view.icons.traced} {view.icons.traced === 1 ? "icon" : "icons"} traced from the design as vectors.
          </p>
          {view.sharedLayouts.map((g) => (
            <div key={g.pages.join()} className="kit-shared">
              <p className="hint">
                These pages share a layout ({g.agreement}% alike): {g.pages.join(", ")}. {g.pages.slice(1).join(" and ")} can be filled in from {g.pages[0]}&rsquo;s copy by code:
                their words and photos go into its layout, and each is kept only if it matches its own design at least as well as its current copy.
              </p>
              {view.canBuild && hasCopies && !working ? (
                <Button small disabled={busy} onClick={fillAll}>
                  Fill {g.pages.slice(1).join(" and ")} from {g.pages[0]} ($0)
                </Button>
              ) : null}
            </div>
          ))}
          {view.notes.map((n) => (
            <p key={n} className="hint-amber">
              {n}
            </p>
          ))}

          {view.previewUrl && view.designUrl ? (
            <div className="kit-preview">
              <p className="card-title">
                The home page put together from the kit alone: matches the design {view.previewMatch ?? "?"}%
              </p>
              <p className="hint">Fixed positions and no AI: it shows the kit has everything, not how the site will be built.</p>
              <div className="kit-preview-pair">
                <figure>
                  <figcaption>The design</figcaption>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={view.designUrl} alt="The design's home page" />
                </figure>
                <figure>
                  <figcaption>From the kit ($0)</figcaption>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={view.previewUrl} alt="The home page put together from the style kit" />
                </figure>
              </div>
              {view.previewMisses.length ? (
                <ul className="kit-misses">
                  {view.previewMisses.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              ) : (
                <p className="hint">Element check: every item present, in the kit&rsquo;s fonts, nothing cut off or overlapping.</p>
              )}
              {view.sheetUrl ? (
                <a className="plain-link" href={view.sheetUrl} target="_blank" rel="noreferrer">
                  Open the kit sheet
                </a>
              ) : null}
            </div>
          ) : null}

          {hasCopies ? (
            <div className="kit-repair">
              <div className="exact-head">
                <div>
                  <p className="card-title">Repair the copies with the kit</p>
                  <p className="hint">
                    Each page&rsquo;s newest copy gets the kit&rsquo;s panels, boxes, ribbons, buttons, icons and fonts by code, then is checked again. A section that comes out worse is
                    put back as it was. $0, no AI; anything still wrong is listed below with the price of rebuilding just that section.
                  </p>
                </div>
                {view.canBuild && !working ? (
                  <Button small disabled={busy} onClick={repairAll}>
                    {repair ? "Repair them again ($0)" : "Repair the copies ($0)"}
                  </Button>
                ) : null}
              </div>
              {repair && repair.working > 0 ? <p className="hint content-warn">Repairing {repair.working} {repair.working === 1 ? "copy" : "copies"}... This page refreshes itself.</p> : null}
              {repair && repair.repaired.length > 0 ? (
                <table className="kit-fonts">
                  <thead>
                    <tr>
                      <th>Page</th>
                      <th>Match</th>
                      <th>Kit items put in</th>
                    </tr>
                  </thead>
                  <tbody>
                    {repair.repaired.map((r) => (
                      <tr key={r.copyId}>
                        <td>
                          <a className="plain-link" href={`/projects/${projectId}/mockups/design/copy?copy=${r.copyId}`}>
                            {r.page}
                          </a>
                          {r.filledFrom ? <span className="hint"> (filled from {r.filledFrom})</span> : null}
                        </td>
                        <td className="hint">
                          {r.before}% to {r.after}%
                        </td>
                        <td className="hint">
                          {r.placed}
                          {r.keptAsBefore.length ? `; kept as before: ${r.keptAsBefore.join(", ")}` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
              {repair?.failed.map((f) => (
                <p key={f.page} className="hint-error">
                  {f.page}: {f.reason}
                </p>
              ))}
              {repair && repair.repaired.length > 0 ? (
                repair.paid.length ? (
                  <div>
                    <p className="hint-amber">
                      {repair.paid.length} {repair.paid.length === 1 ? "section needs" : "sections need"} a paid rebuild, about {repair.perSection.label} each on {repair.perSection.model}
                      {repair.perSection.measured ? "" : " (a first guess until one is measured)"}; about ${repair.total.toFixed(2)} in all. Nothing is rebuilt without a go.
                    </p>
                    <ul className="kit-misses">
                      {repair.paid.map((p) => (
                        <li key={`${p.copyId}-${p.section}`}>
                          <strong>
                            {p.page}: &ldquo;{p.section}&rdquo;
                          </strong>{" "}
                          (about {repair.perSection.label}): {p.reasons.join(" ")}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="hint">Every section passes the kit check: nothing needs a paid rebuild.</p>
                )
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
