import { afterEach, describe, expect, it, vi } from "vitest";
import pkg from "../../../../package.json";

const state: { user: unknown } = { user: null };
const getCurrentUser = vi.fn(async () => state.user);
vi.mock("@/lib/session", () => ({ getCurrentUser: () => getCurrentUser() }));

import { GET } from "./route";

afterEach(() => {
  state.user = null;
  getCurrentUser.mockClear();
});

const withCookie = (cookie: string) => new Request("https://tawd.velocitymedialab.com/api/health", { headers: { cookie } });

describe("GET /api/health", () => {
  it("responds 200 with JSON, never cached", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("says only ok to the public, without asking the database (security tidy-up, 26 September 2026)", async () => {
    expect(await (await GET(new Request("https://tawd.velocitymedialab.com/api/health"))).json()).toEqual({ status: "ok" });
    expect(getCurrentUser).not.toHaveBeenCalled();
    // A made-up cookie that isn't a real session still gets no version.
    expect(await (await GET(withCookie("better-auth.session_token=forged"))).json()).toEqual({ status: "ok" });
  });

  it("shows the version to a signed-in team member, not a disabled one", async () => {
    state.user = { id: "u1", isDisabled: false };
    const body = await (await GET(withCookie("__Secure-better-auth.session_token=abc"))).json();
    // No database here, so no worker heartbeat to show.
    expect(body).toMatchObject({ status: "ok", version: pkg.version, worker: null, settings: { workerReported: false } });
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);

    state.user = { id: "u1", isDisabled: true };
    expect(await (await GET(withCookie("better-auth.session_token=abc"))).json()).toEqual({ status: "ok" });
  });
});
