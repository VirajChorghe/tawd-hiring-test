import { randomBytes } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Brand colours (the founders' request, 25 September 2026): a full colour
  picker (the square, the hue slider, the hex box, the eyedropper where
  the browser has one), and "Suggest colors from the logo": the logo's main
  colours from its pixels, no AI, served from TAWD's own address.
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

import { setDbForTesting, type Database } from "@tawd/core/db";
import { intakeFile } from "@tawd/core/schema";
import { hexToHsv, hsvToHex, logoPalette, normalizeHex } from "@tawd/core/intake";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { setEncryptionKeyForTesting } from "@tawd/core/secrets";
import { GET as logoFile } from "@/app/(app)/projects/[id]/intake/files/[fileId]/route";
import { ColorPicker } from "@/components/ui/color-picker";
import { LogoColors } from "@/components/intake/logo-colors";
import { createProject } from "@/lib/projects";
import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

/* RGBA pixels: n of each colour. */
function pixels(...runs: [number, [number, number, number, number]][]): Uint8ClampedArray {
  const out: number[] = [];
  for (const [n, rgba] of runs) for (let i = 0; i < n; i += 1) out.push(...rgba);
  return new Uint8ClampedArray(out);
}

describe("the logo's colours", () => {
  it("finds the main colours, most used first, leaving out the white background and see-through pixels", () => {
    const logo = pixels(
      [500, [255, 255, 255, 255]], // the white it sits on
      [300, [0, 0, 0, 0]], // see-through
      [120, [31, 78, 121, 255]], // navy
      [60, [200, 85, 27, 255]], // orange
      [20, [33, 80, 124, 255]], // a near-navy edge, merged into navy
      [1, [10, 200, 10, 255]], // a stray pixel
    );
    expect(logoPalette(logo)).toEqual([
      { hex: "#1F4E79", share: 0.7 },
      { hex: "#C8551B", share: 0.3 },
    ]);
    expect(logoPalette(pixels([10, [255, 255, 255, 255]]))).toEqual([]);
  });

  it("leaves out the soft edges, where a colour blends into the white or into another colour", () => {
    const logo = pixels(
      [400, [31, 78, 121, 255]], // navy
      [200, [200, 85, 27, 255]], // orange
      [60, [164, 183, 200, 255]], // navy fading into white
      [40, [233, 186, 163, 255]], // orange fading into white
      [30, [115, 82, 74, 255]], // where navy meets orange
      [80, [40, 160, 90, 255]], // a real green, not a mix of anything
    );
    expect(logoPalette(logo).map((c) => c.hex)).toEqual(["#1F4E79", "#C8551B", "#28A05A"]);
  });

  it("turns hex into hue, saturation and brightness and back", () => {
    expect(normalizeHex("1f4")).toBe("#11FF44");
    expect(normalizeHex("#1f4e79")).toBe("#1F4E79");
    expect(normalizeHex("blue")).toBeNull();
    for (const colour of ["#1F4E79", "#C8551B", "#000000", "#FFFFFF", "#7F7F7F"]) {
      expect(hsvToHex(hexToHsv(colour)!)).toBe(colour);
    }
    expect(hexToHsv("#FF0000")).toEqual({ h: 0, s: 1, v: 1 });
  });
});

describe("the picker and the swatches", () => {
  it("shows the swatch, the hex box, and when open the square and the hue slider", () => {
    const closed = renderToStaticMarkup(<ColorPicker label="Primary color" value="#1F4E79" onChange={() => {}} />);
    expect(closed).toContain('aria-label="Choose the primary color"');
    expect(closed).toContain('value="#1F4E79"');
    expect(closed).not.toContain("Saturation and brightness");
    const open = renderToStaticMarkup(<ColorPicker label="Primary color" value="#1F4E79" onChange={() => {}} initiallyOpen />);
    expect(open).toContain('aria-label="Saturation and brightness"');
    expect(open).toContain('aria-label="Hue"');
    expect(open).toContain("Done");
    // No eyedropper on the server: it only appears in a browser that has one.
    expect(open).not.toContain("Pick a colour from the screen");
    expect(renderToStaticMarkup(<ColorPicker label="Accent color" value="#12" onChange={() => {}} />)).toContain("Use a hex code");
  });

  it("offers the logo's colours as one-click swatches, marking the ones already chosen", () => {
    const html = renderToStaticMarkup(
      <LogoColors
        projectId="p1"
        logoIds={["f1"]}
        used={["#1f4f7a"]}
        canEdit
        onPick={() => {}}
        initial={[
          { hex: "#1F4F7A", share: 0.7 },
          { hex: "#C8551B", share: 0.3 },
        ]}
      />,
    );
    expect(html).toContain("Use #C8551B");
    expect(html).toContain("#1F4F7A is already a brand color");
    expect(html).toContain("In use");
    const before = renderToStaticMarkup(<LogoColors projectId="p1" logoIds={["f1"]} used={[]} canEdit onPick={() => {}} />);
    expect(before).toContain("Suggest colors from the logo");
    expect(renderToStaticMarkup(<LogoColors projectId="p1" logoIds={[]} used={[]} canEdit onPick={() => {}} />)).toBe("");
  });
});

describe("the logo, from TAWD's own address", () => {
  let h: Harness;
  let r2: FakeR2;
  beforeEach(async () => {
    h = await createHarness();
    setDbForTesting(h.db as Database);
    r2 = new FakeR2();
    setStorageForTesting(r2);
    setEncryptionKeyForTesting(randomBytes(32));
  });
  afterEach(async () => {
    setEncryptionKeyForTesting(null);
    setStorageForTesting(null);
    setDbForTesting(null);
    await h.close();
  });

  it("serves an uploaded image to the team, sandboxed, and nothing else", async () => {
    const admin = await seedAdmin(h);
    state.user = admin.viewer;
    const projectId = await createProject(h.ctx, admin.viewer, {
      clientName: "Dale Rowan",
      trade: "well_and_pump",
      tier: "starter",
      lane: "lane_1",
      laneOption: null,
      conceptCount: 3,
      status: "intake",
      memberUserIds: [],
    });
    const [logo] = await h.db
      .insert(intakeFile)
      .values({ projectId, kind: "logo", storageKey: "projects/x/logo.png", fileName: "logo.png", contentType: "image/png", status: "ready" })
      .returning();
    const [guide] = await h.db
      .insert(intakeFile)
      .values({ projectId, kind: "brand_guide", storageKey: "projects/x/guide.pdf", fileName: "guide.pdf", contentType: "application/pdf", status: "ready" })
      .returning();
    r2.objects.set("projects/x/logo.png", Buffer.from("png-bytes"));
    r2.objects.set("projects/x/guide.pdf", Buffer.from("pdf-bytes"));
    const get = (fileId: string, id = projectId) => logoFile(new Request("http://x"), { params: Promise.resolve({ id, fileId }) });

    const response = await get(logo!.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-security-policy")).toMatch(/^sandbox;/);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("png-bytes");

    // Not an image, or not this project's file.
    expect((await get(guide!.id)).status).toBe(404);
    expect((await get(logo!.id, "00000000-0000-0000-0000-000000000000")).status).toBe(404);
  });
});
