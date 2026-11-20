/*
  Photos without their hidden details (8 October 2026): a phone's photo
  carries where it was taken (GPS), when, and the camera. The speed pass's
  WebP versions drop them, but an original it keeps (when WebP isn't
  smaller) was published as it came. Every picture a site build writes now
  goes through here first. Plain byte surgery, no image library: the
  picture itself is untouched.

  - JPEG: the APP1 (EXIF, XMP) and APP13 (IPTC) segments go; colour (APP2)
    and the rest stay.
  - PNG: the eXIf chunk and the text chunks (tEXt, iTXt, zTXt) go.
  - WebP: the EXIF and XMP chunks go, and the header's flags say so.
  Anything else, or a file it can't read, comes back unchanged.
*/

export function stripImageMetadata(bytes: Uint8Array): Uint8Array {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return stripJpeg(bytes);
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return stripPng(bytes);
    if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return stripWebp(bytes);
  } catch {
    // A file it can't read is left as it was.
  }
  return bytes;
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function stripJpeg(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return b;
    const marker = b[i + 1]!;
    // Start of scan: the picture data follows to the end.
    if (marker === 0xda) {
      parts.push(b.subarray(i));
      return concat(parts);
    }
    const length = (b[i + 2]! << 8) | b[i + 3]!;
    if (length < 2 || i + 2 + length > b.length) return b;
    const segment = b.subarray(i, i + 2 + length);
    if (marker !== 0xe1 && marker !== 0xed) parts.push(segment);
    i += 2 + length;
  }
  return b;
}

function stripPng(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const length = ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
    const type = ascii(b, i + 4, 4);
    const end = i + 12 + length;
    if (end > b.length) return b;
    if (!["eXIf", "tEXt", "iTXt", "zTXt"].includes(type)) parts.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") return concat(parts);
  }
  return b;
}

function stripWebp(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = ascii(b, i, 4);
    const length = b[i + 4]! | (b[i + 5]! << 8) | (b[i + 6]! << 16) | (b[i + 7]! << 24);
    const end = i + 8 + length + (length % 2);
    if (end > b.length + 1) return b;
    if (type !== "EXIF" && type !== "XMP ") {
      const chunk = new Uint8Array(b.subarray(i, Math.min(end, b.length)));
      // VP8X's flags: no EXIF (bit 3) and no XMP (bit 2) any more.
      if (type === "VP8X" && chunk.length > 8) chunk[8] = chunk[8]! & ~0x0c;
      parts.push(chunk);
    }
    i = end;
  }
  const body = concat(parts);
  const header = new Uint8Array(12);
  header.set(b.subarray(0, 12));
  const size = body.length + 4;
  header[4] = size & 0xff;
  header[5] = (size >> 8) & 0xff;
  header[6] = (size >> 16) & 0xff;
  header[7] = (size >> 24) & 0xff;
  return concat([header, body]);
}
