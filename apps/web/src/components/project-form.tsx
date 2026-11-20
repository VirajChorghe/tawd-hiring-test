"use client";

import { useActionState, useState } from "react";

import { FieldError, FormError, SubmitButton } from "@/components/form";
import { initialsOf } from "@/components/project/team-line";
import { useProgressDoneOn } from "@/components/ui/top-progress";
import { tiers, trades } from "@tawd/core/enums";
import type { Lane, LaneOption, TeamRole, Tier } from "@tawd/core/enums";
import { roleLabels, tradeLabels } from "@/lib/labels";
import { emptyActionState, type ActionState } from "@/lib/action-state";

/*
  New project and Edit project.

  No stage field: a new project always starts at Intake, and a project only
  moves on through the stage flow and its gates (the intake gate, with the
  admin override on the intake screen). Editing changes the details, never
  the stage.

  The concept rules come from skills/TAWD-PROFILE.md section 9 and are
  enforced on the server in validation.ts. Here they only decide what is
  shown and what is pre-selected: Lane 1 defaults to three concepts, Lane 2
  Option B to one, and Lane 2 Option A has none because the approved design
  is built directly.
*/

export interface ProjectFormValues {
  clientName: string;
  trade: string;
  tier: Tier;
  lane: Lane;
  laneOption: LaneOption | null;
  conceptCount: number | null;
  memberUserIds: string[];
}

export interface AssignableUser {
  id: string;
  name: string;
  email: string;
  roles: TeamRole[];
}

const TIER_CARDS: Record<Tier, { title: string; line: string }> = {
  starter: { title: "Starter", line: "Up to 10 pages" },
  growth: { title: "Growth", line: "11 to 20 pages" },
  pro: { title: "Pro", line: "21 to 50 pages" },
};

function defaultConcepts(lane: Lane, option: LaneOption | null): number | null {
  if (lane === "lane_1") return 3;
  if (option === "b") return 1;
  return null;
}

export function ProjectForm({
  action,
  initial,
  assignable,
  submitLabel,
  cancelHref,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  initial?: ProjectFormValues;
  assignable: AssignableUser[];
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, formAction] = useActionState(action, emptyActionState);
  useProgressDoneOn(state);

  const [tier, setTier] = useState<Tier>(initial?.tier ?? "starter");
  const [lane, setLane] = useState<Lane>(initial?.lane ?? "lane_1");
  const [option, setOption] = useState<LaneOption | null>(initial?.laneOption ?? null);
  const [concepts, setConcepts] = useState<number | null>(
    initial ? initial.conceptCount : 3,
  );
  const [members, setMembers] = useState<string[]>(initial?.memberUserIds ?? []);

  const chooseLane = (next: Lane) => {
    setLane(next);
    const nextOption = next === "lane_1" ? null : option;
    setOption(nextOption);
    setConcepts(defaultConcepts(next, nextOption));
  };

  const chooseOption = (next: LaneOption) => {
    setOption(next);
    setConcepts(defaultConcepts("lane_2", next));
  };

  const showConcepts = lane === "lane_1" || option === "b";

  return (
    <form action={formAction} className="card project-form" data-progress>
      <FormError state={state} />

      {/* The values the server reads, whatever the cards look like. */}
      <input type="hidden" name="tier" value={tier} />
      <input type="hidden" name="lane" value={lane} />
      <input type="hidden" name="laneOption" value={option ?? ""} />
      <input type="hidden" name="conceptCount" value={showConcepts && concepts ? String(concepts) : ""} />

      <div className="field-grid">
        <div className="field">
          <label className="field-label" htmlFor="clientName">
            <span>Business name</span>
            <span className="field-required">Required</span>
          </label>
          <input
            id="clientName"
            name="clientName"
            type="text"
            className="input"
            placeholder="As the client trades, e.g. Pat Rivera Pump & Well"
            defaultValue={initial?.clientName ?? ""}
            autoFocus={!initial}
            required
          />
          <FieldError state={state} name="clientName" />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="trade">
            <span>Trade</span>
            <span className="field-required">Required</span>
          </label>
          <select id="trade" name="trade" className="select" defaultValue={initial?.trade ?? "plumbing"}>
            {trades.map((value) => (
              <option key={value} value={value}>
                {tradeLabels[value]}
              </option>
            ))}
          </select>
          <p className="hint">Decides which design directions TAWD suggests.</p>
          <FieldError state={state} name="trade" />
        </div>
      </div>

      <fieldset className="choice-group">
        <legend className="field-label">
          <span>Tier</span>
        </legend>
        <div className="pick-cards pick-cards-3">
          {tiers.map((value) => (
            <PickCard
              key={value}
              name="tier-choice"
              checked={tier === value}
              onChange={() => setTier(value)}
              title={TIER_CARDS[value].title}
              line={TIER_CARDS[value].line}
            />
          ))}
        </div>
        <FieldError state={state} name="tier" />
      </fieldset>

      <fieldset className="choice-group">
        <legend className="field-label">
          <span>Lane</span>
        </legend>
        <div className="pick-cards pick-cards-2">
          <PickCard
            name="lane-choice"
            checked={lane === "lane_1"}
            onChange={() => chooseLane("lane_1")}
            title="Lane 1: no design supplied"
            line="TAWD designs the site: 1 to 3 concepts for the client to choose from."
          />
          <PickCard
            name="lane-choice"
            checked={lane === "lane_2"}
            onChange={() => chooseLane("lane_2")}
            title="Lane 2: design supplied"
            line="The client already has a design, for example from Figma."
          />
        </div>
        <FieldError state={state} name="lane" />

        {lane === "lane_2" ? (
          <div className="choice-sub">
            <p className="field-label">
              <span>What to do with the design</span>
            </p>
            <div className="pick-cards pick-cards-2">
              <PickCard
                name="option-choice"
                checked={option === "a"}
                onChange={() => chooseOption("a")}
                title="Option A: Client approved, build it"
                line="Built as supplied. No concepts."
              />
              <PickCard
                name="option-choice"
                checked={option === "b"}
                onChange={() => chooseOption("b")}
                title="Option B: Review and improve"
                line="Treated as a reference; TAWD reviews and improves it."
              />
            </div>
            <FieldError state={state} name="laneOption" />
          </div>
        ) : null}
      </fieldset>

      {showConcepts ? (
        <fieldset className="choice-group">
          <legend className="field-label">
            <span>Concepts</span>
          </legend>
          <div className="segmented" role="radiogroup" aria-label="How many concepts">
            {[1, 2, 3].map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                className="segment"
                aria-checked={concepts === n}
                onClick={() => setConcepts(n)}
              >
                {n}
              </button>
            ))}
          </div>
          <p className="hint">
            {lane === "lane_1"
              ? "Lane 1 is normally three: one per design direction."
              : "Option B is normally one."}
          </p>
          <FieldError state={state} name="conceptCount" />
        </fieldset>
      ) : null}

      <fieldset className="choice-group">
        <legend className="field-label">
          <span>Team</span>
          <span className="field-optional">Optional</span>
        </legend>
        {assignable.length === 0 ? (
          <p className="hint">Nobody to assign yet. An admin adds people on the Team page.</p>
        ) : (
          <div className="people-picker">
            {assignable.map((person) => {
              const on = members.includes(person.id);
              return (
                <label key={person.id} className={on ? "person-option is-on" : "person-option"}>
                  <input
                    type="checkbox"
                    name="memberUserIds"
                    value={person.id}
                    checked={on}
                    onChange={() =>
                      setMembers((current) =>
                        on ? current.filter((id) => id !== person.id) : [...current, person.id],
                      )
                    }
                  />
                  <span className="avatar avatar-row" aria-hidden="true">
                    {initialsOf(person.name)}
                  </span>
                  <span className="person-option-name">{person.name}</span>
                  <span className="person-option-roles">
                    {person.roles.length === 0 ? (
                      <span className="hint">No roles yet</span>
                    ) : (
                      person.roles.map((role) => (
                        <span key={role} className="role-chip">
                          {roleLabels[role]}
                        </span>
                      ))
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </fieldset>

      <div className="form-actions">
        <a href={cancelHref} className="btn btn-secondary">
          Cancel
        </a>
        <SubmitButton>{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

/*
  One selectable card: a real radio input, visually hidden, so the keyboard
  and screen readers treat the group as the radio group it is.
*/
function PickCard({
  name,
  checked,
  onChange,
  title,
  line,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  title: string;
  line: string;
}) {
  return (
    <label className={checked ? "pick-card is-on" : "pick-card"}>
      <input type="radio" name={name} className="visually-hidden" checked={checked} onChange={onChange} />
      <span className="pick-card-title">{title}</span>
      <span className="pick-card-line">{line}</span>
    </label>
  );
}
