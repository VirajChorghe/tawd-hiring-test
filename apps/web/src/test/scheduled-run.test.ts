import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claimScheduledRun } from "@tawd/core/scheduled-run";
import { createHarness, type Harness } from "./harness";

/*
  D5 (audit F-042): the web app's timers ran on their own clocks in every
  process: a deploy reset them, and a second web server would have run each
  one twice. A tick now does its work only after claiming its run.
*/

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

describe("a scheduled run", () => {
  it("is claimed by one tick only, however many ask at once", async () => {
    const now = new Date("2026-11-12T12:00:00Z");
    const claims = await Promise.all(Array.from({ length: 5 }, () => claimScheduledRun(h.db as never, "form-purge", 60 * 60_000, now)));
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("is due again only after its interval, and keeps its time across a restart", async () => {
    const start = new Date("2026-11-12T12:00:00Z");
    expect(await claimScheduledRun(h.db as never, "connect-checks", 15 * 60_000, start)).toBe(true);
    // A restart five minutes later starts a new timer: the stored time says it isn't due.
    expect(await claimScheduledRun(h.db as never, "connect-checks", 15 * 60_000, new Date(start.getTime() + 5 * 60_000))).toBe(false);
    expect(await claimScheduledRun(h.db as never, "connect-checks", 15 * 60_000, new Date(start.getTime() + 15 * 60_000))).toBe(true);
    // Each name keeps its own time.
    expect(await claimScheduledRun(h.db as never, "delivery-checks", 60 * 60_000, start)).toBe(true);
  });
});
