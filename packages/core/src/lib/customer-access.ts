import { and, desc, eq, isNull } from "drizzle-orm";

import type { Database } from "../db";
import { customer, project } from "../db/schema";

/*
  The one door for every customer read of a project (Part 2, task 1, 3 November 2026).

  WORKING-WITH-JASON.md: "Keep customers apart. A can never see, change or
  download B's project, files or bill. Every page and file link checks
  ownership." Every customer-app page, action and file link loads its project
  through customerProject() or customerProjects(), never by querying the
  project table itself.

  - Ownership, flow and an open account are checked in the same query: there is
    no moment where a project was loaded and its owner not yet checked.
  - Someone else's project, a made-up ID and garbage all answer null, the same
    way, so a customer can't learn which project IDs exist. Nothing here throws
    on bad input (a malformed ID would otherwise surface as a database error).
  - Only the fields a customer may see come back. The team's internal fields
    (prices, AI caps, test flags, who created it) never leave this file.
*/

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const customerFields = {
  id: project.id,
  clientName: project.clientName,
  trade: project.trade,
  tier: project.tier,
  status: project.status,
  createdAt: project.createdAt,
};

export interface CustomerProject {
  id: string;
  clientName: string;
  trade: string;
  tier: string;
  status: string;
  createdAt: Date;
}

function ownedBy(customerId: string) {
  return and(
    eq(project.flow, "self_serve"),
    eq(project.customerId, customerId),
    eq(customer.id, customerId),
    isNull(customer.closedAt),
  );
}

/** The customer's project, or null if it isn't theirs, doesn't exist, or the account is closed. */
export async function customerProject(db: Database, customerId: string, projectId: string): Promise<CustomerProject | null> {
  if (!customerId || !UUID.test(projectId)) return null;
  const [row] = await db
    .select(customerFields)
    .from(project)
    .innerJoin(customer, eq(customer.id, project.customerId))
    .where(and(eq(project.id, projectId), ownedBy(customerId)))
    .limit(1);
  return row ?? null;
}

/** Every project the customer owns, newest first; empty for a closed or unknown account. */
export async function customerProjects(db: Database, customerId: string): Promise<CustomerProject[]> {
  if (!customerId) return [];
  return db
    .select(customerFields)
    .from(project)
    .innerJoin(customer, eq(customer.id, project.customerId))
    .where(ownedBy(customerId))
    .orderBy(desc(project.createdAt));
}
