import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, goLive, netlifySite, project, siteBuild, siteDeploy } from "@tawd/core/schema";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { createProject } from "@/lib/projects";
import { setNetlifyFetchForTesting } from "@/lib/netlify";
import { LIVE_CLAIM_MS, claimLiveDeploy, settleInterruptedGoLive } from "@/lib/golive";

import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

/*
  D4 (audit F-032): going live ran inside one web request with no guard
  against two presses and six separate writes after Netlify published, so a
  restart between them left the site live and TAWD saying it wasn't.

  Note on the claim test: the test database runs transactions one after the
  other, so it shows one claim per press; the lock itself is what makes that
  hold on the real database (the batch D review, L2).
*/

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setStorageForTesting(new FakeR2() as never);
  vi.stubEnv("NETLIFY_AUTH_TOKEN", "nf-test");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  setNetlifyFetchForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

async function setUp(existing?: Awaited<ReturnType<typeof seedAdmin>>) {
  const admin = existing ?? (await seedAdmin(h));
  const id = await createProject(h.ctx, admin.viewer, { clientName: "Harbor Pest", trade: "pest_control", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 1, status: "qa", memberUserIds: [] });
  const [build] = await h.db.insert(siteBuild).values({ projectId: id, version: 1, status: "done", pages: [], fileCount: 1, checks: [] }).returning();
  await h.db.insert(goLive).values({ projectId: id, domain: "harborpest.example" });
  await h.db.insert(netlifySite).values({ projectId: id, siteId: `site-${id.slice(0, 6)}`, name: "tawd-harbor", url: "https://tawd-harbor.netlify.app", formEmails: [] });
  return { admin, id, buildId: build!.id, siteId: `site-${id.slice(0, 6)}` };
}

/* Netlify's answers: the deploy's own state, and which deploy the site serves. */
function netlifySays(deployState: string, served: string | null) {
  setNetlifyFetchForTesting(
    (async (url: string) => {
      if (url.includes("/deploys/")) return Response.json({ state: deployState, published_at: "2026-11-12T10:00:00Z" });
      return Response.json({ published_deploy: served ? { id: served } : null });
    }) as typeof fetch,
    async () => undefined,
  );
}

const stuckSince = () => new Date(Date.now() - LIVE_CLAIM_MS - 60_000);

describe("going live: one press, one run", () => {
  it("gives the claim once; a second press while it uploads is refused, and a stale upload doesn't hold it", async () => {
    const { admin, id, buildId } = await setUp();
    const [first, second] = await Promise.all([
      claimLiveDeploy(h.db as never, id, buildId, 1, admin.viewer.id),
      claimLiveDeploy(h.db as never, id, buildId, 1, admin.viewer.id),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);

    await h.db.update(siteDeploy).set({ createdAt: stuckSince() }).where(eq(siteDeploy.projectId, id));
    expect(await claimLiveDeploy(h.db as never, id, buildId, 1, admin.viewer.id)).not.toBeNull();
  });
});

describe("going live: interrupted after Netlify published", () => {
  it("records the site as live, once, when Netlify is serving that deploy", async () => {
    const { id, buildId } = await setUp();
    await h.db.insert(siteDeploy).values({ projectId: id, buildId, version: 1, kind: "live", state: "uploading", netlifyDeployId: "nd-9", createdAt: stuckSince() });
    netlifySays("ready", "nd-9");

    const [a, b] = await Promise.all([settleInterruptedGoLive(h.db as never, id), settleInterruptedGoLive(h.db as never, id)]);
    expect([a, b].filter((r) => r === "recovered")).toHaveLength(1);
    const [deploy] = await h.db.select().from(siteDeploy).where(eq(siteDeploy.projectId, id));
    expect(deploy).toMatchObject({ state: "ready", url: "https://harborpest.example/" });
    expect(deploy!.readyAt!.toISOString()).toBe("2026-11-12T10:00:00.000Z");
    const [proj] = await h.db.select().from(project).where(eq(project.id, id));
    expect(proj!.status).toBe("live");
    const logged = await h.db.select().from(activityLog).where(and(eq(activityLog.entityId, id), eq(activityLog.action, "golive.went_live")));
    expect(logged).toHaveLength(1);
  });

  it("doesn't record a deploy Netlify isn't serving (a roll back or a later deploy replaced it)", async () => {
    const { id, buildId } = await setUp();
    await h.db.insert(siteDeploy).values({ projectId: id, buildId, version: 3, kind: "live", state: "uploading", netlifyDeployId: "nd-3", createdAt: stuckSince() });
    netlifySays("ready", "nd-1");
    expect(await settleInterruptedGoLive(h.db as never, id)).toBe("failed");
    const [proj] = await h.db.select().from(project).where(eq(project.id, id));
    expect(proj!.status).not.toBe("live");
  });

  it("marks it failed when Netlify couldn't publish it or never finished, and leaves a go-live still running alone", async () => {
    const { admin, id, buildId } = await setUp();
    await h.db.insert(siteDeploy).values({ projectId: id, buildId, version: 1, kind: "live", state: "uploading", netlifyDeployId: "nd-9", createdAt: stuckSince() });
    netlifySays("error", null);
    expect(await settleInterruptedGoLive(h.db as never, id)).toBe("failed");

    const slow = await setUp(admin);
    await h.db.insert(siteDeploy).values({ projectId: slow.id, buildId: slow.buildId, version: 1, kind: "live", state: "uploading", netlifyDeployId: "nd-11", createdAt: stuckSince() });
    netlifySays("uploading", null);
    expect(await settleInterruptedGoLive(h.db as never, slow.id)).toBe("failed");

    const running = await setUp(admin);
    await h.db.insert(siteDeploy).values({ projectId: running.id, buildId: running.buildId, version: 1, kind: "live", state: "uploading", netlifyDeployId: "nd-10" });
    expect(await settleInterruptedGoLive(h.db as never, running.id)).toBeNull();
  });
});
