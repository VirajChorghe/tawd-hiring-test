import { describe, expect, it } from "vitest";

import { FACT_CHECKS_BLOCK, confirmedFactsFrom, descriptionWithoutClaims, factIssues, findClaimIssues } from "@tawd/core/mockups";

/* What a new kind of check gives: "fail" since Jason chose to block on all of them (12 Nov), "warn" when the switch is off. */
const NEW_KIND = FACT_CHECKS_BLOCK ? "fail" : "warn";
import type { ClaimFacts } from "@tawd/core/mockups";
import { runChecklist } from "@tawd/core/site";
import { emptyIntake } from "@tawd/core/intake";

/*
  B2 (audit F-010): the claims guard, rebuilt on the confirmed facts. The
  tests are the audit's own two lists (04-content-accuracy.md section 2):
  27 invented claims that passed, 15 true ones that were flagged, and the four
  cases where one typed word switched a whole group off.
*/

const NONE: ClaimFacts = { guarantees: "", currentOffers: "", financingAvailable: false };
const page = (body: string) => `<!doctype html><html lang="en"><head><title>Plumber</title></head><body><main><section>${body}</section></main></body></html>`;
const evidences = (html: string, facts: ClaimFacts = NONE) => findClaimIssues(html, facts).map((i) => (i.evidence ?? "").toLowerCase());
const caught = (html: string, evidence: RegExp, facts: ClaimFacts = NONE) => evidences(html, facts).some((e) => evidence.test(e));

/* The audit's 27 invented claims. Each passed the old guard with an empty intake. */
const INVENTED: [string, string, RegExp][] = [
  ["1 possessive best", "<p>Springfield's best plumber.</p>", /best/],
  ["2 No. 1", "<p>Rated No. 1 in Springfield.</p>", /no\. 1/],
  ["3 Number 1", "<p>Number 1 for drains.</p>", /number 1/],
  ["4 #1 any noun", "<p>The area's #1 pest control.</p>", /#1/],
  // 5 and 6 (5-star, five-star) moved: they are a rating, and B1's factIssues reads them once as facts.rating
  // (fact-checks-false-positives-2.test.ts). Reading them here too raised two findings for one phrase.
  ["7 most trusted", "<p>The most trusted plumber around.</p>", /most trusted/],
  ["8 leading", "<p>The leading plumber in town.</p>", /leading/],
  ["9 premier", "<p>A premier plumber for your home.</p>", /premier/],
  ["10 highest rated", "<p>Highest rated on Google.</p>", /highest rated/],
  ["11 licensed bonded insured", "<p>Licensed, bonded and insured.</p>", /licensed/],
  ["11b bonded", "<p>Licensed, bonded and insured.</p>", /bonded/],
  ["11c insured", "<p>Licensed, bonded and insured.</p>", /insured/],
  ["12 background-checked", "<p>Background-checked technicians.</p>", /background-checked/],
  ["13 A+ BBB", "<p>A+ rating with the Better Business Bureau.</p>", /a\+/],
  ["14 EPA and NATE", "<p>EPA and NATE certified technicians.</p>", /epa and nate certified/],
  ["15 24/7", "<p>24/7 emergency service.</p>", /24\/7/],
  ["16 same-day", "<p>Same-day appointments.</p>", /same-day/],
  ["17 our promise", "<p>Our promise: if you are not happy, we come back and fix it at no charge.</p>", /not happy|no charge/],
  ["18 for life", "<p>We stand behind our work for life.</p>", /for life/],
  ["19 price match", "<p>We will match any written price.</p>", /match any written price/],
  ["20 10% discount", "<p>10% discount for new customers.</p>", /10% discount/],
  ["21 save $50", "<p>Save $50 today.</p>", /save \$50/],
  ["22 half off", "<p>Half off your first visit.</p>", /half off/],
  ["23 senior and military", "<p>Senior and military discounts available.</p>", /senior and military discounts/],
  ["24 second opinion", "<p>Free second opinion.</p>", /second opinion/],
  ["25 free diagnostic", "<p>Free diagnostic with repair.</p>", /diagnostic/],
  ["26 no trip charge", "<p>No trip charge.</p>", /no trip charge/],
  ["27 $0 down", "<p>$0 down.</p>", /\$0 down/],
  ["28 pay over time", "<p>Pay over time with low monthly payments.</p>", /pay over time/],
  // The two the old guard read as negations.
  ["29 no obligation free estimate", "<p>Get a no obligation free estimate today.</p>", /free estimate/],
  ["30 can't beat our warranty", "<p>You can't beat our warranty.</p>", /warranty/],
  ["31 not only a 10-year warranty", "<p>Not only a 10-year warranty, but a promise.</p>", /warranty/],
  // Where it reads: alt text, the meta description, JSON-LD.
  ["32 alt text", '<img src="/a.jpg" alt="Our award-winning team">', /award-winning/],
  ["33 JSON-LD award", '<script type="application/ld+json">{"@type":"Plumber","award":"Best of Springfield 2024"}</script>', /award: best of springfield 2024/],
  ["34 job and head count", "<p>Over 5,000 jobs completed by our 15 technicians.</p>", /5,000|5000/],
  ["35 family owned", "<p>Family owned, serving Springfield since 1987.</p>", /family owned/],
];

describe("the audit's invented claims are all caught", () => {
  it.each(INVENTED)("%s", (_name, body, evidence) => {
    expect(caught(page(body), evidence)).toBe(true);
  });

  it("the meta description is read", () => {
    const html = `<!doctype html><html><head><title>Plumber</title><meta name="description" content="Licensed and insured. 24/7 emergency service."></head><body><main><section><p>Hello.</p></section></main></body></html>`;
    expect(caught(html, /24\/7/)).toBe(true);
  });

  /*
    Not in claims.ts, on purpose: prices, ratings, founding years and towns are
    B1's factIssues (report-only), and the claims guard must not say them twice.
  */
  it("a rating, a review count and a year are caught by B1's factIssues", () => {
    const data = emptyIntake();
    data.business.yearFounded = 1998 as never;
    const facts = confirmedFactsFrom(data);
    const ld = '<script type="application/ld+json">{"@type":"Plumber","aggregateRating":{"ratingValue":"4.9","reviewCount":"312"}}</script>';
    const found = factIssues(page(`<p>Serving Springfield since 1987.</p><p>4.9 stars from 312 Google reviews.</p>${ld}`), facts).map((i) => i.id);
    expect(found).toEqual(expect.arrayContaining(["facts.year", "facts.rating"]));
  });
});

/* The audit's 15 true or harmless sentences. The old guard flagged 13 of them. */
const TRUE_FACTS_FOR: Record<string, ClaimFacts> = {
  "one-year": { ...NONE, guarantees: "one-year warranty on labor" },
  "12 months": { ...NONE, guarantees: "Warranty: 12 months on labor" },
  // "Payment plans are available for most cases." is financing: it is true here because the client ticked the box.
  // With the box unticked it IS flagged, on purpose (a payment plan is the same claim as financing).
  financing: { ...NONE, financingAvailable: true },
};
const TRUE: [string, string, ClaimFacts][] = [
  ["best fit", "<p>We help you find the best fit for your home and budget.</p>", NONE],
  ["best job we can", "<p>We do the best job we can on every visit.</p>", NONE],
  ["best of both worlds", "<p>A tankless heater gives you the best of both worlds.</p>", NONE],
  ["manufacturer warranty repairs", "<p>We do manufacturer warranty repairs on Carrier and Trane units.</p>", NONE],
  ["home warranty companies", "<p>We work with home warranty companies.</p>", NONE],
  ["manufacturer's warranty", "<p>Every water heater we install carries the manufacturer's warranty.</p>", NONE],
  ["1-year vs one-year", "<p>Every repair has a 1-year warranty.</p>", TRUE_FACTS_FOR["one-year"]!],
  ["12-month vs 12 months", "<p>Our 12-month warranty covers labor.</p>", TRUE_FACTS_FOR["12 months"]!],
  ["1-year vs 12 months", "<p>Every repair has a 1-year warranty.</p>", TRUE_FACTS_FOR["12 months"]!],
  ["free estimate button", '<a href="/contact" class="btn">Get a free estimate</a>', NONE],
  ["special offers link", '<a href="/offers">Special offers</a>', NONE],
  ["payment plans", "<p>Payment plans are available for most cases.</p>", TRUE_FACTS_FOR.financing!],
  ["number one priority", "<p>Your safety is our number one priority.</p>", NONE],
  ["top-rated Rheem", "<p>We install top-rated Rheem water heaters.</p>", NONE],
  ["#1 priority", "<p>Your safety is our #1 priority.</p>", NONE],
  ["street #1", "<p>Visit us at 123 Main St #1, Sacramento.</p>", NONE],
];

describe("the audit's true sentences are not flagged", () => {
  it.each(TRUE)("%s", (_name, body, facts) => {
    expect(findClaimIssues(page(body), facts)).toEqual([]);
  });

  it("a button is not a claim, but the same words as a sentence are checked against the client's words", () => {
    expect(findClaimIssues(page('<button type="submit">Free quote</button>'), NONE)).toEqual([]);
    expect(caught(page("<p>Free estimates on every job.</p>"), /free estimates/)).toBe(true);
    // The client's own words back it, in whichever field they were written.
    const quoting = { ...NONE, statedText: "We give free estimates on every job." };
    expect(findClaimIssues(page("<p>Free estimates on every job.</p>"), quoting)).toEqual([]);
    const offers = { ...NONE, currentOffers: "Free estimates for everyone" };
    expect(findClaimIssues(page("<p>Free quotes on every job.</p>"), offers)).toEqual([]);
  });

  it("a long link sentence is still read", () => {
    expect(caught(page('<a href="/x">Call today for a free estimate on your next big project with us</a>'), /free estimate/)).toBe(true);
  });
});

describe("one typed word no longer switches a whole group off", () => {
  it("a different offer is not excused by a filled Current offers", () => {
    const facts = { ...NONE, currentOffers: "10% off first service" };
    const found = findClaimIssues(page("<p>Free estimates. $500 off a repipe.</p>"), facts);
    expect(found.map((i) => (i.evidence ?? "").toLowerCase())).toEqual(expect.arrayContaining(["$500 off"]));
    expect(caught(page("<p>Free estimates. $500 off a repipe.</p>"), /free estimates/, facts)).toBe(true);
    // And the offer the client did give is fine.
    expect(findClaimIssues(page("<p>10% off first service.</p>"), facts)).toEqual([]);
  });

  it("a ticked financing box backs a general mention, not a specific term", () => {
    const facts = { ...NONE, financingAvailable: true };
    expect(findClaimIssues(page("<p>Financing available.</p>"), facts)).toEqual([]);
    expect(caught(page("<p>0% APR financing for 60 months.</p>"), /0% apr/, facts)).toBe(true);
    expect(findClaimIssues(page("<p>0% APR financing for 60 months.</p>"), { ...facts, statedText: "Financing at 0% APR for 60 months." })).toEqual([]);
  });

  it("a guarantee is compared with what the field says", () => {
    const satisfaction = { ...NONE, guarantees: "Satisfaction guarantee" };
    const overreach = (html: string, facts: ClaimFacts) => findClaimIssues(page(html), facts).filter((i) => i.id === "house.claim.overreach");
    expect(overreach("<p>Full warranty on all parts and labor.</p>", satisfaction).length).toBeGreaterThan(0);
    const labor = { ...NONE, guarantees: "1-year labor warranty" };
    expect(overreach("<p>Our warranty covers everything, no questions asked.</p>", labor).length).toBeGreaterThan(0);
    // What the field does say passes.
    expect(overreach("<p>A 1-year warranty on labor.</p>", labor)).toEqual([]);
  });

  it("'for life' against a 1-year warranty, and lifetime against a lifetime one", () => {
    const issues = findClaimIssues(page("<p>We stand behind our work for life.</p>"), { ...NONE, guarantees: "1-year labor warranty" });
    expect(issues.length).toBeGreaterThan(0);
    expect(findClaimIssues(page("<p>We stand behind our work for life.</p>"), { ...NONE, guarantees: "Lifetime workmanship warranty" })).toEqual([]);
  });
});

describe("superlatives need the client's own words", () => {
  it("are backed only by the client", () => {
    expect(caught(page("<p>We are award-winning.</p>"), /award-winning/)).toBe(true);
    expect(findClaimIssues(page("<p>We are award-winning.</p>"), { ...NONE, statedText: "Winner of the 2024 award-winning contractor prize" })).toEqual([]);
    expect(caught(page("<p>The best plumber in town.</p>"), /best/, { ...NONE, statedText: "We never claim to be the best" })).toBe(true);
  });

  it("a possessive 'best' that is not a ranking is left alone", () => {
    expect(findClaimIssues(page("<p>It is in your best interest to call early.</p>"), NONE)).toEqual([]);
    expect(findClaimIssues(page("<p>Suite #1 Sacramento is where we are.</p>"), NONE)).toEqual([]);
  });
});

describe("credentials, hours and counts", () => {
  it("are backed by the licence number, the certifications and the hours the intake has", () => {
    const html = page("<p>Licensed and insured. EPA certified. A+ with the BBB. Open 24/7.</p>");
    expect(findClaimIssues(html, { ...NONE, licensed: true, certifications: "Insured, EPA certified, BBB A+", emergency247: true })).toEqual([]);
    // Missing one: only that one is reported.
    const found = evidences(html, { ...NONE, licensed: true, certifications: "Insured, EPA certified, BBB A+" });
    expect(found.some((e) => e.includes("24/7"))).toBe(true);
    expect(found.some((e) => e.includes("licensed"))).toBe(false);
  });

  it("a count is backed by the client's number", () => {
    expect(findClaimIssues(page("<p>Over 5,000 jobs completed.</p>"), { ...NONE, statedText: "We have done 5000 jobs." })).toEqual([]);
  });

  it("are built into the facts once, in confirmedFactsFrom", () => {
    const data = emptyIntake();
    data.business.licenseNumbers = ["C-36 998811"] as never;
    data.business.certifications = ["NATE certified"] as never;
    data.business.emergency247 = true as never;
    const claims = confirmedFactsFrom(data).claims;
    expect(claims).toMatchObject({ licensed: true, certifications: "NATE certified", emergency247: true });
  });
});

describe("negation", () => {
  it("'no obligation', \"can't beat\" and 'not only' do not negate the claim", () => {
    expect(caught(page("<p>A no obligation free estimate.</p>"), /free estimate/)).toBe(true);
    expect(caught(page("<p>You can't beat our lifetime warranty.</p>"), /warranty/)).toBe(true);
    expect(caught(page("<p>Not only a 10-year warranty.</p>"), /warranty/)).toBe(true);
  });

  it("a genuine negation still is one", () => {
    expect(findClaimIssues(page("<p>We do not offer a free estimate.</p>"), NONE)).toEqual([]);
    expect(findClaimIssues(page("<p>We cannot guarantee a result.</p>"), NONE)).toEqual([]);
  });
});

describe("severity: old kinds fail, new kinds report only", () => {
  const sev = (html: string, evidence: RegExp, facts: ClaimFacts = NONE) => findClaimIssues(page(html), facts).find((i) => evidence.test((i.evidence ?? "").toLowerCase()))?.severity;

  it("keeps fail for what the old guard failed", () => {
    expect(sev("<p>Our lifetime warranty.</p>", /warranty/)).toBe("fail");
    expect(sev("<p>Free consultation.</p>", /free consultation/)).toBe("fail");
    expect(sev("<p>25% off this month.</p>", /25% off/)).toBe("fail");
    expect(sev("<p>The best plumber in Sacramento.</p>", /best/)).toBe("fail");
    expect(sev("<p>Springfield's best plumber.</p>", /best/)).toBe("fail");
    expect(sev("<p>Financing available.</p>", /financing/)).toBe("fail");
  });

  it("gives every new kind the switch's severity", () => {
    for (const [html, ev] of [
      ["<p>Licensed and insured.</p>", /licensed/],
      ["<p>24/7 emergency service.</p>", /24\/7/],
      ["<p>10% discount for new customers.</p>", /10% discount/],
      ["<p>Senior and military discounts.</p>", /discounts/],
      ["<p>If you are not happy, we come back and fix it at no charge.</p>", /not happy|no charge/],
      ["<p>Pay over time.</p>", /pay over time/],
      ['<img src="/a.jpg" alt="Our award-winning team">', /award-winning/],
      ['<script type="application/ld+json">{"award":"Best of Springfield"}</script>', /award/],
    ] as [string, RegExp][]) {
      expect(sev(html, ev), html).toBe(NEW_KIND);
    }
  });

  it("a mismatched offer beside a filled Current offers is a new kind too", () => {
    expect(sev("<p>$500 off a repipe.</p>", /\$500 off/, { ...NONE, currentOffers: "10% off first service" })).toBe(NEW_KIND);
  });

  it("a warn finding never takes a sentence out of the meta description", () => {
    const html = '<meta name="description" content="Licensed and insured. Call us today.">';
    // Built by hand: with the switch on, no check gives "warn" any more, but the rule still holds.
    const issues = [{ id: "house.claim.unsupported", severity: "warn" as const, evidence: "Licensed", message: "m" }];
    expect(descriptionWithoutClaims(html, issues)).toEqual({ html, removed: 0 });
  });
});

describe("the go-live checklist blocks only on fail", () => {
  const files = (body: string) =>
    new Map<string, string>([["index.html", `<html><body><h1>ACME Plumbing</h1>${body}<a href="tel:+19165550142">Call</a></body></html>`]]);
  const claimsItem = (body: string, claims: ClaimFacts = NONE) =>
    runChecklist({ files: files(body), pagePaths: ["/"], domain: "acme.example", mobileOverflow: [], gbpUrl: "", claims }).find((i) => i.key === "claims")!;

  it("a new-kind claim blocks when the switch is on, and is only shown when it is off", () => {
    const item = claimsItem("<p>Licensed and insured.</p>");
    expect(item.detail).toMatch(/licensed/i);
    if (FACT_CHECKS_BLOCK) {
      expect(item.ok).toBe(false);
      expect(item.blocksGoLive).toBe(true);
    } else {
      expect(item.ok).toBe(true);
      expect(item.detail).toMatch(/Reported, not blocking/);
      expect(item.flags?.length).toBeGreaterThan(0);
    }
  });

  it("blocks on a claim the old guard failed too", () => {
    const item = claimsItem("<p>Our lifetime warranty. Licensed and insured.</p>");
    expect(item.ok).toBe(false);
    expect(item.blocksGoLive).toBe(true);
    if (!FACT_CHECKS_BLOCK) expect(item.detail).toMatch(/Also reported, not blocking/);
  });
});

describe("a ranking word about the products, not the business (review of B2)", () => {
  it("leaves 'leading HVAC brands' and 'top-rated Rheem water heaters' alone, and still catches the business", () => {
    expect(evidences(page("<p>We install leading HVAC brands like Carrier and Trane.</p>"))).toEqual([]);
    expect(evidences(page("<p>We install top-rated Rheem water heaters.</p>"))).toEqual([]);
    expect(caught(page("<p>The leading HVAC company in Springfield.</p>"), /leading/)).toBe(true);
    expect(caught(page("<p>A top-rated plumber near you.</p>"), /top-rated/)).toBe(true);
  });
});
