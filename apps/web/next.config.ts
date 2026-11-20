import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
    @tawd/core is a workspace package shipping TypeScript source rather than
    a build output, so Next compiles it along with the app. One less build
    step, and the worker bundles the same source with esbuild.
  */
  transpilePackages: ["@tawd/core"],

  // Emits .next/standalone: a self-contained server bundled with only the
  // files it actually uses. The Dockerfile's final stage copies that, which
  // keeps the production image small and free of build tooling.
  output: "standalone",

  // The production build type-checks the app only. Tests (src/test) import
  // the worker and test helpers, and "pnpm typecheck" still checks them.
  typescript: { tsconfigPath: "tsconfig.build.json" },

  // In a pnpm workspace the real packages live in the repo-root
  // node_modules/.pnpm store, outside apps/web. Next traces dependencies
  // upward from this directory by default and would stop at apps/web,
  // producing a standalone build with missing modules. Pointing the tracing
  // root at the repo root makes it follow the symlinks into that store.
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),

  // TAWD is an internal tool: nothing it serves should be indexed, including
  // what robots.txt and the pages' own tag don't reach (API answers, mockup
  // files, downloads). A search engine that ignores robots.txt still obeys this.
  /*
    C5 (audit F-053): the security headers TAWD never sent. HSTS keeps the
    browser on https; nosniff stops a file being run as another type; the
    referrer policy keeps TAWD's paths out of other sites' logs; and
    frame-ancestors 'self' means no other site can frame TAWD to trick a click.
    The full Content-Security-Policy starts report-only, so nothing on the
    screens can break while it is tuned; frame-ancestors is enforced now.
  */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
          {
            key: "Content-Security-Policy-Report-Only",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' data: https://fonts.gstatic.com",
              "img-src 'self' data: blob: https:",
              "connect-src 'self'",
              "frame-src 'self' https:",
              "base-uri 'self'",
              "form-action 'self'",
              "object-src 'none'",
            ].join("; "),
          },
        ],
      },
    ];
  },

  // Don't say what the server runs (C5).
  poweredByHeader: false,
};

export default nextConfig;
