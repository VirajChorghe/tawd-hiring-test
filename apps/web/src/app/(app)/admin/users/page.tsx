import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getDb } from "@tawd/core/db";
import { can } from "@tawd/core/permissions";
import { requireUser } from "@/lib/session";
import { listTeamUsers } from "@/lib/users";
import { TeamManager } from "./team-manager";
import { EmailCheck } from "@/components/team/email-check";
import { mailSettings } from "@/lib/mail";

export const metadata: Metadata = { title: "Team - TAWD" };
export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const current = await requireUser();
  if (!can(current, "user.manage")) redirect("/projects");

  const users = await listTeamUsers(getDb());

  return (
    <div className="page">
      <TeamManager
        currentUserId={current.id}
        users={users.map((user) => ({
          id: user.id,
          name: user.name,
          email: user.email,
          isAdmin: user.isAdmin,
          isDisabled: user.isDisabled,
          mustChangePassword: user.mustChangePassword,
          roles: user.roles,
        }))}
      />
      <EmailCheck email={current.email} settings={mailSettings()} />
    </div>
  );
}
