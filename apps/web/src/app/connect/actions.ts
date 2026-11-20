"use server";

import { revalidatePath } from "next/cache";

import { clientSaysDone } from "@/lib/connect";
import { getServiceContext } from "@/lib/server-context";

/*
  F3: the client's "I've done it", from their private page. No login: the
  link is the key (only its hash is stored), the records are checked at
  most once a minute, and nothing here can change anything but the check.
*/
export async function clientDoneAction(token: string): Promise<{ ok: boolean; done: boolean; remaining: number }> {
  const check = await clientSaysDone(await getServiceContext(), token);
  if (!check) return { ok: false, done: false, remaining: 0 };
  revalidatePath(`/connect/${token}`);
  return { ok: true, done: check.ok, remaining: check.changes.length };
}
