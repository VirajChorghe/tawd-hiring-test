import { and, desc, eq } from "drizzle-orm";
import type { Browser } from "playwright-core";

import { actorFields, recordActivity } from "@tawd/core/activity";
import type { Database } from "@tawd/core/db";
import { getStorage, type FileStorage } from "@tawd/core/intake/storage";
import { HTML_HOMEPAGE_CONCEPT, embedAssets } from "@tawd/core/mockups";
import type { HtmlMockupImportJobData } from "@tawd/core/queue";
import { concept, conceptVersion, intakeFile, mockupRun, user as userTable } from "@tawd/core/schema";
import { KEPT_MAIN_ATTR, SiteBuildError, readHtmlMockup, type DesignSystem } from "@tawd/core/site";

import { renderConcept, type RenderResult } from "./render";

/*
  A homepage supplied as one finished HTML file (16 November 2026).

  VML builds client homepage mockups as one self-contained HTML file. Rather
  than pay a model to recover the design from a picture of it, TAWD reads the
  file (readHtmlMockup, free) and stores it exactly the way a Lane 1 concept
  version is stored (storeVersion in pipeline.ts), so the board, the client's
  approval and Build A all work unchanged:

    source.html  the page WITH image tokens: what the improvement rounds, the
                 Creative Director and the site build read
    page.html    the page with its pictures put back in, the form the client
                 is shown and the one the picture is taken of
    full.png, fold.png   the photographs, taken with Chromium as for any concept
    html-images.json + images/   the extracted pictures, kept so Build A can
                 write them as /images/<name>.<ext> (loadSuppliedHome, below)
    original.html  the file exactly as it came, for the record

  No AI and no network. It never writes a client_decision: the client's
  approval is recorded by the team on the existing screen, as for any concept.
*/

type Db = Database;

/*
  The supplied homepage's label on the board. The generated concepts are A, B
  and C and the designer's design (Lane 2, Option B) is "1", so "S" cannot
  collide with either; it files into the latest run like the designer's does,
  and a new run moves it along (startRun) so it stays on the board.
*/
export const SUPPLIED_LABEL = "S";

/* The file that says which pictures belong to a stored version, beside its page. */
export const HTML_IMAGES_FILE = "html-images.json";

export interface SuppliedImageEntry {
  token: string;
  contentType: string;
  /** Where the picture's bytes are kept. */
  key: string;
}

/** What Build A is given for a supplied homepage: its pictures, ready to be written as site files. */
export interface SuppliedHome {
  images: { token: string; path: string; bytes: Buffer }[];
}

const EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "font/woff2": "woff2",
  "font/woff": "woff",
  "font/ttf": "ttf",
  "font/otf": "otf",
};

const extensionOf = (contentType: string): string => EXTENSION[contentType] ?? "jpg";

/*
  Where a stored file goes on the built site. The page's fonts (tawd-asset:font-N,
  written into its @font-face rules) are site files too, in /fonts/, so the shared
  stylesheet's url(tawd-asset:font-N) becomes a real address on every page.
*/
export function sitePathFor(token: string, contentType: string): string {
  const name = token.replace("tawd-asset:", "");
  return `${contentType.startsWith("font/") ? "/fonts" : "/images"}/${name}.${extensionOf(contentType)}`;
}

/*
  The file's photos arrive named photo-1, photo-2 ... and so do the photos the
  CLIENT uploads to the intake. Both end up as /images/photo-1.jpg on the built
  site, so a project with both would have one overwrite the other. The
  supplied page's own pictures are therefore named photo-page-1 ... (a name
  the mockup checks already read as a photo: "photo-" then words then a number).
*/
const OWN_TOKEN = /tawd-asset:photo-(\d+)(?![A-Za-z0-9_-])/g;

export function suppliedToken(token: string): string {
  return token.replace(/^tawd-asset:photo-(\d+)$/, "tawd-asset:photo-page-$1");
}

export function renameSuppliedTokens(html: string): string {
  return html.replace(OWN_TOKEN, (_whole, n: string) => `tawd-asset:photo-page-${n}`);
}

const countPlaceholders = (html: string) => (html.match(/\[PLACEHOLDER/gi) ?? []).length;

export class HtmlMockupImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HtmlMockupImportError";
  }
}

export interface ImportDeps {
  storage?: FileStorage;
  /** The photographs. The job uses Chromium (renderConcept); a test passes a stand-in. Called with script OFF: the page is not ours. */
  render?: (browser: Browser, html: string, options: { javaScript: boolean }) => Promise<RenderResult>;
}

export async function runHtmlMockupImportJob(db: Db, browser: Browser, data: HtmlMockupImportJobData, deps: ImportDeps = {}): Promise<{ conceptId: string; version: number }> {
  const storage = deps.storage ?? getStorage();
  const render = deps.render ?? ((b: Browser, html: string, options: { javaScript: boolean }) => renderConcept(b, html, options));
  const { projectId } = data;

  const [file] = await db
    .select()
    .from(intakeFile)
    .where(and(eq(intakeFile.projectId, projectId), eq(intakeFile.kind, "homepage_html"), eq(intakeFile.status, "ready")))
    .orderBy(desc(intakeFile.createdAt))
    .limit(1);
  if (!file) throw new HtmlMockupImportError("There is no homepage HTML file to read. Upload the file first.");
  /*
    A repeat is harmless: this exact file already has its version (a second
    confirm, a double click, a job queued twice), so it is not read, rendered
    and stored again. Only "Read it again" (data.again) reads it a second time.
  */
  if (!data.again) {
    const earlier = await db
      .select({ conceptId: conceptVersion.conceptId, version: conceptVersion.version, checks: conceptVersion.checks })
      .from(conceptVersion)
      .innerJoin(concept, eq(concept.id, conceptVersion.conceptId))
      .where(and(eq(concept.projectId, projectId), eq(concept.skillId, HTML_HOMEPAGE_CONCEPT)))
      .orderBy(desc(conceptVersion.version));
    const done = earlier.find((v) => (v.checks as { fileId?: string } | null)?.fileId === file.id);
    if (done) return { conceptId: done.conceptId, version: done.version };
  }
  const bytes = await storage.get(file.storageKey);
  if (!bytes) throw new HtmlMockupImportError("The uploaded homepage file is missing from storage. Remove it on Intake, then upload it again (only one homepage file is kept at a time, so the old one has to go first).");
  const original = bytes.toString("utf8");
  // A file with no <body> has nothing to show or build from: refused here, plainly, rather than failing later in the build as "no sections".
  if (!/<body[\s>]/i.test(original)) throw new HtmlMockupImportError("The homepage file has no <body>, so there is no page in it to show. Check that it is the finished page, then remove this file and upload the right one.");

  // Free: read, clean and split into tokens plus picture files.
  const read = readHtmlMockup(original);
  const source = renameSuppliedTokens(read.html);
  // Photos and fonts are kept the same way: a file each and a line in the list (the token says which it is).
  const images = [...read.images, ...read.fonts].map((image) => ({ token: suppliedToken(image.token), contentType: image.contentType, bytes: Buffer.from(image.bytes) }));

  // The page as the client sees it: the cleaned source with its own pictures put back in.
  const finalHtml = embedAssets(
    source,
    Object.fromEntries(images.map((image) => [image.token, `data:${image.contentType};base64,${image.bytes.toString("base64")}`])),
  );
  // Script OFF: the page is a client's or a supplier's file, not ours, and nothing in it should run in the worker's Chromium (its scripts were taken out already; this is the second lock).
  const shot = await render(browser, finalHtml, { javaScript: false });

  const [supplier] = await db.select({ id: userTable.id, email: userTable.email, name: userTable.name }).from(userTable).where(eq(userTable.id, data.startedByUserId)).limit(1);

  // The run it goes in: the latest run, or one of its own (the same as the designer's design on the board).
  const [latestRun] = await db.select().from(mockupRun).where(eq(mockupRun.projectId, projectId)).orderBy(desc(mockupRun.createdAt)).limit(1);
  const runId =
    latestRun?.id ??
    (
      await db
        .insert(mockupRun)
        .values({ projectId, conceptCount: 1, status: "succeeded", startedByUserId: data.startedByUserId, model: HTML_HOMEPAGE_CONCEPT, finishedAt: new Date() })
        .returning({ id: mockupRun.id })
    )[0]!.id;

  const [existing] = await db
    .select()
    .from(concept)
    .where(and(eq(concept.projectId, projectId), eq(concept.skillId, HTML_HOMEPAGE_CONCEPT)))
    .limit(1);
  const conceptId =
    existing?.id ??
    (
      await db
        .insert(concept)
        .values({ runId, projectId, label: SUPPLIED_LABEL, direction: HTML_HOMEPAGE_CONCEPT, skillId: HTML_HOMEPAGE_CONCEPT, status: "ready" })
        .returning({ id: concept.id })
    )[0]!.id;
  if (existing && existing.runId !== runId) await db.update(concept).set({ runId, status: "ready" }).where(eq(concept.id, conceptId));

  // A second upload is a new version of the same concept, never a second concept.
  const [last] = await db.select({ version: conceptVersion.version }).from(conceptVersion).where(eq(conceptVersion.conceptId, conceptId)).orderBy(desc(conceptVersion.version)).limit(1);
  const version = (last?.version ?? 0) + 1;
  const base = `projects/${projectId}/concepts/${conceptId}/v${version}`;

  const entries: SuppliedImageEntry[] = [];
  for (const image of images) {
    const key = `${base}${sitePathFor(image.token, image.contentType)}`;
    await storage.put(key, image.bytes, image.contentType);
    entries.push({ token: image.token, contentType: image.contentType, key });
  }
  await storage.put(`${base}/${HTML_IMAGES_FILE}`, Buffer.from(JSON.stringify(entries), "utf8"), "application/json");
  await storage.put(`${base}/original.html`, bytes, "text/html");
  await storage.put(`${base}/source.html`, Buffer.from(source, "utf8"), "text/html");
  await storage.put(`${base}/page.html`, Buffer.from(finalHtml, "utf8"), "text/html");
  await storage.put(`${base}/full.png`, shot.fullPage, "image/png");
  await storage.put(`${base}/fold.png`, shot.fold, "image/png");

  const notes = [...read.removed.map((r) => `Taken out: ${r}`), ...read.warnings];
  await db.insert(conceptVersion).values({
    conceptId,
    version,
    htmlKey: `${base}/page.html`,
    pngKey: `${base}/full.png`,
    foldPngKey: `${base}/fold.png`,
    checks: {
      /*
        TAWD's checks for a generated page (no fake reviews, no invented
        phone numbers, [PLACEHOLDER]s, claims, the house rules) did NOT run on this page: people made it. So there is no
        "passed": it is left out on purpose, so nothing reads it as passed (or
        as failed), and the board says the page was not judged.
      */
      issues: [],
      needsIntake: [],
      stage: "build",
      source: "html_homepage",
      checked: false,
      fileId: file.id,
      fileName: file.fileName,
      removed: read.removed,
      warnings: read.warnings,
      heightPx: shot.heightPx,
      truncated: shot.truncated,
      imageHeightPx: shot.imageHeightPx,
      bands: shot.bands,
    },
    summary: `The supplied homepage (${file.fileName}), cleaned: its scripts, inline handlers and javascript: links are taken out, and a picture or font that fails a check is left out. TAWD's own page checks have not judged it${notes.length ? `; ${notes.length} note${notes.length === 1 ? "" : "s"} for the team, in full under the concept's Checks tab` : ""}.`,
    placeholderCount: countPlaceholders(source),
  });

  const by = supplier ?? { id: data.startedByUserId, email: "unknown", name: "" };
  await recordActivity(db, {
    // The existing concept entry: the timeline reads "Concept 1: <reason>".
    action: "mockups.concept_built",
    entityType: "project",
    entityId: projectId,
    ...actorFields(by),
    valueAfter: {
      concept: "1",
      reason: `the supplied homepage ${file.fileName} was put on the board (a finished HTML page, no AI)`,
      source: "html_homepage",
      fileName: file.fileName,
      version,
      pictures: read.images.length,
      fonts: read.fonts.length,
      removed: read.removed.length,
      warnings: read.warnings.length,
    },
    ipAddress: null,
    userAgent: null,
  });
  return { conceptId, version };
}

/*
  Build A (site-build.ts): is the approved version a supplied homepage, and
  if so which pictures does it carry? A logo swap makes a later version of the
  same concept that has no picture list of its own, so the newest earlier
  version that has one is used.
*/
export async function loadSuppliedHome(
  storage: FileStorage,
  picked: { id: string; direction: string },
  version: { htmlKey: string | null; version: number },
): Promise<SuppliedHome | null> {
  if (picked.direction !== HTML_HOMEPAGE_CONCEPT || !version.htmlKey) return null;
  const match = /^(.*\/concepts\/[^/]+)\/v\d+\/page\.html$/.exec(version.htmlKey);
  if (!match) throw new SiteBuildError("The supplied homepage's files can't be found: its stored page has an unexpected address.");
  for (let n = version.version; n >= 1; n -= 1) {
    const listed = await storage.get(`${match[1]}/v${n}/${HTML_IMAGES_FILE}`);
    if (!listed) continue;
    const entries = JSON.parse(listed.toString("utf8")) as SuppliedImageEntry[];
    const images: SuppliedHome["images"] = [];
    for (const entry of entries) {
      const picture = await storage.get(entry.key);
      if (!picture) throw new SiteBuildError(`The supplied homepage's picture ${entry.token.replace("tawd-asset:", "")} is missing from storage. Supply the homepage again.`);
      images.push({ token: entry.token, path: sitePathFor(entry.token, entry.contentType), bytes: picture });
    }
    return { images };
  }
  // A page with no pictures of its own is a page with no list; only a page whose list was lost is an error, and that cannot be told apart, so none is assumed.
  return { images: [] };
}

/*
  The supplied homepage's own sections, as the home page's <main>, to be kept
  as it is. The header and the footer belong to the shared parts (every page
  has the same ones); everything between them is the page the team supplied.
  Not written by a model, so none of the checks a model's reply goes through
  (one H1, no scripts) is applied here: the build's own checks and its
  stripActiveContent pass look at it like every other page.
*/
export function suppliedHomeMain(design: Pick<DesignSystem, "sections">): string {
  if (design.sections.length === 0) throw new SiteBuildError("The supplied homepage has nothing between its header and its footer to keep.");
  // Marked as kept, so every later pass (the tidy-up, the phone layout, a rebuild) leaves its words alone.
  return `<main id="main" ${KEPT_MAIN_ATTR}>\n${design.sections.join("\n")}\n</main>`;
}
