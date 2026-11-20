import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  The page-by-page review (step 3a, 3 October 2026): each page of the
  latest build approved by a PM, the Web Designer, a founder or an admin,
  comments pinned to its sections, approvals carried over while the page,
  header and footer are unchanged, and go-live waiting for every page
  unless a founder lets one version through.
*/

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/projects/p1/build",
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("@/app/actions", () => new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : async () => ({ ok: true })), has: () => true }));

import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, goLive, pageApproval, pageReviewComment, project as projectTable, siteBuild } from "@tawd/core/schema";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { PermissionError } from "@tawd/core/permissions";
import { createProject } from "@/lib/projects";
import { goLiveChecklist } from "@/lib/golive";
import { deleteProject } from "@/lib/project-deletion";
import {
  PageReviewError,
  addReviewComment,
  approveReviewedPage,
  approveUnchanged,
  loadPageComments,
  loadPageForReview,
  loadPageReview,
  overridePageReview,
  pagesChecklistItem,
  setReviewCommentResolved,
  withdrawApproval,
} from "@/lib/page-review";
import { ReviewPagesCard } from "@/components/build/review-pages-card";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

let h: Harness;
let r2: FakeR2;

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  r2 = new FakeR2();
  setStorageForTesting(r2);
});

afterEach(async () => {
  setDbForTesting(null);
  setStorageForTesting(null);
  await h.close();
});

const PAGES = [
  { pageId: "home", name: "Home", path: "/", shotKey: null, placeholders: [] },
  { pageId: "drains", name: "Drain cleaning", path: "/drain-cleaning/", shotKey: null, placeholders: [] },
];

/* A finished build with its kept sources: each page's <main>, and the shared header and footer. */
async function build(projectId: string, version: number, sources: { home: string; drains: string; parts: string }) {
  await h.db.insert(siteBuild).values({ projectId, version, status: "done", pages: PAGES, checks: [], finishedAt: new Date() } as never);
  const base = `projects/${projectId.toLowerCase()}/site/v${version}/`;
  await r2.put(`${base}_source/pages/home.html`, Buffer.from(sources.home));
  await r2.put(`${base}_source/pages/drain-cleaning.html`, Buffer.from(sources.drains));
  await r2.put(`${base}_source/parts.json`, Buffer.from(sources.parts));
}

async function seed() {
  const admin = await seedAdmin(h);
  const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", name: "Sam Park", roles: ["pm"] });
  const designer = await seedUser(h, admin.viewer, { email: "design@velocitymedialab.com", name: "Dana Lee", roles: ["web_designer"] });
  const content = await seedUser(h, admin.viewer, { email: "content@velocitymedialab.com", roles: ["content"] });
  const founder = await seedUser(h, admin.viewer, { email: "cofounder@velocitymedialab.com", name: "Todd Rivers", roles: ["founder"] });
  const id = await createProject(h.ctx, admin.viewer, { trade: "plumbing", lane: "lane_1", laneOption: null, conceptCount: 1, status: "build", memberUserIds: [], tier: "starter", clientName: "Harbor Plumbing" });
  await build(id, 1, { home: "<section>Hero</section>", drains: "<section>Drains</section>", parts: '{"header":"H","footer":"F"}' });
  const people = new Map([
    [pm.viewer.id, "Sam Park"],
    [designer.viewer.id, "Dana Lee"],
    [founder.viewer.id, "Todd Rivers"],
  ]);
  return { admin, pm, designer, content, founder, id, people };
}

describe("approving pages", () => {
  it("lets a PM, the Web Designer or a founder approve, never Content, and go-live waits for every page", async () => {
    const { pm, designer, content, id, people } = await seed();
    await expect(approveReviewedPage(h.ctx, content.viewer, id, "home")).rejects.toBeInstanceOf(PermissionError);
    await expect(approveReviewedPage(h.ctx, pm.viewer, id, "nope")).rejects.toBeInstanceOf(PageReviewError);

    let item = pagesChecklistItem(await loadPageReview(h.db, id, people))!;
    expect(item).toMatchObject({ key: "pages-approved", ok: false, blocksGoLive: true, detail: "0 of 2 approved: review the rest (Check, Review pages)" });

    await approveReviewedPage(h.ctx, pm.viewer, id, "home");
    await expect(approveReviewedPage(h.ctx, designer.viewer, id, "home")).rejects.toThrow("already approved");
    await approveReviewedPage(h.ctx, designer.viewer, id, "drains");

    const view = await loadPageReview(h.db, id, people);
    expect(view.approvedCount).toBe(2);
    expect(view.pages[0]!.approved).toMatchObject({ by: "Sam Park", version: 1 });
    item = pagesChecklistItem(view)!;
    expect(item).toMatchObject({ ok: true, detail: "All 2 pages approved" });
    // The go-live checklist (and so the gate) carries the same line.
    expect((await goLiveChecklist(h.db, id)).items.find((i) => i.key === "pages-approved")).toMatchObject({ ok: true });

    const logged = await h.db.select().from(activityLog).where(eq(activityLog.action, "site.page_approved"));
    expect(logged.map((l) => (l.valueAfter as { page: string }).page)).toEqual(["Home", "Drain cleaning"]);
  });

  it("carries an approval over while the page, header and footer stay the same, and asks again otherwise", async () => {
    const { pm, id, people } = await seed();
    await approveReviewedPage(h.ctx, pm.viewer, id, "home");
    await approveReviewedPage(h.ctx, pm.viewer, id, "drains");

    // Version 2: the drains page changed; home is the same.
    await build(id, 2, { home: "<section>Hero</section>", drains: "<section>Drains, now with prices</section>", parts: '{"header":"H","footer":"F"}' });
    let view = await loadPageReview(h.db, id, people);
    expect(view.pages.map((p) => [p.pageId, Boolean(p.approved), p.partsChangedOnly])).toEqual([
      ["home", true, false],
      ["drains", false, false],
    ]);
    expect(view.pages[0]!.approved!.version).toBe(1);

    // Version 3: only the footer changed. Both pages ask again; the unchanged ones go in one click.
    await approveReviewedPage(h.ctx, pm.viewer, id, "drains");
    await build(id, 3, { home: "<section>Hero</section>", drains: "<section>Drains, now with prices</section>", parts: '{"header":"H","footer":"F2"}' });
    view = await loadPageReview(h.db, id, people);
    expect(view.pages.map((p) => [Boolean(p.approved), p.partsChangedOnly])).toEqual([
      [false, true],
      [false, true],
    ]);
    expect(await approveUnchanged(h.ctx, pm.viewer, id, people)).toBe(2);
    expect((await loadPageReview(h.db, id, people)).approvedCount).toBe(2);
    await expect(approveUnchanged(h.ctx, pm.viewer, id, people)).rejects.toBeInstanceOf(PageReviewError);
  });

  it("takes an approval back, kept for the record", async () => {
    const { pm, id, people } = await seed();
    await approveReviewedPage(h.ctx, pm.viewer, id, "home");
    await withdrawApproval(h.ctx, pm.viewer, id, "home");
    expect((await loadPageReview(h.db, id, people)).pages[0]!.approved).toBeNull();
    expect((await h.db.select().from(pageApproval))[0]!.withdrawnAt).not.toBeNull();
    await expect(withdrawApproval(h.ctx, pm.viewer, id, "home")).rejects.toThrow("isn't approved");
  });

  it("lets a founder take one version live before every page is approved, logged, and only that version", async () => {
    const { pm, founder, id, people } = await seed();
    await approveReviewedPage(h.ctx, pm.viewer, id, "home");
    await expect(overridePageReview(h.ctx, pm.viewer, id, people)).rejects.toBeInstanceOf(PermissionError);
    await overridePageReview(h.ctx, founder.viewer, id, people);
    expect(pagesChecklistItem(await loadPageReview(h.db, id, people))).toMatchObject({ ok: true, detail: "1 of 2 approved; a founder let this version go live" });
    expect((await h.db.select().from(goLive))[0]).toMatchObject({ pagesOverrideVersion: 1, pagesOverrideBy: founder.viewer.id });
    const [log] = await h.db.select().from(activityLog).where(eq(activityLog.action, "site.pages_overridden"));
    expect(log!.valueAfter).toMatchObject({ version: 1, approved: 1, pages: 2, notApproved: ["Drain cleaning"] });

    await build(id, 2, { home: "<section>Hero</section>", drains: "<section>Drains 2</section>", parts: '{"header":"H","footer":"F"}' });
    expect(pagesChecklistItem(await loadPageReview(h.db, id, people))).toMatchObject({ ok: false });
  });
});

describe("comments on a page", () => {
  it("pins a comment to a section, keeps replies in its thread, and resolves it", async () => {
    const { pm, designer, id, people } = await seed();
    const first = await addReviewComment(h.ctx, pm.viewer, {
      projectId: id,
      pageId: "drains",
      body: "Make the call button bigger",
      area: "main",
      section: 1,
      sectionLabel: "Same-day drain cleaning",
      pinX: 40,
      pinY: 25,
    });
    await addReviewComment(h.ctx, designer.viewer, { projectId: id, pageId: "drains", body: "Agreed", parentId: first, area: "main", section: 2 });
    await addReviewComment(h.ctx, pm.viewer, { projectId: id, pageId: "drains", body: "The footer phone is wrong", area: "footer", section: 4, pinX: 10, pinY: 50 });
    await addReviewComment(h.ctx, pm.viewer, { projectId: id, pageId: "drains", body: "Reads well overall" });
    await expect(addReviewComment(h.ctx, pm.viewer, { projectId: id, pageId: "drains", body: "  " })).rejects.toThrow("Write the comment first.");

    const comments = await loadPageComments(h.db, id, "drains", people);
    expect(comments.map((c) => [c.number, c.area, c.section, c.sectionLabel, c.pinX])).toEqual([
      [1, "main", 1, "Same-day drain cleaning", 40],
      // A footer pin has no section number; a general comment no pin.
      [2, "footer", null, null, 10],
      [3, null, null, null, null],
    ]);
    expect(comments[0]!.replies).toEqual([expect.objectContaining({ author: "Dana", body: "Agreed" })]);
    const reply = (await h.db.select().from(pageReviewComment).where(eq(pageReviewComment.body, "Agreed")))[0]!;
    expect(reply).toMatchObject({ area: null, section: null, pinX: null });

    expect((await loadPageReview(h.db, id, people)).pages[1]!.openComments).toBe(3);
    await setReviewCommentResolved(h.ctx, pm.viewer, id, first, true);
    await expect(setReviewCommentResolved(h.ctx, pm.viewer, id, reply.id, true)).rejects.toThrow("Resolve the comment the reply belongs to.");
    expect((await loadPageReview(h.db, id, people)).pages[1]!.openComments).toBe(2);
  });

  it("gives the review screen its place in the site and the next page to review", async () => {
    const { pm, id, people } = await seed();
    await approveReviewedPage(h.ctx, pm.viewer, id, "drains");
    const review = (await loadPageForReview(h.db, id, "drains", people))!;
    expect(review).toMatchObject({ version: 1, position: { index: 2, of: 2 }, approvedCount: 1, next: { pageId: "home", name: "Home" } });
    expect(await loadPageForReview(h.db, id, "nope", people)).toBeNull();
  });

  it("goes with the project when it is deleted", async () => {
    const { admin, pm, id } = await seed();
    await addReviewComment(h.ctx, pm.viewer, { projectId: id, pageId: "home", body: "x" });
    await approveReviewedPage(h.ctx, pm.viewer, id, "home");
    await h.db.update(projectTable).set({ status: "intake" }).where(eq(projectTable.id, id));
    await deleteProject(h.ctx, admin.viewer, id, { confirmName: "Harbor Plumbing", reason: "A test project, done with." });
    expect(await h.db.select().from(pageReviewComment)).toHaveLength(0);
    expect(await h.db.select().from(pageApproval)).toHaveLength(0);
  });
});

describe("the Review pages card", () => {
  it("lists each page, starts at the first to review, and offers a founder the way through", () => {
    const html = renderToStaticMarkup(
      <ReviewPagesCard
        projectId="p1"
        version={4}
        canReview
        canOverride
        overriddenLine={null}
        pages={[
          { pageId: "home", name: "Home", path: "/", approvedLine: "Approved by Sam on version 4, today", partsChangedOnly: false, openComments: 0 },
          { pageId: "drains", name: "Drain cleaning", path: "/drain-cleaning/", approvedLine: null, partsChangedOnly: true, openComments: 2 },
        ]}
      />,
    );
    expect(html).toContain("Version 4: 1 of 2 pages approved. Go-live waits for the rest.");
    expect(html).toContain("Approved before; only the header or footer changed since. 2 open comments");
    expect(html).toContain('href="/projects/p1/build/review/drains"');
    expect(html).toContain("Review the next page");
    expect(html).toContain("Approve all unchanged (1)");
    expect(html).toContain("Let it go live anyway");
  });
});
