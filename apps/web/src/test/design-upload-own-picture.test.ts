import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { visionSliceCount, visionSlices } from "@tawd/core/figma";
import { ownPictureHeight } from "@/lib/design-upload";
import { makePdf, raster } from "../../../worker/src/make-test-pdf";

/*
  E1 (13 November 2026): the worker reads a picture-only PDF page at the
  picture's own size, not 1440 wide. The estimate must not come out under
  what that read needs, and finding the height must not decode the pictures
  (it runs on every intake page render in a 1 GB container).
*/
const pat = path.resolve(__dirname, "../../../../fixtures/lane2/pat-rivera-design.pdf");

describe("the estimate for a picture-only PDF page", () => {
  it("finds the tallest picture's height, plus 5% for what the worker may draw it over", () => {
    const pdf = makePdf({ pageW: 600, pageH: 400, image: { width: 1200, height: 800, rgb: raster(1200, 800, () => [30, 80, 200]) } });
    expect(ownPictureHeight(pdf)).toBe(Math.ceil(800 * 1.05));
  });

  it("finds nothing for a PDF with no picture", () => {
    expect(ownPictureHeight(makePdf({ pageW: 600, pageH: 400, text: "Words" }))).toBeNull();
  });

  it.skipIf(!fs.existsSync(pat))("for Pat's design (2560 x 4056) is not under the worker's height, and is quick (no decoding)", () => {
    const bytes = fs.readFileSync(pat);
    const started = performance.now();
    const own = ownPictureHeight(bytes);
    const took = performance.now() - started;
    expect(own).toBeGreaterThanOrEqual(4056);
    // The worker draws it at round(page height x scale): about 4% above pixel height at most; 5% is added.
    expect(visionSlices(own!).length).toBeGreaterThanOrEqual(visionSlices(Math.round(4056 * 1.05)).length);
    expect(visionSliceCount(1400, 4056)).toBeLessThanOrEqual(visionSlices(own!).length + 1);
    // A byte scan of a 6 MB file, not an image decode.
    expect(took).toBeLessThan(500);
  });
});

describe("finding a picture's height in the PDF bytes (Fable's re-read)", () => {
  const pdfWith = (dictionary: string) => Buffer.from(`%PDF-1.7
5 0 obj
<< /Type /XObject /Subtype /Image ${dictionary} >>
stream
xx
endstream
endobj
%%EOF`, "latin1");

  it("finds a /Height pushed far from /Subtype by an inline colour palette", () => {
    const palette = `/ColorSpace [/Indexed /DeviceRGB 255 <${"ab".repeat(768)}>]`;
    expect(ownPictureHeight(pdfWith(`/Width 1400 ${palette} /Height 4056`))).toBe(Math.ceil(4056 * 1.05));
  });

  it("never reads an indirect /Height (a reference to another object) as a number of pixels", () => {
    expect(ownPictureHeight(pdfWith("/Width 1400 /Height 12 0 R"))).toBeNull();
  });
});
