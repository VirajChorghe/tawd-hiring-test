import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

/*
  A design is labelled by where it really came from (Jason, 28 September
  2026: a client's PDF was shown as "The designer's Figma design ... From Figma").
*/

import { DesignerDesign, type DesignerDesignProps } from "@/components/mockups/designer-design";

const base: DesignerDesignProps = {
  projectId: "p",
  fileName: "NoraHappyBeagleLady_Finished_Website_Mockups.pdf",
  figmaUrl: null,
  status: "imported",
  importedLine: "today, 9:14 PM by Jason.",
  failure: null,
  warnings: 0,
  outOfDate: true,
  frames: [{ id: "1", name: "Page 1", isHome: true, imageUrl: null, width: 1440, height: 2160 }],
};

describe("the design's source on its card", () => {
  it("says uploaded PDF, uploaded images or Figma, with no Figma words for an upload", () => {
    const pdf = renderToStaticMarkup(<DesignerDesign {...base} source="pdf" />);
    expect(pdf).toContain("The designer’s design (uploaded PDF)");
    expect(pdf).toContain("Uploaded: NoraHappyBeagleLady_Finished_Website_Mockups.pdf. Read today");
    expect(pdf).toContain("Uploaded again since");
    expect(pdf).toContain("Design section");
    expect(pdf).toContain("There is no picture of this page.");
    expect(pdf).not.toContain("Figma");
    expect(renderToStaticMarkup(<DesignerDesign {...base} source="upload" fileName="3 design files" />)).toContain("(uploaded images)");
    const figma = renderToStaticMarkup(<DesignerDesign {...base} source="figma" fileName="Dale Rowan" />);
    expect(figma).toContain("The designer’s Figma design");
    expect(figma).toContain("From Figma: Dale Rowan. Imported today");
  });
});
