/*
  What the outside services actually answer (stage 4 of
  docs/plans/self-check.md, built 10 November 2026).

  The fault this exists to make impossible: DataForSEO answers a queued
  crawl with task status **20100, "Task Created."** - its success code - and
  TAWD's test stand-in answered **20000**, which the live service never
  sends for that call. So `problemIn` treated the real answer as a failure,
  every full SEO audit died at the crawl step while being created and
  billed, and the suite stayed green for weeks because the fake was more
  optimistic than the service it stood for.

  A stand-in that can answer anything proves nothing. So the answers a
  stand-in may give are written down here, with where each one came from,
  and `assertRecordedAnswer` refuses any other. A fake can no longer invent
  a success.

  **`source` is the honest part.** "observed" means TAWD saw this answer
  come back from the live service, on the date given. "assumed" means it is
  what the service's documentation says, or what TAWD has always believed,
  and nobody has watched it happen. The assumed ones are the blind spots:
  `assumedAnswers()` lists them, and they are what a live smoke test has to
  settle. Marking one "observed" without having watched it is the whole
  disease, in one word.

  **What this cannot do.** It stops a stand-in INVENTING an answer, and it
  forces everything a stand-in asserts to be written down with where it came
  from. It does not prove an assumption right: an "assumed" answer is still
  allowed, because a test has to be able to exercise that path. Only a real
  call settles one, which is why assumedAnswers() exists and why the live
  smoke test is the rest of this stage.
*/

export type AnswerSource = "observed" | "assumed";

export interface RecordedAnswer {
  /** The service, as the team says it: "dataforseo", "shutterstock", "pagespeed". */
  service: string;
  /** The call, as the service names it: "on_page/task_post". A prefix match, so an id in the path is fine. */
  endpoint: string;
  /** The status this call can answer with. For DataForSEO, the status on the TASK, not the envelope. */
  statusCode: number;
  /** The words beside it, when the service sends them. */
  statusMessage?: string;
  /** Whether this answer has been seen from the live service, or only believed. */
  source: AnswerSource;
  /** When, and how it was seen or where the belief comes from. Dated, so it can be re-checked. */
  note: string;
}

/*
  DataForSEO. The envelope carries its own status_code and so does each
  task; the task's is the one that matters, and the one TAWD got wrong.
*/
const DATAFORSEO: RecordedAnswer[] = [
  {
    service: "dataforseo",
    endpoint: "on_page/task_post",
    statusCode: 20100,
    statusMessage: "Task Created.",
    source: "observed",
    note: "9 November 2026: found by reading a real failed audit. Every full SEO audit had died here because TAWD treated this success as a fault (F16).",
  },
  {
    service: "dataforseo",
    endpoint: "on_page/summary",
    statusCode: 20000,
    source: "assumed",
    note: "Never seen: no audit got past task_post until 9 November 2026, so TAWD has never watched this call answer. A live smoke test owes us this one.",
  },
  {
    service: "dataforseo",
    endpoint: "on_page/pages",
    statusCode: 20000,
    source: "assumed",
    note: "Never seen either, for the same reason as on_page/summary: nothing reached it before 9 November 2026.",
  },
  {
    service: "dataforseo",
    endpoint: "dataforseo_labs",
    statusCode: 20000,
    source: "observed",
    note: "4 November 2026: keyword research answered for real once the server's address was on DataForSEO's allowed list; Spend's connection test makes one real lookup since 0.123.0.",
  },
];

/*
  DataForSEO's envelope, which carries its own status beside the task's. It
  is a separate service key on purpose: a catch-all endpoint under
  "dataforseo" would have allowed 20000 for every call, including
  on_page/task_post, and that is precisely the answer this file exists to
  forbid there.
*/
const DATAFORSEO_ENVELOPE: RecordedAnswer[] = [
  {
    service: "dataforseo-envelope",
    endpoint: "",
    statusCode: 20000,
    source: "observed",
    note: "Seen on every real call since 9 November 2026, the failed audits included: the envelope succeeds while a task inside it says something else. That gap is what F16 was.",
  },
  {
    service: "dataforseo-envelope",
    endpoint: "",
    statusCode: 40104,
    statusMessage: "Please visit https://app.dataforseo.com/api-access to whitelist your IP address.",
    source: "observed",
    note: "4 November 2026: DataForSEO refused real lookups from 203.0.113.10 until the droplet's address was on its allowed list. Spend's connection test makes one real lookup since 0.123.0, so a refusal shows there.",
  },
  {
    service: "dataforseo-envelope",
    endpoint: "",
    statusCode: 40100,
    statusMessage: "You are not authorized to access this resource.",
    source: "observed",
    note: "Seen while the credentials were wrong, before 4 November 2026: the HTTP status is 401 and the envelope says this.",
  },
  {
    service: "dataforseo-envelope",
    endpoint: "",
    statusCode: 40401,
    statusMessage: "Not Found.",
    source: "assumed",
    note: "DataForSEO's documented code for an unknown path, so a stand-in can answer a wrong endpoint honestly. Never seen from TAWD.",
  },
];

export const RECORDED_ANSWERS: RecordedAnswer[] = [...DATAFORSEO, ...DATAFORSEO_ENVELOPE];

/*
  Every recorded answer for a call, longest-matching endpoint first.

  Matched from the START of the path, not anywhere in it (CodeRabbit, PR
  #70): with `includes`, "other/on_page/summary" passed the guard on
  on_page/summary's recorded 20000 although nothing is recorded for that
  path at all. A path that only ends the same way is a different call.
  An id after the path still matches, which is the point: "on_page/summary/
  <task-id>" is on_page/summary.
*/
export function recordedAnswers(service: string, endpoint: string): RecordedAnswer[] {
  return RECORDED_ANSWERS.filter((a) => a.service === service && (a.endpoint === "" || endpoint.startsWith(a.endpoint))).sort(
    (a, b) => b.endpoint.length - a.endpoint.length,
  );
}

/** The answers TAWD believes in but has never watched: what a live smoke test has to settle. */
export function assumedAnswers(service?: string): RecordedAnswer[] {
  return RECORDED_ANSWERS.filter((a) => a.source === "assumed" && (!service || a.service === service));
}

export class UnrecordedAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnrecordedAnswerError";
  }
}

/*
  Refuses an answer no recorded answer allows. Called by the test stand-ins,
  so a fake cannot be more optimistic than the service: answering 20000 to
  on_page/task_post now throws here instead of passing for weeks.
*/
export function assertRecordedAnswer(service: string, endpoint: string, statusCode: number): void {
  const allowed = recordedAnswers(service, endpoint);
  if (allowed.length === 0) {
    throw new UnrecordedAnswerError(
      `No answer has been recorded for ${service} "${endpoint}". Record what the live service actually sends in packages/core/src/lib/recorded-answers.ts before standing in for it.`,
    );
  }
  if (allowed.some((a) => a.statusCode === statusCode)) return;
  const list = allowed.map((a) => `${a.statusCode}${a.statusMessage ? ` (${a.statusMessage})` : ""} [${a.source}]`).join(", ");
  throw new UnrecordedAnswerError(
    `${service} "${endpoint}" has never been seen to answer ${statusCode}. Recorded: ${list}. ` +
      `A stand-in may only answer what the service answers - this is the fault that hid the broken SEO audit for weeks (F16).`,
  );
}
