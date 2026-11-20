import { and, eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Build B, 4b1 (27 September 2026): where the site lives (PMs and admins,
  logged, locked once live), the monthly WordPress hosting add-on for a
  project that isn't Pro (unpriced until an admin sets it), monthly add-ons
  in Revenue, Netlify's go-live closed to a WordPress project, and the
  client's block theme made without AI.
*/

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
vi.mock("@/app/actions", () => {
  const f = async () => ({ ok: true });
  return new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : f), has: () => true });
});

import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, project, projectAddon } from "@tawd/core/schema";
import { PermissionError } from "@tawd/core/permissions";
import { goLiveGate, readDesign, themeSlug, wordpressTheme } from "@tawd/core/site";
import { createProject } from "@/lib/projects";
import { HostingError, loadHosting, setHosting } from "@/lib/hosting";
import { listAddons, loadProjectMoney, revenueByMonth, saveAddonPrice } from "@/lib/pricing";
import { HostingCard } from "@/components/build/hosting-card";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
});

afterEach(async () => {
  setDbForTesting(null);
  await h.close();
});

const base = { trade: "pest_control" as const, lane: "lane_1" as const, laneOption: null, conceptCount: 1, status: "build" as const, memberUserIds: [] as string[] };

describe("hosting", () => {
  it("is changed by PMs and admins, logged; a project that isn't Pro gets the monthly WordPress hosting add-on, and loses it going back", async () => {
    const admin = await seedAdmin(h);
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    const content = await seedUser(h, admin.viewer, { email: "content@velocitymedialab.com", roles: ["content"] });
    const id = await createProject(h.ctx, admin.viewer, { ...base, clientName: "Harbor Pest Control", tier: "growth" });

    expect((await loadHosting(h.db, id))!.hosting).toBe("netlify");
    await expect(setHosting(h.ctx, content.viewer, id, "wordpress")).rejects.toBeInstanceOf(PermissionError);

    await setHosting(h.ctx, pm.viewer, id, "wordpress");
    let view = (await loadHosting(h.db, id))!;
    expect(view).toMatchObject({ hosting: "wordpress", isPro: false, locked: false, addonOnProject: { priceCents: null } });
    const [addon] = await h.db.select().from(projectAddon).where(eq(projectAddon.projectId, id));
    expect(addon).toMatchObject({ addonKey: "wordpress_hosting", monthly: true, priceCents: null, removedAt: null });
    const logged = await h.db.select().from(activityLog).where(and(eq(activityLog.entityId, id), eq(activityLog.action, "project.hosting_changed")));
    expect(logged.map((l) => [l.valueBefore, l.valueAfter])).toEqual([[{ hosting: "netlify" }, { hosting: "wordpress" }]]);
    expect(view.changed?.userId).toBe(pm.viewer.id);

    // The card: the PM sees that the add-on is on, never its price.
    const pmCard = renderToStaticMarkup(
      <HostingCard projectId={id} hosting="wordpress" canChange locked={false} isPro={false} showPrices={false} addonPrice={null} addonLine="the WordPress hosting add-on is on its price" changedLine={null} />,
    );
    expect(pmCard).toContain("WordPress on 20i (Build B)");
    expect(pmCard).toContain("Not a Pro project: the WordPress hosting add-on is on its price.");
    expect(pmCard).toContain("Change hosting");
    expect(pmCard).not.toContain("$");

    // Back to Netlify: the add-on comes off (kept in history).
    await setHosting(h.ctx, pm.viewer, id, "netlify");
    view = (await loadHosting(h.db, id))!;
    expect(view).toMatchObject({ hosting: "netlify", addonOnProject: null });
    expect((await h.db.select().from(projectAddon).where(eq(projectAddon.projectId, id)))[0]!.removedAt).not.toBeNull();
  });

  it("adds no add-on on Pro, and is locked once the site is live", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { ...base, clientName: "Keller Law", tier: "pro" });
    await setHosting(h.ctx, admin.viewer, id, "wordpress");
    expect((await loadHosting(h.db, id))!).toMatchObject({ hosting: "wordpress", isPro: true, addonOnProject: null });
    expect(await h.db.select().from(projectAddon).where(eq(projectAddon.projectId, id))).toHaveLength(0);

    await h.db.update(project).set({ status: "live", liveAt: new Date() }).where(eq(project.id, id));
    await expect(setHosting(h.ctx, admin.viewer, id, "netlify")).rejects.toBeInstanceOf(HostingError);
    const card = renderToStaticMarkup(<HostingCard projectId={id} hosting="wordpress" canChange locked isPro showPrices addonPrice={null} addonLine={null} changedLine={null} />);
    expect(card).toContain("Locked: the site is live.");
    expect(card).toContain("Pro includes WordPress hosting.");
    expect(card).not.toContain("Change hosting");
  });

  it("offers the WordPress package of the last finished build (B1, 1 October 2026)", () => {
    const props = { projectId: "p1", canChange: true, locked: false, isPro: true, showPrices: true, addonPrice: null, addonLine: null, changedLine: null } as const;
    const ready = renderToStaticMarkup(<HostingCard {...props} hosting="wordpress" wpPackage={{ version: 4, href: "/projects/p1/build/wordpress-package/4" }} />);
    expect(ready).toContain("WordPress package");
    expect(ready).toContain("Made from version 4");
    expect(ready).toContain('href="/projects/p1/build/wordpress-package/4"');
    expect(ready).toContain("Download the WordPress package");
    const before = renderToStaticMarkup(<HostingCard {...props} hosting="wordpress" wpPackage={{ version: null, href: null }} />);
    expect(before).toContain("Build the site first: the package is made from the finished build.");
    expect(before).not.toContain("Download the WordPress package");
    // Only for a WordPress project, and only for people who can build.
    expect(renderToStaticMarkup(<HostingCard {...props} hosting="netlify" wpPackage={{ version: 4, href: "/x" }} />)).not.toContain("WordPress package");
    expect(renderToStaticMarkup(<HostingCard {...props} canChange={false} hosting="wordpress" wpPackage={{ version: 4, href: "/x" }} />)).not.toContain("Download the WordPress package");
  });

  it("gives a WordPress project its own go-live steps (B3, 1 October 2026), never Netlify's", () => {
    const steps = { domainConfirmed: true, emailVerified: true, emailConfirmed: true, netlifyDomain: true, nameserversSwitched: true, httpsConfirmed: true, ga4Recorded: true };
    expect(goLiveGate({ buildFeePaid: true, checklist: [], steps, founderFlags: [], hasBuild: true }).ready).toBe(true);
    const gate = goLiveGate({ buildFeePaid: true, checklist: [], steps, founderFlags: [], hasBuild: true, wordpress: true });
    expect(gate.ready).toBe(false);
    expect(gate.blockers).toEqual(["The WordPress preview isn't on the latest build: deploy it again first (Hosting).", "The domain isn't on the site's 20i package yet (Put the domain on 20i).", "The domain's two records aren't pointing at the site's 20i package yet (Connect the domain)."]);
  });
});

describe("monthly add-ons", () => {
  it("are on the price list unpriced, get the first price an admin sets, and count every month with the monthly fee", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { ...base, clientName: "Harbor Pest Control", tier: "starter" });
    const hosting = (await listAddons(h.db)).find((a) => a.key === "wordpress_hosting")!;
    expect(hosting).toMatchObject({ name: "WordPress hosting", priceCents: null, monthly: true, quoted: false });

    await setHosting(h.ctx, admin.viewer, id, "wordpress");
    await saveAddonPrice(h.ctx, admin.viewer, "wordpress_hosting", "25");
    const money = (await loadProjectMoney(h.db, id))!;
    expect(money.addons).toEqual([{ name: "WordPress hosting", priceCents: 2500, monthly: true, quantity: 1 }]);
    expect(await h.db.select().from(activityLog).where(and(eq(activityLog.entityId, id), eq(activityLog.action, "project.addon_priced")))).toHaveLength(1);
    // A later price change doesn't touch a project that has its price.
    await saveAddonPrice(h.ctx, admin.viewer, "wordpress_hosting", "30");
    expect((await loadProjectMoney(h.db, id))!.addons[0]!.priceCents).toBe(2500);

    const months = revenueByMonth(
      [{ id, clientName: "Harbor", packageKey: "starter", buildFeeCents: 19900, monthlyFeeCents: 9900, liveAt: new Date("2026-08-15T18:00:00Z"), cancelledOn: null, addonCents: 15000, monthlyAddonCents: 2500 }],
      ["2026-08", "2026-09"],
    );
    expect(months.map((m) => [m.month, m.buildFees, m.monthlyFees])).toEqual([
      ["2026-08", 34900, 12400],
      ["2026-09", 0, 12400],
    ]);
  });
});

describe("the client's WordPress theme", () => {
  const approved = `<html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;700&amp;display=swap"><link rel="stylesheet" href="https://evil.example.com/x.css"><style>
    :root { --brand: #1a3399; }
    body { background: #ffffff; color: #222222; font-family: 'Inter', sans-serif; font-size: 17px; }
    h1 { font-family: 'Poppins', sans-serif; font-size: 56px; font-weight: 700; color: #111111; }
    h2 { font-size: 36px; }
    .btn { background: var(--brand); color: #ffffff; }
    .container { max-width: 1180px; }
    a { color: #1a3399; }
  </style></head><body><section class="hero"><h1>Harbor</h1></section></body></html>`;

  it("is made from the approved design and Build A's stylesheet, with nothing unescaped in its PHP", () => {
    const files = wordpressTheme({
      clientName: "Bob's Pest */ Control",
      buildVersion: 3,
      siteCss: ".hero { padding: 80px 0; }",
      fontLinks: [...approved.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]),
      design: readDesign(approved),
      parts: { header: '<!-- wp:group {"tagName":"div"} --><div class="wp-block-group"></div><!-- /wp:group -->', footer: "<!-- wp:paragraph --><p>Footer</p><!-- /wp:paragraph -->" },
    });
    expect(Object.keys(files).sort()).toEqual(["functions.php", "parts/footer.html", "parts/header.html", "style.css", "templates/front-page.html", "templates/index.html", "templates/page.html", "theme.json"]);
    expect(themeSlug("Bob's Pest */ Control")).toBe("tawd-bobs-pest-control");

    // The theme header can't be closed early by the client's name; Build A's CSS follows it.
    expect(files["style.css"]).toContain("Theme Name: Bob's Pest * / Control");
    expect(files["style.css"]).toContain("Version: 1.3");
    expect(files["style.css"]).toContain(".hero { padding: 80px 0; }");

    const json = JSON.parse(files["theme.json"]!) as { version: number; settings: { color: { palette: { slug: string; color: string }[] }; typography: { fontFamilies: { name: string }[]; fontSizes: { slug: string; size: string }[] }; layout: { contentSize: string } }; styles: Record<string, unknown> };
    expect(json.version).toBe(3);
    expect(json.settings.color.palette.find((p) => p.slug === "primary-action")!.color).toBe("#1a3399");
    expect(json.settings.typography.fontFamilies.map((f) => f.name)).toEqual(["Poppins", "Inter"]);
    expect(json.settings.typography.fontSizes.find((f) => f.slug === "h1")!.size).toBe("56px");
    expect(json.settings.layout.contentSize).toBe("1180px");
    // Build A's stylesheet sets the colours on the page; theme.json only offers them in the editor (1 October 2026).
    expect(Object.keys(json.styles)).toEqual(["spacing"]);

    // Only Google Fonts are loaded; the quote in the name is escaped in PHP strings.
    expect(files["functions.php"]).toContain("'https://fonts.googleapis.com/css2?family=Poppins:wght@400;700&display=swap'");
    expect(files["functions.php"]).not.toContain("evil.example.com");
    expect(files["functions.php"]).toContain("'tawd-bobs-pest-control-style'");
    expect(files["templates/page.html"]).toContain('<!-- wp:template-part {"slug":"header","tagName":"div"} /-->');
    expect(files["templates/page.html"]).toContain("<!-- wp:post-content");
  });
});
