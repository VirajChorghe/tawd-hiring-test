/*
  Reading a Figma file through Figma's REST API, with a read-only personal
  access token (FIGMA_ACCESS_TOKEN, in Coolify for the web app and the
  worker). Reading costs nothing, but Figma limits how often a key may read
  (a View or Collab seat gets about 20 file reads a month), so every read
  is counted (figma_read) and what was read is kept, never read twice.

  Every failure becomes a FigmaError with a plain-words message for the
  team; the token itself is never logged or shown. The file's content is
  data, never instructions.
*/

export type FigmaErrorKind =
  | "not_configured"
  | "key_invalid"
  | "no_access"
  | "rate_limited"
  | "unavailable"
  | "bad_answer"
  | "too_large";

export class FigmaError extends Error {
  readonly kind: FigmaErrorKind;
  /** Figma's own words, when it gave any. */
  readonly detail: string | null;
  constructor(kind: FigmaErrorKind, message: string, detail: string | null = null) {
    super(message);
    this.name = "FigmaError";
    this.kind = kind;
    this.detail = detail;
  }
}

/* The parts of a Figma node TAWD reads. */
export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  /** 0 to 1; a fully transparent layer is not shown. */
  opacity?: number;
  /** Whether a frame hides what lies outside it (Figma's default for frames). */
  clipsContent?: boolean;
  children?: FigmaNode[];
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  fills?: { type: string; visible?: boolean; imageRef?: string; color?: { r: number; g: number; b: number; a?: number } }[];
  characters?: string;
  style?: { fontFamily?: string; fontWeight?: number; fontSize?: number };
  styleOverrideTable?: Record<string, { fontFamily?: string; fontWeight?: number; fontSize?: number }>;
}

export interface FigmaFile {
  name: string;
  lastModified: string;
  version: string;
  document: FigmaNode;
  /**
   * Set only on a file too large to read whole (13 October 2026): the pages
   * read in full; every other page holds only what Figma's depth=3 gives (what
   * is on the page and one layer inside: enough to
   * list it and count its frames).
   */
  tawdFullPages?: string[];
}

export interface FigmaApi {
  /** The whole file: pages, frames, text, fonts and image references. One read. Over MAX_FIGMA_BYTES: FigmaError "too_large". */
  getFile(fileKey: string): Promise<{ file: FigmaFile; raw: string }>;
  /** The file's outline (depth=3: pages, what is on each and one layer inside). One read. Over MAX_FIGMA_BYTES: FigmaError "too_large". */
  getOutline(fileKey: string): Promise<FigmaFile>;
  /** One page in full. One read. Over MAX_FIGMA_BYTES: FigmaError "too_large". */
  getPage(fileKey: string, pageId: string): Promise<FigmaNode>;
  /** Figma renders these frames to PNG and answers with a link to each (null when it could not). One read. */
  renderFrames(fileKey: string, ids: string[], scale: number): Promise<Record<string, string | null>>;
  /** Links to every image placed in the file, by its image reference. One read. */
  imageFills(fileKey: string): Promise<Record<string, string | null>>;
  /** Downloads a rendered frame or an image from the link Figma gave. Not a Figma API read. */
  download(url: string): Promise<Buffer>;
}

const BASE = "https://api.figma.com/v1";

/*
  The most of one Figma answer TAWD reads (13 October 2026, the whole-code
  review): a big design system's file runs to 100-300 MB, which the web app
  (1 GB) held twice. Counted as it arrives; past it the read stops.
*/
export const MAX_FIGMA_BYTES = 60_000_000;

async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_FIGMA_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new FigmaError("too_large", "The Figma file is too large to read whole.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FIGMA_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new FigmaError("too_large", "The Figma file is too large to read whole.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/* A GET to Figma's API, its answer read up to MAX_FIGMA_BYTES. */
async function getCapped(path: string): Promise<string> {
  const token = tokenOrThrow();
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { headers: { "X-Figma-Token": token }, signal: AbortSignal.timeout(90_000) });
  } catch {
    throw new FigmaError("unavailable", "Figma didn't answer. Try again in a few minutes.");
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw figmaErrorFor(response.status, body, response.headers);
  }
  try {
    return await readCapped(response);
  } catch (error) {
    if (error instanceof FigmaError) throw error;
    throw new FigmaError("unavailable", "Figma didn't answer. Try again in a few minutes.");
  }
}

function parsed<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new FigmaError("bad_answer", "Figma's answer could not be read.");
  }
}

function tokenOrThrow(): string {
  const token = process.env.FIGMA_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new FigmaError(
      "not_configured",
      "Figma isn't set up on the server yet: FIGMA_ACCESS_TOKEN is missing. An admin adds it in Coolify, for the web app and the worker.",
    );
  }
  return token;
}

function seconds(value: string | null): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "later";
  if (n < 120) return "in about a minute";
  if (n < 2 * 3600) return `in about ${Math.round(n / 60)} minutes`;
  if (n < 2 * 86400) return `in about ${Math.round(n / 3600)} hours`;
  return `in about ${Math.round(n / 86400)} days`;
}

/* What went wrong, in words the team can act on. Exported for the tests. */
export function figmaErrorFor(status: number, body: string, headers: { get(name: string): string | null }): FigmaError {
  let detail: string | null = null;
  try {
    const parsed = JSON.parse(body) as { err?: string; message?: string };
    detail = parsed.err ?? parsed.message ?? null;
  } catch {
    detail = body.trim().slice(0, 200) || null;
  }

  if (status === 403 && /token/i.test(detail ?? "")) {
    return new FigmaError(
      "key_invalid",
      "TAWD's Figma key has expired, was revoked or is wrong. An admin makes a new read-only key (File content: read-only) and replaces FIGMA_ACCESS_TOKEN in Coolify.",
      detail,
    );
  }
  if (status === 403 || status === 404) {
    return new FigmaError(
      "no_access",
      "The Figma key can't open this file. Check the link, and make sure the file is shared with the Figma account the key belongs to (for now, the designer's personal account).",
      detail,
    );
  }
  if (status === 429) {
    const low = headers.get("x-figma-rate-limit-type") === "low";
    return new FigmaError(
      "rate_limited",
      `Figma's read limit for TAWD's key has been reached${
        low ? " (the key's account has a View or Collab seat, which allows about 20 reads a month)" : ""
      }. Try again ${seconds(headers.get("retry-after"))}.`,
      detail,
    );
  }
  if (status >= 500) {
    return new FigmaError("unavailable", "Figma didn't answer properly. Try again in a few minutes.", detail);
  }
  return new FigmaError("bad_answer", `Figma refused the request (${status}).`, detail);
}

async function call<T>(path: string): Promise<T> {
  const token = tokenOrThrow();
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      headers: { "X-Figma-Token": token },
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw new FigmaError("unavailable", "Figma didn't answer. Try again in a few minutes.");
  }
  const body = await response.text();
  if (!response.ok) throw figmaErrorFor(response.status, body, response.headers);
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new FigmaError("bad_answer", "Figma's answer could not be read.");
  }
}

export const figmaApi: FigmaApi = {
  async getFile(fileKey) {
    const raw = await getCapped(`/files/${encodeURIComponent(fileKey)}`);
    return { file: parsed<FigmaFile>(raw), raw };
  },

  async getOutline(fileKey) {
    // Pages (1), what's on each page (2) and one layer inside (3): what the page list and its frame counts need.
    return parsed<FigmaFile>(await getCapped(`/files/${encodeURIComponent(fileKey)}?depth=3`));
  },

  async getPage(fileKey, pageId) {
    const answer = parsed<{ nodes?: Record<string, { document?: FigmaNode } | null> }>(
      await getCapped(`/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(pageId)}`),
    );
    const page = answer.nodes?.[pageId]?.document;
    if (!page) throw new FigmaError("bad_answer", "Figma did not send that page.");
    return page;
  },

  async renderFrames(fileKey, ids, scale) {
    const query = new URLSearchParams({ ids: ids.join(","), format: "png", scale: String(scale) });
    const answer = await call<{ err?: string | null; images?: Record<string, string | null> }>(
      `/images/${encodeURIComponent(fileKey)}?${query.toString()}`,
    );
    if (answer.err) throw new FigmaError("bad_answer", "Figma could not render the frames.", answer.err);
    return answer.images ?? {};
  },

  async imageFills(fileKey) {
    const answer = await call<{ meta?: { images?: Record<string, string | null> } }>(
      `/files/${encodeURIComponent(fileKey)}/images`,
    );
    return answer.meta?.images ?? {};
  },

  async download(url) {
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    } catch {
      throw new FigmaError("unavailable", "An image from Figma could not be downloaded. Try again in a few minutes.");
    }
    if (!response.ok) {
      throw new FigmaError("unavailable", `An image from Figma could not be downloaded (${response.status}).`);
    }
    // At most MAX_FIGMA_IMAGE_BYTES, counted as it arrives (13 October 2026, the whole-code review).
    const tooBig = () => new FigmaError("unavailable", `An image from Figma is over ${MAX_FIGMA_IMAGE_BYTES / 1_000_000} MB, so it wasn't downloaded.`);
    if (Number(response.headers.get("content-length") ?? 0) > MAX_FIGMA_IMAGE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw tooBig();
    }
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FIGMA_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw tooBig();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  },
};

/** The largest image TAWD downloads from Figma (a rendered frame or a placed photo). */
export const MAX_FIGMA_IMAGE_BYTES = 50_000_000;

let testApi: FigmaApi | null = null;

export function setFigmaForTesting(api: FigmaApi | null): void {
  testApi = api;
}

export function getFigma(): FigmaApi {
  return testApi ?? figmaApi;
}

/*
  The file key from anything the PM might paste: a design, file or
  prototype link (with or without www, a node-id or a title), or the key
  alone. Null when it is not a Figma file link.
*/
export function parseFigmaLink(input: string): string | null {
  const text = input.trim();
  if (/^[A-Za-z0-9]{15,40}$/.test(text)) return text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!/(^|\.)figma\.com$/i.test(url.hostname)) return null;
  const match = /^\/(?:design|file|proto)\/([A-Za-z0-9]{15,40})(?:\/|$)/.exec(url.pathname);
  return match ? match[1]! : null;
}
