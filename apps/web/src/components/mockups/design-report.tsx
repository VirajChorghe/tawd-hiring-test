"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { setFindingTickedAction, setGroupTickedAction } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";

/*
  Lane 2, Option B: the Creative Director's report on the designer's
  homepage, as a full page. The design stays on the left with a numbered pin
  on each finding's layer; the findings fill the right, grouped, with
  filters, Tick all and Untick all per group and a running count. Clicking a
  finding shows its pin; clicking a pin jumps to its finding. Every tick
  saves at once and says so.
*/

export type ReportGrade = "must_fix" | "should_fix" | "recommendation" | "confirm_fact";

export interface ReportFinding {
  id: string;
  number: number;
  grade: ReportGrade;
  category: string;
  title: string;
  problem: string;
  change: string;
  why: string;
  layerName: string | null;
  pinX: number | null;
  pinY: number | null;
  ticked: boolean;
}

export interface DesignReportProps {
  projectId: string;
  canTick: boolean;
  frame: { name: string; width: number; height: number; imageUrl: string | null };
  headline: string;
  summary: string;
  line: string;
  outOfDate: boolean;
  findings: ReportFinding[];
  questions: { question: number; title: string; score: number | null; notApplicable: boolean; reason: string }[];
  safetyAdvice: { text: string; section: string }[];
  /** Opens with the scores showing, from ?tab=scores. */
  initialTab?: "fixes" | "scores";
}

const GROUPS: { grade: ReportGrade; title: string; line: string; tickLabel: string | null }[] = [
  {
    grade: "must_fix",
    title: "Must-fix",
    line: "Breaks a house rule or a floor the site must meet. Ticked to start with, except anything to confirm with the client first.",
    tickLabel: "Apply in the improved version",
  },
  { grade: "should_fix", title: "Should-fix", line: "The rest of what TAWD fixes in Option B. Tick the ones to apply.", tickLabel: "Apply in the improved version" },
  {
    grade: "confirm_fact",
    title: "Facts to confirm",
    line: "Facts in the design the intake hasn't confirmed. Check each with the client; nothing on the page changes.",
    tickLabel: "Confirmed with the client",
  },
  { grade: "recommendation", title: "Recommendations", line: "Ideas for the designer. Suggested only; never applied.", tickLabel: null },
];

export const categoryLabels: Record<string, string> = {
  accessibility: "Accessibility",
  conversion: "Conversion",
  missing_section: "Missing section",
  seo: "SEO structure",
  house_rules: "House rules",
  consistency: "Consistency",
  fonts: "Fonts",
  mobile: "Mobile",
  content: "Content",
  layout: "Layout",
  other: "Other",
};

const pinClass = (grade: ReportGrade) => `pin-${grade.replace("_", "-")}`;

export function DesignReport(props: DesignReportProps) {
  const router = useRouter();
  const [showScores, setShowScores] = useState(props.initialTab === "scores");
  const [selected, setSelected] = useState<number | null>(null);
  const [ticks, setTicks] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(props.findings.map((f) => [f.id, f.ticked])),
  );
  const [groupFilter, setGroupFilter] = useState<ReportGrade | "all">("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [tickFilter, setTickFilter] = useState<"all" | "ticked" | "unticked">("all");
  const [saving, setSaving] = useState(0);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();

  const fixes = props.findings.filter((f) => f.grade === "must_fix" || f.grade === "should_fix");
  const facts = props.findings.filter((f) => f.grade === "confirm_fact");
  const categories = [...new Set(props.findings.map((f) => f.category))].sort();

  const save = (change: Record<string, boolean>, run: () => Promise<{ ok: true } | { ok: false; message: string }>) => {
    const before = Object.fromEntries(Object.keys(change).map((id) => [id, ticks[id] ?? false]));
    setError(null);
    setTicks((prev) => ({ ...prev, ...change }));
    setSaving((n) => n + 1);
    start(async () => {
      const result = await run();
      setSaving((n) => n - 1);
      if (!result.ok) {
        setTicks((prev) => ({ ...prev, ...before }));
        setError(result.message);
        return;
      }
      setSavedAt(new Date());
      router.refresh();
    });
  };

  const tick = (finding: ReportFinding, on: boolean) =>
    save({ [finding.id]: on }, () => setFindingTickedAction(props.projectId, finding.id, on));

  const tickGroup = (grade: "must_fix" | "should_fix" | "confirm_fact", on: boolean) =>
    save(
      Object.fromEntries(props.findings.filter((f) => f.grade === grade).map((f) => [f.id, on])),
      () => setGroupTickedAction(props.projectId, grade, on),
    );

  // A pin jumps to its finding; a finding scrolls the design to its pin.
  const choosePin = (finding: ReportFinding) => {
    setSelected(finding.number);
    setGroupFilter("all");
    setCategoryFilter("all");
    setTickFilter("all");
    window.requestAnimationFrame(() =>
      document.getElementById(`finding-${finding.number}`)?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
  };
  const chooseFinding = (finding: ReportFinding) => {
    setSelected(finding.number);
    document.getElementById(`pin-${finding.number}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const shown = (f: ReportFinding) =>
    (groupFilter === "all" || f.grade === groupFilter) &&
    (categoryFilter === "all" || f.category === categoryFilter) &&
    (tickFilter === "all" || (f.grade !== "recommendation" && (ticks[f.id] ? tickFilter === "ticked" : tickFilter === "unticked")));

  const pinned = props.findings.filter((f) => f.pinX !== null && f.pinY !== null);
  const status = error ? null : saving > 0 ? "Saving..." : savedAt ? "Saved" : "Ticks save as you go";

  return (
    <div className="review-page">
      <section className="card review-head">
        <div className="review-head-main">
          <p className="design-review-score">{props.headline}</p>
          <p className="concept-signature">{props.summary}</p>
          <p className="hint">{props.line}</p>
          {props.outOfDate ? (
            <p className="hint-missing">The design was imported again since this review. Review it again to see the latest.</p>
          ) : null}
        </div>
        <div className="review-head-actions">
          <ButtonLink href={`/projects/${props.projectId}/mockups`}>Back to Design</ButtonLink>
          <Button variant="text" onClick={() => setShowScores((v) => !v)} aria-expanded={showScores}>
            {showScores ? "Hide the scores" : "Show the scores"}
          </Button>
        </div>
        {showScores ? (
          <div className="review-scores">
            <ol className="design-scores">
              {props.questions.map((q) => (
                <li key={q.question}>
                  <div className="design-score-row">
                    <span>
                      {q.question}. {q.title}
                    </span>
                    <strong>{q.notApplicable ? "Not applicable" : `${q.score} of 5`}</strong>
                  </div>
                  <p className="hint">{q.reason}</p>
                </li>
              ))}
            </ol>
            {props.safetyAdvice.length > 0 ? (
              <div className="info-note info-note-small">
                <p className="card-title">Safety advice, for the content team to check</p>
                <ul>
                  {props.safetyAdvice.map((advice) => (
                    <li key={advice.text}>
                      {advice.text} <span className="hint">({advice.section})</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <div className="review-layout">
        <div className="card review-design">
          <p className="review-design-head">
            The designer&rsquo;s &ldquo;{props.frame.name}&rdquo; frame. <strong>{pinned.length} pins</strong>
          </p>
          <div className="render-frame review-design-frame">
            <div className="render-pinnable">
              {props.frame.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed R2 link
                <img src={props.frame.imageUrl} alt={`The designer's ${props.frame.name} frame`} width={props.frame.width} height={props.frame.height} />
              ) : (
                <p className="hint">The imported picture of this frame is missing.</p>
              )}
              {pinned.map((finding) => (
                <button
                  key={finding.id}
                  id={`pin-${finding.number}`}
                  type="button"
                  className={["pin", pinClass(finding.grade), selected === finding.number ? "is-selected" : null].filter(Boolean).join(" ")}
                  style={{ left: `${finding.pinX}%`, top: `${finding.pinY}%` }}
                  aria-label={`Finding ${finding.number}: ${finding.title}`}
                  onClick={() => choosePin(finding)}
                >
                  {finding.number}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="review-findings">
          <div className="review-toolbar" role="toolbar" aria-label="Findings">
            <div className="review-counts">
              <strong>
                {fixes.filter((f) => ticks[f.id]).length} of {fixes.length} fixes ticked
              </strong>
              {facts.length > 0 ? (
                <span>
                  {facts.filter((f) => ticks[f.id]).length} of {facts.length} facts confirmed
                </span>
              ) : null}
              <span className={error ? "hint-error" : "review-saved"} role="status" aria-live="polite">
                {error ?? status}
              </span>
            </div>
            <div className="review-filters">
              <label>
                <span className="visually-hidden">Group</span>
                <select className="input" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value as ReportGrade | "all")}>
                  <option value="all">All groups</option>
                  {GROUPS.map((g) => (
                    <option key={g.grade} value={g.grade}>
                      {g.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="visually-hidden">Category</span>
                <select className="input" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
                  <option value="all">All categories</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {categoryLabels[c] ?? c}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="visually-hidden">Ticked</span>
                <select className="input" value={tickFilter} onChange={(e) => setTickFilter(e.target.value as "all" | "ticked" | "unticked")}>
                  <option value="all">Ticked or not</option>
                  <option value="ticked">Ticked</option>
                  <option value="unticked">Not ticked</option>
                </select>
              </label>
            </div>
          </div>

          {GROUPS.map((group) => {
            const all = props.findings.filter((f) => f.grade === group.grade);
            const items = all.filter(shown);
            if (all.length === 0 || items.length === 0) return null;
            const tickable = group.tickLabel !== null && group.grade !== "recommendation";
            return (
              <section key={group.grade} className="card finding-group" aria-label={group.title}>
                <div className="finding-group-head">
                  <div>
                    <h3 className="finding-group-title">
                      {group.title} <span className="finding-group-count">{all.length}</span>
                    </h3>
                    <p className="hint">{group.line}</p>
                  </div>
                  {tickable && props.canTick ? (
                    <div className="finding-group-actions">
                      <Button small variant="text" onClick={() => tickGroup(group.grade as "must_fix", true)}>
                        Tick all
                      </Button>
                      <Button small variant="text" onClick={() => tickGroup(group.grade as "must_fix", false)}>
                        Untick all
                      </Button>
                    </div>
                  ) : null}
                </div>
                <ol className="findings">
                  {items.map((finding) => (
                    <li
                      key={finding.id}
                      id={`finding-${finding.number}`}
                      className={selected === finding.number ? "finding is-selected" : "finding"}
                      onClick={() => chooseFinding(finding)}
                    >
                      <div className="finding-head">
                        <span className={`finding-number ${pinClass(finding.grade)}`}>{finding.number}</span>
                        <p className="finding-title">{finding.title}</p>
                        {finding.grade === "must_fix" && finding.category === "house_rules" ? (
                          <Badge kind="warning">Confirm with the client</Badge>
                        ) : null}
                        <Badge kind="info">{categoryLabels[finding.category] ?? finding.category}</Badge>
                      </div>
                      <p className="finding-text">
                        <strong>{finding.grade === "confirm_fact" ? "In the design." : "Problem."}</strong> {finding.problem}
                      </p>
                      <p className="finding-text">
                        <strong>{finding.grade === "confirm_fact" ? "To do." : "Change."}</strong> {finding.change}
                      </p>
                      <p className="hint">
                        <strong>Why.</strong> {finding.why}
                      </p>
                      <p className="hint">{finding.layerName ? `On the layer "${finding.layerName}".` : "About the whole page."}</p>
                      {group.tickLabel ? (
                        <label className="finding-tick" onClick={(event) => event.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={ticks[finding.id] ?? false}
                            disabled={!props.canTick}
                            onChange={(event) => tick(finding, event.target.checked)}
                          />
                          {group.tickLabel}
                        </label>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </section>
            );
          })}
          {props.findings.filter(shown).length === 0 ? <p className="hint">No findings match these filters.</p> : null}
        </div>
      </div>
    </div>
  );
}
