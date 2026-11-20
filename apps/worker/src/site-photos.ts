import { createHash } from "node:crypto";

import { projectStoragePrefix } from "@tawd/core/intake/storage";
import { SITE_PHOTO_CAPTION } from "@tawd/core/mockups";
import { heicToJpeg, isHeic } from "@tawd/core/images";
import type { Browser } from "playwright-core";

import type { AssetFile } from "./assets";
import { MAX_SITE_PHOTOS, collectSitePhotos, type SitePhoto } from "./home-look";
import { trimPhotoFraming, type TrimmedPhoto } from "./photo-framing";

/*
  The client's photos from their current website, for the concepts (Jason,
  4 November 2026: "Concepts must use the client's own photos wherever a
  card or section needs an image: no empty cards"). Read once with the
  concept job's browser (home-look.ts collectSitePhotos), saved in the
  project's folder in R2 and reused until the site's address changes, so a
  run's second concept, its later versions and a re-run see the same photos
  under the same tokens (tawd-asset:photo-site-N, never shifted by a new
  upload). $0, about 10 seconds the first time.

  Each is captioned "from the client's current website", so the builder and
  the team can tell them from the intake's uploads: a photo on the client's
  site is usually theirs, but can be stock they licensed.
*/

export const SITE_PHOTOS_CAPTION = SITE_PHOTO_CAPTION;

interface StoredPhoto {
  key: string;
  contentType: string;
  alt: string;
  width: number;
  height: number;
  /** The photo as read from the site, when `key` is a copy with its framing cut off (gap 10): kept so a cut can be undone or redone. */
  original?: { key: string; width: number; height: number };
  /** The HEIC/HEIF the photo was read as, when it was converted to JPEG at ingress (gap 11): kept, though nothing downstream reads it. */
  sourceHeic?: string;
}

interface Manifest {
  url: string;
  at: string;
  photos: StoredPhoto[];
  /** The framing check these photos have had (gap 10); missing on photos saved before it, which get it once on their next use. */
  framing?: number;
}

/* Raised when the framing check changes, so photos saved under an older one are checked again. */
// v2: the composed-canvas pass (#3, 8 November 2026) — saved photos re-try the cut from their originals on next use.
export const FRAMING_VERSION = 2;

interface PhotoStorage {
  get(key: string): Promise<Buffer | null>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
}

export function sitePhotosFolder(projectId: string, pageKey?: string): string {
  // The home page's photos keep their own folder; a secondary page's own photos (crawl-%) sit under page-photos/<key>/.
  return pageKey ? `${projectStoragePrefix(projectId)}page-photos/${pageKey}/` : `${projectStoragePrefix(projectId)}current-site-photos/`;
}

/* The most of the old site's pages whose own photos are captured (crawl-%), so an unusually large site can't balloon the concept run. */
export const MAX_PAGE_PHOTO_PAGES = 6;
/* The old-page kinds worth their own photos: services and area/city/about pages (not FAQ, pricing, contact, blog). */
export const PAGE_PHOTO_KINDS = new Set(["service", "service_areas", "city", "about"]);

/*
  A safe per-page key from an old page's path ("/retractable-awnings/" →
  "retractable-awnings-1a2b3c4d"), for its photo folder and tokens. A short
  hash of the full path is appended so two distinct paths that sanitize to the
  same readable stem (e.g. "/a/b/" and "/a-b/", or two long paths cut at the
  same point) never collide — a collision would let one page's photos and
  source be assigned to another. Pure in the path, so capture and the build
  read derive the same key.
*/
export function pagePhotoKey(path: string): string {
  const readable = path
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  // SHA-256 (not SHA-1): a content key to disambiguate paths, not a security hash, but the strong one keeps the weak-hash scanner quiet.
  const hash = createHash("sha256").update(path).digest("hex").slice(0, 8);
  return readable ? `${readable}-${hash}` : hash;
}

/* "newdawnawning.net" and "https://newdawnawning.net/" are the same site. */
export function siteAddress(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

const extension = (contentType: string) => (/png/i.test(contentType) ? "png" : /webp/i.test(contentType) ? "webp" : "jpg");

/* The current site's photos keep tokens of their own, so an upload added later never moves them. A page's own photos (crawl-%) get a per-page token so they don't collide with the home's. */
export function sitePhotoToken(index: number, pageKey?: string): string {
  return pageKey ? `tawd-asset:photo-${pageKey}-${index + 1}` : `tawd-asset:photo-site-${index + 1}`;
}

export function sitePhotoAssets(photos: StoredPhoto[], pageKey?: string): AssetFile[] {
  return photos.map((photo, i) => ({
    kind: "photo",
    token: sitePhotoToken(i, pageKey),
    fileName: `${pageKey ? `page-${pageKey}-photo` : "current-site-photo"}-${i + 1}.${extension(photo.contentType)}`,
    contentType: photo.contentType,
    caption: photo.alt ? `${SITE_PHOTOS_CAPTION}: ${photo.alt}` : SITE_PHOTOS_CAPTION,
    storageKey: photo.key,
  }));
}

type SitePhotoReader = (browser: Browser, url: string) => Promise<SitePhoto[]>;
let readerForTesting: SitePhotoReader | null = null;

/* Tests stand in for the browser; without one, a test run never reads a real website. */
export function setSitePhotoReaderForTesting(reader: SitePhotoReader | null): void {
  readerForTesting = reader;
}

/* The framing cut, by the browser (photo-framing.ts); tests stand in for it. Null: nothing to cut. */
type FramingTrimmer = (browser: Browser, bytes: Buffer, contentType: string) => Promise<TrimmedPhoto | null>;
let trimmerForTesting: FramingTrimmer | null = null;

export function setSitePhotoTrimmerForTesting(trimmer: FramingTrimmer | null): void {
  trimmerForTesting = trimmer;
}

const trimmer = (): FramingTrimmer => trimmerForTesting ?? (process.env.VITEST ? async () => null : trimPhotoFraming);

/*
  One photo checked for framing (gap 10). `checked` is false when the check
  itself failed (a browser error): the photo is kept as it was and checked
  again on its next use, never recorded as done (review M4).
*/
async function framed(browser: Browser, photo: { bytes: Buffer; contentType: string; width: number; height: number }) {
  try {
    const result = await trimmer()(browser, photo.bytes, photo.contentType);
    if (!result) return { checked: true, cut: null };
    return {
      checked: true,
      cut: {
        bytes: result.bytes,
        // A background photo's size is its size on the page, so the cut is applied as a share.
        width: Math.max(1, Math.round(photo.width * result.kept.width)),
        height: Math.max(1, Math.round(photo.height * result.kept.height)),
      },
    };
  } catch {
    return { checked: false, cut: null };
  }
}

/* The cut copy's key: next to the original, named by the check's version, so a later version cuts the original again (never a cut copy). */
const framedKey = (originalKey: string) => originalKey.replace(/(\.\w+)$/, `-framed-v${FRAMING_VERSION}$1`);

/* A saved photo through the current framing check, always from its original. `ok` is false when it couldn't be checked. */
async function recheck(storage: PhotoStorage, browser: Browser, photo: StoredPhoto): Promise<{ photo: StoredPhoto; ok: boolean }> {
  const original = photo.original ?? { key: photo.key, width: photo.width, height: photo.height };
  const bytes = await storage.get(original.key).catch(() => null);
  if (!bytes) return { photo, ok: false };
  const result = await framed(browser, { bytes, contentType: photo.contentType, width: original.width, height: original.height });
  if (!result.checked) return { photo, ok: false };
  if (!result.cut) return { photo: { key: original.key, contentType: photo.contentType, alt: photo.alt, width: original.width, height: original.height }, ok: true };
  const key = framedKey(original.key);
  try {
    await storage.put(key, result.cut.bytes, photo.contentType);
  } catch {
    return { photo, ok: false };
  }
  return { photo: { key, contentType: photo.contentType, alt: photo.alt, width: result.cut.width, height: result.cut.height, original }, ok: true };
}

/*
  The client's current site's photos (read once, then reused until the
  address changes). `storedOnly` (Build A, gap 10): only the photos already
  saved for the concepts, never a fresh read of the website, so the site is
  built with exactly the photos its approved concept used: whatever address
  they were read from (the field may have been edited since), and a storage
  error stops the job with its reason instead of building without them
  (review M3).
*/
export async function currentSitePhotos(
  storage: PhotoStorage,
  input: { projectId: string; url: string; browser: Browser; now?: Date; storedOnly?: boolean; pageKey?: string; expectUrl?: string },
  read: SitePhotoReader = readerForTesting ?? (process.env.VITEST ? async () => [] : collectSitePhotos),
): Promise<AssetFile[]> {
  const folder = sitePhotosFolder(input.projectId, input.pageKey);
  const manifestKey = `${folder}manifest.json`;
  const now = input.now ?? new Date();
  const save = (manifest: Manifest) => storage.put(manifestKey, Buffer.from(JSON.stringify(manifest)), "application/json").catch(() => undefined);
  let manifest: Manifest | null = null;
  try {
    const saved = await storage.get(manifestKey);
    if (saved) manifest = JSON.parse(saved.toString("utf8")) as Manifest;
  } catch (error) {
    if (input.storedOnly) throw new Error(`The photos from the client's current website couldn't be read from storage (${error instanceof Error ? error.message : "unknown"}). Try again.`, { cause: error });
    // A concept reads the site again below.
  }
  // storedOnly reuses whatever was captured for this folder regardless of the current url (the home's
  // address field may have been edited since the concepts, review M3). A per-page read passes expectUrl
  // (the current crawl's page url): a manifest left from an EARLIER site (a same-path page skipped or
  // failed on the later concept run) is then rejected, so the build never serves the old site's photos.
  const manifestUsable = !!manifest && (manifest.url === input.url || (!!input.storedOnly && (input.expectUrl === undefined || manifest.url === input.expectUrl)));
  if (manifest && manifestUsable) {
    if (manifest.framing === FRAMING_VERSION) return sitePhotoAssets(manifest.photos, input.pageKey);
    // Saved under an older framing check (or none): each photo is checked from its original (the website isn't read again).
    const photos: StoredPhoto[] = [];
    let allChecked = true;
    for (const photo of manifest.photos) {
      const result = await recheck(storage, input.browser, photo);
      photos.push(result.photo);
      allChecked &&= result.ok;
    }
    // Recorded as done only when every photo was really checked; otherwise the next use tries the rest again.
    await save({ ...manifest, photos, ...(allChecked ? { framing: FRAMING_VERSION } : {}) });
    return sitePhotoAssets(photos, input.pageKey);
  }
  if (input.storedOnly) return [];
  const found = (await read(input.browser, input.url)).slice(0, MAX_SITE_PHOTOS);
  const stamp = now.getTime();
  const photos: StoredPhoto[] = [];
  let allChecked = true;
  for (const [i, found0] of found.entries()) {
    let photo = found0;
    let sourceHeic: string | undefined;
    try {
      // HEIC/HEIF (the iPhone default) can't be rendered or shown, so it's
      // converted to JPEG at ingress (gap 11) and the original is kept beside it.
      // Detected by the bytes, never the content type or file name.
      if (isHeic(photo.bytes)) {
        sourceHeic = `${folder}${stamp}-${i + 1}.heic`;
        await storage.put(sourceHeic, photo.bytes, "image/heic");
        photo = { ...photo, bytes: await heicToJpeg(photo.bytes), contentType: "image/jpeg" };
      }
    } catch (error) {
      console.warn(`[site photos] a HEIC photo couldn't be converted (${error instanceof Error ? error.message : "unknown"}); skipped.`);
      continue;
    }
    const key = `${folder}${stamp}-${i + 1}.${extension(photo.contentType)}`;
    try {
      // The photo as read is always kept; a cut copy sits beside it (review M2).
      await storage.put(key, photo.bytes, photo.contentType);
      const result = await framed(input.browser, photo);
      allChecked &&= result.checked;
      const stored: StoredPhoto = { key, contentType: photo.contentType, alt: photo.alt, width: photo.width, height: photo.height, ...(sourceHeic ? { sourceHeic } : {}) };
      if (result.cut) {
        try {
          await storage.put(framedKey(key), result.cut.bytes, photo.contentType);
          photos.push({ ...stored, key: framedKey(key), width: result.cut.width, height: result.cut.height, original: { key, width: photo.width, height: photo.height } });
          continue;
        } catch {
          allChecked = false;
        }
      }
      photos.push(stored);
    } catch (error) {
      console.warn(`[site photos] one photo couldn't be saved (${error instanceof Error ? error.message : "unknown"}); skipped.`);
    }
  }
  // Saved even when empty, so a site with no photos isn't read again for every concept.
  await save({ url: input.url, at: now.toISOString(), photos, ...(allChecked ? { framing: FRAMING_VERSION } : {}) });
  return sitePhotoAssets(photos, input.pageKey);
}
