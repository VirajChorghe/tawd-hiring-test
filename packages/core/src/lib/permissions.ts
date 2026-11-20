import type { TeamRole } from "@tawd/core/enums";
import { SYSTEM_ACTOR_ID } from "@tawd/core/activity";

/*
  Who can do what.

  Two separate ideas, deliberately kept apart:

  - Team roles (Founder, PM, Web Designer, SEO, Content) describe what
    somebody does. A person can hold several.
  - The admin switch decides who can manage accounts. It is independent of
    team roles: a Founder is not automatically an admin.
*/

export interface Viewer {
  /*
    Always "team": a Viewer is a VML team member, built only from the team's
    `user` table (session.ts) or the system actor. Customers have their own
    table and never become a Viewer (Part 2, task 1, 3 November 2026). can()
    refuses anything that doesn't say "team", so a customer object that ever
    reached a team check by mistake would be denied, not trusted.
  */
  kind: "team";
  id: string;
  email: string;
  isAdmin: boolean;
  isDisabled: boolean;
  roles: TeamRole[];
}

/*
  Used only by scripts/create-admin.ts, which runs on the server with no
  session. It is never reachable from the web interface.
*/
export const SYSTEM_ACTOR: Viewer = {
  kind: "team",
  id: SYSTEM_ACTOR_ID,
  email: "system:create-admin",
  isAdmin: true,
  isDisabled: false,
  roles: [],
};

export const permissions = [
  "project.view",
  "project.create",
  "project.edit",
  "project.change_status",
  "project.assign_members",
  "user.manage",
  "activity.view_all",
  "intake.view",
  "intake.edit",
  // The intake's Design section (Lane 2): the client's design files, the Figma link, reading the design.
  // PMs, web designers and admins (Jason, 29 September 2026).
  "intake.design",
  // Waving an incomplete intake past the gate. Admins only: a PM should not
  // be able to sign off their own project's shortcuts.
  "intake.override_gate",
  // Removing a project and all of its files. Admins only, and never live.
  "project.delete",
  // The Spend page and the monthly AI limit. Admins only.
  "spend.view",
  "settings.manage",
  // Accepting or pushing back on the tracked changes to a designer's design (Lane 2, Option B).
  "design.decide",
  // Prices, a project's price, cancellations and the Revenue page. Admins only.
  "money.manage",
  // Paid keyword lookups (DataForSEO), and the page plan (Phase 7a).
  "seo.research",
  "content.plan",
  // Approving a page's copy (7b): the Content role and admins.
  "content.approve",
  // The SEO team signs off the built site before go-live.
  "seo.signoff",
  // Phase 9: pressing Go live, and rolling a live site back. Founders and admins (Jason, 28 September 2026).
  "site.golive",
  // Recording the $199 build fee as paid, which go-live needs: admins and founders (Jason, 29 September 2026).
  "golive.fee",
  // The page-by-page review of a built site: PMs, the Web Designer, founders and admins (Jason, 1 and 3 October 2026).
  "site.review_pages",
] as const;
export type Permission = (typeof permissions)[number];

export function can(viewer: Viewer, permission: Permission): boolean {
  // Only the team's own accounts hold team permissions. Anything else (a
  // customer, or an object missing its kind) can do nothing: fails closed.
  if (viewer.kind !== "team") return false;
  // A disabled account can do nothing, whatever else it holds.
  if (viewer.isDisabled) return false;

  switch (permission) {
    // Five people on one team: everyone can read every project.
    case "project.view":
    case "intake.view":
      return true;

    case "project.create":
    case "project.edit":
    case "project.change_status":
    case "project.assign_members":
    case "intake.edit":
      return viewer.isAdmin || viewer.roles.includes("pm");

    case "user.manage":
    case "activity.view_all":
    case "intake.override_gate":
    case "project.delete":
    case "spend.view":
    case "settings.manage":
    case "money.manage":
      return viewer.isAdmin;

    // Keyword research spends money: PMs and SEO (26 September 2026).
    case "seo.research":
      return viewer.isAdmin || viewer.roles.includes("pm") || viewer.roles.includes("seo");

    // The page plan belongs to the PM, SEO and Content.
    case "content.plan":
      return viewer.isAdmin || viewer.roles.some((role) => role === "pm" || role === "seo" || role === "content");

    // The SEO team (and admins) sign off before go-live (26 September 2026).
    case "seo.signoff":
      return viewer.isAdmin || viewer.roles.includes("seo");

    // Content approves each page's copy (Jason, 26 September 2026).
    case "content.approve":
      return viewer.isAdmin || viewer.roles.includes("content");

    case "intake.design":
      return viewer.isAdmin || viewer.roles.includes("pm") || viewer.roles.includes("web_designer");

    // The Web Designer and admins decide on the changes to the designer's design (Jason, 25 September 2026).
    case "design.decide":
      return viewer.isAdmin || viewer.roles.includes("web_designer");

    // The founders give the final go-live (CLAUDE.md); admins too.
    case "site.golive":
    case "golive.fee":
      return viewer.isAdmin || viewer.roles.includes("founder");

    case "site.review_pages":
      return viewer.isAdmin || viewer.roles.some((role) => role === "pm" || role === "web_designer" || role === "founder");
  }
}

export function assertCan(viewer: Viewer, permission: Permission): void {
  if (!can(viewer, permission)) {
    throw new PermissionError(permission);
  }
}

export class PermissionError extends Error {
  readonly permission: Permission;

  constructor(permission: Permission) {
    super(`Not allowed: ${permission}`);
    this.name = "PermissionError";
    this.permission = permission;
  }
}
