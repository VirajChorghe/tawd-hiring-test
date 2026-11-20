import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  New project, Edit project, and the 404 and error pages.

  The form never sends a stage: a new project starts at Intake and opens its
  intake straight away, and editing keeps whatever stage the project is at.
*/

const state: { user: unknown; ctx: unknown } = { user: null, ctx: null };

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/projects",
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/session", () => ({
  requireUser: async () => state.user,
  requireUserPendingPasswordChange: async () => state.user,
}));
vi.mock("@/lib/server-context", () => ({ getServiceContext: async () => state.ctx }));

import { eq } from "drizzle-orm";
import { project as projectTable } from "@tawd/core/schema";
import { createProjectAction, updateProjectAction } from "@/app/actions";
import ErrorPage from "@/app/error";
import NotFound from "@/app/not-found";
import { ProjectForm } from "@/components/project-form";
import { emptyActionState } from "@/lib/action-state";
import { createProject } from "@/lib/projects";
import { createHarness, seedAdmin, type Harness } from "./harness";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
  const admin = await seedAdmin(h);
  state.user = admin.viewer;
  state.ctx = h.ctx;
});

afterEach(async () => {
  await h.close();
});

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const basics = {
  clientName: "Dale Rowan",
  trade: "well_and_pump",
  tier: "starter",
  lane: "lane_1",
  laneOption: "",
  conceptCount: "3",
};

async function redirectOf(run: Promise<unknown>): Promise<string> {
  const error = await run.then(
    () => null,
    (e: Error) => e,
  );
  return String(error?.message ?? "").replace(/^redirect /, "");
}

describe("New project", () => {
  it("starts at Intake, whatever the form sends, and opens the intake", async () => {
    const to = await redirectOf(
      createProjectAction(emptyActionState, form({ ...basics, status: "live" })),
    );
    expect(to).toMatch(/^\/projects\/[\w-]+\/intake$/);

    const id = to.split("/")[2]!;
    const [row] = await h.db.select().from(projectTable).where(eq(projectTable.id, id));
    expect(row!.status).toBe("intake");
  });

  it("Lane 2 Option A needs no concept count", async () => {
    const to = await redirectOf(
      createProjectAction(
        emptyActionState,
        form({ ...basics, lane: "lane_2", laneOption: "a", conceptCount: "" }),
      ),
    );
    expect(to).toMatch(/\/intake$/);
  });

  it("shows no stage field, and three concepts for Lane 1 by default", () => {
    const html = renderToStaticMarkup(
      <ProjectForm
        action={async () => emptyActionState}
        assignable={[{ id: "u1", name: "Dee Morgan", email: "dee@x.com", roles: ["web_designer"] }]}
        submitLabel="Create project and open intake"
        cancelHref="/projects"
      />,
    );
    expect(html).not.toMatch(/name="status"/);
    expect(html).toMatch(/Up to 10 pages/);
    expect(html).toMatch(/11 to 20 pages/);
    expect(html).toMatch(/21 to 50 pages/);
    expect(html).toMatch(/<input type="hidden" name="conceptCount" value="3"/);
    expect(html).toMatch(/Web Designer/);
  });
});

describe("Edit project", () => {
  it("changes the details but keeps the stage", async () => {
    const id = await createProject(h.ctx, state.user as never, {
      clientName: "Dale Rowan",
      trade: "well_and_pump",
      tier: "starter",
      lane: "lane_1",
      laneOption: null,
      conceptCount: 3,
      status: "intake",
      memberUserIds: [],
    });
    await h.db.update(projectTable).set({ status: "mockups" }).where(eq(projectTable.id, id));

    const to = await redirectOf(
      updateProjectAction(id, emptyActionState, form({ ...basics, tier: "growth", status: "live" })),
    );
    expect(to).toBe(`/projects/${id}`);

    const [row] = await h.db.select().from(projectTable).where(eq(projectTable.id, id));
    expect(row!.tier).toBe("growth");
    expect(row!.status).toBe("mockups");
  });
});

describe("404 and error pages", () => {
  it("404: the logo, one sentence and a way back to Projects", () => {
    const html = renderToStaticMarkup(<NotFound />);
    expect(html).toMatch(/tawd-logo/);
    expect(html).toMatch(/Page not found/);
    expect(html).toMatch(/href="\/projects"/);
  });

  it("error: try again, back to Projects, and a reference for an admin", () => {
    const html = renderToStaticMarkup(
      <ErrorPage error={Object.assign(new Error("boom"), { digest: "123456" })} reset={() => {}} />,
    );
    expect(html).toMatch(/Something went wrong/);
    expect(html).toMatch(/Try again/);
    expect(html).toMatch(/href="\/projects"/);
    expect(html).toMatch(/123456/);
    expect(html).not.toMatch(/boom/);
  });
});
