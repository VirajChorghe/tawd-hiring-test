import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }) }));
vi.mock("@/app/actions", () => ({ startRunAction: async () => ({ ok: true }) }));

import {
  chooseHeroPhoto,
  describeMockupInputs,
  paletteCharacter,
  photoKind,
  photoPlanSection,
  preselectDirections,
  proposalInputsOf,
  tradeFromWords,
  type PageAsset,
  type PreselectInput,
  type ProposalInputs,
} from "@tawd/core/mockups";
import { parseIntake } from "@tawd/core/intake";
import { MockupSetup, type SetupPlan } from "@/components/mockups/setup";

/*
  Intake-first inputs and the direction proposed after them (27 September
  2026, after the Harbor Pest Control mockups: inputs beat rules). No
  database, no AI.
*/

const noInputs: ProposalInputs = { colors: [], colorsFrom: "none", photos: { count: 3, people: 0, work: 3 }, references: [] };

function propose(overrides: Partial<PreselectInput> = {}) {
  return preselectDirections({ trade: "pest_control", moodWords: [], hasBrandGuide: false, hasFoundingYear: false, conceptCount: 3, inputs: noInputs, ...overrides });
}

describe("pest control and the trade from the words", () => {
  it("reads pest control from the words when the trade is 'other', and never falls through to Warm Local", () => {
    expect(tradeFromWords("other", ["Harbor Pest Control", "Termite inspection"])).toBe("pest_control");
    expect(tradeFromWords("other", ["Bright Smiles Studio"])).toBe("other");
    expect(tradeFromWords("roofing", ["Pest control"])).toBe("roofing");

    const picks = propose().concepts.map((c) => c.direction);
    expect(picks).toEqual(["classic_trust", "modern_clean", "editorial_authority"]);
    expect(picks).not.toContain("warm_local");
  });
});

describe("the direction proposed from the inputs", () => {
  it("lets deep logo colours lead with Classic Trust, and bright ones bring Bright and Friendly", () => {
    expect(paletteCharacter(["#12305A", "#3FA535"])).toBe("deep");
    expect(paletteCharacter(["#E53935", "#FDD835"])).toBe("bright");
    expect(paletteCharacter(["#111111", "#C9A227"])).toBe("rich");

    const deep = propose({ trade: "home_services", inputs: { ...noInputs, colors: ["#12305A"], colorsFrom: "logo" } });
    expect(deep.concepts[0]!.direction).toBe("classic_trust");
    expect(deep.notes.join(" ")).toContain("The logo's colours are deep and sober");

    const bright = propose({ trade: "legal", inputs: { ...noInputs, colors: ["#E53935", "#FDD835"], colorsFrom: "entered" } });
    expect(bright.concepts[0]!.direction).toBe("bright_friendly");
  });

  it("moves photo-led directions down with no real photos, and says results will be weaker", () => {
    const result = propose({ trade: "home_services", inputs: { ...noInputs, photos: { count: 0, people: 0, work: 0 } } });
    expect(result.concepts.map((c) => c.direction)).not.toContain("warm_local");
    expect(result.notes.join(" ")).toContain("Results will be weaker");
  });

  it("lets the studied reference sites lead: two pointing at one direction put it first", () => {
    const result = propose({
      inputs: {
        ...noInputs,
        references: [
          { url: "https://a.example", studied: true, closestDirection: "technical_precision" },
          { url: "https://b.example", studied: true, closestDirection: "technical_precision" },
        ],
      },
    });
    expect(result.concepts[0]!.direction).toBe("technical_precision");
    expect(result.notes.join(" ")).toContain("2 of the 2 reference sites are closest to Technical Precision");
  });
});

describe("the main inputs and their notes", () => {
  it("notes each missing input as weaker, never as a block, and passes closest directions on", () => {
    const empty = describeMockupInputs({ logos: 0, colors: [], colorsFromLogo: false, photos: [], references: [] });
    expect(empty.notes.map((n) => n.input)).toEqual(["logo", "photos", "references"]);
    expect(empty.notes.every((n) => /weaker/.test(n.text))).toBe(true);

    const full = describeMockupInputs({
      logos: 1,
      colors: ["#12305A", "#3FA535"],
      colorsFromLogo: true,
      photos: [{ caption: "Our team at the office", fileName: "IMG_1.jpg" }, { caption: "Termite treatment", fileName: "job.jpg" }],
      references: [
        { url: "https://a.example", status: "done", briefStatus: "done" },
        { url: "https://b.example", status: "done", briefStatus: null },
      ],
    });
    expect(full.notes).toEqual([]);
    expect(full.colorsFrom).toBe("logo");
    expect(full.photos).toEqual({ count: 2, people: 1, work: 1 });
    expect(proposalInputsOf(full, { "https://a.example": "classic_trust" }).references[0]!.closestDirection).toBe("classic_trust");
  });

  it("keeps the 'taken from the logo' mark on the intake, off by default", () => {
    expect(parseIntake({}).brand.colorsFromLogo).toBe(false);
    expect(parseIntake({ brand: { colors: ["#12305A"], colorsFromLogo: true } }).brand.colorsFromLogo).toBe(true);
  });
});

describe("the client's real photos first", () => {
  const photo = (token: string, caption: string, width = 1600, height = 1000): PageAsset => ({ token, kind: "photo", caption, fileName: `${token}.jpg`, width, height });

  it("reads a photo's kind from its caption, and picks a real team photo for the hero", () => {
    expect(photoKind("The Harbor team outside the office")).toBe("people");
    expect(photoKind("Termite treatment in a crawl space")).toBe("work");
    expect(photoKind(null, "sunset.jpg")).toBe("other");

    const assets = [photo("tawd-asset:photo-1", "Crawl space treatment"), photo("tawd-asset:photo-2", "Our team", 1000, 1400), photo("tawd-asset:photo-3", "The crew with the van")];
    expect(chooseHeroPhoto(assets)!.token).toBe("tawd-asset:photo-3");
    const plan = photoPlanSection(assets, true);
    expect(plan).toContain("Hero: use tawd-asset:photo-3 (the client's own team");
    expect(plan).toContain("at most 8 on the page, at most one per band");
    expect(plan).toContain("Never put text over a person's face");
    expect(photoPlanSection([], false)).toContain("never an empty box");
  });
});

describe("the Set up screen", () => {
  const plan: SetupPlan = {
    inputs: {
      logo: true,
      colors: ["#12305A", "#3FA535"],
      colorsFrom: "logo",
      photos: { count: 0, people: 0, work: 0 },
      references: [{ url: "https://a.example", shot: true, studied: false }],
      notes: [
        { input: "photos", text: "No real photos yet. Results will be weaker." },
        { input: "references", text: "Only 1 reference site. Results will be weaker." },
      ],
    },
    trade: "pest_control",
    tradeLabel: "Pest control",
    emergency: false,
    moodWords: [],
    notes: ["The logo's colours are deep and sober, which suits Classic Trust."],
    hasFoundingYear: false,
    limitBlocked: null,
    footnote: "Intake complete.",
    estimates: { 1: { costLabel: "Around $1 to $2", middle: 1.5, minutes: 10 }, 2: { costLabel: "Around $2 to $4", middle: 3, minutes: 15 }, 3: { costLabel: "Around $3 to $6", middle: 4.5, minutes: 20 } },
    estimateBasis: "A first guess until real runs exist.",
    designLogInput: { city: null, paletteFamily: null, neighbours: [] },
    concepts: [
      { label: "A", direction: "classic_trust", skillId: "ui_ux_pro_max", reason: "Suggested" },
      { label: "B", direction: "modern_clean", skillId: "impeccable", reason: "" },
      { label: "C", direction: "editorial_authority", skillId: "taste", reason: "" },
    ],
  };

  it("shows what the proposal rests on, then the proposal, with the dropdowns behind Change directions", () => {
    const html = renderToStaticMarkup(<MockupSetup projectId="p1" plan={plan} canRun />);
    expect(html).toContain("What the proposal is based on");
    expect(html).toContain("#12305A, #3FA535, taken from the logo");
    expect(html).toContain("No real photos yet. Results will be weaker.");
    expect(html).toContain("1 site, 0 studied");
    expect(html).toContain("Classic Trust");
    expect(html).toContain("Why TAWD proposes these directions");
    expect(html).toContain("Change directions");
    // The dropdown is the PM's override, not the first thing on the screen.
    expect(html).not.toContain("<select");
  });
});
