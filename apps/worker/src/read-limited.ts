/*
  One answer read politely (6-7 October 2026): the site reader's and the
  Internet Archive reader's shared parts. A body over the size limit is
  refused rather than cut (its words would be half there).
*/

import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { publicOnlyLookup } from "@tawd/core/public-address";

export const IMPORT_MAX_BYTES = 6_000_000;

/** One answer, before redirects are followed. */
export interface RawAnswer {
  status: number;
  header(name: string): string | null;
  /** The body up to the size limit, or null when it's bigger. */
  body(): Promise<string | null>;
}
export type Requester = (url: string) => Promise<RawAnswer>;

/*
  A body as text, by the charset it declares (F-052): the Content-Type's
  charset, then a <meta charset> or http-equiv in the first 1024 bytes,
  then UTF-8. A label TextDecoder doesn't know is UTF-8 too.
*/
export function decodeBody(bytes: Buffer, contentType: string | null | undefined): string {
  const fromHeader = /charset\s*=\s*["']?\s*([^\s;"']+)/i.exec(contentType ?? "")?.[1];
  const head = bytes.subarray(0, 1024).toString("latin1");
  const fromPage = /<meta[^>]+charset\s*=\s*["']?\s*([^\s;"'>/]+)/i.exec(head)?.[1];
  for (const label of [fromHeader, fromPage]) {
    if (!label) continue;
    try {
      return new TextDecoder(label.trim().toLowerCase()).decode(bytes);
    } catch {
      // An unknown label: the next source, then UTF-8.
    }
  }
  return bytes.toString("utf8");
}

/* Reads the body up to the size limit. */
export async function readLimited(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > IMPORT_MAX_BYTES) return null;
  if (!response.body) return decodeBody(Buffer.from(await response.arrayBuffer()), response.headers.get("content-type"));
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > IMPORT_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return decodeBody(Buffer.concat(chunks), response.headers.get("content-type"));
}

/*
  One request connected only to the addresses publicOnlyLookup checked (14
  October 2026, the whole-code review): refusePrivate checks a name before
  the request, and fetch then looked it up again, so a name that changed
  its answer in between could reach a private address. Compressed answers
  are unpacked, and the size limit counts the unpacked bytes.
*/
export function pinnedRequest(timeoutMs: number, headers: Record<string, string>): Requester {
  return (url) =>
    new Promise<RawAnswer>((resolve, reject) => {
      const parsed = new URL(url);
      const get = parsed.protocol === "https:" ? https.get : http.get;
      const request = get(parsed, { lookup: publicOnlyLookup, signal: AbortSignal.timeout(timeoutMs), headers: { ...headers, "Accept-Encoding": "gzip, deflate, br" } }, (response) => {
        const header = (name: string) => {
          const value = response.headers[name.toLowerCase()];
          return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
        };
        resolve({
          status: response.statusCode ?? 0,
          header,
          body: () =>
            new Promise<string | null>((done, fail) => {
              if (Number(header("content-length") ?? 0) > IMPORT_MAX_BYTES && !header("content-encoding")) {
                response.destroy();
                done(null);
                return;
              }
              const encoding = (header("content-encoding") ?? "").trim().toLowerCase();
              const body: NodeJS.ReadableStream =
                encoding === "gzip" || encoding === "x-gzip"
                  ? response.pipe(zlib.createGunzip())
                  : encoding === "deflate"
                    ? response.pipe(zlib.createInflate())
                    : encoding === "br"
                      ? response.pipe(zlib.createBrotliDecompress())
                      : response;
              const chunks: Buffer[] = [];
              let size = 0;
              body.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > IMPORT_MAX_BYTES) {
                  response.destroy();
                  done(null);
                  return;
                }
                chunks.push(chunk);
              });
              body.on("end", () => done(decodeBody(Buffer.concat(chunks), header("content-type"))));
              body.on("error", (error: Error) => {
                response.destroy();
                fail(error);
              });
              response.on("error", fail);
            }),
        });
      });
      request.on("error", reject);
    });
}
