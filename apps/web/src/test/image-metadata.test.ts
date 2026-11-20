import { describe, expect, it } from "vitest";

import { seoHead, stripImageMetadata } from "@tawd/core/site";

/*
  A photo's hidden details (GPS, date, camera) never reach a website
  (8 October 2026), and the shared picture is never an SVG.
*/

const bytes = (...parts: (number[] | string)[]) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));

describe("photo metadata", () => {
  it("takes the EXIF and IPTC segments out of a JPEG and keeps the rest", () => {
    const exif = bytes([0xff, 0xe1, 0x00, 0x0c], "Exif\0\0GPS!");
    const iptc = bytes([0xff, 0xed, 0x00, 0x06], "IPTC");
    const icc = bytes([0xff, 0xe2, 0x00, 0x06], "ICC!");
    const scan = bytes([0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x55, 0x66, 0xff, 0xd9]);
    const jpeg = bytes([0xff, 0xd8], [...exif], [...iptc], [...icc], [...scan]);
    const out = stripImageMetadata(jpeg);
    expect(Buffer.from(out).includes(Buffer.from("GPS!"))).toBe(false);
    expect(Buffer.from(out).includes(Buffer.from("IPTC"))).toBe(false);
    expect(Buffer.from(out)).toEqual(Buffer.from(bytes([0xff, 0xd8], [...icc], [...scan])));
  });

  it("takes the text and EXIF chunks out of a PNG", () => {
    const chunk = (type: string, data: string) => bytes([0, 0, 0, data.length], type, data, [0, 0, 0, 0]);
    const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [...chunk("IHDR", "abcd")], [...chunk("tEXt", "GPS!")], [...chunk("eXIf", "date")], [...chunk("IDAT", "xy")], [...chunk("IEND", "")]);
    const out = Buffer.from(stripImageMetadata(png));
    expect(out.includes(Buffer.from("GPS!"))).toBe(false);
    expect(out.includes(Buffer.from("eXIf"))).toBe(false);
    expect(out.includes(Buffer.from("IDAT"))).toBe(true);
  });

  it("takes the EXIF chunk out of a WebP and clears its flag", () => {
    const vp8x = bytes("VP8X", [10, 0, 0, 0], [0x08, 0, 0, 0, 1, 0, 0, 1, 0, 0]);
    const exif = bytes("EXIF", [4, 0, 0, 0], "GPS!");
    const body = bytes("WEBP", [...vp8x], [...exif]);
    const webp = bytes("RIFF", [body.length & 0xff, 0, 0, 0], [...body]);
    const out = Buffer.from(stripImageMetadata(webp));
    expect(out.includes(Buffer.from("GPS!"))).toBe(false);
    expect(out[20]! & 0x08).toBe(0);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
  });

  it("leaves anything it can't read as it was", () => {
    const svg = bytes("<svg></svg>");
    expect(stripImageMetadata(svg)).toBe(svg);
  });
});

describe("the picture shared on social sites", () => {
  const facts = { name: "Sample Plumbing Co.", domain: "sacplumbingexperts.com", logoPath: "/images/logo.svg" } as never;
  const head = (extra = {}) => seoHead({ facts: { ...(facts as object), ...extra } as never, path: "/", kind: "about", title: "t", description: "d" });

  it("is a photo, never the SVG logo", () => {
    expect(head()).not.toContain("og:image");
    expect(head({ shareImagePath: "/images/photo-3.jpg" })).toContain('<meta property="og:image" content="https://sacplumbingexperts.com/images/photo-3.jpg" />');
    expect(head({ logoPath: "/images/logo.png" })).toContain("images/logo.png");
  });
});
