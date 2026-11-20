import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyIntake, type IntakeData } from "@tawd/core/intake";
import { activityLog, privacyLaw } from "@tawd/core/schema";
import {
  PRIVACY_TEMPLATE,
  STATE_LAWS,
  lastChecked,
  policyFieldsFrom,
  projectStates,
  renderPolicy,
  stateAddOns,
  stateCode,
  staleRules,
  type TrackingConfig,
} from "@tawd/core/site";
import { PrivacyLawError, isReviewDue, loadPrivacyLaws, markLawChecked, privacyLawFlags, recordPrivacyReview, syncPrivacyLaws } from "@/lib/privacy-laws";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";

/*
  The state-aware privacy policy (28 September 2026): one baseline for
  every site, plus a section for each state its address, locations or
  service areas are in; the rules in one table with their sources and
  checks, the quarterly review, and the flag for a state unchecked for
  three months.
*/

const root = path.resolve(__dirname, "../../../..");
const NONE: TrackingConfig = { ga4: "", gtm: "", metaPixel: "", googleAds: "", callRail: "", consentMode: "opt_in" };
const ADS: TrackingConfig = { ...NONE, ga4: "G-AB12CD34EF", metaPixel: "123456789012345", consentMode: "opt_out" };
const fields = policyFieldsFrom({
  name: "Harbor Pest Control",
  legalName: "Harbor Pest Control LLC",
  streetAddress: "1 Main St",
  city: "Reno",
  state: "NV",
  phone: "(775) 555-0147",
  email: "office@harborpest.com",
  privacyEmail: "",
  domain: "harborpest.com",
  hostingProvider: "Netlify",
  effectiveDate: new Date("2026-09-28T18:00:00Z"),
});

function intake(edit: (d: IntakeData) => void): IntakeData {
  const d = emptyIntake();
  edit(d);
  return d;
}

const rule = (key: string) => STATE_LAWS.find((r) => r.key === key)!;

describe("the rules in docs/policies", () => {
  it("are exactly state-laws.json, each with its section from states/<key>.md", () => {
    const json = JSON.parse(readFileSync(path.join(root, "docs/policies/state-laws.json"), "utf8")) as { key: string }[];
    expect(STATE_LAWS.map((r) => r.key)).toEqual(json.map((r) => r.key));
    for (const r of STATE_LAWS) {
      const file = path.join(root, "docs/policies/states", `${r.key}.md`);
      expect(r.addOn).toBe(existsSync(file) ? readFileSync(file, "utf8") : "");
    }
  });

  it("each have a law, what it applies to, a check date and, when verified, an official source", () => {
    expect(new Set(STATE_LAWS.map((r) => r.key)).size).toBe(STATE_LAWS.length);
    for (const r of STATE_LAWS) {
      expect(r.lawName && r.citation && r.appliesTo, r.key).toBeTruthy();
      expect(r.checkedOn, r.key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(["yes", "no", "maybe"], r.key).toContain(r.coverage);
      if (r.verified) expect(r.sourceUrls.length, r.key).toBeGreaterThan(0);
      else expect(r.notes, r.key).toMatch(/^UNVERIFIED/);
      for (const url of r.sourceUrls) expect(url, r.key).toMatch(/^https?:\/\/[^/]*(\.gov|\.us)\//);
      // A state's first section is "## <State> residents"; a second one is a subsection under it.
      if (r.addOn) expect(r.addOn, r.key).toMatch(new RegExp(`^(## ${r.stateName} residents|### .*${r.stateName})`));
    }
  });

  it("cover California, Nevada, Delaware and the states with comprehensive laws", () => {
    const states = new Set(STATE_LAWS.map((r) => r.state));
    for (const s of ["CA", "NV", "DE", "VA", "CO", "CT", "UT", "IA", "IN", "TN", "MT", "TX", "OR", "FL", "NH", "NJ", "KY", "NE", "MD", "MN", "RI", "OK", "LA", "AL", "VT"]) {
      expect(states.has(s), s).toBe(true);
    }
    expect(rule("CA-caloppa").addOn).toContain("Global Privacy Control");
    expect(rule("NV-603a").addOn).toContain("send an opt-out request to {{business.privacy_email}}, and we will record it");
    expect(rule("DE-doppa").addOn).toContain("Delaware residents");
  });

  it("have no section for New York, whose Privacy Act isn't law; the baseline covers the SHIELD Act's security point", () => {
    expect(rule("NY-none").addOn).toBe("");
    expect(rule("NY-none").appliesTo).toContain("SHIELD");
    expect(PRIVACY_TEMPLATE).toContain("reasonable administrative, technical and physical safeguards");
    expect(PRIVACY_TEMPLATE).toContain("If a security breach affects your personal information, we will notify you");
    expect(stateAddOns(["NY"], { health: false })).toEqual([]);
  });

  it("each render with any tracking, filled from the project", () => {
    for (const tracking of [null, NONE, ADS]) {
      for (const r of STATE_LAWS.filter((x) => x.addOn)) {
        const html = renderPolicy("privacy", fields, tracking, [r.addOn]);
        expect(html, r.key).toContain(`${r.stateName} residents`);
        expect(html, r.key).not.toMatch(/\{\{|\[\[|PLACEHOLDER/);
      }
    }
  });
});

describe("a project's states", () => {
  it("read a code, a name, or the end of a place", () => {
    expect(stateCode("nv")).toBe("NV");
    expect(stateCode("Nevada")).toBe("NV");
    expect(stateCode("Reno, NV 89501")).toBe("NV");
    expect(stateCode("Washoe County, Nevada")).toBe("NV");
    expect(stateCode("Reno")).toBeNull();
  });

  it("come from the address, other locations and the chosen service areas only", () => {
    expect(projectStates(intake((d) => { d.business.state = "CA"; }))).toEqual(["CA"]);
    const d = intake((x) => {
      x.business.state = "NV";
      x.business.locations = [{ name: "", phone: "", streetAddress: "", city: "Salem", state: "Oregon" }];
      x.serviceAreas.scope = "cities";
      x.serviceAreas.cities = ["Reno, NV", "Truckee, CA"];
      x.serviceAreas.states = ["TX"]; // Left from an earlier choice: not counted.
    });
    expect(projectStates(d)).toEqual(["CA", "NV", "OR"]);
    expect(projectStates(intake((x) => { x.serviceAreas.scope = "states"; x.serviceAreas.states = ["DE", "MD"]; }))).toEqual(["DE", "MD"]);
    expect(projectStates(intake((x) => { x.serviceAreas.scope = "counties"; x.serviceAreas.counties = ["Washoe County, NV"]; }))).toEqual(["NV"]);
    expect(projectStates(intake((x) => { x.serviceAreas.scope = "radius"; x.serviceAreas.radius = { miles: 30, address: "1 Main St, Dover, DE 19901" }; }))).toEqual(["DE"]);
    expect(projectStates(intake((x) => { x.serviceAreas.scope = "dmas"; x.serviceAreas.dmas = [{ id: "811", name: "Reno NV", canonical: "Reno,Nevada,United States" }]; }))).toEqual(["NV"]);
    expect(projectStates(intake((x) => { x.serviceAreas.scope = "nationwide"; }))).toEqual([...new Set(STATE_LAWS.map((r) => r.state))].sort());
  });

  it("add their sections in state-name order, Nevada's health section only for health projects", () => {
    expect(stateAddOns(["NV", "CA"], { health: false }).map((r) => r.key)).toEqual(["CA-caloppa", "CA-ccpa", "NV-603a"]);
    expect(stateAddOns(["NV"], { health: true }).map((r) => r.key)).toEqual(["NV-603a", "NV-health"]);
    // Written from the law, not verified: a founders' flag, never a placeholder that blocks go-live.
    expect(rule("NV-health").addOn).toContain("consumer health data privacy policy");
    expect(rule("NV-health").addOn).not.toContain("[PLACEHOLDER");
    expect(rule("NV-health").verified).toBe(false);
  });

  it("go into the privacy policy just before Contact us", () => {
    const html = renderPolicy("privacy", fields, ADS, stateAddOns(["NV"], { health: false }).map((r) => r.addOn));
    const nevada = html.indexOf("Nevada residents");
    expect(nevada).toBeGreaterThan(html.indexOf("Your privacy rights") > 0 ? html.indexOf("Your privacy rights") : 0);
    expect(nevada).toBeLessThan(html.indexOf("Contact us"));
    expect(html).toContain("We do not sell personal information, but you can still send an opt-out request to office@harborpest.com");
    // The tracking sentence only with tracking on.
    expect(html).toContain('described in our <a href="/cookies/">Cookie Policy</a>, may collect');
    expect(renderPolicy("privacy", fields, NONE, stateAddOns(["NV"], { health: false }).map((r) => r.addOn))).not.toContain("Third parties, such as");
    expect(renderPolicy("privacy", fields, ADS)).not.toContain("Nevada residents");
    expect(renderPolicy("cookies", fields, ADS, ["## Nevada residents\n\nx"])).not.toContain("Nevada residents");
  });

  it("say only what's true for the tracking that's on", () => {
    const ca = stateAddOns(["CA"], { health: false }).map((r) => r.addOn);
    expect(renderPolicy("privacy", fields, ADS, ca)).toContain("tools from Google and Meta");
    expect(renderPolicy("privacy", fields, NONE, ca)).not.toContain("tools from Google and Meta");
  });
});

describe("checks", () => {
  const now = new Date("2026-09-28T18:00:00Z");
  const later = new Date("2027-01-15T18:00:00Z");

  it("count from the repo's date for a verified rule, from an admin's check otherwise", () => {
    expect(lastChecked(rule("CA-ccpa"), null).toISOString().slice(0, 10)).toBe("2026-09-28");
    expect(lastChecked(rule("NV-603a"), null).getTime()).toBe(0);
    expect(staleRules(["CA"], {}, now)).toEqual([]);
    expect(staleRules(["NV"], {}, now).map((r) => r.key)).toEqual(["NV-603a", "NV-health"]);
    expect(staleRules(["CA"], {}, later).map((r) => r.key)).toEqual(["CA-caloppa", "CA-ccpa"]);
    expect(staleRules(["CA"], { "CA-caloppa": new Date("2027-01-10T00:00:00Z") }, later).map((r) => r.key)).toEqual(["CA-ccpa"]);
  });
});

describe("the Privacy laws page", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("keeps the table in step with docs/policies and records an admin's checks", async () => {
    const admin = await seedAdmin(h);
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    await syncPrivacyLaws(h.db);
    const rows = await h.db.select().from(privacyLaw);
    expect(rows).toHaveLength(STATE_LAWS.length);
    expect(rows.find((r) => r.key === "NV-603a")).toMatchObject({ stateName: "Nevada", wording: rule("NV-603a").addOn, lastCheckedAt: null });

    await expect(markLawChecked(h.ctx, pm.viewer, "NV-603a")).rejects.toThrow(PrivacyLawError);
    await expect(markLawChecked(h.ctx, admin.viewer, "XX-none")).rejects.toThrow("isn't in the list");
    await markLawChecked(h.ctx, admin.viewer, "NV-603a");
    const people = new Map([[admin.viewer.id, "Test Admin"]]);
    const { rows: view } = await loadPrivacyLaws(h.db, people);
    const nv = view.find((r) => r.rule.key === "NV-603a")!;
    expect(nv).toMatchObject({ stale: false, checkedBy: "Test Admin" });
    expect(view.find((r) => r.rule.key === "IN-icdpa")!.stale).toBe(true);
    const logged = await h.db.select().from(activityLog).where(eq(activityLog.action, "privacy_law.checked"));
    expect(logged[0]!.valueAfter).toEqual({ law: `Nevada: ${rule("NV-603a").lawName}` });

    // A second sync keeps the check.
    await syncPrivacyLaws(h.db);
    const [again] = await h.db.select().from(privacyLaw).where(eq(privacyLaw.key, "NV-603a"));
    expect(again!.lastCheckedAt).not.toBeNull();
  });

  it("reminds admins every quarter, and the review checks every rule", async () => {
    const admin = await seedAdmin(h);
    expect(await isReviewDue(h.db, new Date("2026-10-15T00:00:00Z"))).toBe(false);
    expect(await isReviewDue(h.db, new Date("2027-01-15T00:00:00Z"))).toBe(true);
    await expect(recordPrivacyReview(h.ctx, admin.viewer, "x")).rejects.toThrow("Say what was checked");
    await recordPrivacyReview(h.ctx, admin.viewer, "Every source opened; no changes.");
    const soon = new Date(Date.now() + 30 * 86_400_000);
    expect(await isReviewDue(h.db, soon)).toBe(false);
    expect(await isReviewDue(h.db, new Date(Date.now() + 100 * 86_400_000))).toBe(true);
    const { rows } = await loadPrivacyLaws(h.db, new Map(), soon);
    expect(rows.every((r) => !r.stale)).toBe(true);
    const [logged] = await h.db.select().from(activityLog).where(eq(activityLog.action, "privacy_law.reviewed"));
    expect(logged!.valueAfter).toEqual({ rules: STATE_LAWS.length, note: "Every source opened; no changes." });
  });

  it("flags a project in a state whose rules haven't been checked for three months", async () => {
    const admin = await seedAdmin(h);
    const nevada = intake((d) => { d.business.state = "NV"; });
    const flags = await privacyLawFlags(h.db, nevada);
    expect(flags).toEqual([expect.stringContaining("Nevada's privacy rules")]);
    expect(await privacyLawFlags(h.db, intake((d) => { d.business.state = "CA"; }), new Date("2026-10-01T00:00:00Z"))).toEqual([]);
    await recordPrivacyReview(h.ctx, admin.viewer, "Every source opened.");
    expect(await privacyLawFlags(h.db, nevada)).toEqual([]);
  });
});
