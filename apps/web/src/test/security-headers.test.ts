import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

/* C5 (audit F-053): the security headers on every TAWD response. */

describe("the security headers", () => {
  it("are sent on every path, and the server doesn't say what it runs", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*")!;
    const value = (key: string) => all.headers.find((h) => h.key === key)?.value;
    expect(value("Strict-Transport-Security")).toMatch(/max-age=\d{7,}/);
    expect(value("X-Content-Type-Options")).toBe("nosniff");
    expect(value("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(value("Content-Security-Policy")).toBe("frame-ancestors 'self'");
    expect(value("Content-Security-Policy-Report-Only")).toMatch(/default-src 'self'/);
    expect(value("X-Robots-Tag")).toMatch(/noindex/);
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
