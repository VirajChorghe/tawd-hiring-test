import { describe, expect, it } from "vitest";

/*
  The style kit (Jason, 28 September 2026): the design's elements found by
  code from its picture, a kit built from them, the builder's markers
  filled in by code, and the element check's plan and verdict. All on small
  pictures drawn here; no browser, no AI.
*/

import { traceField, loopsPath, fillHoles, edgeRoughness, colorMask } from "@tawd/core/style-kit/contour";
import { inventoryPage, packMask, unpackMask, type DesignReadPage } from "@tawd/core/style-kit/elements";
import { planSection, checkResult, describeMisses } from "@tawd/core/style-kit/element-check";
import { googleFontsCss } from "@tawd/core/style-kit/fonts";
import { KIT_ICONS, findIcon } from "@tawd/core/style-kit/icon-set";
import { applyKit, buildStyleKit, describeKit, kitCss } from "@tawd/core/style-kit/kit";
import { chooseIcons, edgeSimilarity, fitSquare, holeOfDisc, withoutRing } from "@tawd/core/style-kit/matching";
import { blankPixels, fillBox, type Pixels, type Rgb } from "@tawd/core/style-kit/pixels";
import { findOutlines } from "@tawd/core/style-kit/lines";
import { kitPreviewHtml } from "@tawd/core/style-kit/preview";
import { flatGrid } from "@tawd/core/style-kit/regions";
import { layoutSignature, layoutSimilarity, sharedLayouts } from "@tawd/core/style-kit/templates";

const WHITE: Rgb = [255, 255, 255];
const NAVY: Rgb = [11, 26, 74];
const BEIGE: Rgb = [250, 245, 239];
const GREY: Rgb = [225, 225, 228];

function disc(p: Pixels, cx: number, cy: number, r: number, color: Rgb, hole = 0): void {
  for (let y = cy - r; y <= cy + r; y += 1) {
    for (let x = cx - r; x <= cx + r; x += 1) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r && d >= hole) fillBox(p, { x, y, w: 1, h: 1 }, color);
    }
  }
}

/* A small page: a navy band, a beige panel with a navy button, a grey-outlined box with its title in the border, a paw-like icon. */
function samplePage(): { pixels: Pixels; read: DesignReadPage } {
  const p = blankPixels(1440, 900, WHITE);
  fillBox(p, { x: 0, y: 0, w: 1440, h: 120 }, NAVY);
  fillBox(p, { x: 80, y: 200, w: 600, h: 300 }, BEIGE);
  fillBox(p, { x: 140, y: 400, w: 240, h: 48 }, NAVY);
  // The box outline, its top broken by a title.
  fillBox(p, { x: 760, y: 220, w: 200, h: 1 }, GREY);
  fillBox(p, { x: 1160, y: 220, w: 200, h: 1 }, GREY);
  fillBox(p, { x: 760, y: 700, w: 600, h: 1 }, GREY);
  fillBox(p, { x: 760, y: 220, w: 1, h: 481 }, GREY);
  fillBox(p, { x: 1359, y: 220, w: 1, h: 481 }, GREY);
  // A paw: a pad and four toes.
  disc(p, 300, 280, 14, NAVY);
  for (const [x, y] of [[280, 256], [292, 250], [308, 250], [320, 256]]) disc(p, x!, y!, 5, NAVY);
  const read: DesignReadPage = {
    sections: [
      { name: "top", top: 0, height: 120 },
      { name: "main", top: 120, height: 780 },
    ],
    texts: [
      { text: "FOLLOW OUR PACK", x: 180, y: 414, w: 160, h: 20, size: 16, weight: 400, color: "#ffffff", font: null },
      { text: "MEET THE PACK", x: 980, y: 208, w: 160, h: 26, size: 22, weight: 400, color: "#0b1a4a", font: null },
      { text: "Welcome", x: 120, y: 220, w: 120, h: 30, size: 28, weight: 400, color: "#0b1a4a", font: "cursive" },
    ],
    images: [],
  };
  return { pixels: p, read };
}

describe("finding the design's elements by code", () => {
  it("finds the band, the panel, the button with its words, the outlined box with a title in its border, and the icon", () => {
    const { pixels, read } = samplePage();
    const inv = inventoryPage(pixels, read);
    expect(inv.sections[0]!.background).toBe("#0b1a4a");
    const main = inv.sections[1]!.elements;
    const panel = main.find((e) => e.kind === "panel");
    expect(panel).toMatchObject({ fill: "#faf5ef" });
    expect(panel!.box.x).toBeLessThanOrEqual(84);
    expect(panel!.box.w).toBeGreaterThanOrEqual(592);
    expect(main.find((e) => e.kind === "button")).toMatchObject({ text: "FOLLOW OUR PACK", fill: "#0b1a4a", textColor: "#ffffff" });
    const box = main.find((e) => e.kind === "box");
    expect(box).toBeDefined();
    expect(box!.kind === "box" && box!.titleGap).toMatchObject({ from: expect.any(Number), to: expect.any(Number) });
    const icon = main.find((e) => e.kind === "icon");
    expect(icon).toBeDefined();
    expect(icon!.kind === "icon" && icon!.path).toMatch(/^M/);
    expect(main.filter((e) => e.kind === "text").map((e) => (e.kind === "text" ? e.role : ""))).toEqual(["sans", "sans", "script"]);
    // Ids are prefixed per page when a design has several.
    expect(inventoryPage(pixels, read, "p2-").sections[1]!.elements[0]!.id).toMatch(/^p2-s2-/);
  });

  it("finds an outline whose top is broken by a title", () => {
    const { pixels } = samplePage();
    const outlines = findOutlines(pixels);
    expect(outlines).toHaveLength(1);
    expect(outlines[0]!.box).toMatchObject({ x: 760, y: 220 });
    expect(outlines[0]!.titleGap!.to - outlines[0]!.titleGap!.from).toBeGreaterThan(150);
  });
});

describe("shapes to vectors", () => {
  it("traces a shape with a hole into a smooth even-odd path, and tells a brush stroke from a clean rectangle", () => {
    const w = 20, h = 20;
    const field = new Float32Array(w * h);
    for (let y = 3; y < 17; y += 1) for (let x = 3; x < 17; x += 1) field[y * w + x] = x > 7 && x < 12 && y > 7 && y < 12 ? 0 : 1;
    const loops = traceField(field, w, h);
    expect(loops).toHaveLength(2);
    expect(loopsPath(loops).match(/M/g)).toHaveLength(2);

    const rect = blankPixels(60, 30, WHITE);
    fillBox(rect, { x: 5, y: 8, w: 50, h: 14 }, NAVY);
    expect(edgeRoughness(colorMask(rect, { x: 0, y: 0, w: 60, h: 30 }, NAVY))).toBeLessThan(0.5);
    const brush = blankPixels(60, 30, WHITE);
    for (let x = 5; x < 55; x += 1) fillBox(brush, { x, y: 8 + ((x * 7) % 5), w: 1, h: 12 - ((x * 3) % 4) }, NAVY);
    expect(edgeRoughness(colorMask(brush, { x: 0, y: 0, w: 60, h: 30 }, NAVY))).toBeGreaterThan(1.2);
    const ring = { w: 5, h: 5, on: Uint8Array.from([1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1]) };
    expect(Array.from(fillHoles(ring).on).every((v) => v === 1)).toBe(true);
  });

  it("keeps masks through packing", () => {
    const m = { w: 7, h: 3, on: Uint8Array.from([1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1]) };
    expect(Array.from(unpackMask(packMask(m)).on)).toEqual(Array.from(m.on));
  });
});

describe("matching icons", () => {
  function mask(size: number, draw: (p: Pixels) => void) {
    const p = blankPixels(size, size, WHITE);
    draw(p);
    const on = new Uint8Array(size * size);
    for (let i = 0; i < size * size; i += 1) on[i] = p.data[i * 4]! < 128 ? 1 : 0;
    return { w: size, h: size, on };
  }

  it("takes a ring or a disc away to leave the glyph, and scores a shape against itself above a different one", () => {
    const ringed = mask(48, (p) => {
      disc(p, 24, 24, 23, NAVY, 20);
      fillBox(p, { x: 20, y: 12, w: 8, h: 24 }, NAVY);
    });
    const r = withoutRing(ringed);
    expect(r.ring).toBe(true);
    expect(r.mask.h).toBeGreaterThan(r.mask.w);
    const onDisc = mask(48, (p) => {
      disc(p, 24, 24, 23, NAVY);
      fillBox(p, { x: 20, y: 12, w: 8, h: 24 }, WHITE);
    });
    expect(holeOfDisc(onDisc)).not.toBeNull();
    const bar = fitSquare(r.mask, 32);
    const round = fitSquare(mask(48, (p) => disc(p, 24, 24, 20, NAVY)), 32);
    expect(edgeSimilarity(bar, bar)).toBe(1);
    expect(edgeSimilarity(bar, round)).toBeLessThan(0.6);
  });

  it("matches a social icon to its official mark only in a social row, and keeps other icons as traced", () => {
    const set = KIT_ICONS.filter((i) => ["brand-youtube", "paw"].includes(i.name)).map((item) => ({ item, mask: fitSquare({ w: 1, h: 1, on: Uint8Array.from([1]) }, 8) }));
    const chosen = chooseIcons([{ id: "a", mask: { w: 3, h: 3, on: Uint8Array.from([0, 1, 0, 1, 1, 1, 0, 1, 0]) }, group: null }], set);
    expect(chosen[0]).toMatchObject({ id: "a", frame: null });
    expect(chooseIcons([{ id: "p", mask: { w: 1, h: 1, on: Uint8Array.from([1]) }, group: "play over a photo" }], set)[0]).toMatchObject({ name: "player-play", frame: "disc" });
    expect(findIcon("brand-instagram", "brand")).toBeDefined();
    expect(findIcon("paw", "filled")).toBeDefined();
  });
});

describe("the kit", () => {
  function kitForSample() {
    const { pixels, read } = samplePage();
    const inv = inventoryPage(pixels, read);
    const icons = inv.sections.flatMap((s) => s.elements.filter((e) => e.kind === "icon").map((e) => ({ id: e.id, name: null, style: null, score: 0, frame: null })));
    const fonts = [
      { role: "sans" as const, family: "Lato", score: 0.84, alternatives: [{ family: "Arimo", score: 0.8 }], weights: [400], files: [{ weight: 400, key: "projects/x/style-kit/fonts/lato-400.woff2" }] },
      { role: "script" as const, family: "Dancing Script", score: 0.52, alternatives: [{ family: "Kaushan Script", score: 0.49 }, { family: "Satisfy", score: 0.47 }], weights: [400], files: [] },
    ];
    return { inv, kit: buildStyleKit({ pages: [inv], icons, fonts }) };
  }

  it("names every element's part, shares classes between look-alikes, and flags a loose font match", () => {
    const { inv, kit } = kitForSample();
    const main = inv.sections[1]!;
    for (const e of main.elements.filter((x) => x.kind !== "text" && x.kind !== "picture")) expect(kit.map[e.id]).toBeTruthy();
    expect(kit.parts.find((p) => p.kind === "button")!.css).toContain("min-height:44px");
    expect(kit.notes.join(" ")).toContain("Dancing Script only loosely");
    const css = kitCss(kit, (key) => `/fonts/${key.split("/").pop()}`);
    expect(css).toContain('@font-face{font-family:"Lato";font-weight:400');
    expect(css).toContain("--kit-font-sans:\"Lato\", sans-serif;");
    expect(describeKit(kit)).toContain("never draw icons yourself");
  });

  it("fills the builder's icon markers with the kit's SVG, and reports markers the kit doesn't have", () => {
    const { kit } = kitForSample();
    const ref = kit.icons[0]!.ref;
    const { html, unknownIcons } = applyKit(`<html><head></head><body><h2><span data-kit-icon="${ref}"></span> Meet the pack <i data-kit-icon="kit-icon-99"></i></h2></body></html>`, kit, ".x{}");
    // An icon traced from the design is marked as such (29 September 2026: the finishing pass drops one that stands alone).
    expect(html).toContain(`<span data-kit-icon="${ref}" aria-hidden="true"${kit.icons[0]!.label === "icon from the design" ? " data-kit-traced" : ""}><svg`);
    expect(html).toContain("<style data-kit>.x{}</style></head>");
    expect(unknownIcons).toEqual(["kit-icon-99"]);
  });

  it("fills a marker the design's kit lacks from TAWD's own set when asked, instead of leaving it empty (gap 9)", () => {
    const { kit } = kitForSample();
    // Icons the AI asked for that no design kit has: filled from TAWD's own set by the word, not taken out.
    const { html, unknownIcons } = applyKit(`<body><p><span data-kit-icon="arrow-right"></span><span data-kit-icon="phone"></span></p></body>`, kit, "", { fillUnknown: true });
    expect(unknownIcons).toEqual(["arrow-right", "phone"]);
    expect(html).toContain(`data-kit-icon="arrow-right" aria-hidden="true" data-kit-fallback><svg`);
    expect(html).toContain(`data-kit-icon="phone" aria-hidden="true" data-kit-fallback><svg`);
    expect(html).toContain('stroke="currentColor"');
    // Without the flag the unknown marker is reported and left as it was (as before).
    expect(applyKit(`<body><span data-kit-icon="phone"></span></body>`, kit, "").html).toContain(`<span data-kit-icon="phone"></span>`);
  });

  it("tells the builder to use kit-box-title only inside a kit box (gap 9)", () => {
    const { kit } = kitForSample();
    expect(describeKit(kit)).toContain("Use kit-box-title only inside a kit box");
  });

  it("builds a preview page from the kit alone, section by section", () => {
    const { inv, kit } = kitForSample();
    const html = kitPreviewHtml({ title: "Sample", page: inv, kit, css: "", picture: "data:image/png;base64," });
    expect(html.match(/data-figma-section=/g)).toHaveLength(2);
    expect(html).toContain("FOLLOW OUR PACK");
    // A quote in a design's words can't leave its attribute (13 October 2026). A picture is added here, so the check always runs (CodeRabbit, PR #13).
    const panel = inv.sections[1]!.elements.find((e) => e.kind === "panel")!;
    const picture = { ...panel, id: "pic-quoted", kind: "picture" as const, role: 'hero" onmouseover="x' };
    const quoted = kitPreviewHtml({ title: "Sample", page: { ...inv, sections: inv.sections.map((s, i) => (i === 1 ? { ...s, elements: [...s.elements, picture] } : s)) }, kit, css: "", picture: "data:image/png;base64," });
    expect(quoted).toContain('aria-label="hero&quot; onmouseover=&quot;x"');
    expect(quoted).not.toContain('onmouseover="x"');
    expect(html).toContain(`class="${kit.map[inv.sections[1]!.elements.find((e) => e.kind === "panel")!.id]}"`);
  });
});

describe("the element check", () => {
  it("plans each section's items and fails the section on any miss, naming it", () => {
    const { pixels, read } = samplePage();
    const inv = inventoryPage(pixels, read);
    const kit = buildStyleKit({ pages: [inv], icons: [], fonts: [{ role: "sans", family: "Lato", score: 0.9, alternatives: [], weights: [400], files: [] }] });
    const plan = planSection(kit, inv.sections[1]!);
    expect(plan.items.map((i) => i.label).join("; ")).toMatch(/the button "FOLLOW OUR PACK" \(kit-button-1\)/);
    const found = Object.fromEntries(plan.items.map((i) => [i.selector, i.count]));
    const all = checkResult([plan], [{ number: 2, found, texts: plan.texts.map((t) => ({ id: t.id, present: true, family: t.family, loaded: true })), clipped: [], overlaps: [] }]);
    expect(all.passed).toBe(true);
    const panelSelector = plan.items.find((i) => i.label.includes("panel"))!.selector;
    const missing = checkResult([plan], [
      {
        number: 2,
        found: { ...found, [panelSelector]: 0 },
        texts: plan.texts.map((t, i) => ({ id: t.id, present: true, family: i === 0 ? "Times New Roman" : t.family, loaded: true })),
        clipped: ['the text "FOLLOW OUR PACK"'],
        overlaps: [['the text "MEET THE PACK"', 'the text "Welcome"']],
      },
    ]);
    expect(missing.passed).toBe(false);
    expect(describeMisses(missing)).toEqual([
      "main: the coloured panel (kit-panel-1) is missing.",
      'main: the text "FOLLOW OUR PACK" is in the wrong font (Times New Roman instead of Lato).',
      'main: the text "FOLLOW OUR PACK" is cut off.',
      'main: the text "MEET THE PACK" overlaps (the text "Welcome").',
    ]);
    expect(checkResult([plan], []).sections[0]!.misses[0]!.problem).toBe("missing");
  });
});

describe("fonts", () => {
  it("asks Google Fonts for each family's weights once", () => {
    expect(googleFontsCss([{ family: "Dancing Script", weights: [700, 400, 400] }, { family: "Lato", weights: [] }])).toBe(
      "https://fonts.googleapis.com/css2?family=Dancing+Script:wght@400;700&family=Lato&display=swap",
    );
  });
});

describe("pages that share a layout", () => {
  function page(heroPhoto: boolean, panelTop: number, height = 1600) {
    const p = blankPixels(1440, height, WHITE);
    fillBox(p, { x: 0, y: 0, w: 1440, h: 160 }, NAVY);
    // A "photo": noise the flat-cell test sees as busy.
    if (heroPhoto) for (let y = 200; y < 700; y += 1) for (let x = 700; x < 1400; x += 1) fillBox(p, { x, y, w: 1, h: 1 }, [(x * 37 + y * 11) % 255, (x * 7 + y * 29) % 255, (x * 13 + y * 3) % 255]);
    fillBox(p, { x: 80, y: panelTop, w: 1280, h: 400 }, BEIGE);
    return layoutSignature(flatGrid(p));
  }

  it("groups pages whose blocks agree, and leaves out a different layout and a page drawn another shape", () => {
    const mia = page(true, 800), dakota = page(true, 820), home = page(false, 300), meeko = page(true, 800, 900);
    expect(layoutSimilarity(mia, dakota)).toBeGreaterThan(0.9);
    expect(layoutSimilarity(mia, home)).toBeLessThan(layoutSimilarity(mia, dakota) - 0.08);
    expect(layoutSimilarity(mia, meeko)).toBe(0);
    expect(sharedLayouts([{ key: "home", signature: home }, { key: "mia", signature: mia }, { key: "dakota", signature: dakota }, { key: "meeko", signature: meeko }], 0.88)).toEqual([
      { pages: ["mia", "dakota"], agreement: expect.any(Number) },
    ]);
  });
});
