import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  The main menu, System, the Run book and My work (Jason, 29 September
  2026): Projects, My work and an Admin menu in four groups; Bluehost and
  the Site check folded into System; a Run book for everyone; and My work,
  where anyone who isn't an admin lands.
*/

const state: { user: unknown } = { user: null };
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/my-work",
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
import { can } from "@tawd/core/permissions";
import { e2eCheck, previewDecision, project as projectTable, siteBuild, siteDeploy } from "@tawd/core/schema";
import Home from "@/app/page";
import MyWorkPage from "@/app/(app)/my-work/page";
import RunbookPage from "@/app/(app)/runbook/page";
import SystemPage from "@/app/(app)/admin/system/page";
import { SiteCheckWarning } from "@/components/site-check-warning";
import { TopBar } from "@/components/ui/top-bar";
import { recordBuildFeePaid } from "@/lib/golive";
import { loadMyWork } from "@/lib/my-work";
import { createProject } from "@/lib/projects";
import { createHarness, seedAdmin, seedUser, viewer, type Harness } from "./harness";
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

const html = async (node: Promise<unknown> | unknown) => renderToStaticMarkup((await node) as React.ReactElement);

describe("the top bar", () => {
  it("gives a team member Projects, My work and the Run book, and no Admin menu", () => {
    const bar = renderToStaticMarkup(<TopBar user={{ email: "mei@velocitymedialab.com", canManageUsers: false, canViewActivity: false, canViewSpend: false }} />);
    expect(bar).toContain('href="/projects"');
    expect(bar).toContain('href="/my-work"');
    expect(bar).toContain('href="/runbook"');
    expect(bar).not.toContain("Admin");
    expect(bar).not.toContain("Bluehost");
    expect(bar).not.toContain("Site check");
  });

  it("gives an admin Projects, My work and a closed Admin menu, with no admin links in the bar itself", () => {
    const bar = renderToStaticMarkup(
      <TopBar user={{ email: "owner@velocitymedialab.com", canManageUsers: true, canViewActivity: true, canViewSpend: true, canViewMoney: true, canViewPrivacyLaws: true }} />,
    );
    expect(bar).toContain('aria-haspopup="true"');
    expect(bar).toContain('aria-expanded="false"');
    for (const gone of ["Team", "Spend", "Revenue", "Privacy laws", "Bluehost", "Site check", 'href="/runbook"']) expect(bar).not.toContain(gone);
  });
});

describe("System", () => {
  it("is for admins, holds the Site check and the hosting connections, and the old pages move there", async () => {
    const admin = await seedAdmin(h);
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    state.user = pm.viewer;
    await expect(SystemPage()).rejects.toThrow("redirect /projects");
    state.user = admin.viewer;
    const page = await html(SystemPage());
    expect(page).toContain('id="site-check"');
    expect(page).toContain('id="hosting"');
    expect(page).toContain("20i (WordPress, Build B)");
    expect(page).toContain("Check the 20i account");
    expect(page).not.toContain("Bluehost");
  });

  it("warns admins on every page only when the last Site check failed", async () => {
    expect(await SiteCheckWarning()).toBeNull();
    await h.db.insert(e2eCheck).values({ status: "failed", steps: [{ key: "stages", label: "Open every stage link", status: "failed", detail: "/projects/x/build (404)" }] });
    const strip = await html(SiteCheckWarning());
    expect(strip).toContain("The last Site check failed at &quot;Open every stage link&quot;.");
    expect(strip).toContain("/projects/x/build (404)");
    expect(strip).toContain('href="/admin/system#site-check"');
  });
});

describe("the Run book", () => {
  it("is for everyone, in plain words, with the steps and the house rules", async () => {
    state.user = viewer({ roles: ["content"] });
    const page = await html(RunbookPage());
    for (const text of ["The two lanes", "whose job each one is", "The house rules", "Going live", "[PLACEHOLDER]", "Check first ($0)", "WordPress sites", "Review pages", "Wireframe", "Done</strong> or", "Speed check"]) expect(page).toContain(text.replace("&", "&amp;"));
    // Fix these and 3c (5 October 2026).
    for (const text of ["Approve all unchanged</strong> approves those pages again", "One fix at a time per site", "TAWD’s check</strong> (free, no AI)", "One automatic retry:", "Nothing changed here", "Ask the Web Designer"]) expect(page).toContain(text);
    // Staged builds (6 October 2026).
    for (const text of ["In stages</strong>", "Coming soon</strong>", "Build all remaining pages</strong>", "Build the whole site again</strong>", "Every planned page built</strong>", "Three gates before go-live"]) expect(page).toContain(text);
    // Makeovers: keeping the current site's words (6 October 2026).
    for (const text of ["Project types: Design only and Design + content", "Improve the Home page first</strong>", "Prepare the content: Home page first</strong>", "Not needed for this project", "Current site: SEO suggestions", "kept word for word", "Kept page"]) expect(page).toContain(text);
    // One read of the current site (0.96.0): the plan makes itself, answers filled from the site, the blocked message, PT.
    for (const text of ["Reading the current site", "the page plan makes itself", "(TAWD, automatically)", "Replace the plan with the current site’s N pages</strong>", "From the current site” mark", "Never the name, licence numbers, years, hours, prices or reviews", "On Design there is no Home page words step", "If the site blocks TAWD</strong>", "Reading again won’t change that.", "Times across TAWD say PT (Pacific)."]) expect(page).toContain(text);
    // Blocked sites (Part D): Jina Reader, then Zyte, on Spend with their caps.
    for (const text of ["<strong>Jina Reader</strong>", "<strong>Zyte</strong>", "<strong>Blocked-site reads</strong>", "without asking; over $1 the read waits", "Read it for about $X</strong>", "top it up on jina.ai"]) expect(page).toContain(text);
    expect(page).not.toContain("Use these pages</strong>");
    expect(page).not.toContain("The Internet Archive was busy");
    expect(page).not.toContain("203.0.113.10");
    // US phone numbers, one way (6 October 2026).
    for (const text of ["A US phone number is saved as <strong>(916) 555-0142</strong> however it is typed", "is refused on save with a message beside the field", "a makeover’s kept words (free, by code)"]) expect(page).toContain(text);
    // A client's first real read, fixed (0.97.0). The Run book names the real site it read; the test doesn't (C9).
    for (const text of ["through Jina Reader for $0.30 (no AI)", "Filling the intake and making the page plan", "TAWD is making the page plan", "kept apart as reviews to confirm, never used as the", "a city that repeats the state loses it"]) expect(page).toContain(text);
    // A makeover's blog articles (0.98.0).
    for (const text of ["plus up to 100 blog articles on", "articles don’t count toward the limit", "only the first blog article is built with AI"]) expect(page).toContain(text);
    // The top progress bar (7 October 2026).
    for (const text of ["A thin blue line across the top of the window:</strong> the next screen is loading", "(15 seconds at most)", "Saves that stay on the same screen don’t show it."]) expect(page).toContain(text);
    // Cost per call, and Request changes asking first (0.101.0).
    // The 4.5 gate, pictures, icons and colour (0.102.0).
    for (const text of ["Only concepts at 4.5 or above are shown.", "<strong>Show it anyway</strong> (logged)", "there is no rebuild", "insects get a bug, rodents a paw", "the colour rhythm of the design direction"]) expect(page).toContain(text);
    // Placeholders only for required fields (0.101.0).
    for (const text of ["simply isn’t on the site: no placeholder, card or section", "is removed by code, free"]) expect(page).toContain(text);
    for (const text of ["<strong>Cost per call</strong> gives one row per AI call: its step, model, tokens, dollars and time", "shows the model and the estimate first", "<strong>Save and make v2</strong> starts the paid round"]) expect(page).toContain(text);
  });
});

describe("landing and My work", () => {
  it("sends admins to Projects and everyone else to My work", async () => {
    state.user = viewer({ isAdmin: true });
    await expect(Home()).rejects.toThrow("redirect /projects");
    state.user = viewer({ roles: ["pm"] });
    await expect(Home()).rejects.toThrow("redirect /my-work");
  });

  it("lists what is waiting on you, and what waits on someone else", async () => {
    const admin = await seedAdmin(h);
    const pm = await seedUser(h, admin.viewer, { email: "priya@velocitymedialab.com", name: "Priya Nair", roles: ["pm"] });
    const writer = await seedUser(h, admin.viewer, { email: "mei@velocitymedialab.com", name: "Mei Chen", roles: ["content"] });
    const make = (clientName: string, status: string) =>
      createProject(h.ctx, admin.viewer, { clientName, trade: "plumbing", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 3, status: "intake", memberUserIds: [pm.viewer.id, writer.viewer.id] }).then(async (id) => {
        await h.db.update(projectTable).set({ status }).where(eq(projectTable.id, id));
        return id;
      });
    await make("Tulemark Plumbing", "mockups");
    await make("Rio Glass", "intake");
    const labels = { trade: (t: string) => t, tier: (t: string) => t };

    const mine = await loadMyWork(h.db as Database, pm.viewer, labels);
    expect(mine.mine.map((r) => `${r.name}: ${r.next.title}`).sort()).toEqual(["Rio Glass: Finish the intake", "Tulemark Plumbing: Generate the concepts"]);
    expect(mine.mine.find((r) => r.name === "Rio Glass")!.step).toBe("Intake");

    const theirs = await loadMyWork(h.db as Database, writer.viewer, labels);
    expect(theirs.mine).toEqual([]);
    expect(theirs.others.map((r) => r.name).sort()).toEqual(["Rio Glass", "Tulemark Plumbing"]);

    state.user = writer.viewer;
    const page = await html(MyWorkPage());
    expect(page).toContain("Nothing is waiting on you right now.");
    expect(page).toContain("Waiting on someone else");
    expect(page).toContain("Generate the concepts (Priya Nair)");
  });

  it("puts the build fee on a founder's My work, and lets a founder record it", async () => {
    const admin = await seedAdmin(h);
    const founder = await seedUser(h, admin.viewer, { email: "sam@velocitymedialab.com", name: "Sam Founder", roles: ["founder"] });
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Oak Law", trade: "legal", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 3, status: "intake", memberUserIds: [] });
    await h.db.update(projectTable).set({ status: "build" }).where(eq(projectTable.id, id));
    const [build] = await h.db.insert(siteBuild).values({ projectId: id, version: 1, status: "done" } as never).returning();
    const [deploy] = await h.db.insert(siteDeploy).values({ projectId: id, buildId: build!.id, version: 1, kind: "preview", state: "ready" } as never).returning();
    await h.db.insert(previewDecision).values({ projectId: id, deployId: deploy!.id, outcome: "approved", channel: "email", clientSaid: "Yes", recordedByUserId: admin.viewer.id });

    const view = await loadMyWork(h.db as Database, founder.viewer, { trade: (t) => t, tier: (t) => t });
    expect(view.mine.map((r) => r.next.title)).toEqual(["Record the build fee"]);
    expect(can(founder.viewer, "golive.fee")).toBe(true);
    expect(can(viewer({ roles: ["pm"] }), "golive.fee")).toBe(false);
    await recordBuildFeePaid(h.ctx, founder.viewer, id, { paidOn: "2026-09-29", method: "card" });
    const after = await loadMyWork(h.db as Database, founder.viewer, { trade: (t) => t, tier: (t) => t });
    expect(after.mine).toEqual([]);
  });
});
