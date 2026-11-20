import { and, desc, eq } from "drizzle-orm";
import type { Browser } from "playwright-core";

import type { Database } from "@tawd/core/db";
import { actorFields, recordActivity } from "@tawd/core/activity";
import type { ImportedFrame } from "@tawd/core/figma/service";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import type { StyleKitJobData } from "@tawd/core/queue";
import { figmaDesign, styleKit } from "@tawd/core/schema";
import type { DesignReadPage, FontRole, PageInventory, SectionInventory } from "@tawd/core/style-kit/elements";
import { planPage } from "@tawd/core/style-kit/element-check";
import { applyKit, kitCss, type StyleKit } from "@tawd/core/style-kit/kit";
import { kitPreviewHtml, kitSheetHtml } from "@tawd/core/style-kit/preview";
import { sharedLayouts } from "@tawd/core/style-kit/templates";

import { runElementCheck } from "./element-check";
import { compareWithDesign } from "./fidelity";
import { measureBands } from "./render";
import { buildKitForPages, chooseFonts, fetchFontFile } from "./style-kit";
import { ownPageContext } from "./locked-context";
import { fontsReady, loadHtml } from "./page-load";

/*
  The style kit job (Jason, 28 September 2026): the design's pages (the
  pictures and the reads kept from the upload) made into a kit by code, the
  chosen fonts' files fetched once into R2, the kit sheet drawn, and the
  home page put together from the kit alone, compared with the design and
  element-checked. No AI, $0.
*/

/* Where the upload kept each page's read (see design-upload.ts). */
function readKey(projectId: string, page: number): string {
  return `${projectStoragePrefix(projectId)}design-upload/read-pages/page-${page}.json`;
}

export function kitFontKey(projectId: string, family: string, weight: number): string {
  return `${projectStoragePrefix(projectId)}style-kit/fonts/${family.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${weight}.woff2`;
}

/* The kit's CSS with every font file inlined, so a page needs nothing from outside. */
export async function kitCssInline(kit: StyleKit): Promise<string> {
  const storage = getStorage();
  const urls = new Map<string, string>();
  for (const f of kit.fonts) {
    for (const file of f.files) {
      const bytes = await storage.get(file.key);
      if (bytes) urls.set(file.key, `data:font/woff2;base64,${bytes.toString("base64")}`);
    }
  }
  return kitCss(kit, (key) => urls.get(key) ?? "");
}

async function screenshot(browser: Browser, html: string, width: number): Promise<Buffer> {
  const context = await ownPageContext(browser, { viewport: { width, height: 900 } });
  try {
    const page = await context.newPage();
    // The page has everything inline; nothing is fetched.
    await page.route("**/*", (route) => (/^(data|blob|about):/.test(route.request().url()) ? route.continue() : route.abort()));
    await loadHtml(page, html, { what: "The style kit's picture", free: true });
    await fontsReady(page);
    await page.waitForSelector("body[data-fitted]", { timeout: 5_000 }).catch(() => undefined);
    return await page.screenshot({ fullPage: true });
  } finally {
    await context.close();
  }
}

/* Fonts are chosen and fetched over the network; tests pass stand-ins. */
export interface StyleKitDeps {
  chooseFonts?: typeof chooseFonts;
  fetchFont?: typeof fetchFontFile;
}

export async function runStyleKitJob(db: Database, browser: Browser, job: StyleKitJobData, deps: StyleKitDeps = {}): Promise<void> {
  const storage = getStorage();
  const [row] = await db.select().from(styleKit).where(eq(styleKit.id, job.kitId)).limit(1);
  if (!row) return;
  await db.update(styleKit).set({ status: "working" }).where(eq(styleKit.id, job.kitId));
  const [design] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, job.projectId)).limit(1);
  const frames = ((design?.frames as ImportedFrame[] | null) ?? []).filter((f) => f.imageKey);
  if (frames.length === 0) throw new Error("The design has no pages to build a kit from. Import or upload it first.");

  // The home page first: its preview is the one shown.
  const ordered = [...frames].sort((a, b) => Number(b.isHome) - Number(a.isHome));
  const pages: { png: Buffer; read: DesignReadPage; frame: ImportedFrame }[] = [];
  for (const frame of ordered) {
    const number = Number(/page-(\d+)\.png$/.exec(frame.imageKey!)?.[1]);
    if (!number) continue;
    const [png, saved] = await Promise.all([storage.get(frame.imageKey!), storage.get(readKey(job.projectId, number))]);
    if (!png || !saved) continue;
    const { page } = JSON.parse(saved.toString("utf8")) as { page: DesignReadPage };
    pages.push({ png, read: page, frame });
  }
  if (pages.length === 0) throw new Error("The style kit is built from an uploaded design (a PDF or images) for now; a Figma design's kit comes next.");

  const overrides = (row.fontOverrides as Partial<Record<FontRole, string>> | null) ?? {};
  const { kit, inventories, signatures } = await buildKitForPages(browser, pages, overrides, deps.chooseFonts ?? chooseFonts);
  // Pages that share a layout (the sample client's dog pages): built once, the others filled (28 September 2026).
  kit.sharedLayouts = sharedLayouts(signatures.map((signature, i) => ({ key: pages[i]!.frame.id, signature })));

  // The fonts' files, kept under the project for the site to host.
  for (const font of kit.fonts) {
    for (const weight of font.weights.length ? font.weights : [400]) {
      const bytes = await (deps.fetchFont ?? fetchFontFile)(font.family, weight);
      if (!bytes) {
        kit.notes.push(`${font.family} (${weight}) couldn't be fetched from Google Fonts; pages fall back to a similar system font until the kit is built again.`);
        continue;
      }
      const key = kitFontKey(job.projectId, font.family, weight);
      await storage.put(key, bytes, "font/woff2");
      font.files.push({ weight, key });
    }
  }

  const prefix = `${projectStoragePrefix(job.projectId)}style-kit/${job.kitId}/`;
  const css = await kitCssInline(kit);
  const sheet = await screenshot(browser, applyKit(kitSheetHtml(kit, ""), kit, css).html, 1100);
  const home = pages[0]!;
  const picture = `data:image/png;base64,${home.png.toString("base64")}`;
  const preview = applyKit(kitPreviewHtml({ title: "The home page from the kit", page: inventories[0]!, kit, css: "", picture }), kit, css).html;
  const previewPng = await screenshot(browser, preview, inventories[0]!.width);
  const check = await runElementCheck(browser, preview, planPage(kit, inventories[0]!));
  const fidelity = await compareWithDesign(browser, {
    design: home.png,
    copy: previewPng,
    frameWidth: inventories[0]!.width,
    sections: inventories[0]!.sections.map((s) => ({ name: s.name, top: s.top, height: s.height })),
    copyBands: await measureBands(browser, preview),
  });

  const inventoriesKey = `${prefix}inventories.json`;
  const sheetKey = `${prefix}sheet.png`;
  const previewKey = `${prefix}home-from-kit.png`;
  const stored: StoredInventory[] = pages.map((p, i) => ({ frameId: p.frame.id, inventory: inventories[i]! }));
  await storage.put(inventoriesKey, Buffer.from(JSON.stringify(stored), "utf8"), "application/json");
  await storage.put(sheetKey, sheet, "image/png");
  await storage.put(previewKey, previewPng, "image/png");
  await db
    .update(styleKit)
    .set({ status: "done", kit, inventoriesKey, sheetKey, previewKey, previewFidelity: fidelity.overall, previewCheck: check, finishedAt: new Date() })
    .where(eq(styleKit.id, job.kitId));
  await recordActivity(db, {
    action: "design.style_kit_built",
    entityType: "project",
    entityId: job.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { pages: pages.length, colors: kit.colors.length, parts: kit.parts.length, icons: kit.icons.length, fonts: kit.fonts.map((f) => `${f.role}: ${f.family}`), homeMatch: fidelity.overall },
    ipAddress: null,
    userAgent: null,
  });
}

/* Each page's inventory, by the frame (page) it was found on. */
export interface StoredInventory {
  frameId: string;
  inventory: PageInventory;
}

/*
  The kit a copy is built with: the newest finished kit for the design
  import the copy is of, with its CSS (fonts inlined) and the page's
  inventory. Null when there is none (the copy is built as before).
*/
export async function loadKitForCopy(db: Database, input: { projectId: string; designVersion: string; frameId: string }): Promise<{ id: string; kit: StyleKit; css: string; inventory: PageInventory } | null> {
  const [row] = await db
    .select()
    .from(styleKit)
    .where(and(eq(styleKit.projectId, input.projectId), eq(styleKit.status, "done"), eq(styleKit.designVersion, input.designVersion)))
    .orderBy(desc(styleKit.createdAt))
    .limit(1);
  if (!row?.kit || !row.inventoriesKey) return null;
  const saved = await getStorage().get(row.inventoriesKey);
  if (!saved) return null;
  const inventory = (JSON.parse(saved.toString("utf8")) as StoredInventory[]).find((s) => s.frameId === input.frameId)?.inventory;
  if (!inventory) return null;
  const kit = row.kit as StyleKit;
  return { id: row.id, kit, css: await kitCssInline(kit), inventory };
}

/* Each copy section's inventory section: the same place with the same name, else the one with its name. */
export function matchKitSections(sections: { number: number; name: string }[], inventory: PageInventory): Map<number, SectionInventory> {
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const out = new Map<number, SectionInventory>();
  for (const section of sections) {
    const same = inventory.sections[section.number - 1];
    const match = same && norm(same.name) === norm(section.name) ? same : inventory.sections.find((s) => norm(s.name) === norm(section.name));
    if (match) out.set(section.number, match);
  }
  return out;
}

export async function markStyleKitFailed(db: Database, kitId: string, message: string): Promise<void> {
  await db.update(styleKit).set({ status: "failed", failureReason: message.slice(0, 1000), finishedAt: new Date() }).where(eq(styleKit.id, kitId));
}
