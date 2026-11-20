import type { ProjectStatus } from "@tawd/core/enums";
import type { CompletenessResult, Requirement } from "./completeness";

/*
  The step from Intake to the rest of the build.

  Missing required answers are a warning, not a wall (Jason, 25 September
  2026): whoever can change the stage may continue without them, and each
  missing item appears on the concepts as a highlighted placeholder. The
  choice is explicit - a caller must say it is continuing without them -
  and it is logged with exactly what was missing.

  Pausing is always allowed.
*/

/** Kept for older callers; a note is optional now. */
export const MIN_OVERRIDE_REASON_LENGTH = 0;

/** Statuses that count as "past Intake". */
const PAST_INTAKE: ProjectStatus[] = [
  "mockups",
  "content",
  "build",
  "qa",
  "live",
];

export type GateDecision =
  | { allowed: true; overrideUsed: false }
  | { allowed: true; overrideUsed: true; reason: string; missing: Requirement[] }
  | { allowed: false; reason: "incomplete" | "blocked"; missing: Requirement[] };

/* The missing items nothing can skip (the current website, 30 September 2026). */
export function blockingMissing(completeness: CompletenessResult): Requirement[] {
  return completeness.missing.filter((m) => m.blocking);
}

/*
  Why Generate waits, naming the answers that block it (0.100.0, Fable's
  review H1): the current website and, with one, the project type. Null
  when nothing blocks.
*/
export function blockingLine(completeness: CompletenessResult): { line: string; section: string } | null {
  const missing = blockingMissing(completeness);
  if (!missing.length) return null;
  const names = missing.map((m) => m.label);
  return {
    line: `Finish the intake first: ${names.join(" and ")}. ${missing.some((m) => m.key === "content.projectType") ? "The project type decides the steps and where the mockup's words come from." : "It decides where the mockup's words come from."} No concepts are generated until then.`,
    section: missing[0]!.section,
  };
}

export interface GateInput {
  from: ProjectStatus;
  to: ProjectStatus;
  completeness: CompletenessResult;
  /** The person chose "Continue without these". */
  continueWithoutMissing?: boolean;
  /** An optional note, kept with the log entry. */
  note?: string | null;
}

export function isLeavingIntake(from: ProjectStatus, to: ProjectStatus): boolean {
  return from === "intake" && PAST_INTAKE.includes(to);
}

export function evaluateGate(input: GateInput): GateDecision {
  if (!isLeavingIntake(input.from, input.to)) {
    return { allowed: true, overrideUsed: false };
  }

  if (input.completeness.isComplete) {
    return { allowed: true, overrideUsed: false };
  }

  // Never skipped, not even with "Continue without these".
  const blocking = blockingMissing(input.completeness);
  if (blocking.length) return { allowed: false, reason: "blocked", missing: blocking };

  if (!input.continueWithoutMissing) {
    return {
      allowed: false,
      reason: "incomplete",
      missing: input.completeness.missing,
    };
  }

  return {
    allowed: true,
    overrideUsed: true,
    reason: (input.note ?? "").trim() || "Continued without these",
    // Recorded so the log shows what was actually skipped.
    missing: input.completeness.missing,
  };
}

export function describeGateRefusal(decision: GateDecision): string {
  if (decision.allowed) return "";
  if (decision.reason === "blocked") return "Add the current website, or tick No current website: it decides where the mockup's words come from.";
  return `These required items are still missing: ${decision.missing
    .map((m) => m.label)
    .join(", ")}. Choose "Continue without these" to move on anyway.`;
}
