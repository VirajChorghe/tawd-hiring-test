import { describe, expect, it } from "vitest";

import { homeWordsFromKeptPage } from "@tawd/core/mockups";
import { keptMarkdown } from "@tawd/core/site";

/* F-034: a home page with no H1 was kept with the page's name, "Home", as the hero's headline. */

const p = (text: string) => ({ type: "p" as const, text });
const h = (level: 1 | 2 | 3, text: string) => ({ type: "heading" as const, level, text });
// The importer passes h1 || title || page name; for the home page the name is "Home".
const heroOf = (blocks: Parameters<typeof keptMarkdown>[0]["blocks"], title: string) =>
  homeWordsFromKeptPage(keptMarkdown({ blocks, title }, title || "Home").markdown).sections[0];

describe("a home page with no H1", () => {
  it("uses the page's real title as the headline", () => {
    expect(heroOf([p("We fix drains.")], "Reliable Drain Cleaning in Reno")?.words.split("\n")[0]).toBe("Reliable Drain Cleaning in Reno");
  });

  it("uses the first heading of any level when there is no real title, and does not repeat it", () => {
    const { markdown } = keptMarkdown({ blocks: [h(2, "Fast plumbing repairs"), p("Call today.")], title: "" }, "Home");
    expect(markdown).toMatch(/^# Fast plumbing repairs$/m);
    expect(markdown.match(/Fast plumbing repairs/g)).toHaveLength(1);
  });

  it("skips a title that is just 'Home' and reads past it to a heading", () => {
    const { markdown } = keptMarkdown({ blocks: [h(3, "Plumbing you can trust"), p("x")], title: "Home" }, "Home");
    expect(markdown).toMatch(/^# Plumbing you can trust$/m);
  });

  it("flags the headline as missing instead of writing 'Home'", () => {
    const { markdown, notes } = keptMarkdown({ blocks: [p("We fix drains.")], title: "" }, "Home");
    expect(markdown).not.toMatch(/^# Home$/m);
    expect(markdown).toContain("[PLACEHOLDER: page heading]");
    expect(notes.join(" ")).toContain("no H1");
    expect(heroOf([p("We fix drains.")], "")?.words).not.toBe("Home");
  });
});
