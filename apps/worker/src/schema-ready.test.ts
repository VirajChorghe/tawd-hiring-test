import { describe, expect, it } from "vitest";

import { waitForSchema } from "./schema-ready";

/* A fake clock: sleeping moves time on, nothing really waits. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe("the worker waits for the database it was built for", () => {
  it("starts at once when the database already has the migration, or a newer one", async () => {
    for (const latest of [100, 200]) {
      const c = clock();
      const logs: string[] = [];
      await waitForSchema({ expected: 100, readLatest: async () => latest, ...c, log: (m) => logs.push(m) });
      expect(c.now()).toBe(0);
      expect(logs).toEqual([]);
    }
  });

  it("doesn't wait when running from source (nothing expected)", async () => {
    let reads = 0;
    await waitForSchema({ expected: null, readLatest: async () => (reads++, null) });
    expect(reads).toBe(0);
  });

  it("waits while the database is older, then goes once the web app has migrated", async () => {
    const c = clock();
    const answers = [90, 90, null, 90, 100];
    const logs: string[] = [];
    await waitForSchema({ expected: 100, readLatest: async () => (answers.length ? (answers.shift() as number | null) : 100), ...c, log: (m) => logs.push(m), pollMs: 5_000 });
    expect(answers).toEqual([]);
    expect(c.now()).toBe(20_000);
    expect(logs[0]).toMatch(/Waiting for the database update/);
    expect(logs.at(-1)).toBe("The database is up to date. Taking jobs now.");
  });

  it("tells the team once, after 15 minutes, and keeps waiting", async () => {
    const c = clock();
    const alerts: string[] = [];
    let reads = 0;
    await waitForSchema({
      expected: 100,
      readLatest: async () => (++reads > 400 ? 100 : 90),
      ...c,
      log: () => {},
      alert: async (m) => void alerts.push(m),
      pollMs: 5_000,
    });
    expect(c.now()).toBeGreaterThan(15 * 60_000);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/waited 15 minutes/);
  });

  it("logs about once a minute, not on every check", async () => {
    const c = clock();
    const logs: string[] = [];
    let reads = 0;
    await waitForSchema({ expected: 100, readLatest: async () => (++reads > 60 ? 100 : 90), ...c, log: (m) => logs.push(m), pollMs: 5_000 });
    // 60 checks 5 s apart is 5 minutes: 5 waiting lines and the "up to date" line.
    expect(logs.filter((m) => m.startsWith("Waiting"))).toHaveLength(5);
  });
});
