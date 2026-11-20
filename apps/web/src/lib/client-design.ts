import { and, desc, eq } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { clientDecision, clientDesignDoc } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { getStorage } from "@tawd/core/intake/storage";
import { DesignDocError, writeClientDesignDoc } from "@tawd/core/approved";
import { assertCan, SYSTEM_ACTOR, type Viewer } from "@tawd/core/permissions";
import type { ServiceContext } from "@/lib/users";

/*
  The client's DESIGN.md (26 September 2026): written from the approved
  mockup the moment the client approves it (Lane 2: the designer's approved
  Figma design), kept in versions, shown on the project page, and given to
  every page build and monthly edit. No AI: it is read from the design.
*/

type Db = Database;

export class ClientDesignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientDesignError";
  }
}

export async function makeClientDesignDoc(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<{ version: number }> {
  assertCan(actor, "project.edit");
  let written: { version: number; from: string };
  try {
    written = await writeClientDesignDoc(ctx.db, getStorage(), projectId, actor.id === SYSTEM_ACTOR.id ? null : actor.id);
  } catch (error) {
    if (error instanceof DesignDocError) throw new ClientDesignError(error.message);
    throw error;
  }
  await recordActivity(ctx.db, {
    action: "design_md.created",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: written,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return { version: written.version };
}

export interface ClientDesignView {
  version: number;
  source: "concept" | "figma";
  conceptVersion: number | null;
  markdown: string;
  createdAt: Date;
}

/** The newest DESIGN.md for a project, or null. */
export async function loadClientDesignDoc(db: Db, projectId: string): Promise<ClientDesignView | null> {
  const [row] = await db.select().from(clientDesignDoc).where(eq(clientDesignDoc.projectId, projectId)).orderBy(desc(clientDesignDoc.version)).limit(1);
  return row ? { version: row.version, source: row.source as "concept" | "figma", conceptVersion: row.conceptVersion, markdown: row.markdown, createdAt: row.createdAt } : null;
}

/** Whether the client has approved a mockup, so a DESIGN.md can be written. */
export async function hasApprovedMockup(db: Db, projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: clientDecision.id })
    .from(clientDecision)
    .where(and(eq(clientDecision.projectId, projectId), eq(clientDecision.changesRequested, false)))
    .limit(1);
  return Boolean(row);
}
