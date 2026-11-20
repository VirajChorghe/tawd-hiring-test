import { headers } from "next/headers";

import { getDb } from "@tawd/core/db";
import { getAuth } from "@/lib/auth";
import { getClientIp, getUserAgent } from "@/lib/request";
import type { ServiceContext } from "@/lib/users";

/**
 * Bundles the database, the auth instance and the details of the current
 * request that the activity log records.
 */
export async function getServiceContext(): Promise<ServiceContext> {
  const requestHeaders = await headers();

  return {
    db: getDb(),
    auth: getAuth(),
    ipAddress: getClientIp(requestHeaders),
    userAgent: getUserAgent(requestHeaders),
  };
}

export type { ActionState } from "@/lib/action-state";
