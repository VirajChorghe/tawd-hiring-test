import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { build } from "esbuild";

/* HIRING TEST: bundles src/hiring-test/repro-bug1.ts (the worker's code is TypeScript) and runs it. */
const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, "..", "dist-repro", "repro-bug1.mjs");

await build({
  entryPoints: [path.join(here, "..", "src", "hiring-test", "repro-bug1.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  external: ["node:*", "playwright-core", "astro", "cpu-features", "*.node"],
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __pathDirname(__filename);",
    ].join("\n"),
  },
  define: { __TAWD_VERSION__: '"hiring-test"', __TAWD_SCHEMA_WHEN__: "0" },
  logLevel: "warning",
});

const run = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(run.status ?? 1);
