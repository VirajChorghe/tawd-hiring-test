import { describe, expect, it } from "vitest";

import { isHeic } from "@tawd/core/images";

/*
  Gap 11: HEIC/HEIF detection is by the file's own bytes, never its name — an
  iPhone photo often arrives as ".jpg" while the bytes are still HEIC.
*/

/** An ISO `ftyp` box: [size][ "ftyp" ][ major ][ minor 0000 ][ compatible… ]. */
function ftyp(major: string, compatible: string[] = []): Buffer {
  const after = Buffer.concat([
    Buffer.from("ftyp", "ascii"),
    Buffer.from(major.padEnd(4, " ").slice(0, 4), "ascii"),
    Buffer.from([0, 0, 0, 0]),
    ...compatible.map((b) => Buffer.from(b.padEnd(4, " ").slice(0, 4), "ascii")),
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(4 + after.length, 0);
  return Buffer.concat([size, after]);
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("isHeic (by bytes, not the file name)", () => {
  it("detects HEIC/HEIF by the ftyp major brand (the brands the decoder accepts)", () => {
    expect(isHeic(ftyp("heic"))).toBe(true);
    expect(isHeic(ftyp("heix"))).toBe(true);
    expect(isHeic(ftyp("hevc"))).toBe(true);
    expect(isHeic(ftyp("mif1"))).toBe(true);
    expect(isHeic(ftyp("msf1"))).toBe(true);
  });

  it("catches a HEIC whose extension/content-type lie (the iPhone '.jpg' case)", () => {
    // A HEIC file renamed photo.jpg and even served as image/jpeg is still HEIC
    // by its bytes, so detection — which only sees the bytes — must say true.
    const heicBytesSentAsJpg = ftyp("heic", ["mif1"]);
    expect(isHeic(heicBytesSentAsJpg)).toBe(true);
    // The inverse: real JPEG bytes a user named photo.heic are NOT HEIC.
    expect(isHeic(JPEG)).toBe(false);
  });

  it("leaves other formats alone, incl. AVIF even when it carries a generic mif1 compatible brand (Chromium shows AVIF)", () => {
    expect(isHeic(JPEG)).toBe(false);
    expect(isHeic(PNG)).toBe(false);
    expect(isHeic(ftyp("avif"))).toBe(false);
    expect(isHeic(ftyp("avis"))).toBe(false);
    // The important one: a real AVIF's ftyp lists "mif1"/"miaf" as compatible brands,
    // but its MAJOR brand is "avif" — matching a compatible brand would wrongly reject
    // an AVIF the browser renders. Detection is major-brand-only, so this is false.
    expect(isHeic(ftyp("avif", ["mif1", "miaf"]))).toBe(false);
    // A plain MP4 with a HEIF-looking compatible brand is likewise not flagged.
    expect(isHeic(ftyp("mp42", ["isom", "heic"]))).toBe(false);
    // An AVIF in a MIAF container (major "mif1" but an "avif" compatible brand) is not HEIC.
    expect(isHeic(ftyp("mif1", ["avif", "miaf"]))).toBe(false);
    // ...but a genuine HEIF with a "mif1" major brand still is.
    expect(isHeic(ftyp("mif1", ["heic", "miaf"]))).toBe(true);
    expect(isHeic(Buffer.from("RIFF0000WEBP"))).toBe(false);
    expect(isHeic(Buffer.alloc(8))).toBe(false); // too short / not ftyp
  });
});
