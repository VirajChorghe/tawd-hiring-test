import { and, desc, eq } from "drizzle-orm";

import type { Database } from "../../db";
import { clientDecision, clientDesignDoc, concept, conceptVersion, project } from "../../db/schema";
import { isHealthProject } from "../content/health";
import { loadIntake } from "../intake/service";
import type { FileStorage } from "../intake/storage";
import { SYSTEM_ACTOR } from "../permissions";
import { buildDesignMd } from "../site/design-md";
import { DESIGNER_CONCEPT, directionInfo } from "./directions";

/*
  The approved mockup, server side (27 September 2026), shared by the web
  app and the worker.

  The client approved one version of one concept. When the logo changes
  after that, "Put the new logo into the approved concept" makes a new
  version with only the logo swapped (stage "logo_swap", no AI), and that
  version is the approved one from then on: the site, the client DESIGN.md
  and the concept board all use it.
*/

type Db = Database;

export async function approvedMockupVersion(db: Db, projectId: string) {
  const [decision] = await db
    .select()
    .from(clientDecision)
    .where(and(eq(clientDecision.projectId, projectId), eq(clientDecision.changesRequested, false)))
    .orderBy(desc(clientDecision.createdAt))
    .limit(1);
  if (!decision) return null;
  const [picked] = await db.select().from(concept).where(eq(concept.id, decision.conceptId)).limit(1);
  if (!picked) return null;
  const versions = await db.select().from(conceptVersion).where(eq(conceptVersion.conceptId, picked.id)).orderBy(desc(conceptVersion.version));
  const swapped = versions.find((v) => v.version > decision.version && (v.checks as { stage?: string } | null)?.stage === "logo_swap");
  const version = swapped ?? versions.find((v) => v.version === decision.version) ?? null;
  if (!version) return null;
  return { decision, concept: picked, version, logoSwapped: Boolean(swapped) };
}

/* The page's source (image tokens, not inlined images) for a stored version. */
export function sourceKeyOf(htmlKey: string): string {
  return htmlKey.replace(/page\.html$/, "source.html");
}

export class DesignDocError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignDocError";
  }
}

/*
  Writes the next version of the client's DESIGN.md from the approved
  mockup (Lane 2: the designer's approved design). No AI. Returns what it
  was written from, for the activity log.
*/
export async function writeClientDesignDoc(db: Db, storage: FileStorage, projectId: string, byUserId: string | null): Promise<{ version: number; from: string }> {
  const [row] = await db.select().from(project).where(eq(project.id, projectId)).limit(1);
  if (!row) throw new DesignDocError("That project no longer exists.");
  const approved = await approvedMockupVersion(db, projectId);
  if (!approved) throw new DesignDocError("The client hasn't approved a mockup yet: the DESIGN.md is written from the approved one.");
  if (!approved.version.htmlKey) throw new DesignDocError("The approved mockup's page is missing.");
  const html = (await storage.get(sourceKeyOf(approved.version.htmlKey))) ?? (await storage.get(approved.version.htmlKey));
  if (!html) throw new DesignDocError("The approved mockup's page is missing from storage.");

  const intake = await loadIntake(db, SYSTEM_ACTOR, projectId);
  const figma = row.lane === "lane_2" && approved.concept.direction === DESIGNER_CONCEPT;
  const v = approved.version.version;
  const from = figma ? `the designer's design, v${v}` : `Concept ${approved.concept.label} v${v}`;
  const markdown = buildDesignMd({
    clientName: row.clientName,
    tradeLabel: row.trade.replace(/_/g, " "),
    html: html.toString("utf8"),
    direction: directionInfo(approved.concept.direction),
    source: figma ? "figma" : "concept",
    approvedLabel: approved.logoSwapped ? `${from}, with the new logo` : from,
    moodWords: intake?.data.brand.moodWords ?? [],
    brandLocked: Boolean(intake && (intake.data.brand.colors.length > 0 || intake.data.brand.headingFont || intake.data.brand.bodyFont || intake.data.brand.fonts)),
    healthRules: intake ? isHealthProject(row.trade, intake.data) : false,
  });

  const [latest] = await db.select({ version: clientDesignDoc.version }).from(clientDesignDoc).where(eq(clientDesignDoc.projectId, projectId)).orderBy(desc(clientDesignDoc.version)).limit(1);
  const next = (latest?.version ?? 0) + 1;
  await db.insert(clientDesignDoc).values({
    projectId,
    version: next,
    source: figma ? "figma" : "concept",
    conceptId: approved.concept.id,
    conceptVersion: v,
    markdown,
    createdByUserId: byUserId,
  });
  return { version: next, from };
}
