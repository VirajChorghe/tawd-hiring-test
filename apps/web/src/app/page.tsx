import { redirect } from "next/navigation";

import { requireUser } from "@/lib/session";

/*
  TAWD has no public front page. Signed in, admins land on Projects and
  everyone else on My work (29 September 2026); requireUser sends anyone
  else to sign in.
*/
export const dynamic = "force-dynamic";

export default async function Home() {
  const current = await requireUser();
  redirect(current.isAdmin ? "/projects" : "/my-work");
}
