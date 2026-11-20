import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/*
  The worker's Docker image builds the bundle itself (Dockerfile.worker runs
  scripts/build.mjs), and only the files the Dockerfile copies exist there.
  On 3 November 2026 build.mjs started reading the web app's migration journal
  and the Dockerfile didn't copy it: every check passed, and the worker's deploy
  failed on the server. Since 4 November GitHub's checks also build both images
  (image-web, image-worker); this test stays because it fails in seconds and
  names the missing file: every file build.mjs reads from outside apps/worker
  must be copied.
*/

const workerDir = path.join(import.meta.dirname, "..");
const repoRoot = path.join(workerDir, "..", "..");

function filesTheBuildReads(): string[] {
  const script = readFileSync(path.join(workerDir, "scripts", "build.mjs"), "utf8");
  const reads = [...script.matchAll(/readFileSync\(path\.join\(here,((?:\s*"[^"]*",?)+)\)/g)];
  return reads.map((m) => {
    const parts = [...m[1]!.matchAll(/"([^"]*)"/g)].map((p) => p[1]!);
    const file = path.join(workerDir, "scripts", ...parts);
    return path.relative(repoRoot, file).split(path.sep).join("/");
  });
}

function copiedSources(): string[] {
  const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile.worker"), "utf8");
  return [...dockerfile.matchAll(/^COPY (?!--from)(?:--\S+ )*(.+)$/gm)].flatMap((m) => {
    const words = m[1]!.trim().split(/\s+/);
    return words.slice(0, -1).map((w) => w.replace(/\/$/, ""));
  });
}

describe("the worker image has every file its build reads", () => {
  it("finds the files build.mjs reads (the web app's version and migration journal)", () => {
    expect(filesTheBuildReads()).toEqual(expect.arrayContaining(["apps/web/package.json", "apps/web/drizzle/meta/_journal.json"]));
  });

  it("copies each of them into the image before the build runs", () => {
    const sources = copiedSources();
    const missing = filesTheBuildReads().filter(
      (file) => !file.startsWith("apps/worker/") && !sources.some((src) => file === src || file.startsWith(`${src}/`)),
    );
    expect(missing).toEqual([]);
  });
});
