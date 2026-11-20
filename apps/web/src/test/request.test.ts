import { describe, expect, it } from "vitest";

import { getClientIp, getUserAgent } from "@/lib/request";

/*
  TAWD sits behind Coolify's proxy, so the socket address is always the proxy.
  The visitor's real address has to come from a forwarded header or the
  activity log records the wrong thing for everyone.
*/

describe("finding the visitor's address behind the proxy", () => {
  it("reads x-forwarded-for", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.7" });
    expect(getClientIp(headers)).toBe("203.0.113.7");
  });

  // C4 (audit F-022): the leftmost entry is whatever the caller typed; the audit changed it on every try and was never throttled.
  it("takes the entry our own proxy added (the rightmost), never the one the caller typed", () => {
    const headers = new Headers({
      "x-forwarded-for": "6.6.6.6, 203.0.113.7",
    });
    expect(getClientIp(headers)).toBe("203.0.113.7");
  });

  it("copes with the spaces proxies leave behind", () => {
    const headers = new Headers({
      "x-forwarded-for": "198.51.100.2,   203.0.113.7   ",
    });
    expect(getClientIp(headers)).toBe("203.0.113.7");
  });

  it("reads x-real-ip, which Coolify's proxy sets itself", () => {
    const headers = new Headers({ "x-real-ip": "203.0.113.9" });
    expect(getClientIp(headers)).toBe("203.0.113.9");
  });

  it("prefers x-real-ip when both are present (the caller can't set it past the proxy)", () => {
    const headers = new Headers({
      "x-forwarded-for": "6.6.6.6",
      "x-real-ip": "203.0.113.9",
    });
    expect(getClientIp(headers)).toBe("203.0.113.9");
  });

  it("returns null rather than guessing when neither is present", () => {
    expect(getClientIp(new Headers())).toBeNull();
  });

  it("returns null for an empty header instead of an empty string", () => {
    expect(getClientIp(new Headers({ "x-forwarded-for": "" }))).toBeNull();
    expect(getClientIp(new Headers({ "x-forwarded-for": "  ,  " }))).toBeNull();
  });

  it("handles IPv6, which contains colons of its own", () => {
    const headers = new Headers({
      "x-forwarded-for": "198.51.100.2, 2001:db8::1",
    });
    expect(getClientIp(headers)).toBe("2001:db8::1");
  });
});

describe("recording the browser", () => {
  it("passes an ordinary user agent through", () => {
    const headers = new Headers({ "user-agent": "Mozilla/5.0 (Windows NT)" });
    expect(getUserAgent(headers)).toBe("Mozilla/5.0 (Windows NT)");
  });

  it("returns null when there is none", () => {
    expect(getUserAgent(new Headers())).toBeNull();
  });

  it("truncates an absurdly long one so the log stays readable", () => {
    const headers = new Headers({ "user-agent": "x".repeat(2000) });
    expect(getUserAgent(headers)).toHaveLength(512);
  });
});
