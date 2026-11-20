import path from "node:path";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Jason's review (26 September 2026): add-ons priced on the Pricing page,
  and "Client has no logo: TAWD designs one" (a paid add-on). Claude is a
  stand-in; no AI money.
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
import { activityLog, intakeFile, logoDesign, project, projectAddon } from "@tawd/core/schema";
import { loadIntake, saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { PermissionError } from "@tawd/core/permissions";
import { LOGO_JOB } from "@tawd/core/queue";
import { LogoFormatError, readLogoReply, sanitizeLogoSvg } from "@tawd/core/mockups";
import { createProject } from "@/lib/projects";
import { setQueueForTesting } from "@/lib/mockups";
import { listAddons, loadRevenue, saveAddonPrice } from "@/lib/pricing";
import { chooseLogo, loadLogoDesign, startLogoDesign, syncLogoAddon } from "@/lib/logo-design";

import { runLogoJob } from "../../../worker/src/logo-design";
import type { WorkerConfig } from "../../../worker/src/config";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2, fakeBrowser, fakeClaude, turn } from "./worker-fakes";

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

const SVG = (n: number) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 120" width="400" height="120"><circle cx="60" cy="60" r="40" fill="#1F4E79"/><text x="120" y="75" font-family="Arial, Helvetica, sans-serif" font-size="36" fill="#1F4E79">Rio Glass ${n}</text></svg>`;

describe("a logo's SVG", () => {
  it("is accepted clean, and refused with scripts, handlers, images or outside links", () => {
    expect(sanitizeLogoSvg(SVG(1))).toBe(SVG(1));
    for (const bad of [
      SVG(1).replace("</svg>", "<script>alert(1)</script></svg>"),
      SVG(1).replace("<circle", '<circle onclick="x()"'),
      SVG(1).replace("<circle", '<image href="https://evil.example/a.png"/><circle'),
      SVG(1).replace('fill="#1F4E79"/>', 'fill="url(https://evil.example/p)"/>'),
      SVG(1).replace(' viewBox="0 0 400 120"', ""),
      "<div>not an svg</div>",
    ]) {
      expect(() => sanitizeLogoSvg(bad)).toThrow(LogoFormatError);
    }
    expect(readLogoReply(`Here:\n${SVG(1)}\n${SVG(2)}`, 2)).toHaveLength(2);
    expect(() => readLogoReply(SVG(1), 2)).toThrow("Expected 2 logos, got 1");
  });
});

describe("add-ons", () => {
  it("are priced by admins, logged, and counted with the build fee in Revenue", async () => {
    const admin = await seedAdmin(h);
    expect((await listAddons(h.db)).map((a) => a.key)).toEqual(["logo_design", "seo_audit_20", "seo_audit_40", "seo_audit_60", "seo_audit_80", "seo_audit_100", "seo_audit_quote", "domain_purchase", "extra_pages", "subdomain_site", "extra_concept", "stock_photos", "rush_delivery", "wordpress_hosting", "client_design", "hours_over", "new_page", "redesign"]);
    // Placeholders (27 September 2026): listed, with no price until an admin sets one.
    expect((await listAddons(h.db)).filter((a) => a.key === "rush_delivery" || a.key === "domain_purchase").map((a) => [a.name, a.priceCents])).toEqual([
      ["Domain purchase (registered in the client's name)", null],
      ["Rush delivery", null],
    ]);
    await saveAddonPrice(h.ctx, admin.viewer, "logo_design", "150");
    await expect(saveAddonPrice(h.ctx, admin.viewer, "seo_audit_quote", "900")).rejects.toThrow("quoted case by case");
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    await expect(saveAddonPrice(h.ctx, pm.viewer, "logo_design", "1")).rejects.toThrow(PermissionError);
    const [entry] = (await h.db.select().from(activityLog)).filter((a) => a.action === "pricing.addon_saved");
    expect(entry!.valueAfter).toMatchObject({ priceCents: 15000 });

    // Ticking "TAWD designs one" adds it at today's price; the price is kept if the list changes.
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Rio Glass", trade: "glass_and_windows", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 3, status: "intake", memberUserIds: [] });
    await saveIntakeSection(h.ctx, pm.viewer, id, "brand", { tawdDesignsLogo: true });
    await syncLogoAddon(h.ctx, pm.viewer, id);
    await syncLogoAddon(h.ctx, pm.viewer, id);
    await saveAddonPrice(h.ctx, admin.viewer, "logo_design", "175");
    const addons = await h.db.select().from(projectAddon).where(eq(projectAddon.projectId, id));
    expect(addons).toHaveLength(1);
    expect(addons[0]).toMatchObject({ addonKey: "logo_design", priceCents: 15000, removedAt: null });

    await h.db.update(project).set({ liveAt: new Date("2026-09-10T18:00:00Z") }).where(eq(project.id, id));
    const revenue = await loadRevenue(h.db, new Date("2026-09-26T18:00:00Z"));
    expect(revenue.thisMonth.buildFees).toBe(19900 + 15000);

    // Unticking takes it off (kept in the history).
    await saveIntakeSection(h.ctx, pm.viewer, id, "brand", { tawdDesignsLogo: false });
    await syncLogoAddon(h.ctx, pm.viewer, id);
    expect((await h.db.select().from(projectAddon).where(eq(projectAddon.projectId, id)))[0]!.removedAt).toBeInstanceOf(Date);
  });
});

describe("the logo TAWD designs", () => {
  it("waits for the tick box, designs the tier's number of options, and the chosen one becomes the intake's logo", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Rio Glass", trade: "glass_and_windows", tier: "growth", lane: "lane_1", laneOption: null, conceptCount: 3, status: "intake", memberUserIds: [] });
    await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Rio Glass" });
    await expect(startLogoDesign(h.ctx, admin.viewer, id)).rejects.toThrow("Client has no logo");
    await saveIntakeSection(h.ctx, admin.viewer, id, "brand", { tawdDesignsLogo: true, colors: ["#1F4E79"] });

    await startLogoDesign(h.ctx, admin.viewer, id);
    expect(queued[0]!.name).toBe(LOGO_JOB);
    let prompt = "";
    const claude = fakeClaude(() => [], {
      builder: (params) => {
        prompt = String((params.messages as { content: string }[])[0]!.content);
        return turn(`${SVG(1)}\n${SVG(2)}`, "end_turn");
      },
    });
    await runLogoJob(queued[0]!.data, config, claude.client as never, fakeBrowser());
    expect(prompt).toContain("Design 2 different logo options");
    expect(prompt).toContain("Brand colours: #1F4E79");

    const [design] = await h.db.select().from(logoDesign).where(eq(logoDesign.projectId, id));
    expect(design).toMatchObject({ status: "done", optionCount: 2 });
    const options = design!.options as { svgKey: string; pngKey: string }[];
    expect(options.every((o) => r2.objects.has(o.svgKey) && r2.objects.has(o.pngKey))).toBe(true);

    await chooseLogo(h.ctx, admin.viewer, id, design!.id, 1);
    let logos = await h.db.select().from(intakeFile).where(eq(intakeFile.projectId, id));
    expect(logos).toHaveLength(1);
    expect(logos[0]).toMatchObject({ kind: "logo", contentType: "image/svg+xml", fileName: "Logo by TAWD (option 2).svg" });
    expect((await loadIntake(h.db, admin.viewer, id))!.completeness.missing.map((m) => m.key)).not.toContain("brand.logo");

    // Choosing again replaces it, never adds a second.
    await chooseLogo(h.ctx, admin.viewer, id, design!.id, 0);
    logos = await h.db.select().from(intakeFile).where(eq(intakeFile.projectId, id));
    expect(logos.map((l) => l.fileName)).toEqual(["Logo by TAWD (option 1).svg"]);
    expect((await loadLogoDesign(h.db, id)).chosenIndex).toBe(0);
  });

  it("shows on the Brand section and the Pricing page", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Rio Glass", trade: "glass_and_windows", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 3, status: "intake", memberUserIds: [] });
    await saveIntakeSection(h.ctx, admin.viewer, id, "brand", { tawdDesignsLogo: true });
    state.user = admin.viewer;
    const { default: IntakePage } = await import("@/app/(app)/projects/[id]/intake/page");
    const brand = renderToStaticMarkup(await IntakePage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ section: "brand" }) }));
    expect(brand).toContain("Client has no logo: TAWD designs one");
    expect(brand).toContain("Design the logo");
    expect(brand).toContain("one option");
    const { default: PricingPage } = await import("@/app/(app)/admin/pricing/page");
    const pricing = renderToStaticMarkup(await PricingPage());
    expect(pricing).toContain("Add-ons");
    expect(pricing).toContain("Full SEO audit, over 100 pages");
    expect(pricing).toContain("Quoted case by case");
    for (const name of ["Domain purchase (registered in the client&#x27;s name)", "Extra pages", "Subdomain site or ad landing page", "Extra design concept", "Licensed stock photos", "Rush delivery"]) expect(pricing).toContain(name);
  });
});
