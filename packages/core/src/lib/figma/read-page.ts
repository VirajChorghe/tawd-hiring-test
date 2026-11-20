import { projectStoragePrefix } from "../intake/storage";

/*
  One page built from a finished read (E5a, Lane 2, 15 November 2026; spec
  15 section 6 stage 4).

  The page is written under the read it was built from, beside that read's
  pictures, so a second read of the same upload never mixes with it and
  the page can always be traced back to the read and the corrections it
  came from. Its status lives in the same folder for the same reason the
  pictures' does: the read itself is finished and must stay finished while
  a page is built from it.
*/

export function readPageKeys(projectId: string, version: string, page: number, runId: string) {
  const prefix = `${projectStoragePrefix(projectId)}design-upload/${version}/read-v2/page/${runId}/page-${page}/`;
  return { prefix, html: `${prefix}index.html`, status: `${prefix}building.json` };
}

export interface PageBuildStatus {
  state: "queued" | "working" | "done" | "failed";
  /** The attempt this status belongs to (DesignPageJobData.attempt). */
  attempt: string;
  runId: string;
  /** What the build was told it would cost, shown on the screen. E5b's rounds stop at twice it; one call has nothing yet to count against. */
  estimate: number;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /*
    Two different things, kept apart on purpose.

    `flags` are the "Could not copy" items the plan already knew about
    before the build ran: a picture that could not be cut, an icon that
    matched nothing, a menu item with no page. They are expected, they ask
    for an upload or a page, and they do not mean the build went wrong
    (Jason, 12 November, answer 2).

    `problems` are what code found wrong with what the build sent back: a
    blank band, a dropped menu item, a re-formatted phone number. Empty is
    not "the page is right", only "worth looking at": the real measurement
    is in a browser, and that is E5b.
  */
  flags: string[];
  problems: string[];
  error: string | null;
}

/*
  A build with no news for this long counts as stopped and may be started
  again.

  It must be LONGER than the worker's own lock on the job (20 minutes),
  never shorter. The status is written once when the build begins and once
  when it ends, so a single slow call -- a long page, or the SDK retrying --
  looks silent for the whole time it is running. At 15 minutes the panel
  would tell a person a live build had stopped, they would press again, and
  the same page would be paid for twice.
*/
export const PAGE_BUILD_STALE_MS = 25 * 60 * 1000;

export function pageBuildStalled(status: PageBuildStatus | null, now = Date.now()): boolean {
  if (!status || (status.state !== "queued" && status.state !== "working")) return false;
  return now - new Date(status.updatedAt).getTime() > PAGE_BUILD_STALE_MS;
}
