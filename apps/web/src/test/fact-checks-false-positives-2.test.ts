import { describe, expect, it } from "vitest";

import { confirmedFactsFrom, factIssues, findClaimIssues, labelledPhotoFrames } from "@tawd/core/mockups";
import { emptyIntake } from "@tawd/core/intake";
import { keptMarkdown, phoneProblem } from "@tawd/core/site";

/*
  Batch B, reviewer round 2 (12 November 2026): real sentences that the
  fact and claim checks flagged and should not have, each with the true
  case beside it that must still be flagged. FACT_CHECKS_BLOCK is on, so a
  false alarm costs a paid fix round and holds a concept.
*/

const page = (body: string) => `<!doctype html><html lang="en"><head><title>T</title></head><body><main><h1>Heating</h1>${body}</main></body></html>`;

function intake(change: (d: ReturnType<typeof emptyIntake>) => void = () => {}) {
  const data = emptyIntake();
  data.business.name = "Example Heating Co";
  data.business.phone = "(775) 555-0100";
  data.business.city = "Reno";
  data.business.yearFounded = 2020;
  data.serviceAreas.cities = ["Reno", "Elko"] as never;
  change(data);
  return data;
}
const facts = (change?: (d: ReturnType<typeof emptyIntake>) => void) => confirmedFactsFrom(intake(change));
const ids = (body: string, change?: (d: ReturnType<typeof emptyIntake>) => void) =>
  factIssues(page(body), facts(change), { year: 2026 }).map((i) => `${i.id}:${i.evidence}`);
const claimIds = (body: string, change?: (d: ReturnType<typeof emptyIntake>) => void) =>
  findClaimIssues(page(body), facts(change).claims).map((i) => `${i.id}:${i.evidence}`);

describe("facts: years", () => {
  it("does not read a product's lifespan as the business's age", () => {
    expect(ids("<p>A well-maintained furnace gives 15 to 20 years of service.</p>")).toEqual([]);
    expect(ids("<p>Replace it after 20 years of service.</p>")).toEqual([]);
  });
  it("still reads the business's own years", () => {
    expect(ids("<p>Over 25 years of experience.</p>")).toEqual([expect.stringMatching(/^facts\.years:/)]);
    expect(ids("<p>We have been your neighbours for 30 years.</p>")).toEqual([expect.stringMatching(/^facts\.years:/)]);
    expect(ids("<p>Our crew brings 40 years of service to Reno.</p>")).toEqual([expect.stringMatching(/^facts\.years:/)]);
  });
});

describe("facts: since a year", () => {
  it("does not read a regulation's date as a founding year", () => {
    expect(ids("<p>Since 2023, federal rules require new refrigerants.</p>")).toEqual([]);
  });
  it("still reads a founding claim", () => {
    expect(ids("<p>Serving Reno since 1998.</p>")).toEqual([expect.stringMatching(/^facts\.year:/)]);
    expect(ids("<p>Family owned since 1975.</p>")).toEqual([expect.stringMatching(/^facts\.year:/)]);
    expect(ids("<p>Established in 1990.</p>")).toEqual([expect.stringMatching(/^facts\.year:/)]);
  });
});

describe("facts: people", () => {
  it("does not read heading words as a name", () => {
    expect(ids("<h2>Owner Operated Since 2020</h2>")).toEqual([]);
    expect(ids("<h2>I'm Here To Help</h2>")).toEqual([]);
  });
  it("still reads a real name", () => {
    expect(ids("<p>Owner Dana Whitfield runs the crew.</p>")).toEqual(["facts.name:Owner Dana Whitfield"]);
  });
});

describe("facts: serving lists", () => {
  it("never treats a US state as a town", () => {
    expect(ids("<p>Proudly serving California homeowners.</p>")).toEqual([]);
    expect(ids("<p>Proudly serving North Carolina.</p>")).toEqual([]);
  });
  it("skips the intake's own state", () => {
    const home = (d: ReturnType<typeof emptyIntake>) => {
      d.business.state = "Pacifica";
    };
    expect(ids("<p>Serving Pacifica homeowners.</p>", home)).toEqual([]);
    expect(ids("<p>Serving Pacifica homeowners.</p>")).toEqual(["facts.town:Pacifica"]);
  });
  it("does not read a slogan as a town", () => {
    expect(ids("<h2>Serving Up Comfort</h2>")).toEqual([]);
    expect(ids("<p>Serving Reno and Shelbyville.</p>")).toEqual(["facts.town:Shelbyville"]);
  });
});

describe("facts: ratings", () => {
  it("does not read a date as a rating", () => {
    expect(ids("<p>Last updated 3/5/2026</p>")).toEqual([]);
  });
  it("still reads a rating", () => {
    expect(ids("<p>Rated 4/5 by customers.</p>")).toContainEqual(expect.stringMatching(/^facts\.rating:/));
    expect(ids("<p>4.8 out of 5</p>")).toEqual([expect.stringMatching(/^facts\.rating:/)]);
  });
  it("reads '5 Star Service' once, as a rating, and a spelled-out five-star too", () => {
    expect(ids("<p>5 Star Service</p>")).toEqual(["facts.rating:5 Star"]);
    expect(claimIds("<p>5 Star Service</p>")).toEqual([]);
    expect(ids("<p>Five-star reviews on Google.</p>")).toContainEqual(expect.stringMatching(/^facts\.rating:/));
  });
});

describe("facts: street addresses", () => {
  it("does not read a list of towns with a saint in it as an address", () => {
    expect(ids("<p>Proudly Serving 12 Towns Including St. Helena</p>")).toEqual([]);
  });
  it("still reads a street address", () => {
    expect(ids("<p>Visit 12 Oak Street.</p>")).toEqual(["facts.address:12 Oak Street."]);
  });
});

describe("claims: superlatives", () => {
  it("does not read \"it's best\" as a possessive superlative", () => {
    expect(claimIds("<p>It's best to schedule maintenance in spring.</p>")).toEqual([]);
    expect(claimIds("<p>We find what's best for your home.</p>")).toEqual([]);
    expect(claimIds("<p>That's best left to a professional.</p>")).toEqual([]);
  });
  it("still reads a named possessive", () => {
    expect(claimIds("<p>Springfield's best plumber.</p>")).toContainEqual(expect.stringMatching(/best/i));
  });
  it("does not read 'most reliable option' as a claim about the business", () => {
    expect(claimIds("<p>Heat pumps are the most reliable option for mild winters.</p>")).toEqual([]);
    expect(claimIds("<p>Choose the most reliable heating systems.</p>")).toEqual([]);
  });
  it("still reads 'the most trusted plumber'", () => {
    expect(claimIds("<p>The most trusted plumber in Reno.</p>")).toContainEqual(expect.stringMatching(/most trusted/i));
  });
  it("does not read a step number as '#1'", () => {
    expect(claimIds("<p>Step #1 Call us</p>")).toEqual([]);
    expect(claimIds("<p>Tip #1 Change your filter</p>")).toEqual([]);
  });
  it("still reads '#1' as a ranking", () => {
    expect(claimIds("<p>The area's #1 pest control.</p>")).toContainEqual(expect.stringMatching(/#1/));
  });
});

describe("claims: head counts and financing", () => {
  const withCount = (d: ReturnType<typeof emptyIntake>) => {
    d.business.certifications = [];
  };
  it("does not read '24/7 technicians' as 7 technicians", () => {
    expect(claimIds("<p>Our 24/7 technicians are standing by.</p>", (d) => { withCount(d); d.business.emergency247 = true; })).toEqual([]);
  });
  it("still reads a head count", () => {
    expect(claimIds("<p>We have 12 technicians on call.</p>")).toContainEqual(expect.stringMatching(/12 technicians/));
  });
  it("does not read 'no interest in' as financing", () => {
    expect(claimIds("<p>We have no interest in upselling you.</p>")).toEqual([]);
  });
  it("still reads no-interest financing", () => {
    expect(claimIds("<p>No-interest financing for 12 months.</p>")).toContainEqual(expect.stringMatching(/no-interest/i));
    expect(claimIds("<p>No interest for 12 months.</p>")).toContainEqual(expect.stringMatching(/no interest/i));
  });
});

describe("claims: scope of a guarantee", () => {
  it("'all work' covers everything", () => {
    const warranty = (d: ReturnType<typeof emptyIntake>) => {
      d.process.guarantees = "1-year warranty on all work";
    };
    expect(claimIds("<p>Complete satisfaction guaranteed.</p>", warranty)).toEqual([]);
    expect(claimIds("<p>1-year warranty on parts and labor.</p>", warranty)).toEqual([]);
  });
  it("a bare warranty does not cover parts and labor", () => {
    const warranty = (d: ReturnType<typeof emptyIntake>) => {
      d.process.guarantees = "1-year warranty";
    };
    expect(claimIds("<p>1-year warranty on parts and labor.</p>", warranty)).toContainEqual(expect.stringMatching(/^house\.claim\.overreach:/));
  });
});

describe("claims: a pending old-site value is named", () => {
  it("says the current site claims it and nobody has confirmed it", () => {
    const f = confirmedFactsFrom(intake(), { unconfirmed: [{ key: "process.guarantees", value: "Lifetime warranty" }] });
    expect(f.claims.unconfirmed).toEqual([{ key: "process.guarantees", value: "Lifetime warranty" }]);
    const issue = findClaimIssues(page("<p>Lifetime warranty on every install.</p>"), f.claims).find((i) => i.id === "house.claim.unsupported");
    expect(issue?.message).toContain(`the client's current website says "Lifetime warranty", but nobody has confirmed it yet`);
    expect(issue?.message).toContain("Guarantees and warranties");
    expect(issue?.message).not.toContain("names none");
  });
  it("names the offers and financing the same way, and the plain message stays when nothing is pending", () => {
    const f = confirmedFactsFrom(intake(), {
      unconfirmed: [{ key: "extras.currentOffers", value: "Free estimates" }, { key: "extras.financingAvailable", value: "Yes" }],
    });
    const messages = findClaimIssues(page("<p>Free estimates for all. Financing available.</p>"), f.claims).map((i) => i.message);
    expect(messages.some((m) => m.includes(`current website says "Free estimates", but nobody has confirmed it yet`))).toBe(true);
    expect(messages.some((m) => m.includes(`current website says "Yes", but nobody has confirmed it yet`))).toBe(true);
    const plain = findClaimIssues(page("<p>Lifetime warranty on every install.</p>"), facts().claims);
    expect(plain[0]?.message).toContain("names none");
  });
});

describe("pictures: an inline svg is a picture", () => {
  it("does not flag a frame holding an svg, and still flags an empty classed frame", () => {
    expect(labelledPhotoFrames('<div class="photo-frame"><svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg></div>')).toEqual([]);
    expect(labelledPhotoFrames('<div class="photo-frame"></div>')).toEqual(["(empty photo frame)"]);
    expect(labelledPhotoFrames("<div>Photo: the crew on site</div>")).toEqual(["Photo: the crew on site"]);
  });
});

describe("keptMarkdown: the promoted heading", () => {
  const h = (level: 1 | 2 | 3, text: string) => ({ type: "heading" as const, level, text });
  const p = (text: string) => ({ type: "p" as const, text });
  it("does not promote a heading that is just 'Home'", () => {
    const { markdown } = keptMarkdown({ blocks: [h(2, "Home"), p("x")], title: "" }, "Home");
    expect(markdown).not.toMatch(/^# Home$/m);
    expect(markdown).toContain("[PLACEHOLDER: page heading]");
  });
  it("skips to the next heading that is usable", () => {
    const { markdown } = keptMarkdown({ blocks: [h(2, "Home"), h(2, "Fast drain repair"), p("x")], title: "" }, "Home");
    expect(markdown).toMatch(/^# Fast drain repair$/m);
    expect(markdown).not.toMatch(/^# Home$/m);
  });
  it("strips the 'Home' part of a title", () => {
    expect(keptMarkdown({ blocks: [p("x")], title: "Home | Acme Plumbing" }, "Home").markdown).toMatch(/^# Acme Plumbing$/m);
    expect(keptMarkdown({ blocks: [p("x")], title: "Acme Plumbing - Home" }, "Home").markdown).toMatch(/^# Acme Plumbing$/m);
    expect(keptMarkdown({ blocks: [p("x")], title: "Plumber in Reno | Acme" }, "Home").markdown).toMatch(/^# Plumber in Reno \| Acme$/m);
  });
});

describe("phoneProblem", () => {
  it("refuses an area code or exchange starting with 0 or 1", () => {
    for (const bad of ["(116) 555-0142", "(016) 555-0142", "916 055 0142", "916 155 0142", "1 116 555 0142"]) {
      expect(phoneProblem(bad), bad).toMatch(/is not a US phone number/);
    }
  });
  it("accepts a '#2' extension", () => {
    expect(phoneProblem("916 555 0142 #2")).toBeNull();
    expect(phoneProblem("916-555-0142 x12")).toBeNull();
  });
  it("says letters can't be dialled", () => {
    expect(phoneProblem("916-CALL-NOW")).toMatch(/Letters can't be dialled/);
  });
});
