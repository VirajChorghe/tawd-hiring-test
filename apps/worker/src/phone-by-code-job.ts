import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Browser } from "playwright-core";

import type { Database } from "@tawd/core/db";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { insertMobileCss } from "@tawd/core/figma";
import { getStorage } from "@tawd/core/intake/storage";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import type { DesignMobileJobData } from "@tawd/core/queue";
import { designCopy, designPage, figmaDesign, project } from "@tawd/core/schema";
import { COOKIE_POLICY_PATH, PRIVACY_POLICY_PATH, phoneShellCss, phoneShellHtml, replaceAssetTokens } from "@tawd/core/site";
import { applyKit } from "@tawd/core/style-kit/kit";

import { REPAIR_ASSET_HOST } from "./copy-repair";
import { loadDesignSource } from "./design-source";
import { phoneCheck, phoneRules, readShell } from "./phone-by-code";
import { withImages } from "./pipeline";
import { loadKitForCopy } from "./style-kit-job";

/*
  A page's phone version by code (Jason, 29 September 2026), $0: the phone
  rules read from the page's own layout, the shared phone header and footer
  read from the home page's copy, then the phone check at 390px. Stored in
  the copy as its phone CSS and markup, like the AI's phone version was;
  the desktop page is unchanged.
*/

const SHELL_MARK = /<header class="tawd-m-header"[\s\S]*?<\/header>|<footer class="tawd-m-footer"[\s\S]*?<\/footer>|<style data-tawd-shell>[\s\S]*?<\/style>/g;

async function served(db: Database, browser: Browser, copy: { projectId: string; frameId: string; frameName: string }) {
  const design = await loadDesignSource(db, getStorage(), browser, { projectId: copy.projectId, frameId: copy.frameId, frameName: copy.frameName, purpose: "make the phone version" });
  const files = new Map<string, { body: Buffer; contentType: string }>();
  const toAddress = (html: string) => {
    let out = html;
    design.assets.forEach((asset, i) => {
      const [, type, data] = /^data:([^;]+);base64,([\s\S]*)$/.exec(asset.dataUri) ?? [];
      if (!type || !data) return;
      files.set(`${REPAIR_ASSET_HOST}${i}`, { body: Buffer.from(data, "base64"), contentType: type });
      out = replaceAssetTokens(out, new Map([[asset.token, `${REPAIR_ASSET_HOST}${i}`]]));
    });
    return out;
  };
  const toTokens = (html: string) => {
    let out = html;
    design.assets.forEach((asset, i) => {
      out = out.split(`${REPAIR_ASSET_HOST}${i}`).join(asset.token);
    });
    return out;
  };
  return { design, files, toAddress, toTokens };
}

export async function runPhoneByCodeJob(db: Database, browser: Browser, job: DesignMobileJobData): Promise<void> {
  const storage = getStorage();
  const [copy] = await db.select().from(designCopy).where(eq(designCopy.id, job.copyId)).limit(1);
  if (!copy || copy.mobileStatus !== "queued" || !copy.sourceKey) return;
  await db.update(designCopy).set({ mobileStatus: "working", mobileFailure: null }).where(eq(designCopy.id, copy.id));
  const saved = (await storage.get(copy.sourceKey))?.toString("utf8");
  if (!saved) throw new Error("The page's copy is missing from storage. Build the copy again.");
  // A phone version made before is replaced, not added to.
  const source = saved.replace(SHELL_MARK, "").replace(/<style data-tawd-mobile>[\s\S]*?<\/style>\s*/g, "").replace(/\sdata-m="\d+"/g, "");
  const styled = await loadKitForCopy(db, { projectId: copy.projectId, designVersion: copy.figmaVersion, frameId: copy.frameId });
  const kitted = (html: string) => (styled ? applyKit(html, styled.kit, styled.css).html : html);

  // The shared header and footer, from the home page's copy and the site's pages.
  const [figma] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, copy.projectId)).limit(1);
  const pages = await db
    .select()
    .from(designPage)
    .where(and(eq(designPage.projectId, copy.projectId), eq(designPage.figmaVersion, figma?.importedVersion ?? "")))
    .orderBy(asc(designPage.position));
  const homePage = pages.find((p) => p.isHome);
  const [homeCopy] = homePage
    ? await db
        .select()
        .from(designCopy)
        .where(and(eq(designCopy.projectId, copy.projectId), eq(designCopy.frameId, homePage.frameId), inArray(designCopy.status, ["done", "needs_cleanup"])))
        .orderBy(desc(designCopy.createdAt))
        .limit(1)
    : [];
  const homeSaved = homeCopy?.sourceKey ? (await storage.get(homeCopy.sourceKey))?.toString("utf8").replace(SHELL_MARK, "") : null;
  if (!homeCopy || !homeSaved) throw new Error("Copy the home page first: the phone header and footer are made from it.");
  const home = await served(db, browser, homeCopy);
  const [client] = await db.select({ name: project.clientName }).from(project).where(eq(project.id, copy.projectId)).limit(1);
  const shell = await readShell(
    browser,
    withImages(kitted(homeSaved), home.design.assets),
    pages.map((p) => ({ name: p.name, slug: p.isHome ? "" : p.slug })),
    [
      { label: "Privacy policy", href: PRIVACY_POLICY_PATH },
      { label: "Cookie policy", href: COOKIE_POLICY_PATH },
    ],
  );
  shell.siteName = client?.name ?? shell.siteName;
  // The logo as this page's own picture token when the home page's logo is the same picture.
  const own = await served(db, browser, copy);
  const logoToken = shell.logo ? (home.design.assets.find((a) => a.dataUri === shell.logo)?.token ?? null) : null;
  shell.logo = logoToken && own.design.assets.some((a) => a.token === logoToken) ? logoToken : logoToken ? null : shell.logo;

  // The phone rules, read from this page's layout.
  const rules = await phoneRules(browser, kitted(own.toAddress(source)), own.files);
  const current = pages.find((p) => p.frameId === copy.frameId);
  const { header, footer } = phoneShellHtml(shell, current?.isHome ? "/" : `/${current?.slug ?? ""}/`);
  let phone = insertMobileCss(own.toTokens(rules.html), rules.css);
  phone = phone
    .replace(/<body([^>]*)>/i, `<body$1>${header}`)
    .replace(/<\/body>/i, `${footer}</body>`)
    .replace(/<\/head>/i, `<style data-tawd-shell>${phoneShellCss(shell)}</style></head>`);

  const embedded = withImages(kitted(phone), own.design.assets);
  const check = await phoneCheck(browser, embedded, styled?.kit.fonts.map((f) => f.family) ?? []);
  const base = copy.sourceKey.replace(/source\.html$/, "");
  const pngKey = `${base}mobile.png`;
  await storage.put(copy.sourceKey, Buffer.from(phone, "utf8"), "text/html; charset=utf-8");
  if (copy.htmlKey) await storage.put(copy.htmlKey, Buffer.from(embedded, "utf8"), "text/html; charset=utf-8");
  await storage.put(pngKey, check.shot, "image/png");
  const checks = (copy.checks as Record<string, unknown> | null) ?? {};
  await db
    .update(designCopy)
    .set({
      mobileStatus: "done",
      mobileFrom: "code",
      mobileFrameId: null,
      mobilePngKey: pngKey,
      mobileOverflow: check.problems.some((p) => p.kind === "sideways scrolling"),
      mobileDecision: null,
      mobileDecidedByUserId: null,
      mobileDecidedAt: null,
      mobileDecisionNote: null,
      checks: { ...checks, phone: check.problems },
    })
    .where(eq(designCopy.id, copy.id));
  await recordActivity(db, {
    action: "design.mobile_made",
    entityType: "project",
    entityId: copy.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { page: current?.name ?? copy.frameName, from: "code ($0)", problems: check.problems.length },
    ipAddress: null,
    userAgent: null,
  });
}
