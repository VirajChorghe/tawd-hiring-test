import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Build split into Build, Check and Preview, and Go live as a guided
  checklist (Jason, 29 September 2026; built 30 September): short parts
  instead of nine stacked cards, and one go-live step open at a time,
  with whose job it is.
*/

const state: { user: unknown } = { user: null };
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/projects",
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("@/lib/session", () => ({ requireUser: async () => state.user }));

import { eq } from "drizzle-orm";
import { setDbForTesting, type Database } from "@tawd/core/db";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { buildFeePayment, goLive, previewDecision, project as projectTable, siteBuild, siteDeploy } from "@tawd/core/schema";
import BuildPage from "@/app/(app)/projects/[id]/build/page";
import { GoLiveCard, type GoLiveCardProps } from "@/components/build/golive-card";
import { buildPartStates, currentBuildPart, shownBuildPart, type BuildFacts } from "@/lib/build-parts";
import { createProject } from "@/lib/projects";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setStorageForTesting(new FakeR2());
});
afterEach(async () => {
  state.user = null;
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

const facts = (over: Partial<BuildFacts>): BuildFacts => ({ lane: "lane_1", hasBuild: false, building: false, signedOff: false, previewApproved: false, live: false, ...over });

describe("which part the Build page opens at", () => {
  it("where the work is: Build, then Check, then Preview, then Go live", () => {
    expect(currentBuildPart(facts({}))).toBe("build");
    expect(currentBuildPart(facts({ hasBuild: true, building: true }))).toBe("build");
    expect(currentBuildPart(facts({ hasBuild: true }))).toBe("check");
    expect(currentBuildPart(facts({ hasBuild: true, signedOff: true }))).toBe("preview");
    expect(currentBuildPart(facts({ hasBuild: true, signedOff: true, previewApproved: true }))).toBe("golive");
    expect(currentBuildPart(facts({ live: true }))).toBe("golive");
  });

  it("a part asked for in the address wins; Lane 2 only has Go live", () => {
    expect(shownBuildPart("preview", facts({}))).toBe("preview");
    expect(shownBuildPart("nonsense", facts({ hasBuild: true }))).toBe("check");
    expect(shownBuildPart("build", facts({ lane: "lane_2" }))).toBe("golive");
  });

  it("each part says Done, Now or Later", () => {
    expect(buildPartStates(facts({ hasBuild: true })).map((p) => `${p.label}:${p.state}`)).toEqual(["Build:Done", "Check:Now", "Preview & client approval:Later", "Go live:Later"]);
  });
});

async function seed(status: string, lane: "lane_1" | "lane_2" = "lane_1") {
  const admin = await seedAdmin(h);
  state.user = admin.viewer;
  const pm = await seedUser(h, admin.viewer, { email: "priya@velocitymedialab.com", name: "Priya Nair", roles: ["pm"] });
  const id = await createProject(h.ctx, admin.viewer, {
    clientName: "Oak Law Group",
    trade: "legal",
    tier: "starter",
    lane,
    laneOption: lane === "lane_2" ? "a" : null,
    conceptCount: lane === "lane_2" ? null : 3,
    status: "intake",
    memberUserIds: [pm.viewer.id],
  });
  await h.db.update(projectTable).set({ status }).where(eq(projectTable.id, id));
  return { admin, id };
}

const render = async (id: string, part?: string) =>
  renderToStaticMarkup((await BuildPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(part ? { part } : {}) })) as React.ReactElement);

describe("the Build page, in parts", () => {
  it("opens at Build before anything is built, and shows only that part's cards", async () => {
    const { id } = await seed("build");
    const html = await render(id);
    expect(html).toContain('aria-label="Build parts"');
    expect(html).toContain("1 · Build");
    expect(html).toContain("4 · Go live");
    expect(html).toContain('id="site"');
    expect(html).not.toContain('id="seo-check"');
    expect(html).not.toContain('id="go-live"');
  });

  it("once built, opens at Check; ?part= opens another part", async () => {
    const { id } = await seed("build");
    await h.db.insert(siteBuild).values({ projectId: id, version: 1, status: "done", checks: [] } as never);
    const check = await render(id);
    expect(check).toContain('id="seo-check"');
    expect(check).not.toContain('id="site"');
    const preview = await render(id, "preview");
    expect(preview).toContain('id="preview"');
    expect(preview).not.toContain('id="seo-check"');
  });

  it("after the client approves the preview: Go live, with the checklist, Launch and Monthly edits", async () => {
    const { admin, id } = await seed("build");
    const [build] = await h.db.insert(siteBuild).values({ projectId: id, version: 1, status: "done", checks: [] } as never).returning();
    const [deploy] = await h.db.insert(siteDeploy).values({ projectId: id, buildId: build!.id, version: 1, kind: "preview", state: "ready" } as never).returning();
    await h.db.insert(previewDecision).values({ projectId: id, deployId: deploy!.id, outcome: "approved", channel: "email", clientSaid: "Looks great", recordedByUserId: admin.viewer.id });
    const html = await render(id);
    expect(html).toContain('id="go-live"');
    expect(html).toContain("Go live: 0 of 10 done");
    expect(html).toContain("Launch");
    expect(html).toContain('id="edits"');
    expect(html).toContain("Whose job: Priya Nair");
  });

  it("Lane 2: the Go live part alone, without the row of parts", async () => {
    const { id } = await seed("build", "lane_2");
    const html = await render(id, "build");
    expect(html).not.toContain('aria-label="Build parts"');
    expect(html).toContain('id="go-live"');
  });
});

const card = (over: Partial<GoLiveCardProps["steps"]> = {}, rest: Partial<GoLiveCardProps> = {}) => {
  const step = (done = false) => ({ done, line: done ? "Done line" : "To do line" });
  const props: GoLiveCardProps = {
    projectId: "p1",
    canEdit: true,
    canGoLive: true,
    canMoney: true,
    cloudflareMissing: [],
    fee: null,
    domainFromIntake: "oaklaw.com",
    steps: {
      domain: { ...step(), domain: null, registrar: "", registrant: "" },
      email: { ...step(), records: [], selectors: [] },
      cloudflare: { ...step(), nameservers: [] },
      check: { ...step(), results: [] },
      confirm: step(),
      netlify: step(),
      switched: step(),
      registry: null,
      https: step(),
      ga4: step(),
      ...over,
    },
    gate: { ready: false, blockers: ["The build fee isn't recorded."], flags: [] },
    live: null,
    canRollBack: false,
    lastError: null,
    pmLine: "Priya Nair",
    ...rest,
  };
  return renderToStaticMarkup(<GoLiveCard {...props} />);
};

describe("Go live, a guided checklist", () => {
  it("only the current step is open, with whose job it is; later steps show their name only", () => {
    const html = card({ domain: { done: true, line: "oaklaw.com, at GoDaddy.", domain: "oaklaw.com", registrar: "GoDaddy", registrant: "Oak Law" } });
    expect(html).toContain("Go live: 1 of 10 done");
    const current = html.slice(html.indexOf('class="golive-step is-current"'));
    // F3 (1 October 2026): after the domain, TAWD looks it up and the way it connects is chosen.
    expect(current).toContain("Connect the domain");
    expect(current).toContain("Whose job: Priya Nair");
    expect(current).toContain("Look up the domain");
    // One current step, and the later ones have no controls.
    expect(html.split("is-current").length - 1).toBe(2); // the step and its number
    expect(html).not.toContain("Set up the zone on Cloudflare");
    expect(html).not.toContain("Confirm the domain<");
    expect(html).toContain("Do again");
  });

  it("the build fee doesn't wait its turn: it keeps its button for admins and founders", () => {
    const html = card();
    expect(html).toContain("Waiting on: an admin or a founder");
    expect(html).toContain("Record build fee paid");
    expect(html).toContain("Confirm the domain");
    const paid = card({}, { fee: { line: "Paid 2026-09-29 by card." } });
    expect(paid).toContain("Go live: 1 of 10 done");
    expect(paid).toContain("Take back");
  });

  it("the Launch card holds Go live, disabled until ready, and what still blocks it", () => {
    const html = card();
    const launch = html.slice(html.indexOf("golive-launch"));
    expect(launch).toContain("Opens when every step is done.");
    expect(launch).toContain("Before it can go live");
    expect(launch).toMatch(/<button[^>]*disabled=""[^>]*>Go live<\/button>/);
  });
});

describe("the go-live step count stays with the database", () => {
  it("the fee and the steps recorded in the go-live row", async () => {
    const { admin, id } = await seed("build");
    await h.db.insert(buildFeePayment).values({ projectId: id, paidOn: "2026-09-29", method: "card", recordedByUserId: admin.viewer.id } as never);
    await h.db.insert(goLive).values({ projectId: id, domain: "oaklaw.com", domainConfirmedAt: new Date() } as never);
    const [build] = await h.db.insert(siteBuild).values({ projectId: id, version: 1, status: "done", checks: [] } as never).returning();
    const [deploy] = await h.db.insert(siteDeploy).values({ projectId: id, buildId: build!.id, version: 1, kind: "preview", state: "ready" } as never).returning();
    await h.db.insert(previewDecision).values({ projectId: id, deployId: deploy!.id, outcome: "approved", channel: "email", clientSaid: "Looks great", recordedByUserId: admin.viewer.id });
    expect(await render(id, "golive")).toContain("Go live: 2 of 10 done");
  });
});
