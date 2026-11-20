import { describe, expect, it } from "vitest";
import { pageFromTextLayer } from "@tawd/core/figma";
import { dropDoubledText, tidySpacedCapitals } from "@tawd/core/figma/text-tidy";

describe("tidySpacedCapitals (audit L-05)", () => {
  it("rebuilds the three real strings", () => {
    expect(tidySpacedCapitals("A L E GAC Y O F S E RV I C E")).toBe("A LEGACY OF SERVICE");
    expect(tidySpacedCapitals("W H AT W E D O")).toBe("WHAT WE DO");
    expect(tidySpacedCapitals("C O M P L E T E WAT E R S O L U T I O N S")).toBe("COMPLETE WATER SOLUTIONS");
  });
  it("trusts double spaces as word breaks", () => {
    expect(tidySpacedCapitals("Q X  Z K  J V W")).toBe("QX ZK JVW");
  });
  it("falls back to chunks as word boundaries when the letters are not listed words", () => {
    expect(tidySpacedCapitals("Q X Z K VB J V")).toBe("QXZK VB JV");
  });
  // Fable's review of E4a: only letters are spaced capitals; a list of numbers or a name with "&" is left as drawn.
  it("leaves spaced digits and names with & alone", () => {
    expect(tidySpacedCapitals("1 2 3 4 5")).toBe("1 2 3 4 5");
    expect(tidySpacedCapitals("J & J P L U M B I N G")).toBe("J & J P L U M B I N G");
  });

  it("leaves normal text alone", () => {
    for (const t of ["Call us today", "A B C", "WHAT WE DO", "S E R V I C E S and more", "ABCD E F G H", "A B C DE", "AB CD EF GH IJ A B C D"]) expect(tidySpacedCapitals(t)).toBe(t);
  });
});

describe("dropDoubledText", () => {
  const item = (text: string, x: number, y: number) => ({ text, x, y, w: 200, h: 40 });
  const run = (xs: ReturnType<typeof item>[]) => dropDoubledText(xs, (t) => t.text, (t) => t);
  it("drops the later copy of text drawn on top of itself, keeps the first", () => {
    const a = item("PUMP AND WELL", 0, 0);
    const b = item("Pump and well", 4, 3);
    expect(run([a, b])).toEqual([a]);
  });
  it("keeps same text with little or no overlap and different text on top", () => {
    const a = item("GO", 0, 0);
    expect(run([a, item("GO", 150, 0), item("GO", 0, 500), item("NO", 0, 0)])).toHaveLength(4);
  });
});

describe("pageFromTextLayer uses both fixes and keeps the other fields", () => {
  it("rejoins a spaced heading and drops its shadow", () => {
    const page = pageFromTextLayer({
      number: 1,
      width: 1440,
      height: 500,
      rows: [],
      texts: [
        { str: "W H AT W E D O", x: 80, y: 40, w: 400, h: 40, font: "Poppins-Bold", color: "#ffffff" },
        { str: "W H AT W E D O", x: 83, y: 43, w: 400, h: 40, font: "Poppins-Bold", color: "#000000" },
        { str: "Plain text", x: 80, y: 200, w: 300, h: 20, font: "Poppins-Regular", color: "#111111" },
      ],
      images: [],
    });
    expect(page.texts.map((t) => t.text)).toEqual(["WHAT WE DO", "Plain text"]);
    expect(page.texts[0]).toMatchObject({ x: 80, y: 40, w: 400, h: 40, size: 40, color: "#ffffff" });
  });
});
