"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { startRunAction } from "@/app/actions";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import {
  assignSkills,
  checkDesignLog,
  directionIds,
  directions,
  formatCost,
  skillLabels,
} from "@/lib/mockup-labels";
import type { DesignLogNeighbour, DirectionId, SkillId } from "@tawd/core/mockups";
import type { Trade } from "@tawd/core/enums";

/*
  Mockups 1: set up the concepts. DESIGN.md, Mockup engine screens.

  TAWD's picks come from the intake and DIRECTIONS.md; the team can change
  the count and any direction before generating. Since 27 September 2026
  the directions are proposed after the inputs: the screen first shows what
  the proposal rests on (the brand, the real photos, the reference sites,
  with a "results will be weaker" note for any missing), then the proposal;
  the dropdowns are the PM's override, opened with "Change directions". A changed set is checked
  against the same rules in the browser, so a broken rule is shown before
  anything is spent, and again on the server, which has the last word.
*/

export interface SetupInputs {
  logo: boolean;
  colors: string[];
  colorsFrom: "entered" | "logo" | "none";
  photos: { count: number; people: number; work: number };
  references: { url: string; shot: boolean; studied: boolean }[];
  notes: { input: "logo" | "photos" | "references"; text: string }[];
}

export interface SetupPlan {
  /** What the proposal rests on; absent on older callers. */
  inputs?: SetupInputs;
  trade: Trade;
  tradeLabel: string;
  emergency: boolean;
  moodWords: string[];
  notes: string[];
  hasFoundingYear: boolean;
  /** Why Generate is disabled this month, if the AI limit is reached. */
  limitBlocked: string | null;
  /** The current website isn't answered yet: Generate waits (30 September 2026). */
  websiteBlocked?: string | null;
  /** The intake section of the first blocking answer (website, or content for the project type). */
  websiteBlockedSection?: string | null;
  /** The Home page words aren't used yet: Generate waits (1 October 2026). */
  wordsBlocked?: string | null;
  /** The wireframe isn't approved yet (Growth and Pro, 3 October 2026). */
  wireframeBlocked?: string | null;
  /** The line beside Generate: whether facts are missing. */
  footnote: string;
  estimates: Record<1 | 2 | 3, { costLabel: string; costLabelNoPolish?: string; middle: number; minutes: number }>;
  estimateBasis: string;
  /** The model the concepts are built on, shown with the estimate (standing rule 2; 13 October 2026, the whole-code review). */
  modelLabel?: string;
  /** Reference sites the run studies first (not studied yet). */
  referenceSitesToStudy?: number;
  /** The direction each studied reference site is closest to (0.99.0). */
  referenceLeans?: { url: string; direction: DirectionId }[];
  designLogInput: {
    city: string | null;
    paletteFamily: string | null;
    neighbours: DesignLogNeighbour[];
  };
  concepts: {
    label: string;
    direction: DirectionId;
    skillId: SkillId;
    reason: string;
  }[];
}

const NEXT_STEPS: { title: string; line: string }[] = [
  { title: "Study the reference sites.", line: "Their structure and craft, never their identity (only sites not studied yet)." },
  { title: "Build.", line: "Each skill designs a desktop homepage from the intake, the client's photos and the references." },
  { title: "Render check.", line: "At 1440px: the footer and every planned section, nothing clipped or overflowing, no text over faces; pictures, icons, colour and button labels fixed by code. Before any review." },
  { title: "Creative Director review.", line: "Scores each concept on 11 questions, against the reference sites." },
  { title: "At 4.5 or above, it's ready;", line: "under that, one rewrite of the sections the notes name and one more score. No rebuild." },
  { title: "Critique and polish.", line: "One Impeccable pass per concept, before and after kept (you can skip it)." },
  { title: "Ready for the team at 4.5 or above.", line: "Under 4.5 it's held, with the reason; an admin can show it anyway." },
];

export function MockupSetup({
  projectId,
  plan,
  canRun,
  lastRunProblem,
}: {
  projectId: string;
  plan: SetupPlan;
  canRun: boolean;
  /** A run that ended without concepts, said plainly. */
  lastRunProblem?: string | null;
}) {
  const router = useRouter();
  const [count, setCount] = useState<1 | 2 | 3>(
    Math.min(3, Math.max(1, plan.concepts.length)) as 1 | 2 | 3,
  );
  const [error, setError] = useState<string | null>(null);
  const [starting, startTransition] = useTransition();

  const [overriding, setOverriding] = useState(false);
  const [polish, setPolish] = useState(true);
  const [chosen, setChosen] = useState<Record<string, DirectionId>>(() =>
    Object.fromEntries(plan.concepts.map((c) => [c.label, c.direction])),
  );

  const concepts = plan.concepts.slice(0, count).map((pick) => ({
    ...pick,
    direction: chosen[pick.label] ?? pick.direction,
    changed: (chosen[pick.label] ?? pick.direction) !== pick.direction,
  }));

  const checked = assignSkills(
    concepts.map((c) => ({ label: c.label as "A" | "B" | "C", direction: c.direction })),
    { trade: plan.trade, hasFoundingYear: plan.hasFoundingYear },
  );
  const anyChanged = concepts.some((c) => c.changed);
  const skillFor = (label: string, fallback: SkillId) =>
    anyChanged ? (checked.concepts.find((c) => c.label === label)?.skillId ?? fallback) : fallback;
  const blocked = anyChanged && checked.problems.length > 0;

  const estimate = plan.estimates[count];
  const perExtra = Math.max(0, plan.estimates[2].middle - plan.estimates[1].middle);

  const lede = [
    plan.tradeLabel.toLowerCase(),
    plan.emergency ? "emergency trade" : null,
    plan.moodWords.length > 0 ? `mood "${plan.moodWords.join(", ")}"` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="setup-layout" id="setup">
      <div className="card setup-main">
        <h2 className="setup-title">Set up the concepts</h2>
        <p className="page-lede">
          TAWD proposes directions from the client&rsquo;s brand, photos and reference sites, and the intake: {lede}. Change anything before generating.
        </p>
        <p className="hint">
          Already have a finished homepage as one HTML file?{" "}
          <a href={`/projects/${projectId}/intake?section=homepage`}>Upload it on Intake</a>: it goes on the board as a concept, free, with no AI.
        </p>

        {plan.inputs ? <InputsPanel inputs={plan.inputs} /> : null}

        {lastRunProblem ? (
          <div style={{ marginTop: 16 }}>
            <Banner tone="error" title="The last run didn't produce concepts">
              {lastRunProblem}
            </Banner>
          </div>
        ) : null}

        {error ? (
          <div style={{ marginTop: 16 }}>
            <Banner tone="error" title={error} />
          </div>
        ) : null}

        <div className="setup-count">
          <span className="setup-count-label" id="concept-count-label">
            How many concepts?
          </span>
          <div className="segmented" role="radiogroup" aria-labelledby="concept-count-label">
            {([1, 2, 3] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                className="segment"
                aria-checked={count === value}
                disabled={!canRun}
                onClick={() => setCount(value)}
              >
                {value}
              </button>
            ))}
          </div>
          <p className="hint">
            Each extra concept adds roughly {formatCost(perExtra)} of AI, plus review time.
          </p>
        </div>

        <div className={`setup-cards setup-cards-${count}`}>
          {concepts.map((pick) => {
            const log = checkDesignLog({ direction: pick.direction, ...plan.designLogInput });
            const required = pick.reason.startsWith("Required");
            return (
              <div key={pick.label} className="setup-card">
                <div className="setup-card-head">
                  <h3 className="card-title">Concept {pick.label}</h3>
                  <span className={pick.changed ? "tag tag-muted" : required ? "tag tag-amber" : "tag"}>
                    {pick.changed ? "Changed by you" : required ? pick.reason : "Suggested"}
                  </span>
                </div>
                {!overriding ? (
                  <p className="setup-card-direction">{directions[pick.direction].label}</p>
                ) : null}
                {overriding ? (
                <>
                <label className="field-label" htmlFor={`direction-${pick.label}`}>
                  <span>Direction</span>
                </label>
                <select
                  id={`direction-${pick.label}`}
                  className="select"
                  value={pick.direction}
                  disabled={!canRun}
                  onChange={(event) =>
                    setChosen((current) => ({
                      ...current,
                      [pick.label]: event.target.value as DirectionId,
                    }))
                  }
                >
                  {directionIds.map((id) => (
                    <option key={id} value={id}>
                      {directions[id].label}
                    </option>
                  ))}
                </select>
                </>
                ) : null}
                <p className="setup-card-look">{directions[pick.direction].description}</p>
                <dl className="setup-card-facts">
                  <div>
                    <dt>Built with</dt>
                    <dd>
                      <strong>{skillLabels[skillFor(pick.label, pick.skillId)]}</strong>
                    </dd>
                  </div>
                  {plan.referenceLeans && plan.referenceLeans.length > 0 ? (
                    <div>
                      <dt>References</dt>
                      <dd className={leansTo(plan.referenceLeans, pick.direction) ? "log-clear" : "log-clash"}>
                        {leansTo(plan.referenceLeans, pick.direction) ? <CheckIcon /> : <WarnIcon />}
                        {referenceLeanLine(plan.referenceLeans, pick.direction)}
                      </dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>Design log</dt>
                    <dd className={log.clash ? "log-clash" : "log-clear"}>
                      {log.clash ? <WarnIcon /> : <CheckIcon />}
                      {log.clash ? log.message : "No clash nearby"}
                    </dd>
                  </div>
                </dl>
              </div>
            );
          })}
        </div>

        {canRun && !overriding ? (
          <div className="setup-override">
            <Button small variant="secondary" onClick={() => setOverriding(true)}>
              Change directions
            </Button>
            <span className="hint">Override the proposal. Your choice is checked against the direction rules and logged.</span>
          </div>
        ) : null}

        {blocked ? (
          <div style={{ marginTop: 20 }}>
            <Banner tone="error" title="These choices break a direction rule">
              {checked.problems.join(" ")}
            </Banner>
          </div>
        ) : null}

        {!blocked && checked.warnings.length > 0 ? (
          <div style={{ marginTop: 20 }}>
            <Banner tone="warning" title="Worth a second look">
              {checked.warnings.join(" ")}
            </Banner>
          </div>
        ) : null}

        {plan.notes.length > 0 ? (
          <div className="setup-why">
            <p className="card-title">Why TAWD proposes these directions</p>
            <ul>
              {plan.notes.map((note) => (
                <li key={note}>{note.charAt(0).toUpperCase() + note.slice(1)}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {plan.websiteBlocked ? (
          <div style={{ marginTop: 20 }}>
            <Banner tone="error" title="Finish the intake first">
              {plan.websiteBlocked}{" "}
              <a href={`/projects/${projectId}/intake?section=${plan.websiteBlockedSection ?? "website"}`}>
                {plan.websiteBlockedSection === "content" ? "Open the Content section" : "Open the Website section"}
              </a>
            </Banner>
          </div>
        ) : null}

        {plan.wireframeBlocked && !plan.websiteBlocked ? (
          <div style={{ marginTop: 20 }}>
            <Banner tone="error" title="Approve the wireframe first">
              {plan.wireframeBlocked} <a href="#wireframe">Open the wireframe</a>
            </Banner>
          </div>
        ) : null}

        {plan.wordsBlocked && !plan.websiteBlocked ? (
          <div style={{ marginTop: 20 }}>
            <Banner tone="error" title="The Home page words come first">
              {plan.wordsBlocked}
            </Banner>
          </div>
        ) : null}

        {plan.limitBlocked ? (
          <div style={{ marginTop: 20 }}>
            <Banner tone="error" title="Monthly AI limit reached">
              {plan.limitBlocked}
            </Banner>
          </div>
        ) : null}

        <label className="checkline setup-polish">
          <input type="checkbox" checked={polish} disabled={!canRun} onChange={(event) => setPolish(event.target.checked)} />
          Critique and polish each concept after the review
          <span className="hint">One bounded Impeccable pass (spacing, type scale, repeated decoration, card grids, labels, alignment). Included in the estimate.</span>
        </label>

        <div className="setup-foot">
          <p className="hint">{plan.footnote}</p>
          {canRun ? (
            <Button
              variant="primary"
              disabled={starting || blocked || plan.limitBlocked !== null || Boolean(plan.websiteBlocked) || Boolean(plan.wordsBlocked) || Boolean(plan.wireframeBlocked)}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await startRunAction(
                    projectId,
                    count,
                    concepts.map((c) => ({ label: c.label as "A" | "B" | "C", direction: c.direction })),
                    { polish },
                  );
                  if (!result.ok) {
                    setError(result.message);
                    return;
                  }
                  router.refresh();
                });
              }}
            >
              {starting ? "Starting..." : `Generate ${count} concept${count === 1 ? "" : "s"}`}
            </Button>
          ) : (
            <p className="hint">A PM or admin starts the run.</p>
          )}
        </div>
      </div>

      <aside className="card setup-side" aria-label="What happens next">
        <h2 className="card-title">What happens next</h2>
        <ol className="next-steps">
          {NEXT_STEPS.map((step, index) => (
            <li key={step.title}>
              <span className="next-step-number" aria-hidden="true">
                {index + 1}
              </span>
              <span>
                <strong>{step.title}</strong> {step.line}
              </span>
            </li>
          ))}
        </ol>
        <dl className="setup-estimate">
          <div>
            <dt>Estimated time</dt>
            <dd>About {estimate.minutes} minutes</dd>
          </div>
          <div>
            <dt>Estimated AI cost</dt>
            <dd>{polish ? estimate.costLabel : (estimate.costLabelNoPolish ?? estimate.costLabel)}</dd>
          </div>
          {plan.modelLabel ? (
            <div>
              <dt>Model</dt>
              <dd>{plan.modelLabel}</dd>
            </div>
          ) : null}
        </dl>
        <p className="hint">
          {plan.estimateBasis}
          {plan.referenceSitesToStudy ? ` Includes studying ${plan.referenceSitesToStudy} reference site${plan.referenceSitesToStudy === 1 ? "" : "s"}.` : ""}
          {polish ? " Includes critique and polish." : ""} You can leave this page. TAWD keeps working in the background.
        </p>
      </aside>
    </div>
  );
}

/* Whether any studied reference site is closest to this direction (0.99.0). */
export function leansTo(leans: { direction: DirectionId }[], direction: DirectionId): boolean {
  return leans.some((l) => l.direction === direction);
}

export function referenceLeanLine(leans: { direction: DirectionId }[], direction: DirectionId): string {
  const count = leans.filter((l) => l.direction === direction).length;
  const sites = `${leans.length} studied reference site${leans.length === 1 ? "" : "s"}`;
  if (count > 0) return leans.length === 1 ? "The studied reference site leans this way" : `${count === leans.length ? "All" : `${count} of the`} ${sites} lean this way`;
  const others = [...new Set(leans.map((l) => directions[l.direction].label))];
  return `None of the ${sites} lean this way (${leans.length === 1 ? "it leans" : "they lean"} to ${others.join(", ")})`;
}

const INPUT_TITLES: Record<SetupInputs["notes"][number]["input"], string> = {
  logo: "Brand",
  photos: "Real photos",
  references: "Reference sites",
};

/* What the proposal rests on: the three main inputs, each done or missing. */
function InputsPanel({ inputs }: { inputs: SetupInputs }) {
  const noteFor = (input: keyof typeof INPUT_TITLES) => inputs.notes.find((n) => n.input === input)?.text ?? null;
  const rows: { input: keyof typeof INPUT_TITLES; value: React.ReactNode }[] = [
    {
      input: "logo",
      value: inputs.colors.length ? (
        <span className="setup-input-colors">
          {inputs.colors.slice(0, 4).map((hex) => (
            <span key={hex} className="setup-input-swatch" style={{ background: hex }} title={hex} aria-hidden="true" />
          ))}
          <span>
            {inputs.colors.slice(0, 4).join(", ")}
            {inputs.colorsFrom === "logo" ? ", taken from the logo" : ""}
          </span>
        </span>
      ) : inputs.logo ? (
        "Logo uploaded; colours will be taken from it"
      ) : (
        "No logo"
      ),
    },
    {
      input: "photos",
      value:
        inputs.photos.count === 0
          ? "None yet"
          : `${inputs.photos.count} photo${inputs.photos.count === 1 ? "" : "s"}${inputs.photos.people ? `, ${inputs.photos.people} of the team` : ""}${inputs.photos.work ? `, ${inputs.photos.work} of jobs or premises` : ""}`,
    },
    {
      input: "references",
      value:
        inputs.references.length === 0
          ? "None yet"
          : `${inputs.references.length} site${inputs.references.length === 1 ? "" : "s"}, ${inputs.references.filter((r) => r.studied).length} studied`,
    },
  ];
  return (
    <div className="setup-inputs" aria-label="What the proposal is based on">
      <p className="card-title">What the proposal is based on</p>
      <ul>
        {rows.map((row) => {
          const note = noteFor(row.input);
          // Missing only when the input isn't there at all; a note on one that is (no team photo yet) is advice.
          const weak = row.input === "logo" ? !inputs.logo : row.input === "photos" ? inputs.photos.count === 0 : inputs.references.length < 2;
          return (
            <li key={row.input}>
              <span className="setup-input-name">{INPUT_TITLES[row.input]}</span>
              <span className={weak ? "badge badge-missing" : "badge badge-done"}>{weak ? "Missing" : "In"}</span>
              <span className="setup-input-value">
                {row.value}
                {note ? <span className={weak ? "hint hint-amber" : "hint"}>{note}</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 7v6M12 17h.01" />
    </svg>
  );
}
