import { deflateSync } from "node:zlib";

/* Tiny PDFs for tests: a picture-only page, or a page with text, built byte by byte. */

export type Rgb = [number, number, number];

/* Raw RGB pixels from a function of (x, y). */
export function raster(width: number, height: number, colour: (x: number, y: number) => Rgb): Buffer {
  const out = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = colour(x, y);
      const i = (y * width + x) * 3;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
    }
  }
  return out;
}

/* A one-page PDF. The page is `pageW` by `pageH` points; an image (if given) is painted over all of it; text (if given) is drawn on it. */
export function makePdf(opts: { pageW: number; pageH: number; image?: { width: number; height: number; rgb: Buffer }; text?: string }): Buffer {
  const objects: Buffer[] = [];
  const add = (body: string | Buffer) => {
    objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"));
    return objects.length;
  };
  const stream = (dict: string, data: Buffer) => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]);
  const content = `${opts.image ? `q ${opts.pageW} 0 0 ${opts.pageH} 0 0 cm /Im0 Do Q\n` : ""}${opts.text ? `BT /F1 24 Tf 40 ${opts.pageH - 80} Td (${opts.text}) Tj ET\n` : ""}`;
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  add(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${opts.pageW} ${opts.pageH}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >>${opts.image ? " /XObject << /Im0 6 0 R >>" : ""} >> >>`,
  );
  add(stream("", Buffer.from(content, "latin1")));
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  if (opts.image) add(stream(`/Type /XObject /Subtype /Image /Width ${opts.image.width} /Height ${opts.image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, deflateSync(opts.image.rgb)));
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
    parts.push(chunk);
    length += chunk.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(parts);
}
