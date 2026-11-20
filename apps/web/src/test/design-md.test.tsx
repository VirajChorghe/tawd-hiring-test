import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  The client's DESIGN.md (26 September 2026): written from the approved
  mockup when the client approves it (Lane 2: the designer's approved
  Figma design), kept in versions, shown on the project page and given to
  every page build and monthly edit. No AI.
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
import { activityLog, clientDesignDoc, concept, conceptVersion, mockupRun, project as projectTable } from "@tawd/core/schema";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { buildDesignMd, buildSiteSystemPrompt, readDesign } from "@tawd/core/site";
import { makeClientDesignDoc, loadClientDesignDoc } from "@/lib/client-design";
import { recordClientDecision } from "@/lib/concept-review";
import { createProject } from "@/lib/projects";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

let h: Harness;
let r2: FakeR2;

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  r2 = new FakeR2();
  setStorageForTesting(r2);
});

afterEach(async () => {
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

const APPROVED = `<!doctype html><html><head>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@600&family=Inter:wght@400;700&display=swap" rel="stylesheet">
<style>
:root{--brand:#1F4E79;--accent:#E8A33D}
body{font-family:Inter,sans-serif;color:#1d232b;background:#fafaf7;font-size:17px;line-height:1.6}
h1,h2{font-family:"Fraunces",serif;color:var(--brand)}
h1{font-size:52px;font-weight:600}
.btn{background:var(--accent);color:#1d232b;border-radius:999px;padding:14px 22px;font-weight:700}
.card{background:#fff;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.08);padding:24px}
.wrap{max-width:1160px}
section{padding:96px 24px}
.grid{display:grid;gap:24px}
@media (max-width: 760px){h1{font-size:36px}}
</style></head><body><header><a class="btn" href="tel:5305550199">Call</a></header>
<section class="hero"><h1>Clear water, fast</h1></section><section><div class="grid"><div class="card">Wells</div></div></section><footer>Footer</footer></body></html>`;

describe("reading the approved design", () => {
  it("finds the colours and their roles, fonts, sizes, components, spacing, depth and breakpoints", () => {
    const d = readDesign(APPROVED);
    expect(d.roles).toEqual(
      expect.arrayContaining([
        { role: "Page background", value: "#fafaf7" },
        { role: "Body text", value: "#1d232b" },
        { role: "Headings", value: "#1f4e79" },
        { role: "Primary action (buttons, call links)", value: "#e8a33d" },
      ]),
    );
    expect(d.fonts).toEqual([
      { role: "Headings", family: '"Fraunces",serif' },
      { role: "Body", family: "Inter,sans-serif" },
    ]);
    expect(d.googleFonts).toEqual(["Fraunces", "Inter"]);
    expect(d.sizes.find((s) => s.element === "H1")).toMatchObject({ size: "52px", weight: "600" });
    expect(d.radii).toContain("999px");
    expect(d.shadows).toEqual(["0 8px 24px rgba(0,0,0,.08)"]);
    expect(d.maxWidths).toEqual(["1160px"]);
    expect(d.breakpoints).toEqual(["(max-width: 760px)"]);
    expect(d.usesGrid).toBe(true);
  });

  it("writes the standard DESIGN.md sections, with the health rules only for a health business", () => {
    const input = {
      clientName: "Example Well & Pump",
      tradeLabel: "well and pump",
      html: APPROVED,
      direction: { label: "Rugged Craftsman", description: "Earth and steel tones." },
      source: "concept" as const,
      approvedLabel: "Concept B v2",
      moodWords: ["honest"],
      brandLocked: true,
      healthRules: false,
    };
    const md = buildDesignMd(input);
    expect([...md.matchAll(/^## \d+\. (.+)$/gm)].map((m) => m[1])).toEqual([
      "Visual theme and atmosphere",
      "Colour palette and roles",
      "Typography",
      "Component styles",
      "Layout principles",
      "Depth and elevation",
      "Do's and don'ts",
      "Responsive behaviour",
      "Agent guide",
    ]);
    expect(md).toContain("Written by TAWD from the approved mockup (Concept B v2)");
    expect(md).toContain("Primary action (buttons, call links): `#e8a33d`");
    expect(md).toContain("`--brand`: `#1F4E79`");
    expect(md).toContain("brand colours and fonts are locked");
    expect(md).not.toContain("health and beauty rules");
    expect(buildDesignMd({ ...input, healthRules: true, source: "figma", approvedLabel: "the designer's design, v3" })).toMatch(
      /from the designer's approved Figma design \(the designer's design, v3\)[\s\S]*health and beauty rules/,
    );
  });

  it("goes to the site builder, so every page and every edit follows it", () => {
    const system = buildSiteSystemPrompt("profile", { css: "", fontLinks: [], header: "", footer: "", sections: [] }, "", "", "# DESIGN.md: Example");
    expect(system).toContain("<client_design_md>\n# DESIGN.md: Example\n</client_design_md>");
    expect(buildSiteSystemPrompt("profile", { css: "", fontLinks: [], header: "", footer: "", sections: [] }, "")).not.toContain("client_design_md");
  });
});

async function approvable(lane: "lane_1" | "lane_2" = "lane_1", direction = "rugged_craftsman") {
  const admin = await seedAdmin(h);
  const projectId = await createProject(h.ctx, admin.viewer, {
    clientName: "Example Well & Pump",
    trade: "well_and_pump",
    tier: "starter",
    lane,
    laneOption: lane === "lane_2" ? "b" : null,
    conceptCount: 1,
    status: "intake",
    memberUserIds: [],
  });
  await h.db.update(projectTable).set({ status: "mockups" }).where(eq(projectTable.id, projectId));
  await saveIntakeSection(h.ctx, admin.viewer, projectId, "brand", { moodWords: ["honest"] });
  const [run] = await h.db.insert(mockupRun).values({ projectId, conceptCount: 1, status: "succeeded", model: "m", startedByUserId: admin.viewer.id }).returning();
  const [c] = await h.db.insert(concept).values({ runId: run!.id, projectId, label: "A", direction, skillId: "impeccable", status: "ready" }).returning();
  const base = `projects/${projectId}/concepts/${c!.id}/v1`;
  await h.db.insert(conceptVersion).values({ conceptId: c!.id, version: 1, htmlKey: `${base}/page.html` } as never);
  await r2.put(`${base}/source.html`, Buffer.from(APPROVED));
  return { admin, projectId, conceptId: c!.id };
}

describe("writing it when the client approves", () => {
  it("writes version 1 from the approved concept, logs it, and shows it on the project page", async () => {
    const { admin, projectId, conceptId } = await approvable();
    await recordClientDecision(h.ctx, admin.viewer, { conceptId, channel: "phone", changesRequested: false, clientSaid: "A is perfect." });
    const doc = await loadClientDesignDoc(h.db, projectId);
    expect(doc).toMatchObject({ version: 1, source: "concept", conceptVersion: 1 });
    expect(doc!.markdown).toContain("Written by TAWD from the approved mockup (Concept A v1)");
    expect(doc!.markdown).toContain("Direction: **Rugged Craftsman**");
    const actions = (await h.db.select().from(activityLog)).map((l) => l.action);
    expect(actions).toContain("design_md.created");

    state.user = admin.viewer;
    const { default: ProjectPage } = await import("@/app/(app)/projects/[id]/page");
    const html = renderToStaticMarkup(await ProjectPage({ params: Promise.resolve({ id: projectId }) } as never));
    expect(html).toContain("Client DESIGN.md");
    expect(html).toContain("Version 1, from the approved mockup (v1)");
    expect(html).toContain(`/projects/${projectId}/design-md?download=1`);

    const { GET } = await import("@/app/(app)/projects/[id]/design-md/route");
    const response = await GET(new Request(`http://t/projects/${projectId}/design-md?download=1`), { params: Promise.resolve({ id: projectId }) });
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="DESIGN.md"');
    expect(await response.text()).toContain("# DESIGN.md: Example Well & Pump");
  });

  it("takes a Lane 2 project's from the designer's approved Figma design", async () => {
    const { admin, projectId, conceptId } = await approvable("lane_2", "designer");
    await recordClientDecision(h.ctx, admin.viewer, { conceptId, channel: "email", changesRequested: false, clientSaid: "The designer's version, yes." });
    const doc = await loadClientDesignDoc(h.db, projectId);
    expect(doc).toMatchObject({ source: "figma" });
    expect(doc!.markdown).toContain("from the designer's approved Figma design (the designer's design, v1)");
  });

  it("never stops the decision when the design can't be read, and can be written again by a PM", async () => {
    const { admin, projectId, conceptId } = await approvable();
    r2.objects.clear();
    const result = await recordClientDecision(h.ctx, admin.viewer, { conceptId, channel: "phone", changesRequested: false, clientSaid: "A is perfect." });
    expect(result.movedToContent).toBe(true);
    expect(await loadClientDesignDoc(h.db, projectId)).toBeNull();
    expect((await h.db.select().from(activityLog)).map((l) => l.action)).toContain("design_md.failed");

    await r2.put(`projects/${projectId}/concepts/${conceptId}/v1/source.html`, Buffer.from(APPROVED));
    const seo = await seedUser(h, admin.viewer, { email: "seo@velocitymedialab.com", roles: ["seo"] });
    await expect(makeClientDesignDoc(h.ctx, seo.viewer, projectId)).rejects.toThrow();
    expect(await makeClientDesignDoc(h.ctx, admin.viewer, projectId)).toEqual({ version: 1 });
    expect(await makeClientDesignDoc(h.ctx, admin.viewer, projectId)).toEqual({ version: 2 });
    expect(await h.db.select().from(clientDesignDoc).where(eq(clientDesignDoc.projectId, projectId))).toHaveLength(2);
  });
});
