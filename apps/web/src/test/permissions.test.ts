import { describe, expect, it } from "vitest";

import { teamRoles } from "@tawd/core/schema";
import { PermissionError, assertCan, can, permissions } from "@tawd/core/permissions";
import { viewer } from "./harness";

/*
  The permission matrix, checked role by role rather than by spot-checking a
  few cases. If someone adds a role or a permission and forgets the rules,
  these tests say so.
*/

describe("what each team role can do", () => {
  const expected: Record<string, string[]> = {
    // The founders record the build fee too (Jason, 29 September 2026).
    founder: ["project.view", "intake.view", "site.golive", "golive.fee", "site.review_pages"],
    pm: [
      "project.view",
      "project.create",
      "project.edit",
      "project.change_status",
      "project.assign_members",
      "intake.view",
      "intake.edit",
      "intake.design",
      "seo.research",
      "content.plan",
      // The page review (3 October 2026): PMs, the Web Designer and founders approve pages.
      "site.review_pages",
    ],
    // The Web Designer decides on the tracked changes to a designer's design (4c-2), and changes the intake's Design section (30 September 2026).
    web_designer: ["project.view", "intake.view", "intake.design", "design.decide", "site.review_pages"],
    // Keyword research and the page plan (7a): SEO both, Content the plan only.
    seo: ["project.view", "intake.view", "seo.research", "content.plan", "seo.signoff"],
    content: ["project.view", "intake.view", "content.plan", "content.approve"],
  };

  for (const role of teamRoles) {
    it(`grants a ${role} exactly the expected permissions`, () => {
      const person = viewer({ roles: [role] });
      const granted = permissions.filter((p) => can(person, p));
      expect(granted.sort()).toEqual([...expected[role]!].sort());
    });
  }

  it("gives somebody with no role read access only", () => {
    const person = viewer({ roles: [] });
    expect(permissions.filter((p) => can(person, p)).sort()).toEqual([
      "intake.view",
      "project.view",
    ]);
  });

  it("combines roles rather than picking one", () => {
    const person = viewer({ roles: ["content", "pm"] });
    expect(can(person, "project.create")).toBe(true);
    expect(can(person, "intake.edit")).toBe(true);
    expect(can(person, "user.manage")).toBe(false);
  });
});

describe("the admin switch", () => {
  it("is separate from the team roles", () => {
    const founder = viewer({ roles: ["founder"] });
    expect(can(founder, "user.manage")).toBe(false);

    const adminWithNoRole = viewer({ isAdmin: true, roles: [] });
    expect(can(adminWithNoRole, "user.manage")).toBe(true);
  });

  it("lets an admin manage users and read the whole log", () => {
    const admin = viewer({ isAdmin: true });
    expect(can(admin, "user.manage")).toBe(true);
    expect(can(admin, "activity.view_all")).toBe(true);
  });

  it("keeps the full log away from everybody else", () => {
    for (const role of teamRoles) {
      expect(can(viewer({ roles: [role] }), "activity.view_all")).toBe(false);
    }
  });

  it("also lets an admin run projects without holding the PM role", () => {
    const admin = viewer({ isAdmin: true, roles: [] });
    expect(can(admin, "project.create")).toBe(true);
    expect(can(admin, "project.change_status")).toBe(true);
    expect(can(admin, "intake.edit")).toBe(true);
  });

  /*
    Overriding the intake gate is the one thing a PM cannot do, so that
    nobody can wave their own project past its own requirements.
  */
  it("reserves the intake gate override for admins", () => {
    expect(can(viewer({ isAdmin: true }), "intake.override_gate")).toBe(true);

    for (const role of teamRoles) {
      expect(can(viewer({ roles: [role] }), "intake.override_gate")).toBe(false);
    }
  });
});

describe("a disabled account", () => {
  it("can do nothing at all, whatever it holds", () => {
    const disabledAdmin = viewer({
      isAdmin: true,
      isDisabled: true,
      roles: ["pm", "founder"],
    });

    for (const permission of permissions) {
      expect(can(disabledAdmin, permission)).toBe(false);
    }
  });

  it("cannot even read projects", () => {
    expect(can(viewer({ isDisabled: true }), "project.view")).toBe(false);
  });
});

describe("assertCan", () => {
  it("passes silently when allowed", () => {
    expect(() => assertCan(viewer({ isAdmin: true }), "user.manage")).not.toThrow();
  });

  it("throws a PermissionError naming the permission when not", () => {
    try {
      assertCan(viewer(), "user.manage");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PermissionError);
      expect((error as PermissionError).permission).toBe("user.manage");
    }
  });
});
