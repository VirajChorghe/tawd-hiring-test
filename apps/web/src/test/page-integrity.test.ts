import { describe, expect, it } from "vitest";

import { checkDocumentComplete, checkDuplicateBands, checkDuplicateIds, checkPageIntegrity, countSections, measureRichness } from "@tawd/core/mockups";

/*
  Is it still a page? (9 November 2026, after a client run: a
  concept whose document had collapsed rendered as its hero alone, and
  every check TAWD had passed, because the hero holds the H1, the phone
  link and the form.)
*/

const band = (id: string, words: string) =>
  `<section id="${id}"><h2>${words}</h2><p>${words} ${words} ${words} ${words} ${words} ${words} ${words} ${words}</p></section>`;

const page = (body: string, { close = true }: { close?: boolean } = {}) =>
  `<!doctype html><html lang="en"><head><title>A page</title><style>body{margin:0}</style></head><body>${body}${close ? "</body></html>" : ""}`;

describe("a document that stops before it is finished", () => {
  it("passes a whole page", () => {
    expect(checkDocumentComplete(page(band("a", "roof repair"), {}))).toEqual([]);
  });

  it("catches a page with no </html> or </body>", () => {
    const issues = checkDocumentComplete(page(band("a", "roof repair"), { close: false }));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.id).toBe("structure.truncated");
    expect(issues[0]!.message).toContain("</html>");
    expect(issues[0]!.message).toContain("</body>");
  });

  it("catches a stylesheet cut off mid-rule, which swallows the rest of the page", () => {
    const cut = `<!doctype html><html><head><title>t</title><style>body{margin:0}.band{padding:4`;
    expect(checkDocumentComplete(cut).map((i) => i.id)).toContain("structure.truncated");
    expect(checkDocumentComplete(cut)[0]!.message).toContain("</style>");
  });

  it("catches a band container that is never closed", () => {
    const broken = page(`<section id="a"><h2>Services</h2><p>Words enough to be a band here.</p>${band("b", "drain cleaning")}`);
    const issues = checkDocumentComplete(broken);
    expect(issues.map((i) => i.id)).toContain("structure.unbalanced");
    expect(issues.find((i) => i.id === "structure.unbalanced")!.message).toContain("never closed");
  });

  it("catches a closing tag with no opening one", () => {
    const issues = checkDocumentComplete(page(`${band("a", "roofing")}</section>`));
    expect(issues.find((i) => i.id === "structure.unbalanced")!.message).toContain("no opening");
  });

  it("never reads markup inside a comment, a script or a stylesheet", () => {
    const quoted = page(
      `${band("a", "roofing")}<!-- <section> a note --><script>const s = "</section>";</script><style>.x::after{content:"<section>"}</style>`,
    );
    expect(checkDocumentComplete(quoted)).toEqual([]);
  });
});

describe("the same id twice", () => {
  it("passes a page whose ids are each used once", () => {
    expect(checkDuplicateIds(page(band("services", "roofing") + band("contact", "get in touch")))).toEqual([]);
  });

  /* Bold Marketing, 9 November 2026: a move that copied left two id="services". */
  it("catches a section that was copied instead of moved", () => {
    const issues = checkDuplicateIds(page(band("services", "roofing") + band("services", "roofing")));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.id).toBe("structure.duplicate_id");
    expect(issues[0]!.message).toContain("services");
    expect(issues[0]!.message).toContain("copied instead of moved");
  });
});

describe("the same band twice", () => {
  it("passes a page whose bands each say something different", () => {
    expect(checkDuplicateBands(page(band("a", "roof repair in reno") + band("b", "drain cleaning in sparks")))).toEqual([]);
  });

  it("catches a whole band repeated word for word", () => {
    const twice = page(band("services", "our digital marketing services") + band("why", "why choose us today") + band("services-2", "our digital marketing services"));
    const issues = checkDuplicateBands(twice);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.id).toBe("structure.duplicate_band");
    expect(issues[0]!.message).toContain("same band");
  });

  it("leaves a short repeated call-to-action strip alone", () => {
    const strip = `<section><p>Call us now.</p></section>`;
    expect(checkDuplicateBands(page(band("a", "roof repair in reno") + strip + band("b", "drain cleaning") + strip))).toEqual([]);
  });
});

describe("all of them together", () => {
  it("says nothing about a sound page", () => {
    expect(checkPageIntegrity(page(band("a", "roof repair in reno") + band("b", "drain cleaning in sparks")))).toEqual([]);
  });
});

/*
  Richness (9 November 2026): the photos TAWD reads from a client's current
  site are tokenised photo-site-N, and a built page's own photos
  photo-<page>-N. Counting only photo-N measured every Design + content
  project as having no pictures, which fired the image-poor must-fix and
  capped two of the Creative Director's questions at 2.
*/
describe("counting a page's pictures", () => {
  const withPhotos = (...tokens: string[]) =>
    page(tokens.map((t, i) => `<section><img src="${t}" alt="a photo"><p>Band ${i} needs some words here.</p></section>`).join(""));

  it("counts the client's own uploads", () => {
    expect(measureRichness(withPhotos("tawd-asset:photo-1", "tawd-asset:photo-2"), []).clientPhotos).toBe(2);
  });

  it("counts photos read from the client's current site", () => {
    expect(measureRichness(withPhotos("tawd-asset:photo-site-1", "tawd-asset:photo-site-4"), []).clientPhotos).toBe(2);
  });

  it("counts a built page's own photos", () => {
    expect(measureRichness(withPhotos("tawd-asset:photo-home-2"), []).clientPhotos).toBe(1);
  });

  it("counts all three kinds together, and nothing that isn't a photo", () => {
    const r = measureRichness(withPhotos("tawd-asset:photo-1", "tawd-asset:photo-site-4", "tawd-asset:photo-home-2", "tawd-asset:logo-1"), []);
    expect(r.clientPhotos).toBe(3);
  });
});

/*
  CodeRabbit, PR #59: a closing tag written inside a script string or a
  comment must not hide a document that stops early, and a "<section" in
  the same places is not a band.
*/
describe("markup that only looks like markup", () => {
  it("still catches a truncated page whose script mentions </html>", () => {
    const hidden = `<!doctype html><html><head><title>t</title></head><body>${band("a", "roof repair")}<script>const end = "</html>";</script>`;
    expect(checkDocumentComplete(hidden).map((i) => i.id)).toContain("structure.truncated");
  });

  it("does not count a section written inside a comment or a script", () => {
    const page = `<!doctype html><html><body>${band("a", "roofing")}<!-- <section> --><script>"<section>"</script></body></html>`;
    expect(countSections(page)).toBe(1);
  });

  it("counts only real section tags, not <sections> or <sectionfoo>", () => {
    expect(countSections("<section></section><sections></sections>")).toBe(1);
  });
});

/* CodeRabbit, PR #59: the photo pattern is anchored, so a token that merely ends in photo-N is not one. */
describe("what counts as a photo token", () => {
  const withToken = (token: string) => page(`<section><img src="${token}" alt="x"><p>Some words for this band here.</p></section>`);

  it("does not count a logo that happens to end in photo-1", () => {
    expect(measureRichness(withToken("tawd-asset:logo-photo-1"), []).clientPhotos).toBe(0);
  });

  it("does not count a token that merely contains photo", () => {
    expect(measureRichness(withToken("tawd-asset:nophoto-1"), []).clientPhotos).toBe(0);
  });
});
