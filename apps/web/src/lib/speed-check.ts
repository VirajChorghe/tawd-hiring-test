import { and, desc, eq, ne } from "drizzle-orm";
import type { Database } from "@tawd/core/db";
import { goLive, netlifySite, project, siteBuild, siteDeploy, speedCheck, wpPreview } from "@tawd/core/schema";
import { isStagingHost } from "@tawd/core/wp-preview";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { SPEED_CHECK_JOB, speedCheckJobId } from "@tawd/core/queue";
import { SPEED_MINIMUM, type GoLiveGateInput, type SpeedResult } from "@tawd/core/site";
import { getQueue } from "@/lib/mockups";

/*
  The Speed check (1 October 2026, Jason: "an in-built checker before we
  publish, with the actual scores"): Google PageSpeed on the project's
  Netlify preview and its WordPress preview, phone and computer, from the
  Build page. Free, no AI; PMs and admins; logged. A check takes about a
  minute (the worker asks Google for both at once).
*/

type Db = Database;
type Ctx = { db: Db; ipAddress: string | null; userAgent: string | null };
export type SpeedTarget = "netlify" | "wordpress";

export class SpeedCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeedCheckError";
  }
}

/* A check that hasn't finished in this long is shown as lost (the worker restarted). */
const LOST_AFTER_MS = 10 * 60_000;

export interface SpeedCheckView {
  target: SpeedTarget;
  /** The preview's address, or null while there's none. */
  url: string | null;
  last: {
    status: "queued" | "done" | "failed";
    at: Date;
    mobile: SpeedResult | null;
    desktop: SpeedResult | null;
    error: string | null;
    url: string;
    /** The build version the preview was serving, when known. */
    version: number | null;
  } | null;
}

/*
  The build version a preview is serving (Fable's B1, 3 October 2026): the
  WordPress preview's deployed version; on Netlify, the latest ready live
  deploy once the site is live, else the latest ready preview.
*/
async function previewVersion(db: Db, projectId: string, target: SpeedTarget): Promise<number | null> {
  if (target === "wordpress") {
    const [wp] = await db.select({ version: wpPreview.deployedVersion }).from(wpPreview).where(eq(wpPreview.projectId, projectId)).limit(1);
    return wp?.version ?? null;
  }
  const ready = (kind: "preview" | "other") =>
    db
      .select({ version: siteDeploy.version })
      .from(siteDeploy)
      .where(
        and(
          eq(siteDeploy.projectId, projectId),
          eq(siteDeploy.state, "ready"),
          kind === "preview" ? eq(siteDeploy.kind, "preview") : ne(siteDeploy.kind, "preview"),
        ),
      )
      .orderBy(desc(siteDeploy.readyAt))
      .limit(1);
  const [live] = await ready("other");
  if (live) return live.version;
  const [preview] = await ready("preview");
  return preview?.version ?? null;
}

/*
  Each preview's address: the Netlify site once it's live, else the latest
  preview's own address (previews are drafts, 13 October 2026, so the plain
  site address shows nothing before go-live); the WordPress preview once
  it's deployed.
*/
async function previewUrls(db: Db, projectId: string): Promise<Record<SpeedTarget, string | null>> {
  const [site] = await db.select({ url: netlifySite.url }).from(netlifySite).where(eq(netlifySite.projectId, projectId)).limit(1);
  const ready = (kind: "preview" | "other") =>
    db
      .select({ url: siteDeploy.url })
      .from(siteDeploy)
      .where(and(eq(siteDeploy.projectId, projectId), eq(siteDeploy.state, "ready"), kind === "preview" ? eq(siteDeploy.kind, "preview") : ne(siteDeploy.kind, "preview")))
      .orderBy(desc(siteDeploy.readyAt))
      .limit(1);
  const [live] = await ready("other");
  const [preview] = live ? [] : await ready("preview");
  const netlify = { url: live ? site?.url : (preview?.url ?? null) };
  const [wp] = await db.select({ host: wpPreview.host, state: wpPreview.state }).from(wpPreview).where(eq(wpPreview.projectId, projectId)).limit(1);
  const https = (u: string) => (/^https?:\/\//.test(u) ? u : `https://${u}`);
  return {
    netlify: netlify?.url ? `${https(netlify.url).replace(/\/+$/, "")}/` : null,
    wordpress: wp?.state === "ready" && wp.host ? `https://${wp.host}/` : null,
  };
}

export async function loadSpeedChecks(db: Db, projectId: string): Promise<SpeedCheckView[]> {
  const urls = await previewUrls(db, projectId);
  const rows = await db.select().from(speedCheck).where(eq(speedCheck.projectId, projectId)).orderBy(desc(speedCheck.createdAt)).limit(20);
  return (["netlify", "wordpress"] as const)
    .filter((target) => urls[target] || rows.some((r) => r.target === target))
    .map((target) => {
      const row = rows.find((r) => r.target === target);
      const lost = row?.status === "queued" && row.createdAt.getTime() < Date.now() - LOST_AFTER_MS;
      const results = (row?.results ?? null) as { mobile?: SpeedResult; desktop?: SpeedResult } | null;
      return {
        target,
        url: urls[target],
        last: row
          ? {
              status: lost ? "failed" : (row.status as "queued" | "done" | "failed"),
              at: row.finishedAt ?? row.createdAt,
              mobile: results?.mobile ?? null,
              desktop: results?.desktop ?? null,
              error: lost ? "The check didn't finish (the worker may have restarted): check again." : row.error,
              url: row.url,
              version: row.buildVersion,
            }
          : null,
      };
    });
}

export async function startSpeedCheck(ctx: Ctx, actor: Viewer, projectId: string, target: SpeedTarget): Promise<void> {
  assertCan(actor, "project.edit");
  if (target !== "netlify" && target !== "wordpress") throw new SpeedCheckError("Choose the Netlify or the WordPress preview.");
  const url = (await previewUrls(ctx.db, projectId))[target];
  if (!url) throw new SpeedCheckError(target === "netlify" ? "Deploy the Netlify preview first." : "Deploy the WordPress preview first.");
  // 20i's staging addresses run on reduced-capacity servers (20i's docs): a score there would mislead the gate (plan, decision D1).
  if (target === "wordpress" && isStagingHost(new URL(url).hostname))
    throw new SpeedCheckError("This WordPress preview is on 20i's staging address, which runs on slower servers, so a speed check there means nothing. With a VML preview domain (WP_PREVIEW_DOMAIN) previews run on the real servers; until then a founder or an admin lets the build go live (Let it go live).");
  const [running] = await ctx.db
    .select({ id: speedCheck.id, createdAt: speedCheck.createdAt })
    .from(speedCheck)
    .where(and(eq(speedCheck.projectId, projectId), eq(speedCheck.target, target), eq(speedCheck.status, "queued")))
    .limit(1);
  if (running && running.createdAt.getTime() > Date.now() - LOST_AFTER_MS) throw new SpeedCheckError("A speed check is already running: it takes about a minute.");
  const buildVersion = await previewVersion(ctx.db, projectId, target);
  const [row] = await ctx.db
    .insert(speedCheck)
    .values({ projectId, target, url, status: "queued", buildVersion, requestedByUserId: actor.id })
    .returning({ id: speedCheck.id });
  try {
    await getQueue().add(SPEED_CHECK_JOB, { checkId: row!.id }, { jobId: speedCheckJobId(row!.id), attempts: 1 });
  } catch {
    await ctx.db.update(speedCheck).set({ status: "failed", error: "The job queue didn't answer.", finishedAt: new Date() }).where(eq(speedCheck.id, row!.id));
    throw new SpeedCheckError("The job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, { action: "site.speed_checked", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { target, url, buildVersion }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

/* The latest finished build: its version and when it finished. */
async function latestBuild(db: Db, projectId: string): Promise<{ version: number; finishedAt: Date | null } | null> {
  const [b] = await db
    .select({ version: siteBuild.version, finishedAt: siteBuild.finishedAt })
    .from(siteBuild)
    .where(and(eq(siteBuild.projectId, projectId), eq(siteBuild.status, "done")))
    .orderBy(desc(siteBuild.version))
    .limit(1);
  return b ?? null;
}

/*
  The speed gate's input (Jason, 1 October 2026): the newest Speed check of
  the preview being put live (WordPress or Netlify), made after the build
  going live finished, and whether a founder let this build go live below
  the minimum.
*/
export async function speedForGate(db: Db, projectId: string): Promise<NonNullable<GoLiveGateInput["speed"]>> {
  const [proj] = await db.select({ hosting: project.hosting }).from(project).where(eq(project.id, projectId)).limit(1);
  const target: SpeedTarget = proj?.hosting === "wordpress" ? "wordpress" : "netlify";
  const build = await latestBuild(db, projectId);
  const [check] = await db
    .select()
    .from(speedCheck)
    .where(and(eq(speedCheck.projectId, projectId), eq(speedCheck.target, target), eq(speedCheck.status, "done")))
    .orderBy(desc(speedCheck.createdAt))
    .limit(1);
  /*
    A check counts for the build it measured: the version the preview was
    serving when it started. Checks from before that was recorded fall back
    to "made after the build finished".
  */
  const current =
    check &&
    (check.buildVersion !== null
      ? check.buildVersion === build?.version
      : !build?.finishedAt || check.createdAt >= build.finishedAt);
  const results = (current ? check.results : null) as { mobile?: SpeedResult; desktop?: SpeedResult } | null;
  const [gl] = await db.select({ version: goLive.speedOverrideVersion }).from(goLive).where(eq(goLive.projectId, projectId)).limit(1);
  const [wp] = target === "wordpress" ? await db.select({ host: wpPreview.host }).from(wpPreview).where(eq(wpPreview.projectId, projectId)).limit(1) : [];
  return {
    preview: target === "wordpress" ? (isStagingHost(wp?.host) ? "WordPress preview (it's on 20i's staging address, which can't be measured: a founder lets it through)" : "WordPress preview") : "Netlify preview",
    checked: results ? { phone: results.mobile?.scores.performance ?? null, computer: results.desktop?.scores.performance ?? null } : null,
    overridden: Boolean(build && gl?.version === build.version),
  };
}

/* A founder (or an admin) lets this build go live below the minimum; logged, and only for this build. */
export async function overrideSpeed(ctx: Ctx, actor: Viewer, projectId: string): Promise<void> {
  assertCan(actor, "site.golive");
  const build = await latestBuild(ctx.db, projectId);
  if (!build) throw new SpeedCheckError("There is no finished build yet.");
  const speed = await speedForGate(ctx.db, projectId);
  if (!speed.checked) throw new SpeedCheckError("Run the Speed check first: a founder decides on the scores.");
  if (Math.min(speed.checked.phone ?? 0, speed.checked.computer ?? 0) >= SPEED_MINIMUM) throw new SpeedCheckError("The scores already meet the minimum.");
  const now = new Date();
  await ctx.db
    .insert(goLive)
    .values({ projectId, speedOverrideVersion: build.version, speedOverrideAt: now, speedOverrideBy: actor.id })
    .onConflictDoUpdate({ target: goLive.projectId, set: { speedOverrideVersion: build.version, speedOverrideAt: now, speedOverrideBy: actor.id, updatedAt: now } });
  await recordActivity(ctx.db, { action: "site.speed_overridden", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { version: build.version, ...speed.checked }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

