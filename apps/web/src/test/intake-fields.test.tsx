import path from "node:path";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Two intake fields made useful, and one that now reaches every paid step
  (26 September 2026, overnight):
  - the brand guide PDF, read once (no AI) into "From the brand guide"
    suggestions the PM uses or dismisses;
  - "Websites they like", photographed once (no AI) and given to the
    mockup builder as inspiration only;
  - "Notes for the designer", in every prompt that designs, changes or
    judges a page.
*/

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/projects",
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));

import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, brandGuideReading, intakeFile, likedSiteShot, mockupRun } from "@tawd/core/schema";
import { buildDesignReviewText, buildImproveSectionText, buildRescoreText, buildUndoSectionText } from "@tawd/core/figma";
import { readBrandGuideText } from "@tawd/core/intake/brand-guide";
import { emptyIntake } from "@tawd/core/intake";
import { loadIntake, saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import {
  buildConceptUserPrompt,
  buildReviewUserText,
  buildSectionEditPrompt,
  buildSectionFixPrompt,
} from "@tawd/core/mockups";
import { LIKED_SITES_JOB } from "@tawd/core/queue";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import { answerBrandGuideSuggestion, loadBrandGuide, readBrandGuide } from "@/lib/brand-guide";
import { loadLikedShots, syncLikedSites } from "@/lib/liked-sites";
import { setQueueForTesting } from "@/lib/mockups";
import { createProject } from "@/lib/projects";
import { BrandGuideSuggestions } from "@/components/intake/brand-guide-suggestions";

import { isPrivateAddress, refusePrivate, runLikedSitesJob, setLookupForTesting } from "../../../worker/src/liked-sites";
import { loadProjectContext } from "../../../worker/src/pipeline";
import type { WorkerConfig } from "../../../worker/src/config";

import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2, fakeBrowser } from "./worker-fakes";

let h: Harness;
let r2: FakeR2;
let queued: { name: string; data: unknown }[];

const config: WorkerConfig = {
  databaseUrl: "unused",
  redisUrl: "unused",
  anthropicApiKey: "unused",
  model: "claude-opus-5-5",
  skillsDir: path.resolve(__dirname, "../../../../skills"),
  effort: "high",
};

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  r2 = new FakeR2();
  setStorageForTesting(r2);
  queued = [];
  setQueueForTesting({ add: async (name, data) => void queued.push({ name, data }), getJob: async () => null });
  // Host names become public addresses, except the ones a test names.
  setLookupForTesting(async (host) => (host.includes("internal-trap") ? ["10.0.0.5"] : ["93.184.216.34"]));
});

afterEach(async () => {
  setLookupForTesting(null);
  setQueueForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

async function project() {
  const admin = await seedAdmin(h);
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
  return { admin, projectId };
}

/* A one-page PDF with these lines of text, as a brand guide would have. */
function makePdf(lines: string[]): Buffer {
  const esc = (t: string) => t.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = "BT /F1 12 Tf 50 750 Td 16 TL " + lines.map((l) => `(${esc(l)}) Tj T*`).join(" ") + " ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

async function uploadGuide(projectId: string, pdf: Buffer, fileName = "rowan-brand-guide.pdf") {
  const [file] = await h.db
    .insert(intakeFile)
    .values({ projectId, kind: "brand_guide", storageKey: `projects/${projectId}/intake/${fileName}`, fileName, contentType: "application/pdf", status: "ready" })
    .returning();
  r2.objects.set(file!.storageKey, pdf);
  return file!;
}

/* ---------- notes for the designer ---------- */

describe("notes for the designer reach every paid step", () => {
  const NOTE = "Keep it calm and rural; the client hates stock photos of smiling plumbers.";

  it("go into the build, the fixes, the edits, the Creative Director review and the Option B steps", () => {
    const intake = emptyIntake();
    intake.photos.notes = NOTE;
    const concept = buildConceptUserPrompt({
      brief: { skillId: "impeccable", direction: "modern_clean", conceptLabel: "A" },
      project: { clientName: "Example", trade: "well_and_pump", tier: "starter" },
      intake,
      assets: [],
      facts: [],
    });
    const prompts = [
      concept,
      buildSectionFixPrompt({ clientName: "M", directionLabel: "d", sections: [], issues: [], factsKnown: "-", round: 1, totalRounds: 2, designerNotes: NOTE }),
      buildSectionEditPrompt({ kind: "changes", clientName: "M", directionLabel: "d", request: "r", sections: [], factsKnown: "-", designerNotes: NOTE }),
      buildReviewUserText({ pass: "first", concepts: [], factsKnown: "-", factsMissing: "-", designerNotes: NOTE }),
      buildImproveSectionText({ clientName: "M", tradeLabel: "t", section: { number: 1, name: "Hero" }, totalSections: 1, html: "<section></section>", css: "", fixes: [], factsKnown: "-", designerNotes: NOTE }),
      buildRescoreText({ clientName: "M", tradeLabel: "t", frameName: "Home", changes: [], notApplied: [], designerNotes: NOTE }),
      buildUndoSectionText({ section: { number: 1, name: "Hero" }, html: "<section></section>", undo: [], keep: [], designerNotes: NOTE }),
      buildDesignReviewText({ clientName: "M", tradeLabel: "t", frameName: "Home", frameWidth: 1440, frameHeight: 900, layers: "", factsConfirmed: "", factsUnconfirmed: "", factsMissing: "", designerNotes: NOTE }),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain("# The team's notes for the designer");
      expect(prompt).toContain(NOTE);
    }
    // Nothing when there are none.
    expect(buildSectionEditPrompt({ kind: "changes", clientName: "M", directionLabel: "d", request: "r", sections: [], factsKnown: "-" })).not.toContain(
      "notes for the designer",
    );
  });
});

/* ---------- the brand guide ---------- */

describe("reading a brand guide's text", () => {
  it("finds colours with their names, fonts on lines about type, and logo rules", () => {
    const reading = readBrandGuideText(
      [
        "Example Well & Pump brand guidelines",
        "Colour palette",
        "Primary Navy #1F4E79",
        "Accent Orange HEX C8551B",
        "Sky RGB 143, 182, 217",
        "Typography",
        "Headings: Montserrat Bold. Body copy: Open Sans.",
        "Play the logo on a clean background. Do not stretch or rotate the logo.",
        "Keep a clear space around the logo equal to the height of the drop.",
        "Our team loves to play outdoors.",
      ].join("\n"),
    );
    expect(reading.colors).toEqual([
      { hex: "#1F4E79", name: "Primary Navy" },
      { hex: "#C8551B", name: "Accent Orange" },
      { hex: "#8FB6D9", name: "Sky" },
    ]);
    expect(reading.fonts).toEqual(["Montserrat", "Open Sans"]);
    expect(reading.logoRules).toEqual([
      "Play the logo on a clean background.",
      "Do not stretch or rotate the logo.",
      "Keep a clear space around the logo equal to the height of the drop.",
    ]);
  });
});

describe("the brand guide in the intake", () => {
  it("is read once from the PDF, offered as suggestions, and each answer is logged; a logo rule goes to the notes", async () => {
    const { admin, projectId } = await project();
    const file = await uploadGuide(projectId, makePdf(["Primary Navy #1F4E79", "Typography: Montserrat for headings", "Do not stretch the logo."]));
    await readBrandGuide(h.db, file.id);

    let view = (await loadBrandGuide(h.db, projectId))!;
    expect(view.readings).toEqual([{ fileName: "rowan-brand-guide.pdf", tone: "done", line: "Found 1 colour, 1 font, 1 logo rule." }]);
    expect(view.colors.map((c) => [c.hex, c.name])).toEqual([["#1F4E79", "Primary Navy"]]);
    expect(view.fonts.map((f) => f.name)).toEqual(["Montserrat"]);

    await saveIntakeSection(h.ctx, admin.viewer, projectId, "photos", { notes: "Calm and rural." });
    await answerBrandGuideSuggestion(h.ctx, admin.viewer, projectId, view.logoRules[0]!.readingId, view.logoRules[0]!.key, "used");
    await answerBrandGuideSuggestion(h.ctx, admin.viewer, projectId, view.colors[0]!.readingId, view.colors[0]!.key, "dismissed");
    const intake = await loadIntake(h.db, SYSTEM_ACTOR, projectId);
    expect(intake!.data.photos.notes).toBe("Calm and rural.\nLogo rule (from the brand guide): Do not stretch the logo.");
    view = (await loadBrandGuide(h.db, projectId))!;
    expect(view.colors).toEqual([]);
    expect(view.logoRules).toEqual([]);
    expect(view.fonts).toHaveLength(1);
    const logs = await h.db.select().from(activityLog).where(eq(activityLog.action, "intake.brand_guide_suggestion"));
    expect(logs.map((l) => (l.valueAfter as { outcome: string }).outcome).sort()).toEqual(["dismissed", "used"]);
  });

  it("says when a guide has no text (a scan) and what reading it by AI would cost, without doing it", async () => {
    const { projectId } = await project();
    const file = await uploadGuide(projectId, makePdf([]), "scanned-guide.pdf");
    await readBrandGuide(h.db, file.id);
    const [row] = await h.db.select().from(brandGuideReading);
    expect(row!.status).toBe("no_text");
    const view = (await loadBrandGuide(h.db, projectId))!;
    expect(view.readings[0]!.line).toMatch(/^No text to read: it looks like a scan\. Reading its 1 page by AI would cost about \$\d+\.\d\d; not done\.$/);
  });

  it("shows the suggestions with Use and Dismiss", () => {
    const html = renderToStaticMarkup(
      <BrandGuideSuggestions
        projectId="p1"
        canEdit
        onUseColor={() => {}}
        onUseFont={() => {}}
        view={{
          readings: [{ fileName: "guide.pdf", tone: "done", line: "Found 1 colour, 1 font, 1 logo rule." }],
          colors: [{ readingId: "r", key: "color:#1F4E79", hex: "#1F4E79", name: "Primary Navy" }],
          fonts: [{ readingId: "r", key: "font:Montserrat", name: "Montserrat" }],
          logoRules: [{ readingId: "r", key: "rule:0", index: 0, text: "Do not stretch the logo." }],
        }}
      />,
    );
    expect(html).toContain("From the brand guide");
    expect(html).toContain("Primary Navy <strong>#1F4E79</strong>");
    expect(html).toContain("Add to notes for the designer");
    expect(html.match(/>Dismiss</g)).toHaveLength(3);
  });
});

/* ---------- websites they like ---------- */

describe("never opening a private address", () => {
  it("refuses localhost, private and link-local addresses, other protocols, and names that lead inside", async () => {
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("172.20.0.1")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(await refusePrivate("http://localhost:3000")).toMatch(/private network/);
    expect(await refusePrivate("http://169.254.169.254/latest/meta-data")).toMatch(/private network/);
    expect(await refusePrivate("https://internal-trap.example.com")).toMatch(/private network/);
    expect(await refusePrivate("ftp://example.com")).toBe("Only http and https addresses are opened.");
    expect(await refusePrivate("https://www.rotorooter.com")).toBeNull();
  });
});

describe("websites they like", () => {
  it("get a screenshot each after the Website section is saved, and lose it when taken off the list", async () => {
    const { admin, projectId } = await project();
    await saveIntakeSection(h.ctx, admin.viewer, projectId, "website", { likedWebsites: ["https://www.rotorooter.com", "http://internal-trap.local"] });
    await syncLikedSites(h.ctx, projectId);
    expect(queued.map((q) => q.name)).toEqual([LIKED_SITES_JOB]);

    await runLikedSitesJob({ projectId }, fakeBrowser());
    const shots = await loadLikedShots(h.db, projectId);
    expect(shots.find((s) => s.url === "https://www.rotorooter.com")).toMatchObject({ status: "done" });
    expect(shots.find((s) => s.url === "http://internal-trap.local")).toMatchObject({
      status: "failed",
      failureReason: "That address points at a private network, so it isn't opened.",
    });
    const [done] = await h.db.select().from(likedSiteShot).where(eq(likedSiteShot.status, "done"));
    expect(r2.objects.has(done!.imageKey!)).toBe(true);

    await saveIntakeSection(h.ctx, admin.viewer, projectId, "website", { likedWebsites: [] });
    await syncLikedSites(h.ctx, projectId);
    expect(await h.db.select().from(likedSiteShot)).toHaveLength(0);
    expect(r2.objects.has(done!.imageKey!)).toBe(false);
  });

  it("go to the mockup builder as pictures, with the instruction never to copy them", async () => {
    const { admin, projectId } = await project();
    await saveIntakeSection(h.ctx, admin.viewer, projectId, "website", { likedWebsites: ["https://www.rotorooter.com"] });
    await syncLikedSites(h.ctx, projectId);
    await runLikedSitesJob({ projectId }, fakeBrowser());
    const [run] = await h.db
      .insert(mockupRun)
      .values({ projectId, conceptCount: 1, status: "running", model: "claude-opus-5-5" })
      .returning();
    const context = await loadProjectContext(h.db as never, r2 as never, fakeBrowser(), config, { projectId, runId: run!.id });
    expect(context.likedSites.map((s) => s.url)).toEqual(["https://www.rotorooter.com"]);
    const prompt = buildConceptUserPrompt({
      brief: { skillId: "impeccable", direction: "modern_clean", conceptLabel: "A" },
      project: { clientName: "Example", trade: "well_and_pump", tier: "starter" },
      intake: emptyIntake(),
      assets: [],
      facts: [],
      likedSites: context.likedSites.map((s) => s.url),
    });
    expect(prompt).toContain("# Websites the client likes (inspiration only)");
    expect(prompt).toContain("Never copy them");
  });
});
