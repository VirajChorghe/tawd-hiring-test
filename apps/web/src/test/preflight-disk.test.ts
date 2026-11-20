import { describe, expect, it } from "vitest";

/*
  14 November 2026: Docker Desktop kept its data on C: and every local preflight left its images
  behind, until C: had 30 MB free and a check died halfway. Preflight now asks each drive it writes
  to for room before the long steps.
*/
import os from "node:os";
import path from "node:path";

import { DOCKER_MIN_FREE_GB, OTHER_MIN_FREE_GB, dockerDataDir, freeGbOf, preflightPlaces, shortDrives } from "../../../../scripts/preflight-disk.mjs";

const free = (gbByRoot: Record<string, number | null>) => (dir: string) => gbByRoot[`${dir[0].toUpperCase()}:\\`] ?? null;

describe("preflight's disk check", () => {
  it("stops when Docker's drive has less than its room, naming the drive and what needs it", () => {
    const short = shortDrives([{ what: "Docker's data", dir: "C:\\Users\\jason\\AppData\\Local\\Docker", needGb: DOCKER_MIN_FREE_GB }], free({ "C:\\": 0.03 }));
    expect(short).toHaveLength(1);
    expect(short[0]).toMatchObject({ root: "C:\\", needGb: DOCKER_MIN_FREE_GB, whats: ["Docker's data"], freeGb: 0.03 });
  });

  it("lets a run start when every drive has room", () => {
    const places = [
      { what: "Docker's data", dir: "E:\\DockerData", needGb: DOCKER_MIN_FREE_GB },
      { what: "the repo", dir: "E:\\tawd", needGb: OTHER_MIN_FREE_GB },
      { what: "the temp folder", dir: "C:\\Users\\jason\\AppData\\Local\\Temp", needGb: OTHER_MIN_FREE_GB },
    ];
    expect(shortDrives(places, free({ "E:\\": 200, "C:\\": 67 }))).toEqual([]);
  });

  it("judges places on one drive together, by the largest need among them", () => {
    const places = [
      { what: "the repo", dir: "E:\\tawd", needGb: OTHER_MIN_FREE_GB },
      { what: "Docker's data", dir: "E:\\DockerData", needGb: DOCKER_MIN_FREE_GB },
    ];
    const short = shortDrives(places, free({ "E:\\": 10 }));
    expect(short).toHaveLength(1);
    expect(short[0]).toMatchObject({ root: "E:\\", needGb: DOCKER_MIN_FREE_GB, whats: ["the repo", "Docker's data"] });
  });

  it("keeps each place's own need on a short drive, for the message", () => {
    const places = [
      { what: "the repo", dir: "E:\\tawd", needGb: OTHER_MIN_FREE_GB },
      { what: "Docker's data", dir: "E:\\DockerData", needGb: DOCKER_MIN_FREE_GB },
    ];
    const short = shortDrives(places, free({ "E:\\": 3.2 }));
    expect(short[0].places).toEqual([
      { what: "the repo", needGb: OTHER_MIN_FREE_GB },
      { what: "Docker's data", needGb: DOCKER_MIN_FREE_GB },
    ]);
  });

  it("reads E:/x and E:\\x as the same drive, so it is judged once", () => {
    const places = [
      { what: "the repo", dir: "E:/tawd", needGb: OTHER_MIN_FREE_GB },
      { what: "the temp folder", dir: "e:\\Temp", needGb: OTHER_MIN_FREE_GB },
    ];
    const short = shortDrives(places, free({ "E:\\": 1 }));
    expect(short).toHaveLength(1);
    expect(short[0]).toMatchObject({ root: "E:\\", whats: ["the repo", "the temp folder"] });
  });

  it("leaves out a drive it can't ask, rather than guessing", () => {
    expect(shortDrives([{ what: "the repo", dir: "Z:\\nowhere", needGb: OTHER_MIN_FREE_GB }], free({}))).toEqual([]);
  });
});

describe("which places preflight checks", () => {
  const env = { APPDATA: "C:\\Users\\jason\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\jason\\AppData\\Local" };
  const where = (withDocker: boolean) => preflightPlaces({ withDocker, cwd: "E:\\tawd", env, platform: "win32", tmpdir: "C:\\Temp" }).map((p: { what: string }) => p.what);

  it("includes Docker's data only when Docker will be used", () => {
    expect(where(true)).toContain("Docker's data");
    expect(where(false)).toEqual(["the repo", "the temp folder"]);
  });
});

describe("free space of a folder", () => {
  it("asks the nearest folder that exists when the one given is not made yet", () => {
    const missing = path.join(os.tmpdir(), `tawd-not-made-${Date.now()}`, "deeper");
    expect(typeof freeGbOf(missing)).toBe("number");
  });
});

describe("where Docker keeps its data", () => {
  const env = { APPDATA: "C:\\Users\\jason\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\jason\\AppData\\Local" };

  it("reads Docker Desktop's disk image location, also from a file that starts with a byte-order mark", () => {
    let asked = "";
    const read = (file: string) => {
      asked = file;
      return '\uFEFF{"CustomWslDistroDir": "E:\\\\DockerData"}';
    };
    expect(dockerDataDir(env, "win32", read)).toBe("E:\\DockerData");
    expect(asked.endsWith("Docker\\settings-store.json")).toBe(true);
  });

  it("falls back to Docker's default folder when the setting is empty or the file can't be read", () => {
    expect(dockerDataDir(env, "win32", () => '{"CustomWslDistroDir": ""}')).toBe("C:\\Users\\jason\\AppData\\Local\\Docker");
    expect(
      dockerDataDir(env, "win32", () => {
        throw new Error("ENOENT");
      }),
    ).toBe("C:\\Users\\jason\\AppData\\Local\\Docker");
  });

  it("is not asked off Windows", () => {
    expect(dockerDataDir(env, "linux", () => "{}")).toBeNull();
  });
});
