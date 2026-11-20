import { eq } from "drizzle-orm";
import type { Browser } from "playwright-core";

import { figmaDesign } from "@tawd/core/schema";
import type { FileStorage as Storage } from "@tawd/core/intake/storage";
import { cleanFrame, findNode, type FigmaFile, type FigmaNode, type FrameProblem, type Readiness } from "@tawd/core/figma";
import type { ImportedAsset, ImportedFrame } from "@tawd/core/figma/service";

import { prepareAssets, type AssetFile, type PreparedAsset } from "./assets";
import type { Db } from "./pipeline";

/*
  The imported design, ready to build from: the frame's picture, its
  visible layers (nothing hidden or parked outside the frame), and the
  design's photos, logo and icons as the tawd-asset tokens a page uses.
  Shared by the faithful copy and the improved design, so both name the
  same image the same way.
*/

export interface DesignSource {
  frame: ImportedFrame;
  readiness: Readiness;
  picture: Buffer;
  home: FigmaNode;
  byImageRef: Record<string, string>;
  byNodeId: Record<string, string>;
  assets: PreparedAsset[];
  /** Covered, stacked or flattened content left out of the frame (clean-frame.ts). */
  frameProblems: FrameProblem[];
}

export async function loadDesignSource(
  db: Db,
  storage: Storage,
  browser: Browser,
  input: { projectId: string; frameId: string; frameName: string; purpose: string },
): Promise<DesignSource> {
  const missing = `The imported design is missing. Import it again, then ${input.purpose}.`;
  const [figma] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, input.projectId)).limit(1);
  const frame = ((figma?.frames as ImportedFrame[] | null) ?? []).find((f) => f.id === input.frameId);
  const readiness = figma?.readiness as Readiness | null;
  if (!figma?.fileJsonKey || !frame?.imageKey || !readiness) throw new Error(missing);
  const [picture, saved] = await Promise.all([storage.get(frame.imageKey), storage.get(figma.fileJsonKey)]);
  if (!picture || !saved) throw new Error(missing);
  const file = JSON.parse(saved.toString("utf8")) as FigmaFile;
  // Only what a visitor would see: nothing hidden, parked outside the frame or covered;
  // stacked sections once, top to bottom as the page shows them (27 September 2026).
  const found = findNode(file.document, input.frameId);
  const cleaned = found ? cleanFrame(found) : null;
  const home = cleaned?.frame ?? null;
  const frameProblems: FrameProblem[] = cleaned?.problems ?? [];
  if (!home) throw new Error(`The frame "${input.frameName}" is no longer in the saved file. Check and import the design again.`);

  /* ---------- the design's images, as tokens the page uses ---------- */
  const imageFiles = (figma.imageFiles as Record<string, string | null> | null) ?? {};
  const refsInHome = new Set<string>();
  const walk = (n: FigmaNode) => {
    for (const fill of n.fills ?? []) if (fill.type === "IMAGE" && fill.imageRef) refsInHome.add(fill.imageRef);
    for (const child of n.children ?? []) walk(child);
  };
  walk(home);
  const byImageRef: Record<string, string> = {};
  const byNodeId: Record<string, string> = {};
  const files: AssetFile[] = [];
  [...refsInHome].forEach((ref, index) => {
    const key = imageFiles[ref];
    if (!key) return;
    const token = `tawd-asset:design-image-${index + 1}`;
    byImageRef[ref] = token;
    files.push({ kind: "photo", fileName: `design-image-${index + 1}`, contentType: contentTypeOf(key), caption: null, storageKey: key, token });
  });
  const drawn = ((figma.designAssets as ImportedAsset[] | null) ?? []).filter((a) => findNode(home, a.id));
  let icons = 0;
  for (const asset of drawn) {
    const token = asset.kind === "logo" && !Object.values(byNodeId).includes("tawd-asset:design-logo")
      ? "tawd-asset:design-logo"
      : `tawd-asset:design-icon-${++icons}`;
    byNodeId[asset.id] = token;
    files.push({ kind: "logo", fileName: asset.name, contentType: "image/png", caption: asset.name, storageKey: asset.imageKey, token });
  }
  const assets = await prepareAssets(browser, storage, files);
  return { frame, readiness, picture, home, byImageRef, byNodeId, assets, frameProblems };
}

function contentTypeOf(key: string): string {
  if (/\.jpe?g$/i.test(key)) return "image/jpeg";
  if (/\.webp$/i.test(key)) return "image/webp";
  if (/\.gif$/i.test(key)) return "image/gif";
  return "image/png";
}
