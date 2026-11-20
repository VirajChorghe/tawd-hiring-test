import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { dropNameLabel, fillPictureFrames, FORM_CTA, unifyFormButtons } from "@tawd/core/site";
import { tidySitePages } from "../../../worker/src/site-build";
import { fallbackPhrases } from "../../../worker/src/stock";

/*
  The code rules for every page TAWD designed (Jason, 8 October 2026, on
  Sample Plumbing Co.' built Home page): no empty picture frame,
  one form label, no label repeating the name, the right icons.
*/

const frame = '<div class="svc-img"><div class="photo-frame" data-tawd-photo="plumber repairing bathroom faucet">Photo: plumber repairing a bathroom faucet</div></div>';

describe("picture frames on a built page", () => {
  it("gives an empty frame the client's photo, keeping its box", () => {
    const { html, filled, removed } = fillPictureFrames(frame, () => "/images/photo-4.jpg");
    expect(filled).toBe(1);
    expect(removed).toBe(0);
    expect(html).toContain('<div class="photo-frame" data-tawd-filled><img src="/images/photo-4.jpg" alt="plumber repairing a bathroom faucet"');
    expect(html).not.toContain("data-tawd-photo");
  });

  it("takes the frame out when there's no photo to give, never an empty box", () => {
    const { html, removed } = fillPictureFrames(frame, () => null);
    expect(removed).toBe(1);
    expect(html).toBe('<div class="svc-img"></div>');
  });
});

describe("one form label", () => {
  it("makes every button to the form say Request a quote, keeping its icon, and leaves calls and the menu alone", () => {
    const html = [
      '<a class="btn btn-ghost" href="#contact">Send a message</a>',
      '<a class="btn btn-orange" href="/projects/x/build/site/1/contact/"><span class="icon" data-tawd-icon="mail"><svg></svg></span>Describe the problem</a>',
      '<a class="btn btn-navy" href="tel:+19162357878">Call (916) 235-7878</a>',
      '<a href="/contact/">Contact</a>',
      '<a class="btn" href="#contact">Request a quote</a>',
    ].join("");
    const { html: out, changed } = unifyFormButtons(html);
    expect(changed).toBe(2);
    expect(out).toContain(`<a class="btn btn-ghost" href="#contact">${FORM_CTA}</a>`);
    expect(out).toContain(`<span class="icon" data-tawd-icon="mail"><svg></svg></span>${FORM_CTA}</a>`);
    expect(out).toContain("Call (916) 235-7878");
    expect(out).toContain('<a href="/contact/">Contact</a>');
  });
});

describe("a label repeating the business name", () => {
  it("goes from above the hero's heading, and nothing else does", () => {
    const html = '<section class="hero"><p class="kicker">Sample Plumbing Co.</p><h1>Plumber in Sacramento</h1></section><span class="eyebrow">Plumbing services</span>';
    const { html: out, dropped } = dropNameLabel(html, "Sample Plumbing Co.");
    expect(dropped).toBe(true);
    expect(out).toBe('<section class="hero"><h1>Plumber in Sacramento</h1></section><span class="eyebrow">Plumbing services</span>');
  });
});

describe("the site build's tidy pass", () => {
  it("uses the client's unused photos first, sets the icons, and says what it did", async () => {
    const dist = await fs.mkdtemp(path.join(os.tmpdir(), "tawd-tidy-"));
    await fs.mkdir(path.join(dist, "images"), { recursive: true });
    for (const name of ["photo-1.jpg", "photo-2.jpg", "photo-3.jpg"]) await fs.writeFile(path.join(dist, "images", name), "x");
    const tick = '<svg><path d="M9 12l2 2l4 -4" /></svg>';
    await fs.writeFile(
      path.join(dist, "index.html"),
      `<html><body><img src="/images/photo-1.jpg" alt="a"><img src="/images/photo-2.jpg" alt="b">${frame}<span class="icon" data-tawd-icon="shovel" data-tawd-icon-name="circle-check">${tick}</span><a class="btn" href="#contact">Send a message</a></body></html>`,
    );
    const { notes } = await tidySitePages(dist, { trade: "plumbing", businessName: "Sample Plumbing Co." });
    const out = await fs.readFile(path.join(dist, "index.html"), "utf8");
    // photo-3 is the one no page used.
    expect(out).toContain('<img src="/images/photo-3.jpg" alt="plumber repairing a bathroom faucet"');
    expect(out).toContain('data-tawd-icon-name="shovel"');
    expect(out).toContain(`>${FORM_CTA}</a>`);
    expect(notes).toEqual([
      "1 icon set from TAWD's icon set",
      "1 empty picture frame given the client's photo",
      '1 form button now "Request a quote"',
    ]);
    await fs.rm(dist, { recursive: true, force: true });
  });
});

describe("Shutterstock's fallback searches", () => {
  it("tries the phrase, then its last words, then the trade at work", () => {
    expect(fallbackPhrases("moisture meter on a damp wall", "plumbing")).toEqual([
      "plumbing moisture meter on a damp wall",
      "plumbing damp wall",
      "plumbing technician at work",
    ]);
    expect(fallbackPhrases("water heater", "plumbing")).toEqual(["plumbing water heater", "plumbing technician at work"]);
  });
});
