import { getModelConfig } from "@tawd/core/mockups";
import { encryptionKeyProblem } from "@tawd/core/secrets";

/*
  Everything the worker needs from its environment, checked once at startup
  so a missing value is a clear message rather than a confusing failure
  twenty minutes into a run.
*/

export interface WorkerConfig {
  databaseUrl: string;
  redisUrl: string;
  anthropicApiKey: string;
  model: string;
  /** Where the pinned, read-only design skills live inside the image. */
  skillsDir: string;
  /** How hard the model should think. See DESIGN of the Claude API skill. */
  effort: "low" | "medium" | "high" | "xhigh" | "max";
}

const REQUIRED = [
  "DATABASE_URL",
  "REDIS_URL",
  "ANTHROPIC_API_KEY",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  // C7 (audit F-050): the worker decrypts the 20i SSH keys and WordPress passwords; without it a WordPress job failed half-way instead of the worker refusing to start. (Set on the live worker, checked 12 Nov 2026.)
  "TAWD_ENCRYPTION_KEY",
] as const;

export function loadConfig(): WorkerConfig {
  const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `The worker cannot start. These environment variables are not set:\n${missing
        .map((name) => `  - ${name}`)
        .join("\n")}`,
    );
  }
  // Same reading as the code that encrypts and decrypts, so a key that would fail mid-job fails here; the message never holds the key.
  const keyProblem = encryptionKeyProblem();
  if (keyProblem) throw new Error(`The worker cannot start. ${keyProblem}`);

  const effort = process.env.ANTHROPIC_EFFORT?.trim();

  return {
    databaseUrl: process.env.DATABASE_URL!,
    redisUrl: process.env.REDIS_URL!,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
    model: getModelConfig().model,
    skillsDir: process.env.SKILLS_DIR?.trim() || "/app/skills",
    effort:
      effort === "low" ||
      effort === "medium" ||
      effort === "high" ||
      effort === "xhigh" ||
      effort === "max"
        ? effort
        : "high",
  };
}
