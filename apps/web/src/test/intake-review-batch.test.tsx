import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/*
  Jason's review of the intake (26 September 2026): an empty colour says
  "Pick a color"; fonts are two pickers with "Let TAWD choose" as the
  default and "Other"; the Services section suggests services for the
  trade, one click each, from a built-in list (no AI).
*/

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/projects",
}));

import { SERVICE_SUGGESTIONS, emptyIntake, intakeSchema, suggestedServices } from "@tawd/core/intake";
import { trades } from "@tawd/core/enums";
import { ColorPicker } from "@/components/ui/color-picker";
import { BODY_FONTS, FontPicker, HEADING_FONTS } from "@/components/ui/font-picker";

describe("colours", () => {
  it("shows a rainbow 'Pick a color' when empty, and the colour once chosen", () => {
    const empty = renderToStaticMarkup(<ColorPicker label="Primary color" value="" onChange={() => {}} />);
    expect(empty).toContain("Pick a color");
    expect(empty).toContain("rainbow-dot");
    expect(empty).toContain('aria-label="Pick the primary color"');
    const chosen = renderToStaticMarkup(<ColorPicker label="Primary color" value="#1F4E79" onChange={() => {}} />);
    expect(chosen).not.toContain("Pick a color");
    expect(chosen).toContain("background:#1F4E79");
  });
});

describe("fonts", () => {
  it("offers 8 to 10 free Google fonts per picker, with TAWD choosing by default", () => {
    for (const list of [HEADING_FONTS, BODY_FONTS]) {
      expect(list.length).toBeGreaterThanOrEqual(8);
      expect(list.length).toBeLessThanOrEqual(10);
    }
    const none = renderToStaticMarkup(<FontPicker label="Headings font" value="" fonts={HEADING_FONTS} onChange={() => {}} />);
    expect(none).toContain("Let TAWD choose (no preference)");
    const chosen = renderToStaticMarkup(<FontPicker label="Headings font" value="Playfair Display" fonts={HEADING_FONTS} onChange={() => {}} />);
    expect(chosen).toContain("font-family:&quot;Playfair Display&quot;");
  });

  it("keeps the two fonts in the intake, and an older fonts note", () => {
    const parsed = intakeSchema.parse({ ...emptyIntake(), brand: { ...emptyIntake().brand, headingFont: "Montserrat", bodyFont: "Barlow", fonts: "Montserrat headings" } });
    expect(parsed.brand).toMatchObject({ headingFont: "Montserrat", bodyFont: "Barlow", fonts: "Montserrat headings" });
    expect(emptyIntake().brand).toMatchObject({ headingFont: "", bodyFont: "" });
  });
});

describe("suggested services", () => {
  it("has a list for every trade but 'other', and never repeats what the business already lists", () => {
    for (const trade of trades) {
      if (trade === "other") expect(SERVICE_SUGGESTIONS[trade]).toEqual([]);
      else expect(SERVICE_SUGGESTIONS[trade].length).toBeGreaterThanOrEqual(5);
    }
    const plumbing = suggestedServices("plumbing", ["drain cleaning", "Repiping"]);
    expect(plumbing).toHaveLength(5);
    expect(plumbing).not.toContain("Drain cleaning");
    expect(plumbing).not.toContain("Repiping");
  });
});
