import { desc, eq } from "drizzle-orm";
import { unzipSync } from "fflate";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Build A, 8b (26 September 2026): SEO in the pages, forms, the go-live
  checklist and preview deploys. Netlify is a stand-in: nothing here
  reaches it.
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
import { activityLog, netlifySite, previewDecision, siteBuild, siteDeploy } from "@tawd/core/schema";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import {
  areaServedFrom,
  headersFile,
  localBusinessSchema,
  netlifyForms,
  robotsTxt,
  runChecklist,
  seoHead,
  sitemapXml,
  type BusinessFacts,
} from "@tawd/core/site";
import { buildSiteFeaturesBlock, type SiteFeature } from "@tawd/core/mockups";
import { createProject } from "@/lib/projects";
import { PRIVATE_PREVIEW_WARNING, deployPreview, loadPreviews, recordPreviewDecision, setNetlifyFetchForTesting, setPreviewProbeForTesting, settleDeploys } from "@/lib/netlify";

import { createHarness, seedAdmin, type Harness } from "./harness";
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
  setNetlifyFetchForTesting(null);
  vi.unstubAllEnvs();
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

const facts: BusinessFacts = {
  name: "Sacramento Drain Pros",
  phone: "",
  email: "office@sacdrainpros.com",
  streetAddress: "",
  city: "Sacramento",
  state: "CA",
  isServiceAreaBusiness: false,
  domain: null,
  trade: "plumbing",
  areaServed: [{ type: "City", name: "Sacramento" }],
  logoPath: "/images/logo.png",
};

describe("SEO in the pages", () => {
  it("writes LocalBusiness schema from the intake, never a rating, with missing facts as placeholders", () => {
    const schema = localBusinessSchema(facts);
    expect(schema).toMatchObject({ "@type": "Plumber", name: "Sacramento Drain Pros", telephone: "[PLACEHOLDER: phone number]", email: "office@sacdrainpros.com" });
    expect(schema.address).toMatchObject({ streetAddress: "[PLACEHOLDER: street address]", addressLocality: "Sacramento", addressRegion: "CA" });
    expect(JSON.stringify(schema)).not.toMatch(/aggregateRating|review/i);
    expect(localBusinessSchema({ ...facts, isServiceAreaBusiness: true }).address).toBeUndefined();
    expect(areaServedFrom({ scope: "states", cities: [], states: ["NV"], radius: { miles: null, address: "" } })).toEqual([{ type: "State", name: "Nevada" }]);
    expect(areaServedFrom({ scope: "radius", cities: [], states: [], radius: { miles: 30, address: "4105 Kietzke Ln, Reno, NV 89502" } })).toEqual([{ type: "City", name: "Reno" }]);
  });

  it("adds canonical and Open Graph URLs once the domain is known, and schema on Home and Contact only", () => {
    const home = seoHead({ facts, path: "/", kind: "home", title: "Home", description: "Drains." });
    expect(home).not.toContain("canonical");
    expect(home).toContain('<script type="application/ld+json">');
    expect(seoHead({ facts, path: "/about/", kind: "about", title: "About", description: "x" })).not.toContain("ld+json");
    const withDomain = seoHead({ facts: { ...facts, domain: "sacdrainpros.com", name: 'Pros</script><script>alert(1)' }, path: "/drain-cleaning/", kind: "contact", title: "T", description: "D" });
    expect(withDomain).toContain('<link rel="canonical" href="https://sacdrainpros.com/drain-cleaning/" />');
    expect(withDomain).toContain('<meta property="og:image" content="https://sacdrainpros.com/images/logo.png" />');
    expect(withDomain).not.toContain("</script><script>");
  });

  it("keeps a preview out of search engines, and writes the sitemap only with a domain", () => {
    expect(robotsTxt("preview", "x.com")).toContain("Disallow: /");
    expect(robotsTxt("live", "x.com")).toContain("Sitemap: https://x.com/sitemap.xml");
    expect(headersFile("preview")).toContain("X-Robots-Tag: noindex, nofollow");
    expect(headersFile("live")).not.toContain("X-Robots-Tag");
    expect(sitemapXml(null, ["/"])).toBeNull();
    expect(sitemapXml("x.com", ["/", "/about/"])).toContain("<loc>https://x.com/about/</loc>");
  });

  it("makes every form a Netlify form with a honeypot and the thank-you page, the same however often it runs", () => {
    const once = netlifyForms('<main><form class="contact" action="/x" method="get"><label for="n">Name</label><input id="n" name="name"><button>Send</button></form></main>');
    expect(once).toContain('<form name="contact" method="POST" action="/thank-you/" data-netlify="true" netlify-honeypot="bot-field" class="contact">');
    expect(once).toContain('<input type="hidden" name="form-name" value="contact" />');
    expect(once).toContain('name="bot-field"');
    expect(netlifyForms(once)).toBe(once);
  });
});

describe("the go-live checklist", () => {
  const page = (body: string) => `<html><head><title>A page title</title><meta name="description" content="A description long enough to count."></head><body><a href="#main">Skip</a>${body}<footer>Website by Velocity Media Lab</footer></body></html>`;
  it("finds what stops go-live and what is only worth a look", () => {
    const files = new Map([
      ["index.html", page('<main><h1>Home</h1><a href="tel:9165550100">Call</a><a href="/missing/">x</a><img src="/a.jpg"><mark>[PLACEHOLDER: licence number]</mark></main>')],
      ["faq/index.html", page("<main><h1>FAQ</h1><details><summary>Q</summary>A</details></main>")],
      ["contact/index.html", page('<main><h1>Contact</h1><form name="contact" data-netlify="true"></form></main>')],
      ["thank-you/index.html", page("<main><h1>Thanks</h1></main>")],
      ["404.html", "<html><body><h1>Not found</h1></body></html>"],
    ]);
    const checks = runChecklist({ files, pagePaths: ["/", "/faq/", "/contact/"], domain: null, mobileOverflow: [], gbpUrl: "" });
    const item = (key: string) => checks.find((c) => c.key === key)!;
    expect(item("404").ok).toBe(true);
    expect(item("skip").ok).toBe(true);
    expect(item("faq").ok).toBe(true);
    expect(item("forms").ok).toBe(true);
    expect(item("footer").ok).toBe(true);
    expect(item("tel").ok).toBe(true);
    expect(item("links")).toMatchObject({ ok: false, detail: "Broken: /missing/" });
    expect(item("alt")).toMatchObject({ ok: false, blocksGoLive: false });
    expect(item("placeholders")).toMatchObject({ ok: false, blocksGoLive: true });
    expect(item("domain")).toMatchObject({ ok: false, blocksGoLive: true });
    expect(item("mobile").ok).toBe(true);
    expect(runChecklist({ files, pagePaths: [], domain: "x.com", mobileOverflow: null, gbpUrl: "" }).find((c) => c.key === "mobile")!.detail).toBe("Not measured");
  });

  // Crawl-%: the built site must keep the features the approved concept kept from the current site.
  it("blocks go-live when the built home page drops a current-site feature, unless it's left out on purpose", () => {
    const features: SiteFeature[] = [{ id: "warranty", label: "Warranty or guarantee", evidence: "warranty" }];
    const base = { pagePaths: ["/"], domain: null, mobileOverflow: [] as string[], gbpUrl: "" };
    const feat = (body: string, siteFeatures?: SiteFeature[]) =>
      runChecklist({ files: new Map([["index.html", page(`<main>${body}</main>`)]]), ...base, siteFeatures }).find((c) => c.key === "siteFeatures")!;
    // Missing from the built home page: blocks go-live.
    expect(feat("<h1>Home</h1><p>Welcome.</p>", features)).toMatchObject({ ok: false, blocksGoLive: true });
    expect(feat("<h1>Home</h1><p>Welcome.</p>", features).detail).toContain("Warranty");
    // Present: passes.
    expect(feat("<h1>Home</h1><section><h2>Our warranty</h2><p>Every job is covered.</p></section>", features).ok).toBe(true);
    // Left out on purpose with a reason: not a block.
    expect(feat("<h1>Home</h1><!-- tawd-left-out: warranty: the client no longer offers one (intake notes) --><p>Welcome.</p>", features).ok).toBe(true);
    // A too-short reason (under 8 chars) doesn't count as left out: still blocked.
    expect(feat("<h1>Home</h1><!-- tawd-left-out: warranty: expired --><p>Welcome.</p>", features)).toMatchObject({ ok: false, blocksGoLive: true });
    // No current-site features to keep: passes.
    expect(feat("<h1>Home</h1><p>Welcome.</p>").ok).toBe(true);
    // Home-only: a feature on a secondary page but absent from the home still blocks.
    const homeLacks = new Map([
      ["index.html", page("<main><h1>Home</h1><p>Welcome.</p></main>")],
      ["about/index.html", page("<main><h1>About</h1><section><h2>Our warranty</h2><p>Every job is covered.</p></section></main>")],
    ]);
    expect(runChecklist({ files: homeLacks, ...base, siteFeatures: features }).find((c) => c.key === "siteFeatures")).toMatchObject({ ok: false, blocksGoLive: true });
  });

  it("buildSiteFeaturesBlock names the features for the builder, and is empty when there are none", () => {
    expect(buildSiteFeaturesBlock([])).toBe("");
    const block = buildSiteFeaturesBlock([{ id: "ratings", label: "Ratings and reviews", evidence: "4.9 stars" }]);
    expect(block).toContain("current site's features");
    expect(block).toContain("ratings: Ratings and reviews");
  });
});

describe("preview deploys on Netlify (a stand-in)", () => {
  async function builtProject() {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, {
      clientName: "Sacramento Drain Pros",
      trade: "plumbing",
      tier: "starter",
      lane: "lane_1",
      laneOption: null,
      conceptCount: 3,
      status: "build",
      memberUserIds: [],
    });
    await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Sacramento Drain Pros", email: "office@sacdrainpros.com" });
    await h.db.insert(siteBuild).values({ projectId: id, version: 1, status: "done", pages: [], fileCount: 4 });
    const prefix = `projects/${id}/site/v1/`;
    for (const [file, text] of [["index.html", "<h1>Home</h1>"], ["site.css", "body{}"], ["_headers", "/*\n  X-Robots-Tag: noindex"], ["_shots/home.jpg", "jpeg"], ["_source/parts.json", "{}"]]) {
      r2.objects.set(`${prefix}${file}`, Buffer.from(text!));
    }
    return { admin, id };
  }

  function stand(options: { refuseHooksList?: boolean; noDraftUrl?: boolean } = {}) {
    const calls: { method: string; path: string; auth: string | null; body: unknown }[] = [];
    setNetlifyFetchForTesting(
      (async (url: string, init?: RequestInit) => {
        const path = url.replace("https://api.netlify.com/api/v1", "");
        const body = init?.body instanceof Uint8Array ? unzipSync(init.body) : init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method: init?.method ?? "GET", path, auth: new Headers(init?.headers).get("Authorization"), body });
        if (options.refuseHooksList && path.startsWith("/hooks?")) return new Response("{}", { status: 403 });
        if (path === "/sites" && init?.method === "POST") return Response.json({ id: "site-1", name: (body as { name: string }).name, ssl_url: "https://tawd-sac.netlify.app", admin_url: "https://app.netlify.com/sites/tawd-sac" });
        if (/\/deploys(\?draft=true)?$/.test(path)) return Response.json({ id: `deploy-${calls.length}`, state: "uploaded", ssl_url: "https://tawd-sac.netlify.app", ...(options.noDraftUrl ? {} : { deploy_ssl_url: "https://abc--tawd-sac.netlify.app" }) });
        if (path.startsWith("/deploys/")) return Response.json({ state: "ready", ...(options.noDraftUrl ? {} : { deploy_ssl_url: "https://abc--tawd-sac.netlify.app" }) });
        return Response.json({});
      }) as typeof fetch,
      async () => undefined,
    );
    return calls;
  }

  it("still deploys, and still sets the form emails, when Netlify won't list the site's notifications (the Site check after 0.75.0)", async () => {
    const { admin, id } = await builtProject();
    vi.stubEnv("NETLIFY_AUTH_TOKEN", "nf-test-token");
    vi.stubEnv("NETLIFY_FORM_COPY_EMAIL", "forms@velocitymedialab.com");
    const calls = stand({ refuseHooksList: true });
    await deployPreview(h.ctx, admin.viewer, id);
    await settleDeploys();
    const hooks = calls.filter((c) => c.method === "POST" && c.path === "/hooks").map((c) => (c.body as { data: { email: string } }).data.email);
    expect(hooks).toEqual(["office@sacdrainpros.com", "forms@velocitymedialab.com"]);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(calls.some((c) => c.path.endsWith("/deploys?draft=true"))).toBe(true);
    const [site] = await h.db.select().from(netlifySite);
    expect(site!.formEmails).toEqual(["office@sacdrainpros.com", "forms@velocitymedialab.com"]);
  });

  // CodeRabbit (PR #5): a draft without its own address is never saved as the site's main address.
  it("fails a preview Netlify gives no address of its own", async () => {
    const { admin, id } = await builtProject();
    vi.stubEnv("NETLIFY_AUTH_TOKEN", "nf-test-token");
    stand({ noDraftUrl: true });
    await deployPreview(h.ctx, admin.viewer, id);
    await settleDeploys();
    const [deploy] = await h.db.select().from(siteDeploy);
    expect(deploy).toMatchObject({ state: "failed", url: null, error: "Netlify published the preview but didn't give its own address. Deploy again." });
  });

  it("creates the client's site once, with forms on and emails to the client and VML, then uploads the build without TAWD's own files", async () => {
    const { admin, id } = await builtProject();
    await expect(deployPreview(h.ctx, admin.viewer, id)).rejects.toThrow("NETLIFY_AUTH_TOKEN");
    vi.stubEnv("NETLIFY_AUTH_TOKEN", "nf-test-token");
    vi.stubEnv("NETLIFY_FORM_COPY_EMAIL", "forms@velocitymedialab.com");
    const calls = stand();
    await deployPreview(h.ctx, admin.viewer, id);
    await settleDeploys();

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /sites", "PATCH /sites/site-1", "GET /hooks?site_id=site-1", "POST /hooks", "POST /hooks", "POST /sites/site-1/deploys?draft=true", "GET /deploys/deploy-6"]);
    expect(calls.every((c) => c.auth === "Bearer nf-test-token")).toBe(true);
    expect(calls[1]!.body).toEqual({ processing_settings: { ignore_html_forms: false } });
    expect(calls.slice(3, 5).map((c) => (c.body as { data: { email: string } }).data.email)).toEqual(["office@sacdrainpros.com", "forms@velocitymedialab.com"]);
    expect(Object.keys(calls[5]!.body as object).sort()).toEqual(["_headers", "index.html", "site.css"]);

    const [site] = await h.db.select().from(netlifySite);
    expect(site).toMatchObject({ siteId: "site-1", url: "https://tawd-sac.netlify.app" });
    const [deploy] = await h.db.select().from(siteDeploy);
    expect(deploy).toMatchObject({ state: "ready", url: "https://abc--tawd-sac.netlify.app", version: 1 });

    calls.length = 0;
    await deployPreview(h.ctx, admin.viewer, id);
    await settleDeploys();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /sites/site-1/deploys?draft=true", "GET /deploys/deploy-1"]);

    await recordPreviewDecision(h.ctx, admin.viewer, id, { outcome: "approved", channel: "email", clientSaid: "Looks great, go ahead" });
    const [decision] = await h.db.select().from(previewDecision);
    expect(decision).toMatchObject({ outcome: "approved", channel: "email" });
    const actions = (await h.db.select().from(activityLog)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["site.preview_started", "site.preview_deployed", "site.preview_decision"]));
    expect((await loadPreviews(h.db, id)).deploys).toHaveLength(2);
  });

  it("says when Netlify paused deploys for running out of credits, not that the token is wrong (1 October 2026)", async () => {
    const { admin, id } = await builtProject();
    vi.stubEnv("NETLIFY_AUTH_TOKEN", "fine");
    setNetlifyFetchForTesting((async () => Response.json({ code: 403, message: "Production deploys are paused: the team is running on operational credits." }, { status: 403 })) as typeof fetch, async () => undefined);
    await deployPreview(h.ctx, admin.viewer, id);
    await settleDeploys();
    const [deploy] = await h.db.select().from(siteDeploy).where(eq(siteDeploy.projectId, id));
    expect(deploy!.error).toBe("Netlify paused deploys for the VML team: Production deploys are paused: the team is running on operational credits. An admin upgrades the Netlify plan, or deploys resume at the next billing cycle.");
  });

  it("keeps Netlify's refusal on the deploy in plain words", async () => {
    const { admin, id } = await builtProject();
    vi.stubEnv("NETLIFY_AUTH_TOKEN", "wrong");
    setNetlifyFetchForTesting((async () => new Response("{}", { status: 401 })) as typeof fetch, async () => undefined);
    await deployPreview(h.ctx, admin.viewer, id);
    await settleDeploys();
    const [deploy] = await h.db.select().from(siteDeploy).where(eq(siteDeploy.projectId, id));
    expect(deploy).toMatchObject({ state: "failed", error: "Netlify refused the token. Check NETLIFY_AUTH_TOKEN in Coolify." });
    await expect(recordPreviewDecision(h.ctx, admin.viewer, id, { outcome: "approved", channel: "email", clientSaid: "okay" })).rejects.toThrow("no preview link");
  });

  it("opens each ready preview as a signed-out visitor, and says so plainly when Netlify keeps it private (29 September 2026)", async () => {
    const { admin, id } = await builtProject();
    vi.stubEnv("NETLIFY_AUTH_TOKEN", "nf-test-token");
    stand();
    const visited: string[] = [];
    let answer = 401;
    setPreviewProbeForTesting(async (url) => {
      visited.push(String(url));
      return new Response("Private project", { status: answer });
    });
    await deployPreview(h.ctx, admin.viewer, id);
    await settleDeploys();
    let [deploy] = await h.db.select().from(siteDeploy).where(eq(siteDeploy.projectId, id)).orderBy(desc(siteDeploy.createdAt));
    expect(visited).toEqual(["https://abc--tawd-sac.netlify.app"]);
    expect(deploy).toMatchObject({ state: "ready", accessWarning: PRIVATE_PREVIEW_WARNING });
    expect(PRIVATE_PREVIEW_WARNING).toContain("Project configuration > General > Visitor access > Project visibility");

    // On the Build screen, beside the preview.
    state.user = admin.viewer;
    const { default: BuildPage } = await import("@/app/(app)/projects/[id]/build/page");
    expect(renderToStaticMarkup(await BuildPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ part: "preview" }) }))).toContain("Netlify is keeping this preview private");

    // Made public in Netlify, deployed again: the warning goes.
    answer = 200;
    await deployPreview(h.ctx, admin.viewer, id);
    await settleDeploys();
    [deploy] = await h.db.select().from(siteDeploy).where(eq(siteDeploy.projectId, id)).orderBy(desc(siteDeploy.createdAt));
    expect(deploy!.accessWarning).toBeNull();
    setPreviewProbeForTesting(null);
  });

  it("shows the checklist and the preview on the Build screen", async () => {
    const { admin, id } = await builtProject();
    await h.db.update(siteBuild).set({ checks: [{ key: "404", label: "Custom 404 page", ok: true, detail: "x", blocksGoLive: true }, { key: "placeholders", label: "No placeholders left", ok: false, detail: "1", blocksGoLive: true }] }).where(eq(siteBuild.projectId, id));
    state.user = admin.viewer;
    const { default: BuildPage } = await import("@/app/(app)/projects/[id]/build/page");
    // The checklist is on the Check part, the preview on its own (30 September 2026).
    const part = async (p: string) => renderToStaticMarkup(await BuildPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ part: p }) }));
    const html = (await part("check")) + (await part("preview"));
    expect(html).toContain("Go-live checklist");
    // The SEO team's sign-off (26 September 2026) is on the list too.
    expect(html).toContain("1 of 3 done. 2 still stop the site going live");
    expect(html).toContain("Netlify isn&#x27;t set up yet");
  });
});

describe("Jason's decisions (26 September 2026)", () => {
  it("deletes the project's Netlify site with the project, and deletes nothing if Netlify says no", async () => {
    const { deleteProject } = await import("@/lib/project-deletion");
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Rio Glass", trade: "glass_and_windows", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 3, status: "build", memberUserIds: [] });
    await h.db.insert(netlifySite).values({ projectId: id, siteId: "site-9", name: "tawd-rio-glass-abc123", url: "https://tawd-rio-glass-abc123.netlify.app" });
    const confirm = { confirmName: "Rio Glass", reason: "Test project, not a client" };

    await expect(deleteProject(h.ctx, admin.viewer, id, confirm)).rejects.toThrow("Add NETLIFY_AUTH_TOKEN in Coolify so TAWD can delete it too");
    vi.stubEnv("NETLIFY_AUTH_TOKEN", "nf-test-token");
    setNetlifyFetchForTesting((async () => new Response("{}", { status: 500 })) as typeof fetch);
    await expect(deleteProject(h.ctx, admin.viewer, id, confirm)).rejects.toThrow("Nothing was deleted");
    expect(await h.db.select().from(netlifySite)).toHaveLength(1);

    const deleted: string[] = [];
    setNetlifyFetchForTesting((async (url: string, init?: RequestInit) => {
      deleted.push(`${init?.method} ${url.replace("https://api.netlify.com/api/v1", "")}`);
      return new Response(null, { status: 204 });
    }) as typeof fetch);
    await deleteProject(h.ctx, admin.viewer, id, confirm);
    expect(deleted).toEqual(["DELETE /sites/site-9"]);
    expect(await h.db.select().from(netlifySite)).toEqual([]);
    const [entry] = (await h.db.select().from(activityLog)).filter((a) => a.action === "project.deleted");
    expect(entry!.valueAfter).toMatchObject({ netlifySiteDeleted: "https://tawd-rio-glass-abc123.netlify.app" });
  });

  it("moves a project to Build once the client has approved the copy, and not before", async () => {
    const { moveToBuild } = await import("@/lib/content-drafts");
    const { contentDecision, project } = await import("@tawd/core/schema");
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Rio Glass", trade: "glass_and_windows", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 3, status: "content", memberUserIds: [] });
    await expect(moveToBuild(h.ctx, admin.viewer, id)).rejects.toThrow("hasn't approved the copy yet");
    await h.db.insert(contentDecision).values({ projectId: id, outcome: "changes_requested", channel: "email", clientSaid: "Change the FAQ", pages: [] });
    await expect(moveToBuild(h.ctx, admin.viewer, id)).rejects.toThrow("hasn't approved the copy yet");
    await h.db.insert(contentDecision).values({ projectId: id, outcome: "approved", channel: "email", clientSaid: "All good", pages: [], createdAt: new Date(Date.now() + 1000) });
    await moveToBuild(h.ctx, admin.viewer, id);
    const [row] = await h.db.select().from(project).where(eq(project.id, id));
    expect(row!.status).toBe("build");
    await expect(moveToBuild(h.ctx, admin.viewer, id)).rejects.toThrow("Only a project at Content");
  });

  it("won't move to Build when the copy changed after the client approved it (13 October 2026)", async () => {
    const { moveToBuild } = await import("@/lib/content-drafts");
    const { contentDecision, pageDraft, pagePlanPage, project } = await import("@tawd/core/schema");
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Rio Glass", trade: "glass_and_windows", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 3, status: "content", memberUserIds: [] });
    const [page] = await h.db
      .insert(pagePlanPage)
      .values({ projectId: id, position: 0, kind: "home", name: "Home", slug: "", mainKeyword: "glass", supportingKeywords: [], title: "Rio Glass", metaDescription: "Glass in Reno.", h1: "Rio Glass" })
      .returning({ id: pagePlanPage.id });
    await h.db.insert(pageDraft).values({ projectId: id, pageId: page!.id, version: 1, source: "ai", status: "done", body: "# Rio Glass\n\nGlass in Reno." });
    await h.db.insert(contentDecision).values({ projectId: id, outcome: "approved", channel: "email", clientSaid: "All good", pages: [{ pageId: page!.id, name: "Home", version: 1 }] });
    // Redrafted after the approval.
    await h.db.insert(pageDraft).values({ projectId: id, pageId: page!.id, version: 2, source: "ai", status: "done", body: "# Rio Glass\n\nNew words." });
    await expect(moveToBuild(h.ctx, admin.viewer, id)).rejects.toThrow("The copy changed after the client approved it (Home)");
    const [row] = await h.db.select().from(project).where(eq(project.id, id));
    expect(row!.status).toBe("content");
  });
});
