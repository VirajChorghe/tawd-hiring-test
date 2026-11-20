import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activityLog, appSetting } from "@tawd/core/schema";
import {
  ACTIVITY_CHECK_SETTING,
  checkActivityChainFull,
  checkActivityChainSince,
  computeEntryHash,
  recordActivity,
  saveCheckState,
  verifyActivityChain,
  type ActivityCheckState,
} from "@tawd/core/activity";
import { createTestDatabase, type TestHarness } from "./db";

let harness: TestHarness;

/*
  Drizzle wraps a database error as "Failed query: ...", keeping the original
  on `cause`. Walk the chain so the assertion proves PostgreSQL itself
  refused the statement, not merely that something went wrong.
*/
async function expectRejectedAsAppendOnly(promise: Promise<unknown>) {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }

  expect(thrown, "the statement was allowed through").toBeDefined();

  const messages: string[] = [];
  for (let e = thrown; e instanceof Error; e = e.cause) {
    messages.push(e.message);
  }

  expect(messages.join(" | ")).toMatch(/append-only/i);
}

beforeEach(async () => {
  harness = await createTestDatabase();
});

afterEach(async () => {
  await harness.close();
});

describe("activity log: the database refuses to let history change", () => {
  it("rejects UPDATE on an existing entry", async () => {
    await recordActivity(harness.db, {
      action: "login.succeeded",
      entityType: "session",
      actorEmail: "someone@velocitymedialab.com",
    });

    await expectRejectedAsAppendOnly(
      harness.db.execute(sql`update activity_log set action = 'tampered'`),
    );
  });

  it("rejects DELETE of an existing entry", async () => {
    await recordActivity(harness.db, {
      action: "login.succeeded",
      entityType: "session",
      actorEmail: "someone@velocitymedialab.com",
    });

    await expectRejectedAsAppendOnly(
      harness.db.execute(sql`delete from activity_log`),
    );
  });

  it("rejects TRUNCATE of the whole table", async () => {
    await recordActivity(harness.db, {
      action: "login.succeeded",
      entityType: "session",
      actorEmail: "someone@velocitymedialab.com",
    });

    await expectRejectedAsAppendOnly(
      harness.db.execute(sql`truncate activity_log`),
    );
  });

  it("leaves the entry untouched after all three attempts", async () => {
    await recordActivity(harness.db, {
      action: "project.created",
      entityType: "project",
      entityId: "abc",
      valueAfter: { clientName: "Original" },
    });

    for (const statement of [
      sql`update activity_log set value_after = '{"clientName":"Changed"}'::jsonb`,
      sql`delete from activity_log`,
      sql`truncate activity_log`,
    ]) {
      await expect(harness.db.execute(statement)).rejects.toThrow();
    }

    const rows = await harness.db.select().from(activityLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.valueAfter).toEqual({ clientName: "Original" });
  });
});

describe("activity log: the fingerprint chain", () => {
  it("links entries together in order", async () => {
    for (const name of ["First", "Second", "Third"]) {
      await recordActivity(harness.db, {
        action: "project.created",
        entityType: "project",
        valueAfter: { clientName: name },
      });
    }

    const rows = await harness.db
      .select()
      .from(activityLog)
      .orderBy(activityLog.seq);

    expect(rows).toHaveLength(3);
    expect(rows[0]?.prevHash).toBeNull();
    expect(rows[1]?.prevHash).toBe(rows[0]?.hash);
    expect(rows[2]?.prevHash).toBe(rows[1]?.hash);
  });

  it("verifies a genuine chain", async () => {
    for (let i = 0; i < 5; i += 1) {
      await recordActivity(harness.db, {
        action: "login.succeeded",
        entityType: "session",
        actorEmail: `person${i}@velocitymedialab.com`,
      });
    }

    const result = await verifyActivityChain(harness.db);
    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(5);
    expect(result.brokenAtSeq).toBeNull();
  });

  it("verifies an empty log", async () => {
    const result = await verifyActivityChain(harness.db);
    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(0);
  });

  it("detects an entry whose contents do not match its fingerprint", async () => {
    await recordActivity(harness.db, {
      action: "login.succeeded",
      entityType: "session",
      actorEmail: "real@velocitymedialab.com",
    });

    // The trigger blocks UPDATE, so forge the only way still open: append an
    // entry carrying a fingerprint that does not describe its own contents.
    // This is what a tampered row would look like after the fact.
    await harness.db.insert(activityLog).values({
      occurredAt: new Date(),
      action: "user.created",
      entityType: "user",
      actorEmail: "forged@velocitymedialab.com",
      hash: "0000000000000000000000000000000000000000000000000000000000000000",
      prevHash: null,
    });

    const result = await verifyActivityChain(harness.db);
    expect(result.valid).toBe(false);
    expect(result.brokenAtSeq).toBe(2);
  });

  it("hashes the same entry identically regardless of key order", () => {
    const occurredAt = new Date("2026-09-23T12:00:00.000Z");
    const base = {
      occurredAt,
      actorUserId: "u1",
      actorEmail: "a@velocitymedialab.com",
      action: "project.updated",
      entityType: "project",
      entityId: "p1",
      ipAddress: "203.0.113.7",
      userAgent: "test",
    };

    const first = computeEntryHash(
      { ...base, valueBefore: { a: 1, b: 2 }, valueAfter: null },
      null,
    );
    const second = computeEntryHash(
      { ...base, valueBefore: { b: 2, a: 1 }, valueAfter: null },
      null,
    );

    expect(first).toBe(second);
  });
});

describe("checking the log without reading all of it (13 October 2026)", () => {
  const login = (i: number) =>
    recordActivity(harness.db, { action: "login.succeeded", entityType: "session", actorEmail: `person${i}@velocitymedialab.com` });

  it("checks everything the first time, then only what was added since", async () => {
    for (let i = 0; i < 3; i += 1) await login(i);
    const first = await checkActivityChainSince(harness.db);
    expect(first).toMatchObject({ valid: true, entriesChecked: 3 });
    expect(first.full).toMatchObject({ valid: true, entries: 3 });

    await login(3);
    await login(4);
    const second = await checkActivityChainSince(harness.db);
    expect(second).toMatchObject({ valid: true, entriesChecked: 2 });
    // The first check from the start stands as the last full check.
    expect(second.full).toMatchObject({ entries: 3 });

    const daily = await checkActivityChainFull(harness.db);
    expect(daily).toMatchObject({ valid: true, entriesChecked: 5 });
    expect((await checkActivityChainSince(harness.db)).entriesChecked).toBe(0);
  });

  it("finds a forged entry added after the last check, and the daily check keeps saying so", async () => {
    await login(0);
    await checkActivityChainSince(harness.db);
    await harness.db.insert(activityLog).values({
      occurredAt: new Date(),
      action: "user.created",
      entityType: "user",
      actorEmail: "forged@velocitymedialab.com",
      hash: "0".repeat(64),
      prevHash: null,
    });
    expect(await checkActivityChainSince(harness.db)).toMatchObject({ valid: false, brokenAtSeq: 2 });

    expect(await checkActivityChainFull(harness.db)).toMatchObject({ valid: false, brokenAtSeq: 2 });
    await login(1);
    // A break found by the full check stays on the page until a full check passes.
    expect(await checkActivityChainSince(harness.db)).toMatchObject({ valid: false, brokenAtSeq: 2 });
  });

  it("reads a long log in batches, every entry checked", async () => {
    let prevHash: string | null = null;
    const rows = [];
    for (let i = 0; i < 2_105; i += 1) {
      const entry = { occurredAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)), actorUserId: null, actorEmail: `p${i}@velocitymedialab.com`, action: "login.succeeded", entityType: "session", entityId: null, valueBefore: null, valueAfter: null, ipAddress: null, userAgent: null };
      const hash = computeEntryHash(entry, prevHash);
      rows.push({ ...entry, prevHash, hash });
      prevHash = hash;
    }
    await harness.db.insert(activityLog).values(rows);
    expect(await verifyActivityChain(harness.db)).toMatchObject({ valid: true, entriesChecked: 2_105 });
    expect(await checkActivityChainSince(harness.db)).toMatchObject({ valid: true, entriesChecked: 2_105 });
  });
});

describe("two checks at once (CodeRabbit, PR #10)", () => {
  const stored = async () => {
    const [row] = await harness.db.select().from(appSetting).where(eq(appSetting.key, ACTIVITY_CHECK_SETTING));
    return row!.value as ActivityCheckState;
  };
  const broken = { at: "2026-10-14T00:00:00.000Z", entries: 9, valid: false, brokenAtSeq: 4, reason: "entry contents do not match its fingerprint" };

  it("never moves the checkpoint back", async () => {
    await saveCheckState(harness.db, { checkpoint: { seq: 10, hash: "h10", checkedAt: "b" } });
    await saveCheckState(harness.db, { checkpoint: { seq: 6, hash: "h6", checkedAt: "a" } });
    expect(await stored()).toMatchObject({ seq: 10, hash: "h10" });
    await saveCheckState(harness.db, { checkpoint: { seq: 12, hash: "h12", checkedAt: "c" } });
    expect(await stored()).toMatchObject({ seq: 12, hash: "h12" });
  });

  it("keeps a break the full check found while the first page check was running", async () => {
    await saveCheckState(harness.db, { full: broken });
    await saveCheckState(harness.db, { checkpoint: { seq: 3, hash: "h3", checkedAt: "a" }, full: { ...broken, valid: true, brokenAtSeq: null, reason: null }, fullOnlyIfNone: true });
    expect((await stored()).full).toEqual(broken);
    expect(await checkActivityChainSince(harness.db)).toMatchObject({ valid: false, brokenAtSeq: 4 });
  });
});
