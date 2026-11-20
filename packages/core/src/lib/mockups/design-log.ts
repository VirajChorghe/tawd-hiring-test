import { directions, type DirectionId } from "./directions";

/*
  The design-log check, DIRECTIONS.md selection rule 3: two competitors in
  the same trade and the same city should not get the same look.

  Every built concept writes a design-log entry (trade, city, direction,
  palette family). Before and after a run, each concept is compared with
  entries from *other* projects in the same trade and city. A match on
  direction, or on palette family, is a clash worth an amber warning naming
  the project; neither is a rule the run enforces, because the PM may have a
  good reason.
*/

export interface DesignLogNeighbour {
  projectId: string;
  /** The project's client name, or null if it has since been deleted. */
  projectName: string | null;
  direction: string;
  paletteFamily: string | null;
}

export interface DesignLogResult {
  clash: boolean;
  /** "No clash nearby", or the warning in one sentence. */
  message: string;
  projects: string[];
}

export function checkDesignLog(input: {
  direction: DirectionId;
  paletteFamily: string | null;
  city: string | null;
  neighbours: DesignLogNeighbour[];
}): DesignLogResult {
  if (!input.city) {
    return {
      clash: false,
      message: "No city in the intake, so there is nothing nearby to compare with",
      projects: [],
    };
  }

  const sameDirection = new Set<string>();
  const samePalette = new Set<string>();

  for (const entry of input.neighbours) {
    const name = entry.projectName ?? "a deleted project";
    if (entry.direction === input.direction) sameDirection.add(name);
    if (
      input.paletteFamily &&
      entry.paletteFamily &&
      entry.paletteFamily === input.paletteFamily
    ) {
      samePalette.add(name);
    }
  }

  if (sameDirection.size === 0 && samePalette.size === 0) {
    return { clash: false, message: "No clash nearby", projects: [] };
  }

  const parts: string[] = [];
  if (sameDirection.size > 0) {
    parts.push(
      `${[...sameDirection].join(", ")} nearby already ${
        sameDirection.size === 1 ? "uses" : "use"
      } ${directions[input.direction].label}`,
    );
  }
  if (samePalette.size > 0) {
    parts.push(
      `${[...samePalette].join(", ")} nearby ${
        samePalette.size === 1 ? "has" : "have"
      } a ${input.paletteFamily} palette too`,
    );
  }

  return {
    clash: true,
    message: `${parts.join("; ")}.`,
    projects: [...new Set([...sameDirection, ...samePalette])],
  };
}
