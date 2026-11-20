import { describe, expect, it } from "vitest";

import { checkIcons, fillIcons, ICON_RULE, iconFor, iconSvg, runHtmlChecks, UNKNOWN_ICON } from "@tawd/core/mockups";
import { KIT_ICONS } from "@tawd/core/style-kit/icon-set";

/*
  Icons by code (Jason, 8 October 2026: Harbor's mosquito icon was "something
  else"). The builder writes a word in an empty slot; code fills it from the
  pinned Tabler set.
*/

describe("icons by code", () => {
  it("picks the icon from the word", () => {
    expect(iconFor("mosquito")).toBe("bug");
    expect(iconFor("Termite control")).toBe("bug");
    expect(iconFor("spider")).toBe("spider");
    expect(iconFor("rodent")).toBe("paw");
    expect(iconFor("water heater")).toBe("flame");
    expect(iconFor("drain cleaning")).toBe("pipeline");
    expect(iconFor("air conditioning")).toBe("air-conditioning");
    expect(iconFor("phone")).toBe("phone");
    expect(iconFor("licensed and insured")).toBe("shield-check");
    /*
      A word TAWD has no icon for gets the dot (Jason, 9 November 2026), not
      the tick it got before 8 October, and no longer the house or the trade's
      own icon: see UNKNOWN_ICON. The trade is not consulted at all now, so a
      plumber's unknown word gets the same honest dot as anyone else's.
    */
    expect(iconFor("something unheard of")).toBe(UNKNOWN_ICON);
    expect(iconFor("retractable awnings")).toBe(UNKNOWN_ICON);
  });

  // Sample Plumbing Co.' site (8 October 2026): these fell back to the tick.
  it("uses the icon set's own names, common aliases, word stems and the card's heading", () => {
    expect(iconFor("clock")).toBe("clock");
    expect(iconFor("shovel")).toBe("shovel");
    expect(iconFor("arrow")).toBe("arrow-right");
    expect(iconFor("warning")).toBe("alert-triangle");
    expect(iconFor("repiping")).toBe("pipeline");
    expect(iconFor("faucet")).toBe("bath");
    expect(iconFor("mystery", { context: "Sewer Line Repair" })).toBe("pipeline");
  });

  it("puts the right icon in slots a site build copied with the tick", () => {
    const tick = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M9 12l2 2l4 -4" /></svg>';
    const html = `<span class="icon" data-tawd-icon="shovel" data-tawd-icon-name="circle-check">${tick}</span><h3>Sewer Line Repair</h3><span class="icon" data-tawd-icon="phone" data-tawd-icon-name="phone">${iconSvg("phone")}</span>`;
    const { html: out, filled } = fillIcons(html, { refill: true });
    expect(filled).toBe(1);
    expect(out).toContain('data-tawd-icon="shovel" data-tawd-icon-name="shovel"');
    expect(out).not.toContain('data-tawd-icon-name="circle-check"');
    expect(fillIcons(out, { refill: true }).filled).toBe(0);
  });

  it("has every icon it can pick in the pinned set", () => {
    const words = ["spider", "bat", "mosquito", "rodent", "spraying", "lawn", "tree", "garden", "heater", "air conditioning", "hvac", "drain", "leak", "bathroom", "solar", "electrical", "outlet", "windows", "glass", "doors", "fence", "drywall", "gutters", "painting", "cleaning", "garage", "fire", "attorney", "injury", "inspection", "emergency", "guarantee", "home", "commercial", "phone", "email", "area", "hours", "book", "price", "rating", "award", "team", "truck", "eco", "family", "repair", "done", "zzz"];
    for (const word of words) {
      const name = iconFor(word);
      expect(KIT_ICONS.some((i) => i.name === name && i.style === "outline"), `${word} -> ${name}`).toBe(true);
    }
  });

  it("fills empty slots once, in the icon family, coloured by the text", () => {
    const html = `<ul><li><span class="icon" data-tawd-icon="mosquito"></span> Mosquitoes</li><li><i data-tawd-icon='rodent'> </i> Rodents</li></ul>`;
    expect(checkIcons(html).map((i) => i.id)).toEqual(["icons.unfilled"]);
    const { html: out, filled } = fillIcons(html);
    expect(filled).toBe(2);
    expect(out).toContain('data-tawd-icon="mosquito" data-tawd-icon-name="bug"><svg');
    expect(out).toContain('stroke="currentColor"');
    expect(out).toContain(`data-tawd-icon='rodent' data-tawd-icon-name="paw"><svg`);
    expect(checkIcons(out)).toEqual([]);
    expect(fillIcons(out)).toEqual({ html: out, filled: 0, notes: [] });
  });

  it("is part of the ordinary checks", () => {
    const facts = { phones: [], licenseNumbers: [], yearFounded: null, businessName: "Harbor", cities: [] };
    expect(runHtmlChecks(`<span data-tawd-icon="ant"></span>`, facts).issues.some((i) => i.id === "icons.unfilled")).toBe(true);
  });

  it("tells the builder to write a slot, never to draw", () => {
    expect(ICON_RULE).toContain('data-tawd-icon="word"');
    expect(ICON_RULE).toContain("never draw an icon's SVG yourself");
    expect(iconSvg("bug")).toMatch(/^<svg [^>]*aria-hidden="true"/);
  });
});

/*
  A phrasing a builder actually writes (Clear Sky Awning, 10 November 2026).

  The pinned set HAS a chat bubble, and "text" reached it - but only as that
  one word on its own, because it was an alias and aliases are matched on
  the whole slot. The builder wrote "text us", so the "Call or text" links
  in the header and the final band showed a plain dot, and the Creative
  Director scored Pictures fit 2 of 5 naming them. Nothing was missing from
  the icon set: the words were not reaching it.
*/
describe("the words for an icon TAWD already has", () => {
  it("finds the chat bubble however the builder says it", () => {
    for (const word of ["text us", "Text us", "send a text", "texting", "text message", "sms", "SMS us", "chat", "chat with us", "live chat", "chat bubble"]) {
      expect(iconFor(word), `"${word}" should reach the chat bubble`).toBe("message-circle");
    }
  });

  it("leaves email and the other words alone", () => {
    // Email is an envelope, not a chat bubble: the new rule must not steal it.
    expect(iconFor("email")).toBe("mail");
    expect(iconFor("e-mail us")).toBe("mail");
    expect(iconFor("message")).toBe("mail");
    // Words that merely contain the letters are not the word.
    expect(iconFor("context")).toBe(UNKNOWN_ICON);
    expect(iconFor("textile cleaning")).toBe("vacuum-cleaner");
    expect(iconFor("chateau")).toBe(UNKNOWN_ICON);
    // And a phone is still a phone.
    expect(iconFor("call or text")).toBe("phone");
  });

  it("every icon a rule or alias names is in the pinned set", () => {
    /*
      A rule naming an icon the set does not have would draw the dot while
      the page said otherwise, and nothing would report it: iconSvg falls
      back silently. Checked here rather than trusted.
    */
    const outline = new Set(KIT_ICONS.filter((i) => i.style === "outline").map((i) => i.name));
    const words = [
      "mosquito", "rodent", "weeds", "tree", "garden", "water heater", "air conditioning", "hvac", "drain",
      "leak", "bathroom", "solar", "electrical", "outlet", "window", "glass", "door", "fence", "drywall",
      "roof", "painting", "cleaning", "garage", "fire", "legal", "injury", "inspection", "emergency",
      "licensed", "outdoor living", "home", "commercial", "phone", "email", "location", "hours", "calendar",
      "price", "reviews", "award", "team", "truck", "eco", "family", "repairs", "done", "text us", "chat",
      "arrow", "warning", "info", "question", "menu", "close", "tick", "quote", "dollar", "spider", "bat",
    ];
    for (const word of words) {
      const name = iconFor(word);
      expect(outline.has(name), `"${word}" resolves to "${name}", which is not in the pinned outline set`).toBe(true);
    }
  });
});
