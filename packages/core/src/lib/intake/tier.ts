import type { Tier } from "@tawd/core/enums";
import type { IntakeData } from "./schema";
import { wantsCityPages } from "./service-area";

/*
  The tier check.

  TAWD-PROFILE section 1: Starter covers up to 10 pages. More than five
  services, or a service-area page for each city, pushes a site past that.

  This only ever warns. Changing somebody's tier means changing what the
  client is paying, which is a PM's decision and a conversation with the
  client, not something an app should do quietly.
*/

export const STARTER_MAX_SERVICES = 5;

export interface TierWarning {
  needsAtLeast: Tier;
  reasons: string[];
}

export function checkTier(tier: Tier, intake: IntakeData): TierWarning | null {
  if (tier !== "starter") return null;

  const reasons: string[] = [];

  const serviceCount = intake.services.items.length;
  if (serviceCount > STARTER_MAX_SERVICES) {
    reasons.push(
      `${serviceCount} services, and Starter covers up to ${STARTER_MAX_SERVICES}`,
    );
  }

  // Only a list of cities can have a page each: states, nationwide and a radius never count.
  if (wantsCityPages(intake.serviceAreas)) {
    const counties = intake.serviceAreas.scope === "counties";
    const count = counties ? intake.serviceAreas.counties.length : intake.serviceAreas.cities.length;
    const what = counties ? "counties" : "cities";
    reasons.push(
      count > 0
        ? `a separate page for each of ${count} ${what} was asked for`
        : `a separate page for each ${counties ? "county" : "city"} was asked for`,
    );
  }

  if (reasons.length === 0) return null;

  return { needsAtLeast: "growth", reasons };
}

export function describeTierWarning(warning: TierWarning): string {
  return `This project is on Starter but looks like at least Growth: ${warning.reasons.join(
    ", and ",
  )}. A PM should decide whether to change the tier - TAWD will not change it.`;
}
