import { describe, expect, it } from "vitest";

import { matchOldPage, newPagePath, type OldPageForMatch } from "@tawd/core/site";

/*
  Crawl-% photos: a new page takes photos from the old page most like it, but
  only when the match is confident; otherwise null → the caller uses the home's
  photos (a wrong product photo is worse than a repeat).
*/

const OLD: OldPageForMatch[] = [
  { path: "/", title: "Clear Sky Awning", name: "Home", h1s: ["Awnings and patio covers"] },
  { path: "/retractable-awnings/", title: "Retractable Awnings", name: "Retractable Awnings", h1s: ["Retractable awnings"] },
  { path: "/patio-covers/", title: "Patio Covers", name: "Patio Covers", h1s: ["Aluminium patio covers"] },
  { path: "/about-us/", title: "About Clear Sky", name: "About", h1s: ["About us"] },
];

describe("matchOldPage", () => {
  it("takes the same path as the surest match", () => {
    expect(matchOldPage({ slug: "patio-covers", name: "Patio Covers", mainKeyword: "patio covers sacramento" }, OLD))
      .toMatchObject({ oldPath: "/patio-covers/", reason: "same path on the old site" });
  });

  it("matches on a clear overlap of meaningful words when the path differs", () => {
    const m = matchOldPage({ slug: "retractable-patio-awnings", name: "Retractable Awnings", mainKeyword: "retractable awnings" }, OLD);
    expect(m?.oldPath).toBe("/retractable-awnings/");
    expect(m?.reason).toContain("retractable");
  });

  it("returns null (→ home photos) when no match is confident", () => {
    // A brand-new service the old site never had: no confident match.
    expect(matchOldPage({ slug: "solar-screens", name: "Solar Screens", mainKeyword: "solar screens" }, OLD)).toBeNull();
    // A single shared word (the city) is not enough on its own.
    expect(matchOldPage({ slug: "financing", name: "Financing", mainKeyword: "awning financing sacramento" }, OLD, { generalWords: "awning sacramento" })).toBeNull();
  });

  it("does not cross-match sibling pages that share only generic qualifiers (emergency/repair) — the worst case", () => {
    const electrical = [{ path: "/emergency-electrical-repair/", title: "Emergency Electrical Repair", name: "Electrical", h1s: [] }];
    expect(matchOldPage({ slug: "emergency-plumbing-repair", name: "Emergency Plumbing Repair", mainKeyword: "emergency plumbing repair" }, electrical)).toBeNull();
  });

  it("doesn't let the city/business word carry a match when passed as generalWords", () => {
    const patio = [{ path: "/patio-awnings/", title: "Patio Awnings Sacramento", name: "Patio Awnings", h1s: [] }];
    expect(matchOldPage({ slug: "retractable-awnings", name: "Retractable Awnings", mainKeyword: "retractable awnings sacramento" }, patio, { generalWords: "awnings sacramento" })).toBeNull();
  });

  it("never matches the home page as a topic (its photos are the fallback)", () => {
    // A new page that only echoes the home's words gets null, not the home as a "match".
    expect(matchOldPage({ slug: "overview", name: "Awnings and patio covers", mainKeyword: "" }, [OLD[0]!])).toBeNull();
    // The home page itself is never matched here.
    expect(matchOldPage({ slug: "", name: "Home", mainKeyword: "" }, OLD)).toBeNull();
  });

  it("newPagePath maps the slug to a path, home as '/'", () => {
    expect(newPagePath("patio-covers")).toBe("/patio-covers/");
    expect(newPagePath("")).toBe("/");
  });
});
