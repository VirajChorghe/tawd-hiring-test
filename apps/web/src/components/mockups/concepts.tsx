"use client";

import { StopButton } from "@/components/ui/stop-button";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState, useTransition } from "react";

import { recordClientDecisionAction, setSendToClientAction, showHeldConceptAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import type { ConceptReferenceUse } from "@/lib/reference-use";

/*
  Mockups 3: concepts ready. DESIGN.md, Mockup engine screens.

  The cards, the three-step strip (team review, client pack, client
  decision), the Record client decision dialog and Regenerate. The header
  buttons and the strip's links open the same dialog, so the state lives in
  a small provider around the whole screen.
*/

export interface ConceptCard {
  id: string;
  label: string;
  href: string;
  directionLabel: string;
  skillLabel: string;
  status: string;
  failureReason: string | null;
  imageUrl: string | null;
  version: number | null;
  reviewBefore: number | null;
  reviewAfter: number | null;
  checksPassed: boolean | null;
  /** The homepage file the team supplied: not built by a skill, not judged by TAWD's page checks, never changed or reviewed by AI. */
  supplied?: boolean;
  failingChecks: number;
  placeholderCount: number | null;
  summary: string | null;
  openComments: number;
  sendToClient: boolean;
  needsPmReview: boolean;
  pending: { status: string; detail: string | null; nextVersion: number } | null;
  lastFailure: string | null;
  /** How much of each reference site it used (0.99.0); null without studied references. */
  references?: ConceptReferenceUse | null;
}

interface Board {
  projectId: string;
  canAct: boolean;
  concepts: ConceptCard[];
  /** The concept the client approved, once they have. */
  chosenId?: string | null;
  /** False when new concepts can't be generated here (Lane 2 Option A). Absent means yes. */
  canRegenerate?: boolean;
  /** Lane 2, Option B: these concepts are alternatives to the designer's design (4c-2b). */
  alternatives?: boolean;
  /** Design only (0.100.0): the client's pick moves the project to Build, not Content. */
  designOnly?: boolean;
  /** What a round of changes costs, with its model, shown before the client's "changes requested" spends it. */
  changesEstimate?: string;
  /** Admins may show a held concept anyway (8 October 2026). */
  isAdmin?: boolean;
  /** Opened from a concept's page (8 October 2026): the decision dialog opens with that concept chosen. */
  decideFor?: string | null;
}

const BoardContext = createContext<{
  board: Board;
  openDecision: () => void;
  openRegenerate: () => void;
} | null>(null);

function useBoard() {
  const value = useContext(BoardContext);
  if (!value) throw new Error("Concept board controls must sit inside ConceptBoardProvider.");
  return value;
}

export function ConceptBoardProvider({
  board,
  children,
}: {
  board: Board;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"decision" | "regenerate" | null>(
    board.decideFor && board.concepts.some((c) => c.id === board.decideFor && c.status === "ready") ? "decision" : null,
  );

  // While a new version is being made, keep the cards current.
  const working = board.concepts.some((c) => c.pending);
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(timer);
  }, [working, router]);

  return (
    <BoardContext.Provider
      value={{
        board,
        openDecision: () => setDialog("decision"),
        openRegenerate: () => setDialog("regenerate"),
      }}
    >
      {children}
      {dialog === "decision" ? (
        <DecisionDialog board={board} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === "regenerate" ? (
        <RegenerateDialog projectId={board.projectId} alternatives={board.alternatives ?? false} onClose={() => setDialog(null)} />
      ) : null}
    </BoardContext.Provider>
  );
}

/* ---------- header buttons ---------- */

/* The header's quiet tool, top right: regenerate (30 September 2026). */
export function ConceptBoardActions() {
  const { board, openRegenerate } = useBoard();
  if (!board.canAct || board.canRegenerate === false) return null;
  return (
    <Button variant="secondary" onClick={openRegenerate}>
      {board.alternatives ? "Build alternatives again" : "Regenerate concepts"}
    </Button>
  );
}

/* The next-step bar's buttons on the concept board: the client pack, then the client's decision. */
export function ConceptBoardBarActions() {
  const { board, openDecision } = useBoard();
  if (!board.canAct) return null;
  const ready = board.concepts.some((c) => c.status === "ready");
  const ticked = board.concepts.some((c) => c.status === "ready" && c.sendToClient);
  return (
    <>
      {ticked ? (
        <a className="btn btn-secondary" href={`/projects/${board.projectId}/mockups/client-pack`} download>
          Download client pack
        </a>
      ) : null}
      <Button variant="primary" onClick={openDecision} disabled={!ready}>
        Record client decision
      </Button>
    </>
  );
}

/* ---------- the cards ---------- */

export function ConceptCards() {
  const { board } = useBoard();
  return (
    <div id="concepts" className={`concept-cards concept-cards-${Math.min(3, board.concepts.length)}`}>
      {board.concepts.map((card) => (
        <ConceptCardView
          key={card.id}
          card={card}
          projectId={board.projectId}
          canAct={board.canAct}
          isAdmin={Boolean(board.isAdmin)}
          pick={board.chosenId ? (board.chosenId === card.id ? "chosen" : "other") : null}
        />
      ))}
    </div>
  );
}

function ConceptCardView({
  card,
  projectId,
  canAct,
  isAdmin,
  pick,
}: {
  card: ConceptCard;
  projectId: string;
  canAct: boolean;
  isAdmin: boolean;
  /** After approval: the client's pick stands out, the others fade. */
  pick: "chosen" | "other" | null;
}) {
  const router = useRouter();
  const [send, setSend] = useState(card.sendToClient);
  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const ready = card.status === "ready";
  // Under 4.5 (8 October 2026): not shown, not sent; the reason and, for admins, Show it anyway.
  const held = card.status === "held";

  return (
    <article
      className={["concept-card", pick === "chosen" ? "is-picked" : null, pick === "other" ? "is-faded" : null]
        .filter(Boolean)
        .join(" ")}
      aria-labelledby={`concept-${card.label}`}
    >
      <div className="concept-render">
        {held ? (
          <span className="concept-render-empty">
            {card.failureReason?.startsWith("breaks a house rule")
              ? "Held: breaks a house rule"
              : card.failureReason?.startsWith("wasn't reviewed")
                ? "Held: not reviewed"
                : "Held: under 4.5"}
          </span>
        ) : card.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed R2 link
          <img src={card.imageUrl} alt={`Concept ${card.label}, desktop homepage`} />
        ) : (
          <span className="concept-render-empty">
            {ready ? "No render" : card.status === "failed" ? "Didn't finish" : "Not built"}
          </span>
        )}
      </div>

      <div className="concept-card-body">
        <div className="concept-card-head">
          <h3 className="concept-card-title" id={`concept-${card.label}`}>
            Concept {card.label}
          </h3>
          {pick === "chosen" ? <span className="pick-badge">Client&rsquo;s pick</span> : null}
          {ready && canAct ? (
            <label className="check-label">
              <input
                type="checkbox"
                checked={send}
                disabled={saving}
                onChange={(event) => {
                  const next = event.target.checked;
                  setSend(next);
                  setError(null);
                  startSaving(async () => {
                    const result = await setSendToClientAction(projectId, card.id, next);
                    if (!result.ok) {
                      setSend(!next);
                      setError(result.message);
                    }
                    router.refresh();
                  });
                }}
              />
              Send to client
            </label>
          ) : null}
        </div>
        <p className="concept-card-sub">
          {card.directionLabel}
          {card.skillLabel ? `, built with ${card.skillLabel}` : ""}
        </p>

        {ready ? (
          <div className="concept-badges">
            {card.supplied ? (
              <span className="pill pill-muted">Supplied page</span>
            ) : card.reviewAfter !== null ? (
              <span className="pill">
                Review{" "}
                {card.reviewBefore !== null && card.reviewBefore !== card.reviewAfter
                  ? `${card.reviewBefore.toFixed(1)} to ${card.reviewAfter.toFixed(1)}`
                  : card.reviewAfter.toFixed(1)}
              </span>
            ) : (
              <span className="pill pill-muted">Not reviewed</span>
            )}
            {card.supplied ? (
              <span className="pill pill-muted">Not checked by TAWD</span>
            ) : card.checksPassed === false ? (
              <span className="pill pill-amber">
                {card.failingChecks} check{card.failingChecks === 1 ? "" : "s"} failing
              </span>
            ) : (
              <span className="pill">All checks passed</span>
            )}
            {card.placeholderCount ? (
              <span className="pill pill-amber">
                {card.placeholderCount} placeholder{card.placeholderCount === 1 ? "" : "s"}
              </span>
            ) : null}
            {card.version !== null ? <span className="pill pill-muted">v{card.version}</span> : null}
            {card.needsPmReview ? <span className="pill pill-red">Needs PM review</span> : null}
          </div>
        ) : null}

        {held ? (
          <div className="concept-held">
            <p className="hint">
              Held by TAWD, not shown to the team or the client: it {card.failureReason ?? "scored under 4.5."} Only reviewed concepts at 4.5 or above, with no house rule broken, are shown.
            </p>
            {isAdmin ? (
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                {/* An admin looks before deciding (8 October 2026); the team and the client still don't see it. */}
                <Link href={card.href} className="btn btn-secondary btn-small">
                  Look at it
                </Link>
                <ShowAnywayButton projectId={projectId} conceptId={card.id} label={card.label} />
              </div>
            ) : null}
          </div>
        ) : card.failureReason && !ready ? (
          <p className="hint-error">{card.failureReason}</p>
        ) : null}
        {card.summary && ready ? <p className="concept-signature">{card.summary}</p> : null}
        {card.references && ready ? <ReferencesUsed use={card.references} /> : null}

        {card.pending ? (
          <div className="stop-line">
            <p className="concept-working">
              <span className="step-dot" aria-hidden="true" />
              Making v{card.pending.nextVersion}: {card.pending.detail ?? "waiting its turn"}
            </p>
            <StopButton projectId={projectId} kind="changes" what="the requested changes" />
          </div>
        ) : card.lastFailure ? (
          <p className="hint-error">The last requested changes didn&rsquo;t finish: {card.lastFailure}</p>
        ) : null}
        {error ? <p className="hint-error">{error}</p> : null}

        <div className="concept-card-foot">
          <span className="hint">
            {card.openComments === 0
              ? "No comments"
              : `${card.openComments} open comment${card.openComments === 1 ? "" : "s"}`}
          </span>
          {ready ? (
            <Link href={card.href} className="btn btn-secondary">
              Open
            </Link>
          ) : null}
        </div>
      </div>
    </article>
  );
}

/* How much of each reference site the concept used, measured by code (0.99.0). */
function ReferencesUsed({ use }: { use: ConceptReferenceUse }) {
  return (
    <details className="hint concept-refs">
      <summary>Reference sites used: about {use.percent}%</summary>
      <ul>
        {use.sites.map((site) => (
          <li key={site.url}>
            <strong>
              {site.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}: about {site.percent}%
            </strong>
            {site.liked ? <span> The client likes: &ldquo;{site.liked}&rdquo;</span> : null}
            {site.taken.length ? <span> Taken: {site.taken.join("; ")}.</span> : null}
            {site.notTaken.length ? <span> Not taken: {site.notTaken.join("; ")}.</span> : null}
          </li>
        ))}
      </ul>
      <p>
        {use.orderFromWireframe ? "The section order came from the approved wireframe, not the references. " : ""}
        Measured by code from the concept&rsquo;s sections, hero, kinds of proof and service layout. Colours, fonts,
        words and photos never come from a reference.
      </p>
    </details>
  );
}

/* ---------- the three steps ---------- */

export function NextStepsStrip() {
  const { board, openDecision } = useBoard();
  const ticked = board.concepts.filter((c) => c.status === "ready" && c.sendToClient);
  const letters = ticked.map((c) => c.label).join(", ");

  return (
    <div className="card steps-strip">
      <div className="steps-strip-item">
        <span className="next-step-number" aria-hidden="true">1</span>
        <div>
          <p className="card-title">Team review</p>
          <p className="hint">Open each concept, pin comments, request changes if needed.</p>
        </div>
      </div>
      <div className="steps-strip-item">
        <span className="next-step-number" aria-hidden="true">2</span>
        <div>
          <p className="card-title">Send to the client</p>
          <p className="hint">
            Tick the concepts to send, then download the client pack: desktop images labeled
            Concept {letters || "A, B, C"}.
          </p>
          {board.canAct ? (
            ticked.length > 0 ? (
              <a className="link-strong" href={`/projects/${board.projectId}/mockups/client-pack`} download>
                Download client pack
              </a>
            ) : (
              <p className="hint-missing">Tick Send to client on at least one concept first.</p>
            )
          ) : null}
        </div>
      </div>
      <div className="steps-strip-item">
        <span className="next-step-number" aria-hidden="true">3</span>
        <div>
          <p className="card-title">Record the client&rsquo;s decision</p>
          <p className="hint">
            After the call or email: which concept, and any changes they asked for.
          </p>
          {board.canAct ? (
            <button type="button" className="link-strong link-button" onClick={openDecision}>
              Record client decision
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ---------- Record client decision ---------- */

export function DecisionDialog({
  board,
  onClose,
}: {
  board: Board;
  onClose: () => void;
}) {
  const router = useRouter();
  const choices = board.concepts.filter((c) => c.status === "ready");
  const [conceptId, setConceptId] = useState<string | null>(
    board.decideFor && choices.some((c) => c.id === board.decideFor) ? board.decideFor : choices.length === 1 ? choices[0]!.id : null,
  );
  const [channel, setChannel] = useState("phone");
  const [changes, setChanges] = useState<boolean | null>(null);
  const [said, setSaid] = useState("");
  const [logoApproved, setLogoApproved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const chosen = choices.find((c) => c.id === conceptId);
  const ready = conceptId !== null && changes !== null && said.trim().length >= 3;

  return (
    <div className="modal-backdrop">
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="decision-title">
        <div>
          <h2 className="section-title" id="decision-title">
            Record the client&rsquo;s decision
          </h2>
          <p className="hint">Saved to the timeline with your name and the time.</p>
        </div>

        <fieldset className="choice-group">
          <legend className="field-label">
            <span>Which concept did the client choose?</span>
          </legend>
          <div className={`decision-picks decision-picks-${Math.min(3, choices.length)}`}>
            {choices.map((c) => (
              <label key={c.id} className={conceptId === c.id ? "decision-pick is-on" : "decision-pick"}>
                <span className="decision-thumb">
                  {c.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed R2 link
                    <img src={c.imageUrl} alt="" />
                  ) : null}
                </span>
                <span className="decision-pick-name">
                  <input
                    type="radio"
                    name="decision-concept"
                    checked={conceptId === c.id}
                    onChange={() => setConceptId(c.id)}
                  />
                  Concept {c.label}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="decision-row">
          <div className="field">
            <label className="field-label" htmlFor="decision-channel">
              <span>How it came in</span>
            </label>
            <select
              id="decision-channel"
              className="select"
              value={channel}
              onChange={(event) => setChannel(event.target.value)}
            >
              <option value="phone">Phone call</option>
              <option value="email">Email</option>
              <option value="meeting">Meeting</option>
            </select>
          </div>
          <fieldset className="choice-group">
            <legend className="field-label">
              <span>Changes before approval?</span>
            </legend>
            <div className="radio-row">
              <label className="check-label">
                <input type="radio" name="decision-changes" checked={changes === true} onChange={() => setChanges(true)} />
                Yes, changes requested
              </label>
              <label className="check-label">
                <input type="radio" name="decision-changes" checked={changes === false} onChange={() => setChanges(false)} />
                No, approved as is
              </label>
            </div>
          </fieldset>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="decision-said">
            <span>What the client said</span>
          </label>
          <textarea
            id="decision-said"
            className="textarea"
            rows={3}
            value={said}
            onChange={(event) => setSaid(event.target.value)}
            placeholder="For example: likes B, wants the phone number bigger in the hero and the red swapped for their brand blue."
          />
          <p className="hint">
            {changes === true && chosen?.supplied
              ? `This is the homepage file the team supplied, so TAWD makes no new version. The decision is recorded and the project stays at Design: change the HTML file, remove the old one on Intake and upload the new one.`
              : changes === true && chosen
              ? `TAWD makes v${(chosen.version ?? 0) + 1} of Concept ${chosen.label} from this, for the team to check. The project stays at Design.${board.changesEstimate ? ` ${board.changesEstimate}.` : ""}`
              : changes === false && chosen
                ? `The project moves to ${board.designOnly ? "Build" : "Content"} with Concept ${chosen.label} v${chosen.version}.`
                : `Changes requested: TAWD makes a new version of the chosen concept for the team to check. Approved as is: the project moves to ${board.designOnly ? "Build" : "Content"}.`}
          </p>
        </div>

        <div className="field">
          <label className="check-label">
            <input type="checkbox" checked={logoApproved} onChange={(event) => setLogoApproved(event.target.checked)} />
            Logo approved by the client
          </label>
          <p className="hint">The logo on the chosen concept: the client&rsquo;s own, or the one TAWD designed. Recorded with the decision.</p>
        </div>

        {error ? <p className="hint-error">{error}</p> : null}

        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!ready || saving}
            onClick={() => {
              if (!conceptId || changes === null) return;
              setError(null);
              startSaving(async () => {
                const result = await recordClientDecisionAction(board.projectId, {
                  conceptId,
                  channel,
                  changesRequested: changes,
                  clientSaid: said,
                  logoApproved,
                });
                if (!result.ok) {
                  setError(result.message);
                  return;
                }
                onClose();
                router.refresh();
              });
            }}
          >
            {saving ? "Saving..." : changes === true && chosen && !chosen.supplied ? `Save and make v${(chosen.version ?? 0) + 1}` : "Save decision"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Regenerate ---------- */

function RegenerateDialog({ projectId, alternatives, onClose }: { projectId: string; alternatives: boolean; onClose: () => void }) {
  const router = useRouter();
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="regenerate-title">
        <h2 className="section-title" id="regenerate-title">
          {alternatives ? "Build new alternatives?" : "Generate new concepts?"}
        </h2>
        <p className="hint">
          {alternatives
            ? "You choose one or two again, and TAWD builds a new set with the designer’s brand and words. These alternatives, their versions and comments are kept under Earlier runs, but the new set becomes the one the team reviews and the client pack uses."
            : "You choose the count and directions again, and TAWD builds a new set. These concepts, their versions and comments are kept under Earlier runs, but the new set becomes the one the team reviews and the client pack uses."}
        </p>
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onClose();
              router.push(`/projects/${projectId}/mockups?setup=1`);
            }}
          >
            {alternatives ? "Choose again" : "Set up new concepts"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* An admin shows a held concept anyway (Jason, 8 October 2026), so a project is never stuck at Design. Logged. */
function ShowAnywayButton({ projectId, conceptId, label }: { projectId: string; conceptId: string; label: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
      {confirming ? (
        <>
          <span className="hint">Show Concept {label} to the team and the client, under 4.5? This is logged.</span>
          <Button small onClick={() => setConfirming(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            small
            variant="primary"
            disabled={busy}
            onClick={() =>
              start(async () => {
                setError(null);
                const result = await showHeldConceptAction(projectId, conceptId);
                if (!result.ok) setError(result.message);
                setConfirming(false);
                router.refresh();
              })
            }
          >
            {busy ? "Showing..." : "Yes, show it"}
          </Button>
        </>
      ) : (
        <Button small variant="secondary" onClick={() => setConfirming(true)}>
          Show it anyway
        </Button>
      )}
      {error ? <p className="hint-error">{error}</p> : null}
    </div>
  );
}
