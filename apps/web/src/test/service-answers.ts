import { assertRecordedAnswer } from "@tawd/core/recorded-answers";

/*
  How a test stands in for an outside service (stage 4 of
  docs/plans/self-check.md).

  Build every fake answer through these, never by hand. They refuse any
  status the live service has not been recorded as sending, so a stand-in
  can no longer be more optimistic than the thing it stands for - the fault
  that let every full SEO audit fail for weeks while the suite was green
  (F16: the fake answered 20000 to on_page/task_post; DataForSEO answers
  20100, "Task Created.").

  Adding a new answer means recording it in
  packages/core/src/lib/recorded-answers.ts, with where it was seen. If it
  has not been seen, it is marked assumed, and that is a thing to go and
  find out rather than a thing to assert in a test.
*/

export interface DataForSeoTask {
  status_code: number;
  status_message?: string;
  result?: unknown;
  [extra: string]: unknown;
}

/*
  One DataForSEO answer: the envelope's status and the task's are checked
  separately, because they differ - the envelope succeeding while the task
  says something else is exactly what TAWD misread.
*/
export function dataForSeoAnswer(
  endpoint: string,
  task: DataForSeoTask,
  envelope: { status_code?: number; cost?: number } = {},
): Response {
  const envelopeStatus = envelope.status_code ?? 20000;
  assertRecordedAnswer("dataforseo-envelope", "", envelopeStatus);
  assertRecordedAnswer("dataforseo", endpoint, task.status_code);
  return Response.json({
    status_code: envelopeStatus,
    cost: envelope.cost ?? 0,
    tasks: [{ cost: 0, result: null, ...task }],
  });
}

/** The ordinary "here is your data" answer, for the calls recorded as answering 20000. */
export function dataForSeoResult(endpoint: string, result: unknown[], extra: Record<string, unknown> = {}): Response {
  return dataForSeoAnswer(endpoint, { status_code: 20000, result, ...extra });
}
