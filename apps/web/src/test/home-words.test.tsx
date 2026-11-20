import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Content first, part 2 (Jason, 30 September 2026; built 1 October): the
  home page's words before the concepts, in Lane 1. From the current site or
  the client's copy ($0), or written by one AI call for a new site
  (estimate first; a stand-in here). Facts that differ from the intake are
  flagged; old-site testimonials stay [PLACEHOLDER]s until confirmed;
  Generate waits until the team uses the words, and the concepts carry
  them.
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
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { checkHomeWordsFacts, homeWordsBlock, readHomeWordsReply, wordsFromClientCopy, wordsFromCurrentSite } from "@tawd/core/mockups";
import { HOME_WORDS_JOB } from "@tawd/core/queue";
import { aiCall, homeWords, project as projectTable, siteImport } from "@tawd/core/schema";
import MockupsPage from "@/app/(app)/projects/[id]/mockups/page";
import { approveHomeWords, loadHomeWords, startHomeWords, writeHomeWords } from "@/lib/home-words";
import { planRun, setQueueForTesting, startRun } from "@/lib/mockups";
import { deleteProject } from "@/lib/project-deletion";
import { createProject } from "@/lib/projects";
import type { WorkerConfig } from "../../../worker/src/config";
import { runHomeWordsJob } from "../../../worker/src/home-words";
import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2, fakeClaude, turn } from "./worker-fakes";

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
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

const config: WorkerConfig = { databaseUrl: "unused", redisUrl: "unused", anthropicApiKey: "unused", model: "claude-opus-5-5", skillsDir: path.resolve(__dirname, "../../../../skills"), effort: "high" };

const SITE = {
  title: "Rio Glass",
  menu: [{ label: "Home", href: "/" }, { label: "Shower doors", href: "/showers" }],
  sections: [
    { kind: "hero" as const, heading: "Sacramento glass specialists since 1998", words: "Sacramento glass specialists since 1998. Call (916) 555-0199." },
    { kind: "services" as const, heading: "", words: "Shower doors. Mirrors. Windows." },
    { kind: "reviews" as const, heading: "What customers say", words: '"They fixed our storefront the same day."' },
  ],
  phones: ["(916) 555-0199"],
  testimonials: ["They fixed our storefront the same day."],
};

/* "site": content provided by the client, but no copy yet, so the words start from the current site (a makeover, "keep", uses Content: keep-current-site.test). */
async function seed(mode: "site" | "manual" | "auto" = "site") {
  const admin = await seedAdmin(h);
  state.user = admin.viewer;
  const id = await createProject(h.ctx, admin.viewer, { clientName: "Rio Glass", trade: "glass_and_windows", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 1, status: "intake", memberUserIds: [] });
  await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Rio Glass", phone: "916-555-0147", yearFounded: 2001, state: "CA" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "services", { items: [{ id: "s1", name: "Shower doors", description: "" }], mainServiceId: "s1" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "serviceAreas", { scope: "cities", cities: ["Sacramento"] });
  await saveIntakeSection(h.ctx, admin.viewer, id, "website", { currentWebsiteUrl: "https://rioglass.example" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "content", { mode: mode === "site" ? "manual" : mode, suppliedCopy: mode === "manual" ? "Welcome\nWe install shower doors.\n\nOur services\nMirrors and windows." : "" });
  await h.db.insert(siteImport).values({ projectId: id, url: "https://rioglass.example", status: "done", pageLimit: 10, home: SITE, homeReadAt: new Date() });
  await h.db.update(projectTable).set({ status: "mockups" }).where(eq(projectTable.id, id));
  return { admin, id };
}

describe("the words, by code", () => {
  it("from the current site: the menu, its sections, the reviews kept apart to confirm", () => {
    const words = wordsFromCurrentSite(SITE);
    expect(words.sections.map((s) => s.name)).toEqual(["Menu", "Sacramento glass specialists since 1998", "Services"]);
    expect(words.testimonials).toEqual([{ text: "They fixed our storefront the same day.", confirmed: false }]);
  });

  it("from the client's copy, split at its headings", () => {
    expect(wordsFromClientCopy("Welcome\nWe install shower doors.\n\nOur services\nMirrors and windows.").sections).toEqual([
      { name: "Welcome", words: "We install shower doors." },
      { name: "Our services", words: "Mirrors and windows." },
    ]);
  });

  it("flags a phone or a founding year that differs from the intake: the intake wins", () => {
    const flags = checkHomeWordsFacts(wordsFromCurrentSite(SITE).sections, { phone: "916-555-0147", yearFounded: 2001 });
    expect(flags[1]).toContain("Phone (916) 555-0199 differs from the intake (916-555-0147): the intake wins.");
    expect(flags[1]).toContain("Founded 1998 differs from the intake (2001)");
    expect(flags[2]).toBeNull();
  });

  it("the concept prompt carries the words; an unconfirmed testimonial only as a placeholder", () => {
    const block = homeWordsBlock({ source: "current_site", sections: [{ name: "Hero", words: "Glass done right." }], testimonials: [{ text: "Great crew.", confirmed: false }, { text: "Same-day fix.", confirmed: true }] });
    expect(block).toContain("## Hero\nGlass done right.");
    expect(block).toContain('- "Same-day fix."');
    expect(block).not.toContain("Great crew.");
    expect(block).toContain("[PLACEHOLDER: a testimonial to confirm with the client]");
  });

  it("reads the AI's reply, and refuses one it can't use", () => {
    expect(readHomeWordsReply('Here: {"sections":[{"name":"Hero","words":"Glass done right."}]}')).toEqual([{ name: "Hero", words: "Glass done right." }]);
    expect(() => readHomeWordsReply("no json")).toThrow();
  });
});

describe("before Generate", () => {
  it("Generate waits until the words are used; then the run goes", async () => {
    const { admin, id } = await seed("site");
    const plan = await planRun(admin.viewer, id, 1);
    expect(plan.wordsBlocked).toMatch(/Use the Home page words first/);
    await expect(startRun(h.ctx, admin.viewer, { projectId: id, concepts: plan.plan.concepts.slice(0, 1) })).rejects.toThrow(/Home page words/);

    await startHomeWords(h.ctx, admin.viewer, id, "current_site");
    const panel = await loadHomeWords(h.db as Database, id);
    expect(panel).toMatchObject({ applies: true, suggested: "current_site", words: { source: "current_site", approved: null } });
    await approveHomeWords(h.ctx, admin.viewer, id, { sections: panel.words!.sections.map(({ name, words }) => ({ name, words })), testimonials: panel.words!.testimonials });
    expect((await planRun(admin.viewer, id, 1)).wordsBlocked).toBeNull();
    // Generate pressed twice at once starts one paid run; a run still queued counts (13 October 2026).
    const both = await Promise.allSettled([startRun(h.ctx, admin.viewer, { projectId: id, concepts: plan.plan.concepts.slice(0, 1) }), startRun(h.ctx, admin.viewer, { projectId: id, concepts: plan.plan.concepts.slice(0, 1) })]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(startRun(h.ctx, admin.viewer, { projectId: id, concepts: plan.plan.concepts.slice(0, 1) })).rejects.toThrow("This project already has concepts generating.");
    expect(queued.filter((q) => q.name !== HOME_WORDS_JOB)).toHaveLength(1);
  });

  it("the client's copy is the start for Content provided by the client", async () => {
    const { admin, id } = await seed("manual");
    expect((await loadHomeWords(h.db as Database, id)).suggested).toBe("client_copy");
    await startHomeWords(h.ctx, admin.viewer, id, "client_copy");
    expect((await loadHomeWords(h.db as Database, id)).words!.sections.map((s) => s.name)).toEqual(["Welcome", "Our services"]);
  });

  it("a new site: TAWD writes them in one call (a stand-in here), recorded on the ledger, then the team uses them", async () => {
    const { admin, id } = await seed("auto");
    expect((await loadHomeWords(h.db as Database, id)).suggested).toBe("tawd");
    await writeHomeWords(h.ctx, admin.viewer, id);
    expect(queued.map((q) => q.name)).toEqual([HOME_WORDS_JOB]);
    const prompts: string[] = [];
    const claude = fakeClaude(() => [], {
      builder: (params) => {
        prompts.push(JSON.stringify(params.messages));
        return turn('{"sections":[{"name":"Hero","words":"Glass and mirrors in Sacramento. [PLACEHOLDER: years in business]"},{"name":"Contact","words":"Call 916-555-0147."}]}', "end_turn");
      },
    });
    await runHomeWordsJob(queued[0]!.data as never, config, claude.client as never);
    expect(prompts[0]).toContain("Rio Glass");
    expect(prompts[0]).toContain("Sacramento glass specialists since 1998");
    const panel = await loadHomeWords(h.db as Database, id);
    expect(panel.words).toMatchObject({ source: "tawd", writing: false });
    expect(panel.words!.sections.map((s) => s.name)).toEqual(["Menu", "Hero", "Contact"]);
    expect(await h.db.select().from(aiCall).where(eq(aiCall.step, "home_words"))).toHaveLength(1);
  });

  it("the Design page shows the card, and the Generate banner", async () => {
    const { id } = await seed("site");
    const html = renderToStaticMarkup((await MockupsPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })) as React.ReactElement);
    expect(html).toContain("Home page words");
    expect(html).toContain("Start from the current site (free)");
    expect(html).toContain("Use the Home page words first");
  });

  it("Lane 2 doesn't use them", async () => {
    const { id } = await seed("site");
    await h.db.update(projectTable).set({ lane: "lane_2", laneOption: "a" }).where(eq(projectTable.id, id));
    expect((await loadHomeWords(h.db as Database, id)).applies).toBe(false);
  });

  it("deleting the project removes its words", async () => {
    const { admin, id } = await seed("site");
    await startHomeWords(h.ctx, admin.viewer, id, "current_site");
    await h.db.update(projectTable).set({ status: "build" }).where(eq(projectTable.id, id));
    await deleteProject(h.ctx, admin.viewer, id, { confirmName: "Rio Glass", reason: "Test project, removing it" } as never);
    expect(await h.db.select().from(homeWords)).toHaveLength(0);
  });
});
