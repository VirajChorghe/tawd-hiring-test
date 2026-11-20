import { describe, expect, it } from "vitest";

import { stageStates } from "@/lib/stages";

/*
  The stage strip as navigation: reached stages are links, the next one
  opens once the current stage is done, and the rest are locked with a
  reason.
*/

const ID = "0b0c1f8e-2f5b-4a55-9a1d-2d8f0a6c3e11";

const states = (status: Parameters<typeof stageStates>[0]["status"], done = false) =>
  stageStates({ projectId: ID, status, currentStageDone: done }).map(
    (s) => `${s.stage}:${s.state}`,
  );

describe("stage navigation", () => {
  it("in an unfinished intake, only Intake is open", () => {
    expect(states("intake")).toEqual([
      "intake:current",
      "mockups:locked",
      "content:locked",
      "build:locked",
      "qa:locked",
      "live:locked",
    ]);
  });

  it("with the intake complete, Intake is done and Mockups opens", () => {
    expect(states("intake", true).slice(0, 3)).toEqual([
      "intake:done",
      "mockups:available",
      "content:locked",
    ]);
  });

  it("once in Mockups, Intake is done and Mockups is current", () => {
    expect(states("mockups").slice(0, 3)).toEqual([
      "intake:done",
      "mockups:current",
      "content:locked",
    ]);
  });

  it("links reached stages to their screens", () => {
    const items = stageStates({ projectId: ID, status: "mockups", currentStageDone: false });
    expect(items[0]!.href).toBe(`/projects/${ID}/intake`);
    expect(items[1]!.href).toBe(`/projects/${ID}/mockups`);
    expect(items[2]!.href).toBeNull();
  });

  it("says what unlocks each locked stage", () => {
    const items = stageStates({ projectId: ID, status: "intake", currentStageDone: false });
    expect(items.find((i) => i.stage === "mockups")!.lockedReason).toMatch(/required intake/);
    expect(items.find((i) => i.stage === "content")!.lockedReason).toMatch(/approves a concept/);
    expect(items.find((i) => i.stage === "live")!.lockedReason).toMatch(/founders/);
    expect(items[0]!.lockedReason).toBeNull();
  });

  it("sends a reached stage with no screen yet to the project page", () => {
    const items = stageStates({ projectId: ID, status: "build", currentStageDone: false });
    expect(items.find((i) => i.stage === "content")!.href).toBe(`/projects/${ID}/content`);
    expect(items.find((i) => i.stage === "build")!.href).toBe(`/projects/${ID}/build`);
    expect(items.find((i) => i.stage === "qa")!.state).toBe("locked");
  });

  it("keeps only the existing screens open while paused", () => {
    expect(states("paused")).toEqual([
      "intake:done",
      "mockups:done",
      "content:locked",
      "build:locked",
      "qa:locked",
      "live:locked",
    ]);
  });
});
