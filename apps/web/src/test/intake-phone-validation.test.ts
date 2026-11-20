import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assessCompleteness, emptyIntake, parseIntake, type CompletenessInput } from "@tawd/core/intake";
import { IntakeError, saveIntakeSection } from "@tawd/core/intake/service";
import { projectIntake } from "@tawd/core/schema";
import { intakePhones } from "@tawd/core/mockups";
import { phoneProblem } from "@tawd/core/site";
import { createProject } from "@/lib/projects";
import { createHarness, seedAdmin, type Harness } from "./harness";

/* F-035: the phone field used to accept anything, and the text went to the model as a fact. */

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

const lane1 = {
  clientName: "Sacramento Drain Pros",
  trade: "plumbing" as const,
  tier: "starter" as const,
  lane: "lane_1" as const,
  laneOption: null,
  conceptCount: 3,
  status: "intake" as const,
  memberUserIds: [] as string[],
};

describe("phoneProblem", () => {
  it("accepts 10 digits, or 11 starting with 1, however formatted", () => {
    for (const ok of ["916-555-0142", "(916) 555-0142", "+1 916 555 0142", "19165550142", "916.555.0142 ext. 12", ""]) {
      expect(phoneProblem(ok), ok).toBeNull();
    }
  });
  it("refuses words, short and long numbers with a plain message", () => {
    for (const bad of ["call us", "call us maybe", "555", "12345678901234", "29165550142"]) {
      expect(phoneProblem(bad), bad).toMatch(/is not a US phone number\. Enter 10 digits/);
    }
  });
});

describe("saving the business phone", () => {
  it("refuses 'call us', '555' and a 14-digit string, and writes nothing", async () => {
    const admin = await seedAdmin(h);
    const projectId = await createProject(h.ctx, admin.viewer, lane1);
    for (const bad of ["call us", "555", "12345678901234"]) {
      await expect(saveIntakeSection(h.ctx, admin.viewer, projectId, "business", { name: "X", phone: bad })).rejects.toThrow(IntakeError);
    }
    expect(await h.db.select().from(projectIntake)).toHaveLength(0);
  });

  it("refuses a bad location phone", async () => {
    const admin = await seedAdmin(h);
    const projectId = await createProject(h.ctx, admin.viewer, lane1);
    await expect(
      saveIntakeSection(h.ctx, admin.viewer, projectId, "business", { name: "X", phone: "916-555-0142", locations: [{ name: "Bishop", phone: "soon" }] }),
    ).rejects.toThrow(/not a US phone number/);
  });

  it("saves a good number in the standard format", async () => {
    const admin = await seedAdmin(h);
    const projectId = await createProject(h.ctx, admin.viewer, lane1);
    await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", { name: "X", phone: "916.555.0142" });
    const [row] = await h.db.select().from(projectIntake);
    expect((row!.data as { business: { phone: string } }).business.phone).toBe("(916) 555-0142");
  });

  it("lets an old stored bad value be saved again unchanged, and does not wipe it on load", async () => {
    const admin = await seedAdmin(h);
    const projectId = await createProject(h.ctx, admin.viewer, lane1);
    await h.db.insert(projectIntake).values({ projectId, data: { business: { name: "X", phone: "call us maybe", email: "a@b.co" } } });
    const loaded = parseIntake((await h.db.select().from(projectIntake))[0]!.data);
    expect(loaded.business.phone).toBe("call us maybe");
    expect(loaded.business.email).toBe("a@b.co");
    // Saving the same section with the same bad phone and another edit is not blocked.
    await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", { name: "X", phone: "call us maybe", email: "c@d.co" });
    // Changing it to another bad value is.
    await expect(saveIntakeSection(h.ctx, admin.viewer, projectId, "business", { name: "X", phone: "call us" })).rejects.toThrow(IntakeError);
  });
});

describe("a stored bad phone is a problem, not a fact", () => {
  const bad = parseIntake({ business: { name: "X", phone: "call us maybe", locations: [{ name: "B", phone: "555" }] } });
  it("is reported as missing in completeness", () => {
    const input: CompletenessInput = { projectTrade: "plumbing", intake: bad, files: [] };
    expect(assessCompleteness(input).missing.map((m) => m.key)).toContain("business.phone");
    const good: CompletenessInput = { projectTrade: "plumbing", intake: parseIntake({ business: { name: "X", phone: "916-555-0142" } }), files: [] };
    expect(assessCompleteness(good).missing.map((m) => m.key)).not.toContain("business.phone");
  });
  it("is not passed to prompts by intakePhones", () => {
    expect(intakePhones(bad)).toEqual([]);
    expect(intakePhones(parseIntake({ business: { phone: "916-555-0142", locations: [{ phone: "x" }, { phone: "760-555-0199" }] } }))).toEqual(["(916) 555-0142", "(760) 555-0199"]);
    expect(emptyIntake().business.phone).toBe("");
  });
});
