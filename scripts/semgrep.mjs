#!/usr/bin/env node
/*
  pnpm security: Semgrep over TAWD's own code, with Semgrep's free rule
  packs, no account and no telemetry. Fails on any finding, so a new one
  is fixed or, if it is a false alarm, marked in the code with
  "// nosemgrep: <rule> -- <why>" next to the line.

  Semgrep isn't an npm package: it is installed once, outside the repo
  (see docs/security/semgrep.md). Set SEMGREP_BIN to its path, or have
  "semgrep" on the PATH. Where Windows refuses to start Semgrep's own
  launcher, set SEMGREP_PYTHON instead (see below).

  One rule is left out on purpose: njsscan's regex_dos flags every regular
  expression run on a variable, fixed patterns included. All 15 it raised
  on 26 September 2026 were reviewed: fixed patterns with no nested
  repetition, bar one built from page content, now escaped.
*/
import { spawnSync } from "node:child_process";

const PINNED = "1.178.0";
const RULE_PACKS = ["p/javascript", "p/typescript", "p/react", "p/nextjs", "p/nodejsscan", "p/secrets"];
const LEFT_OUT = ["ajinabraham.njsscan.dos.regex_dos.regex_dos"];

/*
  How Semgrep is started. Normally that is its own launcher: SEMGREP_BIN, or
  "semgrep" on the PATH. On Windows with Smart App Control on, that launcher
  and the pysemgrep.exe it spawns are unsigned files written by pip, and
  Windows refuses to start either of them ("An Application Control policy has
  blocked this file") — which left this whole check unrunnable on Jason's
  laptop, and a check nobody can run is a check that is not running.
  SEMGREP_PYTHON points at the Python interpreter of the environment Semgrep
  is installed in, and the same command-line program is called through it.
  python.exe is signed, so it starts, and the scan is byte for byte the one
  the launcher would have run.
*/
/*
  THE DOCKER ROUTE, and why it exists (11 November 2026).

  Starting Semgrep through Python got past the blocked launcher, and then
  Windows blocked the next file down: Smart App Control refused the
  libtree-sitter.dll that semgrep-core.exe loads, so semgrep-core died at
  rule validation with 0xc0e90002 and the security leg could not pass on
  this machine at all. The Code Integrity log names the file:

    Code Integrity determined that a process (...semgrep-core.exe)
    attempted to load ...\libtree-sitter.dll that did not meet the
    Enterprise signing level requirements.

  That is the third unsigned binary SAC has stopped, after semgrep.exe and
  Astro's compiler DLL, and the answer is the same one each time: find the
  signed or portable path, never weaken the machine. Semgrep's own pinned
  image is that path - it is the same version, and it is what the GitHub
  check used to run. SEMGREP_DOCKER=1 uses semgrep/semgrep:<pinned>;
  SEMGREP_IMAGE names another image.

  The repo is mounted read-only, so a scan can never change the code it is
  scanning.
*/
const dockerImage = process.env.SEMGREP_IMAGE || (process.env.SEMGREP_DOCKER ? `semgrep/semgrep:${PINNED}` : null);
const MOUNT = "/src";
const pythonBin = dockerImage ? null : process.env.SEMGREP_PYTHON;
const PYTHON_ENTRY = "from semgrep.console_scripts.pysemgrep import main; main()";
const bin = dockerImage ? "docker" : pythonBin || process.env.SEMGREP_BIN || "semgrep";
/* Everything before Semgrep's own arguments: the docker run, or python -c, or nothing. */
const start = dockerImage
  ? [
      "run",
      "--rm",
      "-v",
      `${process.cwd().replace(/\\/g, "/")}:${MOUNT}:ro`,
      "-w",
      MOUNT,
      /*
        The mounted repo belongs to another user inside the container, so
        git calls it "dubious ownership" and Semgrep loses the list of
        tracked files. Said through the environment rather than by writing
        a git config, because the mount is read-only and nothing in the
        repo should be changed by a scan.
      */
      "-e",
      "GIT_CONFIG_COUNT=1",
      "-e",
      "GIT_CONFIG_KEY_0=safe.directory",
      "-e",
      `GIT_CONFIG_VALUE_0=${MOUNT}`,
      dockerImage,
      "semgrep",
    ]
  : pythonBin
    ? ["-c", PYTHON_ENTRY]
    : [];
const env = { ...process.env, PYTHONUTF8: "1", SEMGREP_SEND_METRICS: "off" };

const version = spawnSync(bin, [...start, "--version"], { encoding: "utf8", env });
if (version.error || version.status !== 0) {
  const how = dockerImage ? `the image ${dockerImage}` : pythonBin ? `SEMGREP_PYTHON=${pythonBin}` : bin;
  console.error(`Semgrep didn't answer where this looks (${how}). See docs/security/semgrep.md.`);
  if (dockerImage) {
    console.error("Is Docker Desktop running? It does not start itself, and the image is pulled on first use.");
  } else if (version.stderr?.includes("Application Control")) {
    console.error("Windows blocked Semgrep's own launcher. Set SEMGREP_PYTHON instead — see docs/security/semgrep.md.");
  }
  process.exit(2);
}
// Semgrep may print an upgrade notice as well, so take the line that is a version.
const installed = version.stdout.split(/\r?\n/).map((line) => line.trim()).findLast((line) => /^\d+\.\d+\.\d+$/.test(line));
if (installed !== PINNED) {
  console.warn(`Semgrep ${installed ?? version.stdout.trim()} is installed; TAWD's checks were set up with ${PINNED}.`);
}

/*
  The Drizzle schema (1,400+ lines of table/column definitions, no eval, network, filesystem
  or user input) makes three njsscan rules time out at 60s each, every run, finding nothing.
  Semgrep can't skip a rule on just one file from the CLI, so the file is scanned on its own with
  those three rules left out — it still gets p/secrets and every other rule (CodeRabbit, PR #43:
  a whole-file exclude would also drop secret scanning on it). The main scan excludes the file.
*/
const SCHEMA_FILE = "packages/core/src/db/schema/tawd.ts";
const SLOW_ON_SCHEMA = [
  "ajinabraham.njsscan.eval.eval_vm_injection.vm_code_injection",
  "ajinabraham.njsscan.ssrf.ssrf_node.node_ssrf",
  "ajinabraham.njsscan.traversal.resolve_path_traversal.join_resolve_path_traversal",
];

function scan(target, excludeRules, excludePaths) {
  const args = [
    ...start,
    "scan",
    "--metrics=off",
    "--error",
    "--timeout=60",
    ...RULE_PACKS.flatMap((pack) => ["--config", pack]),
    ...excludeRules.flatMap((rule) => ["--exclude-rule", rule]),
    ...excludePaths.flatMap((path) => ["--exclude", path]),
    target,
  ];
  return spawnSync(bin, args, { stdio: "inherit", env }).status ?? 1;
}

// Everything except the schema file, then the schema file alone without the three rules that
// time out on it. Both must pass; the exit code is non-zero if either found something.
const mainScan = scan(".", LEFT_OUT, [SCHEMA_FILE]);
const schemaScan = scan(SCHEMA_FILE, [...LEFT_OUT, ...SLOW_ON_SCHEMA], []);
process.exit(mainScan || schemaScan);
