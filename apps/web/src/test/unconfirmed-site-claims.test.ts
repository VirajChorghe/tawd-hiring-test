import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setDbForTesting, type Database } from "@tawd/core/db";
import { intakePrefill, siteBuild } from "@tawd/core/schema";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import { emptyIntake } from "@tawd/core/intake";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { loadIntakeForBuilding, withoutUnconfirmedClaims } from "@tawd/core/intake/unconfirmed";
import { confirmedFactsFrom, findClaimIssues } from "@tawd/core/mockups";
import { createProject } from "@/lib/projects";
import { goLiveChecklist } from "@/lib/golive";

import { setStorageForTesting } from "@tawd/core/intake/storage";
import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

/*
  B3 (audit F-016): a warranty, offer or financing read from the client's
  old website is marked "pending" and, until now, was used exactly like a
  fact the client gave: stated on the page and counted as backing a claim.
*/

const mark = (fieldKey: string, value: unknown, status = "pending", origin = "site") => ({ fieldKey, value, status, origin });

describe("the intake as a page builder reads it", () => {
  it("takes a pending site claim out, and names it as unconfirmed", () => {
    const data = emptyIntake();
    data.process.guarantees = "Lifetime warranty on every install";
    data.extras.currentOffers = "$500 off a repipe";
    data.extras.financingAvailable = true;
    const { data: out, unconfirmed } = withoutUnconfirmedClaims(data, [
      mark("process.guarantees", "Lifetime warranty on every install"),
      mark("extras.currentOffers", "$500 off a repipe"),
      mark("extras.financingAvailable", true),
    ]);
    expect(out.process.guarantees).toBe("");
    expect(out.extras.currentOffers).toBe("");
    expect(out.extras.financingAvailable).toBeNull();
    expect(unconfirmed.map((c) => c.key)).toEqual(["process.guarantees", "extras.currentOffers", "extras.financingAvailable"]);
    // The original is untouched: the intake screen still shows it with its mark.
    expect(data.process.guarantees).toBe("Lifetime warranty on every install");
  });

  it("keeps a confirmed one, a design's, a non-claim field, and a value someone has since changed", () => {
    const data = emptyIntake();
    data.process.guarantees = "1-year labour warranty";
    data.extras.currentOffers = "10% off first service";
    data.business.phone = "(916) 555-0142";
    const { data: out, unconfirmed } = withoutUnconfirmedClaims(data, [
      mark("process.guarantees", "1-year labour warranty", "confirmed"),
      mark("extras.currentOffers", "$500 off a repipe"),
      mark("business.phone", "(916) 555-0142"),
    ]);
    expect(out.process.guarantees).toBe("1-year labour warranty");
    expect(out.extras.currentOffers).toBe("10% off first service");
    expect(out.business.phone).toBe("(916) 555-0142");
    expect(unconfirmed).toEqual([]);
  });

  it("so an unconfirmed old-site warranty no longer backs one on the page", () => {
    const data = emptyIntake();
    data.process.guarantees = "Lifetime warranty on every install";
    const before = confirmedFactsFrom(data);
    const after = confirmedFactsFrom(withoutUnconfirmedClaims(data, [mark("process.guarantees", "Lifetime warranty on every install")]).data);
    const page = `<!doctype html><html><head><title>T</title></head><body><main><h1>Plumber</h1><p>Every install comes with a lifetime warranty.</p></main></body></html>`;
    expect(findClaimIssues(page, before.claims).map((i) => i.id)).toEqual([]);
    expect(findClaimIssues(page, after.claims).map((i) => i.id)).toContain("house.claim.unsupported");
  });
});

describe("loaded from the database", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    setDbForTesting(h.db as Database);
    setStorageForTesting(new FakeR2() as never);
  });
  afterEach(async () => {
    setDbForTesting(null);
    setStorageForTesting(null);
    await h.close();
  });

  it("the builders' intake leaves the claim out, and the go-live checklist lists it", async () => {
    const admin = await seedAdmin(h);
    const projectId = await createProject(h.ctx, admin.viewer, {
      clientName: "Synthetic Plumbing",
      trade: "plumbing",
      tier: "starter",
      lane: "lane_1",
      laneOption: null,
      conceptCount: 1,
      status: "intake",
      memberUserIds: [],
    });
    await saveIntakeSection(h.ctx, SYSTEM_ACTOR, projectId, "process", { guarantees: "Lifetime warranty on every install" });
    await h.db.insert(intakePrefill).values({ projectId, fieldKey: "process.guarantees", value: "Lifetime warranty on every install", source: "https://old.example/", origin: "site", status: "pending" });

    const intake = await loadIntakeForBuilding(h.db as Database, SYSTEM_ACTOR, projectId);
    expect(intake!.data.process.guarantees).toBe("");
    expect(intake!.unconfirmed).toEqual([{ key: "process.guarantees", label: "Guarantees", value: "Lifetime warranty on every install" }]);

    await h.db.insert(siteBuild).values({ projectId, version: 1, status: "done", checks: [] } as never);
    const { items } = await goLiveChecklist(h.db as never, projectId);
    const item = items.find((i) => i.key === "site-claims")!;
    expect(item.ok).toBe(false);
    expect(item.blocksGoLive).toBe(false);
    expect(item.detail).toContain('Guarantees ("Lifetime warranty on every install")');
  });
});
