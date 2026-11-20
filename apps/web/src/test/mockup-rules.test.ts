import { describe, expect, it } from "vitest";

import {
  assignSkills,
  costOf,
  dealStructure,
  checkWords,
  describeChecks,
  directions,
  estimateFromObserved,
  estimateRun,
  extractHtml,
  GALLERY_MIN_WORK_PHOTOS,
  isCreativeBusiness,
  paletteFamily,
  preselectDirections,
  runHtmlChecks,
  skillIds,
  structureBlock,
  type CheckFacts,
  type PreselectInput,
} from "@tawd/core/mockups";

/*
  The engine's rules on their own: which directions get picked, what the
  checks catch, and what a run costs. No database, no network, no browser.
*/

function preselect(overrides: Partial<PreselectInput> = {}) {
  return preselectDirections({
    trade: "plumbing",
    moodWords: [],
    hasBrandGuide: false,
    hasFoundingYear: true,
    conceptCount: 3,
    ...overrides,
  });
}

// A3+C1 (the design-skills diagnosis): every non-gallery direction carries structural
// variants, and code deals one shape per concept so concepts can't converge on one skeleton.
describe("the dealt structure", () => {
  it("every direction but Gallery and the designer's has variant pools, and the deal is stable and binding", () => {
    for (const d of Object.values(directions)) {
      if (d.id === "gallery_portfolio") continue;
      expect(d.structure, d.id).toBeDefined();
      expect(d.structure!.heroes.length).toBeGreaterThanOrEqual(2);
    }
    // Stable: the same project, direction and label always deal the same shape (fix rounds rebuild it).
    const a1 = dealStructure("classic_trust", "Clear Sky Awning", "A");
    const a2 = dealStructure("classic_trust", "Clear Sky Awning", "A");
    expect(a1).toEqual(a2);
    expect(a1).not.toBeNull();
    // Sibling concepts in one project lean to different heroes.
    const b = dealStructure("classic_trust", "Clear Sky Awning", "B");
    expect(b!.hero).not.toBe(a1!.hero);
    // CodeRabbit on PR #56: all three labels get distinct structures (A and C used to collide).
    const c = dealStructure("classic_trust", "Clear Sky Awning", "C");
    expect(new Set([a1, b, c].map((s) => JSON.stringify(s))).size).toBe(3);
    // Different projects in the same direction spread across the shapes (the anti-re-skin point):
    // over a handful of clients, more than one distinct triple must occur.
    const seeds = ["Sample Plumbing Co.", "Harbor Pest Control", "Rio Glass", "Acme Pest Control", "Valley Roofing"];
    const shapes = new Set(seeds.map((s) => JSON.stringify(dealStructure("classic_trust", s, "A"))));
    expect(shapes.size).toBeGreaterThanOrEqual(2);
    // No pools, no deal: the designer's concept and Gallery keep their own rules.
    expect(dealStructure("designer", "Clear Sky Awning", "A")).toBeNull();
    expect(dealStructure("gallery_portfolio", "Clear Sky Awning", "A")).toBeNull();
    // The block is binding but honest about material limits.
    expect(structureBlock(a1!)).toContain("dealt by TAWD");
    expect(structureBlock(a1!)).toContain(a1!.hero);
  });
});

/*
  The studied reference sites decide before a guess made from words
  (Jason's run, 10 November 2026).

  Clear Sky Awning was proposed Premium Upscale while TAWD's own card said
  "None of the 3 studied reference sites lean this way (they lean to
  Classic Trust, Bright and Friendly, Rugged Craftsman)". It knew, it said
  so on the screen, and it proposed the other thing anyway, so Jason
  changed the direction by hand before paying for the run.

  The cause was the order the rules ran in: the references were applied
  with the other inputs, and then the "creative business" rule rebuilt the
  order on top of them.
*/
describe("what the reference sites lean to", () => {
  const refs = (directions: (string | null)[]) => ({
    colors: [],
    colorsFrom: "none" as const,
    photos: { count: 7, people: 0, work: 2 },
    references: directions.map((closestDirection, i) => ({ url: `https://ref-${i}.example/`, studied: true, closestDirection: closestDirection as never })),
  });

  /* A creative-reading business, which is what put Premium Upscale in front. */
  const proposal = (leans: (string | null)[]) =>
    preselectDirections({
      trade: "interior_design",
      moodWords: [],
      hasBrandGuide: false,
      hasFoundingYear: true,
      conceptCount: 3,
      creative: true,
      inputs: refs(leans),
    });

  it("does not lead with a direction every studied reference leans away from", () => {
    const picks = proposal(["classic_trust", "bright_friendly", "rugged_craftsman"]).concepts.map((c) => c.direction);
    expect(picks[0], `led with ${picks[0]} while the references lean elsewhere`).not.toBe("premium_upscale");
    // The leading pick is one the references actually point to.
    expect(["classic_trust", "bright_friendly", "rugged_craftsman"]).toContain(picks[0]);
  });

  it("gives the direction two references agree on the lead", () => {
    const picks = proposal(["rugged_craftsman", "rugged_craftsman", "classic_trust"]).concepts.map((c) => c.direction);
    expect(picks[0]).toBe("rugged_craftsman");
  });

  it("leads with the direction most references agree on, when two directions each have two or more", () => {
    const picks = proposal(["rugged_craftsman", "rugged_craftsman", "rugged_craftsman", "classic_trust", "classic_trust"]).concepts.map((c) => c.direction);
    expect(picks[0]).toBe("rugged_craftsman");
    expect(picks[1]).toBe("classic_trust");
  });

  it("leaves the proposal alone when nothing has been studied", () => {
    const picks = proposal([null, null, null]).concepts.map((c) => c.direction);
    // No votes, so the creative reading still carries it: this change only adds the references' say.
    expect(picks[0]).toBe("premium_upscale");
  });

  it("still lets a brand guide lead, because that is the client's own instruction", () => {
    const picks = preselectDirections({
      trade: "interior_design",
      moodWords: [],
      hasBrandGuide: true,
      hasFoundingYear: true,
      conceptCount: 3,
      creative: true,
      inputs: refs(["classic_trust", "classic_trust", "classic_trust"]),
    }).concepts.map((c) => c.direction);
    expect(picks[0]).toBe("brand_led");
    // And the references still get their place, right behind it.
    expect(picks).toContain("classic_trust");
  });
});

// B4 (the design-skills diagnosis): Gallery is only dealt with enough real work photos to fill a portfolio.
describe("Gallery and Portfolio needs real work photos", () => {
  const inputsWith = (work: number) => ({ colors: [], colorsFrom: "none" as const, photos: { count: work, people: 0, work }, references: [] });
  const pick = (work: number) =>
    preselectDirections({ trade: "interior_design", moodWords: [], hasBrandGuide: false, hasFoundingYear: true, conceptCount: 3, inputs: inputsWith(work) });

  it("leads with Gallery for a creative trade with a real portfolio, and holds it back when photos are short", () => {
    expect(pick(GALLERY_MIN_WORK_PHOTOS).concepts.map((c) => c.direction)).toContain("gallery_portfolio");
    const starved = pick(GALLERY_MIN_WORK_PHOTOS - 1);
    expect(starved.concepts.map((c) => c.direction)).not.toContain("gallery_portfolio");
    // The note says why, with the count; and no contradictory "Gallery leads" note is left behind.
    expect(starved.notes.some((n) => n.includes(`at least ${GALLERY_MIN_WORK_PHOTOS} photos`))).toBe(true);
    expect(starved.notes.some((n) => n.includes("Gallery and Portfolio leads"))).toBe(false);
    // Premium Upscale carries the creative look meanwhile.
    expect(starved.concepts.map((c) => c.direction)).toContain("premium_upscale");
  });

  // CodeRabbit on PR #58.
  it("an uncounted portfolio is not a portfolio, and a reference vote for Gallery leaves no contradicting note", () => {
    const unknown = preselectDirections({ trade: "interior_design", moodWords: [], hasBrandGuide: false, hasFoundingYear: true, conceptCount: 3 });
    expect(unknown.concepts.map((c) => c.direction)).not.toContain("gallery_portfolio");
    expect(unknown.notes.some((n) => n.includes("haven't been counted yet"))).toBe(true);
    const voted = preselectDirections({
      trade: "interior_design", moodWords: [], hasBrandGuide: false, hasFoundingYear: true, conceptCount: 3,
      inputs: { ...inputsWith(2), references: [{ url: "https://example.com", studied: true, closestDirection: "gallery_portfolio" as const }] },
    });
    expect(voted.concepts.map((c) => c.direction)).not.toContain("gallery_portfolio");
    expect(voted.notes.some((n) => n.includes("Gallery and Portfolio") && n.includes("one of the picks"))).toBe(false);
  });
});

describe("picking directions", () => {
  it("always includes Bold Emergency for an emergency trade", () => {
    for (const trade of ["plumbing", "hvac", "garage_doors"] as const) {
      const result = preselect({ trade });
      expect(
        result.concepts.map((c) => c.direction),
        `${trade} should get Bold Emergency`,
      ).toContain("bold_emergency");
    }
  });

  it("says why Bold Emergency is there", () => {
    const result = preselect({ trade: "plumbing" });
    expect(result.notes.join(" ")).toMatch(/emergency trade/i);
  });

  it("does not force Bold Emergency on a law firm", () => {
    const result = preselect({ trade: "legal" });
    expect(result.concepts.map((c) => c.direction)).not.toContain(
      "bold_emergency",
    );
    expect(result.concepts.map((c) => c.direction)).toContain("classic_trust");
  });

  it("gives every concept a different design skill", () => {
    for (const trade of [
      "plumbing",
      "legal",
      "med_spa",
      "roofing",
      "electrical",
      "home_services",
      "other",
    ] as const) {
      const result = preselect({ trade });
      const used = result.concepts.map((c) => c.skillId);
      expect(new Set(used).size, `${trade} reused a skill`).toBe(used.length);
    }
  });

  it("gives every concept a different direction", () => {
    const result = preselect({ trade: "med_spa" });
    const used = result.concepts.map((c) => c.direction);
    expect(new Set(used).size).toBe(used.length);
  });

  it("returns exactly as many concepts as asked for", () => {
    for (const count of [1, 2, 3]) {
      expect(preselect({ conceptCount: count }).concepts).toHaveLength(count);
    }
  });

  it("keeps the required direction even when only one concept is wanted", () => {
    const result = preselect({ trade: "plumbing", conceptCount: 1 });
    expect(result.concepts[0]?.direction).toBe("bold_emergency");
  });

  it("labels the concepts A, B and C", () => {
    expect(preselect().concepts.map((c) => c.label)).toEqual(["A", "B", "C"]);
  });

  it("leads with Brand-Led when the client supplied a brand guide", () => {
    const result = preselect({ hasBrandGuide: true });
    expect(result.concepts.map((c) => c.direction)).toContain("brand_led");
    expect(result.notes.join(" ")).toMatch(/brand guide/i);
  });

  it("never offers Heritage without a founding year to stand behind", () => {
    const result = preselect({
      trade: "other",
      hasFoundingYear: false,
      conceptCount: 3,
    });
    expect(result.concepts.map((c) => c.direction)).not.toContain(
      "heritage_established",
    );
  });

  it("moves a direction down the list when a competitor nearby has it", () => {
    const clean = preselect({ trade: "legal" });
    const withClash = preselect({
      trade: "legal",
      usedNearby: ["classic_trust"],
    });

    expect(clean.concepts[0]?.direction).toBe("classic_trust");
    expect(withClash.concepts[0]?.direction).not.toBe("classic_trust");
    expect(withClash.notes.join(" ")).toMatch(/already used/i);
  });

  it("takes premium mood words seriously", () => {
    const result = preselect({
      trade: "glass_and_windows",
      moodWords: ["luxury", "refined"],
    });
    expect(result.concepts.map((c) => c.direction)).toContain(
      "premium_upscale",
    );
  });

  it("only ever uses skills that exist", () => {
    const result = preselect();
    for (const concept of result.concepts) {
      expect(skillIds).toContain(concept.skillId);
      expect(directions[concept.direction]).toBeDefined();
    }
  });
});

describe("the palette family, for the design log", () => {
  it("groups near-identical colors together", () => {
    expect(paletteFamily("#1D5B4C")).toBe("green");
    expect(paletteFamily("#1F5F4E")).toBe("green");
  });

  it("tells genuinely different colors apart", () => {
    expect(paletteFamily("#1F4E79")).toBe("blue");
    expect(paletteFamily("#B42318")).toBe("red");
    expect(paletteFamily("#F2D024")).toBe("yellow");
    // Amber sits between the two and lands in orange, which is close enough
    // for "has a competitor nearby already used this look".
    expect(paletteFamily("#E8C47A")).toBe("orange");
  });

  it("copes with short hex and with nonsense", () => {
    expect(paletteFamily("#1a5")).toBe("green");
    expect(paletteFamily("not a color")).toBeNull();
    expect(paletteFamily(null)).toBeNull();
  });
});

/* ---------- the checks ---------- */

const facts: CheckFacts = {
  phones: ["(916) 555-0147"],
  licenseNumbers: ["C36-123456"],
  yearFounded: 2009,
  businessName: "Tulemark Plumbing",
  cities: ["Sacramento"],
};

function page(body: string, head = ""): string {
  return `<!doctype html><html lang="en"><head><title>Emergency Plumbing in Sacramento</title>
<meta name="description" content="Tulemark Plumbing fixes burst pipes and blocked drains across Sacramento, day or night.">${head}</head>
<body>${body}</body></html>`;
}

const goodBody = `
<h1>Emergency Plumbing in Sacramento</h1>
<a href="tel:+19165550147">(916) 555-0147</a>
<p>License C36-123456. Serving Sacramento since 2009.</p>
<form><label for="name">Name</label><input id="name" type="text">
<label for="phone">Phone</label><input id="phone" type="tel">
<button type="submit">Request a call back</button></form>
<div class="frame">Photo: crew and truck outside a job</div>`;

describe("the mechanical checks", () => {
  it("passes a page that does everything right", () => {
    const outcome = runHtmlChecks(page(goodBody), facts);
    expect(outcome.issues.filter((i) => i.severity === "fail")).toEqual([]);
    expect(outcome.passed).toBe(true);
  });

  it("catches a missing H1, and two H1s", () => {
    expect(
      runHtmlChecks(page(goodBody.replace(/<h1>.*?<\/h1>/, "")), facts).issues.map(
        (i) => i.id,
      ),
    ).toContain("structure.h1.missing");

    expect(
      runHtmlChecks(page(`${goodBody}<h1>Another</h1>`), facts).issues.map(
        (i) => i.id,
      ),
    ).toContain("structure.h1.multiple");
  });

  it("catches a phone number that is not a tap-to-call link", () => {
    const outcome = runHtmlChecks(
      page(goodBody.replace(/<a href="tel:[^"]*">/, "<span>").replace("</a>", "</span>")),
      facts,
    );
    expect(outcome.issues.map((i) => i.id)).toContain("conversion.tel.missing");
    expect(outcome.passed).toBe(false);
  });

  it("catches a missing form and unlabelled fields", () => {
    expect(
      runHtmlChecks(page(goodBody.replace(/<form>[\s\S]*<\/form>/, "")), facts)
        .issues.map((i) => i.id),
    ).toContain("conversion.form.missing");

    expect(
      runHtmlChecks(
        page(goodBody.replace('<label for="name">Name</label>', "")),
        facts,
      ).issues.map((i) => i.id),
    ).toContain("a11y.labels");
  });

  it("accepts a field labeled by aria-label instead", () => {
    const outcome = runHtmlChecks(
      page(
        goodBody.replace(
          '<label for="name">Name</label><input id="name" type="text">',
          '<input aria-label="Name" type="text">',
        ),
      ),
      facts,
    );
    expect(outcome.issues.map((i) => i.id)).not.toContain("a11y.labels");
  });

  it("catches an image with no alt text", () => {
    const outcome = runHtmlChecks(page(`${goodBody}<img src="x.png">`), facts);
    expect(outcome.issues.map((i) => i.id)).toContain("a11y.alt");
  });

  it("catches an over-long title and meta description", () => {
    const outcome = runHtmlChecks(
      `<!doctype html><html><head><title>${"a".repeat(80)}</title>
<meta name="description" content="${"b".repeat(200)}"></head><body>${goodBody}</body></html>`,
      facts,
    );
    const ids = outcome.issues.map((i) => i.id);
    expect(ids).toContain("seo.title.long");
    expect(ids).toContain("seo.description.long");
  });

  it("refuses an image pulled off the internet", () => {
    const outcome = runHtmlChecks(
      page(`${goodBody}<img src="https://picsum.photos/800" alt="A photo">`),
      facts,
    );
    expect(outcome.issues.map((i) => i.id)).toContain("images.remote");
    expect(outcome.passed).toBe(false);
  });

  it("allows a Google Fonts link", () => {
    const outcome = runHtmlChecks(
      page(goodBody, '<link href="https://fonts.googleapis.com/css2?family=X" rel="stylesheet">'),
      facts,
    );
    expect(outcome.passed).toBe(true);
  });
});

describe("the house rules: nothing invented", () => {
  it("accepts the phone number the intake gave, in any format", () => {
    for (const written of ["(916) 555-0147", "916-555-0147", "916.555.0147"]) {
      const outcome = runHtmlChecks(
        page(goodBody.replace("(916) 555-0147", written)),
        facts,
      );
      expect(
        outcome.issues.map((i) => i.id),
        `${written} should be accepted`,
      ).not.toContain("house.phone.invented");
    }
  });

  it("refuses a phone number that came from nowhere", () => {
    const outcome = runHtmlChecks(
      page(goodBody.replace("(916) 555-0147", "(916) 555-0199")),
      facts,
    );
    expect(outcome.issues.map((i) => i.id)).toContain("house.phone.invented");
    expect(outcome.passed).toBe(false);
  });

  it("refuses a license number that came from nowhere", () => {
    const outcome = runHtmlChecks(
      page(goodBody.replace("C36-123456", "C36-999999")),
      facts,
    );
    expect(outcome.issues.map((i) => i.id)).toContain("house.license.invented");
  });

  it("refuses an invented rating or review count", () => {
    for (const claim of [
      "Rated 4.9 out of 5",
      "Over 300 five-star reviews",
      "rating of 4.8",
    ]) {
      const outcome = runHtmlChecks(page(`${goodBody}<p>${claim}</p>`), facts);
      expect(
        outcome.issues.map((i) => i.id),
        `"${claim}" should be refused`,
      ).toContain("house.reviews.invented");
    }
  });

  it("accepts the same claim inside a visible placeholder", () => {
    const outcome = runHtmlChecks(
      page(`${goodBody}<p>[PLACEHOLDER: real Google review, rated 4.9 out of 5]</p>`),
      facts,
    );
    expect(outcome.issues.map((i) => i.id)).not.toContain(
      "house.reviews.invented",
    );
    expect(outcome.placeholderCount).toBe(1);
  });

  it("refuses a founding year when the intake has none", () => {
    const outcome = runHtmlChecks(page(goodBody), {
      ...facts,
      yearFounded: null,
    });
    expect(outcome.issues.map((i) => i.id)).toContain("house.year.invented");
  });

  it("accepts the founding year the intake does have", () => {
    const outcome = runHtmlChecks(page(goodBody), facts);
    expect(outcome.issues.map((i) => i.id)).not.toContain(
      "house.year.invented",
    );
  });

  it("flags filler words", () => {
    const outcome = runHtmlChecks(
      page(`${goodBody}<p>We elevate your plumbing with seamless service.</p>`),
      facts,
    );
    const ids = outcome.issues.map((i) => i.id);
    expect(ids).toContain("house.filler.elevate");
    expect(ids).toContain("house.filler.seamless");
  });

  it("counts placeholders so the team can see how many remain", () => {
    const outcome = runHtmlChecks(
      page(
        `${goodBody}<p>[PLACEHOLDER: real Google review]</p><p>[PLACEHOLDER: years in business]</p>`,
      ),
      facts,
    );
    expect(outcome.placeholderCount).toBe(2);
  });

  it("summarizes for the progress screen", () => {
    expect(describeChecks(runHtmlChecks(page(goodBody), facts))).toBe(
      "All passed",
    );
    expect(
      describeChecks(
        runHtmlChecks(page(goodBody.replace(/<h1>.*?<\/h1>/, "")), facts),
      ),
    ).toMatch(/1 fix/);
  });

  /*
    Jason's run, 10 November 2026: one concept card read "1 fix:
    headingonecolumn" - a check id with the dots taken out - and the other
    read "2 fixes needed", naming nothing. The summary is read by the team
    on the generating screen and kept on the step row, so it has to be in
    words.
  */
  it("says what the fixes ARE, in words, never a check id", () => {
    const one = describeChecks({ passed: false, placeholderCount: 0, issues: [{ id: "layout.headingOneColumn", severity: "fail", message: "x" }] });
    expect(one).toBe("1 fix: a heading squeezed into one column");

    const two = describeChecks({
      passed: false,
      placeholderCount: 0,
      issues: [
        { id: "a11y.contrast", severity: "fail", message: "x" },
        { id: "render.footer", severity: "fail", message: "x" },
      ],
    });
    expect(two).toBe("2 fixes: text that cannot be read, no footer");

    const many = describeChecks({
      passed: false,
      placeholderCount: 0,
      issues: [
        { id: "a11y.contrast", severity: "fail", message: "x" },
        { id: "render.footer", severity: "fail", message: "x" },
        { id: "seo.title", severity: "fail", message: "x" },
        { id: "images.empty", severity: "fail", message: "x" },
      ],
    });
    expect(many).toBe("4 fixes: text that cannot be read, no footer, and 2 more");

    // A warning is not a fix, and an issue only the intake can answer never counts as one.
    expect(describeChecks({ passed: true, placeholderCount: 0, issues: [{ id: "icons.noIcon", severity: "warn", message: "x" }] })).toBe("Passed, 1 to look at");
    expect(describeChecks({ passed: true, placeholderCount: 0, issues: [{ id: "conversion.callButton", severity: "fail", message: "x", needsIntake: true }] })).toBe("Passed, 1 to look at");
  });

  it("an id nobody has written words for still reads as words", () => {
    expect(checkWords("something.weHaveNotSeenYet")).toBe("we have not seen yet");
    expect(checkWords("a11y.contrast")).toBe("text that cannot be read");
  });
});

describe("what a run costs", () => {
  const config = {
    model: "claude-opus-5-5",
    inputPricePerMTok: 5,
    outputPricePerMTok: 25,
  };

  it("charges input and output at their own rates", () => {
    expect(
      costOf({ inputTokens: 1_000_000, outputTokens: 0 }, config),
    ).toBeCloseTo(5);
    expect(
      costOf({ inputTokens: 0, outputTokens: 1_000_000 }, config),
    ).toBeCloseTo(25);
  });

  it("charges a cache read at a twentieth of the input rate on Opus 5.5", () => {
    expect(
      costOf({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }, config),
    ).toBeCloseTo(0.25);
  });

  it("recomputes from the rates, so a price correction fixes old runs", () => {
    const usage = { inputTokens: 100_000, outputTokens: 40_000 };
    const cheaper = costOf(usage, { ...config, outputPricePerMTok: 10 });
    const dearer = costOf(usage, config);
    expect(cheaper).toBeLessThan(dearer);
  });

  it("gives a wider estimate for more concepts", () => {
    const one = estimateRun(1, config);
    const three = estimateRun(3, config);
    expect(three.high).toBeGreaterThan(one.high);
    expect(three.low).toBeGreaterThan(one.low);
  });

  it("states the estimate as a range, in words", () => {
    expect(estimateRun(3, config).label).toMatch(/^Around \$/);
  });

  it("clamps a silly concept count", () => {
    expect(estimateRun(99, config)).toEqual(estimateRun(3, config));
    expect(estimateRun(0, config)).toEqual(estimateRun(1, config));
  });
});

/*
  Once concepts have been built, the estimate comes from what they actually
  cost rather than from the guessed constants, which the first real run
  showed were too low.
*/
describe("estimating from concepts already built", () => {
  const config = {
    model: "claude-opus-5-5",
    inputPricePerMTok: 4,
    outputPricePerMTok: 20,
  };

  // Chosen to cost exactly $1.00 a concept at $4 / $20.
  const observed = {
    concepts: 2,
    inputTokens: 50_000,
    outputTokens: 40_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  it("centers the range on what a concept actually cost", () => {
    const one = estimateFromObserved(1, config, observed);
    expect((one.low + one.high) / 2).toBeCloseTo(1);
  });

  it("scales with the number of concepts", () => {
    const three = estimateFromObserved(3, config, observed);
    expect((three.low + three.high) / 2).toBeCloseTo(3);
    expect(three.outputTokens).toBe(120_000);
  });

  it("narrows the range once there is more to go on", () => {
    const thin = estimateFromObserved(1, config, observed);
    const solid = estimateFromObserved(1, config, { ...observed, concepts: 5 });
    expect(solid.high - solid.low).toBeLessThan(thin.high - thin.low);
  });

  it("says the figure is based on concepts already built", () => {
    expect(estimateFromObserved(3, config, observed).label).toMatch(
      /^Around \$.* in AI costs, plus review time \(based on 2 concepts built so far\)$/,
    );
    expect(
      estimateFromObserved(3, config, { ...observed, concepts: 1 }).label,
    ).toMatch(/based on 1 concept built so far\)$/);
  });

  it("counts cache reads and writes at their own rates", () => {
    const withCache = estimateFromObserved(1, config, {
      ...observed,
      cacheReadTokens: 1_000_000,
    });
    const without = estimateFromObserved(1, config, observed);
    // A million cache-read tokens at Opus 5.5's twentieth of $4 adds $0.20.
    expect(
      (withCache.low + withCache.high) / 2 - (without.low + without.high) / 2,
    ).toBeCloseTo(0.2);
  });

  it("prices cache reads at each model's own rate, as Anthropic bills them", () => {
    const read = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 };
    // Opus 5.5: $0.20 a million (Anthropic's 1-7 October 2026 cost export).
    expect(costOf(read, config)).toBeCloseTo(0.2);
    // Sonnet 5 and Haiku 4.5 read at a tenth of their input price.
    expect(costOf(read, { model: "claude-sonnet-5", inputPricePerMTok: 2, outputPricePerMTok: 10 })).toBeCloseTo(0.2);
    expect(costOf(read, { model: "claude-haiku-4-5", inputPricePerMTok: 1, outputPricePerMTok: 5 })).toBeCloseTo(0.1);
    // Writes are unchanged: 1.25x for five minutes, 2x for an hour.
    expect(costOf({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 }, config)).toBeCloseTo(5);
    expect(costOf({ inputTokens: 0, outputTokens: 0, cacheWrite1hTokens: 1_000_000 }, config)).toBeCloseTo(8);
  });

  it("clamps a silly concept count", () => {
    expect(estimateFromObserved(99, config, observed)).toEqual(
      estimateFromObserved(3, config, observed),
    );
    expect(estimateFromObserved(0, config, observed)).toEqual(
      estimateFromObserved(1, config, observed),
    );
  });
});

describe("reading the model's reply", () => {
  it("takes the HTML straight when that is all there is", () => {
    const html = "<!doctype html><html><body>Hi</body></html>";
    expect(extractHtml(html)).toBe(html);
  });

  it("unwraps a markdown fence if the model adds one", () => {
    const html = "<!doctype html><html><body>Hi</body></html>";
    expect(extractHtml("```html\n" + html + "\n```")).toBe(html);
  });

  it("drops a sentence written before the document", () => {
    const html = "<!doctype html><html><body>Hi</body></html>";
    expect(extractHtml(`Here is the page:\n\n${html}`)).toBe(html);
  });

  // CodeRabbit on PR #56: the signature contract's three lines come before the HTML and never reach the page.
  it("drops the THESIS / FIRST VIEWPORT / SIGNATURE lines written before the document", () => {
    const html = "<!doctype html><html><body><!-- tawd-signature: the patio-cover warranty band -->Hi</body></html>";
    const reply = `THESIS: shade you can trust\nFIRST VIEWPORT: a full-bleed patio photo\nSIGNATURE: the warranty band (from the intake)\n\n${html}`;
    expect(extractHtml(reply)).toBe(html);
  });
});

/*
  The team can change any concept's direction on the setup screen. The
  DIRECTIONS.md rules still hold, and a broken one says why in a sentence.
*/
describe("the team's own direction picks", () => {
  const plumbing = { trade: "plumbing" as const, hasFoundingYear: true };
  const wells = { trade: "well_and_pump" as const, hasFoundingYear: false };

  it("gives each direction the skill that builds it", () => {
    const checked = assignSkills(
      [
        { label: "A", direction: "bold_emergency" },
        { label: "B", direction: "modern_clean" },
        { label: "C", direction: "warm_local" },
      ],
      plumbing,
    );
    expect(checked.problems).toEqual([]);
    expect(checked.concepts.map((c) => c.skillId)).toEqual([
      "ui_ux_pro_max",
      "impeccable",
      "taste",
    ]);
  });

  it("refuses two directions built by the same skill, naming both", () => {
    const checked = assignSkills(
      [
        { label: "A", direction: "rugged_craftsman" },
        { label: "B", direction: "modern_clean" },
      ],
      wells,
    );
    expect(checked.problems).toHaveLength(1);
    expect(checked.problems[0]).toContain("Concepts A and B would both be built with Impeccable");
    expect(checked.problems[0]).toContain("UI UX Pro Max or Taste Skill");
  });

  it("advises Bold Emergency for an emergency trade, without blocking", () => {
    const checked = assignSkills(
      [
        { label: "A", direction: "classic_trust" },
        { label: "B", direction: "modern_clean" },
      ],
      plumbing,
    );
    expect(checked.problems).toEqual([]);
    expect(checked.warnings).toEqual([
      "Plumbing is an emergency trade, and TAWD normally includes Bold Emergency. You can go ahead without it; the choice is logged.",
    ]);
  });

  it("does not insist on it for other trades", () => {
    const checked = assignSkills([{ label: "A", direction: "rugged_craftsman" }], wells);
    expect(checked.problems).toEqual([]);
  });

  it("refuses the same direction twice", () => {
    const checked = assignSkills(
      [
        { label: "A", direction: "brand_led" },
        { label: "B", direction: "brand_led" },
      ],
      wells,
    );
    expect(checked.problems.join(" ")).toContain("are both Brand-Led");
  });

  it("refuses Heritage Established without a founding year", () => {
    const checked = assignSkills([{ label: "A", direction: "heritage_established" }], wells);
    expect(checked.problems[0]).toContain("needs a founding year");
  });

  it("lets Brand-Led take whichever skill is left", () => {
    const checked = assignSkills(
      [
        { label: "A", direction: "brand_led" },
        { label: "B", direction: "classic_trust" },
        { label: "C", direction: "rugged_craftsman" },
      ],
      wells,
    );
    expect(checked.problems).toEqual([]);
    expect(checked.concepts.find((c) => c.label === "A")?.skillId).toBe("taste");
  });

  it("accepts TAWD's own picks for every trade", () => {
    for (const trade of [
      "plumbing",
      "hvac",
      "electrical",
      "roofing",
      "legal",
      "glass_and_windows",
      "garage_doors",
      "well_and_pump",
      "home_services",
      "med_spa",
      "other",
    ] as const) {
      const plan = preselectDirections({
        trade,
        moodWords: [],
        hasBrandGuide: false,
        hasFoundingYear: true,
        conceptCount: 3,
      });
      const checked = assignSkills(
        plan.concepts.map((c) => ({ label: c.label, direction: c.direction })),
        { trade, hasFoundingYear: true },
      );
      expect(checked.problems, trade).toEqual([]);
    }
  });
});

describe("a field id with pattern characters (Semgrep, 26 September 2026)", () => {
  it("is matched as plain text", () => {
    const body = goodBody.replace('<label for="name">Name</label><input id="name" type="text">', '<label for="name(+">Name</label><input id="name(+" type="text">');
    expect(() => runHtmlChecks(page(body), facts)).not.toThrow();
    expect(runHtmlChecks(page(body), facts).issues.map((i) => i.id)).not.toContain("a11y.labels");
  });
});

/* A client with a counted portfolio: B4 only proposes Gallery with at least GALLERY_MIN_WORK_PHOTOS work photos. */
const PORTFOLIO = { colors: [], colorsFrom: "none" as const, photos: { count: 6, people: 0, work: 6 }, references: [] };

describe("Gallery and Portfolio, the 13th direction", () => {
  it("is in the catalog and the dropdown, built with Impeccable", () => {
    expect(directions.gallery_portfolio).toMatchObject({ label: "Gallery and Portfolio", bestSkill: "impeccable" });
  });

  it("leads for a creative business, with two other skills beside it", () => {
    const result = preselect({ trade: "other", creative: true, inputs: PORTFOLIO });
    const picks = result.concepts.map((c) => c.direction);
    expect(picks).toEqual(["gallery_portfolio", "premium_upscale", "classic_trust"]);
    expect(new Set(result.concepts.map((c) => c.skillId)).size).toBe(3);
    expect(result.notes.join(" ")).toMatch(/creative business/i);
  });

  it("is never pre-selected for other businesses", () => {
    for (const trade of ["plumbing", "legal", "home_services", "other"] as const) {
      expect(preselect({ trade }).concepts.map((c) => c.direction)).not.toContain("gallery_portfolio");
    }
  });

  it("keeps Bold Emergency for an emergency trade that remodels", () => {
    const picks = preselect({ trade: "plumbing", creative: true, inputs: PORTFOLIO }).concepts.map((c) => c.direction);
    expect(picks).toContain("bold_emergency");
    expect(picks).toContain("gallery_portfolio");
  });

  it("recognises creative businesses from their words, not painters of interiors", () => {
    expect(isCreativeBusiness(["Oak & Linen Interior Design"])).toBe(true);
    expect(isCreativeBusiness(["Wedding photography"])).toBe(true);
    expect(isCreativeBusiness(["Kitchen remodeling"])).toBe(true);
    expect(isCreativeBusiness(["Interior painting", "Drain cleaning", "Heartfelt service"])).toBe(false);
  });
});

describe("the Gallery and Portfolio prompt", () => {
  it("tells the builder to use only the client's own project photos", async () => {
    const { directionInfo } = await import("@tawd/core/mockups");
    expect(directionInfo("gallery_portfolio").buildNote).toMatch(/visible \[PLACEHOLDER\]/);
  });
});

describe("the creative trades (26 September 2026)", () => {
  const creative = ["interior_design", "art_decorative_finishes", "photography", "architecture_remodeling"] as const;

  it("lead with Gallery and Portfolio, whatever the intake's words say", () => {
    for (const trade of creative) {
      expect(preselect({ trade, inputs: PORTFOLIO }).concepts.map((c) => c.direction), trade).toEqual(["gallery_portfolio", "premium_upscale", "classic_trust"]);
    }
  });

  it("each have suggested services, a label, a search term and a schema type; only remodeling asks for a license", async () => {
    const { SERVICE_SUGGESTIONS, isLicensedTrade } = await import("@tawd/core/intake");
    const { tradeLabels } = await import("@/lib/labels");
    const { tradeTerm } = await import("@/lib/seo-plan");
    const { seoHead } = await import("@tawd/core/site");
    for (const trade of creative) {
      expect(SERVICE_SUGGESTIONS[trade].length, trade).toBeGreaterThanOrEqual(5);
      expect(tradeLabels[trade]).toBeTruthy();
      expect(tradeTerm(trade)).toBeTruthy();
      expect(seoHead({ facts: { name: "X", phone: "", email: "", streetAddress: "", city: "", state: "", isServiceAreaBusiness: true, domain: null, trade, areaServed: [], logoPath: null }, path: "/", kind: "home", title: "X", description: "X" })).not.toContain('"@type":"LocalBusiness"');
    }
    expect(tradeLabels.art_decorative_finishes).toBe("Art & decorative finishes");
    expect(creative.filter((t) => isLicensedTrade(t))).toEqual(["architecture_remodeling"]);
  });
});
