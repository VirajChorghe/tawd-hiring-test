/// <reference path="./heic-convert.d.ts" />
import convert from "heic-convert";

/*
  HEIC/HEIF photos (gap 11, Jason 6 November 2026): the iPhone default since
  iOS 11. TAWD does its image work through headless Chromium, which cannot
  decode HEIF, so a HEIC photo renders blank and never reaches the concepts or
  the built site; browsers and the AI don't take it either. Wherever a photo
  enters TAWD — the crawl of the current site, the intake uploads and the
  design upload — a HEIC is converted to JPEG and the original is kept.

  Detection is by the file's own bytes, never its name: iPhone photos often
  arrive as ".jpg" while the bytes are still HEIC, so the extension can't be
  trusted.
*/

// The HEIF major brands the decoder (heic-convert → heic-decode) actually accepts.
// We match it exactly and on the MAJOR brand only, as the decoder does: flagging a
// brand it can't decode would get the file rejected instead of left for the browser.
// AVIF (major brand "avif"/"avis") isn't here, so an AVIF that merely carries a
// generic "mif1" compatible brand is not mistaken for HEIC — Chromium shows AVIF.
const HEIF_MAJOR_BRANDS = new Set(["mif1", "msf1", "heic", "heix", "hevc", "hevx"]);

/**
 * Whether the bytes are a HEIC/HEIF image the converter can handle, read from the
 * ISO `ftyp` box's major brand — never from a file name or a declared content type.
 */
export function isHeic(bytes: Buffer): boolean {
  if (bytes.length < 12) return false;
  if (bytes.toString("ascii", 4, 8) !== "ftyp") return false;
  // The ftyp box: [size][ "ftyp" ][ major brand ][ minor version ][ compatible brands… ].
  if (!HEIF_MAJOR_BRANDS.has(bytes.toString("ascii", 8, 12).replace(/\0/g, " ").trim())) return false;
  // An AVIF wrapped in a generic MIAF container has a major brand of "mif1"/"msf1" but
  // lists "avif"/"avis" as a compatible brand. Chromium shows AVIF, so don't convert it.
  const declared = bytes.readUInt32BE(0);
  const end = declared >= 16 && declared <= bytes.length ? declared : bytes.length;
  for (let off = 16; off + 4 <= end; off += 4) {
    const brand = bytes.toString("ascii", off, off + 4);
    if (brand === "avif" || brand === "avis") return false;
  }
  return true;
}

/** Decode a HEIC/HEIF image and re-encode it as JPEG (quality 0 to 1). */
export async function heicToJpeg(bytes: Buffer, quality = 0.9): Promise<Buffer> {
  const out = await convert({ buffer: bytes, format: "JPEG", quality });
  return Buffer.from(out);
}
