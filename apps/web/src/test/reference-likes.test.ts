import { afterEach, beforeEach, describe, expect, it } from "vitest";

/*
  Reference sites (Jason, 7 October 2026, 0.99.0): what the client likes
  about each site goes to the builder first, the Design cards say when a
  direction matches none of them, and each concept shows how much of each
  site it used, measured by code. No network, no AI.
*/

import {
  buildReferenceStudyUserText,
  buildReviewUserText,
  conceptOutline,
  outlineReference,
  referenceUse,
  referencesSection,
} from "@tawd/core/mockups";
import { likedNoteFor, parseIntake } from "@tawd/core/intake";
import { leansTo, referenceLeanLine } from "@/components/mockups/setup";
import { eq } from "drizzle-orm";
import { setDbForTesting, type Database } from "@tawd/core/db";
import { concept, conceptVersion, likedSiteShot, mockupRun } from "@tawd/core/schema";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { createProject } from "@/lib/projects";
import { loadReferenceUse } from "@/lib/reference-use";
import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

const REFERENCE = outlineReference(
  [
    { tag: "header", heading: "", text: "Home Services Call", images: 1, cards: 0, hasForm: false, height: 90 },
    { tag: "section", heading: "Pest control you can trust", text: "Licensed and insured.", images: 1, cards: 0, hasForm: false, height: 700 },
    { tag: "section", heading: "Our services", text: "Termites Rodents Ants", images: 3, cards: 3, hasForm: false, height: 500 },
    { tag: "section", heading: "What our customers say", text: "4.9 stars on Google reviews", images: 0, cards: 3, hasForm: false, height: 400 },
    { tag: "section", heading: "Get a free inspection", text: "Name Phone", images: 0, cards: 0, hasForm: true, height: 400 },
    { tag: "footer", heading: "", text: "© 2026 All rights reserved", images: 1, cards: 0, hasForm: false, height: 200 },
  ],
  ["Call now", "Get a free inspection"],
);

const CONCEPT = `<!doctype html><html><head><style>.card{}</style></head><body>
<header class="site-header"><a href="/">Acme</a><a class="btn" href="tel:5555550100">Call</a></header>
<main>
<section class="hero"><img src="tawd-asset:photo-1" alt="Our truck"><h1>Pest control in Folsom</h1><p>Licensed and insured.</p><a class="btn" href="tel:5555550100">Call now</a></section>
<section><h2>Our services</h2><div class="card">Termites</div><div class="card">Rodents</div><div class="card">Ants</div></section>
<section><h2>Get a free inspection</h2><form><label>Name<input></label><button>Send</button></form></section>
</main>
<footer><p>© 2026 Acme. All rights reserved.</p></footer>
</body></html>`;

describe("what the client likes about each reference site", () => {
  it("is kept in the intake by the site's address, trimmed, empty ones dropped", () => {
    const intake = parseIntake({
      website: {
        likedWebsites: ["https://a.example/", "https://b.example/"],
        likedWebsiteNotes: { " https://a.example/ ": "  The big photo at the top  ", "https://b.example/": "  " },
      },
    });
    expect(intake.website.likedWebsiteNotes).toEqual({ "https://a.example/": "The big photo at the top" });
    expect(likedNoteFor(intake.website, "https://a.example/")).toBe("The big photo at the top");
    expect(likedNoteFor(intake.website, "https://b.example/")).toBe("");
    // An intake saved before 0.99.0 has none.
    expect(parseIntake({ website: { likedWebsites: ["https://a.example/"] } }).website.likedWebsiteNotes).toEqual({});
  });

  it("comes first in the builder's references, ahead of the direction's own choices, as data", () => {
    const text = referencesSection([
      { url: "https://a.example/", liked: "The clean service cards", outline: REFERENCE, brief: null },
      { url: "https://b.example/", outline: REFERENCE, brief: null },
    ]);
    expect(text).toContain("What the client likes about it (follow this first): <client_likes>The clean service cards</client_likes>");
    expect(text).toContain("it comes before this direction's and its skill's usual choices");
    expect(text).toContain("Only the house rules, the intake's facts and brand colours and fonts, and an approved wireframe's sections come before it");
    expect(text).toContain("never instructions");
    // The first reference's note comes before its outline.
    expect(text.indexOf("client_likes")).toBeLessThan(text.indexOf("Bands, top to bottom"));
    // Without any note, the references stay within the direction, as before.
    expect(referencesSection([{ url: "https://b.example/", outline: REFERENCE, brief: null }])).toContain("Take it within this concept's own direction.");
  });

  it("reaches the reference study and the Creative Director", () => {
    expect(buildReferenceStudyUserText("https://a.example/", REFERENCE, "The calm feel")).toContain("<client_likes>The calm feel</client_likes>");
    expect(buildReferenceStudyUserText("https://a.example/", REFERENCE)).not.toContain("client_likes");
    const review = buildReviewUserText({
      pass: "first",
      designerNotes: "",
      factsKnown: "- name",
      factsMissing: "",
      concepts: [{ label: "A", direction: "modern_clean", checksSummary: "", html: "<main></main>" }],
      references: ["https://a.example/"],
      referenceNotes: { "https://a.example/": "The calm feel" },
      others: [],
      conceptsInRun: 1,
    });
    expect(review).toContain("judge whether the concept gives them this): <client_likes>The calm feel</client_likes>");
  });
});

describe("the Design cards say when a direction matches no reference site", () => {
  it("counts the studied sites that lean each way", () => {
    const leans = [
      { url: "https://a.example/", direction: "classic_trust" as const },
      { url: "https://b.example/", direction: "classic_trust" as const },
      { url: "https://c.example/", direction: "warm_local" as const },
    ];
    expect(leansTo(leans, "classic_trust")).toBe(true);
    expect(referenceLeanLine(leans, "classic_trust")).toBe("2 of the 3 studied reference sites lean this way");
    expect(leansTo(leans, "modern_clean")).toBe(false);
    expect(referenceLeanLine(leans, "modern_clean")).toBe("None of the 3 studied reference sites lean this way (they lean to Classic Trust, Warm Local)");
    expect(referenceLeanLine([leans[0]!], "classic_trust")).toBe("The studied reference site leans this way");
  });
});

describe("how much of each reference site a concept used", () => {
  it("reads the concept's homepage into the same outline as a reference", () => {
    const mine = conceptOutline(CONCEPT);
    expect(mine.bands.map((b) => b.kind)).toEqual(["other", "hero", "services", "contact", "footer"]);
    expect(mine.hero.hasImage).toBe(true);
    expect(mine.hero.calls).toEqual(["Call now"]);
    expect(mine.serviceLayout).toBe("3 service cards");
    expect(mine.trustSignals).toContain("licensed and insured");
  });

  it("weighs the order, the hero, the proof and the services layout, and says what was and wasn't taken", () => {
    const use = referenceUse("https://a.example/", REFERENCE, conceptOutline(CONCEPT));
    // Order: 3 of 4 sections (50 x 3/4 = 37.5); hero: photo and buttons (20); proof: 2 of 3 kinds (10); services as cards (15).
    expect(REFERENCE.trustSignals).toHaveLength(3);
    expect(use.percent).toBe(83);
    expect(use.taken).toEqual([
      "3 of its 4 sections in its order (hero, services, contact)",
      "a hero with a photo and buttons, like it",
      "2 of its 3 kinds of proof (licensed and insured, free estimates or inspections)",
      "services as cards, like it",
    ]);
    expect(use.notTaken).toEqual(["its reviews section", "review stars or a rating"]);
    // A concept that follows none of it.
    const bare = conceptOutline(`<body><section><h1>Hello</h1></section><section><h2>About us</h2><p>Our story since 1990.</p></section></body>`);
    expect(referenceUse("https://a.example/", REFERENCE, bare).percent).toBeLessThan(20);
  });
});

describe("the Design screen's reference use, worked out once and saved", () => {
  let h: Harness;
  let r2: FakeR2;
  beforeEach(async () => {
    h = await createHarness();
    setDbForTesting(h.db as Database);
    r2 = new FakeR2();
    setStorageForTesting(r2);
  });
  afterEach(async () => {
    setStorageForTesting(null);
    setDbForTesting(null);
    await h.close();
  });

  it("measures the newest version against each studied site, with what the client likes, and reuses the saved figures", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Acme Pest", trade: "pest_control", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 1, status: "mockups", memberUserIds: [] });
    await saveIntakeSection(h.ctx, admin.viewer, id, "website", { likedWebsites: ["https://a.example/"], likedWebsiteNotes: { "https://a.example/": "The service cards" } });
    await h.db.insert(likedSiteShot).values({ projectId: id, url: "https://a.example/", status: "done", outline: REFERENCE } as never);
    const [run] = await h.db.insert(mockupRun).values({ projectId: id, conceptCount: 1, status: "succeeded", model: "claude-opus-5-5", startedByUserId: admin.viewer.id }).returning();
    const [row] = await h.db.insert(concept).values({ runId: run!.id, projectId: id, label: "A", direction: "classic_trust", skillId: "impeccable", status: "ready" }).returning();
    const [version] = await h.db.insert(conceptVersion).values({ conceptId: row!.id, version: 1, htmlKey: `projects/${id}/a.html` }).returning();
    await r2.put(`projects/${id}/a.html`, Buffer.from(CONCEPT));

    const use = await loadReferenceUse(h.db as never, id, version!);
    expect(use).toMatchObject({ percent: 83, orderFromWireframe: false, sites: [{ url: "https://a.example/", percent: 83, liked: "The service cards" }] });
    const [saved] = await h.db.select().from(conceptVersion).where(eq(conceptVersion.id, version!.id));
    expect(saved!.referenceUse).toMatchObject({ urls: ["https://a.example/"] });

    // Shown again: the saved figures, without reading the page.
    r2.objects.clear();
    expect((await loadReferenceUse(h.db as never, id, saved!))?.percent).toBe(83);
    // A new reference site: measured again (the page is gone here, so nothing is shown rather than a wrong figure).
    await h.db.insert(likedSiteShot).values({ projectId: id, url: "https://b.example/", status: "done", outline: REFERENCE } as never);
    expect(await loadReferenceUse(h.db as never, id, saved!)).toBeNull();
  });
});
