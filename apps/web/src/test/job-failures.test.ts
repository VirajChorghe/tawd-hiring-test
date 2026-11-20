import { desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setDbForTesting } from "@tawd/core/db";
import { aiCall, jobFailure } from "@tawd/core/schema";
import { recordFailure, scrubSecrets } from "../../../worker/src/failures";
import { createProject } from "@/lib/projects";
import { createHarness, seedAdmin, type Harness } from "./harness";

/*
  Audit F-040 (D6): every failed job leaves one row an engineer can read
  after a redeploy: the stack, the project, the last AI call, with tokens
  and passwords scrubbed out.
*/

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db);
});
afterEach(async () => {
  setDbForTesting(null);
  await h.close();
});

const fakeJob = (data: Record<string, unknown>) => ({ id: "job-7", name: "review", queueName: "tawd-queue", data }) as never;

describe("scrubSecrets", () => {
  it("removes query strings, keys, tokens, passwords and bearer tokens", () => {
    const out = scrubSecrets(
      "GET https://api.example.com/v1/x?api_key=abc123&z=1 failed; token=sekret password: hunter2 Authorization: Bearer eyJhbGci.abc-def key=AAA",
    );
    expect(out).not.toMatch(/abc123|sekret|hunter2|eyJhbGci|AAA|z=1/);
    expect(out).toContain("https://api.example.com/v1/x");
    expect(out).toContain("[removed]");
  });

  it("also removes a JSON-quoted secret, a password in an address, and Basic or Token headers (the batch D review)", () => {
    const out = scrubSecrets(`{"password":"hunter2-secret","api_key":"abc123def"} postgres://tawd:s3cretpass@db:5432/tawd Authorization: Basic dXNlcjpwYXNzd29yZA== Token abcdef123456`);
    for (const secret of ["hunter2-secret", "abc123def", "s3cretpass", "dXNlcjpwYXNzd29yZA==", "abcdef123456"]) expect(out).not.toContain(secret);
    expect(out).toContain("postgres://tawd:[removed]@db:5432/tawd");
  });

  it("leaves ordinary words alone", () => {
    expect(scrubSecrets("The review did not finish: model refused.")).toBe("The review did not finish: model refused.");
  });
});

describe("recordFailure", () => {
  it("writes the stack, the project, the label and the last AI call", async () => {
    const admin = await seedAdmin(h);
    const projectId = await createProject(h.ctx, admin.viewer, {
      trade: "plumbing" as never, tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 1, status: "mockups", memberUserIds: [], clientName: "Acme Plumbing",
    });
    const project = { id: projectId };
    const runId = crypto.randomUUID();
    const [call] = await h.db
      .insert(aiCall)
      .values({ projectId: project.id, runId, step: "review", model: "claude-opus-5-5" })
      .returning({ id: aiCall.id });

    const error = new TypeError("boom at https://x.test/a?token=SECRET123");
    await recordFailure(fakeJob({ runId, projectId: project.id }), error, `Run ${runId}: review`);

    const [row] = await h.db.select().from(jobFailure).orderBy(desc(jobFailure.occurredAt));
    expect(row.queue).toBe("tawd-queue");
    expect(row.jobName).toBe("review");
    expect(row.jobId).toBe("job-7");
    expect(row.projectId).toBe(project.id);
    expect(row.label).toBe(`Run ${runId}: review`);
    expect(row.errorClass).toBe("TypeError");
    expect(row.message).not.toContain("SECRET123");
    expect(row.stack).toContain("TypeError");
    expect(row.stack).not.toContain("SECRET123");
    expect(row.lastAiCallId).toBe(call.id);
  });

  it("caps the message and stack, and accepts a thrown string", async () => {
    await recordFailure(fakeJob({}), "x".repeat(5000), "Thing");
    const e = new Error("y".repeat(5000));
    e.stack = "z".repeat(20000);
    await recordFailure(fakeJob({}), e, "Thing 2");
    const rows = await h.db.select().from(jobFailure);
    const string = rows.find((r) => r.label === "Thing")!;
    const err = rows.find((r) => r.label === "Thing 2")!;
    expect(string.message.length).toBeLessThanOrEqual(2000);
    expect(err.message.length).toBeLessThanOrEqual(2000);
    expect(err.stack.length).toBeLessThanOrEqual(8000);
    expect(string.projectId).toBeNull();
  });

  it("never throws, even when the database is gone", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    setDbForTesting({ insert: () => { throw new Error("db down"); } } as never);
    await expect(recordFailure(fakeJob({}), new Error("x"), "Thing")).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    setDbForTesting(h.db);
    expect(await h.db.select().from(jobFailure).where(eq(jobFailure.label, "Thing"))).toHaveLength(0);
  });
});
