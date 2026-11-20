import { BEFORE_AFTER, HEALTH_RULES_PROMPT, describeHealthFlags, healthContextFrom, healthFlagItems, healthFlags, isHealthProject } from "@tawd/core/content";
import { CACHE_1H, confirmedFactsFrom } from "@tawd/core/mockups";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import type { Browser } from "playwright-core";

import { getDb } from "@tawd/core/db";
import { approvedMockupVersion } from "@tawd/core/approved";
import { aiCall, clientDesignDoc, goLive, projectTracking, editPage, editRequest, pageDraft, pageFix, pagePlanPage, project, seoAudit, siteBuild, siteImport } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import { loadSuppliedHome, suppliedHomeMain, type SuppliedHome } from "./html-mockup-import";
import { anchorPaths, deadLinks, headerNavLinks, menuPages, rewriteAnchors } from "@tawd/core/supplied-nav";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import type { SiteBuildJobData, SiteEditJobData } from "@tawd/core/queue";
import {
  SiteBuildError,
  keptWordsCheck,
  fillArticle,
  hasArticleSlot,
  type ImportedPageSummary,
  matchOldPage,
  type OldPageForMatch,
  applyPhotoAlt,
  astroProject,
  buildPagePrompt,
  buildPartsPrompt,
  buildSiteSystemPrompt,
  checkHomeAgainstPlan,
  checkPageVariety,
  extractDesignSystem,
  homeBandPlan,
  type HomeBand,
  pagePath,
  placeholdersIn,
  readPageReply,
  readPartsReply,
  type SiteImage,
  type SitePageInput,
  SIMPLE_PAGE_CSS,
  THANK_YOU_PATH,
  areaServedFrom,
  headersFile,
  netlifyForms,
  checkIntegrationLinks,
  consentBanner,
  consentRuleFor,
  hasTracking,
  privacyLinks,
  renderPolicy,
  policyFieldsFrom,
  projectStates,
  stateAddOns,
  policyLinks,
  withPolicyLinks,
  socialProfiles,
  type SiteVideo,
  PRIVACY_POLICY_PATH,
  COOKIE_POLICY_PATH,
  trackingHead,
  type TrackingConfig,
  fillIntegrations,
  integrationsChecklistItem,
  integrationsPrompt,
  notFoundMain,
  robotsTxt,
  runChecklist,
  seoHead,
  sitemapXml,
  thankYouMain,
  applyForms,
  formDefinition,
  formPromptLine,
  exactPage,
  simpleExactPage,
  SIMPLE_PAGE_CSS as EXACT_EXTRA_CSS,
  type BusinessFacts,
  buildEditPrompt,
  trackedChanges,
  leftOutUrls,
  mergeRedirects,
  netlifyRedirectsFile,
  redirectMap,
  type RankedPage,
  type RedirectRow,
  type StageBuildOptions,
  COMING_SOON_CSS,
  comingSoonMain,
  stageSlugKey,
  formatPhonesInHtml,
  dropNameLabel,
  dropHollowReviews,
  fillPictureFrames,
  unifyCallButtons,
  unifyFormButtons,
  stripActiveContent,
  stripActiveContentInPage,
  describeChanges,
  describeEach,
  joinSentences,
  isKeptMain,
  passOverPage,
  restampKept,
  sharedPartsNote,
  type TextChange,
  textChanges,
  visibleWords,
  consentBannerWorks,
  VIDEO_SCRIPT,
} from "@tawd/core/site";

import { stepModel } from "./step-model";
import { buildSiteFeaturesBlock, callCost, checkPageRules, featuresTheIntakeAllows, fillIcons, iconWordsWithNoIcon, pageHasFeature, requestSettings, SITE_PHOTO_CAPTION, sitePhotoAlts, type SiteFeature } from "@tawd/core/mockups";
import { isLicensedTrade } from "@tawd/core/intake";
import type { WorkerConfig } from "./config";
import { currentSiteInventory, loadProjectContext, recordCall, sourceKeyFor } from "./pipeline";
import { currentSitePhotos, pagePhotoKey } from "./site-photos";
import { prepareAssets, type AssetFile, type PreparedAsset } from "./assets";
import { VIEWPORT } from "./render";
import { usageOf } from "./review";
import { readProfile } from "./skills";
import { loadExactSite, type ExactSite } from "./site-exact";
import { checkBuiltPage, designSite } from "./design-site";
import { bandWordsNotes, bandsShowWords } from "./band-words";
import { suggestSeo } from "./seo-suggest";
import { writeSiteImages } from "./site-images";
import { finishSite } from "./site-finish";
import { speedLine, speedUpSite, speedUpSiteSafely, type SpeedReport } from "./site-speed";
import { requestHash, type ReusePool } from "./saved-answers";
import { designPage } from "@tawd/core/schema";
import type { DesignBuildOptions } from "@tawd/core/site";
import { isKeptLineage, keptWordsFor, pageReadyForBuild, projectTypeFor, suppliedHomeFile, suppliedHomeWords } from "@tawd/core/site-read";
import { pinnedStatusFetch, refusePrivate } from "./liked-sites";
import { ownPageContext } from "./locked-context";
import { openPage } from "./page-load";

/*
  Build A, 8a (26 September 2026): the static site. From the approved
  mockup (the design system) and each page's approved copy: one AI call
  for the shared header and footer, one per page, each saved before it is
  read with one retry; then Astro turns the project into plain files,
  which go to R2 under projects/<id>/site/v<n>/. Every page is photographed
  (its first screen) for the Build screen. Nothing is deployed here: that
  is 8b's preview deploy.
*/

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

async function setStep(buildId: string, step: string) {
  await getDb().update(siteBuild).set({ step }).where(eq(siteBuild.id, buildId));
}

/* The approved concept's page, with its image tokens (the source). */
async function approvedMockup(projectId: string) {
  // The approved version, or the logo swap made from it (27 September 2026).
  const approved = await approvedMockupVersion(getDb(), projectId);
  if (!approved) throw new SiteBuildError("The client hasn't approved a mockup yet: the site is built from the approved one.");
  const { version, concept: picked } = approved;
  if (!version.htmlKey) throw new SiteBuildError("The approved mockup's page is missing.");
  const source = (await getStorage().get(sourceKeyFor(version.htmlKey))) ?? (await getStorage().get(version.htmlKey));
  if (!source) throw new SiteBuildError("The approved mockup's page is missing from storage.");
  /*
    A homepage the team supplied as an HTML file (16 November 2026): its own
    pictures come with it, and its home page is kept as it is (see the page
    loop in runClaimedBuild). Null for every generated mockup, which then
    behaves exactly as it always did.
  */
  const supplied = await loadSuppliedHome(getStorage(), picked, version);
  return { html: source.toString("utf8"), conceptId: picked.id, version: version.version, supplied };
}

/* Every page in the plan, with the copy Content approved (the latest version, approved). */
async function approvedPages(projectId: string, suppliedHome = false) {
  const db = getDb();
  const pages = await db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId)).orderBy(asc(pagePlanPage.position));
  if (pages.length === 0) throw new SiteBuildError("There is no page plan yet.");
  // Keep the current site (6 October 2026): pages whose words came from the current site keep them word for word.
  const [imported] = await db.select({ pages: siteImport.pages }).from(siteImport).where(eq(siteImport.projectId, projectId)).limit(1);
  const importedPages = (imported?.pages ?? []) as ImportedPageSummary[];
  const out: { page: typeof pagePlanPage.$inferSelect; copy: string; kept: { hadForm: boolean } | null }[] = [];
  const waiting: string[] = [];
  // Design only (0.100.0): kept words need no approval on Content.
  const designOnly = (await projectTypeFor(db, projectId)) === "design_only";
  for (const page of pages) {
    const versions = await db.select().from(pageDraft).where(eq(pageDraft.pageId, page.id)).orderBy(desc(pageDraft.version));
    const latest = versions[0];
    /*
      A supplied homepage is kept as it is, so its home page needs no approved
      copy and is never held to the current site's kept words (the kept-words
      check would compare the supplied page against words it does not use).
      Whatever the plan entry is for (title, description, menu) is still read.
    */
    if (suppliedHome && page.kind === "home") {
      out.push({ page, copy: latest?.body ?? "", kept: null });
      continue;
    }
    // Kept only while its newest words are still the current site's (an improved or redrafted page isn't).
    const kept = isKeptLineage(versions);
    if (!latest?.body || !pageReadyForBuild(versions, designOnly)) waiting.push(page.name);
    else out.push({ page, copy: latest.body, kept: kept ? { hadForm: importedPages.find((p) => p.path === pagePath(page.slug))?.hasForm ?? false } : null });
  }
  if (suppliedHome && !out.some((o) => o.page.kind === "home")) throw new SiteBuildError("The client approved the homepage you supplied, but the page plan has no Home page to keep it as. Add a Home page to the plan on Content.");
  if (waiting.length) throw new SiteBuildError(designOnly ? `These pages have no words from the current site yet: ${waiting.join(", ")}. Add their words on Content, or remove them from the plan.` : `These pages aren't approved by Content yet: ${waiting.join(", ")}.`);
  return out;
}

/*
  What an exact build (Option A) starts from: the approved homepage copy as
  the design system (for the client's DESIGN.md), and the design's pages in
  place of the page plan. No builder prompt: nothing is asked of the AI.
*/
async function exactContext(browser: Browser, config: WorkerConfig, projectId: string, runId: string, exact: ExactSite) {
  const db = getDb();
  const storage = getStorage();
  const [row] = await db.select().from(project).where(eq(project.id, projectId)).limit(1);
  if (!row) throw new SiteBuildError("That project no longer exists.");
  const mockup = await approvedMockup(projectId);
  const context = await loadProjectContext(db, storage, browser, config, { projectId, runId });
  const pages = exact.pages.map((p) => ({
    page: { id: p.id, name: p.name, kind: p.kind, slug: p.slug, mainKeyword: p.mainKeyword ?? "", title: p.title ?? `${p.name} | ${row.clientName}`, metaDescription: p.metaDescription ?? "" } as unknown as typeof pagePlanPage.$inferSelect,
    copy: "",
  }));
  const plan = pages.map((p) => ({ name: p.page.name, kind: p.page.kind, slug: p.page.slug }));
  // An exact (Option A) build places the design's own pages verbatim; no per-page photo matching.
  return { row, mockup, pages, design: extractDesignSystem(mockup.html), homePlan: homeBandPlan(mockup.html), context, images: [] as (SiteImage & { bytes: Buffer })[], system: [] as Anthropic.TextBlockParam[], plan, siteFeatures: [] as SiteFeature[], pagePhotos: NO_PAGE_PHOTOS };
}

/* One call, saved before it is read; one retry saying what was wrong. The prompt may carry pictures (Lane 2's design pages). */
export async function ask<T>(
  client: Anthropic,
  config: WorkerConfig,
  system: Anthropic.TextBlockParam[],
  prompt: string | Anthropic.ContentBlockParam[],
  read: (text: string) => T,
  ledger: {
    projectId: string;
    runId: string;
    startedByUserId: string | null;
    step: "site_parts" | "site_page" | "site_edit" | "site_page_fix" | "design_site_parts" | "design_site_page" | "design_site_rework";
    label: string;
    /** Answers from an unfinished build this one may reuse for $0 (a design build's retry). */
    reuse?: ReusePool;
    /** Stop before another call once this run has spent more than this (twice its estimate). */
    stopAbove?: number;
    /** A free check: no AI; each call it would make is listed here and a stand-in answers. */
    dryRun?: { step: string; label: string; reused: boolean }[];
  },
): Promise<T> {
  const db = getDb();
  const hash = requestHash(system, prompt);
  const saved = ledger.reuse?.take(ledger.step, ledger.label, hash) ?? null;
  if (ledger.dryRun) {
    ledger.dryRun.push({ step: ledger.step, label: ledger.label, reused: Boolean(saved) });
    const standIn =
      ledger.step === "design_site_parts" || ledger.step === "site_parts"
        ? '<header class="site-header"><a href="#main">Skip to content</a></header><footer class="site-footer"><p>Website by Velocity Media Lab</p></footer>'
        : `<main id="main"><h1>${ledger.label.replace(/</g, "&lt;")}</h1><p>A stand-in for the free check: no AI was asked.</p></main>`;
    return read(standIn);
  }
  if (saved) {
    const text = saved.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    try {
      return read(text);
    } catch {
      // The saved answer can't be used: ask for a new one below, as usual.
    }
  }
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // Twice the estimate spent already: stop here rather than pay for more (29 September 2026).
    if (ledger.stopAbove !== undefined) {
      const spent = (await db.select().from(aiCall).where(eq(aiCall.runId, ledger.runId))).reduce((n, c) => n + callCost(c), 0);
      if (spent > ledger.stopAbove) {
        throw new SiteBuildError(`Stopped at twice its estimate: this build has spent $${spent.toFixed(2)} (estimate $${(ledger.stopAbove / 2).toFixed(2)}). Nothing more was spent; ${ledger.label} wasn't built. Check the model and the estimate on Spend before building again.`);
      }
    }
    const model = await stepModel(db, ledger.step);
    const response = await client.messages
      .stream({ model, max_tokens: 32_000, system, messages, ...requestSettings(model, { effort: config.effort, adaptiveThinking: true }) })
      .finalMessage();
    await recordCall(db, {
      projectId: ledger.projectId,
      runId: ledger.runId,
      conceptId: null,
      startedByUserId: ledger.startedByUserId,
      model,
      step: ledger.step,
      round: attempt,
      usage: usageOf(response.usage),
      turns: [{ stopReason: response.stop_reason, content: response.content }],
      label: ledger.label,
      requestHash: attempt === 1 ? hash : null,
    });
    if (response.stop_reason === "refusal") throw new SiteBuildError(`The builder declined to build ${ledger.label}.`);
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    try {
      return read(text);
    } catch (error) {
      if (!(error instanceof SiteBuildError) || attempt === 2) {
        throw new SiteBuildError(`${ledger.label} could not be used: ${error instanceof Error ? error.message : "unknown"}`, { cause: error });
      }
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: `That reply could not be used: ${error.message} Reply again with only what was asked.` });
    }
  }
  throw new SiteBuildError(`${ledger.label} could not be built.`);
}

/*
  Astro, on a folder of its own; its telemetry is always off. Astro writes
  its prerendered pages inside the output folder only when that folder is
  inside process.cwd(); otherwise into <cwd>/.astro, which on the server is
  /app/.astro and not the worker's to write (Jason, 29 September 2026). So
  for the build, process.cwd() answers the build's own folder: nothing is
  written outside it. One Astro build at a time, so the answer is never
  mixed up between two builds.
*/
let astroQueue: Promise<unknown> = Promise.resolve();

export async function runAstroBuild(root: string): Promise<string> {
  process.env.ASTRO_TELEMETRY_DISABLED = "1";
  const require = createRequire(import.meta.url);
  await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
  await fs.symlink(path.dirname(require.resolve("astro/package.json")), path.join(root, "node_modules", "astro"), "junction");
  const { build } = (await import("astro")) as { build: (config: Record<string, unknown>) => Promise<void> };
  const outDir = path.join(root, "dist");
  const run = astroQueue.then(async () => {
    const realCwd = process.cwd;
    process.cwd = () => root;
    try {
      await build({ root, outDir, cacheDir: path.join(root, "node_modules", ".astro"), logLevel: "error", telemetry: false, build: { format: "directory" }, trailingSlash: "always" });
    } finally {
      process.cwd = realCwd;
    }
  });
  astroQueue = run.catch(() => undefined);
  await run;
  return outDir;
}

/*
  "Speed up this build": the site's files of version N copied into a new
  version and put through the speed pass (pictures, fonts, loading). Its
  saved sources and pictures of the pages come along unchanged, its checks
  too, with the speed line. Free: no AI.
*/
// What TAWD itself puts in a page's body, exactly: the video script and the consent
// banner in each form it can take (its mode, and the state rule's symmetrical buttons).
const TAWD_BODY_PARTS = [
  VIDEO_SCRIPT,
  ...(["opt_in", "opt_out"] as const).flatMap((consentMode) =>
    [true, false].map((symmetricalButtons) =>
      consentBanner({ consentMode } as TrackingConfig, { floor: "opt_out", honorGpc: false, symmetricalButtons, optOutHonoredNotice: false, privacyChoicesLink: false }),
    ),
  ),
];

/*
  The go-live check for tracking (audit F-005, 12 November 2026): on every
  page the banner is there and can be answered (both buttons still call
  tawdConsent), and the opt-out link is there. Shared by the build and by
  "Speed up this build", which used to copy the old version's result.
*/
export function trackingCheck(pages: [string, string][], hasPrivacy: boolean, consentMode: string | null | undefined) {
  const missing = pages.filter(([, h]) => !h.includes('id="tawd-consent"') || !h.includes("data-tawd-optout")).map(([f]) => f);
  const dead = pages.filter(([f, h]) => !missing.includes(f) && !consentBannerWorks(h)).map(([f]) => f);
  const problems = [
    missing.length ? `Missing on ${missing.slice(0, 6).join(", ")}` : null,
    dead.length ? `The cookie banner's buttons don't work on ${dead.slice(0, 6).join(", ")}: visitors couldn't answer or close it. Build the site again.` : null,
    hasPrivacy ? null : "The privacy page is missing.",
  ].filter(Boolean);
  return {
    key: "tracking",
    label: "Tracking codes behind the visitor's consent",
    ok: problems.length === 0,
    detail: problems.length ? problems.join(" ") : `${pages.length} pages; consent: ${consentMode === "opt_in" ? "ask first" : "on unless the visitor opts out"}; "Do not sell or share my information" on every page`,
    blocksGoLive: true,
  };
}

async function speedUpBuild(build: typeof siteBuild.$inferSelect, from: number, browser: Browser): Promise<void> {
  const db = getDb();
  const storage = getStorage();
  const [source] = await db.select().from(siteBuild).where(and(eq(siteBuild.projectId, build.projectId), eq(siteBuild.version, from))).limit(1);
  if (!source || source.status !== "done") throw new Error(`Version ${from} isn't a finished build.`);
  const oldPrefix = `${projectStoragePrefix(build.projectId)}site/v${from}/`;
  const newPrefix = `${projectStoragePrefix(build.projectId)}site/v${build.version}/`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tawd-speed-"));
  const dist = path.join(root, "site");
  try {
    await setStep(build.id, `Copying version ${from}`);
    const kept: string[] = [];
    for (const key of await storage.list(oldPrefix)) {
      const rel = key.slice(oldPrefix.length);
      const bytes = await storage.get(key);
      if (!bytes) continue;
      // TAWD's own files (the saved sources, the pictures of the pages) go across as they are.
      if (rel.startsWith("_source/") || rel.startsWith("_shots/")) {
        await storage.put(`${newPrefix}${rel}`, bytes, contentTypeFor(rel));
        kept.push(rel);
        continue;
      }
      await fs.mkdir(path.dirname(path.join(dist, rel)), { recursive: true });
      // An earlier version may predate the cleanup (13 October 2026): its AI-written parts are cleaned on the way.
      await fs.writeFile(path.join(dist, rel), rel.endsWith(".html") ? stripActiveContentInPage(bytes.toString("utf8"), TAWD_BODY_PARTS) : bytes);
    }
    await formatSitePhones(dist);
    await setStep(build.id, "Making the pages fast (pictures, fonts)");
    const { server, origin } = await serve(dist);
    let speed: SpeedReport | null = null;
    try {
      speed = await speedUpSite(browser, dist, origin);
    } finally {
      server.close();
    }
    // Netlify's headers with the year's caching for the new files (preview or live, as the build was).
    await fs.writeFile(path.join(dist, "_headers"), headersFile(source.mode === "live" ? "live" : "preview"), "utf8");
    const outFiles = await listFiles(dist);
    for (const file of outFiles) await storage.put(`${newPrefix}${file}`, await fs.readFile(path.join(dist, file)), contentTypeFor(file));
    const pages = ((source.pages ?? []) as { shotKey?: string | null }[]).map((p) => ({ ...p, shotKey: p.shotKey?.startsWith(oldPrefix) ? `${newPrefix}${p.shotKey.slice(oldPrefix.length)}` : (p.shotKey ?? null) }));
    // The tracking check is run again on the new files, never copied: the cleanup above is what broke the banner before (audit F-005).
    const copied = (source.checks ?? []) as { key: string }[];
    const oldTracking = copied.find((c) => c.key === "tracking");
    let tracking: ReturnType<typeof trackingCheck> | null = null;
    if (oldTracking) {
      const pagesHtml: [string, string][] = [];
      for (const file of outFiles.filter((f) => f.endsWith(".html"))) pagesHtml.push([file, await fs.readFile(path.join(dist, file), "utf8")]);
      const [trackingRow] = await db.select({ consentMode: projectTracking.consentMode }).from(projectTracking).where(eq(projectTracking.projectId, build.projectId)).limit(1);
      tracking = trackingCheck(pagesHtml, outFiles.includes("privacy/index.html"), trackingRow?.consentMode);
    }
    const checks = [
      ...copied.filter((c) => c.key !== "speed").map((c) => (c.key === "tracking" && tracking ? tracking : c)),
      { key: "speed", label: "Made fast: pictures, fonts, loading", ok: true, detail: [`From version ${from}.`, speedLine(speed!), ...speed!.notes].join(" "), blocksGoLive: false },
    ];
    const [finished] = await db
      .update(siteBuild)
      .set({ status: "done", step: null, pages, checks, mode: source.mode, fileCount: outFiles.length + kept.length, conceptId: source.conceptId, conceptVersion: source.conceptVersion, finishedAt: new Date() })
      .where(and(eq(siteBuild.id, build.id), eq(siteBuild.status, "working")))
      .returning({ id: siteBuild.id });
    // Swept as stalled while this ran: the row says failed and stays failed (nothing more is written for it).
    if (!finished) return;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

/*
  Phone numbers (6 October 2026): every US number in a built page's words
  shown as "(916) 555-0142", whatever the AI or a makeover's kept words
  wrote. Code only, free; tel: links, schema and scripts keep their formats.
*/
export async function formatSitePhones(dist: string, onKept?: (file: string, changes: TextChange[]) => void): Promise<number> {
  let changed = 0;
  for (const file of await listFiles(dist)) {
    if (!file.endsWith(".html")) continue;
    const html = await fs.readFile(path.join(dist, file), "utf8");
    // A kept page (a supplied homepage) keeps its own phone number as written: the layout rule runs everywhere else on the page, and what it would have done to the kept words is reported.
    const passed = passOverPage(html, (page) => formatPhonesInHtml(page));
    if (passed.wouldChange.length) onKept?.(file, passed.wouldChange);
    if (!passed.applied) continue;
    const formatted = passed.html;
    if (formatted === html) continue;
    await fs.writeFile(path.join(dist, file), formatted, "utf8");
    changed += 1;
  }
  return changed;
}

/*
  The code rules for every page TAWD designed (Jason, 8 October 2026, on
  Sample Plumbing Co.): icons re-chosen from what each says (the
  site copies the concept's, ticks and all), stock frames filled with the
  client's own photos (unused ones first) or taken out, every form button
  "Request a quote", the hero's name-only label dropped.
*/
export async function tidySitePages(
  dist: string,
  input: { trade: string; businessName: string; phones?: string[]; cities?: string[]; pagePhotoPaths?: Set<string>; yearFounded?: number | null; licenseNumbers?: string[] },
): Promise<{ notes: string[]; findings: { file: string; messages: string[] }[]; kept: { file: string; changes: TextChange[]; icons: number; frames: number }[] }> {
  const files = (await listFiles(dist)).filter((f) => f.endsWith(".html"));
  // Crawl-% rule (a): a page's own photos belong only on that page. They stay where the
  // builder placed them, but are kept out of the cross-page empty-frame fallback below, so
  // one page's service photo can never land on another page. Shared home photos/uploads fill.
  const pagePhotoPaths = input.pagePhotoPaths ?? new Set<string>();
  const photos = (await listFiles(dist))
    .filter((f) => /^images\/photo-[^/]+\.(jpe?g|png|webp)$/i.test(f))
    .map((f) => `/${f}`)
    .filter((p) => !pagePhotoPaths.has(p));
  const pages = new Map<string, string>();
  for (const file of files) pages.set(file, await fs.readFile(path.join(dist, file), "utf8"));
  const everything = [...pages.values()].join("\n");
  const unused = photos.filter((p) => !everything.includes(p));
  const given = new Map<string, number>();
  const pick = () => {
    const next = unused.shift() ?? [...photos].sort((a, b) => (given.get(a) ?? 0) - (given.get(b) ?? 0))[0] ?? null;
    if (next) given.set(next, (given.get(next) ?? 0) + 1);
    return next;
  };
  let icons = 0, frames = 0, removed = 0, buttons = 0, labels = 0, calls = 0, reviews = 0;
  const findings: { file: string; messages: string[] }[] = [];
  const kept: { file: string; changes: TextChange[]; icons: number; frames: number }[] = [];
  // Stage 1 of the self-check plan: the words TAWD had no icon for, said out loud instead of silently becoming a house.
  const noIconWords = new Set<string>();
  // Every rule, in order, over one page (or, for a kept page, over what is outside its kept <main>).
  const tidyOne = (html: string, take: () => string | null) => {
    const iconed = fillIcons(html, { refill: true });
    let out = iconed.html;
    const framed = fillPictureFrames(out, () => take());
    out = framed.html;
    const unified = unifyFormButtons(out);
    out = unified.html;
    const named = dropNameLabel(out, input.businessName);
    out = named.html;
    // 0.103.5: the call buttons, a reviews band with nothing real in it, then the page rules code can't fix, for the checklist.
    const called = unifyCallButtons(out, input.phones ?? []);
    out = called.html;
    const hollow = dropHollowReviews(out);
    out = hollow.html;
    return { out, iconed, framed, unified, named, called, hollow };
  };
  for (const [file, html] of pages) {
    // A kept page (a supplied homepage) is tidied outside its kept <main> only; what the rules would have done inside it is reported, not done.
    let spent: ReturnType<typeof tidyOne> | null = null;
    let seen: ReturnType<typeof tidyOne> | null = null;
    const passed = passOverPage(html, (page, forReal) => {
      // The look-and-see run never takes a photo out of the pool.
      const r = tidyOne(page, forReal ? pick : () => photos[0] ?? null);
      if (forReal) spent = r;
      else seen = r;
      return r.out;
    });
    if (!passed.applied) {
      // The kept page could not be passed over safely and was left exactly as it was: none of the rules' work happened, so none of it is counted, and the team is told.
      kept.push({ file, changes: passed.wouldChange, icons: 0, frames: 0 });
      const unchanged = checkPageRules(html, { businessName: input.businessName, cities: input.cities ?? [], phones: input.phones ?? [], yearFounded: input.yearFounded, licenseNumbers: input.licenseNumbers, kept: true });
      if (unchanged.length) findings.push({ file, messages: unchanged.map((i) => i.message) });
      continue;
    }
    const real = spent as ReturnType<typeof tidyOne> | null;
    if (!real) continue;
    const out = passed.html;
    for (const word of iconWordsWithNoIcon(real.iconed.html)) noIconWords.add(word);
    const would = seen as ReturnType<typeof tidyOne> | null;
    if (would && (passed.wouldChange.length || would.iconed.filled || would.framed.filled || would.framed.removed)) {
      kept.push({ file, changes: passed.wouldChange, icons: would.iconed.filled, frames: would.framed.filled + would.framed.removed });
    }
    // The page rules code can't fix are read on the page as it will be served, kept words included.
    const left = checkPageRules(out, { businessName: input.businessName, cities: input.cities ?? [], phones: input.phones ?? [], yearFounded: input.yearFounded, licenseNumbers: input.licenseNumbers, kept: isKeptMain(out) });
    if (left.length) findings.push({ file, messages: left.map((i) => i.message) });
    calls += real.called.changed;
    reviews += real.hollow.dropped;
    icons += real.iconed.filled;
    frames += real.framed.filled;
    removed += real.framed.removed;
    buttons += real.unified.changed;
    labels += real.named.dropped ? 1 : 0;
    if (out !== html) await fs.writeFile(path.join(dist, file), out, "utf8");
  }
  const notes = [
    icons ? `${icons} icon${icons === 1 ? "" : "s"} set from TAWD's icon set` : null,
    frames ? `${frames} empty picture frame${frames === 1 ? "" : "s"} given the client's photo` : null,
    removed ? `${removed} picture frame${removed === 1 ? "" : "s"} with no photo to give taken out` : null,
    buttons ? `${buttons} form button${buttons === 1 ? "" : "s"} now "Request a quote"` : null,
    labels ? `${labels} label${labels === 1 ? "" : "s"} repeating the business name taken out` : null,
    calls ? `${calls} call button${calls === 1 ? "" : "s"} now "Call" and the number` : null,
    reviews ? `${reviews} reviews band${reviews === 1 ? "" : "s"} with no customer's words taken out` : null,
    noIconWords.size
      ? `no icon in TAWD's set for ${noIconWords.size === 1 ? "this word" : "these words"}, so ${noIconWords.size === 1 ? "its slot shows" : "their slots show"} a plain dot: ${[...noIconWords].map((w) => `"${w}"`).join(", ")}`
      : null,
  ].filter((n): n is string => Boolean(n));
  return { notes, findings, kept };
}

/*
  The kept home page's <main> is the client's; the header and footer round it
  are TAWD's (the menu has to point at the site's real pages), so they are
  written by TAWD and may word things differently. Said once per kept page,
  naming a phone number written differently when there is one.
*/
export async function sharedPartsNotes(dist: string): Promise<string[]> {
  const out: string[] = [];
  for (const file of await listFiles(dist)) {
    if (!file.endsWith(".html")) continue;
    const note = sharedPartsNote(await fs.readFile(path.join(dist, file), "utf8"));
    if (note) out.push(`The shared header and footer on ${file}: ${note}`);
  }
  return out;
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
    .sort();
}

/* A throwaway local server for the built files, so the browser can photograph each page as it will be served. */
export async function serve(folder: string): Promise<{ server: Server; origin: string }> {
  // One spelling of the folder, so the "inside it" test holds on every system.
  const dir = path.resolve(folder);
  const server = createServer((request, response) => {
    void (async () => {
      let url: string;
      try {
        url = decodeURIComponent((request.url ?? "/").split("?")[0]!);
      } catch {
        // A stray "%" in an address answers 400, never crashes the whole worker (13 October 2026, the whole-code review).
        response.writeHead(400);
        response.end();
        return;
      }
      let file = path.join(dir, url.endsWith("/") ? `${url}index.html` : url);
      if (!file.startsWith(dir)) file = path.join(dir, "404.html");
      try {
        const body = await fs.readFile(file);
        response.writeHead(200, { "Content-Type": contentTypeFor(file) });
        response.end(body);
      } catch {
        response.writeHead(404);
        response.end();
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, origin: `http://127.0.0.1:${port}` };
}

/*
  The features the built site must keep (crawl-%, 6 November 2026): the current
  site's features (currentSiteInventory + the intake's own rules, the same set
  the concepts were held to), narrowed to the ones the APPROVED CONCEPT actually
  kept — a feature the concept left out on purpose isn't required of the build.
  Empty for a Lane 2 designer build (no current-site concept) and when there is
  no concept home to read. A storage/DB failure is not swallowed: it propagates
  and fails the build rather than quietly passing the go-live gate.
*/
async function buildSiteFeatures(
  db: ReturnType<typeof getDb>,
  storage: ReturnType<typeof getStorage>,
  projectId: string,
  trade: Parameters<typeof isLicensedTrade>[0],
  lane: string,
  business: { licenseInProgress?: boolean | null; noGoogleBusinessProfile?: boolean | null; googleBusinessProfileUrl?: string | null; licenseNumbers: string[] },
  conceptHtml: string | null,
) {
  if (lane === "lane_2" || !conceptHtml) return [];
  const inventory = await currentSiteInventory(db, storage, projectId);
  if (!inventory) return [];
  const allowed = featuresTheIntakeAllows(inventory.features, {
    licenseInProgress: business.licenseInProgress,
    licensedTrade: isLicensedTrade(trade),
    noGoogleBusinessProfile: business.noGoogleBusinessProfile,
    googleBusinessProfileUrl: business.googleBusinessProfileUrl,
    licenseNumbers: business.licenseNumbers,
  });
  // Only what the approved concept kept: a feature it dropped (with a reason) is not the build's to carry.
  return allowed.filter((f) => pageHasFeature(conceptHtml, f.id));
}

/* How many of a matched old page's photos one built page is given (the rest go to its siblings, rule b). */
const PER_PAGE_PHOTO_SLICE = 3;

export interface PagePhotos {
  /** The per-page photos to write as image files (added to the shared logo/home photos). */
  assets: PreparedAsset[];
  /** Per built-page slug: the photos the builder is told to use first on that page. */
  bySlug: Map<string, { token: string; caption: string }[]>;
  /** Per built-page slug: which old page the photos came from (rule d: the activity log). */
  source: Map<string, { oldPath: string; reason: string }>;
}

const NO_PAGE_PHOTOS: PagePhotos = { assets: [], bySlug: new Map(), source: new Map() };

export interface PagePhotoPlanPage {
  slug: string;
  name: string;
  mainKeyword: string;
  kind: string;
}

/*
  Which captured old-page photos each built page gets (the pure decision, so
  it is tested without a browser). For each non-home page: the old page it
  matches (page-photos.ts) supplies photos; no confident match means no entry,
  and the page is left to the shared home photos — never a guess (rule a). The
  photos of one old page are handed out in disjoint slices, so sibling pages
  that match it don't repeat (rule b). Each chosen photo is an AssetFile that
  already carries the old alt as its caption (rule c). `source` records the
  match for the activity log (rule d).
*/
export function planPagePhotos(
  plan: PagePhotoPlanPage[],
  oldForMatch: OldPageForMatch[],
  filesByKey: Map<string, AssetFile[]>,
  generalWords: string,
  beforeAfterPermission: boolean,
  slice: number = PER_PAGE_PHOTO_SLICE,
): { bySlug: Map<string, AssetFile[]>; source: Map<string, { oldPath: string; reason: string }> } {
  const bySlug = new Map<string, AssetFile[]>();
  const source = new Map<string, { oldPath: string; reason: string }>();
  // Per old page: how many of its photos have been handed out so siblings don't repeat (rule b).
  const claimed = new Map<string, number>();
  for (const page of plan) {
    if (!page.slug || page.kind === "home") continue; // the home keeps its own photos
    const match = matchOldPage({ slug: page.slug, name: page.name, mainKeyword: page.mainKeyword }, oldForMatch, { generalWords });
    if (!match) continue; // no confident match → the shared home photos fill this page (rule a)
    const key = pagePhotoKey(match.oldPath);
    // Same rule as the home photos (pipeline.ts): a before-and-after photo is kept only with the client's permission.
    const files = (filesByKey.get(key) ?? []).filter((f) => beforeAfterPermission || !BEFORE_AFTER.test(f.caption ?? ""));
    if (files.length === 0) continue; // nothing usable → the shared home photos fill this page
    const start = claimed.get(key) ?? 0;
    const mine = files.slice(start, start + slice);
    if (mine.length === 0) continue; // the old page's photos are used up across siblings → fallback (rule b)
    claimed.set(key, start + mine.length);
    bySlug.set(page.slug, mine);
    source.set(page.slug, { oldPath: match.oldPath, reason: match.reason });
  }
  return { bySlug, source };
}

/*
  Crawl-% per-page photos (Jason, 7 November 2026): each built page gets its
  own photos from the old site's most alike page, captured at the crawl and
  reused here (currentSitePhotos, storedOnly — never a fresh read at build).
  The matching and assignment is planPagePhotos; this loads the captured
  photos and prepares them as image files.
*/
async function loadPagePhotos(
  db: ReturnType<typeof getDb>,
  storage: ReturnType<typeof getStorage>,
  browser: Browser,
  projectId: string,
  plan: PagePhotoPlanPage[],
  generalWords: string,
  beforeAfterPermission: boolean,
): Promise<PagePhotos> {
  const [imported] = await db.select({ pages: siteImport.pages }).from(siteImport).where(eq(siteImport.projectId, projectId)).limit(1);
  const oldPages = ((imported?.pages as ImportedPageSummary[] | null) ?? []).filter((p) => p.url && p.path !== "/" && !p.gap);
  if (oldPages.length === 0) return NO_PAGE_PHOTOS;
  const oldForMatch: OldPageForMatch[] = oldPages.map((p) => ({ path: p.path, title: p.title, name: p.name, h1s: p.h1s }));

  // Load each matched old page's captured photos (once per old page).
  const filesByKey = new Map<string, AssetFile[]>();
  for (const page of plan) {
    if (!page.slug || page.kind === "home") continue;
    const match = matchOldPage({ slug: page.slug, name: page.name, mainKeyword: page.mainKeyword }, oldForMatch, { generalWords });
    if (!match) continue;
    const key = pagePhotoKey(match.oldPath);
    if (filesByKey.has(key)) continue;
    const old = oldPages.find((p) => p.path === match.oldPath);
    if (!old) continue;
    try {
      // All captured photos; planPagePhotos applies the before-and-after permission filter.
      // expectUrl = this crawl's page url, so a manifest left from an earlier site is rejected (not served as this page's).
      filesByKey.set(key, await currentSitePhotos(storage, { projectId, url: old.url, browser, storedOnly: true, pageKey: key, expectUrl: old.url }));
    } catch (error) {
      console.warn(`[page photos] ${page.slug}: couldn't read ${match.oldPath}'s photos (${error instanceof Error ? error.message : "unknown"}); using the shared photos.`);
    }
  }

  const { bySlug: filesBySlug, source: planSource } = planPagePhotos(plan, oldForMatch, filesByKey, generalWords, beforeAfterPermission);
  const chosen = [...filesBySlug.values()].flat();
  // Each chosen file keeps its own per-page token (photo-<key>-N), so the assets and the builder's list agree.
  const assets = chosen.length ? await prepareAssets(browser, storage, chosen) : [];
  const { bySlug, source } = advertisablePagePhotos(filesBySlug, new Set(assets.map((a) => a.token)), planSource);
  return { assets, bySlug, source };
}

/*
  The photos to actually offer the builder, keeping bySlug/source in step with the
  files that were written. prepareAssets drops any photo whose bytes it couldn't read;
  a dropped photo's token must NOT be advertised, because with no image written it would
  become a visible [PLACEHOLDER] on the page and block go-live (the home asset list is built
  from the prepared assets for the same reason). A slug left with no photos falls back to the
  shared home photos, and its source line is dropped so the activity log doesn't claim photos
  that aren't there.
*/
export function advertisablePagePhotos(
  filesBySlug: Map<string, AssetFile[]>,
  preparedTokens: Set<string>,
  planSource: Map<string, { oldPath: string; reason: string }>,
): { bySlug: Map<string, { token: string; caption: string }[]>; source: Map<string, { oldPath: string; reason: string }> } {
  const bySlug = new Map<string, { token: string; caption: string }[]>();
  const source = new Map<string, { oldPath: string; reason: string }>();
  for (const [slug, files] of filesBySlug) {
    const kept = files.filter((f) => f.token && preparedTokens.has(f.token)).map((f) => ({ token: f.token!, caption: f.caption ?? "" }));
    if (kept.length === 0) continue; // every photo dropped → fall back to the shared home photos
    bySlug.set(slug, kept);
    const s = planSource.get(slug);
    if (s) source.set(slug, s);
  }
  return { bySlug, source };
}

/* The client's old alt per token, for applyPhotoAlt: sitePhotoAlts from core (gap 14), shared and per-page alike. */
const pagePhotoAlts = (photos: { token: string; caption: string }[] | undefined): Map<string, string> => sitePhotoAlts(photos ?? []);

/*
  Gap 14 (security): a site photo's caption embeds the old site's scraped alt —
  data, never instructions — so the builder's asset list gets a neutral line;
  the real alt is carried onto the built <img> by code (applyPhotoAlt), the
  same as the per-page photos. The team's own captions (uploads) are trusted.
*/
export function assetListFor(assets: { token: string; kind: string; caption: string | null }[]): string {
  return assets.length
    ? assets
        .map((a) => {
          const what = a.kind === "logo" ? "the client's logo" : (a.caption ?? "").startsWith(SITE_PHOTO_CAPTION) ? "photo from the client's current website" : a.caption ? `photo, "${a.caption}"` : "photo";
          return `- ${a.token}: ${what}`;
        })
        .join("\n")
    : "No logo or photos were uploaded: use labeled placeholder frames, and the business name as text where the logo goes.";
}

/*
  What every build and every edit starts from: the approved mockup as the
  design system, the approved pages, the client's images, and the builder's
  system prompt (the same text each time, so the cache is reused).
*/
export async function siteContext(browser: Browser, config: WorkerConfig, projectId: string, runId: string) {
  const db = getDb();
  const storage = getStorage();
  const build = { projectId, id: runId };
  const [row] = await db.select().from(project).where(eq(project.id, build.projectId)).limit(1);
  if (!row) throw new SiteBuildError("That project no longer exists.");
  const mockup = await approvedMockup(build.projectId);
  const pages = await approvedPages(build.projectId, Boolean(mockup.supplied));
  const design = extractDesignSystem(mockup.html);
  /*
    F25: the approved homepage's bands, in order, as a binding plan for the
    built homepage. The mockup's sections used to be handed over as
    "examples of the site's building blocks" with one sentence asking the
    homepage to keep their layout, and that sentence lost to the rules
    around it. Worked out by code, free.
  */
  // A supplied homepage is kept, not rebuilt, so there is no band plan to hold a rebuilt one to.
  const homePlan: HomeBand[] = mockup.supplied ? [] : homeBandPlan(mockup.html);
  const context = await loadProjectContext(db, storage, browser, config, { projectId: build.projectId, runId: build.id });

  // Crawl-% per-page photos: each built page's own photos from the old site's most alike page.
  // General words (the business's own keyword and city) are never counted toward a topic match.
  const business = context.intake.data.business;
  const planForMatch = pages.map((p) => ({ slug: p.page.slug, name: p.page.name, mainKeyword: p.page.mainKeyword ?? "", kind: p.page.kind }));
  const homeKeyword = planForMatch.find((p) => p.kind === "home")?.mainKeyword ?? "";
  const generalWords = [business.name, business.city, row.trade, homeKeyword].filter(Boolean).join(" ");
  const pagePhotos = await loadPagePhotos(db, storage, browser, build.projectId, planForMatch, generalWords, context.intake.data.photos.beforeAfterPermission);

  // The client's logo and photos as files; tokens in the pages become their paths. The per-page photos are added to the shared logo/home photos (never replacing them, so the empty-frame fill always has a pool).
  const images: (SiteImage & { bytes: Buffer })[] = [...context.assets, ...pagePhotos.assets].map((asset) => {
    const match = /^data:([^;]+);base64,(.*)$/.exec(asset.dataUri);
    const ext = match?.[1]?.includes("png") ? "png" : match?.[1]?.includes("svg") ? "svg" : match?.[1]?.includes("webp") ? "webp" : "jpg";
    return { token: asset.token, path: `/images/${asset.token.replace("tawd-asset:", "")}.${ext}`, bytes: Buffer.from(match?.[2] ?? "", "base64") };
  });
  // The supplied homepage's own pictures are site files too: its tokens (photo-page-N, never the client's photo-N) become /images/ paths.
  if (mockup.supplied) images.push(...mockup.supplied.images);
  const assetList = assetListFor(context.assets);

  // The features the client's current site has (crawl-%): told to the builder so the
  // built pages keep them, the same set the concepts were held to.
  const siteFeatures = await buildSiteFeatures(db, storage, projectId, row.trade, row.lane, context.intake.data.business, mockup.html);
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: buildSiteSystemPrompt(
        await readProfile(config.skillsDir),
        design,
        assetList,
        [integrationsPrompt(context.intake.data.extras.integrations), isHealthProject(row.trade, context.intake.data) ? HEALTH_RULES_PROMPT : ""].filter(Boolean).join("\n\n"),
        // The client's DESIGN.md, newest version: every build and monthly edit follows it.
        (await db.select({ markdown: clientDesignDoc.markdown }).from(clientDesignDoc).where(eq(clientDesignDoc.projectId, projectId)).orderBy(desc(clientDesignDoc.version)).limit(1))[0]?.markdown ?? "",
        // F1: the fields the client chose (Website forms); TAWD writes them into the form by code.
        formPromptLine(formDefinition(context.intake.data)),
        buildSiteFeaturesBlock(siteFeatures),
      ), cache_control: CACHE_1H },
  ];
  const plan = pages.map((p) => ({ name: p.page.name, kind: p.page.kind, slug: p.page.slug }));
  return { row, mockup, pages, design, homePlan, context, images, system, plan, siteFeatures, pagePhotos };
}

/** How often a working build stamps its row (audit F-006): the sweep allows ten of these. */
export const BUILD_HEARTBEAT_MS = 60_000;

/** Stamps the build row while it is "working"; errors are swallowed (the next beat tries again). The caller clears the returned timer. */
export function startSiteBuildHeartbeat(db: ReturnType<typeof getDb>, buildId: string, everyMs = BUILD_HEARTBEAT_MS): ReturnType<typeof setInterval> {
  const beat = setInterval(() => {
    void db
      .update(siteBuild)
      .set({ heartbeatAt: new Date() })
      .where(and(eq(siteBuild.id, buildId), eq(siteBuild.status, "working")))
      .catch(() => undefined);
  }, everyMs);
  beat.unref?.();
  return beat;
}

/*
  A build is claimed in one step (audit F-006 and F-007, 12 November 2026):
  only a "queued" row becomes "working", so a job BullMQ delivers twice runs
  once. While it runs, its row is stamped every minute, even during a long
  AI call, so the sweep can tell a running build from one a stopped worker
  left behind.
*/
export async function runSiteBuildJob(job: SiteBuildJobData, config: WorkerConfig, client: Anthropic, browser: Browser): Promise<void> {
  const db = getDb();
  const [build] = await db
    .update(siteBuild)
    .set({ status: "working", step: "Reading the approved mockup and copy", heartbeatAt: new Date() })
    .where(and(eq(siteBuild.id, job.buildId), eq(siteBuild.status, "queued")))
    .returning();
  if (!build) return;
  const beat = startSiteBuildHeartbeat(db, build.id);
  try {
    await runClaimedBuild(build, job, config, client, browser);
  } finally {
    clearInterval(beat);
  }
}

async function runClaimedBuild(build: typeof siteBuild.$inferSelect, job: SiteBuildJobData, config: WorkerConfig, client: Anthropic, browser: Browser): Promise<void> {
  const db = getDb();
  const storage = getStorage();
  // "Speed up this build" (1 October 2026): an earlier build's files through the speed pass, as a new version. No AI.
  const speedFrom = (build.options as { kind?: string; from?: number } | null)?.kind === "speed" ? Number((build.options as { from?: number }).from) : null;
  if (speedFrom !== null) return speedUpBuild(build, speedFrom, browser);

  /*
    Lane 2's site from the design (29 September 2026): built close to the
    design from its pictures (design-site.ts). The exact build from the
    copies (Option A, 28 September) is kept for an admin who asks for it.
  */
  const designOptions = (build.options as DesignBuildOptions | null)?.kind === "design" ? (build.options as DesignBuildOptions) : null;
  // Fix these (3 October 2026): the saved sources with the fixed page (and header or footer) swapped in. No AI.
  const fixId = (build.options as { kind?: string; fixId?: string } | null)?.kind === "page_fix" ? String((build.options as { fixId?: string }).fixId) : null;
  // Staged builds (6 October 2026): the stage's pages by AI, the pages built before from the last version's saved sources, the rest "Coming soon".
  const stageOptions = (build.options as StageBuildOptions | null)?.kind === "stage" ? (build.options as StageBuildOptions) : null;
  const fromDesign = designOptions ? await designSite(browser, config, client, build, designOptions, (step) => setStep(build.id, step)) : null;
  const exact = build.editRequestId || fixId || fromDesign || !(build.options as { exact?: boolean } | null)?.exact ? null : await loadExactSite(build.projectId, browser);
  const { row, mockup, pages: contextPages, design, homePlan, context, images, system, plan, siteFeatures, pagePhotos } = fromDesign
    ? {
        row: fromDesign.row,
        mockup: { conceptId: null, version: null, supplied: null as SuppliedHome | null },
        // Pages not built yet stay out of this build.
        pages: fromDesign.pages.filter((_, i) => Boolean(fromDesign.mains[i])),
        design: fromDesign.design,
        /*
          A Lane 2 build is already built close to the designer's own
          pictures, page by page (design-site.ts), so there is no approved
          mockup to hold the homepage to and no plan to give it (F25).
        */
        homePlan: [] as HomeBand[],
        context: await loadProjectContext(db, storage, browser, config, { projectId: build.projectId, runId: build.id }),
        images: fromDesign.images,
        system: [] as Anthropic.TextBlockParam[],
        plan: fromDesign.plan,
        // Lane 2 designer build: the concepts never held it to the current site.
        siteFeatures: [] as SiteFeature[],
        // A Lane 2 design build uses the design's own images, not the old site's per-page photos.
        pagePhotos: NO_PAGE_PHOTOS,
      }
    : exact
      ? await exactContext(browser, config, build.projectId, build.id, exact)
      : await siteContext(browser, config, build.projectId, build.id);
  const designMains = fromDesign ? fromDesign.mains.filter(Boolean) : null;
  // A stage stops itself at twice its own estimate.
  const ledger = { projectId: build.projectId, runId: build.id, startedByUserId: build.startedByUserId, stopAbove: stageOptions?.estimate ? stageOptions.estimate * 2 : undefined };

  const fromEdit = build.editRequestId ? await editSources(build.projectId, build.editRequestId) : fixId ? await fixSources(build.projectId, fixId) : null;
  const stageBase = stageOptions ? await stageSources(build.projectId, build.version) : null;
  /*
    Which pages this version has: in a stage, the stage's own and those
    built before; after a fix or edit of a staged version, those it had.
    The others are "Coming soon" pages (never in the page list, the
    sitemap or the review), so every menu link works on the preview.
  */
  const inVersion = (entry: (typeof contextPages)[number]) => {
    const key = stageSlugKey(entry.page.slug);
    if (stageOptions) return stageOptions.only.includes(key) || stageBase!.mains.has(key);
    if (fromEdit?.staged) return fromEdit.mains.has(key);
    return true;
  };
  const pages = contextPages.filter(inVersion);
  const unbuiltPages = contextPages.filter((entry) => !inVersion(entry));
  const homeEntry = contextPages.find((entry) => entry.page.kind === "home") ?? contextPages[0];
  const homeKey = stageSlugKey(homeEntry?.page.slug ?? "");
  const stageParts = stageOptions && !stageOptions.only.includes(homeKey) ? stageBase!.parts : null;
  if (stageOptions && !stageOptions.only.includes(homeKey) && !stageParts) throw new SiteBuildError("Build the home page first: it makes the header and footer every other page uses.");
  // The pages the AI builds this time, for each page's "built in" version.
  const fresh = new Set<string>();

  await setStep(build.id, fromDesign ? "Putting the site together" : fromEdit ? "Putting the edit into the site" : exact ? "Putting the approved design's pages together" : "Building the header and footer");
  const rawParts = fromDesign
    ? fromDesign.parts
    : exact
      ? { header: exact.parts.header, footer: exact.parts.footer }
      : fromEdit
        ? fromEdit.parts
        : stageParts
          ? stageParts
          : await ask(client, config, system, buildPartsPrompt(plan, row.clientName, mockup.supplied ? menuPages(design.header, plan) : []), readPartsReply, { ...ledger, step: "site_parts", label: "The header and footer" });
  // No code from the AI on the site (13 October 2026): scripts, on...= and javascript: links go, by code.
  const parts = { ...rawParts, header: stripActiveContent(rawParts.header), footer: stripActiveContent(rawParts.footer) };

  // F1: every form gets the fields the client chose, in the form's own look, then Netlify's attributes.
  const formDef = formDefinition(context.intake.data);
  /*
    A kept page (a supplied homepage, marked on its <main>) keeps its own
    form: its fields, labels and button are what the client approved. Only
    what the form needs to send (Netlify's attributes) is added. The fields
    the client chose on Website forms are written into every other page's
    forms, as before; for a kept page the difference is reported (below).
  */
  const forms = (kind: string) => (html: string) => (isKeptMain(html) ? netlifyForms(html) : netlifyForms(applyForms(html, formDef, { isContact: kind === "contact" })));
  // What TAWD would have changed on a kept page and did not, in plain words, for the build's checklist.
  const keptReports: string[] = [];
  // The links of the supplied home page that were moved onto the pages the design's menu made. Empty on a rebuild, which does not build that page again.
  let suppliedAnchorsMoved: string[] = [];
  /* A built page's <main>, which for a supplied home page is the part the design supplied. */
  const keptMainOf = (html: string): string => {
    const open = html.indexOf("<main");
    const close = html.lastIndexOf("</main>");
    return open === -1 || close <= open ? "" : html.slice(open, close + "</main>".length);
  };
  /*
    What the usual rules would have changed on a kept page, every one of them.
    The checklist line shows the first few of a long list; the rest are never
    only "and 8 more": each report that was cut short has its whole list here,
    and the checklist shows it in a fold-out under the line.
  */
  const keptEvery: string[] = [];
  const KEPT_SHOWN = 4;
  const keptReport = (label: string, changes: TextChange[], extra: string[] = []) => {
    const lines = describeEach(changes);
    const cut = changes.length > KEPT_SHOWN;
    keptReports.push(`${label}: ${[describeChanges(changes, KEPT_SHOWN, ", all listed in full below"), ...extra].filter(Boolean).join("; ")}`);
    if (cut) keptEvery.push(...lines.map((line) => `${label}: ${line}`));
  };

  /*
    A makeover's kept articles (0.98.0): the first built by the AI is the
    layout every other one is filled into by code (kept-article.ts). An
    article built in an earlier stage serves too; without a usable one the
    next article is built by the AI and becomes it.
  */
  const isKeptArticle = (entry: (typeof pages)[number]) => entry.page.kind === "article" && "kept" in entry && Boolean(entry.kept);
  let articleLayout: string | null = null;
  if (stageBase) {
    for (const entry of contextPages) {
      const saved = isKeptArticle(entry) ? stageBase.mains.get(stageSlugKey(entry.page.slug)) : undefined;
      if (saved && hasArticleSlot(saved)) {
        articleLayout = saved;
        break;
      }
    }
  }
  let filledByCode = 0;

  // Gap 14: the shared site photos' old alts (from their captions), applied by code on every built page.
  const sharedSiteAlts = pagePhotoAlts(context.assets.map((a) => ({ token: a.token, caption: a.caption ?? "" })));
  const built: SitePageInput[] = [];
  for (const [index, entry] of pages.entries()) {
    const { page, copy } = entry;
    const planned = plan.find((p) => p.slug === page.slug) ?? { name: page.name, kind: page.kind, slug: page.slug };
    const kept = "kept" in entry ? (entry.kept as { hadForm: boolean } | null) : null;
    if (designMains) {
      const planned = plan.find((p) => p.slug === page.slug) ?? { name: page.name, kind: page.kind, slug: page.slug };
      built.push({ page: planned, title: page.title, metaDescription: page.metaDescription, main: forms(planned.kind)(fillIntegrations(designMains[index]!, context.intake.data.extras.integrations)) });
      continue;
    }
    if (exact) {
      // The page exactly as designed; TAWD's head, forms and consent parts go in when the files are written.
      built.push({ page: plan[index]!, title: page.title, metaDescription: page.metaDescription, main: fillIntegrations(exact.pages[index]!.html, context.intake.data.extras.integrations) });
      continue;
    }
    if (fromEdit) {
      // A rebuild with an edit: every page as it was, the edited ones as edited. No AI.
      const main = fromEdit.mains.get(page.slug || "home");
      if (!main) throw new SiteBuildError(`${page.name} isn't in the build the edit was made on. Build the whole site again instead.`);
      built.push({ page: planned, title: page.title, metaDescription: page.metaDescription, main: forms(page.kind)(main) });
      continue;
    }
    if (stageOptions && !stageOptions.only.includes(stageSlugKey(page.slug))) {
      // Built in an earlier stage: its saved source, as it was. No AI.
      built.push({ page: planned, title: page.title, metaDescription: page.metaDescription, main: forms(page.kind)(stageBase!.mains.get(stageSlugKey(page.slug))!) });
      continue;
    }
    fresh.add(stageSlugKey(page.slug));
    if (mockup.supplied && page.kind === "home") {
      /*
        The supplied homepage is the design the client approved: kept as it
        is, not rewritten from the approved copy by the AI (no call, no cost).
        Jason, 16 November 2026: TAWD changes nothing the visitor reads. What
        still happens is structure and attributes, so the page works: the
        photos' alts, Netlify's form attributes (the page's own fields and
        labels stay), the scripts and handlers stripped, the picture paths,
        the head, tracking and consent parts, and the speed pass (pictures,
        fonts, link labels). The words are never rewritten: the call-to-action
        rules, the phone layout, icons and empty picture frames skip this
        page (its <main> carries data-tawd-kept), and each says in the
        build's checklist what it would have changed.
      */
      await setStep(build.id, `Keeping the supplied home page (page ${index + 1} of ${pages.length}): ${page.name}`);
      /*
        The design's own menu made the plan (option A, 17 November 2026), so
        a link in the kept page that pointed at one of its own sections now
        points at the page that holds it ("#services" -> "/services/"). Only
        an exact href is replaced, and nothing a visitor reads changes. Links
        the design left going nowhere (href="#") are reported below, never
        guessed at: where they should go is the client's decision.
      */
      const navPaths = anchorPaths(headerNavLinks(design.header), plan);
      const moved = rewriteAnchors(applyPhotoAlt(suppliedHomeMain(design), sharedSiteAlts), navPaths);
      const keptHome = moved.html;
      // What was replaced on this page, not what the menu would allow (a review of the first version: the line listed every item whether or not the page used it).
      suppliedAnchorsMoved = moved.moved;
      // The form rule is the one pass that runs here, so it is the one reported here: the fields the client chose on Website forms would have replaced the page's own.
      const formWords = textChanges(visibleWords(keptHome), visibleWords(applyForms(keptHome, formDef, { isContact: false })));
      if (formWords.length) keptReport("The form's fields and button", formWords);
      built.push({ page: planned, title: page.title, metaDescription: page.metaDescription, main: forms(page.kind)(fillIntegrations(keptHome, context.intake.data.extras.integrations)) });
      continue;
    }
    if (articleLayout && isKeptArticle(entry)) {
      // Another kept article in the first one's layout: no AI.
      filledByCode += 1;
      built.push({ page: planned, title: page.title, metaDescription: page.metaDescription, main: forms(page.kind)(fillIntegrations(fillArticle(articleLayout, copy), context.intake.data.extras.integrations)) });
      continue;
    }
    await setStep(build.id, stageOptions ? `Building page ${fresh.size} of ${stageOptions.only.length} (${stageOptions.stage}): ${page.name}` : `Building page ${index + 1} of ${pages.length}: ${page.name}`);
    const main = await ask(
      client,
      config,
      system,
      buildPagePrompt({ page: planned, copy, pages: plan, isHome: page.kind === "home", kept, pagePhotos: pagePhotos.bySlug.get(page.slug), homePlan, designSections: design.sections }),
      readPageReply,
      { ...ledger, step: "site_page", label: page.name },
    );
    // Crawl-% rule (c) + gap 14: carry each photo's own old alt onto its <img>, by code
    // (the scraped alt is never put in the prompt) — the shared home photos now too; a
    // per-page photo's alt wins on the (never expected) token collision.
    const withAlt = applyPhotoAlt(main, new Map([...sharedSiteAlts, ...pagePhotoAlts(pagePhotos.bySlug.get(page.slug))]));
    // The layout later kept articles reuse is saved WITH the alts, so a site photo outside the
    // article slot keeps its old alt on every article built from it (CodeRabbit PR #51).
    if (!articleLayout && isKeptArticle(entry) && hasArticleSlot(withAlt)) articleLayout = withAlt;
    built.push({ page: planned, title: page.title, metaDescription: page.metaDescription, main: forms(page.kind)(fillIntegrations(withAlt, context.intake.data.extras.integrations)) });
  }
  for (const page of built) page.main = stripActiveContent(page.main);
  if (filledByCode) await setStep(build.id, `${filledByCode} kept article${filledByCode === 1 ? "" : "s"} filled into the first article's layout by code (no AI)`);

  // 8b: SEO in each head, the forms, the thank-you and 404 pages, robots, sitemap and headers. No AI.
  const intake = context.intake.data;
  const domain = intake.website.domainName.trim() || null;
  const facts: BusinessFacts = {
    name: intake.business.name,
    phone: intake.business.phone,
    email: intake.business.email,
    streetAddress: intake.business.streetAddress,
    city: intake.business.city,
    state: intake.business.state,
    isServiceAreaBusiness: intake.business.isServiceAreaBusiness,
    domain,
    trade: row.trade,
    areaServed: areaServedFrom(intake.serviceAreas),
    hours: intake.business.hours,
    logoPath: images.find((i) => i.token === "tawd-asset:logo")?.path ?? null,
    // The client's first photo for social sites (a logo is often SVG, which they don't show).
    shareImagePath: images.find((i) => /^tawd-asset:photo-/.test(i.token))?.path ?? null,
  };
  for (const page of built) {
    page.head = seoHead({ facts, path: pagePath(page.page.slug), kind: page.page.kind, title: page.title, description: page.metaDescription });
  }
  const extraPages: SitePageInput[] = [
    { page: { name: "Thank you", kind: "thank_you", slug: THANK_YOU_PATH.replace(/\//g, "") }, title: `Thank you | ${row.clientName}`, metaDescription: `${row.clientName} has your message.`, main: thankYouMain(facts, formDef.thankYouLine), head: '<meta name="robots" content="noindex" />' },
    { page: { name: "Not found", kind: "not_found", slug: "404" }, title: `Page not found | ${row.clientName}`, metaDescription: "That page isn't here.", main: notFoundMain(facts, plan), head: '<meta name="robots" content="noindex" />' },
  ];
  // Tracking (Todd's request): the code in every head, behind the visitor's consent; the banner, the privacy links and the policy page.
  const [trackingRow] = await db.select().from(projectTracking).where(eq(projectTracking.projectId, build.projectId)).limit(1);
  const tracking: TrackingConfig | null = trackingRow
    ? { ga4: trackingRow.ga4, gtm: trackingRow.gtm, metaPixel: trackingRow.metaPixel, googleAds: trackingRow.googleAds, callRail: trackingRow.callRail, consentMode: trackingRow.consentMode as TrackingConfig["consentMode"] }
    : null;
  // The consent rule the site must follow: the strictest of the project's states' rules
  // (consentRuleFor, state-privacy.ts; Jason, 8 November 2026: the law lives in that one table).
  const consentRule = consentRuleFor(projectStates(intake));
  /*
    Every site's privacy and cookie policies (28 September 2026): VML's
    templates, filled from the project; only the parts for the tracking
    that's on. The effective date is the build's until go-live sets it.
  */
  const [live] = await db.select({ at: goLive.wentLiveAt }).from(goLive).where(eq(goLive.projectId, build.projectId)).limit(1);
  const policyFields = policyFieldsFrom({ ...intake.business, domain, hostingProvider: "Netlify", effectiveDate: live?.at ?? new Date() });
  // The states' add-ons: the business's address, its other locations and its service areas (state-privacy.ts).
  const addOns = stateAddOns(projectStates(intake), { health: isHealthProject(row.trade, intake) }).map((r) => r.addOn);
  extraPages.push(
    { page: { name: "Privacy Policy", kind: "privacy", slug: PRIVACY_POLICY_PATH.replace(/\//g, "") }, title: `Privacy Policy | ${row.clientName}`, metaDescription: `How ${row.clientName} collects, uses and protects your information.`, main: renderPolicy("privacy", policyFields, hasTracking(tracking) ? tracking : null, addOns, { personal: intake.services.items.length === 0 }) },
    { page: { name: "Cookie Policy", kind: "cookies", slug: COOKIE_POLICY_PATH.replace(/\//g, "") }, title: `Cookie Policy | ${row.clientName}`, metaDescription: `How ${row.clientName}'s website uses cookies, and how to change your choice.`, main: renderPolicy("cookies", policyFields, hasTracking(tracking) ? tracking : null) },
  );
  // Pages not built yet: a clearly marked "Coming soon" page at their address, never indexed (staged builds, 6 October 2026).
  const comingSoon: SitePageInput[] = unbuiltPages.map((entry) => ({
    page: { name: entry.page.name, kind: entry.page.kind, slug: entry.page.slug },
    title: `${entry.page.name}: coming soon | ${row.clientName}`,
    metaDescription: `${entry.page.name} at ${row.clientName}: this page is coming soon.`,
    main: comingSoonMain(entry.page.name),
    head: '<meta name="robots" content="noindex" />',
  }));
  extraPages.push(...comingSoon);
  if (hasTracking(tracking)) {
    for (const page of [...built, ...extraPages]) page.head = `${page.head ?? ""}\n${trackingHead(tracking, consentRule)}`;
  }
  const footerLinks = hasTracking(tracking) ? privacyLinks(consentRule) : policyLinks(false);
  const publicFiles = new Map<string, string>([
    ["robots.txt", robotsTxt("preview", domain)],
    ["_headers", headersFile("preview")],
  ]);
  const sitemap = sitemapXml(domain, built.map((b) => pagePath(b.page.slug)));
  if (sitemap) publicFiles.set("sitemap.xml", sitemap);
  // The client's old addresses go to their new pages (the "Don't lose it" check), so nothing that ranks turns into a dead link.
  const [audited] = await db.select().from(seoAudit).where(and(eq(seoAudit.projectId, build.projectId), gt(seoAudit.pageCount, 0))).orderBy(desc(seoAudit.createdAt)).limit(1);
  // #5: every dropped/skipped/over-limit old URL also gets a 301, from the site read — so redirects
  // work even when the paid audit never ran.
  const [imported] = await db.select({ notImported: siteImport.notImported, skipped: siteImport.skipped, failed: siteImport.failed }).from(siteImport).where(eq(siteImport.projectId, build.projectId)).limit(1);
  const oldPages = [...((audited?.pages as { url: string }[] | null) ?? []), ...leftOutUrls(imported).map((url) => ({ url }))];
  if (oldPages.length) {
    // #6: start from the plan-consistent recompute, then overlay the saved map so a team
    // correction reaches the site (only redirects whose target this build actually has).
    const recomputed = redirectMap(oldPages, (audited?.rankings as RankedPage[] | null) ?? [], contextPages.map((p) => ({ name: p.page.name, slug: p.page.slug, mainKeyword: p.page.mainKeyword })));
    const validTargets = new Set<string>(["/", ...contextPages.map((p) => pagePath(p.page.slug))]);
    const redirects = netlifyRedirectsFile(mergeRedirects(recomputed, (audited?.redirects as RedirectRow[] | null) ?? [], validTargets));
    if (redirects) publicFiles.set("_redirects", redirects);
  }

  await setStep(build.id, "Putting the site together");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tawd-site-"));
  try {
    const files = astroProject({
      clientName: row.clientName,
      design,
      parts: { ...parts, footer: withPolicyLinks(parts.footer, hasTracking(tracking), { privacyChoicesLink: hasTracking(tracking) && consentRule.privacyChoicesLink }) },
      pages: [...built, ...extraPages],
      images,
      publicFiles,
      extraCss: `${SIMPLE_PAGE_CSS}${comingSoon.length ? COMING_SOON_CSS : ""}${fromDesign?.extraCss ?? ""}`,
      bodyEnd: `${hasTracking(tracking) ? consentBanner(tracking, consentRule) : ""}${fromDesign?.bodyEnd ?? ""}`,
    });
    let dist: string;
    if (exact) {
      // Each page written as it is, no Astro: the design's own pages with TAWD's parts added.
      dist = path.join(root, "dist");
      const extraHead = (p: SitePageInput) => `${p.head ?? ""}\n<style>${EXACT_EXTRA_CSS}</style>`;
      const write = async (file: string, text: string | Buffer) => {
        await fs.mkdir(path.dirname(path.join(dist, file)), { recursive: true });
        await fs.writeFile(path.join(dist, file), text);
      };
      for (const p of built) {
        const html = exactPage({
          html: p.main,
          title: p.title || `${p.page.name} | ${row.clientName}`,
          description: p.metaDescription,
          head: extraHead(p),
          footerEnd: footerLinks,
          bodyEnd: hasTracking(tracking) ? consentBanner(tracking, consentRule) : "",
          transform: forms(p.page.kind),
        });
        await write(p.page.slug ? `${p.page.slug}/index.html` : "index.html", html);
      }
      for (const p of extraPages) {
        const page = simpleExactPage({ ...exact.parts, head: stripActiveContent(exact.parts.head), header: parts.header, footer: parts.footer }, p.main, EXACT_EXTRA_CSS);
        const html = exactPage({ html: page, title: p.title, description: p.metaDescription, head: p.head ?? "", footerEnd: footerLinks, bodyEnd: hasTracking(tracking) ? consentBanner(tracking, consentRule) : "", transform: (h) => h });
        await write(p.page.slug === "404" ? "404.html" : `${p.page.slug}/index.html`, html);
      }
      for (const [file, text] of publicFiles) await write(file, text);
      for (const image of exact.images) await write(image.path.replace(/^\//, ""), image.bytes);
    } else {
      for (const [file, text] of files) {
        await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await fs.writeFile(path.join(root, file), text, "utf8");
      }
      await fs.mkdir(path.join(root, "public", "images"), { recursive: true });
      await writeSiteImages(root, images);
      dist = await runAstroBuild(root);
    }
    // Lane 2 (29 September 2026): the finishing pass, page by page, by code; its Site check notes go on each page.
    let finished: Map<string, string[]> = new Map();
    if (fromDesign) {
      await setStep(build.id, "Finishing the pages (links, colours, menu, phone layout, pictures)");
      const sitePages = fromDesign.plan.map((p) => ({ name: p.name, path: pagePath(p.slug) }));
      finished = (await finishSite(browser, dist, { pages: sitePages, socials: socialProfiles(row.videos as SiteVideo[] | null) })).notes;
      // A free check ends here: the whole build ran (pictures, pages, Astro, the finishing pass); nothing is kept or deployed.
      if ((build.options as DesignBuildOptions | null)?.dryRun) {
        const plan = fromDesign.dryPlan;
        const designNotes = [...fromDesign.notes.values()].flat();
        const report = {
          calls: plan.length,
          reused: plan.filter((c) => c.reused).length,
          steps: plan,
          pictures: fromDesign.images.filter((i) => i.path.startsWith("/images/")).length,
          originals: designNotes.filter((n) => /from the intake/.test(n)).length,
          trimmed: designNotes.filter((n) => /was trimmed/.test(n)).length,
          pages: plan.filter((c) => c.step !== "design_site_parts").map((c) => c.label),
        };
        await db.update(siteBuild).set({ status: "checked", step: null, checks: { dryRun: report }, finishedAt: new Date() }).where(and(eq(siteBuild.id, build.id), eq(siteBuild.status, "working")));
        return;
      }
    }

    // Every US phone number in the pages' words as "(916) 555-0142" (6 October 2026). Code only.
    await formatSitePhones(dist, (_file, changes) => keptReport("The phone number layout", changes));

    // TAWD's own designs (8 October 2026): the right icons, no empty picture frames, one form label, no name-only label. Code only.
    let tidied: Awaited<ReturnType<typeof tidySitePages>> | null = null;
    if (!fromDesign) {
      await setStep(build.id, "Tidying the pages (icons, pictures, buttons)");
      const data = context.intake.data;
      // The per-page photos' image paths, kept out of the cross-page fallback pool (crawl-% rule a).
      const pagePhotoTokens = new Set(pagePhotos.assets.map((a) => a.token));
      const pagePhotoPaths = new Set(images.filter((i) => pagePhotoTokens.has(i.token)).map((i) => i.path));
      tidied = await tidySitePages(dist, {
        trade: row.trade,
        businessName: data.business.name || row.clientName,
        // Every phone the client gave, the locations' too (B1: the mockup knew them all, the site build only the main one).
        phones: confirmedFactsFrom(data).phones,
        cities: [data.business.city, ...(data.serviceAreas.cities ?? [])].filter((c): c is string => Boolean(c)),
        // The credential budget needs the exact year and licence (11 November 2026).
        yearFounded: data.business.yearFounded,
        licenseNumbers: data.business.licenseNumbers ?? [],
        pagePhotoPaths,
      });
      if (tidied.notes.length) console.log(`[site build ${build.id}] ${tidied.notes.join("; ")}`);
      // The tidy-up rules (call-to-action words, call buttons, picture frames, icons) skipped a kept page: what they would have done to it.
      for (const k of tidied.kept) {
        const parts = [
          k.icons ? `${k.icons} icon${k.icons === 1 ? "" : "s"} would have been swapped for TAWD's own` : null,
          k.frames ? `${k.frames} empty picture frame${k.frames === 1 ? "" : "s"} would have been filled or taken out` : null,
        ].filter((p): p is string => Boolean(p));
        if (k.changes.length || parts.length) keptReport("The tidy-up rules", k.changes, parts);
      }
    }

    // The shared header and footer are TAWD's own on a supplied home page too; say so, and where their phone number is written differently.
    for (const note of await sharedPartsNotes(dist)) keptReports.push(note);

    // The speed pass (1 October 2026): pictures, fonts, lazy loading and link labels, by code, before anything is stored.
    await setStep(build.id, "Making the pages fast (pictures, fonts)");
    let speed: SpeedReport | null = null;
    let speedFailure: string | null = null;
    {
      const { server: speedServer, origin: speedOrigin } = await serve(dist);
      try {
        speed = await speedUpSiteSafely(browser, dist, speedOrigin);
      } catch (error) {
        console.error("speed pass", error);
        speedFailure = error instanceof Error ? error.message.slice(0, 200) : "it stopped part-way";
      } finally {
        speedServer.close();
      }
    }

    const prefix = `${projectStoragePrefix(build.projectId)}site/v${build.version}/`;
    const outFiles = await listFiles(dist);
    for (const file of outFiles) await storage.put(`${prefix}${file}`, await fs.readFile(path.join(dist, file)), contentTypeFor(file));
    // What the builder wrote, kept for 8c's edits (never deployed).
    await storage.put(`${prefix}_source/parts.json`, Buffer.from(JSON.stringify(parts), "utf8"), "application/json");
    for (const page of built) await storage.put(`${prefix}_source/pages/${page.page.slug || "home"}.html`, Buffer.from(page.main, "utf8"), "text/html; charset=utf-8");
    // A partial version (staged builds): the planned pages not built yet, so a fix of this version keeps them "Coming soon".
    if (stageOptions || fromEdit?.staged) await storage.put(`${prefix}_source/unbuilt.json`, Buffer.from(JSON.stringify(unbuiltPages.map((e) => stageSlugKey(e.page.slug))), "utf8"), "application/json");
    // Which version built each page: this one for the pages the AI built now, else the version before's word for it.
    const [prior] = await db
      .select({ version: siteBuild.version, pages: siteBuild.pages })
      .from(siteBuild)
      .where(and(eq(siteBuild.projectId, build.projectId), eq(siteBuild.status, "done"), lt(siteBuild.version, build.version)))
      .orderBy(desc(siteBuild.version))
      .limit(1);
    const priorBuiltIn = new Map(((prior?.pages ?? []) as { path: string; builtIn?: number }[]).map((p) => [p.path, p.builtIn ?? prior!.version]));
    const builtInFor = (slug: string) => ((fromEdit || stageOptions) && !fresh.has(stageSlugKey(slug)) ? (priorBuiltIn.get(pagePath(slug)) ?? build.version) : build.version);

    // Each page's first screen, photographed as served.
    await setStep(build.id, "Photographing the pages");
    const { server, origin } = await serve(dist);
    const shots: {
      pageId: string;
      name: string;
      path: string;
      shotKey: string | null;
      placeholders: string[];
      /** Lane 2 (29 September 2026): the page's design picture, the whole built page, and what the checks noted. */
      designKey?: string | null;
      fullShotKey?: string | null;
      notes?: string[];
      /** Staged builds: the version that built this page (later versions carry it over). */
      builtIn?: number;
    }[] = [];
    let mobileOverflow: string[] | null = null;
    // E0(b): on a page built from a design, the bands whose words a visitor can't see (page name -> notes); null when the check couldn't run.
    const bandWordsFailures = new Map<string, string[]>();
    let bandWordsRan = Boolean(fromDesign);
    try {
      const browserContext = await ownPageContext(browser, { viewport: VIEWPORT, deviceScaleFactor: 1 }, [origin]);
      try {
        const tab = await browserContext.newPage();
        for (const [index, p] of built.entries()) {
          const url = pagePath(p.page.slug);
          const html = await fs.readFile(path.join(dist, url === "/" ? "index.html" : `${p.page.slug}/index.html`), "utf8");
          let shotKey: string | null = null;
          // E0(b): the band check reads only a page that really opened (CodeRabbit #83: else it read the page before, or an error page).
          let pageOpened = false;
          try {
            await openPage(tab, `${origin}${url}`);
            pageOpened = true;
            const shot = await tab.screenshot({ type: "jpeg", quality: 70 });
            shotKey = `${prefix}_shots/${p.page.slug || "home"}.jpg`;
            await storage.put(shotKey, shot, "image/jpeg");
          } catch {
            shotKey = null;
          }
          if (fromDesign) {
            // The whole page, for the Preview beside its design, and the automatic check at phone and computer widths.
            const key = p.page.slug || "home";
            let fullShotKey: string | null = null;
            try {
              // Pictures that load lazily are loaded first, so the whole-page picture shows them.
              await tab.evaluate(async () => {
                for (const img of Array.from(document.querySelectorAll("img"))) img.loading = "eager";
                // Sections the speed pass lays out only when scrolled near are laid out now.
                for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-tawd-cv]"))) el.style.contentVisibility = "visible";
                await Promise.all(Array.from(document.images).map((img) => (img.complete ? null : img.decode().catch(() => null))));
              });
              const full = await tab.screenshot({ type: "jpeg", quality: 60, fullPage: true });
              fullShotKey = `${prefix}_shots/${key}.full.jpg`;
              await storage.put(fullShotKey, full, "image/jpeg");
            } catch {
              fullShotKey = null;
            }
            // E0(b): every band shows its words (read on this tab, as a visitor sees the page).
            let bandNotes: string[] = [];
            try {
              if (!pageOpened) throw new Error("the page didn't open in the browser");
              bandNotes = bandWordsNotes(await bandsShowWords(tab));
              if (bandNotes.length) bandWordsFailures.set(p.page.name, bandNotes);
            } catch (error) {
              console.error(`[site build ${build.id}] band words check`, error);
              bandWordsRan = false;
              const why = error instanceof Error ? error.message : "it stopped part-way";
              bandNotes = [`Whether every band shows its words couldn't be checked on this page (${why}). Build again, or tell an admin if it keeps happening.`];
              bandWordsFailures.set(p.page.name, bandNotes);
            }
            const found = await checkBuiltPage(browser, `${origin}${url}`).catch(() => [] as string[]);
            // Its search listing, suggested by code for the team to approve on the Preview (kept once approved).
            const pageId = pages[index]!.page.id;
            if (pageId !== "videos") {
              const [dp] = await db.select({ seo: designPage.seo, isHome: designPage.isHome }).from(designPage).where(eq(designPage.id, pageId)).limit(1);
              const seo = (dp?.seo as { approved?: unknown } | null) ?? {};
              const tagline = /<p class="tawd-m-tagline">([^<]+)<\/p>/.exec(parts.header)?.[1] ?? null;
              const suggested = await suggestSeo(browser, html, { pageName: p.page.name, siteName: row.clientName, isHome: Boolean(dp?.isHome), tagline }).catch(() => null);
              if (dp && suggested) await db.update(designPage).set({ seo: { ...seo, suggested, suggestedAt: new Date().toISOString() } }).where(eq(designPage.id, pageId));
            }
            shots.push({
              pageId: pages[index]!.page.id,
              name: p.page.name,
              path: url,
              shotKey,
              placeholders: placeholdersIn(html),
              designKey: fromDesign.designKeys.get(key) ?? null,
              fullShotKey,
              notes: [...bandNotes, ...(fromDesign.notes.get(key) ?? []), ...found, ...(finished.get(url) ?? [])],
            });
            continue;
          }
          shots.push({ pageId: pages[index]!.page.id, name: p.page.name, path: url, shotKey, placeholders: placeholdersIn(html), builtIn: builtInFor(p.page.slug) });
        }
      } finally {
        await browserContext.close();
      }
      // 8b: does every page fit a phone screen (390 wide)?
      mobileOverflow = [];
      const phone = await ownPageContext(browser, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 }, [origin]);
      try {
        const tab = await phone.newPage();
        for (const p of built) {
          await openPage(tab, `${origin}${pagePath(p.page.slug)}`);
          const wide = await tab.evaluate(() => ({ phoneOverflow: document.documentElement.scrollWidth > window.innerWidth + 1 }));
          if (typeof (wide as { phoneOverflow?: unknown } | undefined)?.phoneOverflow !== "boolean") {
            mobileOverflow = null;
            break;
          }
          if ((wide as { phoneOverflow: boolean }).phoneOverflow) mobileOverflow.push(p.page.name);
        }
      } catch {
        mobileOverflow = null;
      } finally {
        await phone.close();
      }
    } finally {
      server.close();
    }

    const texts = new Map<string, string>();
    for (const file of outFiles) if (/\.(html|txt|xml)$/.test(file) || file === "_headers") texts.set(file, await fs.readFile(path.join(dist, file), "utf8"));
    // The same feature set the prompt used (computed once in siteContext), so the gate and the builder agree.
    // B1: the project's confirmed facts, from the one function the mockups use too; the claims' "client's own words" come with them.
    // Without unconfirmed old-site claims (B3, named in their messages), and with the client's kept current-site words as their own (review H2).
    const confirmed = confirmedFactsFrom(intake, {
      unconfirmed: context.intake.unconfirmed.map((c) => ({ key: c.key, value: c.value })),
      keptWords: await keptWordsFor(getDb(), build.projectId),
    });
    const suppliedFile = await suppliedHomeFile(getDb(), build.projectId);
    /*
      The links of the supplied home page, read from the page that was written,
      not from the step that wrote it (a review of the first version: on a
      rebuild, or a staged build that does not build the home page again,
      nothing set them and the check vanished while the links were still dead).
      The kept main is the part the design supplied; the header and footer are
      TAWD's own.
    */
    const suppliedDeadLinks = suppliedFile && texts.has(suppliedFile) ? deadLinks(keptMainOf(texts.get(suppliedFile)!)) : [];
    const checks = runChecklist({ files: texts, fileNames: outFiles, pagePaths: built.map((b) => pagePath(b.page.slug)), domain, mobileOverflow, gbpUrl: intake.business.googleBusinessProfileUrl, claims: confirmed.claims, siteFeatures, facts: confirmed, suppliedHomeFile: suppliedFile, suppliedWords: await suppliedHomeWords(getDb(), build.projectId) });
    /*
      F25: the built homepage against the approved mockup's band plan.

      It does NOT block go-live, deliberately. The mockup's words and the
      approved copy are two different texts written by two different steps,
      so a band that genuinely has nothing to say is possible, and stopping
      a client's site over a judgement call would be worse than showing the
      team the difference. Nothing compared these two at all before this.
    */
    if (homePlan.length > 0) {
      const homeFile = built.find((b) => b.page.kind === "home");
      const homeHtml = homeFile ? texts.get(`${homeFile.page.slug ? `${homeFile.page.slug}/` : ""}index.html`) : undefined;
      const drift = homeHtml ? checkHomeAgainstPlan(homeHtml, homePlan) : [];
      checks.push({
        key: "homeLayout",
        label: "The homepage keeps the approved layout",
        ok: drift.length === 0,
        detail: drift.length === 0 ? `${homePlan.length} bands, as approved.` : drift.map((d) => d.message).join(" "),
        blocksGoLive: false,
      });
    }

    /*
      Every other page's shape (17 November 2026). A page whose bands are all
      one shape, or which has no picture while the site has photos, is the
      failure Sample Marketing Co.'s Services page showed: the builder was given a
      pile of blocks and no plan, and stamped the same one four times.

      Reported, never blocking (Jason, 17 November 2026): no project already
      built is stopped by a rule it has never been measured against. The
      supplied home page is left out - it is the client's own file, kept.
    */
    const shapeIssues = built
      .filter((b) => b.page.kind !== "home" || !mockup.supplied)
      .flatMap((b) => {
        const html = texts.get(`${b.page.slug ? `${b.page.slug}/` : ""}index.html`);
        return html ? checkPageVariety(html, { name: b.page.name, hasPhoto: images.some((i) => /^tawd-asset:photo-/.test(i.token)) }) : [];
      });
    checks.push({
      key: "pageShapes",
      label: "Every page uses the design's shapes",
      ok: shapeIssues.length === 0,
      detail: shapeIssues.length === 0 ? "No page is one shape repeated, and every page has a picture." : shapeIssues.map((i) => i.message).join(" "),
      blocksGoLive: false,
    });

    /*
      E0(b), audit batch E: a page built from a design whose band doesn't show
      its words is not finished. It blocks go-live (a build's own status is
      only done or failed, so this is how "needs attention" is said), and the
      page's Preview notes name the band. If the check couldn't run it says so
      and blocks too: a check that didn't run is not a pass.
    */
    if (fromDesign) {
      const failing = [...bandWordsFailures.entries()];
      checks.push({
        key: "designBandsShowWords",
        label: "Every band shows its words",
        ok: bandWordsRan && failing.length === 0,
        detail:
          failing.length === 0
            ? bandWordsRan
              ? "Every band's words can be seen."
              : "The check of each band's words couldn't run. Build again, or tell an admin if it keeps happening."
            : failing.map(([page, notes]) => `${page}: ${notes.join(" ")}`).join(" "),
        blocksGoLive: true,
      });
    }

    /*
      The supplied homepage, kept (Jason, 16 November 2026). Anything TAWD
      would have changed on it and did not is listed here for the team to
      judge; nothing is changed. Never blocks go-live.
    */
    if (keptReports.length) {
      checks.push({
        key: "suppliedHomeKept",
        label: "The supplied home page, kept as supplied",
        ok: false,
        detail: `TAWD left the words on the supplied home page exactly as the client approved them. Where its usual rules would have changed something, it did not; for you to look at: ${joinSentences(keptReports)}`,
        ...(keptEvery.length ? { every: keptEvery } : {}),
        blocksGoLive: false,
      });
    }
    /*
      Links in the supplied home page that go nowhere (17 November 2026). A
      supplied design often marks a page it has not designed yet with
      href="#"; nothing in TAWD checked for these, and they would have gone
      live as they are. Listed for the team, never changed or guessed at.
    */
    if (suppliedDeadLinks.length || suppliedAnchorsMoved.length) {
      const dead = suppliedDeadLinks.map((d) => d.label);
      checks.push({
        key: "suppliedHomeLinks",
        label: "The supplied home page's links",
        ok: dead.length === 0,
        detail: [
          suppliedAnchorsMoved.length ? `Moved onto the pages the design's menu made: ${suppliedAnchorsMoved.join(", ")}.` : "",
          dead.length
            ? `${dead.length} link${dead.length === 1 ? "" : "s"} in the main part of the supplied page go nowhere (href="#" or an empty one), so a visitor who clicks ${dead.length === 1 ? "it" : "them"} is taken back to the top of the page and no further: ${dead.slice(0, 8).join(", ")}${dead.length > 8 ? " (every one of them is listed below)" : ""}. Decide with the client where each should go, change the file and upload it again.`
            : "No link in the main part of the supplied page is left going nowhere.",
        ]
          .filter(Boolean)
          .join(" "),
        ...(dead.length > 8 ? { every: dead } : {}),
        blocksGoLive: false,
      });
    }
    // The page rules (0.103.5): what code fixed, and what's left for the team to look at. Never blocks go-live.
    if (tidied) {
      checks.push({
        key: "pageRules",
        label: "Page rules: buttons, labels, repeats, maps",
        ok: tidied.findings.length === 0,
        detail: [
          tidied.notes.length ? `Fixed by code: ${tidied.notes.join("; ")}.` : "Nothing to fix by code.",
          ...tidied.findings.slice(0, 6).map((f) => `${f.file}: ${f.messages.join(" ")}`),
        ].join(" "),
        blocksGoLive: false,
      });
    }
    // Health and beauty rules: flagged, never rewritten. Each flag is fixed or confirmed with the client before go-live.
    if (isHealthProject(row.trade, intake)) {
      const flags = healthFlags(built.map((b) => b.main).join("\n"), healthContextFrom(intake));
      checks.push({
        key: "health",
        label: "Health and beauty rules",
        ok: flags.length === 0,
        detail: flags.length ? `For the PM: ${describeHealthFlags(flags)}.` : "No promised results, titles only as the client gives them, no before-and-after or testimonials without the client",
        blocksGoLive: true,
        flags: healthFlagItems(flags),
      });
    }
    // Tracking: on every page, behind consent, with the opt-out link.
    if (hasTracking(tracking)) {
      const html = [...texts.entries()].filter(([f]) => f.endsWith(".html"));
      checks.push(trackingCheck(html, texts.has("privacy/index.html"), tracking.consentMode));
    }
    // Both policies, filled in, and linked from every page's footer (28 September 2026).
    {
      const html = [...texts.entries()].filter(([f]) => f.endsWith(".html") && f !== "404.html");
      const unlinked = html.filter(([, h]) => !h.includes(`href="${PRIVACY_POLICY_PATH}"`) || !h.includes(`href="${COOKIE_POLICY_PATH}"`)).map(([f]) => f);
      const pages = ["privacy/index.html", "cookies/index.html"].filter((f) => texts.has(f));
      const unfilled = pages.filter((f) => /\[PLACEHOLDER:/i.test(texts.get(f)!));
      checks.push({
        key: "policies",
        label: "Privacy and cookie policies",
        ok: pages.length === 2 && unlinked.length === 0 && unfilled.length === 0,
        detail:
          pages.length < 2
            ? "A policy page is missing."
            : unfilled.length
              ? `Still to fill in (the intake): ${unfilled.map((f) => f.split("/")[0]).join(" and ")}`
              : unlinked.length
                ? `Not linked in the footer of ${unlinked.slice(0, 6).join(", ")}`
                : "VML's templates, filled in, linked from every page",
        blocksGoLive: true,
      });
    }
    // What the speed pass did (never blocks go-live; the Speed check on the Build page measures the result).
    checks.push({
      key: "speed",
      label: "Made fast: pictures, fonts, loading",
      ok: speed !== null,
      detail: speed
        ? [speedLine(speed), ...speed.notes].join(" ")
        : `The speed pass didn't run${speedFailure ? ` (${speedFailure})` : ""}: the site is as built. Speed up this build tries again, free.`,
      blocksGoLive: false,
    });
    /*
      Keep the current site (6 October 2026): every sentence of a kept page's
      words should be on its built page. Code only, free; it never fixes
      anything, and never blocks go-live: the team reads the list.
    */
    {
      const keptPages = designMains || exact ? [] : pages.flatMap((entry, index) => ("kept" in entry && entry.kept && built[index] ? [{ name: entry.page.name, path: pagePath(entry.page.slug), result: keptWordsCheck(built[index]!.main, entry.copy) }] : []));
      if (keptPages.length) {
        const changed = keptPages.filter((p) => p.result.missing.length > 0);
        const sentences = keptPages.reduce((n, p) => n + p.result.total, 0);
        checks.push({
          key: "kept_words",
          label: "The current site's words, kept word for word",
          ok: changed.length === 0,
          detail: changed.length
            ? `Missing or changed on ${changed.length} of ${keptPages.length} kept pages (compare with the page's approved copy on Content): ${changed
                .slice(0, 8)
                .map((p) => `${p.name} (${p.path}): ${p.result.missing.length} of ${p.result.total} sentences, e.g. "${p.result.missing[0]!.slice(0, 90)}"`)
                .join("; ")}${changed.length > 8 ? `; and ${changed.length - 8} more pages` : ""}.`
            : `All ${sentences} sentences of the ${keptPages.length} kept pages are on the built pages.`,
          blocksGoLive: false,
        });
      }
    }
    // The client's booking, shop, portal and review links: on the site, and answering.
    const tools = intake.extras.integrations.filter((i) => i.url);
    if (tools.length) {
      await setStep(build.id, "Checking the booking, shop and review links");
      const results = await checkIntegrationLinks(tools.map((i) => i.url), pinnedStatusFetch, 10_000, async (u) => (await refusePrivate(u)) !== null).catch(() => null);
      const item = integrationsChecklistItem(tools, [...texts.entries()].filter(([f]) => f.endsWith(".html")).map(([, h]) => h), results);
      if (item) checks.push(item);
    }

    const [recorded] = await db
      .update(siteBuild)
      .set({ status: "done", step: null, pages: shots, checks, mode: "preview", fileCount: outFiles.length, conceptId: mockup.conceptId, conceptVersion: mockup.version, finishedAt: new Date() })
      .where(and(eq(siteBuild.id, build.id), eq(siteBuild.status, "working")))
      .returning({ id: siteBuild.id });
    // Swept as stalled while this ran: the row says failed and stays failed, so no "rebuilt", no "site.built", nothing after.
    if (!recorded) return;
    if (build.editRequestId) {
      await db.update(editRequest).set({ status: "rebuilt", buildId: build.id }).where(eq(editRequest.id, build.editRequestId));
    }
    // A page fix's version: the fix itself (worker page-fix.ts) checks it, may try once more, then marks the fix done.
    await recordActivity(db, {
      action: "site.built",
      entityType: "project",
      entityId: build.projectId,
      ...actorFields(SYSTEM_ACTOR),
      valueAfter: {
        version: build.version,
        pages: shots.length,
        files: outFiles.length,
        placeholders: shots.reduce((n, s) => n + s.placeholders.length, 0),
        ...(stageOptions ? { stage: stageOptions.stage, built: [...fresh], comingSoon: unbuiltPages.length } : {}),
        // Crawl-% per-page photos (rule d): which old page each built page took its photos from, so the team can spot a bad match. The rest used the shared home photos.
        ...(pagePhotos.source.size ? { pagePhotos: [...pagePhotos.source].map(([slug, s]) => ({ slug: slug || "home", from: s.oldPath, reason: s.reason })) } : {}),
      },
      ipAddress: null,
      userAgent: null,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

export async function markSiteBuildFailed(buildId: string, message: string): Promise<void> {
  await getDb().update(siteBuild).set({ status: "failed", step: null, failureReason: message, finishedAt: new Date() }).where(eq(siteBuild.id, buildId));
}


/* The sources of the build a page fix was made on, with the fixed page and shared parts swapped in. */
async function fixSources(projectId: string, fixId: string) {
  const db = getDb();
  const storage = getStorage();
  const [fix] = await db.select().from(pageFix).where(eq(pageFix.id, fixId)).limit(1);
  if (!fix?.afterKey) throw new SiteBuildError("The fix has no changed page to put in.");
  const prefix = `${projectStoragePrefix(projectId)}site/v${fix.baseVersion}/_source/`;
  const partsFile = fix.partsKey ? await storage.get(fix.partsKey) : await storage.get(`${prefix}parts.json`);
  if (!partsFile) throw new SiteBuildError("The build the fix was made on has no saved sources. Build the whole site again instead.");
  const mains = new Map<string, string>();
  for (const key of await storage.list(`${prefix}pages/`)) {
    const body = await storage.get(key);
    if (body) mains.set(key.slice(`${prefix}pages/`.length).replace(/\.html$/, ""), body.toString("utf8"));
  }
  const after = await storage.get(fix.afterKey);
  if (!after) throw new SiteBuildError("The fixed page is missing from storage. Try Fix these again.");
  mains.set(fix.slug, after.toString("utf8"));
  return { parts: JSON.parse(partsFile.toString("utf8")) as { header: string; footer: string }, mains, staged: Boolean(await storage.get(`${prefix}unbuilt.json`)) };
}

/* The sources of the build an edit was made on, with the edited pages swapped in. */
async function editSources(projectId: string, requestId: string) {
  const db = getDb();
  const storage = getStorage();
  const [request] = await db.select().from(editRequest).where(eq(editRequest.id, requestId)).limit(1);
  if (!request?.baseBuildId) throw new SiteBuildError("The edit request has no build to start from.");
  const [base] = await db.select().from(siteBuild).where(eq(siteBuild.id, request.baseBuildId)).limit(1);
  if (!base) throw new SiteBuildError("The build the edit was made on is gone. Build the whole site again instead.");
  const prefix = `${projectStoragePrefix(projectId)}site/v${base.version}/_source/`;
  const partsFile = await storage.get(`${prefix}parts.json`);
  if (!partsFile) throw new SiteBuildError("The build the edit was made on has no saved sources. Build the whole site again instead.");
  const mains = new Map<string, string>();
  for (const key of await storage.list(`${prefix}pages/`)) {
    const body = await storage.get(key);
    if (body) mains.set(key.slice(`${prefix}pages/`.length).replace(/\.html$/, ""), body.toString("utf8"));
  }
  for (const page of await db.select().from(editPage).where(eq(editPage.requestId, requestId))) {
    const after = await storage.get(page.afterKey);
    if (after) mains.set(page.slug || "home", after.toString("utf8"));
  }
  return { parts: JSON.parse(partsFile.toString("utf8")) as { header: string; footer: string }, mains, staged: Boolean(await storage.get(`${prefix}unbuilt.json`)) };
}

/*
  What a stage starts from (staged builds, 6 October 2026): the newest
  finished version's saved header and footer and pages. None before the
  first stage.
*/
async function stageSources(projectId: string, version: number) {
  const db = getDb();
  const storage = getStorage();
  const [base] = await db
    .select({ version: siteBuild.version })
    .from(siteBuild)
    .where(and(eq(siteBuild.projectId, projectId), eq(siteBuild.status, "done"), lt(siteBuild.version, version)))
    .orderBy(desc(siteBuild.version))
    .limit(1);
  const mains = new Map<string, string>();
  if (!base) return { parts: null, mains };
  const prefix = `${projectStoragePrefix(projectId)}site/v${base.version}/_source/`;
  const partsFile = await storage.get(`${prefix}parts.json`);
  for (const key of await storage.list(`${prefix}pages/`)) {
    const body = await storage.get(key);
    if (body) mains.set(key.slice(`${prefix}pages/`.length).replace(/\.html$/, ""), body.toString("utf8"));
  }
  return { parts: partsFile ? (JSON.parse(partsFile.toString("utf8")) as { header: string; footer: string }) : null, mains };
}

/*
  Build A, 8c: one edit request, made page by page on the live build's own
  source. Each page is one AI call with the builder's usual system prompt
  (cached); its before and after are kept in R2 for the tracked changes.
*/
export async function runSiteEditJob(job: SiteEditJobData, config: WorkerConfig, client: Anthropic, browser: Browser): Promise<void> {
  const db = getDb();
  const storage = getStorage();
  const [request] = await db.select().from(editRequest).where(eq(editRequest.id, job.requestId)).limit(1);
  if (!request || request.status !== "queued") return;
  await db.update(editRequest).set({ status: "editing" }).where(eq(editRequest.id, request.id));
  const [base] = await db.select().from(siteBuild).where(eq(siteBuild.id, request.baseBuildId ?? "")).limit(1);
  if (!base) throw new SiteBuildError("There is no finished build to edit.");

  const { system, plan } = await siteContext(browser, config, request.projectId, request.id);
  const pages = await db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, request.projectId));
  const sourcePrefix = `${projectStoragePrefix(request.projectId)}site/v${base.version}/_source/pages/`;
  const editPrefix = `${projectStoragePrefix(request.projectId)}edits/${request.id}/`;
  await db.delete(editPage).where(eq(editPage.requestId, request.id));

  for (const pageId of request.pageIds) {
    const page = pages.find((p) => p.id === pageId);
    if (!page) continue;
    const file = page.slug || "home";
    const before = (await storage.get(`${sourcePrefix}${file}.html`))?.toString("utf8");
    if (!before) throw new SiteBuildError(`${page.name} isn't in the live build. Build the whole site again first.`);
    const asked = await ask(
      client,
      config,
      system,
      buildEditPrompt({ page: { name: page.name, kind: page.kind, slug: page.slug }, currentMain: before, clientWords: request.clientWords, teamNote: request.teamNote, pages: plan }),
      readPageReply,
      { projectId: request.projectId, runId: request.id, startedByUserId: request.createdByUserId, step: "site_edit", label: page.name },
    );
    // The model writes the whole <main> back and may drop the mark that says the page is kept; put it back by code, or the next build would rewrite every word.
    const after = restampKept(before, asked);
    const beforeKey = `${editPrefix}${file}.before.html`;
    const afterKey = `${editPrefix}${file}.after.html`;
    await storage.put(beforeKey, Buffer.from(before, "utf8"), "text/html; charset=utf-8");
    await storage.put(afterKey, Buffer.from(after, "utf8"), "text/html; charset=utf-8");
    const changes = trackedChanges(before, after);
    await db.insert(editPage).values({
      requestId: request.id,
      projectId: request.projectId,
      pageId: page.id,
      name: page.name,
      slug: page.slug,
      beforeKey,
      afterKey,
      changed: changes.added.length + changes.removed.length > 0,
    });
  }
  await db.update(editRequest).set({ status: "edited" }).where(eq(editRequest.id, request.id));
  await recordActivity(db, {
    action: "site.edit_made",
    entityType: "project",
    entityId: request.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { request: request.clientWords.slice(0, 300), pages: request.pageIds.length },
    ipAddress: null,
    userAgent: null,
  });
}

export async function markSiteEditFailed(requestId: string, message: string): Promise<void> {
  await getDb().update(editRequest).set({ status: "failed", failureReason: message }).where(eq(editRequest.id, requestId));
}
