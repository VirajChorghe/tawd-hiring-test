import { describe, expect, it } from "vitest";

import { buildPagePrompt, buildSiteSystemPrompt, checkHomeAgainstPlan, describeHomeBandPlan, homeBandPlan } from "@tawd/core/site";

/*
  F25: the built home page drifts from the approved mockup.

  The approved mockup is what the team and the client said yes to. The home
  page was then written fresh from the approved copy, held together by one
  sentence - "keep the approved homepage's layout and sections" - against
  three rules that all pulled the other way: use the copy "word for word,
  in its order", "you may split it into sections, columns or cards", and a
  hard rule giving any page that asks the visitor to get in touch a contact
  form with named fields in a named order.

  a client's contact band, ONE two-column section in the mockup, came out
  as an info band and a separate form band. That is those rules winning,
  and nothing anywhere compared the built page with the mockup.
*/

const band = (inner: string, attrs = "") => `<section${attrs ? ` ${attrs}` : ""}>${inner}</section>`;

/* An approved mockup shaped like a client's: a hero, services, why, process, and ONE contact band with the form in it. */
const MOCKUP = `<!doctype html><html><head><style>body{margin:0}</style></head><body>
<header><nav><a href="/">Home</a></nav></header>
${band('<h1>Patio covers in Sacramento</h1><p>Since 2004.</p><img src="tawd-asset:photo-1" alt="A patio cover">')}
${band('<h2>What we build</h2><div><h3>Patio covers</h3><p>a</p></div><div><h3>Awnings</h3><p>b</p></div><div><h3>Sunrooms</h3><p>c</p></div>')}
${band("<h2>Why us</h2><ul><li>Licensed</li><li>Twenty years</li></ul>")}
${band("<h2>How it works</h2><ol><li>Call</li><li>Measure</li><li>Build</li></ol>")}
${band('<h2>Get a quote</h2><div><p>Call us on (916) 555-0142.</p></div><div><form><label for="n">Name</label><input id="n"></form></div>')}
<footer><p>Website by Velocity Media Lab</p></footer>
</body></html>`;

describe("the approved homepage's band plan", () => {
  const plan = homeBandPlan(MOCKUP);

  it("is the mockup's bands in order, without the header and footer", () => {
    expect(plan.map((b) => b.number)).toEqual([1, 2, 3, 4, 5]);
    expect(plan.map((b) => b.heading)).toEqual(["Patio covers in Sacramento", "What we build", "Why us", "How it works", "Get a quote"]);
  });

  it("says what each band is made of, so a band can be rebuilt as the same shape", () => {
    expect(plan[0]!.shape).toContain("a picture");
    expect(plan[1]!.shape).toContain("3 cards");
    expect(plan[2]!.shape).toContain("a list");
    // The contact band: one band, with the form inside it. This is the band a client's build split in two.
    expect(plan[4]!.shape).toContain("a form");
  });

  it("is empty for a page with nothing in it, rather than throwing", () => {
    expect(homeBandPlan("<html><body></body></html>")).toEqual([]);
    expect(describeHomeBandPlan([])).toBe("");
  });
});

describe("what the builder is told", () => {
  const plan = homeBandPlan(MOCKUP);
  const described = describeHomeBandPlan(plan);

  it("gives the plan as binding, numbered, with each band's shape", () => {
    expect(described).toContain("has these 5 bands, in this order");
    expect(described).toContain('1. "Patio covers in Sacramento"');
    expect(described).toContain('5. "Get a quote"');
    expect(described).toContain("the same bands in the same order, one for one");
  });

  it("settles the three rules that used to beat it", () => {
    // The freedom to split copy.
    expect(described).toContain("wins over the freedom to split the copy");
    expect(described).toContain("Do not split one of these bands into two");
    // The contact-form rule, which is how one band became two.
    expect(described).toContain("goes inside the band above that already has one");
    // And no inventing a band where the copy and the mockup disagree.
    expect(described).toContain("Never add a band that is not on this list");
  });

  it("reaches the homepage's prompt, and only the homepage's", () => {
    const home = buildPagePrompt({
      page: { name: "Home", kind: "home", slug: "" },
      copy: "# Patio covers in Sacramento",
      pages: [{ name: "Home", kind: "home", slug: "" }],
      isHome: true,
      homePlan: plan,
    });
    expect(home).toContain("has these 5 bands, in this order");

    const about = buildPagePrompt({
      page: { name: "About", kind: "about", slug: "about" },
      copy: "# About us",
      pages: [{ name: "Home", kind: "home", slug: "" }],
      isHome: false,
      homePlan: plan,
    });
    expect(about).toContain("Build this page from the site's building blocks.");
    expect(about).not.toContain("bands, in this order");
  });

  /*
    Without a plan the old sentence is all there was, and it is kept for a
    Lane 2 build, which has no approved mockup to hold the homepage to.
  */
  it("falls back to the old sentence when there is no plan", () => {
    const home = buildPagePrompt({
      page: { name: "Home", kind: "home", slug: "" },
      copy: "# Home",
      pages: [{ name: "Home", kind: "home", slug: "" }],
      isHome: true,
      homePlan: [],
    });
    expect(home).toContain("keep the approved homepage's layout and sections");
    expect(home).not.toContain("bands, in this order");
  });

  /* The wording widened on 17 November 2026: every page gets a band plan now, not only the homepage, and the rule defers to whichever page has one. */
  it("tells every page that a band plan outranks splitting the copy", () => {
    const system = buildSiteSystemPrompt("profile", { css: "", fontLinks: [], header: "", footer: "", sections: ["<section>a</section>"] }, "assets");
    expect(system).toContain("Where the page is given a band plan, this freedom does not apply");
    expect(system).toContain("F25, 10 November 2026 for the homepage");
    expect(system).toContain("never in a band of its own");
  });
});

describe("the built homepage against the plan", () => {
  const plan = homeBandPlan(MOCKUP);

  it("says nothing when the bands match", () => {
    const built = `<!doctype html><html><body><header><nav>n</nav></header>
${band("<h1>Patio covers in Sacramento</h1>")}${band("<h2>What we build</h2>")}${band("<h2>Why us</h2>")}${band("<h2>How it works</h2>")}${band('<h2>Get a quote</h2><form><label for="n">Name</label><input id="n"></form>')}
<footer>f</footer></body></html>`;
    expect(checkHomeAgainstPlan(built, plan)).toEqual([]);
  });

  /* a client's actual fault: the contact band split into an info band and a form band. */
  it("catches the contact band split in two, and names both sequences", () => {
    const built = `<!doctype html><html><body><header><nav>n</nav></header>
${band("<h1>Patio covers in Sacramento</h1>")}${band("<h2>What we build</h2>")}${band("<h2>Why us</h2>")}${band("<h2>How it works</h2>")}${band("<h2>Get a quote</h2><p>Call us.</p>")}${band('<h2>Send a message</h2><form><label for="n">Name</label><input id="n"></form>')}
<footer>f</footer></body></html>`;
    const [issue, ...rest] = checkHomeAgainstPlan(built, plan);
    expect(rest).toEqual([]);
    expect(issue!.id).toBe("home.bandsDiffer");
    expect(issue!.severity).toBe("fail");
    expect(issue!.message).toContain("has 5 bands and the built homepage has 6");
    expect(issue!.message).toContain("a band was split or added");
    // Both sequences, so the team can see which band went where.
    expect(issue!.message).toContain("Get a quote");
    expect(issue!.message).toContain("Send a message");
  });

  it("catches a band left out as well as one added", () => {
    const built = `<!doctype html><html><body><header><nav>n</nav></header>
${band("<h1>Patio covers in Sacramento</h1>")}${band("<h2>What we build</h2>")}${band("<h2>Why us</h2>")}${band('<h2>Get a quote</h2><form><label for="n">Name</label><input id="n"></form>')}
<footer>f</footer></body></html>`;
    const [issue] = checkHomeAgainstPlan(built, plan);
    expect(issue!.message).toContain("has 5 bands and the built homepage has 4");
    expect(issue!.message).toContain("a band was merged or left out");
  });

  it("judges nothing when there is no plan to judge against", () => {
    expect(checkHomeAgainstPlan("<html><body><section>a</section></body></html>", [])).toEqual([]);
  });
});
