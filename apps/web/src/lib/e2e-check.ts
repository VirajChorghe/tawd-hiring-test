import { after } from "next/server";
import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";

import { SYSTEM_ACTOR_ID, actorFields, recordActivity } from "@tawd/core/activity";
import { checkReadiness, uploadToFigmaFile } from "@tawd/core/figma";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { SITE_BUILD_JOB, siteBuildJobId } from "@tawd/core/queue";
import { aiCall, e2eCheck, figmaDesign, project, siteBuild, siteDeploy } from "@tawd/core/schema";
import { E2E_CHECK_CLIENT } from "@tawd/core/site";
import { loadDesignFlow } from "@/lib/design-site";
import { CHECK_ABOUT_PNG, CHECK_HOME_PNG, CHECK_PHOTO_PNG } from "@/lib/e2e-check-assets";
import { pagesFor } from "@/lib/exact-design";
import { STAGES, stageHref } from "@/lib/stages";
import { getQueue } from "@/lib/mockups";
import { PRIVATE_PREVIEW_WARNING, deployPreview } from "@/lib/netlify";
import { deleteProject } from "@/lib/project-deletion";
import { createProject } from "@/lib/projects";
import type { ServiceContext } from "@/lib/users";
import { alertSiteCheckFailed } from "@/lib/site-check-alerts";

/* TAWD itself (the automatic check after a deploy) is no person: "started by" stays empty. */
const personOf = (actor: Viewer) => (actor.id === SYSTEM_ACTOR_ID ? null : actor.id);

/*
  The end-to-end check (Jason, 29 September 2026: "before I retry the sample client, run
  a $0 end-to-end test on the live server"). On the live server, one click:
  a test project from a small made-up design, its site built with stand-in
  answers (the real build, no AI, nothing in the ledger), deployed as a
  Netlify preview, and the share link opened page by page and picture by
  picture. Each step says passed or failed and why. The test project stays
  until the next check (so its link can be opened), then goes, with its
  Netlify site.
*/

type Db = ServiceContext["db"];

export class E2eCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "E2eCheckError";
  }
}

export interface CheckStep {
  key: "clear" | "project" | "stages" | "build" | "deploy" | "link";
  label: string;
  status: "waiting" | "running" | "passed" | "failed";
  detail: string | null;
}

/*
  After a deploy the check stops before Netlify (Jason, 1 October 2026): every
  Netlify deploy costs the VML team credits, and a check after each push used
  them up. The full check, with the deploy and the share link, is one click on
  System.
*/
const AUTOMATIC_SKIPS: CheckStep["key"][] = ["deploy", "link"];
const stepsFor = (automatic: boolean) => STEPS.filter((s) => !automatic || !AUTOMATIC_SKIPS.includes(s.key));

const STEPS: Pick<CheckStep, "key" | "label">[] = [
  { key: "clear", label: "Remove the last check's test project and its Netlify site" },
  { key: "project", label: "Make a test project from a small design (2 pages, 1 photo)" },
  { key: "stages", label: "Open every stage link (Intake, Design, Content, Build & preview, Go live) for every lane" },
  { key: "build", label: "Build the site (stand-in answers: no AI, $0)" },
  { key: "deploy", label: "Deploy the Netlify preview" },
  { key: "link", label: "Open the share link: pages, pictures, styles, noindex" },
];

/* A stopped web server leaves a check "running": after 20 minutes it counts as stopped. */
const STALE_MS = 20 * 60_000;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let fetchOverride: Fetch | null = null;
let sleepOverride: ((ms: number) => Promise<void>) | null = null;
const pending = new Set<Promise<unknown>>();

export function setE2eCheckForTesting(stand: { fetch?: Fetch | null; sleep?: ((ms: number) => Promise<void>) | null } | null): void {
  fetchOverride = stand?.fetch ?? null;
  sleepOverride = stand?.sleep ?? null;
}

/** For tests: wait for a check started outside a request. */
export async function settleE2eChecks(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}

const sleep = (ms: number) => (sleepOverride ?? ((t: number) => new Promise<void>((resolve) => setTimeout(resolve, t))))(ms);

/**
 * options.automatic: started by TAWD after a deploy (29 September 2026). Only
 * a failure is announced: the admins' strip, email and the team Slack channel.
 */
export async function startE2eCheck(ctx: ServiceContext, actor: Viewer, options: { automatic?: { version: string } } = {}): Promise<string> {
  assertCan(actor, "settings.manage");
  const [last] = await ctx.db.select().from(e2eCheck).orderBy(desc(e2eCheck.createdAt)).limit(1);
  if (last?.status === "running" && Date.now() - last.createdAt.getTime() < STALE_MS) throw new E2eCheckError("A check is already running.");
  const [row] = await ctx.db
    .insert(e2eCheck)
    .values({ status: "running", steps: stepsFor(Boolean(options.automatic)).map((s) => ({ ...s, status: "waiting", detail: null })), startedByUserId: personOf(actor) })
    .returning({ id: e2eCheck.id });
  await recordActivity(ctx.db, { action: "system.e2e_check", entityType: "setting", entityId: row!.id, ...actorFields(actor), valueAfter: { started: true, ...(options.automatic ? { automatic: true, version: options.automatic.version } : {}) }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
  const task = () => runE2eCheck(ctx, actor, row!.id, options.automatic ?? null).catch((error: unknown) => console.error(`End-to-end check: ${error instanceof Error ? error.message : "unknown"}`));
  try {
    after(task);
  } catch {
    const running = task().finally(() => pending.delete(running));
    pending.add(running);
  }
  return row!.id;
}

async function runE2eCheck(ctx: ServiceContext, actor: Viewer, checkId: string, automatic: { version: string } | null): Promise<void> {
  const db = ctx.db;
  const steps: CheckStep[] = stepsFor(Boolean(automatic)).map((s) => ({ ...s, status: "waiting", detail: null }));
  const save = async (fields: Partial<typeof e2eCheck.$inferInsert> = {}) => db.update(e2eCheck).set({ steps, ...fields }).where(eq(e2eCheck.id, checkId));
  let projectId: string | null = null;
  const step = async (key: CheckStep["key"], run: () => Promise<string | null>) => {
    const s = steps.find((x) => x.key === key)!;
    s.status = "running";
    await save();
    try {
      s.detail = await run();
      s.status = "passed";
      await save();
    } catch (error) {
      s.status = "failed";
      s.detail = error instanceof Error ? error.message : "It stopped unexpectedly.";
      await save();
      throw error;
    }
  };

  try {
    await step("clear", async () => {
      // Only projects an earlier check made (its saved project id), never a real project that happens to share the name (13 October 2026, the whole-code review).
      const made = db.select({ id: e2eCheck.projectId }).from(e2eCheck).where(isNotNull(e2eCheck.projectId));
      const old = await db.select().from(project).where(and(eq(project.clientName, E2E_CHECK_CLIENT), ne(project.status, "live"), inArray(project.id, made)));
      for (const p of old) await deleteProject(ctx, actor, p.id, { confirmName: E2E_CHECK_CLIENT, reason: "The end-to-end check replaces its last test project." });
      return old.length ? `Removed ${old.length} test project${old.length === 1 ? "" : "s"}.` : "Nothing to remove.";
    });

    await step("project", async () => {
      // Saved the moment it exists, so a setup that fails part-way still leaves a project the next check can clear (CodeRabbit, PR #14).
      projectId = await makeTestProject(ctx, actor, async (id) => {
        projectId = id;
        await save({ projectId: id });
      });
      return "Home and About, from an uploaded design with one photo.";
    });

    await step("stages", async () => {
      // Every link the stage strip gives, for every lane, exactly as a person clicks it: each page must exist on this server (signed out, it asks you to sign in; a missing one says "not found").
      const id = projectId!;
      // The app's own address, not the public one: behind Cloudflare Access every public page answers with Access's sign-in (30 September 2026).
      const base = `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
      const hrefs = [...new Set(STAGES.map((s) => stageHref(id, s)))];
      const missing: string[] = [];
      for (const href of hrefs) {
        const response = await (fetchOverride ?? fetch)(`${base}${href}`, { redirect: "manual" }).catch(() => null);
        if (!response || response.status === 404 || response.status >= 500) missing.push(`${href} (${response ? response.status : "no answer"})`);
      }
      if (missing.length) throw new E2eCheckError(`These stage pages don't open on this server: ${missing.join(", ")}.`);
      return `All ${hrefs.length} stage pages open (the same links for Lane 1, Lane 2 Option A and Option B).`;
    });

    await step("build", async () => {
      const id = projectId!;
      const [build] = await db.insert(siteBuild).values({ projectId: id, version: 1, status: "queued", startedByUserId: actor.id, options: { kind: "design", only: ["home", "about"] } }).returning({ id: siteBuild.id });
      await getQueue().add(SITE_BUILD_JOB, { buildId: build!.id, projectId: id, standIn: true }, { jobId: siteBuildJobId(build!.id), attempts: 1 });
      const done = await waitFor(async () => {
        const [row] = await db.select().from(siteBuild).where(eq(siteBuild.id, build!.id)).limit(1);
        return row && (row.status === "done" || row.status === "failed") ? row : null;
      }, 15 * 60_000, "The build didn't finish within 15 minutes. Is the worker running?");
      if (done.status === "failed") throw new E2eCheckError(`The build failed: ${done.failureReason ?? "no reason given"}`);
      const spent = await db.select().from(aiCall).where(eq(aiCall.projectId, id));
      if (spent.length) throw new E2eCheckError(`The build called the AI ${spent.length} time(s); it must use the stand-ins only.`);
      const flow = await loadDesignFlow(db, id, actor);
      const pages = flow?.preview?.pages ?? [];
      const problems: string[] = [];
      if (pages.length !== 2) problems.push(`${pages.length} built pages instead of 2`);
      for (const p of pages) {
        if (!p.designUrl) problems.push(`${p.name}: no design picture for the side by side`);
        if (!p.shotUrl) problems.push(`${p.name}: no picture of the built page`);
        // The automatic check's findings and every Site check rule (section E of Jason's list), on the pages as built.
        const broken = p.notes.filter((n) => /missing|isn't in the design|cut off|overlap|sideways|^Site rule/i.test(n));
        for (const n of broken) problems.push(`${p.name}: ${n}`);
      }
      if (problems.length) throw new E2eCheckError(`Built, but: ${problems.join("; ")}.`);
      return `Built ${pages.map((p) => p.name).join(" and ")} with no AI calls and nothing spent.`;
    });

    if (automatic) {
      await save({ status: "passed", finishedAt: new Date() });
      await recordActivity(db, { action: "system.e2e_check", entityType: "setting", entityId: checkId, ...actorFields(actor), valueAfter: { result: "passed", automatic: true, skipped: AUTOMATIC_SKIPS } });
      return;
    }

    await step("deploy", async () => {
      const id = projectId!;
      const deployId = await deployPreview(ctx, actor, id);
      const done = await waitFor(async () => {
        const [row] = await db.select().from(siteDeploy).where(eq(siteDeploy.id, deployId)).limit(1);
        return row && (row.state === "ready" || row.state === "failed") ? row : null;
      }, 6 * 60_000, "Netlify didn't finish within 6 minutes.");
      if (done.state === "failed") throw new E2eCheckError(`The deploy failed: ${done.error ?? "no reason given"}`);
      return `Published at ${done.url}.`;
    });

    await step("link", async () => {
      const id = projectId!;
      // Exactly the link the Preview shows under "Share for review" (the same field the screen renders), as a client would open it.
      const flow = await loadDesignFlow(db, id, actor);
      const url = flow?.site.url;
      if (!url) throw new E2eCheckError("The Preview has no share link to show.");
      await save({ previewUrl: url });
      const problems = await checkShareLink(url);
      if (problems.length) throw new E2eCheckError(`${url}: ${problems.join("; ")}.`);
      return `${url} opens: both pages, the privacy and cookie pages, every picture and style, and it is kept out of search engines.`;
    });

    await save({ status: "passed", finishedAt: new Date() });
    await recordActivity(db, { action: "system.e2e_check", entityType: "setting", entityId: checkId, ...actorFields(actor), valueAfter: { result: "passed" } });
  } catch {
    await save({ status: "failed", finishedAt: new Date() });
    const failed = steps.find((s) => s.status === "failed");
    await recordActivity(db, { action: "system.e2e_check", entityType: "setting", entityId: checkId, ...actorFields(actor), valueAfter: { result: "failed", step: failed?.label ?? null, detail: failed?.detail ?? null } });
    if (automatic) await alertSiteCheckFailed(db, { version: automatic.version, step: failed?.label ?? null, detail: failed?.detail ?? null });
  }
}

async function waitFor<T>(poll: () => Promise<T | null | undefined>, limitMs: number, timeout: string): Promise<T> {
  const until = Date.now() + limitMs;
  for (;;) {
    const found = await poll();
    if (found) return found;
    if (Date.now() > until) throw new E2eCheckError(timeout);
    await sleep(3000);
  }
}

/* The test project: Lane 2, Option A, an uploaded design of two pages with one photo on Home. */
async function makeTestProject(ctx: ServiceContext, actor: Viewer, created: (id: string) => Promise<void>): Promise<string> {
  const id = await createProject(ctx, actor, { clientName: E2E_CHECK_CLIENT, trade: "home_services", tier: "starter", lane: "lane_2", laneOption: "a", conceptCount: null, status: "mockups", memberUserIds: [] }, { teamSlack: false });
  await created(id);
  const storage = getStorage();
  const prefix = projectStoragePrefix(id);
  const words = (title: string) => [
    { text: "TAWD CHECK", x: 60, y: 42, w: 200, h: 30, size: 28, weight: 700, color: "#ffffff", font: null },
    { text: "HOME", x: 1000, y: 48, w: 60, h: 20, size: 18, weight: 700, color: "#ffffff", font: null },
    { text: "ABOUT", x: 1100, y: 48, w: 70, h: 20, size: 18, weight: 700, color: "#ffffff", font: null },
    { text: title, x: 100, y: 200, w: 600, h: 56, size: 48, weight: 700, color: "#0b1a4a", font: null },
    { text: "A test page built by TAWD's end-to-end check. No AI is used.", x: 100, y: 300, w: 700, h: 24, size: 20, weight: 400, color: "#1a1a2a", font: null },
    { text: "GET IN TOUCH", x: 130, y: 398, w: 150, h: 22, size: 18, weight: 700, color: "#ffffff", font: null },
    { text: "(c) 2026 TAWD check", x: 100, y: 800, w: 220, h: 20, size: 16, weight: 400, color: "#ffffff", font: null },
  ];
  const sections = [
    { name: "Header", top: 0, height: 120, background: "#0b1a4a" },
    { name: "Hero", top: 120, height: 600, background: "#ffffff" },
    { name: "Footer", top: 720, height: 180, background: "#0b1a4a" },
  ];
  const page = (number: number, title: string, photo: boolean) => ({
    number,
    width: 1440,
    height: 900,
    background: "#ffffff",
    readBy: "vision",
    sections,
    texts: words(title),
    images: photo ? [{ ref: "check-photo-1", kind: "photo", x: 900, y: 200, w: 300, h: 200 }] : [],
  });
  const version = `check-${Date.now()}`;
  const reads = [page(1, "Welcome to the check", true), page(2, "About the check", false)];
  // Each page's read, where an upload keeps it (the style kit reads them).
  for (const read of reads) await storage.put(`${prefix}design-upload/read-pages/page-${read.number}.json`, Buffer.from(JSON.stringify({ page: read, notes: [] })), "application/json");
  const file = uploadToFigmaFile(reads as never[], "TAWD check.pdf", version);
  const frameNodes = file.document.children![0]!.children!;
  const pngs = [CHECK_HOME_PNG, CHECK_ABOUT_PNG];
  const frames = [];
  for (const [i, f] of frameNodes.entries()) {
    const imageKey = `${prefix}frames/page-${i + 1}.png`;
    await storage.put(imageKey, Buffer.from(pngs[i]!, "base64"), "image/png");
    frames.push({ id: f.id, name: i === 0 ? "Home" : "About", width: 1440, height: 900, isHome: i === 0, imageKey, scale: 1 });
  }
  const photoKey = `${prefix}figma/images/check-photo-1.png`;
  await storage.put(photoKey, Buffer.from(CHECK_PHOTO_PNG, "base64"), "image/png");
  const fileJsonKey = `${prefix}design.json`;
  await storage.put(fileJsonKey, Buffer.from(JSON.stringify(file)), "application/json");
  const [figma] = await ctx.db
    .insert(figmaDesign)
    .values({
      projectId: id,
      url: "upload",
      fileKey: "upload",
      source: "upload",
      fileName: "TAWD check.pdf",
      importStatus: "done",
      importedVersion: version,
      importedAt: new Date(),
      importedByUserId: personOf(actor),
      fileJsonKey,
      readiness: checkReadiness(file),
      frames,
      imageFiles: { "check-photo-1": photoKey },
    })
    .returning();
  await pagesFor(ctx.db, id, figma!);
  return id;
}

/* The share link as a client opens it: each page, every picture and stylesheet it uses, the privacy pages, and noindex. */
async function checkShareLink(url: string): Promise<string[]> {
  const get = fetchOverride ?? fetch;
  const base = url.replace(/\/+$/, "");
  const problems: string[] = [];
  const open = async (path: string) => {
    try {
      return await get(`${base}${path}`, { redirect: "follow" });
    } catch (error) {
      problems.push(`${path} didn't open (${error instanceof Error ? error.message : "no answer"})`);
      return null;
    }
  };
  const pages: [string, string][] = [
    ["/", "Welcome to the check"],
    ["/about/", "About the check"],
    ["/privacy/", "Privacy"],
    ["/cookies/", "Cookie"],
  ];
  const assets = new Set<string>();
  for (const [path, words] of pages) {
    const response = await open(path);
    if (!response) continue;
    if (response.status === 401 || response.status === 403) {
      problems.push(`${path} is refused to visitors (${response.status}). ${PRIVATE_PREVIEW_WARNING}`);
      break;
    }
    if (response.status !== 200) {
      problems.push(`${path} answered ${response.status}`);
      continue;
    }
    const html = await response.text();
    if (!html.includes(words)) problems.push(`${path} doesn't show "${words}"`);
    if (path === "/" && !/noindex/i.test(response.headers.get("x-robots-tag") ?? "")) problems.push("the preview isn't marked noindex (X-Robots-Tag)");
    for (const m of html.matchAll(/<(?:img|source)\b[^>]*\bsrc=["']([^"']+)["']/gi)) assets.add(m[1]!);
    for (const m of html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi)) assets.add(m[1]!);
    for (const m of html.matchAll(/<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']stylesheet["']/gi)) assets.add(m[1]!);
    if (html.includes("tawd-asset:")) problems.push(`${path} still has an unfilled picture token`);
  }
  let pictures = 0;
  for (const src of assets) {
    if (!src.startsWith("/") || src.startsWith("//")) continue; // the site's own files only
    const response = await open(src);
    if (!response) continue;
    const type = response.headers.get("content-type") ?? "";
    if (response.status !== 200) problems.push(`${src} answered ${response.status}`);
    else if (/\.(png|jpe?g|webp|svg|gif)$/i.test(src) && !type.startsWith("image/")) problems.push(`${src} isn't served as a picture (${type || "no type"})`);
    else if (/\.(png|jpe?g|webp|svg|gif)$/i.test(src)) pictures += 1;
  }
  if (pictures === 0) problems.push("the home page shows no pictures (the test photo should be there)");
  const robots = await open("/robots.txt");
  if (robots && !/Disallow:\s*\/\s*$/m.test(await robots.text())) problems.push("robots.txt doesn't keep search engines out");
  return problems;
}

/* ---------- what the page reads ---------- */

export interface E2eCheckView {
  id: string;
  status: "running" | "passed" | "failed" | "stopped";
  steps: CheckStep[];
  previewUrl: string | null;
  projectId: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  startedByUserId: string | null;
}

export async function loadE2eCheck(db: Db): Promise<E2eCheckView | null> {
  const [row] = await db.select().from(e2eCheck).orderBy(desc(e2eCheck.createdAt)).limit(1);
  if (!row) return null;
  const stale = row.status === "running" && Date.now() - row.createdAt.getTime() > STALE_MS;
  return {
    id: row.id,
    status: stale ? "stopped" : (row.status as E2eCheckView["status"]),
    steps: row.steps as CheckStep[],
    previewUrl: row.previewUrl,
    projectId: row.projectId,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    startedByUserId: row.startedByUserId,
  };
}
