import { Queue } from "bullmq";
import IORedis from "ioredis";
import { afterAll, describe, expect, it } from "vitest";

import {
  CONCEPT_JOB,
  MOCKUP_QUEUE,
  conceptJobId,
  isRunActive,
} from "@tawd/core/queue";

/*
  The job id, checked against BullMQ itself.

  This exists because of a real failure: the id was "concept:<uuid>", and
  BullMQ uses ":" as its Redis key separator and rejects a custom id that
  contains one. Nothing caught it - not the types, not the tests against the
  fake queue - until a PM pressed Generate and got "Something went wrong".

  So these tests hand the id to the real library. BullMQ validates a job's
  options before it touches Redis, which means no server is needed: a valid
  id gets far enough to fail on the connection, an invalid one never gets
  that far. Distinguishing those two failures is the whole test.
*/

const connection = new IORedis({
  host: "127.0.0.1",
  // Deliberately nothing here. We never want this to connect.
  port: 6399,
  lazyConnect: true,
  maxRetriesPerRequest: null,
  enableOfflineQueue: false,
  retryStrategy: () => null,
  connectTimeout: 200,
});

const queue = new Queue(MOCKUP_QUEUE, { connection });

afterAll(async () => {
  await queue.close().catch(() => undefined);
  connection.disconnect();
});

/** The message BullMQ's own validation raises, verbatim. */
const REJECTED_BY_VALIDATION = /Custom Id cannot/;

async function addWithId(jobId: string): Promise<Error> {
  try {
    await queue.add(CONCEPT_JOB, { hello: "world" }, { jobId });
    throw new Error("unreachable: there is no Redis to accept the job");
  } catch (error) {
    return error as Error;
  }
}

describe("the job id BullMQ is actually given", () => {
  it("is accepted by BullMQ's validation", async () => {
    const error = await addWithId(
      conceptJobId("2f6b1f0e-9c1a-4d3a-9a5f-9b4a2f77c111"),
    );

    /*
      It still fails - there is no Redis - but it must fail at the
      connection, which means it got past validation. If this ever matches,
      the id shape has broken again.
    */
    expect(error.message).not.toMatch(REJECTED_BY_VALIDATION);
  });

  it("rejects the colon form that broke the first run", async () => {
    const error = await addWithId(
      "concept:2f6b1f0e-9c1a-4d3a-9a5f-9b4a2f77c111",
    );
    expect(error.message).toMatch(REJECTED_BY_VALIDATION);
  });

  it("contains no colon, whatever the concept id looks like", () => {
    for (const conceptId of [
      "2f6b1f0e-9c1a-4d3a-9a5f-9b4a2f77c111",
      "00000000-0000-0000-0000-000000000000",
      "plain",
    ]) {
      expect(conceptJobId(conceptId)).not.toContain(":");
    }
  });

  it("is not a bare integer, which BullMQ also refuses", async () => {
    // BullMQ reads an all-digits id as one of its own sequence numbers.
    const error = await addWithId(conceptJobId("12345"));
    expect(error.message).not.toMatch(REJECTED_BY_VALIDATION);
  });

  it("stays unique per concept, so two never collide", () => {
    const a = conceptJobId("2f6b1f0e-9c1a-4d3a-9a5f-9b4a2f77c111");
    const b = conceptJobId("2f6b1f0e-9c1a-4d3a-9a5f-9b4a2f77c222");
    expect(a).not.toBe(b);
  });

  it("names the concept, so a stuck job can be found", () => {
    expect(conceptJobId("abc")).toContain("abc");
  });
});

describe("the queue name", () => {
  it("has no colon either, which BullMQ refuses just as firmly", () => {
    // queue-base.js: "Queue name cannot contain :"
    expect(MOCKUP_QUEUE).not.toContain(":");
  });
});

/*
  After the first run failed at the queue, the page went straight back into
  showing that run and gave no way to start another: the setup form was
  hidden for anything that was not stopped. Only a run that is genuinely
  working should hide it.
*/
describe("when the setup form stays available", () => {
  it("hides it only while a run is actually working", () => {
    expect(isRunActive("queued")).toBe(true);
    expect(isRunActive("running")).toBe(true);
  });

  it("shows it again once a run has settled, however it ended", () => {
    for (const status of ["succeeded", "failed", "stopped"]) {
      expect(isRunActive(status), `${status} should not block setup`).toBe(
        false,
      );
    }
  });

  it("shows it when there has never been a run", () => {
    expect(isRunActive(null)).toBe(false);
    expect(isRunActive(undefined)).toBe(false);
  });
});
