import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setDbForTesting, type Database } from "@tawd/core/db";
import { siteBuild } from "@tawd/core/schema";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { projectStoragePrefix, setStorageForTesting } from "@tawd/core/intake/storage";
import { createProject } from "@/lib/projects";
import { goLiveChecklist } from "@/lib/golive";

import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

/*
  Batch B review, M1: the go-live checklist was a snapshot taken at build
  time. When "Facts match the intake" told a person to add a fact to the
  intake, adding it changed nothing until a paid rebuild. The facts and
  claims items are now read again against the stored pages and the intake
  as it is now.
*/

describe("the facts item, read again at go-live", () => {
  let h: Harness;
  let r2: FakeR2;
  beforeEach(async () => {
    h = await createHarness();
    setDbForTesting(h.db as Database);
    r2 = new FakeR2();
    setStorageForTesting(r2 as never);
  });
  afterEach(async () => {
    setDbForTesting(null);
    setStorageForTesting(null);
    await h.close();
  });

  it("clears once the missing fact is on the intake, with no rebuild", async () => {
    const admin = await seedAdmin(h);
    const projectId = await createProject(h.ctx, admin.viewer, {
      clientName: "Synthetic Plumbing",
      trade: "plumbing",
      tier: "starter",
      lane: "lane_1",
      laneOption: null,
      conceptCount: 1,
      status: "build",
      memberUserIds: [],
    });
    await saveIntakeSection(h.ctx, SYSTEM_ACTOR, projectId, "business", { name: "Synthetic Plumbing", phone: "(916) 555-0142" });
    const page = `<!doctype html><html><head><title>T</title></head><body><a href="tel:+19165550199">Call (916) 555-0199</a><h1>Plumber</h1></body></html>`;
    await r2.put(`${projectStoragePrefix(projectId)}site/v1/index.html`, Buffer.from(page));
    // The build's stored checklist, from when the intake had the other number.
    const stale = { key: "facts", label: "Facts match the intake", ok: false, detail: "index.html: (916) 555-0199", blocksGoLive: true };
    await h.db.insert(siteBuild).values({ projectId, version: 1, status: "done", checks: [stale] } as never);

    const before = (await goLiveChecklist(h.db as never, projectId)).items.find((i) => i.key === "facts")!;
    expect(before.ok).toBe(false);

    // The person does what the checklist says: the site's number is the real one.
    await saveIntakeSection(h.ctx, SYSTEM_ACTOR, projectId, "business", { name: "Synthetic Plumbing", phone: "(916) 555-0199" });
    const after = (await goLiveChecklist(h.db as never, projectId)).items.find((i) => i.key === "facts")!;
    expect(after.ok).toBe(true);
    expect(after.blocksGoLive).toBe(true);
  });
});
