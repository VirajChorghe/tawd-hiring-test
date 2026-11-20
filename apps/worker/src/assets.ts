import type { Browser } from "playwright-core";

import type { FileStorage } from "@tawd/core/intake/storage";
import { logoToken, photoToken, type PageAsset } from "@tawd/core/mockups";
import { logoPalette } from "@tawd/core/intake";
import { ownPageContext } from "./locked-context";

/*
  Fetching the client's logo and photos for a concept.

  Each file comes from R2 and is inlined into the page as a data URI, so the
  render and the stored HTML both have it with no network. A phone photo can
  be 15 MB; twelve of those inlined would make a page Chromium struggles
  with on a shared 4 GB droplet. So anything large is shrunk first, in the
  Chromium the worker already has open - there is no image library in the
  container and adding one is not worth it for this. Photos become JPEGs at
  most 1600px wide, which is more than a 1440px mockup ever shows; the logo
  keeps PNG so its transparency survives, at most 800px.

  A file that cannot be read is skipped rather than failing the concept:
  the page is simply built without it, and the log says which.
*/

export const MAX_PHOTOS = 12;

const LIMITS = {
  logo: { maxSide: 800, maxBytes: 400 * 1024, type: "image/png", quality: undefined },
  photo: { maxSide: 1600, maxBytes: 600 * 1024, type: "image/jpeg", quality: 0.82 },
} as const;

export interface AssetFile {
  kind: "logo" | "photo";
  fileName: string;
  contentType: string;
  caption: string | null;
  storageKey: string;
  /* A token of its own (the design's images in the faithful copy); otherwise logo and photo-N. */
  token?: string;
}

export interface PreparedAsset extends PageAsset {
  dataUri: string;
  /** Logos only: the main colours, most used first (27 September 2026: the brand comes from the logo when no colours are entered). */
  palette?: string[];
}

export async function prepareAssets(
  browser: Browser,
  storage: FileStorage,
  files: AssetFile[],
): Promise<PreparedAsset[]> {
  // Files with a token of their own keep it (the design's images; the current site's photos, 5 November 2026); the rest are logo and photo-N.
  const plain = files.filter((f) => !f.token);
  const logo = plain.find((f) => f.kind === "logo");
  const photos = plain.filter((f) => f.kind === "photo").slice(0, MAX_PHOTOS);

  const wanted: { file: AssetFile; token: string }[] = [
    ...(logo ? [{ file: logo, token: logoToken() }] : []),
    ...photos.map((file, index) => ({ file, token: photoToken(index) })),
    ...files.filter((f) => f.token).map((file) => ({ file, token: file.token! })),
  ];
  if (wanted.length === 0) return [];

  const context = await ownPageContext(browser);
  const out: PreparedAsset[] = [];

  try {
    const page = await context.newPage();
    // Nothing here needs the network; the images arrive as data URIs.
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url.startsWith("about:")) {
        void route.continue();
      } else {
        void route.abort();
      }
    });

    for (const { file, token } of wanted) {
      try {
        const bytes = await storage.get(file.storageKey);
        if (!bytes) {
          console.warn(`Image not found in storage, skipped: ${file.fileName}`);
          continue;
        }

        const original = `data:${file.contentType};base64,${bytes.toString("base64")}`;
        const limits = LIMITS[file.kind];

        const result = await page.evaluate(
          async ({ src, maxSide, maxBytes, type, quality, size, isSvg, measureTone }) => {
            const image = new Image();
            image.src = src;
            await image.decode();

            const width = image.naturalWidth;
            const height = image.naturalHeight;

            /*
              How the logo's marks read: the average luminance of the pixels
              that are not transparent. Drawn small, since only the average
              matters.
            */
            const toneOf = (): "dark" | "light" | "mid" | "solid" | null => {
              if (width === 0 || height === 0) return null;
              const probe = document.createElement("canvas");
              probe.width = Math.min(120, width);
              probe.height = Math.max(1, Math.round((probe.width / width) * height));
              const ctx = probe.getContext("2d");
              if (!ctx) return null;
              ctx.drawImage(image, 0, 0, probe.width, probe.height);
              const data = ctx.getImageData(0, 0, probe.width, probe.height).data;
              let lum = 0;
              let weight = 0;
              let opaque = 0;
              for (let i = 0; i < data.length; i += 4) {
                const a = data[i + 3]! / 255;
                if (a > 0.95) opaque += 1;
                if (a < 0.2) continue;
                lum += ((0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255) * a;
                weight += a;
              }
              if (weight === 0) return null;
              if (opaque / (probe.width * probe.height) > 0.97) return "solid";
              const average = lum / weight;
              return average < 0.35 ? "dark" : average > 0.7 ? "light" : "mid";
            };
            // A small sample of the logo's pixels, for its palette (read in Node).
            const sample = (() => {
              try {
                if (!measureTone || width === 0 || height === 0) return null;
                const probe = document.createElement("canvas");
                probe.width = Math.min(160, width);
                probe.height = Math.max(1, Math.round((probe.width / width) * height));
                const ctx = probe.getContext("2d");
                if (!ctx) return null;
                ctx.drawImage(image, 0, 0, probe.width, probe.height);
                return Array.from(ctx.getImageData(0, 0, probe.width, probe.height).data);
              } catch {
                return null;
              }
            })();
            // Measuring must never cost the logo its place on the page.
            const tone = (() => {
              try {
                return measureTone ? toneOf() : null;
              } catch {
                return null;
              }
            })();

            // SVG stays as it is: it is already small and scales perfectly.
            const tooBig = size > maxBytes || Math.max(width, height) > maxSide;
            if (isSvg || !tooBig || width === 0 || height === 0) {
              return { dataUri: src, width, height, tone, sample };
            }

            const scale = Math.min(1, maxSide / Math.max(width, height));
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(width * scale);
            canvas.height = Math.round(height * scale);
            canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);

            return {
              dataUri: canvas.toDataURL(type, quality),
              width: canvas.width,
              height: canvas.height,
              tone,
              sample,
            };
          },
          {
            src: original,
            maxSide: limits.maxSide,
            maxBytes: limits.maxBytes,
            type: limits.type,
            quality: limits.quality,
            size: bytes.length,
            isSvg: file.contentType === "image/svg+xml",
            measureTone: file.kind === "logo",
          },
        );

        out.push({
          token,
          kind: file.kind,
          caption: file.caption,
          fileName: file.fileName,
          width: result.width || null,
          height: result.height || null,
          tone: result.tone ?? null,
          dataUri: result.dataUri,
          ...(file.kind === "logo" && result.sample ? { palette: logoPalette(new Uint8ClampedArray(result.sample)).map((c) => c.hex) } : {}),
        });
      } catch (error) {
        console.warn(`Image could not be read, skipped: ${file.fileName}`, error);
      }
    }
  } finally {
    await context.close();
  }

  return out;
}
