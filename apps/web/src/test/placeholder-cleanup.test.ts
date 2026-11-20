import { describe, expect, it } from "vitest";

import { checkPlaceholderRule, removeStrayPlaceholders, strayPlaceholders, type IntakeFact } from "@tawd/core/mockups";

/*
  Placeholders only for required fields (Jason, 8 October 2026). Harbor's
  concept B had "Quotes and pricing: [PLACEHOLDER: starting price and how
  quotes work]" and "Service visits: [PLACEHOLDER: how often service visits
  happen]" from optional fields the client left blank. Code now takes them
  out, free; only an empty required field keeps its placeholder.
*/

const facts: IntakeFact[] = [
  { key: "business.name", label: "Business name", value: "Harbor Pest Control", tier: "required" },
  { key: "business.phone", label: "Phone number", value: "(916) 555-0142", tier: "required" },
  { key: "business.licenseNumbers", label: "License number", value: null, tier: "required" },
  { key: "process.quotingAndPricing", label: "Quoting and pricing", value: null, tier: "detail" },
  { key: "process.scheduling", label: "How scheduling works", value: null, tier: "detail" },
];

const card = (title: string, body: string) =>
  `<div class="card"><span class="icon"><svg viewBox="0 0 24 24"><path d="M1 1"/></svg></span><h4>${title}</h4><p class="ph">${body}</p></div>`;

const harborBand = `<html><body><main>
<section class="why"><h2>What sets us apart?</h2><p>We're not just another pest control company in Sacramento. We're your partners in pest prevention, from inspection to long-term protection.</p>
<div class="grid">
${card("Licensed experts", "Licensed to provide pest control services in Sacramento and throughout California under License [PLACEHOLDER: license number].")}
${card("Integrated Pest Management", "We combine inspections, targeted treatments, pest monitoring, and preventative measures to protect your property in the long term.")}
${card("Quotes and pricing", "[PLACEHOLDER: starting price and how quotes work]")}
${card("Service visits", "[PLACEHOLDER: how often service visits happen]")}
</div></section>
<section class="faq"><h2>How booking works</h2><p>[PLACEHOLDER: how scheduling works]</p></section>
<section class="call"><h2>Call us today</h2><p>Call (916) 555-0142 for a free inspection. [PLACEHOLDER: current offer] We answer seven days a week and come out the same week for most jobs.</p></section>
</main></body></html>`;

describe("placeholders only for required fields", () => {
  it("knows which placeholders nothing required asks for", () => {
    expect(strayPlaceholders(harborBand, facts).sort()).toEqual([
      "[PLACEHOLDER: current offer]",
      "[PLACEHOLDER: how often service visits happen]",
      "[PLACEHOLDER: how scheduling works]",
      "[PLACEHOLDER: starting price and how quotes work]",
    ]);
  });

  it("takes out the cards and the band that only held a stray placeholder, and keeps the rest", () => {
    const { html, removed, left } = removeStrayPlaceholders(harborBand, facts);
    // The two cards from Harbor's screenshot, whole (title and icon too).
    expect(html).not.toContain("Quotes and pricing");
    expect(html).not.toContain("Service visits");
    // A band that said nothing else goes entirely.
    expect(html).not.toContain("How booking works");
    // The real cards, the section around them and the empty required field's placeholder stay.
    expect(html).toContain("Integrated Pest Management");
    expect(html).toContain("What sets us apart?");
    expect(html).toContain("[PLACEHOLDER: license number]");
    expect(removed.sort()).toEqual([
      "[PLACEHOLDER: how often service visits happen]",
      "[PLACEHOLDER: how scheduling works]",
      "[PLACEHOLDER: starting price and how quotes work]",
    ]);
    // A stray placeholder inside real copy can't be cut cleanly: left for the fix round.
    expect(left).toEqual(["[PLACEHOLDER: current offer]"]);
    expect(html).toContain("Call us today");
  });

  it("never removes a placeholder standing for a value the intake has (its own check fills it in)", () => {
    const page = `<html><body><main><section><h2>Call</h2><p>[PLACEHOLDER: phone number]</p></section></main></body></html>`;
    expect(strayPlaceholders(page, facts)).toEqual([]);
    expect(removeStrayPlaceholders(page, facts).html).toBe(page);
  });

  it("leaves a page with only wanted placeholders exactly as it was", () => {
    const page = `<html><body><main><section><h2>Licensed</h2><p>License [PLACEHOLDER: license number]</p></section></main></body></html>`;
    expect(removeStrayPlaceholders(page, facts)).toEqual({ html: page, removed: [], left: [] });
  });

  it("fails the check for any placeholder that isn't for an empty required field", () => {
    const issues = checkPlaceholderRule(harborBand, facts);
    const stray = issues.find((i) => i.id === "placeholders.notRequired");
    expect(stray?.severity).toBe("fail");
    expect(stray?.message).toContain("[PLACEHOLDER: how often service visits happen]");
    expect(stray?.message).toContain("leave");
    // The empty required field's placeholder is never flagged.
    expect(issues.every((i) => !(i.message ?? "").includes("[PLACEHOLDER: license number]"))).toBe(true);
  });
});
