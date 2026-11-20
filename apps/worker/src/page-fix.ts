import { and, eq, isNull } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import type { Browser } from "playwright-core";

import { getDb } from "@tawd/core/db";
import { claimSiteBuild } from "@tawd/core/paid-starts";
import { pageFix, pagePlanPage, pageReviewComment, siteBuild } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import type { PageFixJobData } from "@tawd/core/queue";
import {
  applyPageFix,
  buildPageFixPrompt,
  changedParts,
  pagePath,
  fixableParts,
  readPageFixReply,
  type FixComment,
  type FixPartId,
  type PageFixCheck,
  type SitePlanPage,
} from "@tawd/core/site";

import { imageBlock } from "./image-type";
import type { WorkerConfig } from "./config";
import { SITE_ORIGIN, checkFixedPage, serveBuild } from "./page-fix-check";
import { ask, markSiteBuildFailed, runSiteBuildJob, siteContext } from "./site-build";
import { ownPageContext } from "./locked-context";
import { openPage } from "./page-load";

/*
  Fix these (step 3b, 3 October 2026): one page's open review comments go
  to the AI with only the parts they're on (and a picture of each, with the
  pins drawn); the changed parts are swapped into the page's saved source,
  and a new build version is made from the saved sources, with no AI for
  any other page. The step runs on Sonnet 5 unless an admin changes it.

  3c (5 October 2026): the new version is then checked by code (free): the
  changed parts at computer and phone width, for wrapping phone numbers and
  buttons, things sticking out and pictures that don't load. When it finds
  a problem, the AI gets ONE more try (the same comments, the parts as they
  are now, the problems and their pictures), one more version is built and
  checked, and it stops there whatever the result. A retry that fails
  keeps the first version.
*/

type Shared = { header: string; footer: string };

/* Marks the retry's calls on Spend (and keeps them apart from the first call in the ledger's labels). */
export const RETRY_LABEL = "second try after TAWD's check";

export async function runPageFixJob(job: PageFixJobData, config: WorkerConfig, client: Anthropic, browser: Browser): Promise<void> {
  const db = getDb();
  const storage = getStorage();
  const [fix] = await db.select().from(pageFix).where(eq(pageFix.id, job.fixId)).limit(1);
  if (!fix || fix.status !== "queued") return;
  await db.update(pageFix).set({ status: "fixing", detail: "Reading the page and the comments" }).where(eq(pageFix.id, fix.id));

  const prefix = projectStoragePrefix(fix.projectId);
  const base = `${prefix}site/v${fix.baseVersion}/`;
  const mainFile = await storage.get(`${base}_source/pages/${fix.slug}.html`);
  const partsFile = await storage.get(`${base}_source/parts.json`);
  if (!mainFile || !partsFile) throw new Error("The build has no saved source for this page. Build the site again, then review it.");
  const main = mainFile.toString("utf8");
  const shared = JSON.parse(partsFile.toString("utf8")) as Shared & Record<string, unknown>;

  const rows = await db
    .select()
    .from(pageReviewComment)
    .where(and(eq(pageReviewComment.fixId, fix.id), isNull(pageReviewComment.parentId)))
    .orderBy(pageReviewComment.createdAt);
  if (rows.length === 0) throw new Error("No comments went with this fix.");

  const sections = fixableParts(main);
  const comments: FixComment[] = rows.map((r, i) => ({
    number: i + 1,
    body: r.body,
    part: r.area === "header" ? "header" : r.area === "footer" ? "footer" : r.area === "main" && r.section !== null && sections.some((s) => s.index === r.section) ? r.section : null,
    label: r.sectionLabel,
    secondTry: r.tries >= 2,
  }));
  // A comment on the whole page (or one whose section isn't there any more) sends every part of the page.
  const wholePage = comments.some((c) => c.part === null);
  const ids: FixPartId[] = [
    ...(comments.some((c) => c.part === "header") ? (["header"] as const) : []),
    ...sections.filter((s) => wholePage || comments.some((c) => c.part === s.index)).map((s) => s.index),
    ...(comments.some((c) => c.part === "footer") ? (["footer"] as const) : []),
  ];
  const pins = rows.flatMap((r, i) => (r.area && comments[i]!.part !== null ? [{ number: i + 1, part: comments[i]!.part!, x: r.pinX ?? 50, y: r.pinY ?? 50 }] : []));
  const path = pagePathOf(fix.slug);

  const { system, plan } = await siteContext(browser, config, fix.projectId, fix.id);
  const planned = await db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, fix.projectId));
  const page: SitePlanPage = plan.find((p) => (p.slug || "home") === fix.slug) ?? {
    name: fix.pageName,
    kind: planned.find((p) => (p.slug || "home") === fix.slug)?.kind ?? "page",
    slug: fix.slug === "home" ? "" : fix.slug,
  };

  /* One AI call on the page as it is in `from` (its main and shared parts), with pictures from the build at `pictureBase`. */
  const fixRound = async (from: { main: string; shared: Shared }, pictureBase: string, round: { problems?: string[]; also?: FixPartId[]; stopAbove?: number; label: string }) => {
    const now = fixableParts(from.main);
    const parts = ids.flatMap((id) => {
      const html = id === "header" ? from.shared.header : id === "footer" ? from.shared.footer : now.find((s) => s.index === id)?.html;
      return html === undefined ? [] : [{ id, html }];
    });
    await db.update(pageFix).set({ detail: round.problems ? "TAWD's check found a problem: taking pictures for one more try" : "Taking pictures of the commented parts" }).where(eq(pageFix.id, fix.id));
    const pictures = await partPictures(browser, pictureBase, path, pins, { also: round.also }).catch(() => []);
    await db.update(pageFix).set({ detail: round.problems ? "Trying once more, with what TAWD's check found" : "Making the changes" }).where(eq(pageFix.id, fix.id));
    const text = buildPageFixPrompt({ page, comments, parts, pages: plan, withPictures: pictures.length > 0, problems: round.problems });
    const prompt: string | Anthropic.ContentBlockParam[] = pictures.length
      ? [
          { type: "text", text },
          ...pictures.flatMap((p): Anthropic.ContentBlockParam[] => [
            { type: "text", text: p.caption },
            imageBlock(p.jpeg),
          ]),
        ]
      : text;
    const replies = await ask(client, config, system, prompt, (answer) => readPageFixReply(answer, parts.map((p) => p.id)), {
      projectId: fix.projectId,
      runId: fix.id,
      startedByUserId: fix.requestedByUserId,
      step: "site_page_fix",
      label: round.label,
      stopAbove: round.stopAbove,
    });
    if (replies.size === 0) throw new Error("The AI didn't return any changed part, so nothing changed. Reword the comments, or ask the Web Designer.");
    const fixed = applyPageFix(from.main, from.shared, replies);
    return { main: fixed.main, shared: { ...from.shared, header: fixed.header, footer: fixed.footer } };
  };

  /* The fixed page (and header or footer) stored, and a new version built from the saved sources: no AI for any other page. */
  const buildVersion = async (fixed: { main: string; shared: Shared }, folder: string) => {
    const fixPrefix = `${prefix}fixes/${fix.id}/${folder}`;
    const afterKey = `${fixPrefix}${fix.slug}.after.html`;
    await storage.put(afterKey, Buffer.from(fixed.main, "utf8"), "text/html; charset=utf-8");
    let partsKey: string | null = null;
    if (fixed.shared.header !== shared.header || fixed.shared.footer !== shared.footer) {
      partsKey = `${fixPrefix}parts.json`;
      await storage.put(partsKey, Buffer.from(JSON.stringify({ ...shared, header: fixed.shared.header, footer: fixed.shared.footer }), "utf8"), "application/json");
    }
    // The version claimed under the build lock, so a build started meanwhile never gets the same number (13 October 2026).
    const build = (await claimSiteBuild(db, fix.projectId, { startedByUserId: fix.requestedByUserId, options: { kind: "page_fix", fixId: fix.id } }, { whileBusy: true, firstVersion: fix.baseVersion }))!;
    const { version } = build;
    await db
      .update(pageFix)
      .set({ status: "building", detail: `Building version ${version}`, afterKey, partsKey, changed: changedParts({ main, ...shared }, { main: fixed.main, ...fixed.shared }), buildId: build!.id })
      .where(eq(pageFix.id, fix.id));
    try {
      await runSiteBuildJob({ buildId: build!.id, projectId: fix.projectId }, config, client, browser);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The build didn't finish.";
      await markSiteBuildFailed(build!.id, message);
      throw new Error(`The changes were made, but version ${version} didn't build: ${message}`, { cause: error });
    }
    const [after] = await db.select({ status: siteBuild.status, failureReason: siteBuild.failureReason }).from(siteBuild).where(eq(siteBuild.id, build!.id)).limit(1);
    if (after?.status !== "done") throw new Error(`The changes were made, but version ${version} didn't build${after?.failureReason ? `: ${after.failureReason}` : "."}`);
    return { version, buildId: build!.id, afterKey, partsKey, ...fixed };
  };

  /* TAWD's check of the parts that changed since the version the fix started from (free; finds nothing if it can't run). */
  const check = async (version: number, fixed: { main: string; shared: Shared }) => {
    await db.update(pageFix).set({ detail: `Checking version ${version}` }).where(eq(pageFix.id, fix.id));
    const changed = changedParts({ main, ...shared }, { main: fixed.main, ...fixed.shared });
    return checkFixedPage(browser, `${prefix}site/v${version}/`, path, changed).catch(() => []);
  };

  const cost = fix.estimateCost ?? null;
  const first = await buildVersion(await fixRound({ main, shared }, base, { label: fix.pageName, stopAbove: cost ? cost * 2 : undefined }), "");
  const firstFound = await check(first.version, first);
  let final = first;
  let finalFound = firstFound;
  let retryNote: string | null = null;

  // One automatic retry when the check found a problem; never a second.
  if (firstFound.length > 0) {
    await db.update(pageFix).set({ status: "fixing", retried: true }).where(eq(pageFix.id, fix.id));
    try {
      const again = await fixRound(first, `${prefix}site/v${first.version}/`, {
        problems: firstFound,
        also: changedParts({ main, ...shared }, { main: first.main, ...first.shared }),
        // Twice the estimate with the retry (two calls).
        stopAbove: cost ? cost * 4 : undefined,
        label: `${fix.pageName}: ${RETRY_LABEL}`,
      });
      final = await buildVersion(again, "retry/");
      finalFound = await check(final.version, final);
    } catch (error) {
      retryNote = error instanceof Error ? error.message : "The second try didn't finish.";
      // The first version stays the fix's result.
      await db.update(pageFix).set({ afterKey: first.afterKey, partsKey: first.partsKey, buildId: first.buildId }).where(eq(pageFix.id, fix.id));
    }
  }

  const changed = changedParts({ main, ...shared }, { main: final.main, ...final.shared });
  const findings: PageFixCheck = { firstVersion: first.version, first: firstFound, finalVersion: final.version, final: finalFound, retryNote };
  await db
    .update(pageFix)
    .set({ status: "done", buildId: final.buildId, resultVersion: final.version, changed, checkFindings: findings, detail: null, finishedAt: new Date() })
    .where(eq(pageFix.id, fix.id));
  await db.update(pageReviewComment).set({ sentInVersion: final.version }).where(eq(pageReviewComment.fixId, fix.id));

  await recordActivity(db, {
    action: "site.page_fixed",
    entityType: "project",
    entityId: fix.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: {
      page: fix.pageName,
      fromVersion: fix.baseVersion,
      version: final.version,
      comments: rows.length,
      changed,
      checkFound: firstFound,
      retried: firstFound.length > 0,
      ...(final !== first ? { firstVersion: first.version, stillFound: finalFound } : {}),
      ...(retryNote ? { retryNote } : {}),
    },
    ipAddress: null,
    userAgent: null,
  });
}

/*
  A fix that couldn't finish. If no version was made, its comments go back
  to Not sent and the try doesn't count; the page keeps its version.
*/
export async function markPageFixFailed(fixId: string, message: string): Promise<void> {
  const db = getDb();
  const [fix] = await db.select().from(pageFix).where(eq(pageFix.id, fixId)).limit(1);
  if (!fix) return;
  await db.update(pageFix).set({ status: "failed", failureReason: message, detail: null, finishedAt: new Date() }).where(eq(pageFix.id, fixId));
  const comments = await db.select().from(pageReviewComment).where(eq(pageReviewComment.fixId, fixId));
  for (const c of comments) {
    await db
      .update(pageReviewComment)
      .set({ fixId: null, tries: Math.max(0, c.tries - 1) })
      .where(eq(pageReviewComment.id, c.id));
  }
}

const pagePathOf = (slug: string) => pagePath(slug === "home" ? "" : slug);

/*
  The commented parts of the page as built, each with its pins drawn (at
  most four parts, at most 1,600 pixels tall each), served from the build's
  own files in storage: nothing is fetched from the internet but fonts.
  `also` adds parts without pins (the retry's changed parts, as they are now).
*/
export async function partPictures(
  browser: Browser,
  base: string,
  path: string,
  pins: { number: number; part: FixPartId; x: number; y: number }[],
  options: { also?: FixPartId[] } = {},
): Promise<{ caption: string; jpeg: Buffer }[]> {
  const parts = [...new Set([...pins.map((p) => String(p.part)), ...(options.also ?? []).map(String)])].slice(0, 4);
  if (parts.length === 0) return [];
  const context = await ownPageContext(browser, { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  try {
    const tab = await context.newPage();
    await serveBuild(tab, base);
    await openPage(tab, `${SITE_ORIGIN}${path}`);
    await tab.waitForTimeout(300);
    const out: { caption: string; jpeg: Buffer }[] = [];
    for (const part of parts) {
      const mine = pins.filter((p) => String(p.part) === part);
      const box = (await tab.evaluate(
        ({ part, mine }) => {
          const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "LINK", "TEMPLATE", "META"]);
          const main = document.querySelector("main");
          const el =
            part === "header"
              ? document.querySelector("body > header") ?? document.querySelector("header")
              : part === "footer"
                ? Array.from(document.querySelectorAll("body > footer")).at(-1) ?? Array.from(document.querySelectorAll("footer")).at(-1)
                : main
                  ? Array.from(main.children).filter((e) => !skip.has(e.tagName))[Number(part)]
                  : null;
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const b = { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height };
          for (const pin of mine) {
            const dot = document.createElement("div");
            dot.textContent = String(pin.number);
            dot.setAttribute("style", `position:absolute;left:${b.x + (pin.x / 100) * b.w - 16}px;top:${b.y + (pin.y / 100) * b.h - 16}px;width:32px;height:32px;border-radius:50%;background:#D93025;color:#fff;border:3px solid #fff;font:bold 15px/26px Arial;text-align:center;z-index:2147483647;box-sizing:border-box`);
            document.body.appendChild(dot);
          }
          return b;
        },
        { part, mine },
      )) as { x: number; y: number; w: number; h: number } | null;
      if (!box || box.w < 1 || box.h < 1) continue;
      const height = Math.min(box.h, 1600);
      const pinYs = mine.map((p) => box.y + (p.y / 100) * box.h);
      const top = box.h > 1600 && pinYs.length ? Math.max(box.y, Math.min(box.y + box.h - 1600, (Math.min(...pinYs) + Math.max(...pinYs)) / 2 - 800)) : box.y;
      const jpeg = await tab.screenshot({ type: "jpeg", quality: 70, fullPage: true, clip: { x: box.x, y: top, width: box.w, height } });
      const name = part === "header" ? "the header" : part === "footer" ? "the footer" : `part ${part}`;
      const what = mine.length ? `: comment${mine.length === 1 ? "" : "s"} ${mine.map((p) => p.number).join(", ")}` : "";
      out.push({ caption: `${name[0]!.toUpperCase()}${name.slice(1)} (<tawd-part id="${part}">), as it looks now${what}.`, jpeg });
    }
    return out;
  } finally {
    await context.close();
  }
}
