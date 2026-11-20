/*
  The Build page's parts (Jason, 29 September 2026; built 30 September):
  Build, Check, Preview & client approval, and Go live, each at its own
  address (`?part=`). With no part in the address the page opens where
  the work is. Lane 2 builds and previews on Design, so its Build page is
  the Go live part alone.
*/

export type BuildPart = "build" | "check" | "preview" | "golive";

export const BUILD_PARTS: { key: BuildPart; label: string }[] = [
  { key: "build", label: "Build" },
  { key: "check", label: "Check" },
  { key: "preview", label: "Preview & client approval" },
  { key: "golive", label: "Go live" },
];

export interface BuildFacts {
  lane: string;
  /** A build finished (the last good one counts). */
  hasBuild: boolean;
  /** A build is queued or running. */
  building: boolean;
  /** The SEO team signed off the latest version. */
  signedOff: boolean;
  /** The client approved the latest preview. */
  previewApproved: boolean;
  live: boolean;
  /** Staged builds (6 October 2026): every planned page is built (absent: yes). */
  allBuilt?: boolean;
}

export function currentBuildPart(f: BuildFacts): BuildPart {
  if (f.lane === "lane_2" || f.live || f.previewApproved) return "golive";
  if (!f.hasBuild || f.building || f.allBuilt === false) return "build";
  if (!f.signedOff) return "check";
  return "preview";
}

export function isBuildPart(value: unknown): value is BuildPart {
  return typeof value === "string" && BUILD_PARTS.some((p) => p.key === value);
}

/* Which part to show: the one asked for, or the current one. Lane 2 only has Go live. */
export function shownBuildPart(asked: unknown, f: BuildFacts): BuildPart {
  if (f.lane === "lane_2") return "golive";
  return isBuildPart(asked) ? asked : currentBuildPart(f);
}

/* Each part's word: Done, Now or Later. */
export function buildPartStates(f: BuildFacts): { key: BuildPart; label: string; state: "Done" | "Now" | "Later" }[] {
  const now = currentBuildPart(f);
  const done: Record<BuildPart, boolean> = {
    build: f.hasBuild && !f.building && f.allBuilt !== false,
    check: f.signedOff,
    preview: f.previewApproved,
    golive: f.live,
  };
  return BUILD_PARTS.map((p) => ({ ...p, state: done[p.key] ? "Done" : p.key === now ? "Now" : "Later" }));
}

export function buildPartHref(projectId: string, part: BuildPart, anchor?: string): string {
  return `/projects/${projectId}/build?part=${part}${anchor ? `#${anchor}` : ""}`;
}
