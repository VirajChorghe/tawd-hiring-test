import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import { runAstroBuild } from "../../../worker/src/site-build";

/*
  Astro writes only inside the build's own folder (29 September 2026): it
  used to put prerendered pages in <cwd>/.astro whenever the build folder
  was outside the working folder, which on the server is /app/.astro, not
  the worker's to write. The tests run from apps/web, so apps/web/.astro
  must not appear.
*/
it("builds a site without writing anything into the working folder", async () => {
  const stray = path.join(process.cwd(), ".astro");
  await fs.rm(stray, { recursive: true, force: true });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tawd-astro-check-"));
  try {
    await fs.mkdir(path.join(root, "src", "pages", "about"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "pages", "index.astro"), "<h1>Home</h1>");
    await fs.writeFile(path.join(root, "src", "pages", "about", "index.astro"), "<h1>About</h1>");
    const cwdBefore = process.cwd();
    const dist = await runAstroBuild(root);
    expect(process.cwd()).toBe(cwdBefore);
    expect(await fs.readFile(path.join(dist, "index.html"), "utf8")).toContain("<h1>Home</h1>");
    expect(await fs.readFile(path.join(dist, "about", "index.html"), "utf8")).toContain("<h1>About</h1>");
    await expect(fs.stat(stray)).rejects.toThrow();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 120_000);
