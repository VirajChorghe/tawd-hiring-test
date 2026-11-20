"use client";

import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import type { StepKey, StepNeed, StepState } from "@/lib/content-steps";

/*
  Content as one step (Jason, 7 October 2026; flow redesign Part C,
  0.100.0): TAWD's steps in order, one row each with where it stands, one
  open at a time (the next step to do by default, or the one a link points
  at). A step the project doesn't need stays in the list, greyed, with
  why. The extras (SEO suggestions, the full audit) sit under "More".
*/

export interface StepRow {
  key: StepKey;
  title: string;
  need: StepNeed;
  state: StepState;
  stateLabel: string;
  /** One line under the title: what's there, or what happens next. */
  line: string | null;
  why: string | null;
  more: boolean;
  /** The anchors inside this step's body, so a link to one of them opens it. */
  anchors: string[];
  /** Said on the step's own line, open or closed: the reason not to go on. */
  warn?: string | null;
}

const BADGE: Record<StepState, "done" | "warning" | "info" | "missing"> = {
  done: "done",
  working: "info",
  todo: "warning",
  problem: "missing",
  waiting: "info",
};

export function ContentSteps(props: { steps: StepRow[]; open: StepKey | null; bodies: Partial<Record<StepKey, React.ReactNode>> }) {
  const [open, setOpen] = useState<StepKey | null>(props.open);
  const [moreOpen, setMoreOpen] = useState(false);

  // A link to #drafts, #plan and the like opens the step that holds it: once on load and when the link changes, never on a refresh (Fable's review M2).
  const steps = useRef(props.steps);
  useEffect(() => {
    steps.current = props.steps;
  }, [props.steps]);
  useEffect(() => {
    const follow = () => {
      const hash = window.location.hash.replace(/^#/, "");
      // A page's row in the drafts table (#page-<id>, Back to Content from a page, 8 October 2026) sits in the words step.
      const row = steps.current.find((s) => s.key === hash || s.anchors.includes(hash) || (hash.startsWith("page-") && s.anchors.includes("drafts")));
      if (!row) return;
      setOpen(row.key);
      if (row.more) setMoreOpen(true);
      window.setTimeout(() => document.getElementById(hash)?.scrollIntoView({ block: hash.startsWith("page-") ? "center" : "start" }), 0);
    };
    // A link to the hash the address already ends in fires no hashchange (the bar's "Open the copy pack" looked broken): follow it on the click too.
    const click = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.("a[href*='#']") as HTMLAnchorElement | null;
      if (!link || link.pathname !== window.location.pathname || link.hash !== window.location.hash) return;
      window.setTimeout(follow, 0);
    };
    follow();
    window.addEventListener("hashchange", follow);
    document.addEventListener("click", click);
    return () => {
      window.removeEventListener("hashchange", follow);
      document.removeEventListener("click", click);
    };
  }, []);

  const row = (step: StepRow, index: number) => {
    const needed = step.need !== "no";
    const isOpen = needed && open === step.key;
    const body = props.bodies[step.key];
    return (
      <li key={step.key} className={["content-step", needed ? null : "is-not-needed", isOpen ? "is-open" : null].filter(Boolean).join(" ")} id={`step-${step.key}`}>
        <button
          type="button"
          className="content-step-head"
          aria-expanded={needed && body ? isOpen : undefined}
          aria-controls={needed && body ? `step-body-${step.key}` : undefined}
          disabled={!needed || !body}
          onClick={() => setOpen(isOpen ? null : step.key)}
        >
          <span className={`content-step-number is-${needed ? step.state : "not-needed"}`} aria-hidden="true">
            {needed && step.state === "done" ? "✓" : index + 1}
          </span>
          <span className="content-step-text">
            <span className="content-step-title">
              {step.title}
              {needed ? <Badge kind={BADGE[step.state]}>{step.stateLabel}</Badge> : <span className="content-step-off">Not needed for this project</span>}
              {step.need === "optional" ? <span className="content-step-optional">Optional</span> : null}
            </span>
            {needed && step.line ? <span className="hint">{step.line}</span> : null}
            {needed && step.warn ? <span className="hint content-warn">{step.warn}</span> : null}
            {step.why && (!needed || step.need === "optional") ? <span className="hint">{step.why}</span> : null}
          </span>
          {needed && body ? (
            <span className="content-step-chevron" aria-hidden="true">
              {isOpen ? "−" : "+"}
            </span>
          ) : null}
        </button>
        {needed && body ? (
          // Every step's body is on the page (links into it, and reading it without the script); only the open one shows.
          <div className="content-step-body" id={`step-body-${step.key}`} hidden={!isOpen}>
            {body}
          </div>
        ) : null}
      </li>
    );
  };

  const main = props.steps.filter((s) => !s.more);
  const more = props.steps.filter((s) => s.more);
  return (
    <div className="card content-steps-card">
      <ol className="content-steps">{main.map((s, i) => row(s, i))}</ol>
      {more.length ? (
        <div className="content-steps-more">
          <button type="button" className="btn btn-text btn-small" aria-expanded={moreOpen} onClick={() => setMoreOpen((m) => !m)}>
            {moreOpen ? "Less" : `More: ${more.map((s) => s.title.replace(/ for the current site$/, "")).join(", ")}`}
          </button>
          <ol className="content-steps" hidden={!moreOpen}>
            {more.map((s, i) => row(s, main.length + i))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
