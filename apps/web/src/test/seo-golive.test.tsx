import path from "node:path";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  The Senior SEO Manager's check before go-live (26 September 2026): the
  program's checks, the agent's review (a stand-in), safe fixes made for
  the team, and the SEO team's sign-off, which the go-live list shows.
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

import { setDbForTesting, type Database } from "@tawd/core/db";
import { editRequest, pagePlanPage, seoGoLiveCheck, siteBuild } from "@tawd/core/schema";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { PermissionError } from "@tawd/core/permissions";
import { SEO_GOLIVE_JOB } from "@tawd/core/queue";
import { programChecks, summarizePage, type SeoFinding } from "@tawd/core/site";
import { createProject } from "@/lib/projects";
import { makePagePlan } from "@/lib/seo-data";
import { setQueueForTesting } from "@/lib/mockups";
import { applySafeFixes, loadSeoGoLive, signOffSeo, startSeoGoLiveCheck } from "@/lib/seo-golive";

import { runSeoGoLiveJob } from "../../../worker/src/seo-golive";
import type { WorkerConfig } from "../../../worker/src/config";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2, fakeClaude } from "./worker-fakes";

let h: Harness;
let r2: FakeR2;
let queued: { name: string; data: never }[];

const config: WorkerConfig = {
  databaseUrl: "unused",
  redisUrl: "unused",
  anthropicApiKey: "unused",
  model: "claude-opus-5-5",
  skillsDir: path.resolve(__dirname, "../../../../skills"),
  effort: "high",
};

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  r2 = new FakeR2();
  setStorageForTesting(r2);
  queued = [];
  setQueueForTesting({ add: async (name, data) => void queued.push({ name, data: data as never }), getJob: async () => null });
});

afterEach(async () => {
  setQueueForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

const html = (o: { title: string; description?: string; h1: string; body?: string; schema?: boolean }) =>
  `<!doctype html><html><head><title>${o.title}</title>${o.description ? `<meta name="description" content="${o.description}" />` : ""}${o.schema ? '<script type="application/ld+json">{"@type":"Plumber"}</script>' : ""}</head><body><a href="#main">Skip</a><main id="main"><h1>${o.h1}</h1>${o.body ?? "<p>Text.</p>"}</main></body></html>`;

describe("the program's checks", () => {
  it("find long or missing titles and descriptions, a missed keyword, images without alt, broken links and missing schema", () => {
    const home = summarizePage(html({ title: "Home", description: "About drains.", h1: "Drains", body: '<p>Welcome.</p><img src="/a.jpg"><a href="/nowhere/">x</a>' }), { path: "/", name: "Home", mainKeyword: "plumber sacramento" });
    const drains = summarizePage(html({ title: "x".repeat(70), h1: "Drain cleaning in Sacramento", schema: true }), { path: "/drain-cleaning/", name: "Drain cleaning", mainKeyword: "drain cleaning sacramento" });
    const keys = programChecks([home, drains], { name: "Sac Drain", phone: "", city: "Sacramento" }, new Set(["/", "/drain-cleaning/"])).map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(["alt:/", "keyword:/", "link:/:/nowhere/", "title-long:/drain-cleaning/", "meta-missing:/drain-cleaning/", "schema:home"]));
    expect(keys).not.toContain("keyword:/drain-cleaning/");
  });
});

describe("the check before go-live", () => {
  async function built() {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Sacramento Drain Pros", trade: "plumbing", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 3, status: "build", memberUserIds: [] });
    await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Sacramento Drain Pros", state: "CA", yearFounded: 2009, emergency247: true });
    await saveIntakeSection(h.ctx, admin.viewer, id, "services", { items: [{ id: "s1", name: "Drain cleaning", description: "" }], mainServiceId: "s1" });
    await saveIntakeSection(h.ctx, admin.viewer, id, "serviceAreas", { scope: "cities", cities: ["Sacramento"] });
    await makePagePlan(h.ctx, admin.viewer, id);
    const plan = await h.db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, id));
    const [build] = await h.db.insert(siteBuild).values({ projectId: id, version: 1, status: "done", pages: [], fileCount: 1 }).returning();
    for (const p of plan) {
      const file = p.slug ? `${p.slug}/index.html` : "index.html";
      const long = p.kind === "about" ? "About Sacramento Drain Pros and the family who run it | Sacramento Drain Pros" : p.title;
      r2.objects.set(`projects/${id}/site/v1/${file}`, Buffer.from(html({ title: long, description: p.metaDescription, h1: p.h1, schema: p.kind === "home", body: p.kind === "faq" ? '<p>Questions.</p><img src="/x.jpg">' : `<p>${p.h1}.</p>` })));
    }
    // The about page's plan title is the long one too, as if someone had typed it.
    await h.db.update(pagePlanPage).set({ title: "About Sacramento Drain Pros and the family who run it | Sacramento Drain Pros" }).where(eq(pagePlanPage.kind, "about"));
    return { admin, id, build: build! };
  }

  it("runs the checks and the agent's review, applies the safe fixes, and records the SEO team's sign-off", async () => {
    const { admin, id } = await built();
    // Two clicks together start one paid check (13 October 2026, the whole-code review).
    const both = await Promise.allSettled([startSeoGoLiveCheck(h.ctx, admin.viewer, id), startSeoGoLiveCheck(h.ctx, admin.viewer, id)]);
    expect(both.filter((b) => b.status === "fulfilled")).toHaveLength(1);
    expect(queued.map((q) => q.name)).toEqual([SEO_GOLIVE_JOB]);
    const claude = fakeClaude(() => [{ summary: "Nearly ready: two small fixes.", findings: [{ page: "/service-areas/", problem: "The page is thin (under 100 words).", fix: "Add a sentence per area served.", safe: false }] }]);
    await runSeoGoLiveJob(queued[0]!.data, config, claude.client as never);

    let view = await loadSeoGoLive(h.db, id);
    const findings = view.check!.findings as SeoFinding[];
    expect(view.check).toMatchObject({ status: "done", summary: "Nearly ready: two small fixes." });
    expect(findings.map((f) => f.key)).toEqual(expect.arrayContaining(["title-long:/about/", "alt:/faq/", "agent:0"]));
    const sent = String((claude.calls[0]!.params.messages as { content: string }[])[0]!.content);
    expect(sent).toContain("Already found by TAWD's checks");

    await applySafeFixes(h.ctx, admin.viewer, id, view.check!.id);
    const [about] = await h.db.select().from(pagePlanPage).where(eq(pagePlanPage.kind, "about"));
    expect(about!.title.length).toBeLessThanOrEqual(60);
    const [request] = await h.db.select().from(editRequest).where(eq(editRequest.projectId, id));
    expect(request).toMatchObject({ kind: "edit", status: "open" });
    expect(request!.clientWords).toContain("/faq/: Describe each image in its alt text.");
    view = await loadSeoGoLive(h.db, id);
    expect((view.check!.findings as SeoFinding[]).filter((f) => f.safe).every((f) => f.fixed)).toBe(true);

    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    await expect(signOffSeo(h.ctx, pm.viewer, id, view.check!.id, "")).rejects.toThrow(PermissionError);
    const seo = await seedUser(h, admin.viewer, { email: "seo@velocitymedialab.com", roles: ["seo"] });
    await signOffSeo(h.ctx, seo.viewer, id, view.check!.id, "Service areas page to grow after launch");
    expect((await loadSeoGoLive(h.db, id)).signedOff).toBe(true);

    state.user = admin.viewer;
    const { default: BuildPage } = await import("@/app/(app)/projects/[id]/build/page");
    await h.db.update(siteBuild).set({ checks: [] }).where(eq(siteBuild.projectId, id));
    const page = renderToStaticMarkup(await BuildPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ part: "check" }) }));
    expect(page).toContain("SEO check before go-live");
    expect(page).toContain("SEO team sign-off");
    expect(page).toContain("Signed off by Test Person");
  });

  it("asks for a new check when a newer build exists", async () => {
    const { admin, id } = await built();
    await startSeoGoLiveCheck(h.ctx, admin.viewer, id);
    await runSeoGoLiveJob(queued[0]!.data, config, fakeClaude(() => [{ summary: "Fine.", findings: [] }]).client as never);
    const [check] = await h.db.select().from(seoGoLiveCheck).where(eq(seoGoLiveCheck.projectId, id));
    await h.db.insert(siteBuild).values({ projectId: id, version: 2, status: "done", pages: [], fileCount: 1 });
    await expect(signOffSeo(h.ctx, admin.viewer, id, check!.id, "")).rejects.toThrow("A newer build exists");
    expect((await loadSeoGoLive(h.db, id)).signedOff).toBe(false);
  });
});
