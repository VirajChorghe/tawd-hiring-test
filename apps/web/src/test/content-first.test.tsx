import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Content first, part 1 (Jason, 30 September 2026; built 1 October): the
  current website is required, or "No current website available" ticked,
  and nothing can skip it: not "Continue without these", not Generate.
  With an address, the worker reads the home page ($0, no AI). The Content
  section has three choices.
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
import { assessCompleteness, blockingMissing, emptyIntake, evaluateGate } from "@tawd/core/intake";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { summarizeCurrentSite, describeCurrentSite } from "@tawd/core/mockups";
import { SITE_READ_JOB } from "@tawd/core/queue";
import { project as projectTable } from "@tawd/core/schema";
import IntakePage from "@/app/(app)/projects/[id]/intake/page";
import { loadSiteRead, readSiteAgain, syncSiteRead } from "@/lib/site-read";
import { planRun, setQueueForTesting, startRun } from "@/lib/mockups";
import { createProject, updateProject } from "@/lib/projects";
import { setLookupForTesting } from "../../../worker/src/liked-sites";
import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

let h: Harness;
let queued: { name: string; data: unknown }[];
beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setStorageForTesting(new FakeR2());
  queued = [];
  setQueueForTesting({ add: async (name, data) => void queued.push({ name, data }), getJob: async () => null });
});
afterEach(async () => {
  state.user = null;
  setQueueForTesting(null);
  setLookupForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

const lane1 = { clientName: "Dave Riccio Plumbing", trade: "plumbing", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 3, status: "intake", memberUserIds: [] as string[] } as const;

async function seed() {
  const admin = await seedAdmin(h);
  state.user = admin.viewer;
  const id = await createProject(h.ctx, admin.viewer, lane1);
  await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Dave Riccio Plumbing", phone: "916-555-0100", state: "CA" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "services", { items: [{ id: "s1", name: "Drain cleaning", description: "" }], mainServiceId: "s1" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "serviceAreas", { scope: "cities", cities: ["Sacramento"] });
  return { admin, id };
}

describe("the current website is required, and nothing skips it", () => {
  it("is a blocking requirement until there's an address or the box is ticked", () => {
    const blank = assessCompleteness({ projectTrade: "plumbing", intake: emptyIntake(), files: [] });
    expect(blockingMissing(blank).map((m) => m.key)).toEqual(["website.current"]);
    const ticked = emptyIntake();
    ticked.website.noCurrentWebsite = true;
    expect(blockingMissing(assessCompleteness({ projectTrade: "plumbing", intake: ticked, files: [] }))).toEqual([]);
  });

  it('"Continue without these" can\'t skip it', () => {
    const completeness = assessCompleteness({ projectTrade: "plumbing", intake: emptyIntake(), files: [] });
    const decision = evaluateGate({ from: "intake", to: "mockups", completeness, continueWithoutMissing: true });
    expect(decision).toMatchObject({ allowed: false, reason: "blocked" });
  });

  it("Move to Design is refused on the server, and Generate too, for a project already at Design", async () => {
    const { admin, id } = await seed();
    await expect(updateProject(h.ctx, admin.viewer, id, { ...lane1, status: "mockups" } as never, { continueWithoutMissing: true })).rejects.toThrow(/current website/);
    // A project already at Design (from before the rule): no paid run until the website is answered.
    await h.db.update(projectTable).set({ status: "mockups" }).where(eq(projectTable.id, id));
    const plan = await planRun(admin.viewer, id, 1);
    expect(plan.websiteBlocked).toMatch(/^Finish the intake first: Current website, or No current website./);
    await expect(startRun(h.ctx, admin.viewer, { projectId: id, concepts: plan.plan.concepts.slice(0, 1) })).rejects.toThrow(/current website/);
    expect(queued).toHaveLength(0);

    await saveIntakeSection(h.ctx, admin.viewer, id, "website", { noCurrentWebsite: true });
    expect((await planRun(admin.viewer, id, 1)).websiteBlocked).toBeNull();
  });

  it("the intake shows the field as required with the tick box, and Move to Design disabled", async () => {
    const { id } = await seed();
    const html = renderToStaticMarkup((await IntakePage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ section: "website" }) } as never)) as React.ReactElement);
    expect(html).toContain("No current website available");
    expect(html).toContain("Add the current website, or tick No current website");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Move to Design<\/button>/);
  });
});

describe("reading the current website ($0, no AI)", () => {
  it("summarises the menu, the sections, the phone and the testimonials", () => {
    const result = summarizeCurrentSite({
      title: "Rio Glass | Sacramento",
      menu: [{ label: "Skip to Main Content", href: "#main" }, { label: "Home", href: "/" }, { label: "/Sites/_Assets/images/brand-logo", href: "/" }, { label: "Shower doors", href: "/showers" }, { label: "Heating / Cooling", href: "/hvac" }, { label: "home", href: "/" }, { label: "Contact", href: "/contact" }],
      bands: [
        { tag: "header", heading: "", text: "Call (916) 555-0147", images: 1, cards: 0, hasForm: false, height: 90 },
        { tag: "section", heading: "Sacramento's glass specialists since 1998", text: "Sacramento's glass specialists since 1998. Custom shower doors and mirrors.", images: 1, cards: 0, hasForm: false, height: 600 },
        { tag: "section", heading: "What our customers say", text: 'Reviews "They fixed our storefront the same day, great crew." M. Ortiz', images: 0, cards: 0, hasForm: false, height: 300 },
      ],
    });
    expect(result.menu.map((m) => m.label)).toEqual(["Home", "Shower doors", "Heating / Cooling", "Contact"]);
    expect(result.phones).toEqual(["(916) 555-0147"]);
    expect(result.testimonials).toEqual(["They fixed our storefront the same day, great crew."]);
    expect(describeCurrentSite(result)).toContain("a menu of 4 links (Home, Shower doors, Heating / Cooling, Contact)");
  });

  it("queues one read when the website is saved; the same site at another spelling isn't read again; another site is; the box removes it", async () => {
    const { admin, id } = await seed();
    await saveIntakeSection(h.ctx, admin.viewer, id, "website", { currentWebsiteUrl: "https://rioglass.example" });
    await syncSiteRead(h.ctx, id);
    expect(queued.map((q) => q.name)).toEqual([SITE_READ_JOB]);
    expect((await loadSiteRead(h.db as Database, id)).read?.status).toBe("queued");
    await syncSiteRead(h.ctx, id);
    expect(queued).toHaveLength(1);
    // http, www and a trailing slash are the same site: the row follows the address, no new read.
    await saveIntakeSection(h.ctx, admin.viewer, id, "website", { currentWebsiteUrl: "http://www.rioglass.example/" });
    await syncSiteRead(h.ctx, id);
    expect(queued).toHaveLength(1);
    expect((await loadSiteRead(h.db as Database, id)).read?.url).toBe("http://www.rioglass.example/");
    await saveIntakeSection(h.ctx, admin.viewer, id, "website", { currentWebsiteUrl: "https://rio-glass.example" });
    await syncSiteRead(h.ctx, id);
    expect(queued).toHaveLength(2);
    await saveIntakeSection(h.ctx, admin.viewer, id, "website", { noCurrentWebsite: true, currentWebsiteUrl: "https://rio-glass.example" });
    await syncSiteRead(h.ctx, id);
    expect((await loadSiteRead(h.db as Database, id)).read).toBeNull();
  });

  it("Read again is refused while the site is being read, and queues a fresh read after", async () => {
    const { admin, id } = await seed();
    await saveIntakeSection(h.ctx, admin.viewer, id, "website", { currentWebsiteUrl: "https://rioglass.example" });
    await syncSiteRead(h.ctx, id);
    await expect(readSiteAgain(h.ctx, admin.viewer, id)).rejects.toThrow(/being read now/);
    setLookupForTesting(async () => ["93.184.216.34"]);
  });
});

describe("the three content choices", () => {
  it("saves Design only (keep), and the intake offers it only with a current website (0.100.0: the project type)", async () => {
    const { admin, id } = await seed();
    await saveIntakeSection(h.ctx, admin.viewer, id, "content", { mode: "keep" });
    const render = async () => renderToStaticMarkup((await IntakePage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ section: "content" }) } as never)) as React.ReactElement);
    let html = await render();
    // No current website: Everything new or the client's words only.
    expect(html).not.toContain("Design only");
    expect(html).toContain("The client is sending their own words");
    expect(html).toContain("Everything new");
    await saveIntakeSection(h.ctx, admin.viewer, id, "website", { currentWebsiteUrl: "https://rioglass.example" });
    html = await render();
    expect(html).not.toContain("Coming next");
    expect(html).toContain("Design only");
    expect(html).toContain("Design + content");
    expect(html).toContain("TAWD reads every page of the current site by code");
  });
});
