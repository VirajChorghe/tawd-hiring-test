import path from "node:path";
import { fileURLToPath } from "node:url";

import { copyFileSync, readFileSync } from "node:fs";

import { build } from "esbuild";

/*
  Bundles the worker into one file.

  The worker imports TypeScript straight out of @tawd/core, so something has
  to compile it. Bundling also means the production image carries no
  node_modules for our own code.

  Playwright stays external: it finds the browser it was installed with at
  runtime, and bundling it breaks that.
*/
const here = path.dirname(fileURLToPath(import.meta.url));
// The app version the web app shows, so the worker reports the same one (heartbeat.ts).
const appVersion = JSON.parse(readFileSync(path.join(here, "..", "..", "web", "package.json"), "utf8")).version;
// The newest database migration this worker is built for: it waits for it before taking jobs (schema-ready.ts).
const journal = JSON.parse(readFileSync(path.join(here, "..", "..", "web", "drizzle", "meta", "_journal.json"), "utf8"));
const schemaWhen = Math.max(...journal.entries.map((entry) => entry.when));

await build({
  entryPoints: [path.join(here, "..", "src", "index.ts")],
  outfile: path.join(here, "..", "dist", "index.js"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // Astro (8a) too: it loads its own compiler and Vite at runtime.
  // ssh2's optional native speed-ups (Build B, 4a) are left out: ssh2 loads
  // them inside a try and runs in plain JavaScript without them.
  external: ["node:*", "playwright-core", "astro", "cpu-features", "*.node"],
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
      // CommonJS code in the bundle (ssh2's agent, when it loads) reads __dirname.
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __pathDirname(__filename);",
    ].join("\n"),
  },
  define: { __TAWD_VERSION__: JSON.stringify(appVersion), __TAWD_SCHEMA_WHEN__: JSON.stringify(schemaWhen) },
  logLevel: "warning",
});

console.log(`Built dist/index.js (version ${appVersion}, database ${schemaWhen})`);

/*
  pdf.js, for reading an uploaded design (28 September 2026): unpdf's
  single-file build runs inside the worker's Chromium, so it sits next to
  the bundle as a plain file rather than inside it.
*/
copyFileSync(fileURLToPath(import.meta.resolve("unpdf/pdfjs")), path.join(here, "..", "dist", "pdfjs.mjs"));
