import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  Pricing and revenue (26 September 2026, overnight), admins only: the
  price list, each project's own price copied on the day it was created,
  going Live counting as paid, Cancelled with a date, and the Revenue view.
  No card or payment data anywhere.
*/

const state: { user: unknown } = { user: null };
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/admin/revenue",
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("@/lib/session", () => ({ requireUser: async () => state.user }));

import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, packagePrice, project, goLive } from "@tawd/core/schema";
import { PermissionError } from "@tawd/core/permissions";
import {
  PricingError,
  formatMoney,
  lastMonths,
  listPackages,
  loadProjectMoney,
  loadRevenue,
  monthOf,
  parseMoney,
  revenueByMonth,
  savePackage,
  setProjectCancelled,
  setProjectPrice,
  type RevenueProject,
} from "@/lib/pricing";
import { createProject, updateProject } from "@/lib/projects";
import { describeChanges } from "@/lib/timeline-text";
import { ProjectMoney } from "@/components/money/project-money";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
});

const lane1 = {
  clientName: "Sacramento Drain Pros",
  trade: "plumbing" as const,
  tier: "starter" as const,
  lane: "lane_1" as const,
  laneOption: null,
  conceptCount: 3,
  status: "intake" as const,
  memberUserIds: [] as string[],
};

describe("money in and out of text", () => {
  it("reads dollars as whole cents and refuses anything else", () => {
    expect(parseMoney("199")).toBe(19900);
    expect(parseMoney("$1,250.50")).toBe(125050);
    expect(parseMoney(" 99.5 ")).toBe(9950);
    expect(parseMoney("")).toBeNull();
    expect(() => parseMoney("ninety")).toThrow(PricingError);
    expect(() => parseMoney("-5")).toThrow(PricingError);
    expect(() => parseMoney("1.234")).toThrow(PricingError);
  });

  it("shows cents only when there are some", () => {
    expect(formatMoney(19900)).toBe("$199");
    expect(formatMoney(125050)).toBe("$1,250.50");
    expect(formatMoney(null)).toBe("Not set");
  });
});

describe("the revenue rules", () => {
  const live = (id: string, liveAt: string, cancelledOn: string | null = null): RevenueProject => ({
    id,
    clientName: id,
    packageKey: "starter",
    buildFeeCents: 19900,
    monthlyFeeCents: 9900,
    liveAt: new Date(liveAt),
    cancelledOn,
  });

  it("counts the build fee in the live month and the monthly fee from then through the cancellation month", () => {
    const rows = revenueByMonth(
      [live("a", "2026-08-10T18:00:00Z"), live("b", "2026-09-05T18:00:00Z", "2026-10-15"), { ...live("c", "2026-09-01T18:00:00Z"), liveAt: null }],
      ["2026-07", "2026-08", "2026-09", "2026-10", "2026-11"],
    );
    expect(rows.map((r) => [r.month, r.buildFees, r.monthlyFees, r.liveClients])).toEqual([
      ["2026-07", 0, 0, 0],
      ["2026-08", 19900, 9900, 1],
      ["2026-09", 19900, 19800, 2],
      ["2026-10", 0, 19800, 2],
      ["2026-11", 0, 9900, 1],
    ]);
    expect(rows[2]!.total).toBe(39700);
  });

  it("uses the team's time zone for the month a site went live", () => {
    // 1 October 03:00 UTC is still 30 September in California.
    expect(monthOf(new Date("2026-10-01T03:00:00Z"))).toBe("2026-09");
  });

  it("lists the last twelve months, oldest first, across a year end", () => {
    const months = lastMonths(new Date("2027-02-10T18:00:00Z"));
    expect(months).toHaveLength(12);
    expect(months[0]).toBe("2026-03");
    expect(months.at(-1)).toBe("2027-02");
  });
});

describe("the price list", () => {
  it("starts with Starter at $199 and $99 a month, Growth and Pro blank", async () => {
    const packages = await listPackages(h.db);
    expect(packages).toEqual([
      { key: "starter", name: "Starter", buildFeeCents: 19900, monthlyFeeCents: 9900 },
      { key: "growth", name: "Growth", buildFeeCents: null, monthlyFeeCents: null },
      { key: "pro", name: "Pro", buildFeeCents: null, monthlyFeeCents: null },
    ]);
  });

  it("lets admins change and add packages, logging each change, and nobody else", async () => {
    const admin = await seedAdmin(h);
    await savePackage(h.ctx, admin.viewer, { key: "growth", name: "Growth", buildFee: "499", monthlyFee: "149" });
    const key = await savePackage(h.ctx, admin.viewer, { key: null, name: "Pro Plus", buildFee: "1,500", monthlyFee: "" });
    expect(key).toBe("pro-plus");
    // Saving with nothing changed logs nothing.
    await savePackage(h.ctx, admin.viewer, { key: "growth", name: "Growth", buildFee: "499.00", monthlyFee: "149" });

    const packages = await listPackages(h.db);
    expect(packages.find((p) => p.key === "growth")).toMatchObject({ buildFeeCents: 49900, monthlyFeeCents: 14900 });
    expect(packages.at(-1)).toEqual({ key: "pro-plus", name: "Pro Plus", buildFeeCents: 150000, monthlyFeeCents: null });

    const log = await h.db.select().from(activityLog).where(eq(activityLog.action, "pricing.package_saved"));
    expect(log).toHaveLength(2);
    expect(log[0]!.valueBefore).toEqual({ name: "Growth", buildFeeCents: null, monthlyFeeCents: null });
    expect(describeChanges(log[0]!.action, log[0]!.valueBefore, log[0]!.valueAfter, new Map()).join(" ")).toContain("Growth: build fee $499, monthly $149");

    await expect(savePackage(h.ctx, admin.viewer, { key: null, name: "growth", buildFee: "1", monthlyFee: "1" })).rejects.toThrow(
      "already a package called",
    );
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    await expect(savePackage(h.ctx, pm.viewer, { key: "starter", name: "Starter", buildFee: "1", monthlyFee: "1" })).rejects.toThrow(
      PermissionError,
    );
  });
});

describe("a project's own price", () => {
  it("is copied from the price list on the day it is created and kept", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, lane1);
    await savePackage(h.ctx, admin.viewer, { key: "starter", name: "Starter", buildFee: "249", monthlyFee: "119" });

    const [row] = await h.db.select().from(project).where(eq(project.id, id));
    expect(row).toMatchObject({ packageKey: "starter", buildFeeCents: 19900, monthlyFeeCents: 9900, liveAt: null });

    const growth = await createProject(h.ctx, admin.viewer, { ...lane1, tier: "growth" });
    const [g] = await h.db.select().from(project).where(eq(project.id, growth));
    expect(g).toMatchObject({ packageKey: "growth", buildFeeCents: null, monthlyFeeCents: null });
  });

  it("changes for one project only with a reason, logged", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, lane1);
    await expect(
      setProjectPrice(h.ctx, admin.viewer, id, { packageKey: "starter", buildFee: "0", monthlyFee: "99", reason: "" }),
    ).rejects.toThrow("Say why");
    await setProjectPrice(h.ctx, admin.viewer, id, { packageKey: "starter", buildFee: "0", monthlyFee: "99", reason: "Build fee waived for a referral" });

    const money = await loadProjectMoney(h.db, id);
    expect(money).toMatchObject({ packageName: "Starter", buildFeeCents: 0, monthlyFeeCents: 9900 });
    const [entry] = await h.db.select().from(activityLog).where(eq(activityLog.action, "project.price_changed"));
    expect(entry!.valueBefore).toEqual({ packageKey: "starter", buildFeeCents: 19900, monthlyFeeCents: 9900 });
    expect(describeChanges(entry!.action, entry!.valueBefore, entry!.valueAfter, new Map()).join(" ")).toContain("Why: Build fee waived for a referral");
    const [listed] = await h.db.select().from(packagePrice).where(eq(packagePrice.key, "starter"));
    expect(listed!.buildFeeCents).toBe(19900);
  });

  it("records the day it went live, once", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { ...lane1, status: "mockups" });
    // Since Phase 9 a project becomes Live through Go live, which records the go-live first.
    await h.db.insert(goLive).values({ projectId: id, wentLiveAt: new Date() });
    await updateProject(h.ctx, admin.viewer, id, { ...lane1, status: "live" });
    const [first] = await h.db.select().from(project).where(eq(project.id, id));
    expect(first!.liveAt).toBeInstanceOf(Date);

    await updateProject(h.ctx, admin.viewer, id, { ...lane1, status: "paused" });
    await updateProject(h.ctx, admin.viewer, id, { ...lane1, status: "live" });
    const [again] = await h.db.select().from(project).where(eq(project.id, id));
    expect(again!.liveAt!.getTime()).toBe(first!.liveAt!.getTime());
  });

  it("can be marked cancelled on a date and undone, both logged", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, lane1);
    await setProjectCancelled(h.ctx, admin.viewer, id, { on: "2026-10-15", reason: "Closed the business" });
    expect(await loadProjectMoney(h.db, id)).toMatchObject({ cancelledOn: "2026-10-15", cancelReason: "Closed the business" });
    await setProjectCancelled(h.ctx, admin.viewer, id, null);
    expect(await loadProjectMoney(h.db, id)).toMatchObject({ cancelledOn: null, cancelReason: null });

    const actions = (await h.db.select().from(activityLog)).map((e) => e.action);
    expect(actions).toContain("project.cancelled");
    expect(actions).toContain("project.cancellation_undone");
  });
});

describe("the Revenue view", () => {
  it("adds up live clients, flags the unpriced and the cancelled early", async () => {
    const admin = await seedAdmin(h);
    const a = await createProject(h.ctx, admin.viewer, { ...lane1, clientName: "Example Wells" });
    const b = await createProject(h.ctx, admin.viewer, { ...lane1, clientName: "Rio Glass", tier: "growth" });
    await createProject(h.ctx, admin.viewer, { ...lane1, clientName: "Not Live Yet" });
    await h.db.update(project).set({ liveAt: new Date("2026-08-10T18:00:00Z") }).where(eq(project.id, a));
    await h.db.update(project).set({ liveAt: new Date("2026-09-02T18:00:00Z"), cancelledOn: "2026-09-20" }).where(eq(project.id, b));

    const report = await loadRevenue(h.db, new Date("2026-09-26T18:00:00Z"));
    expect(report.thisMonth).toMatchObject({ month: "2026-09", buildFees: 0, monthlyFees: 9900, liveClients: 2 });
    expect(report.clients.map((x) => [x.clientName, x.state, x.monthsLive, x.underMinimum])).toEqual([
      ["Example Wells", "active", 2, false],
      ["Rio Glass", "cancelled", 1, true],
    ]);
    expect(report.unpriced).toEqual(["Rio Glass"]);
  });

  it("renders for admins and sends everyone else away", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { ...lane1, clientName: "Example Wells" });
    await h.db.update(project).set({ liveAt: new Date() }).where(eq(project.id, id));
    const { default: RevenuePage } = await import("@/app/(app)/admin/revenue/page");
    const { default: PricingPage } = await import("@/app/(app)/admin/pricing/page");

    state.user = admin.viewer;
    const revenue = renderToStaticMarkup(await RevenuePage());
    expect(revenue).toContain("Monthly revenue");
    expect(revenue).toContain("Example Wells");
    expect(revenue).toContain("$99");
    const pricing = renderToStaticMarkup(await PricingPage());
    expect(pricing).toContain("Starter");
    expect(pricing).toContain("$199");
    expect(pricing).toContain("Add a package");

    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    state.user = pm.viewer;
    await expect(RevenuePage()).rejects.toThrow("redirect /projects");
    await expect(PricingPage()).rejects.toThrow("redirect /projects");
  });

  it("shows a project's price panel with no card or payment fields", () => {
    const html = renderToStaticMarkup(
      <ProjectMoney
        projectId="p1"
        packageKey="starter"
        packageName="Starter"
        buildFee="199"
        monthlyFee="99"
        buildFeeText="$199"
        monthlyFeeText="$99"
        liveOn={null}
        cancelledOn={null}
        cancelledOnText={null}
        cancelReason={null}
        packages={[{ key: "starter", name: "Starter", buildFee: "199", monthlyFee: "99" }]}
        today="2026-09-26"
      />,
    );
    expect(html).toContain("Price and billing");
    expect(html).toContain("Not live yet");
    expect(html).toContain("Change price");
    expect(html).not.toMatch(/card number|cvc|expiry/i);
  });
});
