import { describe, expect, it } from "vitest";

import { assertRecordedAnswer, assumedAnswers, recordedAnswers, RECORDED_ANSWERS, UnrecordedAnswerError } from "@tawd/core/recorded-answers";

import { dataForSeoAnswer, dataForSeoResult } from "./service-answers";

/*
  Stage 4 of docs/plans/self-check.md: no stand-in may be more optimistic
  than the service it stands for.

  The fault: DataForSEO answers a queued crawl with task status 20100,
  "Task Created." - its success code - and TAWD's stand-in answered 20000,
  which the live service never sends for that call. Every full SEO audit
  died at the crawl step, having been created and billed, and the suite
  stayed green for weeks (F16).
*/

describe("the answer this file exists to forbid", () => {
  it("refuses 20000 for on_page/task_post: the exact answer the old stand-in gave", () => {
    expect(() => assertRecordedAnswer("dataforseo", "on_page/task_post", 20000)).toThrow(UnrecordedAnswerError);
    expect(() => assertRecordedAnswer("dataforseo", "on_page/task_post", 20000)).toThrow(/never been seen to answer 20000/);
    // And it says what the service does answer, so the fix is obvious.
    expect(() => assertRecordedAnswer("dataforseo", "on_page/task_post", 20000)).toThrow(/20100 \(Task Created\.\)/);
  });

  it("allows what the service really answers there", () => {
    expect(() => assertRecordedAnswer("dataforseo", "on_page/task_post", 20100)).not.toThrow();
  });

  it("cannot be slipped past through the helper the tests use", () => {
    expect(() => dataForSeoAnswer("on_page/task_post", { status_code: 20000 })).toThrow(UnrecordedAnswerError);
    expect(() => dataForSeoResult("on_page/task_post", [])).toThrow(UnrecordedAnswerError);
  });

  it("checks the envelope and the task separately, because they differ", async () => {
    // The envelope succeeding while the task says something else is what TAWD misread.
    const answer = dataForSeoAnswer("on_page/task_post", { status_code: 20100, status_message: "Task Created." });
    const body = (await answer.json()) as { status_code: number; tasks: { status_code: number }[] };
    expect(body.status_code).toBe(20000);
    expect(body.tasks[0]!.status_code).toBe(20100);
    // An envelope status nobody has seen is refused too.
    expect(() => dataForSeoAnswer("dataforseo_labs", { status_code: 20000 }, { status_code: 20100 })).toThrow(UnrecordedAnswerError);
  });

  it("refuses to stand in for a call nobody has recorded at all", () => {
    expect(() => assertRecordedAnswer("dataforseo", "serp/live/advanced", 20000)).toThrow(/No answer has been recorded/);
    expect(() => assertRecordedAnswer("originality", "scan", 200)).toThrow(/No answer has been recorded/);
  });
});

describe("the record itself", () => {
  it("says where every answer came from, and when", () => {
    for (const answer of RECORDED_ANSWERS) {
      expect(["observed", "assumed"]).toContain(answer.source);
      // A note without a date cannot be re-checked later.
      expect(answer.note, `${answer.service} ${answer.endpoint} ${answer.statusCode}`).toMatch(/\d{4}|documented/i);
      expect(answer.note.length).toBeGreaterThan(30);
    }
  });

  /*
    CodeRabbit on PR #70: matching anywhere in the path let
    "other/on_page/summary" pass on on_page/summary's recorded answer,
    although nothing is recorded for that path. Matched from the start now.
  */
  it("matches from the start of the path, so a path that merely ends the same way is refused", () => {
    expect(() => assertRecordedAnswer("dataforseo", "other/on_page/summary", 20000)).toThrow(/No answer has been recorded/);
    expect(() => assertRecordedAnswer("dataforseo", "v4/on_page/task_post", 20100)).toThrow(/No answer has been recorded/);
    // An id after the path is still the same call.
    expect(() => assertRecordedAnswer("dataforseo", "on_page/summary/0711-task-id", 20000)).not.toThrow();
    expect(() => assertRecordedAnswer("dataforseo", "dataforseo_labs/google/ranked_keywords/live", 20000)).not.toThrow();
  });

  it("matches the longest endpoint first, so a general answer can't shadow a specific one", () => {
    const [first] = recordedAnswers("dataforseo", "on_page/task_post");
    expect(first!.endpoint).toBe("on_page/task_post");
    expect(first!.statusCode).toBe(20100);
  });

  /*
    The blind-spot list. TAWD has never watched on_page/summary or
    on_page/pages answer, because no audit got past task_post until the day
    that was fixed. That is not a reason to assert them in a test as though
    it had; it is the list a live smoke test has to settle.
  */
  it("names what TAWD believes but has never seen", () => {
    const assumed = assumedAnswers("dataforseo").map((a) => a.endpoint);
    expect(assumed).toContain("on_page/summary");
    expect(assumed).toContain("on_page/pages");
    for (const answer of assumedAnswers()) {
      expect(answer.note, `${answer.endpoint} is assumed but doesn't say so plainly`).toMatch(/never seen|documented|never watched/i);
    }
  });

  /*
    What this guard cannot do, said beside it (rule 11 of
    docs/CODE-REVIEW-STANDARD.md): an assumed answer is still ALLOWED,
    because a test must be able to exercise that path. The guard stops a
    stand-in inventing an answer; only a real call settles whether an
    assumption is right.
  */
  it("allows an assumed answer, and does not pretend that proves it", () => {
    expect(() => assertRecordedAnswer("dataforseo", "on_page/summary", 20000)).not.toThrow();
    expect(assumedAnswers("dataforseo").some((a) => a.endpoint === "on_page/summary")).toBe(true);
  });

  /*
    The whole list of what TAWD has actually watched a service do. It is
    short, and that is the point: the rest is belief. Adding to it means
    having seen it.
  */
  it("has seen everything it claims to have seen", () => {
    const observed = RECORDED_ANSWERS.filter((a) => a.source === "observed");
    expect(observed.map((a) => `${a.service} ${a.endpoint} ${a.statusCode}`)).toEqual([
      "dataforseo on_page/task_post 20100",
      "dataforseo dataforseo_labs 20000",
      "dataforseo-envelope  20000",
      "dataforseo-envelope  40104",
      "dataforseo-envelope  40100",
    ]);
  });
});

/*
  The ratchet.

  The guard only works on answers built through service-answers.ts: nothing
  stops a test hand-building a DataForSEO envelope and inventing a status,
  which is exactly how F16's lie got in. Converting every existing one is a
  bigger job than this stage, so the files that still do it are named here
  and grandfathered - and a NEW one cannot appear without this failing.

  When a named file is converted, take it off the list. The list only ever
  gets shorter.
*/
describe("nothing new may hand-build a service's answer", () => {
  const STILL_BY_HAND = [
    // Keyword research and its refusals (40100, 40104). Worth converting next; the refusals are recorded already.
    "seo-content.test.tsx",
  ];

  it("names every test file that builds a DataForSEO envelope itself", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.resolve(__dirname);
    const offenders: string[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!/\.tsx?$/.test(name)) continue;
      // The helper and this file's own expectations are the point, not offenders.
      if (name === "service-answers.ts" || name === "recorded-answers.test.ts") continue;
      const text = fs.readFileSync(path.join(dir, name), "utf8");
      // An envelope built by hand: a status_code beside a tasks array, not through the helper.
      if (/status_code:\s*\d{5}[\s\S]{0,200}tasks:/.test(text) || /tasks:\s*\[[\s\S]{0,120}status_code:\s*\d{5}/.test(text)) {
        offenders.push(name);
      }
    }
    expect(offenders.sort(), "a test builds a DataForSEO answer by hand; use service-answers.ts so the status is checked against what the service really sends").toEqual(
      STILL_BY_HAND.sort(),
    );
  });
});
