import { parseArgs } from "node:util";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "@tawd/core/schema";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import { buildAuth } from "../src/lib/auth";
import { createTeamUser } from "../src/lib/users";
import { emailSchema } from "../src/lib/validation";

/*
  Creates the very first admin account, once.

  Run it from Coolify's Terminal tab on the TAWD application:

    node apps/web/scripts/create-admin.js --email you@velocitymedialab.com --name "Your Name"

  It refuses to run if any admin already exists, so it cannot be used a second
  time to quietly add an account. After the first admin exists, every other
  account is created through the Team page, which records who did it.

  The temporary password is printed once and never stored anywhere readable.
*/

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      name: { type: "string" },
    },
  });

  if (!values.email || !values.name) {
    console.error(
      'Usage: node apps/web/scripts/create-admin.js --email you@velocitymedialab.com --name "Your Name"',
    );
    process.exit(1);
  }

  const email = emailSchema.safeParse(values.email);
  if (!email.success) {
    console.error(email.error.issues.map((i) => i.message).join("\n"));
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  const secret = process.env.BETTER_AUTH_SECRET;
  const baseURL = process.env.BETTER_AUTH_URL;

  if (!databaseUrl || !secret || !baseURL) {
    console.error(
      "DATABASE_URL, BETTER_AUTH_SECRET and BETTER_AUTH_URL must all be set.",
    );
    process.exit(1);
  }

  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const db = drizzle(client, { schema });

  try {
    const admins = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.role, "admin"))
      .limit(1);

    if (admins.length > 0) {
      console.error(
        "An admin account already exists. Add further accounts from the Team page,\n" +
          "so the activity log records who created them.",
      );
      process.exit(1);
    }

    const auth = buildAuth(db, { secret, baseURL, withNextCookies: false });

    const created = await createTeamUser(
      { db, auth, ipAddress: null, userAgent: null },
      SYSTEM_ACTOR,
      {
        name: values.name,
        email: email.data,
        isAdmin: true,
        roles: [],
      },
    );

    console.log("");
    console.log("  First admin created.");
    console.log("");
    console.log(`    Email:              ${email.data}`);
    console.log(`    Temporary password: ${created.temporaryPassword}`);
    console.log("");
    console.log("  Copy that password now. It is not shown again and cannot be");
    console.log("  recovered. Sign in with it and TAWD will ask you to choose a");
    console.log("  real one before letting you go any further.");
    console.log("");
  } catch (error) {
    console.error("Could not create the first admin.");
    console.error(error);
    process.exitCode = 1;
  } finally {
    await client.end({ timeout: 5 });
  }
}

await main();
