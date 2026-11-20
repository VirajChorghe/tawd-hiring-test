import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getDb } from "@tawd/core/db";
import { user as userTable, userRole } from "@tawd/core/schema";
import type { TeamRole } from "@tawd/core/schema";
import { getAuth } from "@/lib/auth";
import type { Viewer } from "@tawd/core/permissions";

/*
  Every protected page resolves its viewer through here.

  The check reads the user row on each request rather than trusting what was
  true when the session was created. That is what makes "disabling a user
  blocks them immediately" true: their existing session stops working on the
  next page load, not whenever it happens to expire.

  This runs in layouts and server actions rather than in middleware, because
  middleware would need the database and Next middleware is not a comfortable
  place to open a PostgreSQL connection.
*/

export interface CurrentUser extends Viewer {
  name: string;
  mustChangePassword: boolean;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await getAuth().api.getSession({
    headers: await headers(),
  });
  if (!session?.user?.id) return null;

  const db = getDb();

  const [row] = await db
    .select()
    .from(userTable)
    .where(eq(userTable.id, session.user.id))
    .limit(1);

  if (!row) return null;

  const roleRows = await db
    .select({ role: userRole.role })
    .from(userRole)
    .where(eq(userRole.userId, row.id));

  return {
    // Built from the team's `user` table only; customers live in their own table.
    kind: "team",
    id: row.id,
    email: row.email,
    name: row.name,
    isAdmin: row.role === "admin",
    isDisabled: row.banned === true,
    mustChangePassword: row.mustChangePassword,
    roles: roleRows.map((r) => r.role as TeamRole),
  };
}

/**
 * For ordinary pages: signed in, not disabled, password already changed.
 */
export async function requireUser(): Promise<CurrentUser> {
  const current = await getCurrentUser();

  if (!current) redirect("/login");
  if (current.isDisabled) redirect("/login?error=disabled");
  if (current.mustChangePassword) redirect("/change-password");

  return current;
}

/**
 * For the change-password page itself, which is the one place a user with a
 * temporary password is allowed to be.
 */
export async function requireUserPendingPasswordChange(): Promise<CurrentUser> {
  const current = await getCurrentUser();

  if (!current) redirect("/login");
  if (current.isDisabled) redirect("/login?error=disabled");

  return current;
}
