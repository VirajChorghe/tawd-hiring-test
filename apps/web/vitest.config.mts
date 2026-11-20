import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Subpaths first: "@tawd/core/intake" must not be caught by "@tawd/core".
    alias: {
      "@tawd/core/schema": path.join(import.meta.dirname, "../../packages/core/src/db/schema/index.ts"),
      "@tawd/core/db": path.join(import.meta.dirname, "../../packages/core/src/db/index.ts"),
      "@tawd/core/enums": path.join(import.meta.dirname, "../../packages/core/src/lib/enums.ts"),
      "@tawd/core/images": path.join(import.meta.dirname, "../../packages/core/src/lib/images/heic.ts"),
      "@tawd/core/activity": path.join(import.meta.dirname, "../../packages/core/src/lib/activity.ts"),
      "@tawd/core/permissions": path.join(import.meta.dirname, "../../packages/core/src/lib/permissions.ts"),
      "@tawd/core/recorded-answers": path.join(import.meta.dirname, "../../packages/core/src/lib/recorded-answers.ts"),
      "@tawd/core/intake/service": path.join(import.meta.dirname, "../../packages/core/src/lib/intake/service.ts"),
      "@tawd/core/intake/prefill": path.join(import.meta.dirname, "../../packages/core/src/lib/intake/prefill.ts"),
      "@tawd/core/intake/unconfirmed": path.join(import.meta.dirname, "../../packages/core/src/lib/intake/unconfirmed.ts"),
      "@tawd/core/intake/storage": path.join(import.meta.dirname, "../../packages/core/src/lib/intake/storage.ts"),
      "@tawd/core/intake/brand-guide": path.join(import.meta.dirname, "../../packages/core/src/lib/intake/brand-guide.ts"),
      "@tawd/core/content": path.join(import.meta.dirname, "../../packages/core/src/lib/content/draft.ts"),
      "@tawd/core/site": path.join(import.meta.dirname, "../../packages/core/src/lib/site/build.ts"),
      "@tawd/core/queue": path.join(import.meta.dirname, "../../packages/core/src/lib/mockups/queue.ts"),
      "@tawd/core/secrets": path.join(import.meta.dirname, "../../packages/core/src/lib/secrets.ts"),
      "@tawd/core/slack": path.join(import.meta.dirname, "../../packages/core/src/lib/slack.ts"),
      "@tawd/core/approved": path.join(import.meta.dirname, "../../packages/core/src/lib/mockups/approved.ts"),
      "@tawd/core/kept-home-words": path.join(import.meta.dirname, "../../packages/core/src/lib/mockups/kept-home-words.ts"),
      "@tawd/core/site-read": path.join(import.meta.dirname, "../../packages/core/src/lib/site/site-read.ts"),
      "@tawd/core/supplied-nav": path.join(import.meta.dirname, "../../packages/core/src/lib/site/supplied-nav.ts"),
      "@tawd/core/saved-answers": path.join(import.meta.dirname, "../../packages/core/src/lib/site/saved-answers.ts"),
      "@tawd/core/settings-check": path.join(import.meta.dirname, "../../packages/core/src/lib/settings-check.ts"),
      "@tawd/core/ssh-keys": path.join(import.meta.dirname, "../../packages/core/src/lib/ssh-keys.ts"),
      "@tawd/core/cloudflare-dns": path.join(import.meta.dirname, "../../packages/core/src/lib/cloudflare-dns.ts"),
      "@tawd/core/wp-preview": path.join(import.meta.dirname, "../../packages/core/src/lib/wp-preview.ts"),
      "@tawd/core/customer-access": path.join(import.meta.dirname, "../../packages/core/src/lib/customer-access.ts"),
      "@tawd/core/schema-version": path.join(import.meta.dirname, "../../packages/core/src/lib/schema-version.ts"),
      "@tawd/core/forms-relay": path.join(import.meta.dirname, "../../packages/core/src/lib/site/forms-relay.ts"),
      "@tawd/core/step-models": path.join(import.meta.dirname, "../../packages/core/src/lib/step-models.ts"),
      "@tawd/core/addons": path.join(import.meta.dirname, "../../packages/core/src/lib/addons.ts"),
      "@tawd/core/style-kit": path.join(import.meta.dirname, "../../packages/core/src/lib/style-kit"),
      "@tawd/core/stops": path.join(import.meta.dirname, "../../packages/core/src/lib/stops.ts"),
      "@tawd/core/twentyi-plan": path.join(import.meta.dirname, "../../packages/core/src/lib/twentyi-plan.ts"),
      "@tawd/core/section-library": path.join(import.meta.dirname, "../../packages/core/src/lib/mockups/section-library-store.ts"),
      "@tawd/core/stuck-work": path.join(import.meta.dirname, "../../packages/core/src/lib/stuck-work.ts"),
      "@tawd/core/scheduled-run": path.join(import.meta.dirname, "../../packages/core/src/lib/scheduled-run.ts"),
      "@tawd/core/paid-starts": path.join(import.meta.dirname, "../../packages/core/src/lib/paid-starts.ts"),
      "@tawd/core/public-address": path.join(import.meta.dirname, "../../packages/core/src/lib/public-address.ts"),
      "@tawd/core/text-safe": path.join(import.meta.dirname, "../../packages/core/src/lib/text-safe.ts"),
      "@tawd/core/figma/text-tidy": path.join(import.meta.dirname, "../../packages/core/src/lib/figma/text-tidy.ts"),
      "@tawd/core/figma/service": path.join(import.meta.dirname, "../../packages/core/src/lib/figma/service.ts"),
      "@tawd/core/figma/design-prefill": path.join(import.meta.dirname, "../../packages/core/src/lib/figma/design-prefill.ts"),
      "@tawd/core/figma/build-spec": path.join(import.meta.dirname, "../../packages/core/src/lib/figma/build-spec.ts"),
      "@tawd/core/figma/read-page": path.join(import.meta.dirname, "../../packages/core/src/lib/figma/read-page.ts"),
      "@tawd/core/figma/read-assets": path.join(import.meta.dirname, "../../packages/core/src/lib/figma/read-assets.ts"),
      "@tawd/core/figma/read-corrections": path.join(import.meta.dirname, "../../packages/core/src/lib/figma/read-corrections.ts"),
      "@tawd/core/figma/read-item-corrections": path.join(import.meta.dirname, "../../packages/core/src/lib/figma/read-item-corrections.ts"),
      "@tawd/core/figma/read-lock": path.join(import.meta.dirname, "../../packages/core/src/lib/figma/read-lock.ts"),
      "@tawd/core/figma": path.join(import.meta.dirname, "../../packages/core/src/lib/figma/index.ts"),
      "@tawd/core/mockups": path.join(import.meta.dirname, "../../packages/core/src/lib/mockups/index.ts"),
      "@tawd/core/intake": path.join(import.meta.dirname, "../../packages/core/src/lib/intake/index.ts"),
      "@": path.join(import.meta.dirname, "src"),
      "@tawd/core": path.join(import.meta.dirname, "../../packages/core/src"),
    },
  },
  test: {
    // Route handlers, the database and the auth layer all run on the server,
    // so there is no DOM to simulate.
    environment: "node",
    // The migrations run once and the migrated database is saved; each test copies it (src/test/db.ts).
    globalSetup: ["./src/test/global-setup.ts"],
    // Lets each test free its closed database's memory straight away (src/test/db.ts).
    execArgv: ["--expose-gc"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Each database test boots its own PostgreSQL in WebAssembly, which is
    // slower than a mock but proves the real triggers work. It starts from
    // the saved, migrated copy made by the global setup.
    // Two test files at a time by default (Jason, 26 September 2026): each
    // boots its own database and some open a real browser, and more at once
    // ran his laptop out of memory. TAWD_TEST_WORKERS raises it on a bigger machine.
    maxWorkers: Number(process.env.TAWD_TEST_WORKERS) || 2,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
