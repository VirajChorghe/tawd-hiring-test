import { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";

/*
  File storage, in Cloudflare R2.

  Uploads go straight from the browser to Cloudflare using a short-lived
  permission slip signed here. The upload itself never passes through the
  container.

  That is not only tidiness. The container has a 1 GB memory limit on a
  droplet shared with Velocity Reports, and a 25 MB brand guide streamed
  through the app would sit in that budget on the way past.

  What the container does read afterwards: on confirm, the size from head()
  and the first bytes (a ranged read) to check the file is what it says it
  is; a HEIC photo (15 to 40 MB at most) or an SVG logo (5 MB) is read whole
  to convert or to check. A brand guide or design PDF is read whole later to
  parse it (brand-guide.ts, design-upload.ts). The size limit is checked
  from head() before any of this, so nothing over its limit is downloaded.

  Viewing works the same way round: a link that lasts five minutes, handed
  only to a signed-in user who is allowed to see the project.
*/

export const UPLOAD_URL_TTL_SECONDS = 5 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

export interface StoredObject {
  sizeBytes: number;
  contentType: string | null;
}

/**
 * Everything the app needs from object storage. Tests supply their own
 * implementation, so no test ever reaches the network.
 */
export interface FileStorage {
  signUpload(key: string, contentType: string): Promise<string>;
  signDownload(key: string, fileName: string): Promise<string>;
  head(key: string): Promise<StoredObject | null>;
  remove(key: string): Promise<void>;
  /**
   * Copies an object inside the bucket, on the storage side (nothing passes
   * through the container). The copy is a snapshot: a permission slip for
   * the source key can no longer change it.
   */
  copy(from: string, to: string): Promise<void>;
  /*
    Writes an object from the server.

    Intake files never use this - they go straight from the browser to
    Cloudflare. This is for artefacts the worker produces itself, such as a
    rendered concept, which have nowhere else to come from.
  */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Reads an object back, for the client pack. */
  get(key: string): Promise<Buffer | null>;
  /**
   * Reads bytes start..end (inclusive) of an object: a ranged read, so the
   * first bytes of a large file can be checked without downloading it. Null
   * when the object isn't there. Optional: readRange falls back to get.
   */
  getRange?(key: string, start: number, end: number): Promise<Buffer | null>;
  /**
   * Every key under a prefix. Used when a project is deleted, to find its
   * files and then to prove none are left.
   */
  list(prefix: string): Promise<string[]>;
  /*
    Build B on 20i (5 October 2026): a WordPress site's backup streams from
    the site to R2 and back, never held whole in memory (the worker's 2 GB
    limit). Optional: the helpers below fall back to put and get.
  */
  putStream?(key: string, body: Readable, contentType: string): Promise<number>;
  getStream?(key: string): Promise<Readable | null>;
}

/** The size of each part of a streamed upload: at most one part is in memory at a time. */
export const STREAM_PART_BYTES = 8 * 1024 * 1024;

/* Reads a stream into parts of a fixed size; the source is paused while a part is handled (backpressure). */
export async function forEachPart(body: Readable, size: number, handle: (part: Buffer, index: number) => Promise<void>): Promise<number> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let total = 0;
  let index = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    pending.push(buf);
    pendingBytes += buf.length;
    total += buf.length;
    while (pendingBytes >= size) {
      const all = Buffer.concat(pending);
      await handle(all.subarray(0, size), index++);
      const rest = all.subarray(size);
      pending = rest.length ? [rest] : [];
      pendingBytes = rest.length;
    }
  }
  if (pendingBytes > 0 || index === 0) await handle(Buffer.concat(pending), index++);
  return total;
}

/** The four calls of a multipart upload (R2's S3 API; tests keep the parts in memory). */
export interface MultipartCalls {
  start(): Promise<string>;
  /** Sends one part; answers its ETag. */
  part(uploadId: string, partNumber: number, body: Buffer): Promise<string>;
  complete(uploadId: string, parts: { ETag: string; PartNumber: number }[]): Promise<void>;
  abort(uploadId: string): Promise<void>;
}

/* A stream sent in parts, one part in memory at a time; any failure aborts the upload (nothing half-written is left) and is thrown on. */
export async function multipartUpload(calls: MultipartCalls, body: Readable, partBytes = STREAM_PART_BYTES): Promise<number> {
  const uploadId = await calls.start();
  if (!uploadId) throw new Error("R2 didn't start the upload.");
  const parts: { ETag: string; PartNumber: number }[] = [];
  try {
    const total = await forEachPart(body, partBytes, async (part, index) => {
      parts.push({ ETag: await calls.part(uploadId, index + 1, part), PartNumber: index + 1 });
    });
    await calls.complete(uploadId, parts);
    return total;
  } catch (error) {
    await calls.abort(uploadId).catch(() => undefined);
    throw error;
  }
}

/** True only when storage said the object isn't there (404, NoSuchKey); anything else (a 5xx, a timeout) is a real error. */
export function isMissingObject(error: unknown): boolean {
  const e = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } } | null;
  return Boolean(e && (e.name === "NoSuchKey" || e.name === "NotFound" || e.Code === "NoSuchKey" || e.$metadata?.httpStatusCode === 404));
}

/** Writes a stream to storage: multipart where the storage streams, otherwise read whole (tests). Returns the bytes written. */
export async function putStreamTo(storage: FileStorage, key: string, body: Readable, contentType: string): Promise<number> {
  if (storage.putStream) return storage.putStream(key, body, contentType);
  const parts: Buffer[] = [];
  const total = await forEachPart(body, STREAM_PART_BYTES, async (part) => {
    parts.push(Buffer.from(part));
  });
  await storage.put(key, Buffer.concat(parts), contentType);
  return total;
}

/** The first `length` bytes of an object (a ranged read where storage has one); null when it isn't there. */
export async function readRange(storage: FileStorage, key: string, length: number): Promise<Buffer | null> {
  if (storage.getRange) return storage.getRange(key, 0, length - 1);
  const body = await storage.get(key);
  return body ? body.subarray(0, length) : null;
}

/** Reads an object as a stream; null when it isn't there (a storage error is thrown, never read as "gone"). */
export async function getStreamFrom(storage: FileStorage, key: string): Promise<Readable | null> {
  if (storage.getStream) return storage.getStream(key);
  const body = await storage.get(key);
  return body ? Readable.from([body]) : null;
}

const storageEnvSchema = z.object({
  R2_ACCOUNT_ID: z.string().min(1, "R2_ACCOUNT_ID is not set"),
  R2_ACCESS_KEY_ID: z.string().min(1, "R2_ACCESS_KEY_ID is not set"),
  R2_SECRET_ACCESS_KEY: z.string().min(1, "R2_SECRET_ACCESS_KEY is not set"),
  R2_BUCKET: z.string().min(1, "R2_BUCKET is not set"),
});

/*
  Validated on first use rather than at import, like the rest of the
  environment: `next build` imports every module in a container that has no
  credentials, and the tests never touch this path at all.
*/
function getStorageEnv() {
  const parsed = storageEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `File storage is not configured:\n${parsed.error.issues
        .map((issue) => `  - ${issue.message}`)
        .join("\n")}`,
    );
  }
  return parsed.data;
}

/*
  Time limits on storage calls (CodeRabbit's review of #96, 14 November 2026).
  Without them a stalled connection could leave a call waiting forever (a
  worker job holding its browser, a page that never loads).
  - Connecting may take STORAGE_CONNECT_MS.
  - Until the response headers arrive, a request on which nothing moves for
    STORAGE_IDLE_MS fails (the handler's socket timeout; the SDK then retries
    it, up to three tries in all, so a stalled call gives up after about six
    minutes, not two).
  - When the headers arrive within about 3 s (the usual case) the handler
    stops watching (Fable's reviews of #99), so get and getRange read the body
    through readWithin, which fails a body on which nothing arrives for
    STORAGE_IDLE_MS. (When headers take longer, the socket's own idle limit
    stays on as well.)
  - getStream is not given a body limit: its stream is piped into a restore
    that reads at its own pace, where a pause is normal (only the socket's own
    idle limit can apply, in the slow-headers case above).
  None of these caps a whole call: a large upload or download that keeps
  moving is never cut off.
*/
export const STORAGE_CONNECT_MS = 10_000;
export const STORAGE_IDLE_MS = 120_000;

export function storageClientConfig(env: { R2_ACCOUNT_ID: string; R2_ACCESS_KEY_ID: string; R2_SECRET_ACCESS_KEY: string }) {
  return {
    // R2 speaks the S3 API. The region is ignored but the SDK insists on one.
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
    requestHandler: { connectionTimeout: STORAGE_CONNECT_MS, socketTimeout: STORAGE_IDLE_MS },
  };
}

/** A whole body read, failing if nothing arrives for `idleMs` (the request handler stops watching once headers arrive). */
export function readWithin(body: Readable, idleMs: number = STORAGE_IDLE_MS): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        body.destroy();
        reject(new Error(`Storage stopped sending this file (nothing for ${Math.round(idleMs / 1000)} s).`));
      }, idleMs);
    };
    arm();
    body.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      arm();
    });
    body.once("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    body.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    // Closed without an end (the connection dropped): fail now rather than after the idle limit. After an end this does nothing.
    body.once("close", () => {
      clearTimeout(timer);
      reject(new Error("Storage closed the connection before the whole file arrived."));
    });
  });
}

/* The SDK's body: a Node stream on the server (read with the idle limit), else its own reader. */
async function bodyBytes(body: unknown): Promise<Buffer> {
  if (body instanceof Readable) return readWithin(body);
  return Buffer.from(await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray());
}

let cachedClient: S3Client | null = null;
let cachedBucket: string | null = null;

function getClient(): { client: S3Client; bucket: string } {
  if (cachedClient && cachedBucket) {
    return { client: cachedClient, bucket: cachedBucket };
  }

  const env = getStorageEnv();

  cachedClient = new S3Client(storageClientConfig(env));
  cachedBucket = env.R2_BUCKET;

  return { client: cachedClient, bucket: cachedBucket };
}

export const r2Storage: FileStorage = {
  async signUpload(key, contentType) {
    const { client, bucket } = getClient();
    // Signing the content type means the browser cannot upload a script and
    // call it a PNG: the upload is rejected unless the header matches.
    return getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
      { expiresIn: UPLOAD_URL_TTL_SECONDS },
    );
  },

  async signDownload(key, fileName) {
    const { client, bucket } = getClient();
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        // Hand the browser the original name rather than the storage key.
        ResponseContentDisposition: `inline; filename="${fileName.replace(/"/g, "")}"`,
      }),
      { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
    );
  },

  async head(key) {
    const { client, bucket } = getClient();
    try {
      const result = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      return {
        sizeBytes: result.ContentLength ?? 0,
        contentType: result.ContentType ?? null,
      };
    } catch (error) {
      // Not found, or not uploaded yet: nothing there. Any other failure (R2 briefly down) is thrown, never read as "missing",
      // so an upload's record is never removed over an outage (13 October 2026, the whole-code review).
      if (isMissing(error)) return null;
      throw error;
    }
  },

  async remove(key) {
    const { client, bucket } = getClient();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  },

  async copy(from, to) {
    const { client, bucket } = getClient();
    await client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: to,
        // S3 wants "bucket/key", URL-encoded, slashes kept.
        CopySource: `${bucket}/${encodeURIComponent(from).replace(/%2F/g, "/")}`,
        MetadataDirective: "COPY",
      }),
    );
  },

  async put(key, body, contentType) {
    const { client, bucket } = getClient();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  },

  async get(key) {
    const { client, bucket } = getClient();
    try {
      const result = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      if (!result.Body) return null;
      return bodyBytes(result.Body);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  },

  async getRange(key, start, end) {
    const { client, bucket } = getClient();
    try {
      const result = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${start}-${end}` }),
      );
      if (!result.Body) return null;
      return bodyBytes(result.Body);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  },

  async putStream(key, body, contentType) {
    const { client, bucket } = getClient();
    return multipartUpload(
      {
        start: async () => (await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }))).UploadId ?? "",
        part: async (uploadId, partNumber, part) => (await client.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: part }))).ETag ?? "",
        complete: async (uploadId, parts) => void (await client.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }))),
        abort: async (uploadId) => void (await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }))),
      },
      body,
    );
  },

  async getStream(key) {
    const { client, bucket } = getClient();
    try {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return result.Body instanceof Readable ? result.Body : null;
    } catch (error) {
      // Only "not there" is null: a 5xx or a timeout is thrown, so a backup is never called gone when R2 just hiccuped (Fable's code review, finding 16).
      if (isMissingObject(error)) return null;
      throw error;
    }
  },

  async list(prefix) {
    const { client, bucket } = getClient();
    const keys: string[] = [];
    let token: string | undefined;

    // A page is at most 1,000 keys; keep asking until R2 says there are no more.
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const item of page.Contents ?? []) {
        if (item.Key) keys.push(item.Key);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);

    return keys;
  },
};

/*
  Where all of one project's files live.

  Refuses anything but a real project id. An empty or malformed id would
  give "projects/" or "projects/x" as the prefix, and deleting under that
  would reach other clients' files.
*/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function projectStoragePrefix(projectId: string): string {
  if (!UUID.test(projectId)) {
    throw new Error(`Not a project id: "${projectId}"`);
  }
  return `projects/${projectId.toLowerCase()}/`;
}

let storageOverride: FileStorage | null = null;

export function getStorage(): FileStorage {
  return storageOverride ?? r2Storage;
}

/** Only for tests, which supply a fake in place of Cloudflare. */
export function setStorageForTesting(storage: FileStorage | null): void {
  storageOverride = storage;
}

/**
 * Where a file lives in the bucket.
 *
 * Grouped by project so everything for a client can be found or removed
 * together, and prefixed with the row id so two files with the same name
 * cannot collide.
 */
export function buildStorageKey(
  projectId: string,
  kind: string,
  fileId: string,
  fileName: string,
): string {
  const safeName =
    fileName
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "file";

  return `projects/${projectId}/${kind}/${fileId}-${safeName}`;
}

const READY_KEY = /^(projects\/[^/]+\/[^/]+\/)(?!ready\/)/;

/** Whether this key is a ready key: one no permission slip was ever signed for. */
export const isReadyKey = (key: string): boolean => /^projects\/[^/]+\/[^/]+\/ready\//.test(key);

/**
 * Where a confirmed upload lives (CodeRabbit #81): confirm copies the
 * object here, so the permission slip that wrote the upload key (good for
 * five minutes and reusable until then) cannot overwrite a checked file.
 */
export const readyKeyOf = (uploadKey: string): string => (isReadyKey(uploadKey) ? uploadKey : uploadKey.replace(READY_KEY, "$1ready/"));

/* R2's "there is no such file" (404, NoSuchKey or NotFound), as opposed to any other failure. */
export function isMissing(error: unknown): boolean {
  const e = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } } | null;
  return Boolean(e && (e.name === "NotFound" || e.name === "NoSuchKey" || e.Code === "NoSuchKey" || e.$metadata?.httpStatusCode === 404));
}
