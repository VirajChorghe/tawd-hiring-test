import { describe, expect, it } from "vitest";

import {
  MAX_STOCK_PER_PAGE,
  REVIEW_QUESTIONS,
  applyStockPictures,
  buildConceptPromptParts,
  buildReferenceStudySystemPrompt,
  classifySection,
  comparePhotoText,
  decideAfterRescore,
  describePolishRequest,
  measureRichness,
  outlineReference,
  photoTextNotes,
  readPhotoTextReply,
  readPolishCritique,
  readReferenceBrief,
  referencesSection,
  richnessMustFix,
  stockClash,
  validateReview,
  type StoredReview,
} from "@tawd/core/mockups";
import { parseIntake } from "@tawd/core/intake";

/*
  The mockup rework's rules (27 September 2026), on their own: no database,
  no browser, no AI. The worker jobs are tested with stand-ins elsewhere.
*/

describe("stock pictures", () => {
  const frames = (n: number) =>
    Array.from({ length: n }, (_, i) => `<section><div class="photo-frame" data-tawd-photo="scene ${i + 1}">Photo ${i + 1}</div></section>`).join("");
  const pictures = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`scene ${i + 1}`, { id: `ss${i + 1}`, dataUri: "data:image/jpeg;base64,AA==" }]));

  it("fills at most 8 frames, top to bottom, and leaves the rest as boxes", () => {
    const html = applyStockPictures(frames(10), pictures(10));
    expect(MAX_STOCK_PER_PAGE).toBe(8);
    expect((html.match(/data-tawd-stock=/g) ?? []).length).toBe(8);
    expect(html).toContain('data-tawd-stock="ss8"');
    expect(html).not.toContain('data-tawd-stock="ss9"');
    expect(html).toContain("Photo 10");
  });

  it("gives every stock picture one colour treatment: calmer colour and a wash of the brand colour", () => {
    const html = applyStockPictures(frames(2), pictures(2), { tint: "#12305A" });
    expect((html.match(/filter:saturate\(0\.85\) contrast\(1\.05\)/g) ?? []).length).toBe(2);
    expect((html.match(/class="tawd-stock-tone"[^>]*background:#12305A;mix-blend-mode:color/g) ?? []).length).toBe(2);
    // No brand colour, no wash (and nothing broken).
    expect(applyStockPictures(frames(1), pictures(1))).not.toContain("tawd-stock-tone");
  });

  it("flags stock that shows another company's uniform colours or a named competitor", () => {
    expect(stockClash("Pest control technician in red uniform spraying a house", ["#12305A", "#3FA535"])).toContain("in red");
    expect(stockClash("Technician in a blue uniform inspecting a crawl space", ["#12305A"])).toBeNull();
    expect(stockClash("Exterminator at work", ["#12305A"])).toBeNull();
    expect(stockClash("An Orkin van parked outside", ["#12305A"], ["Orkin"])).toContain("a competitor the client named");
  });
});

describe("the photo text check", () => {
  const intake = parseIntake({
    business: { name: "Harbor Pest Control", phone: "(775) 555-0100", streetAddress: "1100 Melody Ln, Suite 2017", city: "Roseville" },
    website: { currentWebsiteUrl: "https://harborpest.com" },
  });

  it("reads the reply per photo, in order", () => {
    expect(readPhotoTextReply('{"photos":[{"photo":2,"texts":["530A"]},{"photo":1,"texts":[]}]}', 2)).toEqual([[], ["530A"]]);
    expect(() => readPhotoTextReply("no json", 1)).toThrow("no JSON");
  });

  it("flags the Harbor door number that isn't in the intake address, and other mismatches", () => {
    const findings = comparePhotoText(
      [
        { fileId: "f1", fileName: "team.jpg", texts: ["530A", "HARBOR PEST CONTROL", "(775) 555-0100"] },
        { fileId: "f2", fileName: "van.jpg", texts: ["Call (916) 555-0199", "www.otherpest.com", "Acme Pest Services", "Suite 2017"] },
      ],
      intake,
    );
    const problems = findings.map((f) => `${f.fileName}: ${f.text}`);
    expect(problems).toEqual([
      "team.jpg: 530A",
      "van.jpg: Call (916) 555-0199",
      "van.jpg: www.otherpest.com",
      "van.jpg: Acme Pest Services",
    ]);
    expect(findings[0]!.problem).toContain("isn't in the intake address (1100 Melody Ln, Suite 2017, Roseville)");
    expect(photoTextNotes(findings, { f1: "tawd-asset:photo-1" })).toContain("tawd-asset:photo-1: Shows \"530A\"");
  });
});

describe("the reference study", () => {
  it("reads an outline from a page's bands, with no AI", () => {
    const outline = outlineReference(
      [
        { tag: "header", heading: "", text: "Home Services About Call (555) 555-0100", images: 1, cards: 0, hasForm: false, height: 90 },
        { tag: "section", heading: "Pest control you can trust", text: "Licensed and insured. Same-day service.", images: 1, cards: 0, hasForm: false, height: 700 },
        { tag: "section", heading: "Our services", text: "Termites Rodents Ants", images: 3, cards: 3, hasForm: false, height: 500 },
        { tag: "section", heading: "What our customers say", text: "4.9 stars on Google reviews", images: 0, cards: 3, hasForm: false, height: 400 },
        { tag: "section", heading: "Get a free inspection", text: "Name Phone", images: 0, cards: 0, hasForm: true, height: 400 },
        { tag: "footer", heading: "", text: "© 2026 All rights reserved", images: 1, cards: 0, hasForm: false, height: 200 },
      ],
      ["Call (555) 555-0100", "Get a free inspection"],
    );
    expect(outline.bands.map((b) => b.kind)).toEqual(["other", "hero", "services", "reviews", "contact", "footer"]);
    expect(outline.trustSignals).toEqual(expect.arrayContaining(["licensed and insured", "review stars or a rating", "same-day or emergency service", "free estimates or inspections"]));
    expect(outline.serviceLayout).toBe("3 service cards with pictures");
    expect(classifySection({ tag: "section", heading: "Areas we serve", text: "", index: 3, total: 6, hasForm: false })).toBe("areas");
  });

  it("reads the AI's brief, keeping only known directions, and never asks for identity", () => {
    const brief = readReferenceBrief(
      'Here: {"sectionOrder":["hero","trust bar","services grid"],"heroPattern":"photo right, phone top","trustElements":["badges"],"serviceLayout":"3 cards","craftNotes":["tight type scale"],"closestDirection":"classic_trust"}',
    );
    expect(brief.closestDirection).toBe("classic_trust");
    // A direction TAWD doesn't know becomes null. (The brief itself must say something: an all-empty
    // one is refused since 9 November 2026, so the builder falls back to the free outline instead.)
    expect(readReferenceBrief('{"sectionOrder":["hero"],"heroPattern":"photo right","trustElements":[],"serviceLayout":"","craftNotes":[],"closestDirection":"made_up"}').closestDirection).toBeNull();
    expect(() => readReferenceBrief('{"sectionOrder":"x"}')).toThrow("fields");
    expect(buildReferenceStudySystemPrompt()).toContain("Never copy identity");

    const text = referencesSection([{ url: "https://a.example", outline: null, brief }]);
    expect(text).toContain("structure and craft only");
    expect(text).toContain("Never take their identity");
    expect(text).toContain("Section order: hero > trust bar > services grid");
  });

  it("gives the builder the references, the photo plan and the logo's colours", () => {
    const intake = parseIntake({ business: { name: "Harbor Pest Control" }, brand: { colors: ["#12305A"], colorsFromLogo: true } });
    const { project } = buildConceptPromptParts({
      brief: { skillId: "impeccable", direction: "modern_clean", conceptLabel: "A" },
      project: { clientName: "Harbor", trade: "pest_control", tier: "growth" },
      intake,
      assets: [{ token: "tawd-asset:photo-1", kind: "photo", caption: "Our team", fileName: "team.jpg", width: 1600, height: 1000 }],
      facts: [],
      references: [{ url: "https://a.example", outline: null, brief: null }],
      stockAvailable: true,
      photoTextNotes: "\n\n# Text in the client's photos that doesn't match the intake",
    });
    expect(project).toContain("# Reference sites: the bar to meet");
    expect(project).toContain("Hero: use tawd-asset:photo-1");
    expect(project).toContain("taken from the client's own logo");
    expect(project).toContain("Text in the client's photos that doesn't match");
  });
});

describe("the Creative Director's ninth question and the must-fix", () => {
  it("asks whether a real client would choose this, and needs all eleven answers", () => {
    expect(REVIEW_QUESTIONS).toHaveLength(11);
    expect(REVIEW_QUESTIONS[8]!.text).toContain("Would a real client in this trade choose this over their current site?");
    // 8 October 2026: Pictures fit and Ready to send.
    expect(REVIEW_QUESTIONS.map((q) => q.title).slice(9)).toEqual(["Pictures fit", "Ready to send"]);
    const ten = { concepts: [{ label: "A", summary: "", safetyAdvice: [], earlierNotes: [], questions: REVIEW_QUESTIONS.slice(0, 10).map((q) => ({ question: q.id, score: 4, reason: "", notes: [] })) }] };
    expect(() => validateReview(ten, ["A"], "first", new Date(), 2)).toThrow("left out question 11");
  });

  it("measures a flat, image-poor or unbranded page, and fails it whatever the scores say", () => {
    const flat = measureRichness('<style>.a{color:#222222}</style><section>x</section><section>y</section><section>z</section><section><div class="photo-frame">Photo</div></section>', ["#12305A"]);
    expect(flat).toMatchObject({ clientPhotos: 0, stockFrames: 0, emptyFrames: 1, bands: 4, branded: false });
    expect(richnessMustFix(flat)).toEqual([expect.stringContaining("Image-poor"), expect.stringContaining("Unbranded")]);

    const rich = measureRichness('<style>.a{color:#12305a}</style><section><img src="tawd-asset:photo-1"></section><section><div data-tawd-photo="a b c"></div></section><section><img src="tawd-asset:photo-2"></section>', ["#12305A"]);
    expect(richnessMustFix(rich)).toEqual([]);

    const review = { questions: [], mustFix: ["Image-poor: only 0 pictures."] } as unknown as StoredReview;
    expect(decideAfterRescore(review, false).kind).toBe("rebuild");
    expect(decideAfterRescore({ ...review, mustFix: [] }, false).kind).toBe("done");
  });
});

describe("critique then polish", () => {
  it("reads at most 8 fixes on real bands and turns them into one bounded request", () => {
    const critique = readPolishCritique(
      '{"fixes":[{"band":1,"area":"spacing rhythm","problem":"Bands all 96px.","fix":"Vary 64 and 120."},{"band":9,"area":"alignment","problem":"x","fix":"y"}],"summary":"ok"}',
      4,
    );
    expect(critique.fixes).toHaveLength(1);
    // More fixes than TAWD acts on is a usable critique, not a wasted call: since 9 November 2026 the
    // extras are dropped rather than the whole reply refused. Only a reply of the wrong shape throws.
    const tooMany = readPolishCritique('{"fixes":' + JSON.stringify(Array.from({ length: 9 }, () => ({ band: 0, area: "a", problem: "p", fix: "f" }))) + "}", 4);
    expect(tooMany.fixes).toHaveLength(8);
    expect(() => readPolishCritique('{"fixes":[{"band":0,"area":"a","problem":"p"}]}', 4)).toThrow(/"fixes.0.fix" is missing/);
    const request = describePolishRequest(critique, "POLISH RULES");
    expect(request).toContain("Band 1, spacing rhythm: Bands all 96px. Change: Vary 64 and 120.");
    expect(request).toContain("Keep every word, fact, phone number, [PLACEHOLDER], photo token and brand colour");
    expect(request).toContain("POLISH RULES");
  });
});
