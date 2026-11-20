import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../../worker/src/config";

/* C7 (audit F-050): the worker refuses to start without the encryption key, instead of failing half-way through a WordPress job. */

const ALL = {
  DATABASE_URL: "postgres://x",
  REDIS_URL: "redis://x",
  ANTHROPIC_API_KEY: "test-key",
  R2_ACCOUNT_ID: "a",
  R2_ACCESS_KEY_ID: "b",
  R2_SECRET_ACCESS_KEY: "c",
  R2_BUCKET: "d",
  TAWD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

describe("the worker's start-up check", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("starts with everything set", () => {
    for (const [k, v] of Object.entries(ALL)) vi.stubEnv(k, v);
    expect(() => loadConfig()).not.toThrow();
  });

  it("refuses to start without TAWD_ENCRYPTION_KEY, and says which", () => {
    for (const [k, v] of Object.entries(ALL)) vi.stubEnv(k, v);
    vi.stubEnv("TAWD_ENCRYPTION_KEY", "");
    expect(() => loadConfig()).toThrow(/TAWD_ENCRYPTION_KEY/);
  });

  it("refuses a key of only spaces (CodeRabbit #81)", () => {
    for (const [k, v] of Object.entries(ALL)) vi.stubEnv(k, v);
    vi.stubEnv("TAWD_ENCRYPTION_KEY", "   ");
    expect(() => loadConfig()).toThrow(/TAWD_ENCRYPTION_KEY/);
  });

  it("refuses a key that isn't 32 bytes, and never prints it", () => {
    for (const [k, v] of Object.entries(ALL)) vi.stubEnv(k, v);
    const wrong = Buffer.alloc(16, 9).toString("base64");
    vi.stubEnv("TAWD_ENCRYPTION_KEY", wrong);
    let message = "";
    try {
      loadConfig();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/TAWD_ENCRYPTION_KEY/);
    expect(message).toMatch(/32/);
    expect(message).not.toContain(wrong);
  });

  it("accepts a key with stray spaces around it, as the web app does", () => {
    for (const [k, v] of Object.entries(ALL)) vi.stubEnv(k, v);
    vi.stubEnv("TAWD_ENCRYPTION_KEY", `  ${ALL.TAWD_ENCRYPTION_KEY}\n`);
    expect(() => loadConfig()).not.toThrow();
  });
});
