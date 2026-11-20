import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import type { Database } from "../../db";
import { clientDecision, concept, intakePrefill, pageComment, pageDraft, pagePlanPage, project, siteImport } from "../../db/schema";
import { HTML_HOMEPAGE_CONCEPT } from "../mockups/directions";
import { actorFields, recordActivity } from "../activity";
import { loadIntake, lockIntakeForFills, saveIntakeSection } from "../intake/service";
import { getStorage, type FileStorage } from "../intake/storage";
import { approvedMockupVersion } from "../mockups/approved";
import { extractDesignSystem } from "./build";
import { readHtmlMockup } from "./html-mockup";
import { visibleWordsLine } from "./kept-page";
import { headerNavLinks, type NavLink } from "./supplied-nav";
import { PREFILL_LABELS, type PrefillKey } from "../intake/prefill-fields";
import { prefillValueAt, sectionOfPrefill, withPrefill, type PrefillFieldKey } from "../intake/prefill";
import { SITE_WORDS_MODES, hasCurrentWebsite, projectTypeOf, type ProjectType } from "../intake/project-type";
import { SYSTEM_ACTOR, type Viewer } from "../permissions";
import type { CurrentSiteResult, SiteHome } from "../mockups/current-site";
import { botCheckMessage, savedWordsBotCheck } from "./bot-check";
import { gapPlaceholder, archiveDate, slugFromPath, hostOf } from "./site-import";
import type { ImportedPageSummary, KeptPageFile } from "./site-import-seo";
import { planSitePrefill } from "./site-prefill";

/*
  One read of the current site (Jason, 7 October 2026;
  docs/plans/flow-a-one-read.md): what the worker and the web app share
  about it. The home page as the browser saw it, the intake answers the
  site proves (filled only when empty), and, for "Keep all content as is",
  the page plan made from the site's pages by itself.

  Nothing the team did is ever wiped: a plan that came from the read is
  only added to (new pages) and refreshed where a kept page is untouched; a
  plan made some other way is replaced only when no page has any work.
  Otherwise the team decides once, on Content.
*/

type Db = Database;
type ReadRow = typeof siteImport.$inferSelect;

export const KEPT_SOURCE = "kept";
export const KEPT_LABEL = "From the current site (kept as is)";

/*
  Whether a page's words are still the current site's (0.100.0, found in
  the project-type plan): walk back from the newest version through hand
  edits; kept when that reaches a kept version before any AI version (a
  draft, a redraft or an improvement). A page once kept and later
  rewritten by AI is no longer held to the kept words.
*/
export function isKeptLineage(versions: { version: number; source: string }[]): boolean {
  for (const v of [...versions].sort((a, b) => b.version - a.version)) {
    if (v.source === KEPT_SOURCE) return true;
    if (v.source !== "edit") return false;
  }
  return false;
}

/*
  Whether a page's words are ready for the build: its newest version
  approved on Content; or, on Design only (0.100.0, no Content step), its
  newest words still the current site's, which need no approval (the
  client's own words, checked word for word after the build).
*/
export function pageReadyForBuild(versions: { version: number; source: string; approvedAt: Date | null; body: string | null }[], designOnly: boolean): boolean {
  const latest = [...versions].sort((a, b) => b.version - a.version)[0];
  if (!latest?.body) return false;
  if (latest.approvedAt) return true;
  // A page the read couldn't give is only its heading and a placeholder: it needs its words first (Fable's review L6).
  return designOnly && isKeptLineage(versions) && !onlyPlaceholder(latest.body);
}

/*
  Is the mockup the client approved a homepage the team supplied as an HTML
  file (16 November 2026)? Then Build A keeps that page's own words as the
  home page and never reads the home page's drafted copy (site-build.ts), so
  Content does not ask for that copy to be approved: nobody should write and
  approve words that are thrown away. The other pages are unchanged.
*/
export async function usesSuppliedHome(db: Db, projectId: string): Promise<boolean> {
  const [decision] = await db
    .select({ conceptId: clientDecision.conceptId })
    .from(clientDecision)
    .where(and(eq(clientDecision.projectId, projectId), eq(clientDecision.changesRequested, false)))
    .orderBy(desc(clientDecision.createdAt))
    .limit(1);
  if (!decision) return false;
  const [picked] = await db.select({ direction: concept.direction }).from(concept).where(eq(concept.id, decision.conceptId)).limit(1);
  return picked?.direction === HTML_HOMEPAGE_CONCEPT;
}

/*
  The built file that holds the supplied home page ("index.html" for the
  home page; a home page with a slug has its own folder), or null when the
  client did not approve a supplied homepage or the plan has no Home page.
  The go-live checks name this file, and only this file, as the one whose own
  words back themselves (publish.ts); it is worked out from the approval and
  the plan, never from a mark a page could carry itself.
*/
export async function suppliedHomeFile(db: Db, projectId: string): Promise<string | null> {
  if (!(await usesSuppliedHome(db, projectId))) return null;
  const [home] = await db.select({ slug: pagePlanPage.slug }).from(pagePlanPage).where(and(eq(pagePlanPage.projectId, projectId), eq(pagePlanPage.kind, "home"))).limit(1);
  if (!home) return null;
  return home.slug ? `${home.slug}/index.html` : "index.html";
}

/*
  The words the approved supplied homepage was SUPPLIED with: the visible
  words of the sections between its header and footer (the part kept as the
  home page's <main>), read from the file the team uploaded and TAWD stored
  at import (original.html beside the concept version), never from the built
  site. Null when the client did not approve a supplied homepage or the
  stored upload cannot be found: then nothing is backed (the safe way round).

  Why this source: it is written once, by the import, and no later step
  touches it (an AI edit, a "Fix these" round, a logo swap and a rebuild all
  write other files), so it is the same at go-live as on the day it was
  uploaded, and it is the only thing a person actually wrote and approved.
  The built page cannot be used: an edit request can have the AI add words
  to it and they carry the kept mark too. The newest version at or below the
  approved one that has an original.html is used, because a logo swap makes a
  later version with none of its own. The sections are found the way the
  build finds them (extractDesignSystem), so these are exactly the words that
  were kept.
*/
export async function suppliedHomeWords(db: Db, projectId: string, storage: FileStorage = getStorage()): Promise<string | null> {
  if (!(await usesSuppliedHome(db, projectId))) return null;
  const approved = await approvedMockupVersion(db, projectId);
  if (!approved?.version.htmlKey) return null;
  const match = /^(.*\/concepts\/[^/]+)\/v\d+\/page\.html$/.exec(approved.version.htmlKey);
  if (!match) return null;
  for (let n = approved.version.version; n >= 1; n -= 1) {
    const original = await storage.get(`${match[1]}/v${n}/original.html`);
    if (!original) continue;
    const design = extractDesignSystem(readHtmlMockup(original.toString("utf8")).html);
    return design.sections.length ? visibleWordsLine(design.sections.join("\n")) : null;
  }
  return null;
}

/*
  The menu of the approved supplied homepage, in the order it is written
  (Jason, 17 November 2026). The page plan is made from it: the design the
  client approved says what pages the site has. Read from the file the team
  uploaded and TAWD stored at import, for the same reason the supplied words
  are: it is the only thing a person actually wrote and approved, and no
  later step writes to it. Null when the client approved something else, or
  the stored upload cannot be found; an empty list when the design has no
  menu, which leaves the plan as it was.
*/
export async function suppliedHomeNav(db: Db, projectId: string, storage: FileStorage = getStorage()): Promise<NavLink[] | null> {
  if (!(await usesSuppliedHome(db, projectId))) return null;
  const approved = await approvedMockupVersion(db, projectId);
  if (!approved?.version.htmlKey) return null;
  const match = /^(.*\/concepts\/[^/]+)\/v\d+\/page\.html$/.exec(approved.version.htmlKey);
  if (!match) return null;
  for (let n = approved.version.version; n >= 1; n -= 1) {
    const original = await storage.get(`${match[1]}/v${n}/original.html`);
    if (!original) continue;
    try {
      return headerNavLinks(extractDesignSystem(readHtmlMockup(original.toString("utf8")).html).header);
    } catch {
      // A design this reader cannot split into bands throws, and it must not take the page plan down with it: the plan is then made the ordinary way.
      return [];
    }
  }
  return null;
}

/*
  The client's own current-site words the project keeps, as one text (batch
  B review, H2): every page whose newest words are still the kept ones and
  are ready for the build (approved on Content, or Design only). The fact
  and claim checks count them as the client's words, so the real facts in
  kept copy are not reported as invented.
*/
export async function keptWordsFor(db: Db, projectId: string): Promise<string> {
  const designOnly = (await projectTypeFor(db, projectId)) === "design_only";
  const pages = await db.select({ id: pagePlanPage.id }).from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId));
  const out: string[] = [];
  for (const page of pages) {
    const versions = await db.select({ version: pageDraft.version, source: pageDraft.source, approvedAt: pageDraft.approvedAt, body: pageDraft.body }).from(pageDraft).where(eq(pageDraft.pageId, page.id));
    const latest = [...versions].sort((a, b) => b.version - a.version)[0];
    if (latest?.body && isKeptLineage(versions) && pageReadyForBuild(versions, designOnly)) out.push(latest.body);
  }
  return out.join(" . ");
}

/* A page with no words of its own: its H1 and [PLACEHOLDER]s only. */
export function onlyPlaceholder(body: string): boolean {
  return body.replace(/^#\s.*$/m, "").replace(/\[PLACEHOLDER:[^\]]*\]/gi, "").trim().length === 0;
}

/** A read with no step for this long was cut off (a worker restart): measured from the worker's heartbeat. */
export const READ_STALE_MS = 20 * 60_000;

/*
  A done read's last step (0.97.0): the worker fills the intake and makes the
  page plan after saving the pages, so the Intake panel keeps refreshing
  while this step is set (for at most AFTER_STEP_MS after the read finished:
  a worker stopped mid-way doesn't keep the page refreshing).
*/
export const AFTER_STEP = "Filling the intake and making the page plan";
export const AFTER_STEP_MS = 3 * 60_000;

/* A queued or working read whose last sign of life is too old. */
export function readIsStale(row: Pick<ReadRow, "status" | "heartbeatAt" | "createdAt">, at = Date.now()): boolean {
  if (row.status !== "queued" && row.status !== "working") return false;
  return at - (row.heartbeatAt ?? row.createdAt).getTime() > READ_STALE_MS;
}

/* A read saved before TAWD spotted bot checks that kept a host's check page as the site: its reason, or null. */
export function savedImportBotCheck(row: Pick<ReadRow, "status" | "pages" | "url">): string | null {
  if (row.status !== "done") return null;
  const pages = row.pages as ImportedPageSummary[];
  if (pages.length !== 1) return null;
  const page = pages[0]!;
  const check = savedWordsBotCheck(page.title, [...(page.h1s ?? []), ...(page.headings ?? []).map((h) => h.text)]);
  return check ? botCheckMessage(row.url, check) : null;
}

/* ---------- the home page ---------- */

/* The row's home page, when it's the site's real words (a host's check saved as words before 6 October 2026 is never used). */
export function homeOfRow(row: Pick<ReadRow, "home"> | null | undefined): SiteHome | null {
  const home = (row?.home as SiteHome | null) ?? null;
  if (!home || !Array.isArray(home.sections) || home.sections.length === 0) return null;
  if (savedWordsBotCheck(home.title, home.sections.map((s) => s.words))) return null;
  return home;
}

/* The current site's home page for a project (Design's Home words, the worker's prompt), or null. */
export async function siteReadHome(db: Db, projectId: string): Promise<CurrentSiteResult | null> {
  const [row] = await db.select({ home: siteImport.home }).from(siteImport).where(eq(siteImport.projectId, projectId)).limit(1);
  return homeOfRow(row);
}

/* ---------- filling empty intake answers ---------- */

export interface SitePrefillResult {
  filled: { key: PrefillKey; label: string; value: string }[];
}

const valueText = (value: unknown): string => (Array.isArray(value) ? value.map((v) => (typeof v === "object" && v && "name" in v ? String((v as { name: string }).name) : String(v))).join(", ") : String(value));

/*
  After a read: the empty answers the site proves are filled, as the
  system, each marked "From the current site" until the team confirms or
  corrects it. The intake is loaded again just before the save, so a field
  filled by the team meanwhile is left alone. One activity entry.
*/
export async function applySitePrefill(db: Db, projectId: string, pages: ImportedPageSummary[], siteUrl: string): Promise<SitePrefillResult> {
  /*
    The team's save wins (Fable's review M8): the intake is locked
    (lockIntakeForFills) and loaded again inside one transaction, so the
    empty fields are judged on what is saved at that moment and a person's
    save can't be overwritten by an older copy.
  */
  return db.transaction(async (txn) => {
    const tx = txn as unknown as Db;
    await lockIntakeForFills(tx, projectId);
    const intake = await loadIntake(tx, SYSTEM_ACTOR, projectId);
    if (!intake) return { filled: [] };
    const marks = await tx.select({ fieldKey: intakePrefill.fieldKey, status: intakePrefill.status }).from(intakePrefill).where(eq(intakePrefill.projectId, projectId));
    const corrected = new Set(marks.filter((m) => m.status === "corrected").map((m) => m.fieldKey));
    // #1b: the home page's own words, for the warranty, offer and financing facts (never a bot-check page).
    const [siteRow] = await tx.select({ home: siteImport.home }).from(siteImport).where(eq(siteImport.projectId, projectId)).limit(1);
    const plan = planSitePrefill(intake.data, pages, corrected, homeOfRow(siteRow ?? null));
    if (plan.fill.length === 0) return { filled: [] };
    let data = intake.data;
    for (const proposal of plan.fill) data = withPrefill(data, proposal.key as PrefillFieldKey, proposal.value, () => crypto.randomUUID(), { setMainService: false });
    const ctx = { db: tx, ipAddress: null, userAgent: null };
    for (const section of [...new Set(plan.fill.map((p) => sectionOfPrefill(p.key as PrefillFieldKey)))]) {
      await saveIntakeSection(ctx, SYSTEM_ACTOR, projectId, section, data[section]);
    }
    const filled: SitePrefillResult["filled"] = [];
    for (const proposal of plan.fill) {
      const value = prefillValueAt(data, proposal.key as PrefillFieldKey);
      await tx
        .insert(intakePrefill)
        .values({ projectId, fieldKey: proposal.key, value, source: proposal.from, origin: "site", status: "pending", filledByUserId: null, filledAt: sql`clock_timestamp()` })
        .onConflictDoUpdate({
          target: [intakePrefill.projectId, intakePrefill.fieldKey],
          // clock_timestamp (latestPrefillStamp says why).
          set: { value, source: proposal.from, origin: "site", status: "pending", filledByUserId: null, filledAt: sql`clock_timestamp()`, resolvedByUserId: null, resolvedAt: null },
        });
      filled.push({ key: proposal.key, label: PREFILL_LABELS[proposal.key], value: valueText(value) });
    }
    await recordActivity(tx, {
      action: "intake.prefilled_from_site",
      entityType: "project",
      entityId: projectId,
      ...actorFields(SYSTEM_ACTOR),
      valueAfter: { url: siteUrl, filled: filled.map((f) => `${f.label}: ${f.value}`) },
      ipAddress: null,
      userAgent: null,
    });
    return { filled };
  });
}

/* ---------- "Keep all content as is": the page plan makes itself ---------- */

export interface KeptPlanNote {
  /** made: the plan is the site's pages; merged: added to a plan from an earlier read; needs_decision: a plan not from the read; missing: the read's files are gone; failed: making the plan stopped (message says why; the next look tries again). */
  status: "made" | "merged" | "needs_decision" | "missing" | "failed";
  /** failed: what went wrong. */
  message?: string;
  at: string;
  added: string[];
  updated: string[];
  /** Kept pages the team has worked on whose words changed on the site since (left as they are). */
  changed: string[];
  /** Kept pages no longer on the current site (left in the plan). */
  gone: string[];
  /** needs_decision: what replacing the plan would delete. */
  decision: PlanWork | null;
}

export interface PlanWork {
  pages: number;
  /** Plan pages a person edited (their row changed after it was made). */
  edited: number;
  approved: number;
  drafted: number;
  commented: number;
}

/*
  A makeover keeps the current site's blog articles on top of the tier's
  page limit, up to this many (Jason, 7 October 2026, 0.98.0: Finley had
  18 articles over Pro's 50). Read by code (cents through a paid route),
  and built by code after the first (site-build.ts), so they cost next to
  nothing. Whether they're charged is the founders' call; the Content card
  says how many were kept.
*/
export const KEPT_ARTICLE_LIMIT = 100;

/* The project's type (0.100.0, intake/project-type.ts), from its lane and intake. */
export async function projectTypeFor(db: Db, projectId: string): Promise<ProjectType | null> {
  const [proj] = await db.select({ lane: project.lane }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!proj) return null;
  const intake = await loadIntake(db, SYSTEM_ACTOR, projectId);
  if (!intake) return null;
  return projectTypeOf({ lane: proj.lane, mode: intake.data.content.mode, hasCurrentWebsite: hasCurrentWebsite(intake.data.website) });
}

/* A project built from the current site's pages (Lane 1, Design only or Design + content, a current website): the address; null otherwise. */
export async function keepSiteUrl(db: Db, projectId: string): Promise<string | null> {
  const [proj] = await db.select({ lane: project.lane }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!proj || proj.lane === "lane_2") return null;
  const intake = await loadIntake(db, SYSTEM_ACTOR, projectId);
  const url = intake?.data.website.noCurrentWebsite ? "" : (intake?.data.website.currentWebsiteUrl ?? "").trim();
  return SITE_WORDS_MODES.includes(intake?.data.content.mode ?? "") && url ? url : null;
}

/* The work in a page plan that replacing it would delete. */
export async function planWork(db: Db, projectId: string): Promise<PlanWork> {
  const pages = await db.select({ id: pagePlanPage.id, createdAt: pagePlanPage.createdAt, updatedAt: pagePlanPage.updatedAt }).from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId));
  if (pages.length === 0) return { pages: 0, edited: 0, approved: 0, drafted: 0, commented: 0 };
  const drafts = await db.select({ pageId: pageDraft.pageId, source: pageDraft.source, approvedAt: pageDraft.approvedAt }).from(pageDraft).where(eq(pageDraft.projectId, projectId));
  const comments = await db.select({ pageId: pageComment.pageId }).from(pageComment).where(eq(pageComment.projectId, projectId));
  return {
    pages: pages.length,
    edited: pages.filter((p) => p.updatedAt.getTime() - p.createdAt.getTime() > 1_000).length,
    approved: new Set(drafts.filter((d) => d.approvedAt).map((d) => d.pageId)).size,
    drafted: new Set(drafts.filter((d) => d.source !== KEPT_SOURCE).map((d) => d.pageId)).size,
    commented: new Set(comments.map((c) => c.pageId)).size,
  };
}

/* "This deletes 4 approved pages and 2 drafted ones." */
export function workWords(w: PlanWork): string {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const parts = [
    w.approved ? n(w.approved, "approved page", "approved pages") : null,
    w.drafted ? n(w.drafted, "drafted or edited page", "drafted or edited pages") : null,
    w.commented ? n(w.commented, "page with comments", "pages with comments") : null,
    w.edited ? n(w.edited, "page edited by hand", "pages edited by hand") : null,
  ].filter(Boolean);
  const plan = `It replaces the current page plan (${n(w.pages, "page", "pages")}).`;
  return parts.length ? `${plan} This deletes ${parts.join(", ")}.` : plan;
}

/* A page nothing could read: its heading and the placeholder for its words. */
function gapFile(summary: ImportedPageSummary): KeptPageFile & { gap: true } {
  return { url: summary.url, path: summary.path, kind: summary.kind, name: summary.name, title: "", metaDescription: "", h1: "", markdown: `# ${summary.name}\n\n${gapPlaceholder(summary.path)}\n`, notes: [], hadForm: false, images: [], gap: true };
}

/* The kept draft's note: where its words came from. */
export function keptNote(f: KeptPageFile & { gap?: boolean }): string {
  if (f.gap) return `Not read from the current site (${f.url}): the live site blocks TAWD and no other source had it. Paste the page's words or remove the page.`;
  const copy = f.readFrom === "archive" && f.snapshotAt ? `. ${archiveNote(f.snapshotAt)}` : f.readFrom === "fallback" && f.snapshotAt ? `. From a copy of ${archiveDate(f.snapshotAt)}: check prices, hours and service areas.` : "";
  return `${KEPT_LABEL}: ${f.url}${copy}${f.notes.length ? `. ${f.notes.join(" ")}` : ""}`;
}

/* Shown beside the kept label for a page 0.94.0 read from the Internet Archive (its drafts keep saying so). */
export function archiveNote(snapshotAt: string): string {
  return `From the Internet Archive's copy of ${archiveDate(snapshotAt)}: check prices, hours and service areas.`;
}

/* The read's kept pages from storage, home first, the rest as read. null: a file is missing (read again). */
async function keptFiles(row: ReadRow): Promise<(KeptPageFile & { gap?: boolean })[] | null> {
  const storage = getStorage();
  const files: (KeptPageFile & { gap?: boolean })[] = [];
  for (const summary of row.pages as ImportedPageSummary[]) {
    if (summary.gap) {
      files.push(gapFile(summary));
      continue;
    }
    const object = await storage.get(summary.key);
    if (!object) return null;
    files.push(JSON.parse(object.toString("utf8")) as KeptPageFile);
  }
  return [...files].sort((a, b) => (a.kind === "home" ? -1 : b.kind === "home" ? 1 : 0));
}

const slugOf = (f: Pick<KeptPageFile, "kind" | "path">) => (f.kind === "home" ? "" : slugFromPath(f.path));

/* The plan becomes the read's pages: each page's words its version 1. Replaces whatever plan there is. */
async function makeKeptPlan(outer: Db, row: ReadRow, files: (KeptPageFile & { gap?: boolean })[], actor: Viewer, auto: boolean, context: { ipAddress: string | null; userAgent: string | null }): Promise<void> {
  // All or nothing (0.97.0): a plan half made would look like the team's own work and ask for a decision.
  await outer.transaction(async (tx) => {
    const db = tx as unknown as Db;
    const blog = files.find((f) => f.kind === "blog");
    const before = await db.select({ name: pagePlanPage.name }).from(pagePlanPage).where(eq(pagePlanPage.projectId, row.projectId));
    await db.delete(pagePlanPage).where(eq(pagePlanPage.projectId, row.projectId));
    const inserted = await db
      .insert(pagePlanPage)
      .values(
        files.map((f, position) => ({
          projectId: row.projectId,
          position,
          kind: f.kind,
          name: f.name.slice(0, 80),
          slug: slugOf(f),
          mainKeyword: "",
          supportingKeywords: [],
          title: f.title.slice(0, 120),
          metaDescription: f.metaDescription.slice(0, 320),
          h1: f.h1.slice(0, 120),
          parentSlug: f.kind === "article" && blog ? slugFromPath(blog.path) : null,
        })),
      )
      .returning({ id: pagePlanPage.id });
    const at = new Date();
    await db.insert(pageDraft).values(
      files.map((f, i) => ({ projectId: row.projectId, pageId: inserted[i]!.id, version: 1, source: KEPT_SOURCE, status: "done", body: f.markdown, note: keptNote(f).slice(0, 2000), createdByUserId: auto ? null : actor.id, finishedAt: at })),
    );
    const note: KeptPlanNote = { status: "made", at: at.toISOString(), added: [], updated: [], changed: [], gone: [], decision: null };
    await db.update(siteImport).set({ usedAt: at, usedByUserId: auto ? null : actor.id, keptPlan: note }).where(eq(siteImport.id, row.id));
    const gaps = files.filter((f) => f.gap).map((f) => f.path);
    await recordActivity(db, {
      action: "content.site_import_used",
      entityType: "project",
      entityId: row.projectId,
      ...actorFields(actor),
      valueBefore: before.length ? { pages: before.map((p) => p.name) } : null,
      valueAfter: { url: row.url, pages: files.map((f) => f.name), version: 1, source: KEPT_LABEL, ...(auto ? { auto: true } : {}), ...(gaps.length ? { gaps } : {}) },
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
  });
  });
}

/*
  A plan from an earlier read of this site: new pages added, untouched kept pages refreshed, nothing deleted. In one transaction
  (13 October 2026, the whole-code review): a failure part-way leaves the plan as it was, never half its new pages.
*/
async function mergeKeptPlan(db: Db, row: ReadRow, files: (KeptPageFile & { gap?: boolean })[]): Promise<KeptPlanNote> {
  return db.transaction(async (tx) => mergeKeptPlanIn(tx as unknown as Db, row, files));
}

async function mergeKeptPlanIn(db: Db, row: ReadRow, files: (KeptPageFile & { gap?: boolean })[]): Promise<KeptPlanNote> {
  const pages = await db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, row.projectId)).orderBy(asc(pagePlanPage.position));
  const drafts = pages.length ? await db.select().from(pageDraft).where(inArray(pageDraft.pageId, pages.map((p) => p.id))).orderBy(desc(pageDraft.version)) : [];
  const open = new Set((await db.select({ pageId: pageComment.pageId }).from(pageComment).where(and(eq(pageComment.projectId, row.projectId), isNull(pageComment.resolvedAt)))).map((c) => c.pageId));
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const at = new Date();
  const note: KeptPlanNote = { status: "merged", at: at.toISOString(), added: [], updated: [], changed: [], gone: [], decision: null };
  let position = pages.reduce((n, p) => Math.max(n, p.position), -1);
  const blog = files.find((f) => f.kind === "blog");
  for (const f of files) {
    const page = bySlug.get(slugOf(f));
    if (!page) {
      const [added] = await db
        .insert(pagePlanPage)
        .values({ projectId: row.projectId, position: ++position, kind: f.kind, name: f.name.slice(0, 80), slug: slugOf(f), mainKeyword: "", supportingKeywords: [], title: f.title.slice(0, 120), metaDescription: f.metaDescription.slice(0, 320), h1: f.h1.slice(0, 120), parentSlug: f.kind === "article" && blog ? slugFromPath(blog.path) : null })
        .returning({ id: pagePlanPage.id });
      await db.insert(pageDraft).values({ projectId: row.projectId, pageId: added!.id, version: 1, source: KEPT_SOURCE, status: "done", body: f.markdown, note: keptNote(f).slice(0, 2000), createdByUserId: null, finishedAt: at });
      note.added.push(f.name);
      continue;
    }
    if (f.gap) continue;
    const own = drafts.filter((d) => d.pageId === page.id);
    const latest = own[0];
    const lastKept = own.find((d) => d.source === KEPT_SOURCE);
    if (!lastKept || (lastKept.body ?? "") === f.markdown) continue;
    const untouched = latest && latest.id === lastKept.id && latest.status === "done" && !latest.approvedAt && !open.has(page.id);
    if (untouched) {
      await db.insert(pageDraft).values({ projectId: row.projectId, pageId: page.id, version: latest.version + 1, source: KEPT_SOURCE, status: "done", body: f.markdown, note: keptNote(f).slice(0, 2000), createdByUserId: null, finishedAt: at });
      note.updated.push(page.name);
    } else {
      note.changed.push(page.name);
    }
  }
  const siteSlugs = new Set(files.map(slugOf));
  for (const page of pages) {
    if (!siteSlugs.has(page.slug) && drafts.some((d) => d.pageId === page.id && d.source === KEPT_SOURCE)) note.gone.push(page.name);
  }
  return note;
}

/* How long a claim on the plan holds before another caller may take over (a worker restart mid-way). */
export const PLAN_CLAIM_MS = 5 * 60_000;

/*
  Single-flight (Fable's review H1): the worker and a page render can both
  reach syncKeptPlan for the same read. Only the caller that claims the row
  (kept_plan_claimed_at empty, or older than PLAN_CLAIM_MS) makes or
  updates the plan; the others do nothing and the next render shows the
  result. Released when done, whatever happened.
*/
async function withPlanClaim<T>(db: Db, rowId: string, fn: () => Promise<T>): Promise<T | null> {
  const now = new Date();
  const claimed = await db
    .update(siteImport)
    .set({ keptPlanClaimedAt: now })
    .where(and(eq(siteImport.id, rowId), or(isNull(siteImport.keptPlanClaimedAt), lt(siteImport.keptPlanClaimedAt, new Date(now.getTime() - PLAN_CLAIM_MS)))))
    .returning({ id: siteImport.id });
  if (claimed.length === 0) return null;
  try {
    return await fn();
  } finally {
    await db.update(siteImport).set({ keptPlanClaimedAt: null }).where(eq(siteImport.id, rowId));
  }
}

const noteOf = (status: KeptPlanNote["status"], decision: PlanWork | null = null): KeptPlanNote => ({ status, at: new Date().toISOString(), added: [], updated: [], changed: [], gone: [], decision });

/*
  Run by the worker when a keep project's read finishes, and by the web
  app when the content choice is saved as keep with a done read (or when
  Content or Design opens and the plan hasn't been made yet). Returns what
  it did, or null when there's nothing to do (not a keep project, the read
  isn't done, it found no pages, or another caller is on it).

  No plan yet: the site's pages become the plan. A plan from this read: new
  pages added, untouched kept pages refreshed. Any other plan (made with
  Make the page plan, shaped by hand, from another address) is never
  replaced by code: the team decides once on Content (Fable's review M4).
*/
export async function syncKeptPlan(db: Db, projectId: string): Promise<KeptPlanNote | null> {
  if (!(await keepSiteUrl(db, projectId))) return null;
  const [row] = await db.select().from(siteImport).where(eq(siteImport.projectId, projectId)).limit(1);
  if (!row || row.status !== "done" || savedImportBotCheck(row)) return null;
  const summaries = row.pages as ImportedPageSummary[];
  if (!summaries.some((p) => !p.gap)) return null;
  return withPlanClaim(db, row.id, async () => {
    try {
      return await syncClaimed(db, projectId, row);
    } catch (error) {
      // Said on Intake and the Next step card instead of "reading" forever (0.97.0); the next look tries again.
      const message = error instanceof Error ? error.message : "unknown";
      console.error(`The kept page plan: ${message}`);
      const note: KeptPlanNote = { ...noteOf("failed"), message: message.slice(0, 300) };
      await db.update(siteImport).set({ keptPlan: note }).where(eq(siteImport.id, row.id));
      return note;
    }
  });
}

async function syncClaimed(db: Db, projectId: string, row: ReadRow): Promise<KeptPlanNote> {
  const [any] = await db.select({ id: pagePlanPage.id }).from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId)).limit(1);
  if (any && !row.usedAt) {
    const note = noteOf("needs_decision", await planWork(db, projectId));
    await db.update(siteImport).set({ keptPlan: note }).where(eq(siteImport.id, row.id));
    return note;
  }
  const files = await keptFiles(row);
  if (!files) {
    const note = noteOf("missing");
    await db.update(siteImport).set({ keptPlan: note }).where(eq(siteImport.id, row.id));
    return note;
  }
  if (!any) {
    await makeKeptPlan(db, row, files, SYSTEM_ACTOR, true, { ipAddress: null, userAgent: null });
    return (await db.select({ keptPlan: siteImport.keptPlan }).from(siteImport).where(eq(siteImport.id, row.id)))[0]?.keptPlan as KeptPlanNote;
  }
  const note = await mergeKeptPlan(db, row, files);
  const previous = row.keptPlan as KeptPlanNote | null;
  const changedSomething = note.added.length + note.updated.length > 0;
  await db.update(siteImport).set({ keptPlan: { ...note, status: previous?.status === "made" && !changedSomething ? "made" : "merged" } }).where(eq(siteImport.id, row.id));
  if (changedSomething) {
    await recordActivity(db, {
      action: "content.kept_plan_updated",
      entityType: "project",
      entityId: projectId,
      ...actorFields(SYSTEM_ACTOR),
      valueAfter: { url: row.url, added: note.added, updated: note.updated, changed: note.changed, gone: note.gone },
      ipAddress: null,
      userAgent: null,
    });
  }
  return note;
}

/*
  The one decision left (Content, a person with content.plan): replace a
  plan that isn't from the read with the current site's pages. The caller
  checks the permission and logs it as the person.
*/
export async function replaceWithKeptPages(db: Db, projectId: string, actor: Viewer, context: { ipAddress: string | null; userAgent: string | null }): Promise<number> {
  const [row] = await db.select().from(siteImport).where(eq(siteImport.projectId, projectId)).limit(1);
  if (!row || row.status !== "done") throw new Error("The current site's pages haven't been read yet: read it on the intake's Website section.");
  const blocked = savedImportBotCheck(row);
  if (blocked) throw new Error(`${blocked} Read again on the intake's Website section.`);
  const made = await withPlanClaim(db, row.id, async () => {
    const files = await keptFiles(row);
    if (!files || files.length === 0) throw new Error("The kept pages are missing from storage. Read the site again on the intake's Website section.");
    await makeKeptPlan(db, row, files, actor, false, context);
    return files.length;
  });
  if (made === null) throw new Error("TAWD is making the page plan from the current site right now. Look again in a moment.");
  return made;
}

/* The read's host, for comparing addresses (http/https, www and a trailing slash don't count). */
export function readHost(url: string): string {
  return hostOf(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`) ?? url.trim().toLowerCase();
}

export * from "./blocked-spend";
