import { describe, expect, it } from "vitest";

import { buildPagePrompt, buildSiteSystemPrompt, checkPageVariety, copyGroups, describePageBandPlan, designPatterns, pageBandPlan } from "@tawd/core/site";

/*
  Every page's band plan (17 November 2026), the other six-sevenths of F25.

  Sample Marketing Co.'s Services page, built on live TAWD on 17 November 2026, came
  back as four identical bands - an icon, a heading, a line, a row of plain
  cards - with no picture anywhere in it, beside a home page the client's own
  designer had built from eight different shapes and two photographs.

  The cause was in the prompt, not in the model's taste: a page that is not
  the home page was given one sentence of layout guidance ("Build this page
  from the site's building blocks"), the design's bands as an unnamed pile,
  and a rule saying it "may split it into sections, columns or cards". Four
  content groups and no plan: it picked the safest block and stamped it four
  times. Nothing anywhere asked for a picture, so it used none.

  These tests use Sample Marketing Co.'s own shapes.
*/

const band = (inner: string, attrs = "") => `<section${attrs ? ` ${attrs}` : ""}>${inner}</section>`;

/* The approved design's bands, shaped like Sample Marketing Co.'s home page. */
const DESIGN = [
  band('<h1>More than a campaign</h1><p>A partner in your growth.</p><img src="tawd-asset:photo-1" alt="">'),
  band("<h2>How we can help</h2><ul><li>Plan &amp; Brand</li><li>Get Found</li></ul>"),
  band('<h2>Most marketing stops when the phone rings</h2><img src="tawd-asset:photo-2" alt=""><ul><li>Monthly reviews</li><li>Leads that turn</li><li>New ideas</li></ul>'),
  band("<h2>What clients say</h2><div><h3>Desiree C.</h3><p>a</p></div><div><h3>Sean P.</h3><p>b</p></div><div><h3>Coreen S.</h3><p>c</p></div>"),
  band('<h2>Your numbers, explained</h2><img src="tawd-asset:photo-3" alt=""><div><h3>Calls</h3><p>1</p></div><div><h3>Form leads</h3><p>2</p></div>'),
  band("<h2>Common questions</h2><details><summary>What does Sample Marketing Co. do?</summary><p>a</p></details><form><label for='n'>Name</label><input id='n'></form>"),
  band("<h2>Let's talk about what's next</h2><p>No pressure, no cookie-cutter packages.</p>"),
];

/* The Services copy, in the shape the approved copy actually has: four groups of named items. */
const SERVICES_COPY = `# Services

Sample Marketing Co. helps businesses plan their marketing, get found online, reach the right people, and turn them into customers.

## Plan & Brand

Get clear on your goals before you invest in anything else.

### Strategic Marketing Planning

This is where most clients start.

### Brand Development

A logo, graphics and a simple brand guide.

## Get Found

Show up where customers are looking.

### Website Development

A website built to explain what you do.

### SEO - Search Engine Optimization

Work on your website and content.

### AEO - AI Search Optimization

More people now ask AI tools for recommendations.

## Advertise

Reach the right people with ads built for your goal.

### Google Ads & Local Service Ads

Ads that put your business in front of people searching right now.

### Social Media Ads & Organic Posting

Paid ads and regular posts on social media.

## Engage & Convert

Turn interest into customers with content that connects.

### Content Creation

Writing, graphics and other content.

### Email Marketing

Emails that keep you in touch with leads.

## Not sure where to start?

Tell us about your business and we will talk it through. Request a quote and we will get in touch.
`;

describe("the approved design, read as a vocabulary of patterns", () => {
  const patterns = designPatterns(DESIGN);

  it("numbers each band the way the builder is given them, so a plan can point at one", () => {
    expect(patterns.map((p) => p.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(patterns[0]!.heading).toBe("More than a campaign");
  });

  it("sorts them into families, so two bands running are never the same thing", () => {
    expect(patterns.map((p) => p.key)).toEqual(["picture+words", "points", "picture+points", "cards", "picture+cards", "form", "words"]);
  });

  it("gives nothing back for a design with no bands, rather than throwing", () => {
    expect(designPatterns([])).toEqual([]);
    expect(pageBandPlan(SERVICES_COPY, [], { hasPhoto: true })).toEqual([]);
    expect(describePageBandPlan([])).toBe("");
  });
});

describe("the approved copy, read as its own groups", () => {
  const groups = copyGroups(SERVICES_COPY);

  it("is the H1's opening part, then one group per '## '", () => {
    expect(groups.map((g) => g.heading)).toEqual([null, "Plan & Brand", "Get Found", "Advertise", "Engage & Convert", "Not sure where to start?"]);
  });

  it("counts the items that make a group cards, and notices where the copy asks the visitor to get in touch", () => {
    expect(groups[1]!.subHeadings).toBe(2);
    expect(groups[2]!.subHeadings).toBe(3);
    expect(groups.at(-1)!.asks).toBe(true);
    expect(groups[1]!.asks).toBe(false);
  });
});

describe("the page's band plan", () => {
  const plan = pageBandPlan(SERVICES_COPY, designPatterns(DESIGN), { hasPhoto: true });

  /* The failure this was written for: four groups, four of the same band. */
  it("never gives two bands running the same shape", () => {
    const keys = plan.map((b) => b.pattern!.key);
    for (let i = 1; i < keys.length; i += 1) expect(keys[i]).not.toBe(keys[i - 1]);
  });

  it("uses more than one shape across the page", () => {
    expect(new Set(plan.map((b) => b.pattern!.key)).size).toBeGreaterThanOrEqual(4);
  });

  /* The other half of the failure: not one <img> on the whole page. */
  it("gives the page at least one picture-led band when the site has photos", () => {
    expect(plan.some((b) => b.pattern!.hasPicture)).toBe(true);
  });

  it("opens with the design's own opening band", () => {
    expect(plan[0]!.pattern!.number).toBe(1);
    expect(plan[0]!.heading).toBeNull();
  });

  it("puts the form in the band whose copy asks for it, and nowhere else", () => {
    const withForm = plan.filter((b) => b.pattern!.hasForm);
    expect(withForm).toHaveLength(1);
    expect(withForm[0]!.heading).toBe("Not sure where to start?");
  });

  it("only ever uses bands of the design the client approved", () => {
    const numbers = new Set(designPatterns(DESIGN).map((p) => p.number));
    for (const b of plan) expect(numbers.has(b.pattern!.number)).toBe(true);
  });
});

describe("what the builder is told", () => {
  const described = describePageBandPlan(pageBandPlan(SERVICES_COPY, designPatterns(DESIGN), { hasPhoto: true }));

  it("gives the plan as binding and numbered, pointing at the design's own bands", () => {
    expect(described).toContain("bands, in this order");
    expect(described).toContain("shaped like band ");
    expect(described).toContain("wins over the freedom to split the copy");
    expect(described).toContain("Two bands next to each other are never the same shape");
  });

  it("reaches the page's prompt, in place of the sentence that caused this", () => {
    const prompt = buildPagePrompt({
      page: { id: "p", name: "Services", slug: "services", kind: "hub" } as never,
      copy: SERVICES_COPY,
      pages: [{ id: "p", name: "Services", slug: "services", kind: "hub" } as never],
      isHome: false,
      pagePhotos: [{ token: "tawd-asset:photo-1" }],
      designSections: DESIGN,
    });
    expect(prompt).toContain("shaped like band ");
    expect(prompt).not.toContain("Build this page from the site's building blocks.");
  });

  it("falls back to the old sentence when the design has no bands to copy", () => {
    const prompt = buildPagePrompt({
      page: { id: "p", name: "Services", slug: "services", kind: "hub" } as never,
      copy: SERVICES_COPY,
      pages: [{ id: "p", name: "Services", slug: "services", kind: "hub" } as never],
      isHome: false,
      designSections: [],
    });
    expect(prompt).toContain("Build this page from the site's building blocks.");
  });

  it("numbers the example bands in the system prompt, so the plan's numbers mean something", () => {
    const system = buildSiteSystemPrompt("profile", { css: "", fontLinks: [], header: "", footer: "", sections: DESIGN } as never, "no images");
    expect(system).toContain("<!-- band 1 -->");
    expect(system).toContain("<!-- band 7 -->");
    expect(system).toContain("a page's band plan points at them by number");
    // The rule that used to beat the plan now defers to it on every page, not only the homepage.
    expect(system).toContain("Where the page is given a band plan, this freedom does not apply");
  });
});

describe("the built page, checked against what went wrong", () => {
  /* A built page as the worker has it when it checks: the whole file, header and footer and all. */
  const page = (inner: string) => `<!doctype html><html><body><header><nav><a href="/">Home</a></nav></header><main id="main">${inner}</main><footer><p>Website by Velocity Media Lab</p></footer></body></html>`;
  const sameShape = page(`${band("<h2>A</h2><div><h3>1</h3><p>x</p></div><div><h3>2</h3><p>y</p></div>")}${band("<h2>B</h2><div><h3>1</h3><p>x</p></div><div><h3>2</h3><p>y</p></div>")}${band("<h2>C</h2><div><h3>1</h3><p>x</p></div><div><h3>2</h3><p>y</p></div>")}${band("<h2>D</h2><div><h3>1</h3><p>x</p></div><div><h3>2</h3><p>y</p></div>")}`);

  it("says when a page is the same shape over and over", () => {
    const issues = checkPageVariety(sameShape, { name: "Services", hasPhoto: false });
    expect(issues.map((i) => i.id)).toContain("page.oneShape");
    expect(issues[0]!.message).toContain("Services is 4 bands of the same shape");
  });

  it("says when a page has no picture and the site has photos", () => {
    expect(checkPageVariety(sameShape, { name: "Services", hasPhoto: true }).map((i) => i.id)).toContain("page.noPicture");
    expect(checkPageVariety(sameShape, { name: "Services", hasPhoto: false }).map((i) => i.id)).not.toContain("page.noPicture");
  });

  it("is quiet about a page built from the design's own shapes", () => {
    const varied = page(DESIGN.join(""));
    expect(checkPageVariety(varied, { name: "About", hasPhoto: true })).toEqual([]);
  });

  it("says nothing about a short page: two bands are not a pattern", () => {
    expect(checkPageVariety(page(`${band("<h2>A</h2><p>x</p>")}${band("<h2>B</h2><p>y</p>")}`), { name: "Thanks", hasPhoto: true })).toEqual([]);
  });
});
