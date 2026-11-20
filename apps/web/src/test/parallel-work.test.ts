import { describe, expect, it } from "vitest";

/* Work at once (28 September 2026): which queue a job goes to, and the limit on calls in flight. */

import { CONCEPT_JOB, CONCEPT_QUEUE, CONTENT_DRAFT_JOB, COPY_QUEUE, DRAFT_QUEUE, FAITHFUL_COPY_JOB, MOCKUP_QUEUE, REVIEW_JOB, SITE_BUILD_JOB, queueFor } from "@tawd/core/queue";

import { eachAtOnce } from "../../../worker/src/at-once";

describe("the queues", () => {
  it("sends copies, drafts and concepts to their own queues, and everything else one at a time", () => {
    expect([FAITHFUL_COPY_JOB, CONTENT_DRAFT_JOB, CONCEPT_JOB].map(queueFor)).toEqual([COPY_QUEUE, DRAFT_QUEUE, CONCEPT_QUEUE]);
    expect([REVIEW_JOB, SITE_BUILD_JOB, "design-upload-read"].map(queueFor)).toEqual([MOCKUP_QUEUE, MOCKUP_QUEUE, MOCKUP_QUEUE]);
  });
});

describe("calls at once", () => {
  it("keeps to the limit, runs every item, and throws the first failure after all have settled", async () => {
    let inFlight = 0;
    let most = 0;
    const done: number[] = [];
    await eachAtOnce([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      done.push(n);
    });
    expect(most).toBe(3);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const ran: number[] = [];
    await expect(
      eachAtOnce([1, 2, 3], 3, async (n) => {
        ran.push(n);
        if (n === 1) throw new Error("first");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }),
    ).rejects.toThrow("first");
    expect(ran.sort()).toEqual([1, 2, 3]);
  });
});
