import { z } from "zod";

/*
  Environment is validated lazily, never at module load.

  `next build` imports every route module while no database or secret is
  present in the builder container. Validating at import time would fail the
  Docker build. Each getter validates on first use instead, so a missing or
  malformed value surfaces as a clear error at runtime rather than a stack
  trace deep inside a library.
*/

const serverEnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is not set. Coolify provides it for tawd-db."),
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters."),
  BETTER_AUTH_URL: z
    .string()
    .url("BETTER_AUTH_URL must be a full URL, e.g. https://tawd.velocitymedialab.com"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | null = null;

export function getEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Environment is not configured correctly:\n${problems}`);
  }

  cached = parsed.data;
  return cached;
}

/** Only for tests, which swap the environment between cases. */
export function resetEnvCache(): void {
  cached = null;
}
