import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
  US phone numbers, one way (Jason, 6 October 2026): every client site shows
  them as (916) 555-0142, however the team typed them. The intake saves them
  that way; the pages TAWD writes by code use it; a free code pass rewrites
  every number in the built pages' words (the AI's, a makeover's kept
  words), never inside tags, scripts, styles or comments; and the checks
  that compare numbers compare digits.
*/

import { parseIntake } from "@tawd/core/intake";
import { intakePhones, listIntakeFacts } from "@tawd/core/mockups";
import {
  formatPhonesInHtml,
  formatPhonesInText,
  formatUsPhone,
  phoneStyleOf,
  keptWordsCheck,
  localBusinessSchema,
  notFoundMain,
  phoneHref,
  phoneWords,
  policyFieldsFrom,
  programChecks,
  samePhone,
  schemaPhone,
  thankYouMain,
  usPhoneDigits,
  wordpressPackage,
  type BusinessFacts,
  type PageSummary,
} from "@tawd/core/site";
import { formatSitePhones } from "../../../worker/src/site-build";

describe("one number", () => {
  it("writes every usual way of typing a US number as (916) 555-0142", () => {
    for (const typed of [
      "9165550142",
      "916.555.0142",
      "916-555-0142",
      "916 555 0142",
      "+1 916 555 0142",
      "+1-916-555-0142",
      "+19165550142",
      "1-916-555-0142",
      "1 (916) 555-0142",
      "(916)555-0142",
      "(916) 555-0142",
      " (916)  555 - 0142 ",
    ]) {
      expect(formatUsPhone(typed), typed).toBe("(916) 555-0142");
    }
  });

  it("keeps an extension after the number", () => {
    expect(formatUsPhone("916-555-0142 x123")).toBe("(916) 555-0142 ext. 123");
    expect(formatUsPhone("916.555.0142 ext. 12")).toBe("(916) 555-0142 ext. 12");
    expect(formatUsPhone("(916) 555-0142, Ext 7")).toBe("(916) 555-0142 ext. 7");
    expect(phoneHref("916-555-0142 x123")).toBe("tel:+19165550142,123");
  });

  it("never mangles what isn't a US number", () => {
    for (const typed of ["+44 20 7123 4567", "+61 2 9876 5432", "555-0142", "916-555-014", "123-456-7890", "call the office", "", "[PLACEHOLDER: phone number]", "916-555-01425"]) {
      expect(formatUsPhone(typed), typed).toBe(typed);
    }
    expect(usPhoneDigits("+44 20 7123 4567")).toBeNull();
  });

  it("gives the tap-to-call link, the schema form and compares numbers by their digits", () => {
    expect(phoneHref("(916) 555-0142")).toBe("tel:+19165550142");
    expect(phoneHref("916.555.0142")).toBe("tel:+19165550142");
    expect(phoneHref("+44 20 7123 4567")).toBe("tel:+442071234567");
    expect(phoneHref("555-0142")).toBeNull();
    expect(phoneHref("")).toBeNull();
    expect(schemaPhone("916.555.0142")).toBe("+1-916-555-0142");
    expect(schemaPhone(" +44 20 7123 4567 ")).toBe("+44 20 7123 4567");
    expect(samePhone("916-555-0142", "+1 (916) 555 0142")).toBe(true);
    expect(samePhone("9165550142", "19165550142")).toBe(true);
    expect(samePhone("916-555-0142", "916-555-0143")).toBe(false);
    expect(samePhone("", "")).toBe(false);
    // The speed pass's link labels use the same reading.
    expect(phoneWords("tel:+19165550142")).toBe("(916) 555-0142");
    expect(phoneWords("tel:9165550142")).toBe("(916) 555-0142");
    expect(phoneWords("tel:+442071234567")).toBe("+442071234567");
  });
});

describe("numbers in a page's words", () => {
  it("rewrites the numbers people write in sentences", () => {
    expect(formatPhonesInText("Call 916.555.0142 today.")).toBe("Call (916) 555-0142 today.");
    expect(formatPhonesInText("Call us at 916-555-0142, or text +1 916 555 0143.")).toBe("Call us at (916) 555-0142, or text (916) 555-0143.");
    expect(formatPhonesInText("Toll free: 1-800-555-0199!")).toBe("Toll free: (800) 555-0199!");
    expect(formatPhonesInText("Office (916)555-0142 ext. 4")).toBe("Office (916) 555-0142 ext. 4");
    expect(formatPhonesInText("Phone:916-555-0142")).toBe("Phone:(916) 555-0142");
    // Already right: the same string back.
    const right = "Call (916) 555-0142.";
    expect(formatPhonesInText(right)).toBe(right);
  });

  it("leaves alone what only looks like a phone number", () => {
    for (const text of [
      "Prices from $1,234.56 to $9,165,550.14.",
      "ZIP 95814-1234, Sacramento.",
      "License #OPR12345 and CSLB 1012345.",
      "Licence 916-555-0142 is ours.",
      "Lic. No. 916-555-0142",
      "Account #916-555-0142",
      "Order 916-555-0142 shipped.",
      "Since 1981, open 2005-2026.",
      "On 2026-10-06 and 10/06/2026.",
      "Reference 9165550142 (ten digits, no separators).",
      "Version 3.916.555.0142",
      "Part 916-555-0142-7",
      "ISBN 978-916-555-0142",
      "Measures 916.555.0142.5 units",
      "Area code 123-456-7890 is not real.",
      "+44 20 7123 4567",
    ]) {
      expect(formatPhonesInText(text), text).toBe(text);
    }
  });

  it("keeps a number written not to wrap from wrapping", () => {
    expect(formatPhonesInText("Call 916 555 0142")).toBe("Call (916) 555‑0142");
    expect(formatPhonesInHtml("<p>Call (916)&nbsp;555-0142</p>")).toBe("<p>Call (916)&nbsp;555-0142</p>");
    expect(formatPhonesInHtml("<p>Call 916&#8209;555&#8209;0142</p>")).toBe("<p>Call (916)&nbsp;555&#8209;0142</p>");
  });

  it("changes only the visible words: never attributes, tel: links, scripts, styles or comments", () => {
    const jsonLd = `<script type="application/ld+json">{"@type":"Plumber","telephone":"916-555-0142"}</script>`;
    const style = `<style>.x::after{content:"916-555-0142"}</style>`;
    const block = `<!-- wp:paragraph {"placeholder":"916-555-0142"} -->`;
    const textarea = `<textarea name="m">916-555-0142</textarea>`;
    const html = `<!doctype html><html><head><title>Call 916-555-0142</title>${jsonLd}${style}</head><body>${block}<p class="lead">Call <a href="tel:916-555-0142" aria-label="Call 916-555-0142" data-x='a>916-555-0142'>916-555-0142</a> or 916.555.0143.</p><img alt="916-555-0142" src="/a-916-555-0142.jpg">${textarea}<script>var n = "916-555-0142";</script></body></html>`;
    const out = formatPhonesInHtml(html);
    expect(out).toContain("<title>Call (916) 555-0142</title>");
    expect(out).toContain(`<a href="tel:916-555-0142" aria-label="Call 916-555-0142" data-x='a>916-555-0142'>(916) 555-0142</a> or (916) 555-0143.</p>`);
    for (const kept of [jsonLd, style, block, textarea, `<img alt="916-555-0142" src="/a-916-555-0142.jpg">`, `<script>var n = "916-555-0142";</script>`]) expect(out).toContain(kept);
    // Run twice: nothing more changes.
    expect(formatPhonesInHtml(out)).toBe(out);
  });

  it("writes the numbers in a page's own style when it has one (a kept page's header and footer)", () => {
    expect(formatPhonesInText("Call (916) 555-0142 or 916.555.0143 or 916 555 0144.", "dash")).toBe("Call 916-555-0142 or 916-555-0143 or 916-555-0144.");
    expect(formatPhonesInText("Call 916-555-0142", "dot")).toBe("Call 916.555.0142");
    expect(formatPhonesInText("Call 916.555.0142", "space")).toBe("Call 916 555 0142");
    expect(formatPhonesInText("Call 916.555.0142", "paren")).toBe("Call (916) 555-0142");
    expect(formatPhonesInHtml("<p>530.227.2479</p>", "dash")).toBe("<p>530-227-2479</p>");
    const tel = `<a href="tel:+15302272479">Call 530.227.2479</a>`;
    expect(formatPhonesInHtml(tel, "dash")).toBe(`<a href="tel:+15302272479">Call 530-227-2479</a>`);
  });

  it("reads a page's style from its first number, and says the standard when it has none", () => {
    expect(phoneStyleOf("Call 530-227-2479")).toBe("dash");
    expect(phoneStyleOf("Call 530.227.2479")).toBe("dot");
    expect(phoneStyleOf("Call 530 227 2479")).toBe("space");
    expect(phoneStyleOf("Call (530) 227-2479")).toBe("paren");
    expect(phoneStyleOf("Licence 916-555-0142 then 530.227.2479")).toBe("dot");
    expect(phoneStyleOf("Prices from $99. Open 24/7.")).toBe("paren");
  });

  it("hands back a page with no numbers exactly as it was", () => {
    const html = `<p>We answer 24/7. Prices from $99. <a href="tel:+19165550142">Call now</a></p>`;
    expect(formatPhonesInHtml(html)).toBe(html);
  });
});

describe("the intake", () => {
  it("saves and reads the business's and each location's number as (916) 555-0142; anything else as typed", () => {
    const intake = parseIntake({
      business: {
        phone: "916.555.0142",
        locations: [
          { name: "Bishop", phone: "+1 760 555 0142" },
          { name: "London", phone: "+44 20 7123 4567" },
        ],
      },
    });
    expect(intake.business.phone).toBe("(916) 555-0142");
    expect(intake.business.locations.map((l) => l.phone)).toEqual(["(760) 555-0142", "+44 20 7123 4567"]);
    expect(parseIntake({ business: { phone: "" } }).business.phone).toBe("");
  });

  it("gives the concepts' facts the formatted numbers, even from an intake saved before", () => {
    const raw = { business: { name: "ABC Plumbers", phone: "9165550142", locations: [{ name: "Bishop", phone: "760-555-0142" }] } };
    const intake = parseIntake(raw);
    expect(intakePhones(intake)).toEqual(["(916) 555-0142", "(760) 555-0142"]);
    const facts = listIntakeFacts(intake, [], { trade: "plumbing" });
    expect(facts.find((f) => f.key === "business.phone")?.value).toBe("(916) 555-0142");
  });
});

describe("the pages TAWD writes by code", () => {
  const facts: BusinessFacts = {
    name: "Sacramento Drain Pros",
    phone: "916.555.0142",
    email: "office@sacdrainpros.com",
    streetAddress: "1 Main Street",
    city: "Sacramento",
    state: "CA",
    isServiceAreaBusiness: false,
    domain: null,
    trade: "plumbing",
    areaServed: [],
    logoPath: null,
  };

  it("thank-you and 404: the number shown as (916) 555-0142, the link in tel: form", () => {
    expect(thankYouMain(facts)).toContain(`<a href="tel:+19165550142">(916) 555-0142</a>`);
    expect(notFoundMain(facts, [])).toContain(`<a href="tel:+19165550142">(916) 555-0142</a>`);
    expect(thankYouMain({ ...facts, phone: "" })).toContain("[PLACEHOLDER: phone number]");
  });

  it("schema: the machine form; the policies: the formatted one", () => {
    expect(localBusinessSchema(facts).telephone).toBe("+1-916-555-0142");
    expect(localBusinessSchema({ ...facts, phone: "" }).telephone).toBe("[PLACEHOLDER: phone number]");
    const fields = policyFieldsFrom({ name: "X", legalName: "", streetAddress: "", city: "", state: "", phone: "916-555-0142", email: "a@b.c", privacyEmail: "", domain: null, hostingProvider: "Netlify", effectiveDate: new Date("2026-10-06") });
    expect(fields.phone).toBe("(916) 555-0142");
  });
});

describe("the final pass over a built site", () => {
  it("rewrites every page's numbers and nothing else (Build A)", async () => {
    const dist = await mkdtemp(path.join(tmpdir(), "tawd-phones-"));
    try {
      await mkdir(path.join(dist, "about"), { recursive: true });
      await writeFile(path.join(dist, "index.html"), `<main><p>Call 916.555.0142</p><a href="tel:+19165550142">916-555-0142</a></main>`);
      await writeFile(path.join(dist, "about", "index.html"), `<main><p>Call (916) 555-0142</p></main>`);
      await writeFile(path.join(dist, "site.css"), `.x::after{content:"916.555.0142"}`);
      expect(await formatSitePhones(dist)).toBe(1);
      expect(await readFile(path.join(dist, "index.html"), "utf8")).toBe(`<main><p>Call (916) 555-0142</p><a href="tel:+19165550142">(916) 555-0142</a></main>`);
      expect(await readFile(path.join(dist, "site.css"), "utf8")).toBe(`.x::after{content:"916.555.0142"}`);
    } finally {
      await rm(dist, { recursive: true, force: true });
    }
  });

  it("WordPress (Build B) gets the same, also from a build made before", () => {
    const enc = (text: string) => new TextEncoder().encode(text);
    const page = (main: string) => `<!doctype html><html lang="en"><head><title>Home</title></head><body><header class="site-header"><nav><a href="/">Home</a></nav></header><main id="main" class="page-x">${main}</main><footer><p>Call 916.555.0142</p></footer></body></html>`;
    const { files } = wordpressPackage({
      clientName: "Harbor Plumbing",
      buildVersion: 1,
      files: new Map([["index.html", enc(page(`<h1>Harbor</h1><p>Call 916-555-0142 any time.</p>`))]]),
      formEmails: { to: [], copy: null },
    });
    const all = [...files.entries()].filter(([name]) => /\.(html|php|json)$/.test(name)).map(([, bytes]) => new TextDecoder().decode(bytes)).join("\n");
    expect(all).toContain("Call (916) 555-0142 any time.");
    expect(all).not.toContain("916-555-0142");
    expect(all).not.toContain("916.555.0142");
  });
});

describe("checks that compare numbers", () => {
  it("a kept sentence whose number is only written another way is still kept word for word", () => {
    const copy = "Call 916.555.0142 for a free quote. We find the nest and treat it.";
    const built = `<main><p>Call (916) 555-0142 for a free quote.</p><p>We find the nest and treat it.</p></main>`;
    expect(keptWordsCheck(built, copy)).toEqual({ total: 2, missing: [] });
    // A different number is still a change.
    expect(keptWordsCheck(built.replace("0142", "0143"), copy).missing).toEqual(["Call 916.555.0142 for a free quote."]);
  });

  it("the go-live check finds the intake's number on the home page however it was typed", () => {
    const home: PageSummary = { path: "/", name: "Home", mainKeyword: "plumber sacramento", title: "Harbor Plumbing", description: "A plumber in Sacramento.", h1: ["Harbor"], headings: [], firstParagraph: "Call (916) 555-0142 today.", words: 300, imagesWithoutAlt: 0, internalLinks: [], schemaTypes: ["Plumber"] };
    const findings = programChecks([home], { name: "Harbor Plumbing", phone: "+1 916 555 0142", city: "Sacramento" }, new Set(["/"]));
    expect(findings.map((f) => f.key)).not.toContain("nap:phone");
  });
});
