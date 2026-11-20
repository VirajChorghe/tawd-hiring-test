import { Readable } from "node:stream";

import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import { STORAGE_CONNECT_MS, STORAGE_IDLE_MS, readWithin, storageClientConfig } from "@tawd/core/intake/storage";

/*
  CodeRabbit's review of #96 (14 November 2026): the storage client had no
  time limits, so a stalled connection could leave a call waiting forever.
*/

const env = { R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret" };

describe("the storage client's time limits", () => {
  it("gives up connecting after 10 s, and closes a connection idle for 2 minutes, but never caps a whole call", () => {
    const config = storageClientConfig(env);
    expect(STORAGE_CONNECT_MS).toBe(10_000);
    expect(STORAGE_IDLE_MS).toBe(120_000);
    expect(config.requestHandler).toEqual({ connectionTimeout: STORAGE_CONNECT_MS, socketTimeout: STORAGE_IDLE_MS });
    // No total-time limit: a large upload that keeps moving must not be cut off.
    expect(config.requestHandler).not.toHaveProperty("requestTimeout");
  });

  it("is taken up by the SDK's own request handler", async () => {
    const client = new S3Client(storageClientConfig(env));
    const handler = client.config.requestHandler as unknown as { configProvider?: Promise<Record<string, unknown>>; config?: Record<string, unknown> };
    const resolved = (await handler.configProvider) ?? handler.config ?? {};
    expect(resolved).toMatchObject({ connectionTimeout: STORAGE_CONNECT_MS, socketTimeout: STORAGE_IDLE_MS });
    client.destroy();
  });

  it("still points at Cloudflare R2 with the account's keys", () => {
    expect(storageClientConfig(env)).toMatchObject({ region: "auto", endpoint: "https://acct.r2.cloudflarestorage.com", credentials: { accessKeyId: "key", secretAccessKey: "secret" } });
  });
});

// Fable's review of #99: the request handler stops watching once the headers arrive, so a body that stalls needs its own limit.
describe("reading a whole file's body", () => {
  it("fails a body on which nothing arrives within the limit, and stops the stream", async () => {
    const body = new Readable({ read() {} });
    body.push(Buffer.from("first part"));
    const read = readWithin(body, 50);
    await expect(read).rejects.toThrow("Storage stopped sending this file (nothing for 0 s).");
    expect(body.destroyed).toBe(true);
  });

  it("fails a body that never sends anything", async () => {
    const body = new Readable({ read() {} });
    await expect(readWithin(body, 50)).rejects.toThrow("Storage stopped sending this file");
  });

  it("reads a body that keeps arriving, however long it takes in all", async () => {
    let n = 0;
    const body = new Readable({
      read() {
        n += 1;
        // Each part arrives well within the limit; together they take longer than it (wide margins, so a busy machine can't make it flaky).
        setTimeout(() => this.push(n <= 20 ? Buffer.from(`part${n};`) : null), 20);
      },
    });
    const expected = Array.from({ length: 20 }, (_, i) => `part${i + 1};`).join("");
    await expect(readWithin(body, 300)).resolves.toEqual(Buffer.from(expected));
  });

  it("fails at once when the connection closes before the end", async () => {
    const body = new Readable({ read() {} });
    const read = readWithin(body, 60_000);
    body.push(Buffer.from("half"));
    body.destroy();
    await expect(read).rejects.toThrow("Storage closed the connection before the whole file arrived.");
  });

  it("passes on a stream's own error", async () => {
    const body = new Readable({ read() {} });
    const read = readWithin(body, 1000);
    body.destroy(new Error("connection reset"));
    await expect(read).rejects.toThrow("connection reset");
  });
});
