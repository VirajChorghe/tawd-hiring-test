import { describe, expect, it } from "vitest";

import { confirmedFactsFrom, factIssues, findClaimIssues, runHtmlChecks } from "@tawd/core/mockups";
import { emptyIntake } from "@tawd/core/intake";

/*
  The false alarms batch B's read-only count found on real projects
  (12 November 2026), each as a made-up page of the same shape. Every one
  of these was reported before its fix.
*/

const page = (body: string) => `<!doctype html><html lang="en"><head><title>T</title></head><body><main><h1>Well service</h1>${body}</main></body></html>`;

function facts() {
  const data = emptyIntake();
  data.business.name = "Example Well Co";
  data.business.phone = "(775) 555-0100";
  data.business.city = "Reno";
  data.business.licenseNumbers = ["NV Lic #12345", "CA Lic #765432"] as never;
  data.business.locations = [{ name: "Elko", phone: "(775) 555-1234", streetAddress: "Ridge Ct.", city: "Elko", state: "NV" }] as never;
  data.serviceAreas.cities = ["Reno", "Elko"] as never;
  return confirmedFactsFrom(data);
}
const ids = (body: string) => factIssues(page(body), facts()).map((i) => `${i.id}:${i.evidence}`);

describe("the count's false alarms", () => {
  it("does not read a sentence after 'owner' as a person's name", () => {
    expect(ids("<p>That gap is where most owner questions come from.</p>")).toEqual([]);
    expect(ids("<p>The owner went out of his way.</p>")).toEqual([]);
    // A real name after the role is still read.
    expect(ids("<p>Owner Dana Whitfield runs the crew.</p>")).toEqual(["facts.name:Owner Dana Whitfield"]);
  });

  it("does not read the next phrase's first word as a town", () => {
    expect(ids("<p>We serve From Reno to Elko.</p>")).toEqual([]);
    expect(ids("<p>Areas we serve Free estimates for Reno and Elko.</p>")).toEqual([]);
    expect(ids("<p>Serving Reno and Shelbyville.</p>")).toEqual(["facts.town:Shelbyville"]);
  });

  it("does not glue a phone number's last digits onto a street", () => {
    expect(ids("<p>Elko office: (775) 555-1234 Elko Ridge Ct.</p>")).toEqual([]);
    expect(ids("<p>Elko office: 775 555 1234 Elko Ridge Ct.</p>")).toEqual([]);
    expect(ids("<p>Visit 12 Oak Street.</p>")).toEqual(["facts.address:12 Oak Street."]);
  });

  it("accepts a licence the intake typed with its label", () => {
    const f = facts();
    const outcome = runHtmlChecks(page('<p>NV Lic #12345 · CA Lic #765432</p><a href="tel:+17755550100">Call</a><form><label for="n">Name</label><input id="n"></form>'), {
      phones: f.phones,
      licenseNumbers: f.licenseNumbers,
      yearFounded: null,
      businessName: f.businessName,
      cities: [],
    });
    expect(outcome.issues.map((i) => i.id)).not.toContain("house.license.invented");
    // A licence the intake doesn't have still fails.
    const other = runHtmlChecks(page("<p>NV Lic #99999</p>"), { phones: f.phones, licenseNumbers: f.licenseNumbers, yearFounded: null, businessName: f.businessName, cities: [] });
    expect(other.issues.map((i) => i.id)).toContain("house.license.invented");
  });

  it("treats a button drawn as a span as a call to action", () => {
    const claims = facts().claims;
    expect(findClaimIssues(page('<div class="site-header-actions"><span class="site-header-cta kit-button-1">Free quote</span></div>'), claims)).toEqual([]);
    // The same words as a statement are still read.
    expect(findClaimIssues(page("<p>Every job starts with a free quote.</p>"), claims).map((i) => i.id)).toContain("house.claim.unsupported");
  });
});
