import { stripImageMetadata } from "@tawd/core/site";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SiteBuildError } from "@tawd/core/site";

/*
  The site's pictures, written into the build folder (Jason, 29 September
  2026: the sample client's build stopped after its AI calls because /images/home/ was
  never made). Every picture's own folder is made first; and the design
  build writes them all to a scratch folder before any AI call, so a
  missing or unwritable picture stops the build for $0.
*/

export interface PictureFile {
  path: string;
  bytes: Buffer;
  token?: string;
}

/** Writes each picture under <root>/public, making its folder first. */
export async function writeSiteImages(root: string, images: PictureFile[]): Promise<void> {
  for (const image of images) {
    const file = path.join(root, "public", image.path.replace(/^\//, ""));
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Never a photo's hidden details (GPS, date, camera) on a website (8 October 2026).
    await fs.writeFile(file, stripImageMetadata(image.bytes));
  }
}

/** Before any AI call: every picture has bytes, and all of them can be written. Throws a plain reason; costs nothing. */
export async function checkSiteImages(images: PictureFile[]): Promise<void> {
  const empty = images.filter((i) => !i.bytes || i.bytes.length === 0);
  if (empty.length) {
    const names = empty.slice(0, 5).map((i) => i.path).join(", ");
    throw new SiteBuildError(`The design's pictures ${names}${empty.length > 5 ? ` and ${empty.length - 5} more` : ""} are empty. Re-import the design, then build again. Nothing was spent.`);
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tawd-images-check-"));
  try {
    await writeSiteImages(dir, images);
  } catch (error) {
    throw new SiteBuildError(`The design's pictures couldn't be put in the site (${error instanceof Error ? error.message : "unknown"}). Nothing was spent.`, { cause: error });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** The /images/... addresses a page points to that no picture of the build has. */
export function missingPictures(html: string, images: PictureFile[]): string[] {
  const have = new Set(images.map((i) => i.path));
  const found = new Set<string>();
  for (const m of html.matchAll(/["'(\s]((?:\/)images\/[^"')\s]+)/g)) if (!have.has(m[1]!)) found.add(m[1]!);
  return [...found];
}
