import { describe, expect, it } from "vitest";

import { bandKinds, checkPictures, fixPictures, measureRichness, phraseFromLabel, runHtmlChecks } from "@tawd/core/mockups";
import { searchPhrase } from "../../../worker/src/stock";

/*
  Pictures where they belong (Jason, 8 October 2026, Harbor's concept B: no
  stock pictures in the first build, and one forced into "What sets us
  apart?"). Code decides which bands may carry stock, asks Shutterstock for
  every general-scene frame, and the hero must have a picture.
*/

const page = (bands: string) => `<!doctype html><html><head><title>Harbor</title></head><body>
<header><a href="/">Harbor Pest Control</a></header>
<main>${bands}</main>
<footer><p>Harbor Pest Control</p></footer>
</body></html>`;

const hero = `<section class="hero"><h1>Pest control in Sacramento</h1><div class="photo-frame" data-tawd-photo="pest control technician spraying yard">Photo: technician spraying a yard</div></section>`;
const signs = `<section><h2>Signs you may need pest control</h2><p>Droppings, damage, strange noises.</p><div class="photo-frame">Photo: technician spraying shrubs around a house</div></section>`;
const apart = `<section><h2>What sets us apart?</h2><img src="tawd-asset:photo-1" alt="The Harbor team"><div class="photo-frame" data-tawd-photo="bait traps">Photo: bait traps</div><div class="card"><h3>Licensed experts</h3></div></section>`;
const team = `<section><h2>Meet our team</h2><div class="photo-frame">Photo: our crew outside the office</div></section>`;

describe("pictures where they belong", () => {
  it("names each band from its heading", () => {
    const kinds = bandKinds(page(hero + signs + apart + team)).map((b) => b.kind);
    expect(kinds).toEqual(["header", "hero", "other", "why", "about", "footer"]);
  });

  it("takes stock out of a band that doesn't need it, keeps the client's own photo, and asks for stock on an empty frame", () => {
    const html = page(hero + signs + apart);
    const issues = checkPictures(html, { stockAvailable: true }).map((i) => i.id);
    expect(issues).toEqual(["images.frameWithoutStock", "images.stockOutOfPlace"]);

    const fixed = fixPictures(html, { stockAvailable: true });
    // Harbor's "What sets us apart?": the forced traps picture goes, the team photo and the card stay.
    expect(fixed.html).not.toContain("bait traps");
    expect(fixed.html).toContain('src="tawd-asset:photo-1"');
    expect(fixed.html).toContain("Licensed experts");
    // The empty frame in a problem band gets its phrase, so Shutterstock fills it.
    expect(fixed.html).toContain('data-tawd-photo="technician spraying shrubs around house"');
    // The hero's own stock frame stays.
    expect(fixed.html).toContain('data-tawd-photo="pest control technician spraying yard"');
    expect(fixed.fixed).toEqual([
      "took out 1 stock picture from sections that don't need one",
      "asked Shutterstock for 1 empty picture frame",
    ]);
    // Running it again changes nothing.
    expect(fixPictures(fixed.html, { stockAvailable: true }).html).toBe(fixed.html);
    expect(checkPictures(fixed.html, { stockAvailable: true })).toEqual([]);
  });

  it("never asks stock for the client's own people, premises or vehicles", () => {
    const html = page(hero + team);
    expect(fixPictures(html, { stockAvailable: true }).html).not.toContain('data-tawd-photo="our');
  });

  it("asks for nothing without Shutterstock keys", () => {
    const html = page(hero + signs);
    expect(checkPictures(html, { stockAvailable: false })).toEqual([]);
  });

  it("fails a hero with no picture, for the fix round", () => {
    const bare = page(`<section class="hero"><h1>Pest control in Sacramento</h1><p>Call today.</p></section>`);
    expect(checkPictures(bare, { stockAvailable: true }).map((i) => i.id)).toEqual(["images.heroNoPicture"]);
  });

  it("runs only when asked (never on a copy of the designer's design)", () => {
    const html = page(hero + apart);
    const facts = { phones: [], licenseNumbers: [], yearFounded: null, businessName: "Harbor Pest Control", cities: [] };
    expect(runHtmlChecks(html, facts).issues.some((i) => i.id.startsWith("images.stock"))).toBe(false);
    expect(runHtmlChecks(html, { ...facts, pictures: { stockAvailable: true } }).issues.some((i) => i.id === "images.stockOutOfPlace")).toBe(true);
  });

  it("makes a plain search phrase from a frame's label", () => {
    expect(phraseFromLabel("Technician spraying the shrubs around a house!")).toBe("technician spraying shrubs around house");
  });

  it("puts the trade in front of a phrase that doesn't name it", () => {
    expect(searchPhrase("bait traps", "pest control")).toBe("pest control bait traps");
    expect(searchPhrase("pest technician spraying", "pest control")).toBe("pest technician spraying");
    expect(searchPhrase("kitchen sink repair", undefined)).toBe("kitchen sink repair");
  });

  it("counts only the stock frames Shutterstock filled as pictures", () => {
    const html = page(hero + signs.replace('class="photo-frame"', 'class="photo-frame" data-tawd-photo="pest control signs"'));
    expect(measureRichness(html, []).stockFrames).toBe(2);
    expect(measureRichness(html, [], 1).stockFrames).toBe(1);
  });
});
