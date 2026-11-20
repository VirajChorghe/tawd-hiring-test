import { describe, expect, it } from "vitest";

import { approvalProblems } from "@/lib/exact-design";

/*
  The whole-code review's Lows (13 October 2026), the last batch: the ones
  with no test file of their own. No database, no network.
*/

describe("approving a design built exactly (Option A)", () => {
  const view = (mobile: { status: string; from: string; decision: string | null }) =>
    ({ imported: true, confirmed: true, upload: false, pages: [{ name: "Home", isHome: true, copy: { status: "done", mobile } }] }) as unknown as Parameters<typeof approvalProblems>[0];

  it("waits while the designer has pushed back a phone version, however it was made", () => {
    expect(approvalProblems(view({ status: "done", from: "code", decision: "pushed_back" }))).toEqual(["Home: the designer pushed back the phone version; make a new one first."]);
    expect(approvalProblems(view({ status: "done", from: "code", decision: null }))).toEqual([]);
    expect(approvalProblems(view({ status: "done", from: "code", decision: "accepted" }))).toEqual([]);
  });
});
