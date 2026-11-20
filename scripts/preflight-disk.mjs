/*
  Disk space for pnpm preflight (14 November 2026). Docker Desktop kept its data on C: and every
  preflight left its images and build cache behind (GitHub throws its machine away after each run;
  a laptop doesn't). By 14 November it was 67 GB, C: had 30 MB free, and a check died halfway.

  Before the long steps preflight now asks every drive it will write to for room, and stops with a
  plain message instead of filling one. After the image builds it removes what it built and trims
  the build cache (see the clean-up in preflight.mjs). Docker Desktop's data is one disk file that
  does not shrink on Windows by itself, so clean-up limits how far it grows but does not give room
  back to the drive.
*/
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Docker's drive needs the most: two image builds plus their cache. The repo and the temp folder take test files.
export const DOCKER_MIN_FREE_GB = 20;
export const OTHER_MIN_FREE_GB = 5;

/**
 * Where Docker Desktop keeps its data on Windows: the "Disk image location" setting, else its default. Null elsewhere (not asked).
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [platform]
 * @param {(file: string, encoding: "utf8") => string} [readFile]
 * @returns {string | null}
 */
export function dockerDataDir(env = process.env, platform = process.platform, readFile = fs.readFileSync) {
  if (platform !== "win32") return null;
  try {
    const raw = readFile(path.win32.join(env.APPDATA ?? "", "Docker", "settings-store.json"), "utf8").replace(/^\uFEFF/, "");
    const custom = JSON.parse(raw).CustomWslDistroDir;
    if (typeof custom === "string" && custom.trim()) return custom.trim();
  } catch {
    // No settings file yet, or unreadable: Docker uses its default.
  }
  return env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, "Docker") : null;
}

/*
  The drives that are short of room. `places` are { what, dir, needGb }; places on one drive are
  judged together against the largest need among them (they share the space), and each keeps its
  own need in `places` so the message can name it. `freeGb(dir)` answers in GB, or null when the
  folder can't be asked (it is then left out, never guessed).
*/
export function shortDrives(places, freeGb) {
  const drives = new Map();
  for (const place of places) {
    if (!place.dir) continue;
    // A Windows path is read as one wherever this runs (the tests also run on Linux). "E:/x" and
    // "E:\x" must give the same root, or one drive would be judged twice.
    const root = /^[a-z]:[\\/]/i.test(place.dir) ? `${place.dir[0].toUpperCase()}:\\` : path.parse(path.resolve(place.dir)).root;
    const drive = drives.get(root) ?? { root, needGb: 0, whats: [], places: [], dir: place.dir };
    drive.needGb = Math.max(drive.needGb, place.needGb);
    drive.whats.push(place.what);
    drive.places.push({ what: place.what, needGb: place.needGb });
    drives.set(root, drive);
  }
  const short = [];
  for (const drive of drives.values()) {
    const free = freeGb(drive.dir);
    if (free !== null && free < drive.needGb) short.push({ ...drive, freeGb: free });
  }
  return short;
}

/* Free space where `dir` is, asking its nearest folder that exists (Docker's may not be made yet). */
export function freeGbOf(dir) {
  let at = path.resolve(dir);
  for (;;) {
    try {
      const stats = fs.statfsSync(at);
      return (stats.bavail * stats.bsize) / 1e9;
    } catch {
      const up = path.dirname(at);
      if (up === at) return null;
      at = up;
    }
  }
}

/**
 * Every place the checks write to. Docker's data is included only when Docker will be used.
 * @param {{ withDocker?: boolean, cwd?: string, env?: Record<string, string | undefined>, platform?: string, tmpdir?: string }} [options]
 */
export function preflightPlaces({ withDocker, cwd = process.cwd(), env = process.env, platform = process.platform, tmpdir = os.tmpdir() } = {}) {
  return [
    ...(withDocker ? [{ what: "Docker's data", dir: dockerDataDir(env, platform), needGb: DOCKER_MIN_FREE_GB }] : []),
    { what: "the repo", dir: cwd, needGb: OTHER_MIN_FREE_GB },
    { what: "the temp folder", dir: tmpdir, needGb: OTHER_MIN_FREE_GB },
  ];
}
