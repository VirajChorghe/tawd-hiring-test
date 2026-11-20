import { defineConfig } from "drizzle-kit";

/*
  Used only by drizzle-kit on a developer machine, to generate migration SQL
  from the schema, which lives in the shared core package. The running app never reads this file, and migrations are
  applied by scripts/migrate.ts rather than by drizzle-kit.
*/
export default defineConfig({
  dialect: "postgresql",
  schema: "../../packages/core/src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://unused",
  },
  strict: true,
  verbose: true,
});
