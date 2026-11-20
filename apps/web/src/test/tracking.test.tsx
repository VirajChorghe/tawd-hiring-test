import vm from "node:vm";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Tracking codes (Todd's request, 26 September 2026): IDs only, checked;
  the code on every page, loading nothing before the visitor's consent;
  "ask first" or "on unless the visitor opts out"; a "Do not sell or share
  my information" link; the privacy and cookie policies are VML's templates
  (policies.ts, since 28 September 2026).
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
import { activityLog, projectTracking } from "@tawd/core/schema";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { PermissionError } from "@tawd/core/permissions";
import { checkTrackingIds, consentBanner, consentRuleFor, effectiveConsentMode, privacyLinks, trackingHead, type ConsentRule, type TrackingConfig } from "@tawd/core/site";
import { createProject } from "@/lib/projects";
import { deleteProject } from "@/lib/project-deletion";
import { loadTracking, saveTracking } from "@/lib/tracking";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

const ALL: TrackingConfig = { ga4: "G-AB12CD34EF", gtm: "GTM-AB12CD3", metaPixel: "123456789012345", googleAds: "AW-123456789/AbC-dEf", callRail: "515180123/60e10556ab4e9108ff3a", consentMode: "opt_in" };
/* California's 2026 rule (the strictest in the table today, and the no-state fallback). */
const CA: ConsentRule = consentRuleFor(["CA"]);
/* A rule with nothing special, to prove each behaviour is rule-driven, not hardcoded. */
const PLAIN: ConsentRule = { floor: "opt_out", honorGpc: false, symmetricalButtons: false, optOutHonoredNotice: false, privacyChoicesLink: false };
const EVERY_SRC = [
  "https://www.googletagmanager.com/gtm.js?id=GTM-AB12CD3",
  "https://www.googletagmanager.com/gtag/js?id=G-AB12CD34EF",
  "https://connect.facebook.net/en_US/fbevents.js",
  "https://cdn.callrail.com/companies/515180123/60e10556ab4e9108ff3a/12/swap.js",
];

describe("the IDs", () => {
  it("take only their exact formats, so an ID can never carry code into a page", () => {
    expect(checkTrackingIds(ALL)).toEqual([]);
    expect(checkTrackingIds({ ...ALL, ga4: "UA-1234-1", gtm: 'GTM-1"><script>', metaPixel: "12ab", googleAds: "123", callRail: "515180123/../evil.js" }).map((p) => p.key)).toEqual(["ga4", "gtm", "metaPixel", "googleAds", "callRail"]);
    expect(checkTrackingIds({ ga4: "", gtm: "", metaPixel: "", googleAds: "", callRail: "" })).toEqual([]);
    // CallRail is the two path parts of its own snippet URL: digits, a slash, a hex key — nothing else.
    expect(checkTrackingIds({ ...ALL, callRail: "515180123/60E10556AB4E9108FF3A" })).toEqual([]); // case-insensitive
    for (const bad of ["swap.js", "515180123", "515180123/60e1 0556", "515180123/60e1'0556abcd", "//cdn.callrail.com/companies/1/2/12/swap.js"]) {
      expect(checkTrackingIds({ ...ALL, callRail: bad }).map((p) => p.key)).toEqual(["callRail"]);
    }
    expect(() => trackingHead({ ...ALL, gtm: "GTM-</script>" }, consentRuleFor([]))).toThrow();
  });
});

/* Runs the page's consent script in a small stand-in browser and reports what it loaded. */
function visit(config: TrackingConfig, rule: ConsentRule, options: { stored?: string | null; gpc?: boolean } = {}) {
  const loaded: string[] = [];
  const store = new Map<string, string>(options.stored ? [["tawd-consent", options.stored]] : []);
  const banner = { hidden: true };
  // One opt-out link and one "Your Privacy Choices" link, like the built footer's.
  const optOutLink = { textContent: "Do Not Sell or Share My Personal Information", addEventListener: (_: string, fn: unknown) => void (optOutClick = fn as (e: unknown) => void) };
  let optOutClick: (e: { preventDefault(): void }) => void = () => {};
  let ready: () => void = () => {};
  const window: Record<string, unknown> = {};
  const sandbox = {
    window,
    navigator: { globalPrivacyControl: options.gpc === true },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    location: { reload: () => loaded.push("(reload)") },
    encodeURIComponent,
    Date,
    document: {
      head: { appendChild: (el: { src: string }) => void loaded.push(el.src) },
      createElement: () => ({ src: "", async: false }),
      getElementById: (id: string) => (id === "tawd-consent" ? banner : null),
      querySelectorAll: (sel: string) => (sel.includes("data-tawd-optout") ? [optOutLink] : []),
      addEventListener: (_: string, fn: () => void) => void (ready = fn),
    },
  };
  Object.assign(window, sandbox);
  const script = /<script>([\s\S]*)<\/script>/.exec(trackingHead(config, rule))![1]!;
  vm.runInNewContext(script, sandbox);
  ready();
  return {
    loaded,
    banner,
    choose: (v: string) => (window.tawdConsent as (v: string) => void)(v),
    stored: () => store.get("tawd-consent") ?? null,
    optOutText: () => optOutLink.textContent,
    // A real browser calls the handler with `this` bound to the clicked link.
    clickOptOut: () => optOutClick.call(optOutLink, { preventDefault() {} }),
  };
}

describe("consent", () => {
  it("ask first: nothing loads until the visitor accepts, then every tool loads, CallRail included", () => {
    const page = visit(ALL, CA);
    expect(page.loaded).toEqual([]);
    expect(page.banner.hidden).toBe(false);
    page.choose("granted");
    expect(page.loaded).toEqual(EVERY_SRC);
    expect(page.banner.hidden).toBe(true);
    expect(page.stored()).toBe("granted");
  });

  it("ask first: declining loads nothing, and the choice is remembered", () => {
    const page = visit(ALL, CA);
    page.choose("denied");
    expect(page.loaded).toEqual([]);
    const later = visit(ALL, CA, { stored: "denied" });
    expect(later.loaded).toEqual([]);
    expect(later.banner.hidden).toBe(true);
  });

  it("on unless the visitor opts out: loads, but not after an opt-out or with Global Privacy Control", () => {
    const optOut = { ...ALL, consentMode: "opt_out" as const };
    expect(visit(optOut, CA).loaded).toHaveLength(4);
    expect(visit(optOut, CA, { stored: "denied" }).loaded).toEqual([]);
    const gpc = visit(optOut, CA, { gpc: true });
    expect(gpc.loaded).toEqual([]);
    expect(gpc.banner.hidden).toBe(true);
  });

  // The critical matrix (Consent PR1): under the rule, NO tag fires — GTM, GA4, Ads, Pixel or CallRail —
  // when consent is missing (ask-first), opted out, or Global Privacy Control is on.
  it("no consent, an opt-out, or GPC fires NOTHING, whatever the team chose", () => {
    for (const mode of ["opt_in", "opt_out"] as const) {
      const config = { ...ALL, consentMode: mode };
      expect(visit(config, CA, { stored: "denied" }).loaded).toEqual([]);
      expect(visit(config, CA, { gpc: true }).loaded).toEqual([]);
    }
    expect(visit(ALL, CA).loaded).toEqual([]); // ask first, unanswered
  });

  it("the rule is the floor: a weaker team choice is lifted, GPC and the honored notice follow the rule", () => {
    // The team chose "on unless opted out", but the rule's floor is ask-first → nothing before an accept.
    const optInFloor: ConsentRule = { ...PLAIN, floor: "opt_in" };
    expect(effectiveConsentMode({ ...ALL, consentMode: "opt_out" }, optInFloor)).toBe("opt_in");
    expect(visit({ ...ALL, consentMode: "opt_out" }, optInFloor).loaded).toEqual([]);
    // A rule that doesn't honor GPC loads under it (today no such state is in the table; the behaviour is the rule's, not hardcoded).
    expect(visit({ ...ALL, consentMode: "opt_out" }, PLAIN, { gpc: true }).loaded).toEqual(EVERY_SRC);
    // An explicit later accept still wins over GPC under the CA rule (§7025 allows asking).
    expect(visit({ ...ALL, consentMode: "opt_out" }, CA, { gpc: true, stored: "granted" }).loaded).toEqual(EVERY_SRC);
  });

  it('shows "Opt-Out Request Honored" once an opt-out is processed: clicked, chosen, or via GPC (CA §7025(c)(6))', () => {
    const optOut = { ...ALL, consentMode: "opt_out" as const };
    const clicked = visit(optOut, CA);
    clicked.clickOptOut();
    expect(clicked.optOutText()).toBe("Opt-Out Request Honored");
    const viaGpc = visit(optOut, CA, { gpc: true });
    expect(viaGpc.optOutText()).toBe("Opt-Out Request Honored");
    const declined = visit(ALL, CA);
    declined.choose("denied");
    expect(declined.optOutText()).toBe("Opt-Out Request Honored");
    // Without the rule, the old wording stays.
    const plain = visit(optOut, PLAIN);
    plain.clickOptOut();
    expect(plain.optOutText()).toBe("You have opted out");
  });

  it("symmetry (CA §7004): under the rule, accept is styled no heavier than decline; closing isn't a choice (no close button)", () => {
    const symmetric = consentBanner(ALL, CA);
    expect(symmetric).not.toContain("tawd-consent-yes");
    expect(symmetric).not.toMatch(/close|dismiss|×/i);
    expect(consentBanner(ALL, PLAIN)).toContain("tawd-consent-yes");
  });

  it("puts the banner and the footer's links on the page, with 'Your Privacy Choices' where the rule asks (the policies: policies.test.ts)", () => {
    expect(consentBanner(ALL, CA)).toContain("Nothing is tracked unless you accept.");
    expect(consentBanner(ALL, CA)).toContain('<a href="/cookies/">Cookie Policy</a>');
    expect(consentBanner({ ...ALL, consentMode: "opt_out" }, CA)).toContain(">Opt out</button>");
    expect(privacyLinks(CA)).toContain("Do Not Sell or Share My Personal Information");
    expect(privacyLinks(CA)).toContain("data-tawd-cookie-settings");
    expect(privacyLinks(CA)).toContain(">Your Privacy Choices</a>");
    expect(privacyLinks(PLAIN)).not.toContain("Your Privacy Choices");
    expect(trackingHead(ALL, CA)).toContain("[data-tawd-cookie-settings],[data-tawd-privacy-choices]");
  });

  it("the no-state fallback is the strictest rule in the table (today: California's)", () => {
    expect(consentRuleFor([])).toEqual(CA);
    expect(consentRuleFor(["TX"])).toEqual(CA); // no TX entry yet → strictest fallback
    expect(consentRuleFor(["CA", "TX"])).toEqual(CA);
  });
});

describe("the Tracking card", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    setDbForTesting(h.db as Database);
    setStorageForTesting(new FakeR2());
  });
  afterEach(async () => {
    setStorageForTesting(null);
    setDbForTesting(null);
    await h.close();
  });

  it("saves checked IDs for a PM, logs the change, shows on the project page, and goes with the project", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Glow Med Spa", trade: "med_spa", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 1, status: "build", memberUserIds: [] });
    const seo = await seedUser(h, admin.viewer, { email: "seo@velocitymedialab.com", roles: ["seo"] });
    await expect(saveTracking(h.ctx, seo.viewer, id, ALL)).rejects.toThrow(PermissionError);
    await expect(saveTracking(h.ctx, admin.viewer, id, { ...ALL, ga4: "UA-1" })).rejects.toThrow("should look like G-AB12CD34EF");
    await saveTracking(h.ctx, admin.viewer, id, { ...ALL, ga4: " g-ab12cd34ef ", consentMode: "opt_out" });
    expect(await loadTracking(h.db, id)).toMatchObject({ ga4: "G-AB12CD34EF", consentMode: "opt_out" });
    const [log] = (await h.db.select().from(activityLog)).filter((l) => l.action === "tracking.saved");
    expect(log!.valueAfter).toMatchObject({ ga4: "G-AB12CD34EF", consentMode: "opt_out" });

    state.user = admin.viewer;
    const { default: ProjectPage } = await import("@/app/(app)/projects/[id]/page");
    const html = renderToStaticMarkup(await ProjectPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ tab: "settings" }) } as never));
    expect(html).toContain("Tracking");
    expect(html).toContain('value="G-AB12CD34EF"');

    await deleteProject(h.ctx, admin.viewer, id, { confirmName: "Glow Med Spa", reason: "Test project, removing it" });
    expect(await h.db.select().from(projectTracking).where(eq(projectTracking.projectId, id))).toEqual([]);
  });
});
