import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { customerProject, customerProjects } from "@tawd/core/customer-access";
import { PermissionError, assertCan, can, permissions, type Viewer } from "@tawd/core/permissions";
import { customer, project, projectFlows, teamRoles } from "@tawd/core/schema";
import { createHarness, viewer, type Harness } from "./harness";

/*
  Part 2, task 1 (3 November 2026): customers are kept apart.

  Customer accounts live in their own table, never in the team's `user` table
  (Jason chose separate tables over a "customer" role, for isolation: the two
  front doors never share a login or a session). These tests are the
  "try to open another customer's project" check from WORKING-WITH-JASON.md,
  run against real PostgreSQL with the real migrations.
*/

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.close();
});

async function seedCustomer(name: string, opts: { closed?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await h.db.insert(customer).values({
    id,
    name,
    email: `${name.toLowerCase()}-${id.slice(0, 8)}@example.com`,
    closedAt: opts.closed ? new Date() : null,
  });
  return id;
}

async function seedProject(values: { clientName: string; flow?: string; customerId?: string | null }): Promise<string> {
  const [row] = await h.db
    .insert(project)
    .values({
      clientName: values.clientName,
      trade: "plumbing",
      tier: "starter",
      lane: "lane_1",
      conceptCount: 1,
      ...(values.flow ? { flow: values.flow } : {}),
      ...(values.customerId !== undefined ? { customerId: values.customerId } : {}),
    })
    .returning({ id: project.id });
  return row!.id;
}

/* PostgreSQL's refusal arrives wrapped; the constraint name is on the cause. */
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const e = error as { message?: string; cause?: { message?: string; constraint?: string } };
    return [e.message, e.cause?.message, e.cause?.constraint].filter(Boolean).join(" | ");
  }
  throw new Error("expected the database to refuse this");
}

describe("project flow: team or self-serve", () => {
  it("has exactly two flows", () => {
    expect([...projectFlows]).toEqual(["team", "self_serve"]);
  });

  it("makes every project a team project unless it says otherwise, with no customer", async () => {
    const id = await seedProject({ clientName: "Harbor Plumbing" });
    const [row] = await h.db.select().from(project).where(eq(project.id, id));
    expect(row!.flow).toBe("team");
    expect(row!.customerId).toBeNull();
  });

  it("refuses a self-serve project with no customer", async () => {
    expect(await refusal(seedProject({ clientName: "Orphan", flow: "self_serve" }))).toMatch(/project_flow_customer/);
  });

  it("refuses a team project that has a customer", async () => {
    const a = await seedCustomer("Ana");
    expect(await refusal(seedProject({ clientName: "Mixed", flow: "team", customerId: a }))).toMatch(/project_flow_customer/);
  });

  it("refuses a flow that isn't one of the two", async () => {
    const a = await seedCustomer("Ana");
    expect(await refusal(seedProject({ clientName: "Typo", flow: "selfserve", customerId: a }))).toMatch(/project_flow_customer/);
  });

  it("refuses a second account for the same email in other capitals", async () => {
    await h.db.insert(customer).values({ id: randomUUID(), name: "Ana", email: "ana@example.com" });
    expect(await refusal(h.db.insert(customer).values({ id: randomUUID(), name: "Ana", email: "Ana@Example.com" }))).toMatch(/customer_email_lower_unique/);
  });

  it("refuses to delete a customer who still owns a project", async () => {
    const a = await seedCustomer("Ana");
    await seedProject({ clientName: "Ana's Plumbing", flow: "self_serve", customerId: a });
    expect(await refusal(h.db.delete(customer).where(eq(customer.id, a)))).toMatch(/customer_id|foreign key/i);
  });
});

describe("a customer sees only their own project", () => {
  let ana: string;
  let ben: string;
  let anaProject: string;
  let benProject: string;
  let teamProject: string;

  beforeEach(async () => {
    ana = await seedCustomer("Ana");
    ben = await seedCustomer("Ben");
    anaProject = await seedProject({ clientName: "Ana's Plumbing", flow: "self_serve", customerId: ana });
    benProject = await seedProject({ clientName: "Ben's Roofing", flow: "self_serve", customerId: ben });
    teamProject = await seedProject({ clientName: "Nora Beagle Site" });
  });

  it("gives each customer their own project", async () => {
    expect((await customerProject(h.db, ana, anaProject))?.id).toBe(anaProject);
    expect((await customerProject(h.db, ben, benProject))?.id).toBe(benProject);
  });

  it("never gives a customer another customer's project", async () => {
    expect(await customerProject(h.db, ana, benProject)).toBeNull();
    expect(await customerProject(h.db, ben, anaProject)).toBeNull();
  });

  it("never gives a customer a team project", async () => {
    expect(await customerProject(h.db, ana, teamProject)).toBeNull();
    expect(await customerProject(h.db, ben, teamProject)).toBeNull();
  });

  it("answers the same for someone else's project, a made-up ID and garbage, and never throws", async () => {
    for (const id of [benProject, randomUUID(), "not-a-uuid", "' OR 1=1 --", "", "../../etc/passwd"]) {
      await expect(customerProject(h.db, ana, id)).resolves.toBeNull();
    }
  });

  it("gives nothing to a customer ID that doesn't exist, or to an empty one", async () => {
    expect(await customerProject(h.db, randomUUID(), anaProject)).toBeNull();
    expect(await customerProject(h.db, "", anaProject)).toBeNull();
    expect(await customerProjects(h.db, "")).toEqual([]);
  });

  it("locks a closed account out of its own project at once", async () => {
    await h.db.update(customer).set({ closedAt: new Date() }).where(eq(customer.id, ana));
    expect(await customerProject(h.db, ana, anaProject)).toBeNull();
    expect(await customerProjects(h.db, ana)).toEqual([]);
  });

  it("lists only the customer's own projects", async () => {
    const second = await seedProject({ clientName: "Ana's Second", flow: "self_serve", customerId: ana });
    const ids = (await customerProjects(h.db, ana)).map((p) => p.id).sort();
    expect(ids).toEqual([anaProject, second].sort());
    expect((await customerProjects(h.db, ben)).map((p) => p.id)).toEqual([benProject]);
  });

  it("returns only the fields a customer may see, never the team's internal ones", async () => {
    const seen = await customerProject(h.db, ana, anaProject);
    expect(Object.keys(seen!).sort()).toEqual(["clientName", "createdAt", "id", "status", "tier", "trade"]);
    const listed = await customerProjects(h.db, ana);
    expect(Object.keys(listed[0]!).sort()).toEqual(["clientName", "createdAt", "id", "status", "tier", "trade"]);
  });
});

describe("the team's permissions refuse anything that isn't a team viewer", () => {
  it("every team viewer says so", () => {
    expect(viewer().kind).toBe("team");
  });

  it("denies every permission to a non-team viewer, even one dressed as an admin with every role", () => {
    const impostor = { ...viewer({ isAdmin: true, roles: [...teamRoles] }), kind: "customer" } as unknown as Viewer;
    for (const permission of permissions) {
      expect(can(impostor, permission), permission).toBe(false);
      expect(() => assertCan(impostor, permission)).toThrow(PermissionError);
    }
  });

  it("denies every permission to a viewer with no kind at all (fails closed)", () => {
    const noKind: Partial<Viewer> = viewer({ isAdmin: true, roles: [...teamRoles] });
    delete noKind.kind;
    for (const permission of permissions) {
      expect(can(noKind as Viewer, permission), permission).toBe(false);
    }
  });
});
