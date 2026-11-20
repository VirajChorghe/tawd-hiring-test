import type { CompletenessResult } from "./completeness";
import { intakeSectionKeys, sectionLabels, type IntakeSectionKey } from "./schema";
import type { TierWarning } from "./tier";
import type { FitWarning } from "./fit";

/*
  What the left-hand section list says beside each section.

  Kept as a pure function so the rule is one readable thing and can be tested
  without rendering anything. The order of precedence is deliberate:

  1. Missing required answers, because that is what blocks the project.
  2. A tier problem, which needs a decision but does not block.
  3. A useful count, where the section holds a list worth seeing at a glance.
  4. Optional, meaning nothing here is required and nothing is filled in.
  5. Done, meaning there is something here and nothing is outstanding.
*/

/** Mirrors the badge kinds in DESIGN.md. Kept here so core has no UI imports. */
export type SectionBadgeKind = "done" | "missing" | "warning" | "info";

export interface SectionStatus {
  key: IntakeSectionKey;
  label: string;
  badge: string;
  kind: SectionBadgeKind;
  /** How many required answers are outstanding in this section. */
  missingCount: number;
}

export interface SectionStatusInput {
  completeness: CompletenessResult;
  tierWarning: TierWarning | null;
  /** The "TAWD fit" check; marks Extras. */
  fitWarning?: FitWarning | null;
  /** Counts of ready files, by kind. */
  fileCounts: Record<string, number>;
  /** Whether the section has any answer at all, used to tell Done from Optional. */
  hasContent: Record<IntakeSectionKey, boolean>;
}

const SECTIONS_WITH_TIER_IMPACT: IntakeSectionKey[] = [
  "services",
  "serviceAreas",
];

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function buildSectionStatuses(
  input: SectionStatusInput,
): SectionStatus[] {
  const missingBySection = new Map<string, number>();
  for (const item of input.completeness.missing) {
    missingBySection.set(
      item.section,
      (missingBySection.get(item.section) ?? 0) + 1,
    );
  }

  return intakeSectionKeys.map((key) => {
    const label = sectionLabels[key];
    const missingCount = missingBySection.get(key) ?? 0;

    if (missingCount > 0) {
      return {
        key,
        label,
        badge: `${missingCount} missing`,
        kind: "missing" as const,
        missingCount,
      };
    }

    if (input.tierWarning && SECTIONS_WITH_TIER_IMPACT.includes(key)) {
      return {
        key,
        label,
        badge: "Needs Growth",
        kind: "warning" as const,
        missingCount: 0,
      };
    }

    if (input.fitWarning && key === "extras") {
      return {
        key,
        label,
        badge: "Custom build?",
        kind: "warning" as const,
        missingCount: 0,
      };
    }

    if (key === "photos") {
      const count = input.fileCounts.photo ?? 0;
      return count > 0
        ? {
            key,
            label,
            badge: plural(count, "photo"),
            kind: "info" as const,
            missingCount: 0,
          }
        : {
            key,
            label,
            badge: "Optional",
            kind: "info" as const,
            missingCount: 0,
          };
    }

    if (!input.hasContent[key]) {
      return {
        key,
        label,
        badge: "Optional",
        kind: "info" as const,
        missingCount: 0,
      };
    }

    return {
      key,
      label,
      badge: "Done",
      kind: "done" as const,
      missingCount: 0,
    };
  });
}

/**
 * Whether a section holds any answer at all.
 *
 * Used only to tell "finished" apart from "nobody has opened it", so an empty
 * optional section is not congratulated for being Done.
 */
export function hasAnyContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return true;
  if (Array.isArray(value)) return value.some(hasAnyContent);
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(hasAnyContent);
  }
  return false;
}
