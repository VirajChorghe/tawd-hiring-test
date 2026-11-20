import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Updates, the step after Go live (Jason, 30 September 2026; built
  1 October): a category and an hours estimate on every request, pages
  from the built site for every lane, quotes from the Pricing page that the
  client approves before work starts, the included hours per tier, and the
  admin-entered monthly invoice.
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
import { addonPrice, editRequest, project as projectTable, siteBuild, updateInvoice, updateQuote } from "@tawd/core/schema";
import { quoteNeed } from "@tawd/core/site";
import UpdatesPage from "@/app/(app)/projects/[id]/updates/page";
import { logDevTime, startEdit } from "@/lib/edits";
import { deleteProject } from "@/lib/project-deletion";
import { createProject } from "@/lib/projects";
import { draftInvoiceLines, includedHoursFor, invoiceCsv, loadQuotes, logUpdateRequest, monthPlan, recordQuoteAnswer, saveInvoice, setIncludedHours } from "@/lib/updates";
import { invoiceDocument, quoteDocument } from "@/lib/updates-docs";
import { pacificToday } from "@/lib/spend-report";
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

const today = pacificToday();

async function liveProject(options: { lane?: "lane_1" | "lane_2"; tier?: "starter" | "growth" | "pro" } = {}) {
  const admin = await seedAdmin(h);
  const pm = await seedUser(h, admin.viewer, { email: "priya@velocitymedialab.com", name: "Priya Nair", roles: ["pm"] });
  const lane = options.lane ?? "lane_1";
  const id = await createProject(h.ctx, admin.viewer, {
    clientName: "Oak Law Group",
    trade: "legal",
    tier: options.tier ?? "starter",
    lane,
    laneOption: lane === "lane_2" ? "a" : null,
    conceptCount: lane === "lane_2" ? null : 3,
    status: "intake",
    memberUserIds: [pm.viewer.id],
  });
  await h.db.update(projectTable).set({ status: "live", liveAt: new Date() }).where(eq(projectTable.id, id));
  await h.db.insert(siteBuild).values({
    projectId: id,
    version: 1,
    status: "done",
    fileCount: 3,
    pages: [
      { pageId: "home", name: "Home", path: "/", shotKey: null, placeholders: [] },
      { pageId: "about", name: "About", path: "/about/", shotKey: null, placeholders: [] },
    ],
  } as never);
  return { admin, pm, id };
}

const request = (over: Partial<Parameters<typeof logUpdateRequest>[3]> = {}) => ({
  clientWords: "Change our Saturday hours to 9 to 1",
  teamNote: "",
  requestedOn: today,
  category: "content",
  redesign: false,
  estimateHours: "1",
  pageIds: ["home"],
  ...over,
});

describe("when a request becomes a quote", () => {
  const base = { redesign: false, estimateMinutes: 60, usedMinutes: 0, plannedMinutes: 0, includedHours: 8 };
  it("fits the included hours: no quote", () => {
    expect(quoteNeed({ ...base, category: "content" })).toMatchObject({ quote: false, overMinutes: 0 });
  });
  it("a new page and a redesign are always quoted", () => {
    expect(quoteNeed({ ...base, category: "new_page" })).toMatchObject({ quote: true, whole: "new_page", reason: "New pages are always quoted." });
    expect(quoteNeed({ ...base, category: "design", redesign: true })).toMatchObject({ quote: true, whole: "redesign" });
    expect(quoteNeed({ ...base, category: "design" }).quote).toBe(false);
  });
  it("only the hours over the included ones are quoted", () => {
    const need = quoteNeed({ ...base, category: "technical", estimateMinutes: 180, usedMinutes: 6 * 60, plannedMinutes: 30 });
    expect(need).toMatchObject({ quote: true, overMinutes: 90, whole: null });
    expect(need.reason).toBe("This month has 1.5 of 8 included hours left: the 1.5 hours over are quoted at the hourly rate.");
  });
});

describe("logging a request", () => {
  it("needs a category and an hours estimate, and picks pages from the built site", async () => {
    const { pm, id } = await liveProject();
    await expect(logUpdateRequest(h.ctx, pm.viewer, id, request({ category: "" }))).rejects.toThrow("Choose the category.");
    await expect(logUpdateRequest(h.ctx, pm.viewer, id, request({ estimateHours: "0.3" }))).rejects.toThrow(/hours estimate/);
    await expect(logUpdateRequest(h.ctx, pm.viewer, id, request({ pageIds: [] }))).rejects.toThrow("Choose the page or pages");
    const { requestId, quoteId } = await logUpdateRequest(h.ctx, pm.viewer, id, request());
    expect(quoteId).toBeNull();
    const [row] = await h.db.select().from(editRequest).where(eq(editRequest.id, requestId));
    expect(row).toMatchObject({ kind: "edit", status: "open", category: "content", estimateMinutes: 60, pageIds: ["home"], pagePaths: ["/"] });
    expect((await monthPlan(h.db as Database, id)).plannedMinutes).toBe(60);
  });

  it("a new page becomes a quote from the Pricing page; it can't be approved until the price is set, then work can start", async () => {
    const { admin, pm, id } = await liveProject();
    // Pages still ticked in the form are ignored for a new page.
    const { requestId, quoteId } = await logUpdateRequest(h.ctx, pm.viewer, id, request({ clientWords: "A landing page for our estate-planning ads", category: "new_page", pageIds: ["home"], estimateHours: "3" }));
    expect(quoteId).not.toBeNull();
    expect((await h.db.select().from(editRequest).where(eq(editRequest.id, requestId)))[0]!.pageIds).toEqual([]);
    let [quote] = await loadQuotes(h.db as Database, id);
    expect(quote).toMatchObject({ status: "waiting", totalCents: null, lines: [{ key: "new_page", label: "New page", quantity: 1, amountCents: null }] });
    await expect(startEdit(h.ctx, admin.viewer, id, requestId)).rejects.toThrow("Waiting on the client's approval of the quote.");
    await expect(recordQuoteAnswer(h.ctx, pm.viewer, id, quoteId!, { outcome: "approved", channel: "email", clientSaid: "Go ahead" })).rejects.toThrow(/isn't set yet/);

    // An admin sets the price on Pricing: the waiting quote follows it.
    await h.db.update(addonPrice).set({ priceCents: 34_900 }).where(eq(addonPrice.key, "new_page"));
    [quote] = await loadQuotes(h.db as Database, id);
    expect(quote!.totalCents).toBe(34_900);
    expect(await quoteDocument(h.db as Database, id, quoteId!)).toContain("$349.00");

    await recordQuoteAnswer(h.ctx, pm.viewer, id, quoteId!, { outcome: "approved", channel: "email", clientSaid: "Go ahead" });
    const [row] = await h.db.select().from(editRequest).where(eq(editRequest.id, requestId));
    expect(row).toMatchObject({ kind: "edit", status: "open" });
    // The price is kept as approved, even if Pricing changes later.
    await h.db.update(addonPrice).set({ priceCents: 50_000 }).where(eq(addonPrice.key, "new_page"));
    expect((await loadQuotes(h.db as Database, id))[0]!.totalCents).toBe(34_900);
  });

  it("hours over the month's included ones are quoted at the hourly rate; declined closes the request", async () => {
    const { admin, pm, id } = await liveProject();
    await h.db.update(addonPrice).set({ priceCents: 9_500 }).where(eq(addonPrice.key, "hours_over"));
    await logDevTime(h.ctx, admin.viewer, id, { requestId: null, minutes: 7 * 60, note: "Earlier work", workedOn: today });
    const { requestId, quoteId } = await logUpdateRequest(h.ctx, pm.viewer, id, request({ category: "technical", estimateHours: "2.5" }));
    const [quote] = await loadQuotes(h.db as Database, id);
    expect(quote).toMatchObject({ id: quoteId, lines: [{ key: "hours_over", quantity: 1.5, amountCents: 14_250 }], totalCents: 14_250 });
    await recordQuoteAnswer(h.ctx, pm.viewer, id, quoteId!, { outcome: "declined", channel: "phone call", clientSaid: "Not this month" });
    const [row] = await h.db.select().from(editRequest).where(eq(editRequest.id, requestId));
    expect(row!.status).toBe("declined");
  });

  it("Lane 2 logs requests on its built pages, and is updated by hand (no AI edit yet)", async () => {
    const { admin, pm, id } = await liveProject({ lane: "lane_2" });
    const { requestId } = await logUpdateRequest(h.ctx, pm.viewer, id, request({ pageIds: ["about"] }));
    await expect(startEdit(h.ctx, admin.viewer, id, requestId)).rejects.toThrow(/updated by hand/);
  });
});

describe("the included hours per tier", () => {
  it("8 for every tier to start; admins change a tier's hours, logged", async () => {
    const { admin, pm, id } = await liveProject({ tier: "pro" });
    expect(await includedHoursFor(h.db as Database, id)).toBe(8);
    await expect(setIncludedHours(h.ctx, pm.viewer, "pro", "20")).rejects.toThrow(/Not allowed/);
    await expect(setIncludedHours(h.ctx, admin.viewer, "pro", "abc")).rejects.toThrow(/number from 0 to 200/);
    await setIncludedHours(h.ctx, admin.viewer, "pro", "20");
    expect(await includedHoursFor(h.db as Database, id)).toBe(20);
    expect((await monthPlan(h.db as Database, id)).line).toMatch(/: 0 of 20 included hours$/);
  });
});

describe("the monthly invoice", () => {
  it("starts from the month's work, is entered and saved by an admin, and downloads as a page and as CSV", async () => {
    const { admin, pm, id } = await liveProject();
    const month = today.slice(0, 7);
    const { requestId } = await logUpdateRequest(h.ctx, pm.viewer, id, request());
    await logDevTime(h.ctx, admin.viewer, id, { requestId, minutes: 45, note: "Hours changed", workedOn: today });
    const draft = await draftInvoiceLines(h.db as Database, id, month);
    expect(draft).toContainEqual({ date: today, task: "Change our Saturday hours to 9 to 1", category: "Content", hours: 0.8, amountCents: 0 });

    await expect(saveInvoice(h.ctx, pm.viewer, id, month, draft)).rejects.toThrow(/Not allowed/);
    await expect(saveInvoice(h.ctx, admin.viewer, id, month, [{ ...draft[0]!, task: "" }])).rejects.toThrow("Line 1 needs a task.");
    const lines = [...draft, { date: today, task: "Rush fix of the contact form", category: "Technical", hours: 1, amountCents: 9_500 }];
    await saveInvoice(h.ctx, admin.viewer, id, month, lines);
    const [saved] = await h.db.select().from(updateInvoice).where(eq(updateInvoice.projectId, id));
    // The monthly plan line (the package price) plus the added line.
    expect(saved!.totalCents).toBe(lines.reduce((n, l) => n + l.amountCents, 0));
    expect(draft.some((l) => l.category === "Plan")).toBe(true);

    const page = await invoiceDocument(h.db as Database, id, month);
    expect(page).toContain("Invoice: Oak Law Group");
    expect(page).toContain("Rush fix of the contact form");
    expect(page).not.toContain("AI");
    const csv = invoiceCsv("Oak Law Group", month, lines);
    expect(csv.split("\n")[0]).toBe("Client,Month,Date,Task,Category,Hours,Amount");
    expect(csv).toContain(",95.00");
    // A cell a spreadsheet would run as a formula is neutralised.
    expect(invoiceCsv("Oak", month, [{ date: today, task: "=HYPERLINK(1)", category: "x", hours: 0, amountCents: 0 }])).toContain("'=HYPERLINK(1)");
  });
});

describe("the Updates page", () => {
  const render = async (id: string) => renderToStaticMarkup((await UpdatesPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })) as React.ReactElement);

  it("is locked until the site is live", async () => {
    const { admin, id } = await liveProject();
    await h.db.update(projectTable).set({ status: "build" }).where(eq(projectTable.id, id));
    state.user = admin.viewer;
    expect(await render(id)).toContain("Updates opens when the site goes live.");
  });

  it("shows the month, the requests with their category, the quotes, and the invoice for admins only", async () => {
    const { admin, pm, id } = await liveProject();
    await logUpdateRequest(h.ctx, pm.viewer, id, request());
    await logUpdateRequest(h.ctx, pm.viewer, id, request({ clientWords: "A landing page for ads", category: "new_page", pageIds: [], estimateHours: "3" }));
    state.user = admin.viewer;
    const html = await render(id);
    expect(html).toMatch(/[A-Z][a-z]+: 0 of 8 included hours/);
    expect(html).toContain("Content</span>");
    expect(html).toContain("Estimate 1h");
    expect(html).toContain("Quote: waiting on the client");
    expect(html).toContain("Download the quote");
    expect(html).toContain("Invoice:");
    state.user = pm.viewer;
    const asPm = await render(id);
    expect(asPm).toContain("Record the client&rsquo;s answer".replace("&rsquo;", "’"));
    expect(asPm).not.toContain("Invoice:");
  });
});

describe("deleting a project", () => {
  it("removes its quotes and invoices", async () => {
    const { admin, pm, id } = await liveProject();
    // A project that has gone live is never deleted (Jason, 13 October 2026); this one is made deletable to prove the cascade.
    await h.db.update(projectTable).set({ status: "build", liveAt: null }).where(eq(projectTable.id, id));
    await logUpdateRequest(h.ctx, pm.viewer, id, request({ category: "new_page", pageIds: [] }));
    await h.db.insert(updateInvoice).values({ projectId: id, month: today.slice(0, 7), lines: [], totalCents: 0 });
    await deleteProject(h.ctx, admin.viewer, id, { confirmName: "Oak Law Group", reason: "Test project, removing it" } as never);
    expect(await h.db.select().from(updateQuote)).toHaveLength(0);
    expect(await h.db.select().from(updateInvoice)).toHaveLength(0);
  });
});
