import { describe, expect, it } from "vitest";

import { descriptionWithoutClaims, findClaimIssues } from "@tawd/core/mockups";
import { runChecklist } from "@tawd/core/site";

/*
  The claims guard (gap 12): house rules enforced in code for prose claims, not
  only numbers. An invented warranty, free offer, financing or superlative that
  the intake doesn't back must fail and block go-live.
*/

const NONE = { guarantees: "", currentOffers: "", financingAvailable: false };
const ids = (html: string, facts = NONE) => findClaimIssues(html, facts).map((i) => i.id);

describe("the claims guard", () => {
  it("flags a warranty, free offer or financing the intake doesn't back", () => {
    expect(ids("<p>We back every job with a lifetime warranty.</p>")).toContain("house.claim.unsupported");
    expect(ids("<p>Book your free consultation today.</p>")).toContain("house.claim.unsupported");
    expect(ids("<p>Financing available on approved credit.</p>")).toContain("house.claim.unsupported");
    expect(ids("<h2>25% off this month</h2>")).toContain("house.claim.unsupported");
  });

  it("lets a backed claim through", () => {
    expect(findClaimIssues("<p>Every repair carries a 1-year parts warranty.</p>", { ...NONE, guarantees: "1-year parts and labour warranty on every repair" })).toEqual([]);
    expect(findClaimIssues("<p>Ask about our free estimate.</p>", { ...NONE, currentOffers: "Free estimates for new customers" })).toEqual([]);
    expect(findClaimIssues("<p>Financing available.</p>", { ...NONE, financingAvailable: true })).toEqual([]);
  });

  it("reads the guarantee's own duration, not an unrelated number next to it", () => {
    // A backed 1-year warranty with the firm's age beside it must not read as a 25-year over-claim.
    expect(findClaimIssues("<p>Over 25 years of experience. All work backed by our 1-year warranty.</p>", { ...NONE, guarantees: "1-year warranty on all work" })).toEqual([]);
    // And an unrelated big number in the intake text must not hide a real over-claim.
    expect(ids("<p>Every install comes with a 5-year warranty.</p>", { ...NONE, guarantees: "Family-owned for 10 years; 1-year warranty" })).toContain("house.claim.overreach");
    // "for life" is an over-claim against a 1-year intake.
    expect(ids("<p>We guarantee your roof for life.</p>", { ...NONE, guarantees: "1-year workmanship warranty" })).toContain("house.claim.overreach");
  });

  it("doesn't flag a negated guarantee (the privacy policy)", () => {
    // Empty intake, but the policy only says it CANNOT guarantee: not a claim.
    expect(findClaimIssues("<p>We cannot guarantee absolute security of your data.</p>", NONE)).toEqual([]);
    // A real unsupported claim on the same page is still caught.
    expect(ids("<p>We cannot guarantee absolute security. Every job has a lifetime warranty.</p>", NONE)).toContain("house.claim.unsupported");
    // "can't" with a curly apostrophe (as generated/policy copy often has it) is still a negation.
    expect(findClaimIssues("<p>We can’t guarantee absolute security.</p>", NONE)).toEqual([]);
    // But "Don't miss our free consultation" is a promotion, not a negation: the invented offer is still caught.
    expect(ids("<p>Don't miss our free consultation!</p>", NONE)).toContain("house.claim.unsupported");
    // An unrelated negation in an earlier sentence doesn't negate the offer either.
    expect(ids("<p>No pressure. Don't miss our free estimate!</p>", NONE)).toContain("house.claim.unsupported");
    // A genuine negation in the claim's own clause still counts.
    expect(findClaimIssues("<p>We do not offer free estimates.</p>", NONE)).toEqual([]);
  });

  it("doesn't false-flag addresses, priorities, memberships or 'no hidden' copy", () => {
    expect(findClaimIssues("<p>Visit us at 123 Main St #1, Sacramento.</p>", NONE)).toEqual([]);
    expect(findClaimIssues("<p>Your safety is our #1 priority.</p>", NONE)).toEqual([]);
    expect(findClaimIssues("<p>No hidden discounts or coupons — just honest pricing.</p>", NONE)).toEqual([]);
    expect(findClaimIssues("<p>Our maintenance plan is a simple monthly payment.</p>", NONE)).toEqual([]);
    // But a real ranking claim or concrete offer is still caught.
    expect(ids("<p>Rated #1 in Sacramento.</p>")).toContain("house.claim.superlative");
    expect(ids("<h2>25% off this month</h2>")).toContain("house.claim.unsupported");
  });

  // #1a (client bug list): a whole band built on an unsupported optional fact, worded
  // past the phrase-level guards ("Lifetime Materials", "Complimentary Design Session").
  // The band's heading declares its topic; the issue carries the band's index.
  describe("a whole section built on an unsupported optional fact (#1a)", () => {
    const page = (bands: string) => `<!doctype html><html><body><main>${bands}</main></body></html>`;
    const sectionIssues = (html: string, facts = NONE) => findClaimIssues(html, facts).filter((i) => i.id === "house.section.unsupported");

    it("flags the band by its heading and names which band", () => {
      const html = page("<section><h1>Patio Covers in Sacramento</h1></section><section><h2>Lifetime Materials</h2><p>Built to last.</p></section>");
      const issues = sectionIssues(html);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.evidence).toBe("Lifetime Materials");
      expect(issues[0]!.sections).toEqual([1]);
      // Paraphrases the word-level guard can't know: still a section-level catch.
      expect(sectionIssues(page("<section><h2>Complimentary Design Session</h2><p>We visit your home.</p></section>"))).toHaveLength(1);
      expect(sectionIssues(page("<section><h2>Payment Plans</h2><p>Spread the cost.</p></section>"))).toHaveLength(1);
      expect(sectionIssues(page("<section><h2>Our Money-Back Promise</h2><p>Love it or we fix it.</p></section>"))).toHaveLength(1);
    });

    it("stays quiet on backed topics, poetic lifetimes, compounds, placeholders and confirmed financing", () => {
      // Backed by the intake: the band is legitimate.
      expect(sectionIssues(page("<section><h2>Lifetime Materials Warranty</h2></section>"), { ...NONE, guarantees: "Lifetime material warranty" })).toEqual([]);
      // A poetic "lifetime" with no build-quality word is the Creative Director's call, never a block.
      expect(sectionIssues(page("<section><h1>A Lifetime of Shade Starts Here</h1></section>"))).toEqual([]);
      // A "-free" compound heading is not an offer.
      expect(sectionIssues(page("<section><h2>Worry-Free Installation</h2></section>"))).toEqual([]);
      // "Free" with no offer noun in the heading is left alone.
      expect(sectionIssues(page("<section><h2>Feel Free to Browse Our Work</h2></section>"))).toEqual([]);
      // A heading already shown as a placeholder to confirm is not flagged again.
      expect(sectionIssues(page("<section><h2>[PLACEHOLDER: warranty — confirm with the client]</h2></section>"))).toEqual([]);
      // Financing confirmed in the intake.
      expect(sectionIssues(page("<section><h2>Financing Options</h2></section>"), { ...NONE, financingAvailable: true })).toEqual([]);
      // A fragment without a body (every other test here) has no sections to read.
      expect(sectionIssues("<h2>Lifetime Materials</h2>")).toEqual([]);
    });
  });

  it("catches a guarantee stated stronger than the intake supports", () => {
    // Backed by a 1-year warranty, but the page claims lifetime.
    expect(ids("<p>Protected by our lifetime warranty.</p>", { ...NONE, guarantees: "1-year workmanship warranty" })).toContain("house.claim.overreach");
    // A longer duration than the intake gave.
    expect(ids("<p>Every install comes with a 10-year warranty.</p>", { ...NONE, guarantees: "2-year warranty on installs" })).toContain("house.claim.overreach");
    // Money-back when the intake never said so.
    expect(ids("<p>100% money-back guarantee.</p>", { ...NONE, guarantees: "1-year parts warranty" })).toContain("house.claim.overreach");
  });

  it("the over-claim is for human review, not an automatic fix", () => {
    const issue = findClaimIssues("<p>Protected by our lifetime warranty.</p>", { ...NONE, guarantees: "1-year workmanship warranty" }).find((i) => i.id === "house.claim.overreach");
    expect(issue?.needsIntake).toBe(true);
  });

  it("strips superlatives (banned outright, never backed)", () => {
    expect(ids("<h1>The best plumber in Sacramento</h1>")).toContain("house.claim.superlative");
    expect(ids("<p>Rated #1 by local homeowners.</p>")).toContain("house.claim.superlative");
    expect(ids("<p>Our award-winning team.</p>")).toContain("house.claim.superlative");
    expect(ids("<p>Guaranteed results, every time.</p>")).toContain("house.claim.superlative");
  });

  it("doesn't false-flag ordinary copy", () => {
    expect(findClaimIssues("<p>The best time to call is the morning.</p>", NONE)).toEqual([]);
    expect(findClaimIssues("<p>We serve every home in the county.</p>", NONE)).toEqual([]);
  });

  it("keeps negation inside its own block, matches plural offers, and ignores a negated warranty", () => {
    // A negation in one block doesn't carry into the next block's offer.
    expect(ids("<p>No financing available.</p><p>Ask about our free estimate.</p>", NONE)).toContain("house.claim.unsupported");
    // Plural offers are caught too.
    expect(ids("<p>Free estimates for every new roof.</p>", NONE)).toContain("house.claim.unsupported");
    // A negated warranty doesn't count toward the page's strength, so no false over-claim.
    expect(findClaimIssues("<p>We do not offer a lifetime warranty. Our work has a 1-year warranty.</p>", { ...NONE, guarantees: "1-year warranty on all work" })).toEqual([]);
  });

  it("catches a free offer however it's worded, without false-flagging a benign 'free'", () => {
    // An adjective between "free" and the offer noun (the real client wording).
    expect(ids("<h3>Free Design Consultation</h3>", NONE)).toContain("house.claim.unsupported");
    expect(ids("<p>Ask about our free in-home estimate.</p>", NONE)).toContain("house.claim.unsupported");
    // Synonyms for "free".
    expect(ids("<p>Book a complimentary consultation.</p>", NONE)).toContain("house.claim.unsupported");
    expect(ids("<p>Ask about our no-cost estimate.</p>", NONE)).toContain("house.claim.unsupported");
    // The offer worded as a paraphrase after the noun.
    expect(ids("<p>And the design consultation costs nothing.</p>", NONE)).toContain("house.claim.unsupported");
    // Backed by the intake, the adjective wording passes.
    expect(findClaimIssues("<h3>Free Design Consultation</h3>", { ...NONE, currentOffers: "Free design consultations for new clients" })).toEqual([]);
    // Benign "free" that names no offer must NOT be flagged (no go-live block).
    expect(findClaimIssues("<p>You're free to choose any colour you like.</p>", NONE)).toEqual([]);
    expect(findClaimIssues("<p>Feel free to call us anytime.</p>", NONE)).toEqual([]);
    expect(findClaimIssues("<p>On-site parking is free of charge.</p>", NONE)).toEqual([]);
    // A "…-free" adjective ("worry-free", "hassle-free") means "without X", not "no charge".
    expect(findClaimIssues("<p>Enjoy a worry-free estimate and hassle-free installation.</p>", NONE)).toEqual([]);
    expect(findClaimIssues("<p>Get a risk-free consultation on your own terms.</p>", NONE)).toEqual([]);
    // Same when the compound is typed with a Unicode hyphen (non-breaking hyphen / en dash).
    expect(findClaimIssues("<p>Enjoy a worry‑free estimate and a hassle–free quote.</p>", NONE)).toEqual([]);
    // And when that hyphen is an HTML entity ("worry&#8209;free").
    expect(findClaimIssues("<p>Enjoy a worry&#8209;free estimate.</p>", NONE)).toEqual([]);
    // A verb reading of "free"/offer words ("free yourself", "feel free to consult/quote").
    expect(findClaimIssues("<p>Free yourself from a quote you can't trust.</p>", NONE)).toEqual([]);
    expect(findClaimIssues("<p>Feel free to consult our guide before you book.</p>", NONE)).toEqual([]);
    expect(findClaimIssues("<p>Feel free to quote this article anywhere.</p>", NONE)).toEqual([]);
    // "complimentary"/"costs nothing" + an opinion word ("assessment") is not an offer.
    expect(findClaimIssues("<p>The inspector left a complimentary assessment of our crew.</p>", NONE)).toEqual([]);
    expect(findClaimIssues("<p>Peace of mind costs nothing.</p>", NONE)).toEqual([]);
  });

  it("doesn't flag a claim already shown as a placeholder", () => {
    expect(findClaimIssues('<p>We offer a <mark class="tawd-placeholder">[PLACEHOLDER: warranty — confirm with the client]</mark> on every job.</p>', NONE)).toEqual([]);
  });

  it("blocks go-live when an unconfirmed claim is on the built site", () => {
    const pages = new Map<string, string>([
      ["index.html", "<html><body><h1>ACME Plumbing</h1><p>Backed by our lifetime warranty.</p><a href=\"tel:+19165550142\">Call</a></body></html>"],
    ]);
    const item = runChecklist({ files: pages, pagePaths: ["/"], domain: "acme.example", mobileOverflow: [], gbpUrl: "", claims: NONE }).find((i) => i.key === "claims");
    expect(item?.ok).toBe(false);
    expect(item?.blocksGoLive).toBe(true);
    // Clean once the intake backs it.
    const ok = runChecklist({ files: pages, pagePaths: ["/"], domain: "acme.example", mobileOverflow: [], gbpUrl: "", claims: { ...NONE, guarantees: "Lifetime warranty on all workmanship" } }).find((i) => i.key === "claims");
    expect(ok?.ok).toBe(true);
  });
});

/*
  Jason's run, 10 November 2026: both concepts' metadata carried claims the
  intake never made.

  Concept B's meta description said "Family owned since 1970"; Concept A's
  said "family owned" and "free design consultation". The guard never saw
  any of it: a description lives in an ATTRIBUTE, and the text the guard
  reads is built by stripping whole tags, attributes and all. So the one
  sentence Google shows under the result was the one sentence no check
  looked at. Only the Creative Director caught it, by eye, at review price.
*/
describe("the claims guard and the page's metadata", () => {
  const head = (description: string, title = "Patio covers in Fair Oaks") =>
    `<!doctype html><html><head><title>${title}</title><meta name="description" content="${description}"></head><body><p>Patio covers, built since 1970.</p></body></html>`;

  it("reads the meta description", () => {
    expect(ids(head("Family owned since 1970. Book your free design consultation."))).toContain("house.claim.unsupported");
    const found = findClaimIssues(head("Book your free design consultation today."), NONE);
    expect(found.some((i) => (i.evidence ?? "").toLowerCase().includes("free design consultation"))).toBe(true);
  });

  it("reads the page title", () => {
    expect(ids(head("Patio covers in Fair Oaks, built since 1970.", "The best patio covers in Fair Oaks"))).toContain("house.claim.superlative");
  });

  it("leaves an ordinary description alone", () => {
    expect(findClaimIssues(head("Custom aluminium patio covers in Fair Oaks, building since 1970. Call for a quote."), NONE)).toEqual([]);
  });

  it("lets the description say what the intake backs", () => {
    expect(
      findClaimIssues(head("Free estimates on every patio cover."), { ...NONE, currentOffers: "Free estimates" }),
    ).toEqual([]);
  });

  /*
    "Family owned" is the other half of the same fault, and it needed a rule
    of its own: there is no intake field for ownership, so nothing could
    ever back or refuse it. It is exactly the kind of claim a local-services
    page invents, and a client who is not family owned would have shipped a
    lie on their own website.
  */
  it("flags an ownership claim the client never made", () => {
    expect(ids("<p>A family owned business since 1970.</p>")).toContain("house.claim.unsupported");
    expect(ids("<p>Family-run, and proud of it.</p>")).toContain("house.claim.unsupported");
    expect(ids("<p>We are a veteran owned company.</p>")).toContain("house.claim.unsupported");
    expect(ids("<p>Third-generation craftsmen.</p>")).toContain("house.claim.unsupported");
    expect(ids("<p>The owners are second generation.</p>")).toContain("house.claim.unsupported");
    expect(ids(head("Family owned since 1970, serving Fair Oaks."))).toContain("house.claim.unsupported");
  });

  /*
    This check fails a page and blocks a go-live, so it carries the
    no-false-positive priority the rest of the guard has.
  */
  it("leaves the two that would have been noise", () => {
    // "Locally owned and operated" is on almost every local trade's site and is true of nearly
    // all of them: flagging it would have made the guard noise, and noise stops being read.
    expect(findClaimIssues("<p>Locally owned and operated in Fair Oaks.</p>", NONE)).toEqual([]);
    // And a generation claim about a PRODUCT is not a claim about the owners.
    expect(findClaimIssues("<p>We install second-generation heat pumps.</p>", NONE)).toEqual([]);
    expect(findClaimIssues("<p>Third generation inverter technology.</p>", NONE)).toEqual([]);
  });

  it("lets it through when the client's own words say so, in whatever words", () => {
    const stated = { ...NONE, statedText: "We are a family owned shop, second generation, serving Fair Oaks since 1970." };
    /*
      One claim in two word orders is one claim: the client wrote "a family
      owned shop, second generation" and the page says "Second generation
      owners". Kept as separate claims - which is how this started - the
      client's own sentence did not back their own page.
    */
    expect(findClaimIssues("<p>A family owned business since 1970.</p>", stated)).toEqual([]);
    expect(findClaimIssues("<p>Second generation owners.</p>", stated)).toEqual([]);
    // A different ownership claim is still not backed by that sentence.
    expect(findClaimIssues("<p>A veteran owned company.</p>", stated).map((i) => i.id)).toContain("house.claim.unsupported");
  });

  it("is not fooled by a word that merely contains the claim", () => {
    // "family" alone is not an ownership claim: a page may talk about families it serves.
    expect(findClaimIssues("<p>Shade your family's backyard all summer.</p>", NONE)).toEqual([]);
    expect(findClaimIssues("<p>A family-friendly crew.</p>", NONE)).toEqual([]);
    // And a negated claim is not a claim.
    expect(findClaimIssues("<p>We are not a family owned franchise.</p>", NONE)).toEqual([]);
  });

  /* CodeRabbit on PR #75 (12 November 2026), each checked against the code first. */
  it("a generation is part of the fact: the client's second generation does not back a page's fourth", () => {
    const second = { ...NONE, statedText: "Second generation owners, serving Fair Oaks." };
    expect(findClaimIssues("<p>Second generation owners.</p>", second)).toEqual([]);
    expect(findClaimIssues("<p>2nd-generation owners.</p>", second)).toEqual([]);
    expect(ids("<p>Fourth generation owners.</p>", second)).toContain("house.claim.unsupported");
    expect(ids("<p>Third generation craftsmen.</p>", second)).toContain("house.claim.unsupported");
  });

  it("a business noun near a product's generation is not an ownership claim", () => {
    expect(findClaimIssues("<p>Our business installs second-generation heat pumps.</p>", NONE)).toEqual([]);
    expect(findClaimIssues("<p>The shop now stocks third generation inverters.</p>", NONE)).toEqual([]);
    // The ownership readings still read.
    expect(ids("<p>A family business, now in its third generation.</p>")).toContain("house.claim.unsupported");
    expect(ids("<p>The owners are second generation.</p>")).toContain("house.claim.unsupported");
  });

  it("a product's generation followed by a people noun further on is not a claim; a generation next to its people is", () => {
    expect(findClaimIssues("<p>Second-generation heat pumps from our team of installers.</p>", NONE)).toEqual([]);
    expect(findClaimIssues("<p>Third generation inverters that your family will love.</p>", NONE)).toEqual([]);
    expect(findClaimIssues("<p>Second-generation heat pumps, built by our business partner.</p>", NONE)).toEqual([]);
    expect(ids("<p>A second-generation family business.</p>")).toContain("house.claim.unsupported");
    expect(ids("<p>Third generation owners.</p>")).toContain("house.claim.unsupported");
    expect(ids("<p>Meet our 2nd-generation plumbers.</p>")).toContain("house.claim.unsupported");
  });

  it("a description claim matches on whole words and the write-back never touches data-content", () => {
    const issue = (evidence: string) => ({ id: "house.claim.superlative", evidence }) as never;
    // "best" must not take out a sentence that only holds "bestselling".
    const html = '<meta name="description" content="Our bestselling plans are simple. We are the best in town.">';
    const out = descriptionWithoutClaims(html, [issue("best")]);
    expect(out.removed).toBe(1);
    expect(out.html).toContain("Our bestselling plans are simple.");
    expect(out.html).not.toContain("the best in town");
    // Regex characters in the evidence are plain text.
    expect(descriptionWithoutClaims('<meta name="description" content="Call us (24/7). We fix it.">', [issue("(24/7)")]).removed).toBe(1);
    // The write-back replaces `content=`, not the `content=` inside `data-content=`.
    const tagged = '<meta name="description" data-content="keep" content="We are the best. We fix it.">';
    const next = descriptionWithoutClaims(tagged, [issue("the best")]);
    expect(next.html).toContain('data-content="keep"');
    expect(next.html).toContain('content="We fix it."');
  });

  it("the client's words are read with the same hyphens as the page's", () => {
    // U+2011, the non-breaking hyphen, as a phone keyboard or a pasted document gives it.
    const stated = { ...NONE, statedText: "We are family‑owned." };
    expect(findClaimIssues("<p>We are family-owned.</p>", stated)).toEqual([]);
    expect(findClaimIssues("<p>We are family‐owned.</p>", { ...NONE, statedText: "We are family-owned." })).toEqual([]);
  });

  it("a client who says they are NOT something does not back a page that says they are", () => {
    const denied = { ...NONE, statedText: "We are not family owned." };
    expect(ids("<p>We are family owned.</p>", denied)).toContain("house.claim.unsupported");
    // A denial elsewhere in their words does not undo a plain statement.
    const both = { ...NONE, statedText: "We are not a franchise. Family owned since 1970." };
    expect(findClaimIssues("<p>We are family owned.</p>", both)).toEqual([]);
  });
});

/*
  A band of articles nobody wrote (Jason's run, 10 November 2026).

  Both concepts built one. Concept A's "Our Blogs" showed post titles and
  dates the intake never supplied with "Read more" links that go nowhere,
  and the Creative Director scored Placeholders only where required 2 of 5
  for it: "a section for unasked content ... Remove the blog band
  entirely". Concept B had the same band with fabricated dates and every
  link a "#".

  The claim phrases guard and the section-heading guard both missed it,
  because the invention is not a phrase or a heading: it is a list of
  ITEMS that do not exist. The test a machine can settle is the links: an
  article nobody can open is an article nobody wrote.

  A makeover that keeps the client's real posts links to real paths, so it
  is not touched - which is the whole point of testing the links rather
  than the words.
*/
describe("a band of articles that go nowhere", () => {
  const band = (items: string) =>
    `<!doctype html><html><head><title>T</title></head><body><section><h2>Patio cover guides and answers</h2><div class="posts">${items}</div></section></body></html>`;

  const post = (href: string, title: string, date = "March 4, 2024") =>
    `<article><span>${date}</span><h3>${title}</h3><a href="${href}">Read more</a></article>`;

  it("fails a band whose every article link goes nowhere", () => {
    const found = findClaimIssues(
      band([post("#", "Aluminium or wood?"), post("#", "Do I need a permit?"), post("#", "Lattice or solid?")].join("")),
      NONE,
    );
    expect(found.map((i) => i.id)).toContain("house.section.unsupported");
    expect(found.find((i) => i.id === "house.section.unsupported")!.message).toContain("link");
  });

  it("counts an empty href, a javascript: link and a bare anchor as nowhere", () => {
    for (const href of ["#", "", "javascript:void(0)", "#missing-id"]) {
      expect(
        findClaimIssues(band([post(href, "One"), post(href, "Two")].join("")), NONE).map((i) => i.id),
        `href "${href}" was treated as a real article`,
      ).toContain("house.section.unsupported");
    }
  });

  it("leaves a band whose articles link to real pages alone", () => {
    const real = band(
      [
        post("/blog/aluminium-or-wood-patio-covers/", "Aluminium or wood?"),
        post("/blog/do-i-need-a-permit/", "Do I need a permit?"),
      ].join(""),
    );
    expect(findClaimIssues(real, NONE)).toEqual([]);
    // One real link among them is enough: the band is not invented, and the rest is the reviewer's call.
    const mixed = band([post("/blog/aluminium-or-wood-patio-covers/", "One"), post("#", "Two")].join(""));
    expect(findClaimIssues(mixed, NONE)).toEqual([]);
  });

  it("finds articles nested inside a wrapper div and an <ul>", () => {
    const wrapped = `<!doctype html><html><head><title>T</title></head><body><section><h2>Guides</h2><div class="outer"><div class="posts">${post("#", "One")}${post("#", "Two")}</div></div></section></body></html>`;
    expect(findClaimIssues(wrapped, NONE).map((i) => i.id)).toContain("house.section.unsupported");
  });

  it("treats an in-page anchor to an id the page has as a real link", () => {
    const page = `<!doctype html><html><head><title>T</title></head><body><section><h2>Guides</h2><div>${post("#contact", "One")}${post("#contact", "Two")}</div></section><section id="contact"><h2>Contact</h2></section></body></html>`;
    expect(findClaimIssues(page, NONE)).toEqual([]);
  });

  it("does not take 'Learn more about ...' for a read-more link", () => {
    const learn = (t: string) => `<article><h3>${t}</h3><a href="#">Learn more about our 20 years</a></article>`;
    expect(findClaimIssues(band(learn("Roofing") + learn("Gutters")), NONE)).toEqual([]);
  });

  it("checks every link in an article, not just the first", () => {
    const two = (href: string) =>
      `<article><span>March 4, 2024</span><a href="#">Read more</a><a href="${href}">Share</a></article>`;
    expect(findClaimIssues(band(two("/blog/a/") + two("/blog/b/")), NONE)).toEqual([]);
  });

  it("is not fooled by the rest of a page", () => {
    // A services grid whose cards link nowhere is not an articles band: no dates, no "read more".
    const services = `<!doctype html><html><head><title>T</title></head><body><section><h2>What we build</h2><div><article><h3>Patio covers</h3><a href="#">More</a></article><article><h3>Awnings</h3><a href="#">More</a></article></div></section></body></html>`;
    expect(findClaimIssues(services, NONE)).toEqual([]);
    // And one lone article card is not a band of them.
    expect(findClaimIssues(band(post("#", "Aluminium or wood?")), NONE)).toEqual([]);
  });
});
