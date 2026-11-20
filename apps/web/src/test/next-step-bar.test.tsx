import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  The next-step bar (Jason, 29 September 2026; built 30 September): the
  same bar in the same place on every stage page, with the next step and
  whose job it is on the left and the one next action on the right. It
  never starts a paid step: paid work starts from its card, beside its
  model and estimate.
*/

const state: { user: unknown } = { user: null };
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/projects",
  useSearchParams: () => new URLSearchParams(),
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
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { contentDecision, pageDraft, pagePlanPage, project as projectTable, siteBuild } from "@tawd/core/schema";
import BuildPage from "@/app/(app)/projects/[id]/build/page";
import ContentPage from "@/app/(app)/projects/[id]/content/page";
import IntakePage from "@/app/(app)/projects/[id]/intake/page";
import MockupsPage from "@/app/(app)/projects/[id]/mockups/page";
import ProjectPage from "@/app/(app)/projects/[id]/page";
import { planBar } from "@/components/project/next-step-bar";
import type { NextStep } from "@/lib/next-step";
import { createProject } from "@/lib/projects";
import { makePagePlan } from "@/lib/seo-data";
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

const P = "/projects/p1";
const step = (over: Partial<NextStep>): NextStep => ({
  title: "Draft 3 pages",
  line: "",
  who: { label: "Whose job", people: [{ id: "m", name: "Mei Chen" }], text: "", roles: ["content"] },
  action: { label: "Draft the pages", href: `${P}/content#drafts` },
  secondary: null,
  ...over,
});

describe("what the bar shows", () => {
  it("work further down this page: a link that scrolls to its card", () => {
    expect(planBar(step({}), `${P}/content`, false)).toEqual({ badge: "Now", elsewhere: null, link: { label: "Draft the pages ↓", href: "#drafts" } });
  });

  it("work on another page: a link there, and which page", () => {
    expect(planBar(step({}), `${P}/intake`, false)).toEqual({ badge: "Next step", elsewhere: "Content", link: { label: "Draft the pages →", href: `${P}/content#drafts` } });
  });

  it("the page's own buttons win, and say Now", () => {
    expect(planBar(step({}), `${P}/intake`, true)).toEqual({ badge: "Now", elsewhere: null, link: null });
  });

  it("while TAWD works on this page there is nothing to press", () => {
    const busy = step({ who: { label: "Waiting on", people: [], text: "TAWD", roles: [] }, action: { label: "Watch the progress", href: `${P}/mockups#build` } });
    expect(planBar(busy, `${P}/mockups`, false)).toEqual({ badge: "Waiting", elsewhere: null, link: null });
    expect(planBar(busy, `${P}/content`, false).link).toEqual({ label: "Watch the progress →", href: `${P}/mockups#build` });
  });

  it("waiting on the client or a founder shows Waiting, with the way there", () => {
    const fee = step({ who: { label: "Waiting on", people: [], text: "an admin or a founder", roles: [], adminOrFounder: true }, action: { label: "Open the go-live steps", href: `${P}/build?part=golive#go-live` } });
    expect(planBar(fee, `${P}/build?part=golive`, false)).toEqual({ badge: "Waiting", elsewhere: null, link: { label: "Open the go-live steps ↓", href: "#go-live" } });
  });

  it("another part of the intake (its Design section) is a plain link", () => {
    const design = step({ action: { label: "Open the Design section", href: `${P}/intake?section=figma` } });
    expect(planBar(design, `${P}/intake`, false)).toEqual({ badge: "Now", elsewhere: null, link: { label: "Open the Design section", href: `${P}/intake?section=figma` } });
  });

  it("on its own page, \"Open Build\" names the card instead", () => {
    const build = step({ action: { label: "Open Build", href: `${P}/build?part=build#site` } });
    expect(planBar(build, `${P}/build?part=build`, false).link).toEqual({ label: "Go to the site ↓", href: "#site" });
  });

  it("a paused project: no button", () => {
    expect(planBar(step({ action: null }), `${P}/build`, false).link).toBeNull();
  });
});

async function seed(status: string) {
  const admin = await seedAdmin(h);
  state.user = admin.viewer;
  const pm = await seedUser(h, admin.viewer, { email: "priya@velocitymedialab.com", name: "Priya Nair", roles: ["pm"] });
  const id = await createProject(h.ctx, admin.viewer, {
    clientName: "Valley Air",
    trade: "hvac",
    tier: "starter",
    lane: "lane_1",
    laneOption: null,
    conceptCount: 3,
    status: "intake",
    memberUserIds: [pm.viewer.id],
  });
  // Answered, so Design and Generate aren't blocked (the current website rule, 30 September 2026).
  await saveIntakeSection(h.ctx, admin.viewer, id, "website", { noCurrentWebsite: true });
  await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Valley Air", state: "CA" });
  if (status !== "intake") await h.db.update(projectTable).set({ status }).where(eq(projectTable.id, id));
  return { admin, id };
}

const html = async (page: unknown) => renderToStaticMarkup((await page) as React.ReactElement);
const params = (id: string) => ({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });
/* The bar's own markup, from its opening tag to its end. */
const barOf = (markup: string) => {
  const start = markup.indexOf('<aside class="next-bar"');
  return start < 0 ? null : markup.slice(start, markup.indexOf("</aside>", start));
};

describe("the bar on each stage page", () => {
  it("Intake: the gate's button is in the bar, not the header", async () => {
    const { id } = await seed("intake");
    const page = await html(IntakePage(params(id) as never));
    const bar = barOf(page)!;
    expect(bar).toContain("Finish the intake");
    expect(bar).toContain("Whose job: Priya Nair");
    expect(bar).toContain("Move to Design");
    expect(bar).toContain("required items missing");
    const header = page.slice(page.indexOf('class="project-header"'), page.indexOf("</section>", page.indexOf('class="project-header"')));
    expect(header).not.toContain("Move to Design");
  });

  it("Design, before any concepts: scrolls to the set up (the paid Generate stays beside its estimate)", async () => {
    const { id } = await seed("mockups");
    const bar = barOf(await html(MockupsPage(params(id) as never)))!;
    expect(bar).toContain("Generate the concepts");
    expect(bar).toContain('href="#setup"');
    expect(bar).toContain("Set up the concepts ↓");
  });

  it("Content: the drafts, then Move to Build & preview once the client approved the copy", async () => {
    const { admin, id } = await seed("content");
    await makePagePlan(h.ctx, admin.viewer, id);
    const pages = await h.db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, id));
    const first = barOf(await html(ContentPage(params(id) as never)))!;
    expect(first).toContain(`Draft ${pages.length} pages</p>`);
    expect(first).toContain('<a class="btn btn-primary" href="#drafts">Draft the pages ↓</a>');
    for (const p of pages) await h.db.insert(pageDraft).values({ projectId: id, pageId: p.id, version: 1, source: "draft", status: "done", body: "# Page\n", approvedAt: new Date(), approvedByUserId: admin.viewer.id } as never);
    await h.db.insert(contentDecision).values({ projectId: id, outcome: "approved", channel: "email", clientSaid: "All good", pages: [], recordedByUserId: admin.viewer.id } as never);
    const page = await html(ContentPage(params(id) as never));
    const bar = barOf(page)!;
    expect(bar).toContain("Move to Build &amp; preview");
    // Only in the bar now (its title and its button), not in the drafts card as well.
    expect(page.replace(bar, "")).not.toContain("Move to Build");
  });

  it("Build: the SEO check once built, as a link down the page; Intake links there", async () => {
    const { id } = await seed("build");
    await h.db.insert(siteBuild).values({ projectId: id, version: 1, status: "done", checks: [] } as never);
    const bar = barOf(await html(BuildPage({ params: Promise.resolve({ id }) })))!;
    expect(bar).toContain("Run the SEO check and sign off");
    expect(bar).toContain('href="#seo-check"');
    const fromIntake = barOf(await html(IntakePage(params(id) as never)))!;
    expect(fromIntake).toContain("on Build");
    expect(fromIntake).toContain(`href="/projects/${id}/build?part=check#seo-check"`);
  });

  it("the project page has the Next step card instead, and no bar", async () => {
    const { id } = await seed("mockups");
    expect(barOf(await html(ProjectPage(params(id))))).toBeNull();
  });
});
