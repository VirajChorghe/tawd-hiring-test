import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { admin } from "better-auth/plugins/admin";

import { getDb, type Database } from "@tawd/core/db";
import * as schema from "@tawd/core/schema";
import { getEnv } from "@/lib/env";
import { RESET_LINK_MINUTES, afterPasswordReset, sendResetEmail } from "@/lib/password-reset";
import { MIN_PASSWORD_LENGTH } from "@/lib/validation";

/*
  No return type annotation on purpose: the plugin endpoints (createUser,
  banUser and the rest) only exist on the inferred type. Annotating this as
  the generic Auth type would erase them.
*/
export function buildAuth(
  db: Database,
  options?: {
    secret?: string;
    baseURL?: string;
    /*
      The Next.js cookie bridge reads the current request's cookie store, so
      it can only run inside a request. Tests call the auth API directly with
      no request around them and switch it off.
    */
    withNextCookies?: boolean;
  },
) {
  const baseURL = options?.baseURL ?? getEnv().BETTER_AUTH_URL;
  // Production is https, so cookies get the __Secure- prefix. Browsers reject
  // that prefix over plain http, which would silently break local development
  // on localhost, so follow the URL rather than hard-coding it.
  const useSecureCookies = baseURL.startsWith("https://");

  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg", schema }),
    secret: options?.secret ?? getEnv().BETTER_AUTH_SECRET,
    baseURL,

    emailAndPassword: {
      enabled: true,
      // There is no public sign-up in TAWD. Accounts exist only because an
      // admin created them, so the endpoint is switched off rather than
      // merely unlinked from the interface.
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: 200,
      requireEmailVerification: false,
      // Forgot password: a link that works once, for 30 minutes (password-reset.ts).
      resetPasswordTokenExpiresIn: RESET_LINK_MINUTES * 60,
      sendResetPassword: async ({ user, token }) => sendResetEmail(db, user, token, baseURL),
      onPasswordReset: async ({ user }) => afterPasswordReset(db, user),
      // Every session signs out: whoever had the old password is out too.
      revokeSessionsOnPasswordReset: true,
    },

    // Reset links are kept only as a hash, so the database never holds a working one.
    verification: { storeIdentifier: "hashed" },

    user: {
      additionalFields: {
        // Admin-created accounts start on a temporary password.
        mustChangePassword: {
          type: "boolean",
          defaultValue: true,
          required: false,
          input: false,
        },
      },
    },

    session: {
      // A working day. Long enough not to nag, short enough that a forgotten
      // laptop stops being useful overnight.
      expiresIn: 60 * 60 * 8,
      updateAge: 60 * 60,
    },

    // Stored in the database so the login throttle survives a redeploy,
    // which an in-memory counter would not.
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/change-password": { window: 60, max: 5 },
        "/request-password-reset": { window: 15 * 60, max: 5 },
        "/reset-password": { window: 60, max: 5 },
      },
    },

    advanced: {
      useSecureCookies,
      ipAddress: {
        // TAWD sits behind Coolify's proxy, so the real client address
        // arrives in a forwarded header rather than on the socket.
        // x-real-ip first: Coolify's proxy sets it, the caller can't (C4; see lib/request.ts).
        ipAddressHeaders: ["x-real-ip", "x-forwarded-for"],
      },
    },

    plugins: [
      admin({
        // The plugin's own switch, held in user.role. Not a TAWD team role.
        defaultRole: "user",
        adminRoles: ["admin"],
      }),
      // Must stay last: lets server actions set the session cookie.
      ...(options?.withNextCookies === false ? [] : [nextCookies()]),
    ],
  });
}

export type Auth = ReturnType<typeof buildAuth>;

let cached: Auth | null = null;

export function getAuth(): Auth {
  if (!cached) cached = buildAuth(getDb());
  return cached;
}

/** Only for tests, which build their own instance against a test database. */
export function setAuthForTesting(auth: Auth | null): void {
  cached = auth;
}
