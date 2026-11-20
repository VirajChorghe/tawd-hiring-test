import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { checkPageRules, fillFramesWithClientPhotos } from "@tawd/core/mockups";
import { PAGE_WRITING_RULES } from "../../../../packages/core/src/lib/page-writing-rules";
import { bandLabels, dropHollowReviews, exactPage, placeholdersIn, unifyCallButtons } from "@tawd/core/site";
import { analyzeDraft } from "@tawd/core/content";
import { serve, tidySitePages } from "../../../worker/src/site-build";

/*
  The gaps left after the official run's fixes (0.103.5): the call button's
  words, a reviews band with nothing real in it, more than one small label
  in a band, the same checks on every built site page, client photos for
  frames Shutterstock couldn't fill, and no promise of a map nothing makes.
*/

const facts = { businessName: "Sample Plumbing Co.", cities: ["Sacramento"], phones: ["(916) 235-7878"] };

describe("the call button", () => {
  it("says Call and the number, as the intake writes it", () => {
    const html = '<a class="btn btn-primary" href="tel:+19162357878"><svg class="icon"></svg>Call about your address</a>';
    const { html: out, changed } = unifyCallButtons(html, facts.phones);
    expect(changed).toBe(1);
    expect(out).toBe('<a class="btn btn-primary" href="tel:+19162357878"><svg class="icon"></svg>Call (916) 235-7878</a>');
  });

  it("leaves a call button already showing the number, and a plain phone link", () => {
    expect(unifyCallButtons('<a class="btn" href="tel:9162357878">Call now</a>', facts.phones).html).toContain(">Call (916) 235-7878</a>");
    for (const html of ['<a class="btn" href="tel:9162357878">Call (916) 235-7878</a>','<a class="cta" href="tel:9162357878">(916) 235-7878</a>', '<a href="tel:9162357878">Call about your address</a>']) {
      expect(unifyCallButtons(html, facts.phones).changed).toBe(0);
    }
  });
});

describe("a reviews band", () => {
  it("goes when it only asks for reviews", () => {
    const html = '<main><section><h2>Hero</h2></section><section class="reviews"><h2>What our customers say</h2><p>[PLACEHOLDER: reviews]</p></section></main>';
    expect(dropHollowReviews(html)).toEqual({ html: "<main><section><h2>Hero</h2></section></main>", dropped: 1 });
  });

  it("stays with a customer's real words", () => {
    const html = '<section><h2>Reviews</h2><blockquote>"Fixed our leak the same day." Maria, Sacramento</blockquote></section>';
    expect(dropHollowReviews(html).dropped).toBe(0);
  });

  it("goes with a short line around its review placeholders", () => {
    const html = '<section><h2>Reviews</h2><p>See what our neighbors say.</p><p>[PLACEHOLDER: real Google review]</p><p>[PLACEHOLDER: testimonial 2]</p></section>';
    expect(dropHollowReviews(html)).toEqual({ html: "", dropped: 1 });
  });

  // The whole-code review (13 October 2026): a required placeholder never vanishes with the band.
  it("stays when it holds any other placeholder, so the go-live check still sees it", () => {
    const html = '<section><h2>What our customers say</h2><p>Read our reviews on Google [PLACEHOLDER: Google Business Profile link]</p></section>';
    expect(dropHollowReviews(html).dropped).toBe(0);
  });

  it("stays when a customer's words sit beside a review placeholder", () => {
    const quoted = '<section><h2>Reviews</h2><p>"Fast and fair."</p><p>[PLACEHOLDER: more reviews]</p></section>';
    const long = `<section><h2>Reviews</h2><p>${"They came out the same day and fixed the water heater for a fair price ".repeat(2)}</p><p>[PLACEHOLDER: reviews]</p></section>`;
    expect(dropHollowReviews(quoted).dropped).toBe(0);
    // CodeRabbit (PR #5): single quotes count as a pair, an apostrophe doesn't.
    expect(dropHollowReviews("<section><h2>Reviews</h2><p>'Fast and fair.'</p><p>[PLACEHOLDER: more reviews]</p></section>").dropped).toBe(0);
    expect(dropHollowReviews("<section><h2>Reviews</h2><p>We're proud of our work.</p><p>[PLACEHOLDER: reviews]</p></section>").dropped).toBe(1);
    // A link to the reviews is information still owed.
    expect(dropHollowReviews("<section><h2>Reviews</h2><p>Read them here.</p><p>[PLACEHOLDER: Google reviews link]</p></section>").dropped).toBe(0);
    expect(dropHollowReviews(long).dropped).toBe(0);
  });
});

describe("small labels above headings", () => {
  it("allows one per band, never the name, 24/7 or the city", () => {
    const html =
      '<section><p class="eyebrow">Drain cleaning</p><h2>Clear drains</h2></section>' +
      '<section><span class="eyebrow">Fast</span><span class="kicker">Local</span><h2>Why us</h2></section>' +
      '<section><p class="eyebrow">24/7</p><h2>Emergencies</h2></section>';
    expect(bandLabels(html)).toEqual([
      { band: 1, labels: ["Drain cleaning"] },
      { band: 2, labels: ["Fast", "Local"] },
      { band: 3, labels: ["24/7"] },
    ]);
    const issue = checkPageRules(html, facts).find((i) => i.id === "copy.labels")!;
    expect(issue.message).toContain('band 2 has "Fast", "Local"; band 3 has "24/7"');
    expect(issue.where).toBe("2,3");
  });

  it("raises the call button and the hollow reviews band too, both fixed by code", () => {
    const html = '<section><h2>Hero</h2><a class="btn" href="tel:9162357878">Describe the problem</a></section><section><h2>Testimonials</h2><p>[PLACEHOLDER: a review]</p></section>';
    const ids = checkPageRules(html, facts).map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining(["copy.callButton", "copy.hollowReviews"]));
  });
});

describe("no map that nothing makes", () => {
  it("never tells the builder the site gets a real map", () => {
    expect(PAGE_WRITING_RULES).not.toMatch(/real map/i);
    const drawn = '<html><body><main><section class="hero"><h1>Plumber in Sacramento</h1></section><section><h2>Service areas</h2><svg viewBox="0 0 10 10" class="map"><path d="M0 0"/></svg></section></main></body></html>';
    const issue = checkPageRules(drawn, facts).find((i) => i.id === "images.drawnMap");
    expect(issue?.message).not.toMatch(/real map/i);
  });
});

describe("a concept's frame Shutterstock couldn't fill", () => {
  it("gets the client's photo not used elsewhere, and a stock frame is left alone", () => {
    const html =
      '<img src="data:image/jpeg;base64,AAA">' +
      '<div class="photo-frame" data-tawd-photo="leak detection" data-tawd-stock="123"><img src="stock"></div>' +
      '<div class="photo-frame" data-tawd-photo="moisture meter on a damp wall">Photo: moisture meter</div>';
    const { html: out, filled } = fillFramesWithClientPhotos(html, ["data:image/jpeg;base64,AAA", "data:image/jpeg;base64,BBB"]);
    expect(filled).toBe(1);
    expect(out).toContain('data-tawd-photo="moisture meter on a damp wall" data-tawd-client-photo style="');
    expect(out).toContain('<img src="data:image/jpeg;base64,BBB" alt="moisture meter on a damp wall"');
    expect(out).toContain('data-tawd-stock="123"><img src="stock"></div>');
    expect(out).not.toContain("Photo: moisture meter");
  });

  it("stays a labeled box with no unused photo", () => {
    const html = '<div data-tawd-photo="leak detection">Photo: leak detection</div><img src="data:a">';
    expect(fillFramesWithClientPhotos(html, ["data:a"])).toEqual({ html, filled: 0 });
  });
});

describe("the same rules on a built site page", () => {
  it("fixes what code can and lists the rest for the checklist", async () => {
    const dist = await fs.mkdtemp(path.join(os.tmpdir(), "tawd-gaps-"));
    try {
      await fs.writeFile(
        path.join(dist, "index.html"),
        '<html><body><header><a class="btn" href="tel:9162357878">Call about your address</a></header><main>' +
          '<section class="hero"><p class="eyebrow">Fast</p><p class="eyebrow">Local</p><h1>Plumber in Sacramento</h1></section>' +
          '<section><h2>What our customers say</h2><p>[PLACEHOLDER: reviews]</p></section></main></body></html>',
        "utf8",
      );
      const { notes, findings } = await tidySitePages(dist, { trade: "plumbing", ...facts });
      const page = await fs.readFile(path.join(dist, "index.html"), "utf8");
      expect(page).toContain(">Call (916) 235-7878</a>");
      expect(page).not.toContain("What our customers say");
      expect(notes).toEqual(expect.arrayContaining(['1 call button now "Call" and the number', "1 reviews band with no customer's words taken out"]));
      expect(findings).toEqual([{ file: "index.html", messages: [expect.stringContaining('band 1 has "Fast", "Local"')] }]);
    } finally {
      await fs.rm(dist, { recursive: true, force: true });
    }
  });
});

/* ---------- the whole-code review's Lows (13 October 2026) ---------- */

describe("built pages and placeholders: the review's small fixes", () => {
  it("gives a call button with an empty tel: the business number in its link, not only its words", () => {
    const { html, changed } = unifyCallButtons('<a class="btn" href="tel:">Call us today</a>', facts.phones);
    expect(changed).toBe(1);
    expect(html).toBe('<a class="btn" href="tel:+19162357878">Call (916) 235-7878</a>');
    // The real href, not the end of a data-href before it (CodeRabbit, PR #11).
    expect(unifyCallButtons('<a data-href="tel:" class="btn" href="tel:">Call us</a>', facts.phones).html).toBe('<a data-href="tel:" class="btn" href="tel:+19162357878">Call (916) 235-7878</a>');
    // An international number keeps its own country code (CodeRabbit, PR #11).
    expect(unifyCallButtons('<a class="btn" href="tel:">Call us</a>', ["+44 20 7123 4567"]).html).toBe('<a class="btn" href="tel:+442071234567">Call +44 20 7123 4567</a>');
    // With no business number known, it's left for the checks to find.
    expect(unifyCallButtons('<a class="btn" href="tel:">Call us today</a>', []).changed).toBe(0);
  });

  it("finds a placeholder however it's capitalised, so it can't go live", () => {
    expect(placeholdersIn("<p>[Placeholder: license number]</p><p>[PLACEHOLDER: hours]</p>")).toEqual(["[Placeholder: license number]", "[PLACEHOLDER: hours]"]);
  });

  it("keeps a $ in an exact page's title and description as written", () => {
    const page = exactPage({ html: "<html><head></head><body><footer></footer></body></html>", title: "Drains from $$89", description: "Was $$120, now from $$89 ($& off).", head: "", footerEnd: "<p>Cost: $$5</p>", bodyEnd: "<p>$1</p>", transform: (h) => h });
    expect(page).toContain("<title>Drains from $$89</title>");
    expect(page).toContain('content="Was $$120, now from $$89 ($&amp; off)."');
    expect(page).toContain("<p>Cost: $$5</p>");
    expect(page).toContain("<p>$1</p>");
  });

  it("counts the main keyword per sentence, so stuffing shows", () => {
    const page = { mainKeyword: "drain cleaning", supportingKeywords: [], title: "Drain cleaning", metaDescription: "" };
    const body = Array.from({ length: 6 }, () => "We do drain cleaning. Drain cleaning is what we do.").join(" ");
    const check = analyzeDraft(`# Drain cleaning\n\n${body}\n`, page).checks.find((c) => c.key === "stuffing")!;
    expect(check.ok).toBe(false);
    // The H1 counts once: a short draft using the keyword in its H1 and two sentences isn't stuffed.
    const short = analyzeDraft("# Drain cleaning\n\nWe do drain cleaning. Drain cleaning is fast.\n", page).checks.find((c) => c.key === "stuffing")!;
    expect(short.detail).toMatch(/^3 uses/);
    expect(short.ok).toBe(true);
  });
});

describe("the worker's local file server", () => {
  it("answers a stray % with 400 and keeps serving", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tawd-serve-"));
    await fs.writeFile(path.join(dir, "index.html"), "<h1>Home</h1>");
    const { server, origin } = await serve(dir);
    try {
      expect((await fetch(`${origin}/100%`)).status).toBe(400);
      const home = await fetch(`${origin}/`);
      expect(home.status).toBe(200);
      expect(await home.text()).toBe("<h1>Home</h1>");
    } finally {
      server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
