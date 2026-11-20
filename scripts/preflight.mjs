#!/usr/bin/env node
/*
  pnpm preflight: the whole set of checks GitHub's "Tests" workflow used to run, now run locally
  before every push (Jason, 7 November 2026: CI moved local to stop spending Actions minutes; the
  T16 has Docker + 32 GB). It is the complete match for the CI checks:

    install (frozen lockfile) · typecheck · lint · test · security (Semgrep) · docker build web · docker build worker

  The two Docker builds are the one thing CI caught that the test suite didn't (0.121.0 built in CI
  but failed in Coolify), built here with --platform linux/amd64 to match the ubuntu runner exactly.
  Note: the local test run executes the real-Chrome browser tests CI skipped, so it is a superset.

  Every step runs even if an earlier one fails, so the summary is complete; the script exits non-zero
  if any step failed. Paste the printed "Preflight" block into the PR. `--skip-docker` leaves the two
  image builds out (for when Docker isn't running yet); the summary says so.

  Since 14 November 2026 it first checks every drive it writes to has room (preflight-disk.mjs: 20 GB
  where Docker keeps its data, 5 GB for the repo and the temp folder) and stops with a plain message
  if not, and after the image builds it removes the images it built, untagged leftovers, and trims
  the build cache towards 8 GB (it can stay a little above, and keeps the most recently used cache).
  Docker filled C: on 14 November because nothing ever cleared them. Clean-up limits how far Docker's
  disk file grows; the file does not shrink on Windows by itself.
*/
import { spawnSync } from "node:child_process";

import { freeGbOf, preflightPlaces, shortDrives } from "./preflight-disk.mjs";

const skipDocker = process.argv.includes("--skip-docker");

// Room on every drive the checks write to, before anything long starts (14 November 2026: Docker filled C: mid-check).
// Semgrep in Docker also writes to Docker's drive, even with --skip-docker.
const withDocker = !skipDocker || Boolean(process.env.SEMGREP_DOCKER || process.env.SEMGREP_IMAGE);
const short = shortDrives(preflightPlaces({ withDocker }), freeGbOf);
if (short.length) {
  console.error("\nPreflight stopped: not enough free room.");
  for (const d of short) {
    const free = d.freeGb < 1 ? d.freeGb.toFixed(2) : d.freeGb.toFixed(1);
    console.error(`${d.root} has ${free} GB free; ${d.places.map((p) => `${p.what} needs ${p.needGb} GB there`).join(", ")}.`);
    // Pruning frees room inside Docker's disk file, but the file itself does not shrink on Windows.
    if (d.whats.includes("Docker's data")) {
      console.error(`  Free up space on ${d.root}, or in Docker Desktop use Troubleshoot > "Clean / Purge data" (deletes ALL of Docker's images, containers, volumes and cache on this machine, not only TAWD's; TAWD keeps nothing there and rebuilds what it needs).`);
    } else {
      console.error(`  Free up space on ${d.root}.`);
    }
  }
  console.error("Then run preflight again.");
  process.exit(1);
}

// Enforce the exact Semgrep version CI ran (the security wrapper only WARNS on a mismatch); otherwise
// preflight could report a green scan run on a different version as the "Semgrep 1.178.0" CI equivalent
// (CodeRabbit, PR #47). Fail fast before the long steps.
const SEMGREP_PIN = "1.178.0"; // keep in step with .github/workflows/tests.yml (pip install semgrep==...)
/*
  How the gate asks Semgrep its version — the same three routes the scan
  itself uses (scripts/semgrep.mjs), so the gate and the scan can never read
  different installations:

  - SEMGREP_DOCKER / SEMGREP_IMAGE: Semgrep's own pinned image, for a machine
    whose Application Control policy blocks the DLL semgrep-core loads;
  - SEMGREP_PYTHON: through a signed Python, where only the launcher is
    blocked;
  - otherwise SEMGREP_BIN, or "semgrep" on the PATH.

  The image route was missing here on 11 November 2026, so preflight refused
  to start with "found: none on PATH" while `pnpm security` ran perfectly -
  the gate doing its job (it stops rather than skipping the check) on a
  question it was not taught to ask.
*/
const semgrepImage = process.env.SEMGREP_IMAGE || (process.env.SEMGREP_DOCKER ? `semgrep/semgrep:${SEMGREP_PIN}` : null);
const semgrepCmd = semgrepImage
  ? `docker run --rm ${semgrepImage} semgrep`
  : process.env.SEMGREP_PYTHON
    ? `"${process.env.SEMGREP_PYTHON}" -c "from semgrep.console_scripts.pysemgrep import main; main()"`
    : `${process.env.SEMGREP_BIN || "semgrep"}`;
const semVer = spawnSync(`${semgrepCmd} --version`, { encoding: "utf8", shell: true });
// Semgrep may also print an upgrade notice, so take the line that is a version.
const semInstalled = (semVer.stdout || "")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .findLast((line) => /^\d+\.\d+\.\d+$/.test(line));
if (semVer.status !== 0 || semInstalled !== SEMGREP_PIN) {
  console.error(`\nPreflight needs Semgrep ${SEMGREP_PIN} (the version CI ran); found: ${semVer.status !== 0 ? "none on PATH" : semInstalled || "unknown"}.`);
  console.error(`Install it:  pip install semgrep==${SEMGREP_PIN}`);
  console.error(`Blocked by Windows? See docs/security/semgrep.md: set SEMGREP_PYTHON, or SEMGREP_DOCKER=1 to run it in Semgrep's own pinned image.`);
  process.exit(1);
}

const steps = [
  { name: "install", cmd: "pnpm install --frozen-lockfile", ci: "test job" },
  { name: "typecheck", cmd: "pnpm typecheck", ci: "test job" },
  { name: "lint", cmd: "pnpm lint", ci: "test job" },
  { name: "test", cmd: "pnpm test", ci: "test job (local also runs the Chrome tests CI skipped)" },
  { name: "security", cmd: "pnpm security", ci: "security job (Semgrep 1.178.0)" },
  { name: "docker:web", cmd: 'docker build --platform linux/amd64 --file Dockerfile --tag tawd-web:check .', ci: "image-web job", docker: true },
  { name: "docker:worker", cmd: 'docker build --platform linux/amd64 --file Dockerfile.worker --tag tawd-worker:check .', ci: "image-worker job", docker: true },
];

const results = [];
for (const step of steps) {
  if (step.docker && skipDocker) {
    results.push({ name: step.name, status: "skipped", seconds: 0, ci: step.ci });
    console.log(`\n── ${step.name}: SKIPPED (--skip-docker)\n`);
    continue;
  }
  console.log(`\n── ${step.name}: ${step.cmd}\n`);
  const started = Date.now();
  const run = spawnSync(step.cmd, { stdio: "inherit", shell: true });
  const seconds = Math.round((Date.now() - started) / 1000);
  const ok = run.status === 0 && !run.error;
  results.push({ name: step.name, status: ok ? "pass" : "FAIL", seconds, ci: step.ci });
}

const mark = (s) => (s === "pass" ? "✅" : s === "skipped" ? "➖" : "❌");
const fmt = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)}m${sec % 60}s` : `${sec}s`);
const failed = results.filter((r) => r.status === "FAIL");

console.log("\n========== Preflight summary ==========");
console.log("Preflight (local, replaces GitHub checks):");
for (const r of results) console.log(`  ${mark(r.status)} ${r.name.padEnd(14)} ${r.status.padEnd(8)} ${fmt(r.seconds).padStart(6)}   (${r.ci})`);

// A Markdown block to paste into the PR.
console.log("\n--- paste into the PR ---\n");
console.log("## Preflight (local, replaces the GitHub checks)");
console.log("| Check | Result | Time | CI equivalent |");
console.log("|---|---|---|---|");
for (const r of results) console.log(`| ${r.name} | ${mark(r.status)} ${r.status} | ${fmt(r.seconds)} | ${r.ci} |`);
if (skipDocker) console.log("\n> Docker builds skipped (`--skip-docker`) — NOT a complete run.");
console.log("");

/*
  Clean up what the image builds left (14 November 2026), after the summary so the results
  table is printed even if clean-up is slow (each command stops after 2 minutes; the verdict line
  and exit code still come after it). Each run re-tags tawd-web:check and tawd-worker:check, so
  the previous run's images were left untagged, and the build cache only grew. The images are only
  proof that the build works, so they go; untagged leftovers go; the build cache is trimmed
  towards CACHE_KEEP (it can stay a little above, and keeps the most recently used cache, which
  usually includes the base images, so the next run isn't slow). Never volumes, never other tagged
  images. A failed clean-up warns and does not change the result. If both builds failed, Docker is
  probably not running, so clean-up is skipped (if it was running, leftovers wait for the next run).
*/
const CACHE_KEEP = "8gb";
const dockerSteps = results.filter((r) => r.name.startsWith("docker:") && r.status !== "skipped");
if (skipDocker) {
  // Nothing was built.
} else if (dockerSteps.length && dockerSteps.every((r) => r.status === "FAIL")) {
  console.log("Cleanup skipped: both Docker builds failed, so Docker is probably not running.");
} else {
  console.log(`── cleanup: the check images, untagged leftovers, build cache trimmed towards ${CACHE_KEEP}\n`);
  const run = (cmd, quiet) => spawnSync(cmd, { stdio: quiet ? "ignore" : "inherit", shell: true, timeout: 120000 });
  const cleanup = [
    ...["tawd-web:check", "tawd-worker:check"].flatMap((tag) =>
      // Only remove an image that exists, so a missing one is not a warning.
      run(`docker image inspect ${tag}`, true).status === 0 ? [`docker image rm --force ${tag}`] : [],
    ),
    "docker image prune --force",
    `docker builder prune --force --max-used-space ${CACHE_KEEP}`,
  ];
  for (const cmd of cleanup) {
    const done = run(cmd, false);
    if (done.status !== 0 || done.error) console.warn(`(cleanup step did not finish: ${cmd}; the checks' result is unchanged)`);
  }
}

if (failed.length) {
  console.error(`\nPreflight FAILED: ${failed.map((r) => r.name).join(", ")}.`);
  process.exit(1);
}
if (skipDocker) {
  console.error("\nPreflight passed WITHOUT the Docker builds (--skip-docker): not a complete run; do not rely on it for a real PR.");
  process.exit(2);
}
console.log("\nPreflight passed: all checks green, including both Docker builds.");
