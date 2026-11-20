import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Two blockers from the screens review (Jason, 29 September 2026; built
  30 September): the web designer can change the intake's Design section,
  and a PM or an admin can resume a paused project, logged.
*/

const state: { user: unknown } = { user: null };
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/projects",
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("@/lib/session", () => ({ requireUser: async () => state.user }));

import { and, eq } from "drizzle-orm";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setDbForTesting, type Database } from "@tawd/core/db";
import { confirmUpload, removeFile, requestUpload } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { can } from "@tawd/core/permissions";
import { activityLog, goLive, intakeFile, project as projectTable } from "@tawd/core/schema";
import ProjectPage from "@/app/(app)/projects/[id]/page";
import { saveFigmaLink } from "@/lib/figma";
import { createProject, updateProject } from "@/lib/projects";
import { lastPause, pauseProject, planResume, resumeProject } from "@/lib/resume";
import { describeChanges } from "@/lib/timeline-text";
import { PermissionError } from "@tawd/core/permissions";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

let h: Harness;
let storage: FakeR2;
beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  storage = new FakeR2();
  setStorageForTesting(storage);
});
afterEach(async () => {
  state.user = null;
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

const members: string[] = [];
const lane2 = { clientName: "Nora Beagle Site", trade: "home_services", tier: "starter", lane: "lane_2", laneOption: "a", conceptCount: null, status: "intake" } as const;

async function seed() {
  const admin = await seedAdmin(h);
  const pm = await seedUser(h, admin.viewer, { email: "priya@velocitymedialab.com", name: "Priya Nair", roles: ["pm"] });
  const designer = await seedUser(h, admin.viewer, { email: "dan@velocitymedialab.com", name: "Dan Ortiz", roles: ["web_designer"] });
  const writer = await seedUser(h, admin.viewer, { email: "mei@velocitymedialab.com", name: "Mei Chen", roles: ["content"] });
  members.splice(0, members.length, pm.viewer.id, designer.viewer.id);
  const id = await createProject(h.ctx, admin.viewer, { ...lane2, memberUserIds: [...members] });
  // Answered, so Design and Generate aren't blocked (the current website rule, 30 September 2026).
  await saveIntakeSection(h.ctx, admin.viewer, id, "website", { noCurrentWebsite: true });
  return { admin, pm, designer, writer, id };
}

async function upload(actor: Parameters<typeof requestUpload>[1], id: string, kind: "design_file" | "logo", name: string, type: string) {
  const ticket = await requestUpload(h.ctx, actor, id, kind, name, type, 1000);
  // A picture's bytes start as a real one does: the stand-in storage keeps no type, so confirmUpload reads them (CodeRabbit on PR #75).
  const body = Buffer.alloc(1000);
  if (type === "image/png") Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(body);
  if (type === "application/pdf") Buffer.from("%PDF-1.7\n").copy(body);
  await storage.put(ticket.uploadUrl, body);
  await confirmUpload(h.ctx, actor, ticket.fileId);
  return ticket.fileId;
}

describe("the web designer and the intake's Design section", () => {
  it("the Design section is for PMs, web designers and admins; the rest of the intake stays with PMs", async () => {
    const { admin, pm, designer, writer } = await seed();
    expect([admin, pm, designer, writer].map((p) => can(p.viewer, "intake.design"))).toEqual([true, true, true, false]);
    expect(can(designer.viewer, "intake.edit")).toBe(false);
  });

  it("a designer uploads and removes the design, and links Figma, but not a logo", async () => {
    const { designer, pm, id } = await seed();
    const fileId = await upload(designer.viewer, id, "design_file", "design.pdf", "application/pdf");
    const [row] = await h.db.select().from(intakeFile).where(eq(intakeFile.id, fileId));
    expect(row).toMatchObject({ kind: "design_file", status: "ready" });

    await expect(requestUpload(h.ctx, designer.viewer, id, "logo", "logo.png", "image/png", 1000)).rejects.toThrow(/intake\.edit/);
    const logo = await upload(pm.viewer, id, "logo", "logo.png", "image/png");
    await expect(removeFile(h.ctx, designer.viewer, logo)).rejects.toThrow(/intake\.edit/);

    await removeFile(h.ctx, designer.viewer, fileId);
    expect(await h.db.select().from(intakeFile).where(eq(intakeFile.id, fileId))).toHaveLength(0);

    await h.db.update(projectTable).set({ laneOption: "b" }).where(eq(projectTable.id, id));
    // Refused for the link, not for who is asking.
    const refused = await saveFigmaLink(h.ctx, designer.viewer, id, "not a link").then(() => null, (e: unknown) => e);
    expect(refused).not.toBeInstanceOf(PermissionError);
  });

  it("the content team can't change the design", async () => {
    const { writer, id } = await seed();
    await expect(requestUpload(h.ctx, writer.viewer, id, "design_file", "design.pdf", "application/pdf", 1000)).rejects.toThrow(/Not allowed/);
  });
});

const input = (status: string) => ({ ...lane2, status, memberUserIds: members });

describe("Resume project", () => {
  it("goes back to the stage it was paused at, logged with the note", async () => {
    const { admin, pm, id } = await seed();
    await updateProject(h.ctx, admin.viewer, id, input("mockups") as never, { continueWithoutMissing: true });
    await updateProject(h.ctx, admin.viewer, id, input("paused") as never);
    expect(await planResume(h.db as Database, id)).toEqual({ to: "mockups", known: true });

    expect(await resumeProject(h.ctx, pm.viewer, id, "The client paid.")).toBe("mockups");
    const [row] = await h.db.select().from(projectTable).where(eq(projectTable.id, id));
    expect(row!.status).toBe("mockups");
    const [entry] = await h.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, id), eq(activityLog.action, "project.status_changed")))
      .orderBy(activityLog.seq)
      .then((rows) => rows.slice(-1));
    expect(entry!.valueAfter).toEqual({ status: "mockups", resumed: true, note: "The client paid." });
    expect(describeChanges(entry!.action, entry!.valueBefore, entry!.valueAfter, new Map())).toEqual(["Resumed: Paused to Design", "Note: The client paid."]);
  });

  it("PMs and admins only; only a paused project; back to Intake when the log doesn't say", async () => {
    const { designer, pm, id } = await seed();
    await expect(resumeProject(h.ctx, designer.viewer, id)).rejects.toThrow(/Not allowed/);
    await expect(resumeProject(h.ctx, pm.viewer, id)).rejects.toThrow("This project isn't paused.");
    await h.db.update(projectTable).set({ status: "paused" }).where(eq(projectTable.id, id));
    expect(await planResume(h.db as Database, id)).toEqual({ to: "intake", known: false });
    expect(await resumeProject(h.ctx, pm.viewer, id)).toBe("intake");
  });

  it("a project paused while live goes back to Live only if it really went live", async () => {
    const { admin, id } = await seed();
    await h.db.update(projectTable).set({ status: "live" }).where(eq(projectTable.id, id));
    await updateProject(h.ctx, admin.viewer, id, input("paused") as never);
    expect((await planResume(h.db as Database, id)).to).toBe("build");
    await h.db.insert(goLive).values({ projectId: id, wentLiveAt: new Date() } as never);
    expect((await planResume(h.db as Database, id)).to).toBe("live");
  });

  it("the paused project's Next step card has Resume project for a PM, and says who can for others", async () => {
    const { admin, pm, designer, id } = await seed();
    await updateProject(h.ctx, admin.viewer, id, input("mockups") as never, { continueWithoutMissing: true });
    await updateProject(h.ctx, admin.viewer, id, input("paused") as never);
    const render = async () => renderToStaticMarkup((await ProjectPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })) as React.ReactElement);
    state.user = pm.viewer;
    const html = await render();
    expect(html).toContain("This project is paused");
    expect(html).toContain("Resume project");
    state.user = designer.viewer;
    const other = await render();
    expect(other).not.toContain("Resume project</button>");
    expect(other).toContain("A PM or an admin can resume it.");
  });
});

describe("Pause project", () => {
  it("a PM pauses with a reason; it is logged, shown on the card, and Resume takes it back", async () => {
    const { admin, pm, id } = await seed();
    await updateProject(h.ctx, admin.viewer, id, input("mockups") as never, { continueWithoutMissing: true });
    await expect(pauseProject(h.ctx, pm.viewer, id, "too short")).rejects.toThrow(/at least 10 characters/);
    await pauseProject(h.ctx, pm.viewer, id, "Waiting for the client's deposit.");
    const [row] = await h.db.select().from(projectTable).where(eq(projectTable.id, id));
    expect(row!.status).toBe("paused");
    expect(await lastPause(h.db as Database, id)).toMatchObject({ by: "Priya Nair", reason: "Waiting for the client's deposit." });
    await expect(pauseProject(h.ctx, pm.viewer, id, "Paused a second time")).rejects.toThrow("already paused");
    expect(await planResume(h.db as Database, id)).toEqual({ to: "mockups", known: true });

    state.user = pm.viewer;
    const html = renderToStaticMarkup((await ProjectPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })) as React.ReactElement);
    expect(html).toContain("Paused by Priya Nair");
    expect(html).toContain("Waiting for the client&#x27;s deposit.");
    const [entry] = (await h.db.select().from(activityLog).where(and(eq(activityLog.entityId, id), eq(activityLog.action, "project.status_changed"))).orderBy(activityLog.seq)).slice(-1);
    expect(describeChanges(entry!.action, entry!.valueBefore, entry!.valueAfter, new Map())).toEqual(["Design to Paused", "Reason: Waiting for the client's deposit."]);
  });

  it("PMs and admins only; the Settings tab shows the card, with the button only for them", async () => {
    const { designer, pm, id } = await seed();
    await expect(pauseProject(h.ctx, designer.viewer, id, "Waiting for the client's deposit.")).rejects.toThrow(/Not allowed/);
    const settings = async () => renderToStaticMarkup((await ProjectPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ tab: "settings" }) })) as React.ReactElement);
    state.user = pm.viewer;
    expect(await settings()).toContain("Pause project</button>");
    state.user = designer.viewer;
    const other = await settings();
    expect(other).toContain("Pause the project");
    expect(other).toContain("A PM or an admin can pause it.");
    expect(other).not.toContain("Pause project</button>");
  });
});
