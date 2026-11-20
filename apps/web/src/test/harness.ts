import type { Database } from "@tawd/core/db";
import type { TeamRole } from "@tawd/core/schema";
import { buildAuth, type Auth } from "@/lib/auth";
import { SYSTEM_ACTOR, type Viewer } from "@tawd/core/permissions";
import { createTeamUser, type ServiceContext } from "@/lib/users";
import { createTestDatabase, type TestHarness } from "./db";

// nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- the test database's own made-up secret
const TEST_SECRET = "test-secret-value-that-is-long-enough-32";
const TEST_BASE_URL = "http://localhost:3000";

export interface Harness {
  db: Database;
  auth: Auth;
  ctx: ServiceContext;
  close: () => Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const base: TestHarness = await createTestDatabase();

  const auth = buildAuth(base.db, {
    secret: TEST_SECRET,
    baseURL: TEST_BASE_URL,
    withNextCookies: false,
  });

  const ctx: ServiceContext = {
    db: base.db,
    auth,
    ipAddress: "203.0.113.10",
    userAgent: "vitest",
  };

  return { db: base.db, auth, ctx, close: base.close };
}

/**
 * A viewer built by hand, for permission checks that need no database row.
 */
export function viewer(overrides: Partial<Viewer> = {}): Viewer {
  return {
    kind: "team",
    id: "u-test",
    email: "test@velocitymedialab.com",
    isAdmin: false,
    isDisabled: false,
    roles: [],
    ...overrides,
  };
}

/**
 * The bootstrap admin every test needs before it can do anything else,
 * created the same way scripts/create-admin.ts creates the real first one.
 */
export async function seedAdmin(
  h: Harness,
  email = "admin@velocitymedialab.com",
): Promise<{ viewer: Viewer; temporaryPassword: string }> {
  const created = await createTeamUser(h.ctx, SYSTEM_ACTOR, {
    name: "Test Admin",
    email,
    isAdmin: true,
    roles: [],
  });

  return {
    viewer: viewer({ id: created.userId, email, isAdmin: true }),
    temporaryPassword: created.temporaryPassword,
  };
}

export async function seedUser(
  h: Harness,
  admin: Viewer,
  options: { email: string; name?: string; roles?: TeamRole[]; isAdmin?: boolean },
): Promise<{ viewer: Viewer; temporaryPassword: string }> {
  const created = await createTeamUser(h.ctx, admin, {
    name: options.name ?? "Test Person",
    email: options.email,
    isAdmin: options.isAdmin ?? false,
    roles: options.roles ?? [],
  });

  return {
    viewer: viewer({
      id: created.userId,
      email: options.email,
      isAdmin: options.isAdmin ?? false,
      roles: options.roles ?? [],
    }),
    temporaryPassword: created.temporaryPassword,
  };
}
