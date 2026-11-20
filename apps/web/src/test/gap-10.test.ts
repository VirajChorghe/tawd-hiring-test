import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/*
  Gap 10 (5 November 2026, Clear Sky Awning's makeover concepts held at 4.1
  and 3.8): the Critique and polish step crashed on a mislabelled picture,
  the built site never got the client's photos the concepts used, those
  photos kept the old site's navy and orange framing, and the main service
  got a wrench.
*/

import { setDbForTesting, type Database } from "@tawd/core/db";
import { intakeFile, mockupRun } from "@tawd/core/schema";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { checkIcons, fillIcons, iconFor, iconWordsWithNoIcon, isFixable, UNKNOWN_ICON } from "@tawd/core/mockups";
import { setEncryptionKeyForTesting } from "@tawd/core/secrets";
import { createProject } from "@/lib/projects";
import { setQueueForTesting } from "@/lib/mockups";

import { imageBlock, imageMediaType } from "../../../worker/src/image-type";
import { findFraming } from "../../../worker/src/photo-framing";
import { loadProjectContext } from "../../../worker/src/pipeline";
import { FRAMING_VERSION, currentSitePhotos, setSitePhotoReaderForTesting, setSitePhotoTrimmerForTesting, sitePhotosFolder } from "../../../worker/src/site-photos";
import type { WorkerConfig } from "../../../worker/src/config";

import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2, fakeBrowser } from "./worker-fakes";

const WORKER_SRC = path.resolve(__dirname, "../../../worker/src");

/* ---------- 1. the polish step's pictures ---------- */

describe("pictures for the AI are labelled by their bytes", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);

  it("knows a JPEG, a PNG and a WebP, and labels each as what it is", () => {
    expect(imageMediaType(jpeg)).toBe("image/jpeg");
    expect(imageMediaType(png)).toBe("image/png");
    expect(imageMediaType(webp)).toBe("image/webp");
    // The review's renders are JPEGs: they go out as JPEGs (they went out as PNGs and the API refused them).
    expect(imageBlock(jpeg)).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/jpeg" } });
  });

  it("refuses a picture of no known type in plain words, rather than sending it mislabelled", () => {
    expect(() => imageBlock(Buffer.from("not a picture"))).toThrow("is not a JPEG, PNG, WebP or GIF");
  });

  it("is how the Critique and polish step, and every other worker step, sends pictures (no type written by hand)", () => {
    expect(fs.readFileSync(path.join(WORKER_SRC, "polish.ts"), "utf8")).toContain(".map(imageBlock)");
    const files = fs.readdirSync(WORKER_SRC, { recursive: true }).map(String).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith("image-type.ts"));
    const handWritten = files.filter((f) => /media_type\s*:/.test(fs.readFileSync(path.join(WORKER_SRC, f), "utf8")));
    expect(handWritten).toEqual([]);
  });
});

/* ---------- 3. framing baked into the client's photos ---------- */

const NAVY = [1, 21, 59] as const;
const ORANGE = [232, 119, 34] as const;

/* A busy "photo", w x h, with paint() drawing framing on it. */
function photo(w: number, h: number, paint?: (x: number, y: number) => readonly number[] | null): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 7;
  const noise = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) % 60) - 30;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const c = paint?.(x, y) ?? [70 + ((x * 3 + y * 5) % 120) + noise(), 80 + ((x * 7 + y * 2) % 110) + noise(), 60 + ((x + y * 9) % 100) + noise()];
      data[i] = c[0]!;
      data[i + 1] = c[1]!;
      data[i + 2] = c[2]!;
      data[i + 3] = 255;
    }
  }
  return data;
}

describe("the old site's framing is cut off its photos", () => {
  it("cuts a navy corner block on the side that loses less of the photo", () => {
    const data = photo(400, 300, (x, y) => (x < 60 && y < 24 ? NAVY : null));
    expect(findFraming(data, 400, 300)).toEqual({ left: 0, top: 25, right: 0, bottom: 0 });
  });

  it("cuts an orange band along an edge, and corner blocks in two corners", () => {
    expect(findFraming(photo(400, 300, (_x, y) => (y >= 294 ? ORANGE : null)), 400, 300)).toEqual({ left: 0, top: 0, right: 0, bottom: 6 });
    const two = photo(400, 300, (x, y) => (x < 30 && y < 70 ? NAVY : x >= 360 && y >= 270 ? ORANGE : null));
    expect(findFraming(two, 400, 300)).toEqual({ left: 31, top: 0, right: 0, bottom: 31 });
  });

  it("leaves a clean photo, a pale sky and a ragged dark shadow alone", () => {
    expect(findFraming(photo(400, 300), 400, 300)).toBeNull();
    expect(findFraming(photo(400, 300, (_x, y) => (y < 80 ? [190, 220, 245] : null)), 400, 300)).toBeNull();
    expect(findFraming(photo(400, 300, (x, y) => (x < 40 + ((y * 7) % 25) && y < 60 ? NAVY : null)), 400, 300)).toBeNull();
  });

  // Review M1: a deep blue sky, or an awning's fabric seen from under it, is flat at the top but fades instead of ending in a hard line.
  it("leaves a deep blue sky and an awning's fabric across the top alone", () => {
    const fade = (base: readonly number[], y: number, from: number) => base.map((c) => c + (y - from) * 3);
    expect(findFraming(photo(400, 300, (_x, y) => (y < 20 ? [70, 130, 200] : y < 40 ? fade([70, 130, 200], y, 20) : null)), 400, 300)).toBeNull();
    expect(findFraming(photo(400, 300, (_x, y) => (y < 30 ? [120, 60, 40] : y < 50 ? fade([120, 60, 40], y, 30) : null)), 400, 300)).toBeNull();
  });

  it("leaves a see-through edge alone (a transparent PNG)", () => {
    const data = photo(400, 300, (x, y) => (x < 60 && y < 24 ? [0, 0, 0] : null));
    for (let y = 0; y < 24; y += 1) for (let x = 0; x < 60; x += 1) data[(y * 400 + x) * 4 + 3] = 0;
    expect(findFraming(data, 400, 300)).toBeNull();
  });

  it("never cuts more than a fifth of a side: framing that big is left as it is", () => {
    expect(findFraming(photo(400, 300, (x, y) => (x < 200 && y < 150 ? NAVY : null)), 400, 300)).toBeNull();
    // A fifth exactly is cut; just past it is not.
    expect(findFraming(photo(400, 300, (x, y) => (x < 79 && y < 290 ? NAVY : null)), 400, 300)).toEqual({ left: 80, top: 0, right: 0, bottom: 0 });
    expect(findFraming(photo(400, 300, (x, y) => (x < 85 && y < 290 ? NAVY : null)), 400, 300)).toBeNull();
  });
});

/*
  #3 (8 November 2026, confirmed on a client's real photos): the photograph
  INSET in a canvas — transparent or white margin, decorative corner blocks
  peeking from BEHIND the photo, so their visible parts are L-shaped and no
  band or corner-rectangle model can match them. The cut goes to the
  photograph's own box: margin and blocks off in one cut.
*/
describe("a composed canvas is cut to the photograph's own box", () => {
  const PHOTO_BOX = (x: number, y: number) => x >= 40 && x <= 369 && y >= 30 && y <= 279;
  const composed = (margin: readonly number[] | "transparent") => {
    const inNavy = (x: number, y: number) => x < 90 && y < 80;
    const inOrange = (x: number, y: number) => x >= 330 && y >= 240;
    const data = photo(400, 300, (x, y) => (PHOTO_BOX(x, y) ? null : inNavy(x, y) ? NAVY : inOrange(x, y) ? ORANGE : margin === "transparent" ? [0, 0, 0] : margin));
    if (margin === "transparent") {
      for (let y = 0; y < 300; y += 1) {
        for (let x = 0; x < 400; x += 1) {
          if (!PHOTO_BOX(x, y) && !inNavy(x, y) && !inOrange(x, y)) data[(y * 400 + x) * 4 + 3] = 0;
        }
      }
    }
    return data;
  };

  it("cuts to the photo's box over a transparent margin (a client's real shape) and over a white one with blocks", () => {
    expect(findFraming(composed("transparent"), 400, 300)).toEqual({ left: 40, top: 30, right: 30, bottom: 20 });
    expect(findFraming(composed([255, 255, 255]), 400, 300)).toEqual({ left: 40, top: 30, right: 30, bottom: 20 });
  });

  it("never takes a plain photograph that merely fades to white at its edges (no transparency, no blocks)", () => {
    const whiteEdged = photo(400, 300, (x, y) => (x < 12 || x > 387 || y < 10 || y > 289 ? [235, 235, 235] : null));
    expect(findFraming(whiteEdged, 400, 300)).toBeNull();
  });

  it("refuses when the margin holds real content, when the box keeps too little, or when the ring is busy", () => {
    // A wide strip under the photo (a caption band, nothing like the blocks' colours) is
    // INCLUDED in the box — kept, never sliced.
    const withCaption = composed("transparent");
    for (let x = 60; x <= 340; x += 1) {
      for (let y = 284; y <= 296; y += 1) {
        const i = (y * 400 + x) * 4;
        withCaption[i] = 120; withCaption[i + 1] = 40; withCaption[i + 2] = 160; withCaption[i + 3] = 255;
      }
    }
    expect(findFraming(withCaption, 400, 300)).toEqual({ left: 40, top: 30, right: 30, bottom: 3 });
    // Smaller content in the margin (too narrow to be a photo row, too big to be stray noise,
    // and nothing like the blocks' colours): refused outright.
    const withContent = composed("transparent");
    for (let x = 100; x <= 209; x += 1) {
      for (let y = 284; y <= 295; y += 1) {
        const i = (y * 400 + x) * 4;
        withContent[i] = 120; withContent[i + 1] = 40; withContent[i + 2] = 160; withContent[i + 3] = 255;
      }
    }
    expect(findFraming(withContent, 400, 300)).toBeNull();
    // A photo smaller than 60% of the canvas: the rails refuse the cut.
    const tiny = photo(400, 300, (x, y) => (x >= 150 && x <= 320 && y >= 110 && y <= 260 ? null : [0, 0, 0]));
    for (let y = 0; y < 300; y += 1) for (let x = 0; x < 400; x += 1) if (!(x >= 150 && x <= 320 && y >= 110 && y <= 260)) tiny[(y * 400 + x) * 4 + 3] = 0;
    expect(findFraming(tiny, 400, 300)).toBeNull();
    // A busy ring (an ordinary photograph) never reads as a canvas.
    expect(findFraming(photo(400, 300), 400, 300)).toBeNull();
  });

  // CodeRabbit on PR #54: a mostly DARK ring (a night shot, a vignette) must never read as a
  // canvas, whatever its solid clusters say — a composition's margin is light by definition.
  it("never takes a dark-edged photograph (a vignette ring with no transparency)", () => {
    // Two alternating dark tones, so no band is row-uniform (the band pass stays out) and the
    // ring still clusters tightly — before the fix, the solid-block evidence alone let this in.
    const dark = (x: number, y: number) => ((x + y) % 7 < 4 ? [20, 22, 26] : [60, 62, 66]);
    const vignette = photo(400, 300, (x, y) => (x < 40 || x >= 360 || y < 40 || y >= 260 ? dark(x, y) : null));
    expect(findFraming(vignette, 400, 300)).toBeNull();
  });
});

describe("the client's photos are checked for framing once, from their saved copies", () => {
  afterEach(() => {
    setSitePhotoReaderForTesting(null);
    setSitePhotoTrimmerForTesting(null);
  });
  const projectId = "7b0e3a52-1c4d-4f7a-9a51-2f6a3c1d9e10";

  it("cuts new photos, and keeps each original beside its cut copy", async () => {
    const r2 = new FakeR2();
    setSitePhotoTrimmerForTesting(async (_b, bytes) => (bytes[0] === 1 ? { bytes: Buffer.from("trimmed"), cut: { left: 0, top: 40, right: 0, bottom: 0 }, kept: { width: 1, height: 0.95 } } : null));
    const reader = async () => [1, 2].map((n) => ({ bytes: Buffer.alloc(100, n), contentType: "image/jpeg", alt: "", width: 1200, height: 800, src: `https://x/${n}.jpg` }));
    const photos = await currentSitePhotos(r2, { projectId, url: "https://clearskyawning.net/", browser: {} as never }, reader);
    expect(r2.objects.get(photos[0]!.storageKey)!.toString()).toBe("trimmed");
    expect(photos[0]!.storageKey).toMatch(new RegExp(`-framed-v${FRAMING_VERSION}\\.jpg$`));
    expect(r2.objects.get(photos[1]!.storageKey)!.equals(Buffer.alloc(100, 2))).toBe(true);
    const manifest = JSON.parse(r2.objects.get(`${sitePhotosFolder(projectId)}manifest.json`)!.toString());
    expect(manifest.framing).toBe(FRAMING_VERSION);
    expect(manifest.photos[0]).toMatchObject({ width: 1200, height: 760, original: { width: 1200, height: 800 } });
    // Review M2: the photo as read is still there, so a wrong cut can be undone.
    expect(r2.objects.get(manifest.photos[0].original.key)!.equals(Buffer.alloc(100, 1))).toBe(true);
  });

  // Review M4: a check that failed is tried again on the next use, never recorded as done.
  it("tries again next time when the check itself failed", async () => {
    const r2 = new FakeR2();
    let fail = true;
    setSitePhotoTrimmerForTesting(async () => {
      if (fail) throw new Error("browser closed");
      return null;
    });
    const reader = async () => [{ bytes: Buffer.alloc(100, 1), contentType: "image/jpeg", alt: "", width: 1200, height: 800, src: "https://x/1.jpg" }];
    await currentSitePhotos(r2, { projectId, url: "https://clearskyawning.net/", browser: {} as never }, reader);
    const manifestKey = `${sitePhotosFolder(projectId)}manifest.json`;
    expect(JSON.parse(r2.objects.get(manifestKey)!.toString()).framing).toBeUndefined();
    fail = false;
    await currentSitePhotos(r2, { projectId, url: "https://clearskyawning.net/", browser: {} as never }, reader);
    expect(JSON.parse(r2.objects.get(manifestKey)!.toString()).framing).toBe(FRAMING_VERSION);
  });

  it("checks photos saved before the check once, without reading the website again, under the same tokens", async () => {
    const r2 = new FakeR2();
    const folder = sitePhotosFolder(projectId);
    r2.objects.set(`${folder}1-1.jpg`, Buffer.alloc(50, 1));
    r2.objects.set(
      `${folder}manifest.json`,
      Buffer.from(JSON.stringify({ url: "https://clearskyawning.net/", at: "2026-11-04T00:00:00Z", photos: [{ key: `${folder}1-1.jpg`, contentType: "image/jpeg", alt: "Patio", width: 900, height: 600 }] })),
    );
    let trims = 0;
    setSitePhotoTrimmerForTesting(async () => {
      trims += 1;
      return { bytes: Buffer.from("framed off"), cut: { left: 30, top: 0, right: 0, bottom: 0 }, kept: { width: 0.9, height: 1 } };
    });
    const reader = async () => {
      throw new Error("the website must not be read again");
    };
    const first = await currentSitePhotos(r2, { projectId, url: "https://clearskyawning.net/", browser: {} as never }, reader);
    expect(first.map((p) => p.token)).toEqual(["tawd-asset:photo-site-1"]);
    expect(first[0]!.storageKey).toBe(`${folder}1-1-framed-v${FRAMING_VERSION}.jpg`);
    expect(r2.objects.get(first[0]!.storageKey)!.toString()).toBe("framed off");
    const again = await currentSitePhotos(r2, { projectId, url: "https://clearskyawning.net/", browser: {} as never }, reader);
    expect(again).toEqual(first);
    expect(trims).toBe(1);
  });

  it("gives a build only the photos already saved, and never reads the website for one", async () => {
    const r2 = new FakeR2();
    const reader = async () => {
      throw new Error("a build never reads the website");
    };
    expect(await currentSitePhotos(r2, { projectId, url: "https://clearskyawning.net/", browser: {} as never, storedOnly: true }, reader)).toEqual([]);
  });

  // Review M3: the address edited after the concepts, or storage failing, never leaves a build silently without the photos.
  it("gives a build the saved photos even if the website address was edited since, and stops with a reason when storage fails", async () => {
    const r2 = new FakeR2();
    const folder = sitePhotosFolder(projectId);
    r2.objects.set(`${folder}1-1.jpg`, Buffer.alloc(30, 1));
    r2.objects.set(
      `${folder}manifest.json`,
      Buffer.from(JSON.stringify({ url: "https://clearskyawning.net/", at: "2026-11-04T00:00:00Z", photos: [{ key: `${folder}1-1.jpg`, contentType: "image/jpeg", alt: "", width: 900, height: 600 }], framing: FRAMING_VERSION })),
    );
    const reader = async () => {
      throw new Error("a build never reads the website");
    };
    const photos = await currentSitePhotos(r2, { projectId, url: "https://www.clearskyawning.com/", browser: {} as never, storedOnly: true }, reader);
    expect(photos.map((p) => p.token)).toEqual(["tawd-asset:photo-site-1"]);
    r2.get = async () => {
      throw new Error("R2 503");
    };
    await expect(currentSitePhotos(r2, { projectId, url: "https://clearskyawning.net/", browser: {} as never, storedOnly: true }, reader)).rejects.toThrow(
      "The photos from the client's current website couldn't be read from storage (R2 503)",
    );
  });
});

/* ---------- 2. the concepts' photos reach Build A ---------- */

describe("the client's photos the concepts used are in the built site", () => {
  let h: Harness;
  let r2: FakeR2;
  const config: WorkerConfig = {
    databaseUrl: "unused",
    redisUrl: "unused",
    anthropicApiKey: "unused",
    model: "claude-opus-5-5",
    skillsDir: path.resolve(__dirname, "../../../../skills"),
    effort: "high",
  };

  beforeEach(async () => {
    h = await createHarness();
    setDbForTesting(h.db as Database);
    r2 = new FakeR2();
    setStorageForTesting(r2);
    setQueueForTesting({ add: async () => undefined, getJob: async () => null });
    setEncryptionKeyForTesting(randomBytes(32));
  });
  afterEach(async () => {
    setSitePhotoReaderForTesting(null);
    await h.close();
  });

  /* A makeover with 8 photos saved from the current site and `uploads` photos uploaded on the intake. */
  async function makeover(uploads: number) {
    const admin = await seedAdmin(h);
    const projectId = await createProject(h.ctx, admin.viewer, { clientName: "Clear Sky Awning", trade: "home_services", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 2, status: "mockups", memberUserIds: [] });
    await saveIntakeSection(h.ctx, admin.viewer, projectId, "website", { currentWebsiteUrl: "https://clearskyawning.net" });
    const folder = sitePhotosFolder(projectId);
    const photos = Array.from({ length: 8 }, (_, i) => ({ key: `${folder}1-${i + 1}.jpg`, contentType: "image/jpeg", alt: `Patio ${i + 1}`, width: 1200, height: 800 }));
    for (const p of photos) r2.objects.set(p.key, Buffer.alloc(30, 9));
    r2.objects.set(`${folder}manifest.json`, Buffer.from(JSON.stringify({ url: "https://clearskyawning.net/", at: "2026-11-04T00:00:00Z", photos, framing: FRAMING_VERSION })));
    for (let i = 0; i < uploads; i += 1) {
      const key = `projects/${projectId}/upload-${i + 1}.jpg`;
      r2.objects.set(key, Buffer.alloc(30, 5));
      await h.db.insert(intakeFile).values({ projectId, kind: "photo", storageKey: key, fileName: `upload-${i + 1}.jpg`, contentType: "image/jpeg", status: "ready" });
    }
    setSitePhotoReaderForTesting(async () => {
      throw new Error("the website must not be read again");
    });
    return { admin, projectId };
  }
  const siteTokens = (n: number) => Array.from({ length: n }, (_, i) => `tawd-asset:photo-site-${i + 1}`);

  it("loads them for a site build (no concept run), all of them, under the concepts' tokens", async () => {
    const { projectId } = await makeover(0);
    // A site build passes its own id, which is no concept run.
    const context = await loadProjectContext(h.db as never, r2 as never, fakeBrowser() as never, config, { projectId, runId: "00000000-0000-0000-0000-000000000000" });
    expect(context.assets.map((a) => a.token)).toEqual(siteTokens(8));
  });

  // Review L7: a concept run still holds twelve photos in all, the uploads first (each photo is inlined into the concept page).
  it("still gives a concept run twelve photos in all: the uploads, then the site's photos up to twelve", async () => {
    const { admin, projectId } = await makeover(5);
    const [run] = await h.db.insert(mockupRun).values({ projectId, conceptCount: 2, status: "running", model: "claude-opus-5-5", startedByUserId: admin.viewer.id }).returning();
    const concept = await loadProjectContext(h.db as never, r2 as never, fakeBrowser() as never, config, { projectId, runId: run!.id });
    const photoTokens = concept.assets.filter((a) => a.kind === "photo").map((a) => a.token);
    expect(photoTokens).toHaveLength(12);
    expect(photoTokens.filter((t) => t.startsWith("tawd-asset:photo-site-"))).toEqual(siteTokens(7));
    // The build of the same project gets all eight, so a site photo a concept never had can't be missing either.
    const build = await loadProjectContext(h.db as never, r2 as never, fakeBrowser() as never, config, { projectId, runId: "00000000-0000-0000-0000-000000000000" });
    expect(build.assets.filter((a) => a.token.startsWith("tawd-asset:photo-site-")).map((a) => a.token)).toEqual(siteTokens(8));
  });
});

/* ---------- 4. the main service's icon ---------- */

describe("a word with no icon gets a dot, and an address a map pin", () => {
  /*
    Gap 10 gave these words the house, so that the main service would not get
    a wrench for the word "service". Clear Sky Awning showed the cost: three
    different services, none of them in the icon set, three identical houses,
    and the Creative Director marking the concept down for it. Jason's call,
    9 November 2026: the dot, and TAWD says it had no icon.
  */
  it("never gives a word it does not know a glyph that means something else", () => {
    expect(iconFor("main service")).toBe(UNKNOWN_ICON);
    expect(iconFor("Patio covers")).toBe(UNKNOWN_ICON);
    expect(iconFor("retractable awnings")).toBe(UNKNOWN_ICON);
    expect(iconFor("pergola")).toBe(UNKNOWN_ICON);
    expect(iconFor("sunrooms")).toBe(UNKNOWN_ICON);
    expect(iconFor("something unheard of")).toBe(UNKNOWN_ICON);
    // A real repair still gets the tool, and the place is still the home.
    expect(iconFor("repairs")).toBe("tool");
    expect(iconFor("outdoor living")).toBe("home");
    expect(iconFor("Residential")).toBe("home");
  });

  it("gives an address the map pin, and chat a speech bubble", () => {
    expect(iconFor("address")).toBe("map-pin");
    expect(iconFor("Our address")).toBe("map-pin");
    expect(iconFor("Directions")).toBe("map-pin");
    // Review M5: the verb, and a visit, are not places.
    expect(iconFor("We address every issue")).not.toBe("map-pin");
    expect(iconFor("Book a visit")).toBe("calendar");
    expect(iconFor("Schedule your visit")).toBe("calendar");
    expect(iconFor("chat")).toBe("message-circle");
    expect(iconFor("pin")).toBe("map-pin");
  });

  it("says which words it had no icon for, instead of filling them from the trade", () => {
    const html = [
      '<span class="icon" data-tawd-icon="retractable awnings"></span><h3>Retractable Awnings</h3>',
      '<span class="icon" data-tawd-icon="patio covers"></span><h3>Patio Covers</h3>',
      '<span class="icon" data-tawd-icon="phone"></span><h3>Call us</h3>',
    ].join("");
    const { html: out, notes } = fillIcons(html);
    // The two unknown words are reported; the phone is not, because TAWD knew it.
    expect(notes.map((n) => n.what)).toEqual(['"retractable awnings"', '"patio covers"']);
    expect(notes.every((n) => n.step === "icons" && n.action === "substituted" && n.with === "a plain dot")).toBe(true);
    expect(iconWordsWithNoIcon(out)).toEqual(["retractable awnings", "patio covers"]);
    expect(checkIcons(out).map((i) => [i.id, i.severity])).toEqual([["icons.noIcon", "warn"]]);
    expect(checkIcons(out)[0]!.message).toContain('"retractable awnings", "patio covers"');
  });

  it("does not report a slot that asked for the dot by name", () => {
    const { html: out, notes } = fillIcons('<span class="icon" data-tawd-icon="point"></span>');
    expect(notes).toEqual([]);
    expect(iconWordsWithNoIcon(out)).toEqual([]);
    expect(checkIcons(out)).toEqual([]);
  });

  it("warns without failing, so no fix round is spent on an icon TAWD does not have", () => {
    const { html: out } = fillIcons('<span class="icon" data-tawd-icon="pergola"></span>');
    const issue = checkIcons(out)[0]!;
    expect(issue.severity).toBe("warn");
    expect(isFixable(issue)).toBe(false);
  });
});
