import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Saving a team member (13 October 2026, the whole-code review): the admin
  switch, the name and the roles are one save. A name refused after the
  admin switch changed leaves everything as it was.
*/

const state = vi.hoisted(() => ({ user: null as unknown, ctx: null as unknown }));
vi.mock("@/lib/session", () => ({ requireUser: async () => state.user }));
vi.mock("@/lib/server-context", () => ({ getServiceContext: async () => state.ctx }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { setDbForTesting, type Database } from "@tawd/core/db";
import { user as userTable } from "@tawd/core/schema";
import { updateTeamMemberAction } from "@/app/actions";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  state.ctx = h.ctx;
});

afterEach(async () => {
  state.user = null;
  setDbForTesting(null);
  await h.close();
});

describe("saving a team member", () => {
  it("keeps the admin switch as it was when the name is refused", async () => {
    const admin = await seedAdmin(h);
    state.user = admin.viewer;
    const other = await seedUser(h, admin.viewer, { email: "priya@velocitymedialab.com", name: "Priya Nair", roles: ["pm"], isAdmin: true });

    const refused = await updateTeamMemberAction(other.viewer.id, { name: "   ", roles: ["pm"], isAdmin: false });
    expect(refused).toMatchObject({ ok: false, message: "Enter a name." });
    const [row] = await h.db.select().from(userTable).where(eq(userTable.id, other.viewer.id));
    expect(row).toMatchObject({ name: "Priya Nair", role: "admin" });

    const saved = await updateTeamMemberAction(other.viewer.id, { name: "Priya N.", roles: ["pm", "seo"], isAdmin: false });
    expect(saved).toMatchObject({ ok: true });
    const [after] = await h.db.select().from(userTable).where(eq(userTable.id, other.viewer.id));
    expect(after).toMatchObject({ name: "Priya N.", role: "user" });
  });
});
