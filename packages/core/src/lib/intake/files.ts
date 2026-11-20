/*
  Upload rules.

  No imports, so the uploader in the browser and the checks on the server use
  exactly the same numbers. A limit that exists only on one side is not a
  limit.
*/

export const fileKinds = [
  "logo",
  "brand_guide",
  "photo",
  "content_document",
  // A Screaming Frog crawl export the SEO team attaches to a full SEO audit (optional extra evidence).
  "seo_crawl_export",
  // Lane 2 without Figma (28 September 2026): the design as a PDF, or one image per page.
  "design_file",
  // A finished homepage made as one self-contained HTML file (the direct route: no picture of the page to read).
  "homepage_html",
] as const;
export type FileKind = (typeof fileKinds)[number];

export interface KindRules {
  label: string;
  /** Exact MIME types. Anything else is refused. */
  contentTypes: string[];
  maxBytes: number;
  /** How many of this kind a project may have. */
  maxCount: number;
  /** For the file picker's filter. */
  accept: string;
}

const MB = 1024 * 1024;

export const fileRules: Record<FileKind, KindRules> = {
  logo: {
    label: "Logo",
    // HEIC/HEIF (iPhone) are accepted and converted to JPEG at ingress (gap 11).
    contentTypes: ["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/heic", "image/heif"],
    maxBytes: 5 * MB,
    // One logo. Replacing it means removing the old one, which keeps it
    // obvious which file the mockups will actually use.
    maxCount: 1,
    accept: ".png,.jpg,.jpeg,.webp,.svg,.heic,.heif",
  },
  brand_guide: {
    label: "Brand guide",
    contentTypes: ["application/pdf"],
    maxBytes: 25 * MB,
    maxCount: 3,
    accept: ".pdf",
  },
  photo: {
    label: "Photo",
    // HEIC/HEIF (iPhone) are accepted and converted to JPEG at ingress (gap 11).
    contentTypes: ["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"],
    maxBytes: 15 * MB,
    maxCount: 60,
    accept: ".png,.jpg,.jpeg,.webp,.heic,.heif",
  },
  content_document: {
    label: "Content document",
    contentTypes: [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
      "text/markdown",
    ],
    maxBytes: 15 * MB,
    maxCount: 20,
    accept: ".pdf,.docx,.txt,.md",
  },
  seo_crawl_export: {
    label: "Screaming Frog export",
    contentTypes: ["text/csv", "application/vnd.ms-excel", "text/plain"],
    maxBytes: 25 * MB,
    maxCount: 2,
    accept: ".csv",
  },
  design_file: {
    label: "Design (PDF or images)",
    // HEIC/HEIF (iPhone) are accepted and converted to JPEG at ingress (gap 11).
    contentTypes: ["application/pdf", "image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"],
    maxBytes: 40 * MB,
    maxCount: 30,
    accept: ".pdf,.png,.jpg,.jpeg,.webp,.heic,.heif",
  },
  homepage_html: {
    label: "Finished homepage (HTML)",
    contentTypes: ["text/html"],
    // These pages are self-contained with their photos embedded, so a real one is about 500 KB; 10 MB leaves room.
    maxBytes: 10 * MB,
    // One homepage. Replacing it means removing the old one, so it is obvious which file TAWD reads
    // (the same rule, for the same reason, as the logo).
    maxCount: 1,
    accept: ".html,.htm",
  },
};

export function isFileKind(value: string): value is FileKind {
  return (fileKinds as readonly string[]).includes(value);
}

export type UploadRefusal =
  | { ok: false; message: string }
  | { ok: true };

/*
  What a file's NAME says it is, when its type cannot say (Jason, 10
  November 2026: "I thought we fixed this").

  Gap 11 made TAWD accept an iPhone photo and convert it to JPEG at
  ingress, and the upload screen lists heic among the kinds allowed - but
  the gate was the CONTENT TYPE, and Windows and Chrome report no type at
  all for a .HEIC file. So the type arrived empty, nothing matched, and the
  upload was refused by the same screen that said heic was fine.

  The name is asked only when the browser gave nothing useful, and it can
  only allow a kind this upload already allows: a name never overrules a
  type the browser did give, so renaming a program ".jpg" gets nobody past
  this. Since F-041 (12 November 2026) every upload's first bytes are
  checked against its type when it is confirmed (confirmUpload, service.ts,
  with sniff.ts), whether the type came from the browser or the name: bytes
  that don't fit are refused and the object removed, and an image keeps the
  type its bytes show.
*/
const NO_TYPE = ["", "application/octet-stream", "binary/octet-stream"];

/** The browser (or the stored object) gave no useful type. */
export function isNoType(contentType: string | null | undefined): boolean {
  return NO_TYPE.includes((contentType ?? "").trim().toLowerCase());
}

/*
  The image type a file's first bytes show: PNG, JPEG, WebP or SVG (HEIC
  is told by isHeic, images/heic.ts). Null for anything else.
*/
export function imageTypeOfBytes(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  // Up to 4 KB: a licence comment or a DOCTYPE subset can come before the <svg> tag.
  const head = bytes.subarray(0, 4096).toString("utf8").replace(/^﻿/, "").trimStart();
  if (/^(?:<\?[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\]\s*)?>\s*)*<svg\b/i.test(head)) return "image/svg+xml";
  return null;
}
const TYPE_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  // Only a kind whose rules list text/html (homepage_html) can use these; every other kind still refuses it.
  html: "text/html",
  htm: "text/html",
};

/** The content type a file name implies, or null when its extension is not one TAWD takes. */
export function typeFromFileName(fileName: string): string | null {
  const extension = /\.([a-z0-9]+)$/i.exec(fileName.trim())?.[1]?.toLowerCase();
  return extension ? (TYPE_BY_EXTENSION[extension] ?? null) : null;
}

/*
  The type to judge and to keep: the browser's, or the one the name implies
  when the browser gave nothing useful. Kept on the row as well, so every
  later step that reads a file's type still knows what it is.
*/
export function effectiveContentType(contentType: string, fileName = ""): string {
  const declared = contentType.trim().toLowerCase();
  return isNoType(declared) ? (typeFromFileName(fileName) ?? declared) : declared;
}

export function checkUpload(
  kind: FileKind,
  contentType: string,
  sizeBytes: number,
  existingCount: number,
  fileName = "",
): UploadRefusal {
  const rules = fileRules[kind];
  const effective = effectiveContentType(contentType, fileName);

  if (!rules.contentTypes.includes(effective)) {
    return {
      ok: false,
      message: `${rules.label} must be one of: ${rules.accept.replace(/\./g, "").replace(/,/g, ", ")}.`,
    };
  }

  if (sizeBytes <= 0) {
    return { ok: false, message: "That file appears to be empty." };
  }

  if (sizeBytes > rules.maxBytes) {
    return {
      ok: false,
      message: `${rules.label} must be ${formatBytes(rules.maxBytes)} or smaller. That one is ${formatBytes(sizeBytes)}.`,
    };
  }

  if (existingCount >= rules.maxCount) {
    return {
      ok: false,
      message:
        rules.maxCount === 1
          ? `There is already a ${rules.label.toLowerCase()}. Remove it first.`
          : `That is the most ${rules.label.toLowerCase()}s allowed (${rules.maxCount}).`,
    };
  }

  return { ok: true };
}

export function formatBytes(bytes: number): string {
  if (bytes >= MB) {
    const value = bytes / MB;
    return `${value >= 10 ? Math.round(value) : value.toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
