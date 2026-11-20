import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  /api/health (26 September 2026): the public answer is only "ok"; a signed-in
  team member also sees the web app's version and the worker's, from the
  worker's heartbeat, to confirm a deploy reached both.
*/

const state: { user: unknown } = { user: null };
vi.mock("@/lib/session", () => ({ getCurrentUser: async () => state.user }));

import { setDbForTesting, type Database } from "@tawd/core/db";
import pkg from "../../package.json";
import { GET } from "@/app/api/health/route";

import { recordHeartbeat } from "../../../worker/src/heartbeat";
import { createHarness, seedAdmin, type Harness } from "./harness";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
});

afterEach(async () => {
  setDbForTesting(null);
  await h.close();
});

const signedIn = () => new Request("http://t/api/health", { headers: { cookie: "better-auth.session_token=x" } });

describe("the health check", () => {
  it("tells the public only that it's up", async () => {
    expect(await (await GET(new Request("http://t/api/health"))).json()).toEqual({ status: "ok" });
  });

  it("shows a signed-in team member both versions, and whether they match", async () => {
    state.user = (await seedAdmin(h)).viewer;
    expect(await (await GET(signedIn())).json()).toMatchObject({ status: "ok", version: pkg.version, worker: null, settings: { workerReported: false } });

    await recordHeartbeat(new Date("2026-09-26T10:00:00Z"), h.db as never);
    const body = await (await GET(signedIn())).json();
    // From source the worker says "dev"; the bundle carries the app's version.
    expect(body.worker).toMatchObject({ version: "dev", sameVersion: false, startedAt: "2026-09-26T10:00:00.000Z" });
  });

  it("lists every setting per service, flags what's missing, and never shows a value (27 September 2026)", async () => {
    state.user = (await seedAdmin(h)).viewer;
    vi.stubEnv("DATAFORSEO_LOGIN", "secret-login-value");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("SHUTTERSTOCK_CLIENT_ID", "");
    try {
      await recordHeartbeat(new Date(), h.db as never);
      const text = await (await GET(signedIn())).text();
      expect(text).not.toContain("secret-login-value");
      const body = JSON.parse(text) as { settings: { ok: boolean; missing: string[]; workerReported: boolean; list: { name: string; web: string; worker: string; missing?: boolean }[] } };
      expect(body.settings.workerReported).toBe(true);
      const row = (name: string) => body.settings.list.find((r) => r.name === name)!;
      // The DataForSEO login is read by the web app only; the worker never needs it.
      expect(row("DATAFORSEO_LOGIN")).toMatchObject({ web: "set", worker: "not used" });
      // The worker runs every AI step: without the key it is flagged.
      expect(row("ANTHROPIC_API_KEY")).toMatchObject({ web: "not used", worker: "not set", missing: true });
      expect(body.settings.missing).toContain("ANTHROPIC_API_KEY on the worker");
      // Optional features show as not set without being flagged.
      expect(row("SHUTTERSTOCK_CLIENT_ID")).toMatchObject({ worker: "not set" });
      expect(row("SHUTTERSTOCK_CLIENT_ID").missing).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("counts email as set when either Resend or SMTP is", async () => {
    const { settingsCheck } = await import("@tawd/core/settings-check");
    const none = settingsCheck({ RESEND_API_KEY: false, SMTP_HOST: false }, null);
    expect(none.missing).toEqual(expect.arrayContaining(["RESEND_API_KEY on the web app", "SMTP_HOST on the web app"]));
    const smtp = settingsCheck({ RESEND_API_KEY: false, SMTP_HOST: true }, null);
    expect(smtp.missing.filter((m) => /RESEND|SMTP/.test(m))).toEqual([]);
  });
});
