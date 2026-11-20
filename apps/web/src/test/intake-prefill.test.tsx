import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  "Pre-fill the intake from the design" (Lane 2): the design's own text
  fills only the empty intake fields, each marked "from the design" until
  the PM confirms or corrects it. Plain text matching on the file saved at
  import: no AI, no Figma read.
*/

const state: { user: unknown } = { user: null };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/projects",
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("@/lib/session", () => ({ requireUser: async () => state.user }));
vi.mock("@/app/actions", () => {
  const f = async () => ({ ok: true });
  return new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : f), has: () => true });
});

import { and, eq } from "drizzle-orm";
import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, figmaDesign, figmaRead, intakePrefill, project } from "@tawd/core/schema";
import { prefillFromDesign, setFigmaForTesting, type FigmaFile, type FigmaNode } from "@tawd/core/figma";
import { importFigmaDesign } from "@tawd/core/figma/service";
import { prefillAfterDesignRead, setAutomaticDesignPrefillForTesting } from "@tawd/core/figma/design-prefill";
import { loadIntake, saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { PermissionError, SYSTEM_ACTOR } from "@tawd/core/permissions";
import IntakePage from "@/app/(app)/projects/[id]/intake/page";
import {
  FigmaDesignError,
  confirmPrefill,
  pendingPrefills,
  prefillIntakeFromDesign,
  queueFigmaImport,
  saveFigmaLink,
} from "@/lib/figma";
import { setQueueForTesting } from "@/lib/mockups";
import { deleteProject } from "@/lib/project-deletion";
import { createProject } from "@/lib/projects";
import { describeChanges } from "@/lib/timeline-text";

import { FILE_LINK, daleRowanFile, fakeFigma } from "./figma-fakes";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

let h: Harness;

beforeEach(async () => {
  // The button's own tests run without the automatic pre-fill at import; the tests of that switch it on.
  setAutomaticDesignPrefillForTesting(false);
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setStorageForTesting(new FakeR2());
  setQueueForTesting({ add: async () => undefined, getJob: async () => null });
});

afterEach(async () => {
  setAutomaticDesignPrefillForTesting(true);
  setFigmaForTesting(null);
  setQueueForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

/* ---------- a homepage with the facts in it ---------- */

let n = 0;
const text = (characters: string, x: number, y: number, size = 16, weight = 400, width = 400): FigmaNode => ({
  id: `5:${++n}`,
  name: characters.slice(0, 20),
  type: "TEXT",
  characters,
  style: { fontFamily: "Inter", fontSize: size, fontWeight: weight },
  absoluteBoundingBox: { x, y, width, height: size * 1.4 },
});
const frame = (name: string, y: number, children: FigmaNode[], height = 400): FigmaNode => ({
  id: `5:${++n}`,
  name,
  type: "FRAME",
  absoluteBoundingBox: { x: 0, y, width: 1440, height },
  children,
});

function homeWith(children: FigmaNode[]): FigmaFile {
  const file = daleRowanFile();
  file.document.children![2]!.children![0] = {
    id: "2:10",
    name: "Home",
    type: "FRAME",
    absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 4000 },
    children,
  };
  return file;
}

const tile = (title: string, description: string, x: number) =>
  frame(title, 1100, [text(title, x + 20, 1120, 20, 700), text(description, x + 20, 1160)], 200);

function fullDesign(): FigmaFile {
  return homeWith([
    frame("Header", 0, [
      text("Example Well & Pump", 80, 30, 26, 700),
      text("Services", 700, 36),
      text("About", 800, 36),
      text("Call (530) 555-0199", 1200, 36, 17, 700),
    ], 100),
    frame("Hero", 100, [
      text("Well drilling and pump repair", 120, 300, 64, 700),
      text("Serving Grass Valley, Nevada City and Auburn since 1987.", 120, 420, 20),
    ], 800),
    frame("Services", 1000, [
      text("Our services", 80, 1020, 40, 700),
      tile("Well drilling", "New residential and agricultural wells.", 80),
      tile("Pump repair", "Submersible and jet pumps, same day.", 520),
      tile("Water testing", "Yearly tests and treatment advice.", 960),
    ], 500),
    frame("Footer", 3600, [
      text("123 Main St, Grass Valley, CA 95945", 80, 3620),
      text("info@examplewell.com", 80, 3650),
      text("CA Lic. #1034567", 80, 3680),
      text("© 2026 Example Well & Pump. All rights reserved.", 80, 3710, 13),
    ], 400),
  ]);
}

const HOME = [{ id: "2:10", name: "Home", isHome: true }];

/*
  E0(c), 13 November 2026: laid out like the Pat Rivera read. A top bar
  with a "Schedule Online" button on the same row as the towns and numbers;
  a hero phone beside a "Message" button; an "Our Services" button beside
  "Our Story" in one band; a "What we do" band with a big headline, three
  cards (title, two lines of description, "Learn more"); a footer with
  Locations (addresses) beside Services.
*/
function patLikeDesign(): FigmaFile {
  return homeWith([
    frame("Topbar", 0, [
      text("Schedule Online", 513, 28, 7, 400, 120),
      text("Reno", 739, 16, 8, 400, 50),
      text("775-346-6321", 739, 28, 7, 400, 70),
      text("Bishop", 873, 16, 8, 400, 50),
      text("760-205-6540", 873, 28, 7, 400, 70),
      text("Winnemucca", 1026, 16, 8, 400, 70),
      text("775-823-4203", 1026, 28, 7, 400, 70),
    ], 50),
    frame("Hero", 60, [text("775-238-9814", 388, 397, 14, 700, 120), text("Message", 520, 397, 10, 400, 60)], 500),
    frame("Legacy", 600, [
      text("Serving Northern Nevada", 343, 665, 26, 700, 350),
      text("Established in 1981.", 343, 744, 11, 400, 350),
      text("Our Services", 360, 884, 11, 700, 80),
      text("Our Story", 494, 884, 11, 700, 60),
    ], 320),
    frame("What we do", 950, [
      text("What we do", 360, 970, 9, 700, 100),
      text("The Right Fix. The First Time", 343, 990, 24, 700, 340),
      text("From pump repair to full well installation.", 343, 1030, 10, 400, 280),
      text("Water Pump Service & Repair", 665, 1049, 10, 700, 100),
      text("Keep your water flowing with fast,", 665, 1061, 8, 400, 110),
      text("expert pump repairs and service.", 665, 1071, 8, 400, 110),
      text("Learn more", 665, 1090, 8, 700, 60),
      text("Water Well Drilling", 789, 1049, 10, 700, 80),
      text("New well drilling for residential,", 789, 1061, 8, 400, 110),
      text("commercial, and agricultural needs.", 789, 1071, 8, 400, 110),
      text("Learn more", 789, 1090, 8, 700, 60),
      text("Water Filtration", 913, 1049, 10, 700, 80),
      text("Filtration systems for cleaner,", 913, 1061, 8, 400, 110),
      text("safer, better-tasting water.", 913, 1071, 8, 400, 110),
      text("Learn more", 913, 1090, 8, 700, 60),
    ], 200),
  ]);
}

describe("reading the facts from a design laid out like the Pat Rivera read (E0(c))", () => {
  const found = () => Object.fromEntries(prefillFromDesign(patLikeDesign(), HOME).map((p) => [p.key, p.value]));

  it("names each other location by the town above its number, never a button on the same row or beside it", () => {
    const locations = found()["business.locations"] as { name: string; phone: string }[];
    expect(locations.map((l) => [l.name, l.phone])).toEqual([
      ["Bishop", "(760) 205-6540"],
      ["Winnemucca", "(775) 823-4203"],
    ]);
  });

  it("takes the services from the cards under the heading, with their own descriptions, not a button or the headline", () => {
    expect(found()["services.items"]).toEqual([
      { name: "Water Pump Service & Repair", description: "Keep your water flowing with fast, expert pump repairs and service." },
      { name: "Water Well Drilling", description: "New well drilling for residential, commercial, and agricultural needs." },
      { name: "Water Filtration", description: "Filtration systems for cleaner, safer, better-tasting water." },
    ]);
  });

  it("never takes a street address or a City, ST line as a service", () => {
    const design = homeWith([
      frame("Footer", 0, [
        text("Services", 900, 10, 12, 700, 80),
        text("Locations", 600, 10, 12, 700, 80),
        text("7355 Lodging Ln, Reno, NV 89511", 600, 40, 10, 400, 160),
        text("1085 Ash St, Bishop, CA 93514", 600, 74, 10, 400, 160),
        text("Water Well Drilling", 900, 40, 10, 400, 120),
        text("Water Filtration Systems", 900, 60, 10, 400, 140),
        text("© 2024 Example Well Co. All rights reserved.", 40, 160, 8, 400, 300),
      ], 200),
    ]);
    const items = Object.fromEntries(prefillFromDesign(design, HOME).map((p) => [p.key, p.value]))["services.items"] as { name: string }[];
    expect(items.map((i) => i.name)).toEqual(["Water Well Drilling", "Water Filtration Systems"]);
  });
});

describe("Fable's review of #85: the reading of services and towns", () => {
  const facts = (design: FigmaFile) => Object.fromEntries(prefillFromDesign(design, HOME).map((p) => [p.key, p.value]));

  it("keeps real names and sentences that contain a button word; skips only whole button labels", () => {
    const design = homeWith([
      frame("Services", 0, [
        text("Our services", 80, 20, 30, 700, 300),
        text("Sign Installation", 80, 100, 18, 700, 200),
        text("Get your signs up again today.", 80, 130, 14, 400, 260),
        text("Learn more", 80, 160, 14, 700, 100),
        text("Jump Start Service", 480, 100, 18, 700, 220),
        text("Dead battery? We come to you.", 480, 130, 14, 400, 260),
        text("Learn more", 480, 160, 14, 700, 100),
      ], 300),
      frame("Topbar", 400, [text("Main 530-555-0101", 80, 426, 12, 400, 160), text("Mountain View", 900, 410, 12, 400, 110), text("650-555-0142", 900, 426, 12, 400, 100)], 60),
    ]);
    const f = facts(design);
    expect(f["services.items"]).toEqual([
      { name: "Sign Installation", description: "Get your signs up again today." },
      { name: "Jump Start Service", description: "Dead battery? We come to you." },
    ]);
    expect((f["business.locations"] as { name: string }[]).map((l) => l.name)).toEqual(["Mountain View"]);
  });

  it("prefers bold titles over a larger group of plain description lines, with fine print nearby", () => {
    const design = homeWith([
      frame("Services", 0, [
        text("Our services", 80, 20, 30, 700, 300),
        text("Tank repair", 80, 100, 20, 700, 200),
        text("Fast tidy work", 80, 130, 16, 400, 200),
        text("every single time", 80, 152, 16, 400, 200),
        text("Pump service", 480, 100, 20, 700, 200),
        text("Repair of pumps", 480, 130, 16, 400, 200),
        text("of all brands", 480, 152, 16, 400, 200),
        text("Prices exclude tax.", 80, 260, 10, 400, 200),
      ], 300),
    ]);
    expect(facts(design)["services.items"]).toEqual([
      { name: "Tank repair", description: "Fast tidy work every single time" },
      { name: "Pump service", description: "Repair of pumps of all brands" },
    ]);
  });

  it("takes titles on the heading's own row, to its right (a heading beside a grid of cards)", () => {
    const design = homeWith([
      frame("Services", 0, [
        text("Our services", 80, 100, 30, 700, 260),
        text("Drilling", 500, 100, 20, 700, 150),
        text("Pumps", 800, 100, 20, 700, 150),
        text("Filtration", 500, 200, 20, 700, 150),
        text("Testing", 800, 200, 20, 700, 150),
      ], 300),
    ]);
    expect((facts(design)["services.items"] as { name: string }[]).map((i) => i.name).sort()).toEqual(["Drilling", "Filtration", "Pumps", "Testing"]);
  });

  it("names a location by the town to the right of its number, and finds a description centred under a narrower title", () => {
    const design = homeWith([
      frame("Topbar", 0, [text("Main 530-555-0101", 80, 10, 12, 400, 160), text("530-555-0177", 600, 10, 12, 400, 100), text("Chico", 710, 10, 12, 400, 50)], 40),
      frame("Services", 100, [
        text("Our services", 80, 120, 30, 700, 300),
        text("Wells", 160, 200, 20, 700, 60),
        text("New wells for homes and farms.", 100, 230, 14, 400, 180),
        text("Pumps", 560, 200, 20, 700, 70),
        text("Repairs the same day.", 525, 230, 14, 400, 140),
      ], 300),
    ]);
    const f = facts(design);
    expect((f["business.locations"] as { name: string }[]).map((l) => l.name)).toEqual(["Chico"]);
    expect(f["services.items"]).toEqual([
      { name: "Wells", description: "New wells for homes and farms." },
      { name: "Pumps", description: "Repairs the same day." },
    ]);
  });
});

describe("Fable's re-read of #85", () => {
  const facts = (design: FigmaFile) => Object.fromEntries(prefillFromDesign(design, HOME).map((p) => [p.key, p.value]));

  it("pairs each number with the town touching it when several pairs share a line, town after the number or before it", () => {
    const after = homeWith([
      frame("Topbar", 0, [
        text("530-555-0100", 80, 10, 12, 400, 100), text("Reno", 185, 10, 12, 400, 40),
        text("760-555-0111", 265, 10, 12, 400, 100), text("Bishop", 370, 10, 12, 400, 50),
        text("775-555-0122", 460, 10, 12, 400, 100), text("Elko", 565, 10, 12, 400, 40),
      ], 40),
    ]);
    expect((facts(after)["business.locations"] as { name: string; phone: string }[]).map((l) => [l.name, l.phone])).toEqual([
      ["Bishop", "(760) 555-0111"],
      ["Elko", "(775) 555-0122"],
    ]);
    const before = homeWith([
      frame("Topbar", 0, [
        text("Reno", 80, 10, 12, 400, 40), text("530-555-0100", 125, 10, 12, 400, 100),
        text("Bishop", 265, 10, 12, 400, 50), text("760-555-0111", 320, 10, 12, 400, 100),
      ], 40),
    ]);
    expect((facts(before)["business.locations"] as { name: string }[]).map((l) => l.name)).toEqual(["Bishop"]);
  });

  // Fable's second re-read: an evenly spaced auto-layout row, the gap to the town on either side the same.
  it("pairs each number with its own town in an evenly spaced row (a town belongs to one number only)", () => {
    const row = (items: [string, number][]) => homeWith([frame("Topbar", 0, items.map(([t, x]) => text(t, x, 10, 12, 400, /\d/.test(t) ? 100 : 50)), 40)]);
    const right = row([["530-555-0100", 80], ["Reno", 196], ["760-555-0111", 262], ["Bishop", 378], ["775-555-0122", 444], ["Elko", 560]]);
    expect((facts(right)["business.locations"] as { name: string; phone: string }[]).map((l) => [l.name, l.phone])).toEqual([
      ["Bishop", "(760) 555-0111"],
      ["Elko", "(775) 555-0122"],
    ]);
    const left = row([["Reno", 80], ["530-555-0100", 146], ["Bishop", 262], ["760-555-0111", 328], ["Elko", 444], ["775-555-0122", 510]]);
    expect((facts(left)["business.locations"] as { name: string; phone: string }[]).map((l) => [l.name, l.phone])).toEqual([
      ["Bishop", "(760) 555-0111"],
      ["Elko", "(775) 555-0122"],
    ]);
  });

  it("never takes a common button label for a town, a service or a description", () => {
    for (const label of ["Free Estimate", "Book Appointment", "Schedule Appointment", "Contact Us Today", "Get Directions", "Pay Online", "Email Us", "Our Story", "View All Services"]) {
      const design = homeWith([frame("Topbar", 0, [text("Main 530-555-0101", 80, 10, 12, 400, 160), text(label, 600, 10, 12, 400, 120), text("530-555-0177", 725, 10, 12, 400, 100)], 40)]);
      expect(facts(design)["business.locations"], label).toBeUndefined();
    }
    const cards = homeWith([
      frame("Services", 0, [
        text("Our services", 80, 20, 30, 700, 300),
        text("Drain Cleaning", 80, 100, 18, 700, 200), text("Book Appointment", 80, 130, 14, 700, 160), text("View Service", 80, 160, 18, 700, 140),
        text("Water Heaters", 480, 100, 18, 700, 200), text("Book Appointment", 480, 130, 14, 700, 160), text("View Service", 480, 160, 18, 700, 140),
        text("View All Services", 80, 240, 18, 700, 200),
      ], 300),
    ]);
    expect(facts(cards)["services.items"]).toEqual([
      { name: "Drain Cleaning", description: "" },
      { name: "Water Heaters", description: "" },
    ]);
  });

  it("takes a title on the heading's row only as the top of a grid, never a lone bold line beside the heading", () => {
    const design = homeWith([
      frame("Services", 0, [
        text("Our services", 80, 100, 30, 700, 260),
        text("Call Bob Today", 700, 100, 20, 700, 160),
        text("Drilling", 500, 200, 20, 700, 150),
        text("Pumps", 900, 200, 20, 700, 150),
      ], 300),
    ]);
    expect((facts(design)["services.items"] as { name: string }[]).map((i) => i.name)).toEqual(["Drilling", "Pumps"]);
  });
});

describe("reading the facts from the design's text", () => {
  it("finds the name, phone, email, address, license, year, services and areas", () => {
    const found = Object.fromEntries(prefillFromDesign(fullDesign(), HOME).map((p) => [p.key, p.value]));
    expect(found).toEqual({
      "business.name": "Example Well & Pump",
      "business.phone": "(530) 555-0199",
      "business.email": "info@examplewell.com",
      "business.streetAddress": "123 Main St",
      "business.city": "Grass Valley",
      "business.state": "CA",
      "business.licenseNumbers": ["1034567"],
      "business.yearFounded": 1987,
      "services.items": [
        { name: "Well drilling", description: "New residential and agricultural wells." },
        { name: "Pump repair", description: "Submersible and jet pumps, same day." },
        { name: "Water testing", description: "Yearly tests and treatment advice." },
      ],
      "serviceAreas.cities": ["Grass Valley", "Nevada City", "Auburn"],
    });
  });

  it("keeps the text each value was read from", () => {
    const phone = prefillFromDesign(fullDesign(), HOME).find((p) => p.key === "business.phone")!;
    expect(phone.from).toBe("Call (530) 555-0199");
  });

  it("never takes a placeholder, or a year without words that say it is the founding year", () => {
    const found = prefillFromDesign(
      homeWith([
        frame("Hero", 0, [
          text("Family-run since [year]", 80, 100),
          text("CA C-57 #[license]", 80, 140),
          text("Call [PLACEHOLDER: phone]", 80, 180),
          text("© 2026", 80, 220),
          text("Our 2019 award", 80, 260),
        ]),
      ]),
      HOME,
    );
    expect(found.map((p) => p.key)).toEqual([]);
  });

  it("reads a CSLB or C-57 license, and takes the name from the header when there is no copyright line", () => {
    const found = Object.fromEntries(
      prefillFromDesign(
        homeWith([
          frame("Header", 0, [text("Home", 40, 30), text("Sierra Pumps", 120, 30, 24, 700), text("(916) 555 0147", 1200, 30)], 100),
          frame("Trust", 200, [text("C-57 #987654 | Est. 2004", 80, 220)]),
        ]),
        HOME,
      ).map((p) => [p.key, p.value]),
    );
    expect(found["business.name"]).toBe("Sierra Pumps");
    expect(found["business.phone"]).toBe("(916) 555-0147");
    expect(found["business.licenseNumbers"]).toEqual(["987654"]);
    expect(found["business.yearFounded"]).toBe(2004);
  });

  it("takes the name from a footer line that also carries the phone", () => {
    const found = prefillFromDesign(homeWith([frame("Footer", 0, [text("Gold Country Wells · Auburn, CA · (530) 555-0101", 80, 20)])]), HOME);
    expect(found.find((p) => p.key === "business.name")!.value).toBe("Gold Country Wells");
    expect(found.find((p) => p.key === "business.city")!.value).toBe("Auburn");
  });
});

describe("a business with more than one office", () => {
  it("reads each further phone with its town as another location, the first as the main phone", () => {
    const found = prefillFromDesign(
      homeWith([
        frame("Top bar", 0, [text("Reno 775-555-0118 | Bishop: (760) 555-0142 | Winnemucca 775-555-0177", 80, 20)], 60),
        frame("Hero", 60, [text("Family owned since 1981 775-555-0118", 80, 300)]),
        frame("Offices", 1000, [
          frame("Bishop card", 1000, [text("Bishop Office", 80, 1020, 20, 700), text("(760) 555-0142", 80, 1060), text("12 Line St, Bishop, CA", 80, 1090)], 200),
        ]),
      ]),
      HOME,
    );
    const byKey = Object.fromEntries(found.map((p) => [p.key, p.value]));
    expect(byKey["business.phone"]).toBe("(775) 555-0118");
    expect(byKey["business.locations"]).toEqual([
      { name: "Bishop", phone: "(760) 555-0142", streetAddress: "", city: "Bishop", state: "" },
      { name: "Winnemucca", phone: "(775) 555-0177", streetAddress: "", city: "Winnemucca", state: "" },
    ]);
    // "Since 1981" beside a phone is a year, never a phone.
    expect(byKey["business.yearFounded"]).toBe(1981);
  });

  it("takes the town and street from the phone's own block when the phone stands alone", () => {
    const found = prefillFromDesign(
      homeWith([
        frame("Header", 0, [text("Call (775) 555-0118", 1200, 30)], 100),
        frame("Bishop card", 1000, [text("Bishop Office", 80, 1020, 20, 700), text("(760) 555-0142", 80, 1060), text("12 Line St, Bishop, CA", 80, 1090)], 200),
      ]),
      HOME,
    );
    expect(found.find((p) => p.key === "business.locations")!.value).toEqual([
      { name: "Bishop Office", phone: "(760) 555-0142", streetAddress: "12 Line St", city: "Bishop", state: "CA" },
    ]);
  });

  it("leaves out a further phone with no town beside it", () => {
    const found = prefillFromDesign(homeWith([frame("Header", 0, [text("Call (775) 555-0118", 1200, 30), text("Fax 775 555 0100", 1200, 60)], 100)]), HOME);
    expect(found.some((p) => p.key === "business.locations")).toBe(false);
  });
});

/* ---------- filling the intake ---------- */

async function seedImported(file: () => FigmaFile = fullDesign) {
  const admin = await seedAdmin(h);
  state.user = admin.viewer;
  const projectId = await createProject(h.ctx, admin.viewer, {
    clientName: "Dale Rowan",
    trade: "well_and_pump",
    tier: "starter",
    lane: "lane_2",
    laneOption: "b",
    conceptCount: 1,
    status: "intake",
    memberUserIds: [],
  });
  setFigmaForTesting(fakeFigma({ file }).api);
  await saveFigmaLink(h.ctx, admin.viewer, projectId, FILE_LINK);
  await queueFigmaImport(h.ctx, admin.viewer, projectId);
  await importFigmaDesign(h.db, projectId);
  return { admin, projectId };
}

describe("pre-filling the intake", () => {
  it("fills only the empty fields, marks each, reads nothing from Figma, and logs it", async () => {
    const { admin, projectId } = await seedImported();
    // The PM already typed the city and a service area.
    await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", { city: "Nevada City" });
    await saveIntakeSection(h.ctx, admin.viewer, projectId, "serviceAreas", { cities: ["Penn Valley"] });
    const reads = (await h.db.select().from(figmaRead)).length;

    const result = await prefillIntakeFromDesign(h.ctx, admin.viewer, projectId);

    expect((await h.db.select().from(figmaRead)).length).toBe(reads);
    expect(result.filled.map((f) => f.label)).toEqual([
      "Phone",
      "Email",
      "Street address",
      "State",
      "License number",
      "Year founded",
      "Business name",
      "Services",
    ]);
    expect(result.alreadyFilled).toEqual(["City", "Service areas"]);
    expect(result.notFound).toEqual([]);

    const intake = (await loadIntake(h.db, SYSTEM_ACTOR, projectId))!.data;
    expect(intake.business).toMatchObject({
      name: "Example Well & Pump",
      phone: "(530) 555-0199",
      city: "Nevada City",
      state: "CA",
      licenseNumbers: ["1034567"],
      yearFounded: 1987,
    });
    expect(intake.services.items.map((s) => s.name)).toEqual(["Well drilling", "Pump repair", "Water testing"]);
    expect(intake.services.mainServiceId).toBe(intake.services.items[0]!.id);
    expect(intake.serviceAreas.cities).toEqual(["Penn Valley"]);

    const marks = await pendingPrefills(h.db, projectId);
    expect(Object.keys(marks).sort()).toEqual([
      "business.email",
      "business.licenseNumbers",
      "business.name",
      "business.phone",
      "business.state",
      "business.streetAddress",
      "business.yearFounded",
      "services.items",
    ]);
    expect(marks["business.phone"]).toEqual({ source: "Call (530) 555-0199", origin: "design" });

    const [log] = await h.db.select().from(activityLog).where(eq(activityLog.action, "intake.prefilled"));
    const lines = describeChanges("intake.prefilled", null, log!.valueAfter, new Map());
    expect(lines).toContain("Phone: (530) 555-0199");
    expect(lines).toContain("Services: Well drilling, Pump repair, Water testing");
    expect(lines.at(-1)).toBe("Left alone, already filled in: City, Service areas");
    expect((await h.db.select().from(figmaDesign))[0]!.prefillResult).toMatchObject({ alreadyFilled: ["City", "Service areas"] });
  });

  it("takes the mark off a field the PM saves differently, and logs the correction", async () => {
    const { admin, projectId } = await seedImported();
    await prefillIntakeFromDesign(h.ctx, admin.viewer, projectId);
    const business = (await loadIntake(h.db, SYSTEM_ACTOR, projectId))!.data.business;

    await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", { ...business, phone: "(530) 555-0100" });

    const marks = await pendingPrefills(h.db, projectId);
    expect(marks["business.phone"]).toBeUndefined();
    // Saved unchanged: still waiting for someone to confirm it.
    expect(marks["business.name"]).toBeDefined();
    const [row] = await h.db.select().from(intakePrefill).where(eq(intakePrefill.fieldKey, "business.phone"));
    expect(row).toMatchObject({ status: "corrected", resolvedByUserId: admin.viewer.id });
    const [log] = await h.db.select().from(activityLog).where(eq(activityLog.action, "intake.prefill_corrected"));
    expect(describeChanges("intake.prefill_corrected", null, log!.valueAfter, new Map())).toEqual(["Phone"]);
  });

  it("takes the mark off a field the PM confirms, and logs it", async () => {
    const { admin, projectId } = await seedImported();
    await prefillIntakeFromDesign(h.ctx, admin.viewer, projectId);
    await confirmPrefill(h.ctx, admin.viewer, projectId, "business.email");
    await confirmPrefill(h.ctx, admin.viewer, projectId, "business.email");
    expect((await pendingPrefills(h.db, projectId))["business.email"]).toBeUndefined();
    const logs = await h.db.select().from(activityLog).where(eq(activityLog.action, "intake.prefill_confirmed"));
    expect(logs).toHaveLength(1);
    expect(describeChanges("intake.prefill_confirmed", null, logs[0]!.valueAfter, new Map())).toEqual(["Email: info@examplewell.com"]);
    await expect(confirmPrefill(h.ctx, admin.viewer, projectId, "business.hours")).rejects.toBeInstanceOf(FigmaDesignError);
  });

  it("run again, leaves everything it filled alone, since those fields are no longer empty", async () => {
    const { admin, projectId } = await seedImported();
    await prefillIntakeFromDesign(h.ctx, admin.viewer, projectId);
    const again = await prefillIntakeFromDesign(h.ctx, admin.viewer, projectId);
    expect(again.filled).toEqual([]);
    expect(again.alreadyFilled).toHaveLength(10);
  });

  it("says what the design doesn't have", async () => {
    const { admin, projectId } = await seedImported(daleRowanFile);
    const result = await prefillIntakeFromDesign(h.ctx, admin.viewer, projectId);
    expect(result.filled.map((f) => f.label)).toEqual(["Phone"]);
    expect(result.notFound).toContain("Email");
    expect(result.notFound).toContain("License number");
  });

  it("needs an imported design, and a PM or admin", async () => {
    const { admin, projectId } = await seedImported();
    const designer = await seedUser(h, admin.viewer, { email: "designer@velocitymedialab.com", roles: ["web_designer"] });
    await expect(prefillIntakeFromDesign(h.ctx, designer.viewer, projectId)).rejects.toBeInstanceOf(PermissionError);
    await h.db.update(figmaDesign).set({ importStatus: null });
    await expect(prefillIntakeFromDesign(h.ctx, admin.viewer, projectId)).rejects.toThrow(/Import the design first/);
  });

  it("goes with the project", async () => {
    const { admin, projectId } = await seedImported();
    await prefillIntakeFromDesign(h.ctx, admin.viewer, projectId);
    await deleteProject(h.ctx, admin.viewer, projectId, { confirmName: "Dale Rowan", reason: "Test project, no longer needed" });
    expect(await h.db.select().from(intakePrefill)).toHaveLength(0);
  });
});

/* ---------- the screens ---------- */

describe("the intake screens", () => {
  async function render(projectId: string, section: string) {
    const node = await IntakePage({ params: Promise.resolve({ id: projectId }), searchParams: Promise.resolve({ section }) });
    return renderToStaticMarkup(node as React.ReactElement);
  }

  /*
    E0(c), audit batch E (13 November 2026): in the paid Lane 2 run nobody
    pressed the button, so the built footer showed placeholders for facts the
    design showed. Now the pre-fill runs by itself where every design read
    finishes (core figma/design-prefill.ts); the button stays for a manual run.
  */
  const prefillRuns = async (projectId: string) =>
    (await h.db.select().from(activityLog).where(and(eq(activityLog.entityId, projectId), eq(activityLog.action, "intake.prefilled")))).length;

  describe("by itself, at the end of the design read", () => {
    beforeEach(() => setAutomaticDesignPrefillForTesting(true));

    it("fills the answers when the read finishes, credits TAWD, and the first view's form already shows them", async () => {
      const { admin, projectId } = await seedImported();
      expect(await prefillRuns(projectId)).toBe(1);
      const figma = await render(projectId, "figma");
      expect(figma).toContain("filled 10 fields.");
      expect(figma).toContain("by TAWD, automatically after the design was read");
      expect(figma).toContain("Pre-fill again");
      const [mark] = await h.db.select().from(intakePrefill).where(and(eq(intakePrefill.projectId, projectId), eq(intakePrefill.fieldKey, "business.phone")));
      expect(mark).toMatchObject({ origin: "design", status: "pending", filledByUserId: null });
      // The answer is in the intake itself before anyone opens the page (Fable's review: the form showed blanks on the first view).
      const intake = await loadIntake(h.db, admin.viewer, projectId);
      expect(intake!.data.business.phone).toBe("(530) 555-0199");
      expect(await render(projectId, "business")).toContain("(530) 555-0199");

      // The button still works, by a person.
      await prefillIntakeFromDesign(h.ctx, admin.viewer, projectId);
      expect(await render(projectId, "figma")).not.toContain("automatically after the design was read");
    });

    it("on a later read, never refills an answer a person corrected or cleared", async () => {
      const { admin, projectId } = await seedImported();
      // The PM clears the phone the design gave (a correction).
      await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", { phone: "" });
      const [mark] = await h.db.select().from(intakePrefill).where(and(eq(intakePrefill.projectId, projectId), eq(intakePrefill.fieldKey, "business.phone")));
      expect(mark!.status).toBe("corrected");
      // The design is read again.
      const again = await prefillAfterDesignRead(h.db, projectId);
      expect(await prefillRuns(projectId)).toBe(2);
      // Left as the person left it, and not reported as "already filled" (it is empty).
      expect(again!.alreadyFilled).not.toContain("Phone");
      expect((await loadIntake(h.db, admin.viewer, projectId))!.data.business.phone).toBe("");
    });

    it("a pre-fill that can't run never fails the read: nothing is filled and it is logged", async () => {
      const { admin, projectId } = await seedImported();
      await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", { phone: "", email: "" });
      // The saved read goes missing.
      await h.db.update(figmaDesign).set({ readiness: null }).where(eq(figmaDesign.projectId, projectId));
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await expect(prefillAfterDesignRead(h.db, projectId)).resolves.toBeNull();
      expect(errors).toHaveBeenCalled();
      errors.mockRestore();
      expect(await prefillRuns(projectId)).toBe(1);
    });

    it("does nothing on a project that isn't Lane 2", async () => {
      const { projectId } = await seedImported();
      await h.db.update(project).set({ lane: "lane_1" }).where(eq(project.id, projectId));
      await expect(prefillAfterDesignRead(h.db, projectId)).resolves.toBeNull();
      expect(await prefillRuns(projectId)).toBe(1);
    });
  });

  it("marks each pre-filled field until it is confirmed or corrected", async () => {
    const { admin, projectId } = await seedImported();
    await prefillIntakeFromDesign(h.ctx, admin.viewer, projectId);
    const business = await render(projectId, "business");
    expect(business.match(/From the design/g)).toHaveLength(8);
    expect(business).toContain("Read from “Call (530) 555-0199”");
    expect(await render(projectId, "services")).toContain("From the design");

    await confirmPrefill(h.ctx, admin.viewer, projectId, "business.phone");
    expect((await render(projectId, "business")).match(/From the design/g)).toHaveLength(7);
  });
});
