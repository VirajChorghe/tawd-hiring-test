import { cp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

/*
  Bundles the two operational scripts into standalone JavaScript files.

  Next's standalone output only contains files the web app itself imports, so
  these scripts cannot rely on finding their dependencies at runtime inside
  the production image. Bundling removes the question entirely: each script
  becomes one file that needs nothing but Node.
*/

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, "..");

await build({
  entryPoints: [
    path.join(here, "migrate.ts"),
    path.join(here, "create-admin.ts"),
  ],
  outdir: path.join(appRoot, "dist-scripts"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // Node's own modules, and the one native-ish dependency, stay external.
  // Everything else is inlined.
  external: ["node:*"],
  banner: {
    // Some bundled dependencies still expect CommonJS globals to exist.
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "warning",
});

/*
  The migration SQL travels with the bundled scripts, so the production image
  copies one directory and migrate.js finds its migrations beside itself.
*/
const outDir = path.join(appRoot, "dist-scripts");

/*
  The app's package.json has no "type", so Node would treat these .js files as
  CommonJS, notice the ESM syntax and warn on every run. A module marker beside
  them settles it.
*/
await writeFile(
  path.join(outDir, "package.json"),
  `${JSON.stringify({ type: "module", private: true }, null, 2)}
`,
);

const migrationsOut = path.join(outDir, "drizzle");
await rm(migrationsOut, { recursive: true, force: true });
await cp(path.join(appRoot, "drizzle"), migrationsOut, { recursive: true });

console.log("Built dist-scripts: migrate.js, create-admin.js and drizzle/");
