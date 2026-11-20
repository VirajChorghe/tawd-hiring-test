import { and, asc, desc, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import type { Browser } from "playwright-core";

import { CACHE_1H } from "@tawd/core/mockups";
import { getDb } from "@tawd/core/db";
import { designTextsBySection, frameSections, type FigmaNode } from "@tawd/core/figma";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import { designFinding, designPage, designReview, figmaDesign, project, siteBuild, styleKit } from "@tawd/core/schema";
import {
  COOKIE_POLICY_PATH,
  PRIVACY_POLICY_PATH,
  SiteBuildError,
  VIDEO_CSS,
  VIDEO_SCRIPT,
  buildDesignPagePrompt,
  buildDesignPartsPrompt,
  buildDesignReworkPrompt,
  buildDesignSiteSystemPrompt,
  readPageReply,
  readPartsReply,
  videosPageMain,
  type AcceptedChange,
  clearArea,
  type DesignBuildOptions,
  type DesignSystem,
  type SiteImage,
  type SitePlanPage,
  type SiteVideo,
} from "@tawd/core/site";
import { applyKit, describeKit, kitCss, type StyleKit } from "@tawd/core/style-kit/kit";

import type { WorkerConfig } from "./config";
import { loadDesignSource } from "./design-source";
import { phoneCheck } from "./phone-by-code";
import { cropPicture } from "./render";
import { jpeg } from "./review";
import { loadOriginals, useOriginals } from "./originals";
import { ReusePool } from "./saved-answers";
import { ask } from "./site-build";
import { checkSiteImages, missingPictures } from "./site-images";
import { featureVideos, tiktokThumbnail } from "./site-videos";
import { tidyPage } from "./site-tidy";
import { readProfile } from "./skills";
import { markStyleKitFailed, runStyleKitJob } from "./style-kit-job";
import { fillInBrowser, planFill } from "./template-fill";
import { ownPageContext } from "./locked-context";

/*
  Lane 2's site from the design (Jason, 29 September 2026): the design is a
  reference, the site is built close to it. The style kit (built quietly if
  there isn't one), the header and footer from the top and bottom of the
  home page's design, then each page from its picture with its words and
  photos, one AI pass each (Sonnet 5 by default). Pages that share a layout
  are built once and filled by code; pages not asked for this time are kept
  from the last build; feedback reworks only its page. Then, by code: the
  kit's styles, fonts and icons, the words and links tidy, the videos.
*/

/*
  Every design-built site, by code (Jason, 29 September 2026, on the sample client's
  Home): the skip link hidden until it gets keyboard focus (it showed as a
  1x1 link), and on a phone every menu and footer link at least 44px tall.
*/
export const SITE_WIDE_CSS = `a[href="#main"]:not(:focus):not(:focus-visible){position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0 0 0 0)!important;clip-path:inset(50%)!important;white-space:nowrap!important;border:0!important}
a[href="#main"]:focus,a[href="#main"]:focus-visible{position:fixed;top:8px;left:8px;z-index:1000;width:auto;height:auto;padding:12px 16px;background:#fff;color:#000;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.3);clip:auto;clip-path:none;overflow:visible}
@media (max-width:767px){.site-header nav a,.site-header summary,.site-header details a,.site-footer a{display:inline-flex;align-items:center;min-height:44px;min-width:44px}}`;

export interface DesignSite {
  row: typeof project.$inferSelect;
  plan: SitePlanPage[];
  pages: { page: { id: string; name: string; kind: string; slug: string; mainKeyword: string; title: string; metaDescription: string }; copy: string }[];
  parts: { header: string; footer: string };
  mains: string[];
  images: (SiteImage & { bytes: Buffer })[];
  design: DesignSystem;
  extraCss: string;
  bodyEnd: string;
  /** For the Preview: each page's design picture and what the checks noted while building. */
  notes: Map<string, string[]>;
  designKeys: Map<string, string>;
  /** A free check: the calls a real build would make (none were made). */
  dryPlan: { step: string; label: string; reused: boolean }[];
}

type Source = Awaited<ReturnType<typeof loadDesignSource>>;

const slugKey = (slug: string) => slug || "home";

/* The design's sections: the header ones at the top (short), the footer at the bottom. */
function chrome(home: FigmaNode): { header: number[]; footer: number[] } {
  const sections = frameSections(home);
  const header: number[] = [];
  for (const s of sections) {
    if (s.height <= 220 || /header|nav|menu|top/i.test(s.name)) header.push(s.index);
    else break;
  }
  const last = sections[sections.length - 1];
  const footer = last && last.index !== header[header.length - 1] && (/footer/i.test(last.name) || last.height <= 360) ? [last.index] : [];
  return { header, footer };
}

/* A part of a picture, cut by the browser: box in the picture's own coordinates (sourceWidth wide). */
async function cutBox(browser: Browser, dataUri: string, box: { x: number; y: number; w: number; h: number }, sourceWidth: number): Promise<string | null> {
  const context = await ownPageContext(browser);
  try {
    const page = await context.newPage();
    return await page.evaluate(
      async ({ dataUri, box, sourceWidth }) => {
        const img = new Image();
        img.src = dataUri;
        await img.decode();
        const k = img.naturalWidth / sourceWidth;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(box.w * k));
        canvas.height = Math.max(1, Math.round(box.h * k));
        canvas.getContext("2d")!.drawImage(img, box.x * k, box.y * k, box.w * k, box.h * k, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/png");
      },
      { dataUri, box, sourceWidth },
    );
  } catch {
    return null;
  } finally {
    await context.close();
  }
}

/*
  A photo's edges, by its pixels: a light strip along an edge that carries
  dark design ink (letters, a heart, a paw, a tab bar's labels) is design,
  not photo, and is trimmed off. At most 18% from any side; the photo
  itself is never touched.
*/
export async function trimDesignEdges(browser: Browser, dataUri: string): Promise<string | null> {
  const context = await ownPageContext(browser);
  try {
    const page = await context.newPage();
    return await page.evaluate(async (dataUri) => {
      const img = new Image();
      img.src = dataUri;
      await img.decode();
      const w = img.naturalWidth, h = img.naturalHeight;
      if (w < 40 || h < 40) return null;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, w, h).data;
      const at = (x: number, y: number) => {
        const i = (y * w + x) * 4;
        return [data[i]!, data[i + 1]!, data[i + 2]!] as const;
      };
      const light = ([r, g, b]: readonly number[]) => r! > 222 && g! > 222 && b! > 222;
      const ink = ([r, g, b]: readonly number[]) => 0.2126 * r! + 0.7152 * g! + 0.0722 * b! < 90 && Math.max(r!, g!, b!) - Math.min(r!, g!, b!) < 90;
      // A line is design when it's mostly light with some dark ink in it.
      const design = (pixels: (readonly number[])[]) => {
        const l = pixels.filter(light).length / pixels.length;
        const k = pixels.filter(ink).length / pixels.length;
        return l >= 0.5 && k >= 0.004;
      };
      const lightLine = (pixels: (readonly number[])[]) => pixels.filter(light).length / pixels.length >= 0.9;
      // A round or rounded photo (light corners, photo at the middle of each edge): its frame is the design's; leave it.
      const corner = (x0: number, y0: number) => {
        let n = 0;
        for (let y = y0; y < y0 + 4; y += 1) for (let x = x0; x < x0 + 4; x += 1) if (light(at(x, y))) n += 1;
        return n >= 12;
      };
      const mid = (x: number, y: number) => !light(at(x, y));
      if (corner(0, 0) && corner(w - 4, 0) && corner(0, h - 4) && corner(w - 4, h - 4) && [mid(Math.floor(w / 2), 2), mid(Math.floor(w / 2), h - 3), mid(2, Math.floor(h / 2)), mid(w - 3, Math.floor(h / 2))].filter(Boolean).length >= 3) return null;
      const column = (x: number) => Array.from({ length: h }, (_, y) => at(x, y));
      const row = (y: number) => Array.from({ length: w }, (_, x) => at(x, y));
      // From an edge inward: the furthest design line within the band (light lines between go too).
      const cut = (n: number, line: (i: number) => (readonly number[])[], from: "start" | "end") => {
        const band = Math.floor(n * 0.18);
        let last = -1;
        for (let k = 0; k < band; k += 1) {
          const i = from === "start" ? k : n - 1 - k;
          const px = line(i);
          if (design(px)) last = k;
          else if (!lightLine(px) && last >= 0 && k - last > 6) break;
        }
        return last >= 0 ? last + 3 : 0;
      };
      // The rest of a light strip past its last line of words goes with it.
      const extend = (n: number, line: (i: number) => (readonly number[])[], from: "start" | "end", at: number) => {
        let k = at;
        const band = Math.floor(n * 0.18);
        while (at > 0 && k < band && lightLine(line(from === "start" ? k : n - 1 - k))) k += 1;
        return k;
      };
      const left = cut(w, column, "start");
      const right = cut(w, column, "end");
      const top = cut(h, row, "start");
      const bottom = cut(h, row, "end");
      const [l2, r2, t2, b2] = [extend(w, column, "start", left), extend(w, column, "end", right), extend(h, row, "start", top), extend(h, row, "end", bottom)];
      if (l2 + r2 + t2 + b2 === 0) return null;
      const nw = w - l2 - r2, nh = h - t2 - b2;
      if (nw < w * 0.6 || nh < h * 0.6) return null;
      const out = document.createElement("canvas");
      out.width = nw;
      out.height = nh;
      out.getContext("2d")!.drawImage(canvas, l2, t2, nw, nh, 0, 0, nw, nh);
      return out.toDataURL(dataUri.startsWith("data:image/png") ? "image/png" : "image/jpeg", 0.92);
    }, dataUri);
  } catch {
    return null;
  } finally {
    await context.close();
  }
}

/*
  The design's photos without the design's bits (Jason, 29 September 2026):
  words and drawn marks along a photo's edge (a tab bar, a heart, a letter)
  are trimmed off by code; and the logo is cut again from the page with the
  name and line set under it in the design ("SampleHuskyLady / Five
  Huskies. Endless Adventures."), at the page picture's full sharpness.
*/
export async function cleanPictures(browser: Browser, source: Source): Promise<string[]> {
  const notes: string[] = [];
  type Node = FigmaNode & { absoluteBoundingBox?: { x: number; y: number; width: number; height: number }; characters?: string; fills?: { type: string; imageRef?: string }[] };
  const origin = (source.home as Node).absoluteBoundingBox ?? { x: 0, y: 0, width: source.frame.width, height: source.frame.height };
  const boxOf = (n: Node) => (n.absoluteBoundingBox ? { x: n.absoluteBoundingBox.x - origin.x, y: n.absoluteBoundingBox.y - origin.y, w: n.absoluteBoundingBox.width, h: n.absoluteBoundingBox.height } : null);
  const photos: { ref: string; box: { x: number; y: number; w: number; h: number } }[] = [];
  const marks: { x: number; y: number; w: number; h: number }[] = [];
  const texts: { text: string; box: { x: number; y: number; w: number; h: number } }[] = [];
  const walk = (n: Node) => {
    const box = boxOf(n);
    const ref = n.fills?.find((f) => f.type === "IMAGE" && f.imageRef)?.imageRef;
    if (box && ref && source.byImageRef[ref]) photos.push({ ref, box });
    if (box && n.type === "TEXT" && (n.characters ?? "").trim()) {
      marks.push(box);
      texts.push({ text: n.characters!.trim(), box });
    }
    if (box && source.byNodeId[n.id]) marks.push(box);
    for (const c of (n.children ?? []) as Node[]) walk(c);
  };
  walk(source.home as Node);
  const done = new Set<string>();
  for (const photo of photos) {
    if (done.has(photo.ref)) continue;
    done.add(photo.ref);
    const token = source.byImageRef[photo.ref]!;
    // nosemgrep: ajinabraham.njsscan.crypto.timing_attack_node.node_timing_attack -- a photo token, not a secret
    const asset = source.assets.find((a) => a.token === token);
    if (!asset) continue;
    // What the read knows really overlaps the photo (not just its neighbours).
    const inside = (m: { x: number; y: number; w: number; h: number }) => Math.min(m.x + m.w, photo.box.x + photo.box.w) - Math.max(m.x, photo.box.x) > 2 && Math.min(m.y + m.h, photo.box.y + photo.box.h) - Math.max(m.y, photo.box.y) > 2;
    const others = marks.filter((m) => inside(m) && !(m.x <= photo.box.x && m.y <= photo.box.y && m.x + m.w >= photo.box.x + photo.box.w && m.y + m.h >= photo.box.y + photo.box.h));
    const clear = clearArea(photo.box, others, { margin: 8 });
    let trimmed = false;
    if (clear) {
      // The asset covers the photo's box: the clean part, as a share of it.
      const rel = { x: clear.x - photo.box.x, y: clear.y - photo.box.y, w: clear.w, h: clear.h };
      const cut = await cutBox(browser, asset.dataUri, rel, photo.box.w);
      if (cut) {
        asset.dataUri = cut;
        trimmed = true;
      }
    }
    // Then by its pixels: design ink left along an edge.
    const edges = await trimDesignEdges(browser, asset.dataUri);
    if (edges) {
      asset.dataUri = edges;
      trimmed = true;
    }
    if (trimmed) notes.push(`A photo (${token.replace("tawd-asset:", "")}) was trimmed to leave out the design's words or marks at its edge.`);
  }
  // The logo, with the name and line under it.
  const logoId = Object.entries(source.byNodeId).find(([, t]) => t === "tawd-asset:design-logo")?.[0];
  const findNode = (n: Node): Node | null => (n.id === logoId ? n : ((n.children ?? []) as Node[]).map(findNode).find(Boolean) ?? null);
  const logoNode = logoId ? findNode(source.home as Node) : null;
  const logoBox = logoNode ? boxOf(logoNode) : null;
  const logoAsset = source.assets.find((a) => a.token === "tawd-asset:design-logo");
  if (logoBox && logoAsset) {
    const under = texts.filter((t) => t.box.y >= logoBox.y + logoBox.h * 0.5 && t.box.y <= logoBox.y + logoBox.h + 60 && Math.min(t.box.x + t.box.w, logoBox.x + logoBox.w) - Math.max(t.box.x, logoBox.x) > t.box.w * 0.5);
    if (under.length) {
      const all = [logoBox, ...under.map((t) => t.box)];
      const x = Math.max(0, Math.min(...all.map((b) => b.x)) - 4);
      const y = Math.max(0, Math.min(...all.map((b) => b.y)) - 4);
      const box = { x, y, w: Math.max(...all.map((b) => b.x + b.w)) - x + 4, h: Math.max(...all.map((b) => b.y + b.h)) - y + 4 };
      const cut = await cutBox(browser, `data:image/png;base64,${source.picture.toString("base64")}`, box, source.frame.width);
      if (cut) {
        logoAsset.dataUri = cut;
        notes.push(`The logo includes the words under it in the design (${under.map((t) => `"${t.text}"`).join(", ")}).`);
      }
    }
  }
  return notes;
}

/* The page's tokens renamed to the page's own ("tawd-asset:mia-design-image-2"): every page names its pictures from 1. */
function pageTokens(source: Source, slug: string) {
  const rename = (token: string) => `tawd-asset:${slugKey(slug)}-${token.replace("tawd-asset:", "")}`;
  const byImageRef = Object.fromEntries(Object.entries(source.byImageRef).map(([ref, token]) => [ref, rename(token)]));
  const images = source.assets.map((asset) => {
    const match = /^data:([^;]+);base64,([\s\S]*)$/.exec(asset.dataUri);
    const ext = match?.[1]?.includes("png") ? "png" : match?.[1]?.includes("svg") ? "svg" : match?.[1]?.includes("webp") ? "webp" : "jpg";
    const token = rename(asset.token);
    return { token, path: `/images/${slugKey(slug)}/${asset.token.replace("tawd-asset:", "")}.${ext}`, bytes: Buffer.from(match?.[2] ?? "", "base64"), kind: asset.token.includes("logo") ? "logo" : "photo" };
  });
  return { byImageRef, images };
}

/* Where each photo is on the page, for the builder. */
function photoList(source: Source, byImageRef: Record<string, string>, logo: string | null): string {
  const origin = source.home.absoluteBoundingBox ?? { x: 0, y: 0, width: 0, height: 0 };
  const sections = frameSections(source.home);
  const lines: string[] = [];
  const walk = (n: FigmaNode) => {
    const b = n.absoluteBoundingBox;
    for (const fill of n.fills ?? []) {
      if (fill.type !== "IMAGE" || !fill.imageRef || !b) continue;
      const token = byImageRef[fill.imageRef];
      if (!token) continue;
      const y = Math.round(b.y - origin.y);
      const section = sections.find((s) => y >= s.top && y < s.top + s.height)?.name ?? "the page";
      lines.push(`- ${token}: in "${section}", ${Math.round(b.width)}x${Math.round(b.height)} at ${Math.round(b.x - origin.x)},${y - (sections.find((s) => s.name === section)?.top ?? 0)}`);
    }
    for (const child of n.children ?? []) walk(child);
  };
  walk(source.home);
  if (logo) lines.unshift(`- ${logo}: the logo`);
  return [...new Set(lines)].join("\n");
}

export async function currentKit(browser: Browser, projectId: string, version: string): Promise<{ id: string; kit: StyleKit }> {
  const db = getDb();
  const find = async () =>
    (
      await db
        .select()
        .from(styleKit)
        .where(and(eq(styleKit.projectId, projectId), eq(styleKit.status, "done"), eq(styleKit.designVersion, version)))
        .orderBy(desc(styleKit.createdAt))
        .limit(1)
    )[0];
  let row = await find();
  if (!row) {
    // Built quietly, $0: the kit is read from the design by code.
    const [queued] = await db.insert(styleKit).values({ projectId, designVersion: version }).returning({ id: styleKit.id });
    try {
      await runStyleKitJob(db as never, browser, { kitId: queued!.id, projectId });
    } catch (error) {
      // Marked failed with its reason (5 November 2026, gap 8: five of New Dawn's kits stayed "working" for ever), and said in plain words.
      const reason = error instanceof Error ? error.message : "The style kit didn't finish.";
      await markStyleKitFailed(db as never, queued!.id, reason).catch(() => undefined);
      throw new SiteBuildError(`The design's style kit couldn't be made: ${reason}`, { cause: error });
    }
    row = await find();
  }
  if (!row?.kit) throw new SiteBuildError("The design's style kit couldn't be read. Try again, or ask an admin to look at the design.");
  return { id: row.id, kit: row.kit as StyleKit };
}

/*
  The automatic check of a built page (29 September 2026), before the team
  sees it: at a phone's width and a computer's, broken pictures, text lying
  over other text or cut off, small tap targets and sideways scrolling.
  What code fixed while building (icons, links) is noted where it happened;
  these are the flags left for the Preview, in plain words.
*/
export async function checkBuiltPage(browser: Browser, url: string): Promise<string[]> {
  const phone = await phoneCheck(browser, url, [], 390);
  const computer = await phoneCheck(browser, url, [], 1440);
  const words = (p: { kind: string; detail: string }) => `${p.kind[0]!.toUpperCase()}${p.kind.slice(1)}: ${p.detail}.`;
  const out = [
    ...computer.problems.filter((p) => p.kind !== "small tap target" && p.kind !== "sideways scrolling").slice(0, 6).map((p) => `On a computer: ${words(p)}`),
    ...phone.problems.slice(0, 6).map((p) => `On a phone: ${words(p)}`),
  ];
  const more = computer.problems.length + phone.problems.length - out.length;
  if (more > 0) out.push(`And ${more} more like these.`);
  return out;
}

/* The main of a page, from a whole document (what the fill returns). */
const mainOf = (html: string) => /<main\b[\s\S]*<\/main>/i.exec(html)?.[0] ?? html;

export async function designSite(
  browser: Browser,
  config: WorkerConfig,
  client: Anthropic,
  build: typeof siteBuild.$inferSelect,
  options: DesignBuildOptions,
  onStep: (step: string) => Promise<void>,
): Promise<DesignSite> {
  const db = getDb();
  const storage = getStorage();
  const [row] = await db.select().from(project).where(eq(project.id, build.projectId)).limit(1);
  if (!row) throw new SiteBuildError("That project no longer exists.");
  const [figma] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, build.projectId)).limit(1);
  if (!figma?.importedVersion) throw new SiteBuildError("Upload the design first; the site is built from it.");
  const rows = await db
    .select()
    .from(designPage)
    .where(and(eq(designPage.projectId, build.projectId), eq(designPage.figmaVersion, figma.importedVersion)))
    .orderBy(asc(designPage.position));
  if (rows.length === 0) throw new SiteBuildError("The design's pages aren't set up yet. Check them on Mockups first.");
  const home = rows.find((r) => r.isHome) ?? rows[0]!;

  await onStep("Reading the design's colours, fonts and icons");
  const { kit } = await currentKit(browser, build.projectId, figma.importedVersion);
  // A build stops itself at twice its estimate (29 September 2026).
  // A free check (dryRun) lists the calls it would make instead of making them.
  const dryPlan: { step: string; label: string; reused: boolean }[] = [];
  const ledger = { projectId: build.projectId, runId: build.id, startedByUserId: build.startedByUserId, stopAbove: options.estimate ? options.estimate * 2 : undefined, dryRun: options.dryRun ? dryPlan : undefined };
  const plan: SitePlanPage[] = rows.map((r) => ({ name: r.name, kind: r.isHome ? "home" : "page", slug: r.isHome ? "" : r.slug }));
  const videos = (row.videos as SiteVideo[] | null) ?? [];
  if (videos.length && !plan.some((p) => p.slug === "videos")) plan.push({ name: "Videos", kind: "page", slug: "videos" });

  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: buildDesignSiteSystemPrompt({ profileText: await readProfile(config.skillsDir), kit: describeKit(kit), clientName: row.clientName }), cache_control: CACHE_1H },
  ];

  // What the last build of the design kept: its parts and pages, used for pages not built now.
  const [last] = await db
    .select()
    .from(siteBuild)
    .where(and(eq(siteBuild.projectId, build.projectId), eq(siteBuild.status, "done")))
    .orderBy(desc(siteBuild.version))
    .limit(1);
  const lastPrefix = last && (last.options as DesignBuildOptions | null)?.kind === "design" ? `${projectStoragePrefix(build.projectId)}site/v${last.version}/_source/` : null;
  const kept = async (file: string) => (lastPrefix ? (await storage.get(`${lastPrefix}${file}`))?.toString("utf8") ?? null : null);

  const images: (SiteImage & { bytes: Buffer })[] = [];
  const notes = new Map<string, string[]>();
  const designKeys = new Map<string, string>();
  const note = (slug: string, text: string) => notes.set(slugKey(slug), [...(notes.get(slugKey(slug)) ?? []), text]);
  const sources = new Map<string, Source>();
  const source = async (r: (typeof rows)[number]) => {
    if (!sources.has(r.id)) {
      const loaded = await loadDesignSource(db, storage, browser, { projectId: build.projectId, frameId: r.frameId, frameName: r.frameName, purpose: "build the site" });
      // The design's bits trimmed off its photos, and the logo with its name (by code, before anything else uses them).
      for (const n of await cleanPictures(browser, loaded).catch(() => [] as string[])) note(r.isHome ? "" : r.slug, n);
      sources.set(r.id, loaded);
    }
    return sources.get(r.id)!;
  };

  // Every page's pictures first, checked and written to a scratch folder before any AI call: a missing one stops the build for $0.
  const tokensOf = new Map<string, ReturnType<typeof pageTokens>>();
  const lost: string[] = [];
  // The client's own logo and photos from the intake, wherever the design used them (sharper than the design's crops).
  await onStep("Matching the design's photos to the originals in the intake");
  const originals = await loadOriginals(db, storage, build.projectId);
  if (originals.logo || originals.photos.length) {
    for (const r of rows) {
      const src = await source(r);
      for (const swap of await useOriginals(browser, originals, src.assets).catch(() => [])) note(r.isHome ? "" : r.slug, swap.note);
    }
  }
  for (const r of rows) {
    const src = await source(r);
    const t = pageTokens(src, r.isHome ? "" : r.slug);
    tokensOf.set(r.id, t);
    images.push(...t.images);
    // A picture the design uses but storage no longer has (it would be skipped quietly and show as missing).
    const have = new Set(src.assets.map((a) => a.token));
    const used = new Set([...Object.values(src.byImageRef), ...Object.values(src.byNodeId)]);
    for (const token of used) if (!have.has(token)) lost.push(`${r.name}: ${token.replace("tawd-asset:", "")}`);
  }
  if (lost.length) throw new SiteBuildError(`Some of the design's pictures are missing from storage (${lost.slice(0, 5).join("; ")}${lost.length > 5 ? `; and ${lost.length - 5} more` : ""}). Import the design again, then build. Nothing was spent.`);
  await onStep("Checking the design's pictures");
  await checkSiteImages(images);
  // Answers an unfinished build already paid for, reused for $0 when the question is the same.
  const reuse = await ReusePool.load(build.projectId, build.id);

  // Option B: the suggestions the team accepted from the newest finished review, for the page it reviewed.
  const accepted = new Map<string, AcceptedChange[]>();
  if (row.laneOption === "b") {
    const [review] = await db.select().from(designReview).where(eq(designReview.projectId, build.projectId)).orderBy(desc(designReview.createdAt)).limit(1);
    if (review?.status === "done") {
      const rowsOf = await db.select().from(designFinding).where(and(eq(designFinding.reviewId, review.id), eq(designFinding.ticked, true))).orderBy(asc(designFinding.number));
      const changes = rowsOf.filter((f) => f.grade !== "confirm_fact").map((f) => ({ title: f.title, change: f.change, where: f.layerName }));
      if (changes.length) accepted.set(review.frameId, changes);
    }
  }

  // The header and footer: kept from the last build unless there is none, from the top and bottom of the home page's design.
  const homeSource = await source(home);
  const homeTokens = tokensOf.get(home.id)!;
  let parts: { header: string; footer: string } | null = null;
  const keptParts = await kept("parts.json");
  if (keptParts && !options.rework && options.only?.length) parts = JSON.parse(keptParts) as { header: string; footer: string };
  if (options.rework && keptParts) parts = JSON.parse(keptParts) as { header: string; footer: string };
  if (!parts) {
    await onStep("Building the header and footer");
    const { header, footer } = chrome(homeSource.home);
    const sections = frameSections(homeSource.home);
    const words = designTextsBySection(homeSource.home);
    const headerBottom = header.length ? sections[header[header.length - 1]!]!.top + sections[header[header.length - 1]!]!.height : 200;
    const footerTop = footer.length ? sections[footer[0]!]!.top : homeSource.frame.height - 300;
    const top = await cropPicture(browser, homeSource.picture, { top: 0, height: headerBottom, sourceWidth: homeSource.frame.width });
    const bottom = await cropPicture(browser, homeSource.picture, { top: footerTop, height: homeSource.frame.height - footerTop, sourceWidth: homeSource.frame.width });
    const logo = homeTokens.images.find((i) => i.kind === "logo")?.token ?? null;
    const content: Anthropic.ContentBlockParam[] = [
      { type: "text", text: "The top of the home page's design:" },
      ...top.map(jpeg),
      { type: "text", text: "The bottom of the home page's design:" },
      ...bottom.map(jpeg),
      {
        type: "text",
        text: `${logo ? `The logo: ${logo}.\n\n` : ""}${buildDesignPartsPrompt({
          pages: plan,
          clientName: row.clientName,
          headerWords: header.flatMap((i) => words[i]?.texts ?? []),
          footerWords: footer.flatMap((i) => words[i]?.texts ?? []),
        })}`,
      },
    ];
    const before = reuse.used;
    parts = await ask(client, config, system, content, readPartsReply, { ...ledger, step: "design_site_parts", label: "The header and footer", reuse });
    if (reuse.used > before) note("", "The header and footer: the answer the last, unfinished build paid for, reused ($0).");
  }

  // The pages: built, filled from a page that shares the layout, reworked, or kept.
  const groups = kit.sharedLayouts ?? [];
  const mains: string[] = [];
  const built = new Map<string, string>();
  const want = (r: (typeof rows)[number]) => !options.only?.length || options.only.includes(slugKey(r.isHome ? "" : r.slug));
  for (const [index, r] of rows.entries()) {
    const slug = r.isHome ? "" : r.slug;
    const src = await source(r);
    const tokens = tokensOf.get(r.id)!;
    const frame = (src.frame as { imageKey?: string }).imageKey;
    if (frame) designKeys.set(slugKey(slug), frame);
    const page = plan[index]!;
    const rework = options.rework && options.rework.slug === slugKey(slug) ? options.rework : null;
    const keptMain = await kept(`pages/${slugKey(slug)}.html`);
    // Not asked for this time (or another page is being reworked): kept as it was, or not built yet. Never a paid call nobody asked for.
    if (!rework && (!want(r) || options.rework)) {
      if (keptMain) mains.push(keptMain);
      else {
        mains.push("");
        note(slug, "Not built yet.");
      }
      continue;
    }
    const slices = await cropPicture(browser, src.picture, { top: 0, height: src.frame.height, sourceWidth: src.frame.width });
    if (rework) {
      await onStep(`Reworking ${r.name}`);
      if (!keptMain) throw new SiteBuildError(`${r.name} hasn't been built yet: build it first, then give feedback.`);
      const content: Anthropic.ContentBlockParam[] = [...slices.map(jpeg), { type: "text", text: buildDesignReworkPrompt({ page, pages: plan, currentMain: keptMain, feedback: rework.feedback }) }];
      mains.push(await ask(client, config, system, content, readPageReply, { ...ledger, step: "design_site_rework", label: r.name, reuse }));
      continue;
    }
    // A page that shares its layout with one built this time is filled from it, by code.
    const group = groups.find((g) => g.pages.includes(r.frameId) && g.pages[0] !== r.frameId);
    const template = group ? rows.find((x) => x.frameId === group.pages[0]) : undefined;
    const templateMain = template ? built.get(template.id) : undefined;
    if (template && templateMain) {
      await onStep(`Filling ${r.name} from ${template.name} (same layout, by code)`);
      const tSrc = await source(template);
      const tTokens = tokensOf.get(template.id) ?? pageTokens(tSrc, template.isHome ? "" : template.slug);
      const fill = planFill({ frame: tSrc.home, byImageRef: tTokens.byImageRef, name: template.name }, { frame: src.home, byImageRef: tokens.byImageRef, name: r.name });
      const filled = await fillInBrowser(browser, `<!doctype html><html><body>${templateMain}</body></html>`, fill);
      const main = mainOf(filled.html).split(`page-${slugKey(template.isHome ? "" : template.slug)}`).join(`page-${slugKey(slug)}`);
      mains.push(main);
      built.set(r.id, main);
      if (fill.unmatched.length) note(slug, `Filled from ${template.name}; these words of its design had no place and are missing: ${fill.unmatched.slice(0, 6).join("; ")}.`);
      continue;
    }
    await onStep(`Building page ${index + 1} of ${rows.length}: ${r.name}`);
    const words = designTextsBySection(src.home);
    const { header, footer } = chrome(src.home);
    const logo = tokens.images.find((i) => i.kind === "logo")?.token ?? null;
    const content: Anthropic.ContentBlockParam[] = [
      ...slices.map(jpeg),
      {
        type: "text",
        text: buildDesignPagePrompt({
          page,
          pages: plan,
          words: { sections: words.filter((_, i) => !header.includes(i) && !footer.includes(i)).map((s) => ({ name: s.name, texts: s.texts })) },
          photos: photoList(src, tokens.byImageRef, logo),
          slices: slices.length,
          changes: accepted.get(r.frameId),
        }),
      },
    ];
    const before = reuse.used;
    const main = await ask(client, config, system, content, readPageReply, { ...ledger, step: "design_site_page", label: r.name, reuse });
    if (reuse.used > before) note(slug, "Built from the answer the last, unfinished build paid for, reused ($0).");
    mains.push(main);
    built.set(r.id, main);
  }

  // By code, $0: the kit's icons into the markers; words and links tidied; the videos.
  const sitePages = plan.map((p) => ({ name: p.name, path: p.slug ? `/${p.slug}/` : "/" }));
  const tidyInput = { pages: sitePages, names: [], privacyPath: PRIVACY_POLICY_PATH, cookiePath: COOKIE_POLICY_PATH, extraLinks: Object.entries((figma.linkRules as Record<string, string> | null) ?? {}).map(([match, path]) => ({ match, path })) };
  const fillIcons = (html: string, where: string) => {
    // Gap 9: an icon the AI named that the design's own kit doesn't have is filled from TAWD's own set, not removed.
    const { html: out, unknownIcons } = applyKit(html, kit, "", { fillUnknown: true });
    for (const ref of unknownIcons) note(where, `An icon (${ref}) isn't in the design's kit; filled from TAWD's own set.`);
    return out.replace(/<style data-kit><\/style>/, "");
  };
  const tidyWrapped = async (fragment: string, where: string) => {
    const { html, report } = await tidyPage(browser, `<!doctype html><html><body>${fragment}</body></html>`, tidyInput);
    // One line per page: the links that don't say where they go, the same words counted once.
    if (report.unresolved.length) {
      const counts = new Map<string, number>();
      for (const u of report.unresolved) counts.set(u.text.replace(/\s+/g, " ").trim(), (counts.get(u.text.replace(/\s+/g, " ").trim()) ?? 0) + 1);
      const list = [...counts.entries()].map(([t, n]) => `"${t}"${n > 1 ? ` (x${n})` : ""}`);
      note(where, `${report.unresolved.length} link${report.unresolved.length === 1 ? " doesn't" : "s don't"} say where ${report.unresolved.length === 1 ? "it goes" : "they go"} yet: ${list.slice(0, 8).join(", ")}${list.length > 8 ? ", ..." : ""}. Say where in this page's feedback, or they stay unlinked.`);
    }
    return /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? fragment;
  };
  const partsHtml = await tidyWrapped(`${fillIcons(parts.header, "home")}${fillIcons(parts.footer, "home")}`, "home");
  const header = /<header\b[\s\S]*<\/header>/i.exec(partsHtml)?.[0] ?? parts.header;
  const footer = /<footer\b[\s\S]*<\/footer>/i.exec(partsHtml)?.[0] ?? parts.footer;
  for (let i = 0; i < mains.length; i += 1) {
    if (!mains[i]) continue;
    const slug = rows[i]!.isHome ? "" : rows[i]!.slug;
    mains[i] = mainOf(await tidyWrapped(fillIcons(mains[i]!, slugKey(slug)), slugKey(slug)));
  }

  let extraCss = "";
  let bodyEnd = "";
  const pages: DesignSite["pages"] = rows.map((r) => ({
    page: {
      id: r.id,
      name: r.name,
      kind: r.isHome ? "home" : "page",
      slug: r.isHome ? "" : r.slug,
      mainKeyword: "",
      title: ((r.seo as { approved?: { title?: string } } | null)?.approved?.title) ?? `${r.isHome ? row.clientName : `${r.name} | ${row.clientName}`}`,
      metaDescription: ((r.seo as { approved?: { description?: string } } | null)?.approved?.description) ?? "",
    },
    copy: "",
  }));
  if (videos.length) {
    extraCss = VIDEO_CSS;
    bodyEnd = VIDEO_SCRIPT;
    const homeIndex = rows.indexOf(home);
    const playRefs = kit.icons.filter((i) => i.label === "player-play" || i.label === "play button").map((i) => i.ref);
    const featured = mains[homeIndex] ? await featureVideos(browser, `<!doctype html><html><body>${mains[homeIndex]}</body></html>`, videos, playRefs) : null;
    if (featured?.html) mains[homeIndex] = mainOf(featured.html);
    const thumbs: (string | null)[] = [];
    for (const [i, v] of videos.entries()) {
      const tiktok = v.platform === "tiktok" ? await tiktokThumbnail(v.url) : null;
      if (tiktok) {
        const path = `/images/videos/${i + 1}.jpg`;
        images.push({ token: `tawd-asset:video-${i + 1}`, path, bytes: tiktok.bytes });
        thumbs.push(path);
        // The whole title (the page cuts it at a word).
        if (!v.title && tiktok.title) v.title = tiktok.title.replace(/\s+/g, " ").trim().slice(0, 300);
      } else {
        const pics = (featured?.pictures ?? []).map((p) => images.find((x) => x.token === p)?.path ?? p);
        thumbs.push(pics.length ? pics[i % pics.length]! : null);
      }
    }
    mains.push(`<main id="main" class="page-videos">${videosPageMain(videos, thumbs).replace(/<\/?main[^>]*>/g, "")}</main>`);
    pages.push({ page: { id: "videos", name: "Videos", kind: "page", slug: "videos", mainKeyword: "", title: `Videos | ${row.clientName}`, metaDescription: `Videos from ${row.clientName}.` }, copy: "" });
  }

  // The kit's fonts as the site's own files, and its styles as the site's stylesheet.
  for (const font of kit.fonts) {
    for (const file of font.files) {
      const path = `/fonts/${file.key.split("/").pop()}`;
      if (images.some((i) => i.path === path)) continue;
      const bytes = await storage.get(file.key);
      if (bytes) images.push({ token: `font:${path}`, path, bytes });
    }
  }
  const design: DesignSystem = {
    css: `${kitCss(kit, (key) => `/fonts/${key.split("/").pop()}`)}\n*,*::before,*::after{box-sizing:border-box}\nbody{margin:0;font-family:var(--kit-font-sans,system-ui,sans-serif)}\nimg{max-width:100%;height:auto}\n${SITE_WIDE_CSS}`,
    fontLinks: [],
    header,
    footer,
    sections: [],
  };
  // Every picture a page points to is in the build; one that isn't (a name the AI made up) is flagged on its page.
  const tokens = new Set(images.map((i) => i.token));
  const flag = (html: string, where: string) => {
    const madeUp = [...new Set([...html.matchAll(/tawd-asset:[\w-]+/g)].map((m) => m[0]))].filter((t) => !tokens.has(t));
    const missing = [...madeUp, ...missingPictures(html, images)];
    if (missing.length) note(where, `${missing.length === 1 ? "A picture this page points to isn't" : `${missing.length} pictures this page points to aren't`} in the design (${missing.slice(0, 4).join(", ")}); ${missing.length === 1 ? "it shows" : "they show"} as missing. Say which picture to use in the feedback.`);
  };
  flag(`${header}${footer}`, "home");
  for (const [i, main] of mains.entries()) if (main && rows[i]) flag(main, slugKey(rows[i]!.isHome ? "" : rows[i]!.slug));
  return { row, plan, pages, parts: { header, footer }, mains, images, design, extraCss, bodyEnd, notes, designKeys, dryPlan };
}
