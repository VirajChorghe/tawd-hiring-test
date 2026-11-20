import { and, desc, eq, inArray, like } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { modelLabel } from "@tawd/core/mockups";
import { stepModelConfig } from "@tawd/core/step-models";
import { aiCall, intakeFile, logoDesign, project } from "@tawd/core/schema";
import type { Tier } from "@tawd/core/enums";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { loadIntake } from "@tawd/core/intake/service";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import { LOGO_JOB, logoJobId } from "@tawd/core/queue";
import { LOGO_OPTIONS, costOf, formatCost } from "@tawd/core/mockups";
import { getQueue } from "@/lib/mockups";
import { addProjectAddon, removeProjectAddon } from "@/lib/pricing";
import { SpendError, assertWithinMonthlyLimit } from "@/lib/spend";
import type { ServiceContext } from "@/lib/users";

/*
  "Client has no logo: TAWD designs one" (Jason, 26 September 2026). The
  tick box adds the logo add-on to the project's price (and unticking
  takes it off). Designing is paid AI with the estimate first; the chosen
  option becomes the intake's logo, so the mockups use it and the client
  approves it with them.
*/

type Db = Database;

export class LogoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogoError";
  }
}

/** A first guess per option until real designs have run. */
export const LOGO_GUESS = { inputTokens: 1_500, outputTokens: 3_500 };
const TAWD_LOGO_NAME = "Logo by TAWD";

export async function estimateLogo(db: Db, options: number): Promise<{ cost: number; label: string }> {
  const config = await stepModelConfig(db, "logo_design");
  const calls = await db.select().from(aiCall).where(eq(aiCall.step, "logo_design"));
  const designs = calls.length ? await db.select().from(logoDesign).where(inArray(logoDesign.id, [...new Set(calls.map((c) => c.runId))])) : [];
  const optionsMade = designs.reduce((n, d) => n + d.optionCount, 0);
  const perOption = optionsMade ? calls.reduce((n, c) => n + costOf(c, config), 0) / optionsMade : costOf(LOGO_GUESS, config);
  const cost = perOption * options;
  return { cost, label: `About ${formatCost(cost)} of AI on ${modelLabel(config.model)} for ${options} option${options === 1 ? "" : "s"}${optionsMade ? ", from the logos so far" : " (a first guess until a real design has run)"}.` };
}

/* After the Brand section is saved: the add-on follows the tick box. */
export async function syncLogoAddon(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  const intake = await loadIntake(ctx.db, actor, projectId);
  if (!intake) return;
  if (intake.data.brand.tawdDesignsLogo) await addProjectAddon(ctx, actor, projectId, "logo_design");
  else await removeProjectAddon(ctx, actor, projectId, "logo_design");
}

export async function startLogoDesign(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  assertCan(actor, "intake.edit");
  const intake = await loadIntake(ctx.db, actor, projectId);
  if (!intake?.data.brand.tawdDesignsLogo) throw new LogoError('Tick "Client has no logo: TAWD designs one" and save the Brand section first.');
  const [row] = await ctx.db.select({ tier: project.tier }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!row) throw new LogoError("That project no longer exists.");
  const [running] = await ctx.db.select().from(logoDesign).where(eq(logoDesign.projectId, projectId)).orderBy(desc(logoDesign.createdAt)).limit(1);
  if (running && (running.status === "queued" || running.status === "working")) throw new LogoError("The logo is already being designed.");
  try {
    await assertWithinMonthlyLimit(ctx.db, { projectId, estimate: (await estimateLogo(ctx.db, LOGO_OPTIONS[row.tier as Tier])).cost });
  } catch (error) {
    if (error instanceof SpendError) throw new LogoError(error.message);
    throw error;
  }
  const options = LOGO_OPTIONS[row.tier as Tier];
  const estimate = await estimateLogo(ctx.db, options);
  const [design] = await ctx.db.insert(logoDesign).values({ projectId, status: "queued", optionCount: options, startedByUserId: actor.id }).returning({ id: logoDesign.id });
  try {
    await getQueue().add(LOGO_JOB, { designId: design!.id, projectId }, { jobId: logoJobId(design!.id), attempts: 1 });
  } catch {
    await ctx.db.delete(logoDesign).where(eq(logoDesign.id, design!.id));
    throw new LogoError("The logo couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, {
    action: "logo.design_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { options, estimate: estimate.label },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* The chosen option becomes the intake's logo (an SVG file); an earlier TAWD logo is replaced. */
export async function chooseLogo(ctx: ServiceContext, actor: Viewer, projectId: string, designId: string, index: number): Promise<void> {
  assertCan(actor, "intake.edit");
  const [design] = await ctx.db.select().from(logoDesign).where(and(eq(logoDesign.id, designId), eq(logoDesign.projectId, projectId))).limit(1);
  const option = (design?.options as { svgKey: string; pngKey: string; name: string }[] | undefined)?.[index];
  if (!design || design.status !== "done" || !option) throw new LogoError("That logo option isn't there.");
  const storage = getStorage();
  const svg = await storage.get(option.svgKey);
  if (!svg) throw new LogoError("That logo option's file is missing. Design it again.");

  const earlier = await ctx.db.select().from(intakeFile).where(and(eq(intakeFile.projectId, projectId), eq(intakeFile.kind, "logo"), like(intakeFile.fileName, `${TAWD_LOGO_NAME}%`)));
  for (const file of earlier) {
    await storage.remove(file.storageKey);
    await ctx.db.delete(intakeFile).where(eq(intakeFile.id, file.id));
  }
  const storageKey = `${projectStoragePrefix(projectId)}intake/logo-by-tawd-${designId}-${index + 1}.svg`;
  await storage.put(storageKey, svg, "image/svg+xml");
  await ctx.db.insert(intakeFile).values({
    projectId,
    kind: "logo",
    storageKey,
    fileName: `${TAWD_LOGO_NAME} (${option.name.toLowerCase()}).svg`,
    contentType: "image/svg+xml",
    sizeBytes: svg.length,
    status: "ready",
  });
  await ctx.db.update(logoDesign).set({ chosenIndex: index }).where(eq(logoDesign.id, designId));
  await recordActivity(ctx.db, {
    action: "logo.chosen",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { option: option.name },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

export interface LogoDesignView {
  status: "none" | "queued" | "working" | "done" | "failed";
  failureReason: string | null;
  options: { name: string; png: string | null }[];
  chosenIndex: number | null;
  designId: string | null;
  optionCount: number;
  estimateLine: string;
}

export async function loadLogoDesign(db: Db, projectId: string): Promise<LogoDesignView> {
  const [row] = await db.select({ tier: project.tier }).from(project).where(eq(project.id, projectId)).limit(1);
  const optionCount = LOGO_OPTIONS[(row?.tier ?? "starter") as Tier];
  const [design] = await db.select().from(logoDesign).where(eq(logoDesign.projectId, projectId)).orderBy(desc(logoDesign.createdAt)).limit(1);
  const storage = getStorage();
  const options = design?.status === "done"
    ? await Promise.all(
        (design.options as { pngKey: string; name: string }[]).map(async (o) => {
          const png = await storage.get(o.pngKey);
          return { name: o.name, png: png ? `data:image/png;base64,${png.toString("base64")}` : null };
        }),
      )
    : [];
  return {
    status: (design?.status ?? "none") as LogoDesignView["status"],
    failureReason: design?.failureReason ?? null,
    options,
    chosenIndex: design?.chosenIndex ?? null,
    designId: design?.id ?? null,
    optionCount,
    estimateLine: (await estimateLogo(db, optionCount)).label,
  };
}
