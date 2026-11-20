"use server";

import { confirmTest } from "@/lib/forms-relay";
import { answerLabTest } from "@/lib/delivery-checks";
import { getServiceContext } from "@/lib/server-context";

/* F2: the client's "Yes, I got it" (no login; the link is the key, only its hash is stored). */
export async function confirmTestAction(token: string): Promise<{ recipient: string; site: string } | null> {
  return confirmTest(await getServiceContext(), token);
}

/* F4: where the monthly delivery check landed, from whoever checks that test inbox (no login). */
export async function answerLabAction(token: string, where: "inbox" | "spam"): Promise<{ provider: string } | null> {
  if (where !== "inbox" && where !== "spam") return null;
  return answerLabTest(await getServiceContext(), token, where);
}
