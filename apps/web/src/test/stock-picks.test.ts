import { describe, expect, it } from "vitest";

import { STOCK_PICK_ATTR, stampStockPicks, stockPicks, stockQueries } from "@tawd/core/mockups";

/*
  F28 (a client's site, 9 November 2026): two concepts in one project were handed
  the same photograph for the same phrase, because the search is saved per
  project and only its winner was kept - a code-level guarantee that the
  concepts looked alike.

  Jason's call: the page itself carries which picture it took. Then the
  review, a polish pass and a changes run all load that one, without any of
  them having to know which concept they are looking at. The page carries
  what was decided about it.
*/

const frame = (phrase: string, extra = "") => `<div data-tawd-photo="${phrase}"${extra} class="frame">Photo</div>`;
const pageOf = (...frames: string[]) => `<html><body><section>${frames.join("")}</section></body></html>`;

describe("what a page says it took", () => {
  it("reads nothing from a page that was never stamped", () => {
    expect(stockPicks(pageOf(frame("lattice patio cover")))).toEqual({});
  });

  it("stamps each frame with its own picture and reads it back", () => {
    const html = stampStockPicks(pageOf(frame("lattice patio cover"), frame("retractable awning")), {
      "lattice patio cover": "901",
      "retractable awning": "902",
    });
    expect(stockPicks(html)).toEqual({ "lattice patio cover": "901", "retractable awning": "902" });
    // The frames still ask for the same phrases, and nothing else in the tag moved.
    expect(stockQueries(html)).toEqual(["lattice patio cover", "retractable awning"]);
    expect(html).toContain('class="frame"');
  });

  it("leaves a frame alone when there is no pick for its phrase", () => {
    const html = stampStockPicks(pageOf(frame("a"), frame("b")), { a: "901" });
    expect(stockPicks(html)).toEqual({ a: "901" });
    expect(html).toContain('<div data-tawd-photo="b" class="frame">');
  });

  it("replaces a pick already there rather than writing a second one, and is the same run twice", () => {
    const once = stampStockPicks(pageOf(frame("a")), { a: "901" });
    const twice = stampStockPicks(once, { a: "907" });
    expect(stockPicks(twice)).toEqual({ a: "907" });
    expect(twice.match(new RegExp(STOCK_PICK_ATTR, "g"))).toHaveLength(1);
    expect(stampStockPicks(once, { a: "901" })).toBe(once);
  });

  it("refuses an id that isn't one: nothing from outside TAWD goes into an attribute", () => {
    const nasty = stampStockPicks(pageOf(frame("a")), { a: '"><script>alert(1)</script>' });
    expect(nasty).not.toContain("<script>");
    expect(stockPicks(nasty)).toEqual({});
    expect(stampStockPicks(pageOf(frame("a")), { a: "x".repeat(200) })).toBe(pageOf(frame("a")));
  });

  it("ignores a void tag, because a void tag was never a frame", () => {
    // framesIn() skips img/br/hr: a frame is an element a picture goes inside.
    const img = `<html><body><img data-tawd-photo="a" src="x.png" /></body></html>`;
    expect(stampStockPicks(img, { a: "901" })).toBe(img);
    expect(stockPicks(img)).toEqual({});
  });

  it("does nothing at all when there is nothing to stamp", () => {
    const page = pageOf(frame("a"));
    expect(stampStockPicks(page, {})).toBe(page);
  });

  it("stamps every frame in a long page, counting from the bottom up without shifting the others", () => {
    const phrases = Array.from({ length: 12 }, (_, i) => `phrase ${i}`);
    const html = stampStockPicks(pageOf(...phrases.map((p) => frame(p))), Object.fromEntries(phrases.map((p, i) => [p, `9${i}`])));
    expect(stockPicks(html)).toEqual(Object.fromEntries(phrases.map((p, i) => [p, `9${i}`])));
  });
});
