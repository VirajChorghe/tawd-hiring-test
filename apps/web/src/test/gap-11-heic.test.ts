import { afterEach, describe, expect, it, vi } from "vitest";

// Real isHeic (detects by bytes); the decode is stubbed so no WASM or fixture is
// needed. The real heic-convert decode is verified separately.
vi.mock("@tawd/core/images", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tawd/core/images")>()),
  heicToJpeg: vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])),
}));

import { FakeR2 } from "./worker-fakes";
import {
  currentSitePhotos,
  setSitePhotoReaderForTesting,
  setSitePhotoTrimmerForTesting,
  sitePhotosFolder,
} from "../../../worker/src/site-photos";

/*
  Gap 11: a HEIC/HEIF photo found on the crawl is converted to JPEG at ingress,
  by its bytes (even when it's served as image/jpeg), and the original is kept.
*/

// A minimal HEIC header: ftyp box with the "heic" major brand.
const HEIC = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from("ftypheic", "ascii"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("mif1", "ascii"),
  Buffer.alloc(32, 9),
]);

describe("a HEIC photo found on the crawl", () => {
  afterEach(() => {
    setSitePhotoReaderForTesting(null);
    setSitePhotoTrimmerForTesting(null);
  });

  it("is converted to JPEG (by bytes, even when served as image/jpeg), and the original is kept", async () => {
    const r2 = new FakeR2();
    setSitePhotoTrimmerForTesting(async () => null); // no framing to cut
    const projectId = "3f9c1a2b-5d6e-4f70-8a91-2b3c4d5e6f70";
    const now = new Date("2026-11-06T00:00:00Z");
    const folder = sitePhotosFolder(projectId);
    // One HEIC mislabelled image/jpeg (the iPhone case), one ordinary JPEG.
    const reader = async () => [
      { bytes: HEIC, contentType: "image/jpeg", alt: "awning", width: 1200, height: 800, src: "https://x/1.jpg" },
      { bytes: Buffer.alloc(100, 5), contentType: "image/jpeg", alt: "", width: 1200, height: 800, src: "https://x/2.jpg" },
    ];

    const assets = await currentSitePhotos(r2, { projectId, url: "https://clearskyawning.net/", browser: {} as never, now }, reader);

    // The HEIC one is now a JPEG, under a .jpg key.
    expect(assets[0]!.contentType).toBe("image/jpeg");
    expect(assets[0]!.storageKey).toMatch(/\.jpg$/);
    expect(r2.objects.get(assets[0]!.storageKey)!.equals(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))).toBe(true);
    // The original HEIC is kept beside it.
    const originalKey = `${folder}${now.getTime()}-1.heic`;
    expect(r2.objects.get(originalKey)!.equals(HEIC)).toBe(true);
    const manifest = JSON.parse(r2.objects.get(`${folder}manifest.json`)!.toString());
    expect(manifest.photos[0].sourceHeic).toBe(originalKey);
    // The ordinary JPEG is untouched.
    expect(assets[1]!.contentType).toBe("image/jpeg");
    expect(r2.objects.get(assets[1]!.storageKey)!.equals(Buffer.alloc(100, 5))).toBe(true);
  });

  // Crawl-% photos: a secondary page's own photos are captured under per-page tokens/folder,
  // reusing the exact home-photo pipeline (capture-bytes-at-crawl), separate from the home's.
  it("captures a secondary page's photos under per-page tokens, not the home's", async () => {
    const r2 = new FakeR2();
    setSitePhotoTrimmerForTesting(async () => null);
    const projectId = "3f9c1a2b-5d6e-4f70-8a91-2b3c4d5e6f70";
    const now = new Date("2026-11-06T00:00:00Z");
    const reader = async () => [{ bytes: Buffer.alloc(100, 7), contentType: "image/jpeg", alt: "A retractable awning", width: 1200, height: 800, src: "https://x/aw.jpg" }];
    const assets = await currentSitePhotos(r2, { projectId, url: "https://clearskyawning.net/retractable-awnings/", browser: {} as never, now, pageKey: "retractable-awnings" }, reader);
    expect(assets[0]!.token).toBe("tawd-asset:photo-retractable-awnings-1"); // per-page token, not photo-site-N
    expect(assets[0]!.storageKey.startsWith(sitePhotosFolder(projectId, "retractable-awnings"))).toBe(true);
    expect(assets[0]!.caption).toContain("A retractable awning"); // old alt carried as the caption
    // The home's own folder/manifest is untouched by a per-page capture.
    expect(r2.objects.has(`${sitePhotosFolder(projectId)}manifest.json`)).toBe(false);
  });

  // Crawl-%: a per-page manifest left from an EARLIER site must not be served as this page's photos.
  // The build read passes expectUrl (the current crawl's page url); a stored manifest from another url is rejected.
  it("rejects a stored per-page manifest captured from a different site (expectUrl guard)", async () => {
    const r2 = new FakeR2();
    setSitePhotoTrimmerForTesting(async () => null);
    const projectId = "3f9c1a2b-5d6e-4f70-8a91-2b3c4d5e6f70";
    const reader = async () => [{ bytes: Buffer.alloc(100, 7), contentType: "image/jpeg", alt: "awning", width: 1200, height: 800, src: "https://x/aw.jpg" }];
    // Capture under the OLD site's page url.
    const oldUrl = "https://old-site.example/awnings/";
    const saved = await currentSitePhotos(r2, { projectId, url: oldUrl, browser: {} as never, pageKey: "awnings" }, reader);
    expect(saved).toHaveLength(1);

    const nullReader = async () => [];
    // A later build for a DIFFERENT site's same-path page: stale manifest rejected → no photos (falls back to the shared home photos).
    const stale = await currentSitePhotos(r2, { projectId, url: "https://new-site.example/awnings/", browser: {} as never, storedOnly: true, pageKey: "awnings", expectUrl: "https://new-site.example/awnings/" }, nullReader);
    expect(stale).toHaveLength(0);
    // The same site's build still gets its photos.
    const fresh = await currentSitePhotos(r2, { projectId, url: oldUrl, browser: {} as never, storedOnly: true, pageKey: "awnings", expectUrl: oldUrl }, nullReader);
    expect(fresh).toHaveLength(1);
    // Home photos (no expectUrl) keep their deliberate url-agnostic behaviour (review M3).
    const home = await currentSitePhotos(r2, { projectId, url: "https://whatever.example/awnings/", browser: {} as never, storedOnly: true, pageKey: "awnings" }, nullReader);
    expect(home).toHaveLength(1);
  });
});
