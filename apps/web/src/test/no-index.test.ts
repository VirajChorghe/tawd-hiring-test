import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/font/local", () => ({ default: () => ({ className: "", variable: "", style: {} }) }));

import nextConfig from "../../next.config";
import { metadata } from "@/app/layout";

/* Security tidy-up (26 September 2026): nothing TAWD serves is indexed. */
describe("don't index", () => {
  it("sends X-Robots-Tag noindex on every path", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*");
    expect(all?.headers).toContainEqual({ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet" });
  });

  it("keeps robots.txt shut and the pages' own noindex tag", () => {
    const robots = fs.readFileSync(path.resolve(__dirname, "../../public/robots.txt"), "utf8");
    expect(robots).toMatch(/User-agent: \*\s+Disallow: \/\s*$/);
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});

/* The font is in the repo (28 September 2026): the build never calls Google's font servers. */
describe("the typeface", () => {
  it("is loaded from the repo's own file, with its licence", () => {
    const layout = fs.readFileSync(path.join(__dirname, "../app/layout.tsx"), "utf8");
    expect(layout).toContain('from "next/font/local"');
    expect(layout).not.toContain("next/font/google");
    const font = fs.readFileSync(path.join(__dirname, "../app/fonts/hanken-grotesk-latin.woff2"));
    expect(font.subarray(0, 4).toString("latin1")).toBe("wOF2");
    expect(fs.readFileSync(path.join(__dirname, "../app/fonts/OFL.txt"), "utf8")).toContain("SIL OPEN FONT LICENSE");
  });
});
