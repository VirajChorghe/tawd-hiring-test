import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { skillFolders, type SkillId } from "@tawd/core/mockups";

const run = promisify(execFile);

/*
  Reaching into a design skill's folder.

  Skills are pinned and read-only, and this is where that stops being an
  intention and becomes a fact: there is no write path here at all, and
  every path is resolved and then checked to be inside the skill's own
  folder before anything is opened. A model that asks for
  "../../../.env" gets an error, not a secret.
*/

export class SkillAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillAccessError";
  }
}

/** Resolves a path inside one skill, or refuses. */
function resolveInsideSkill(
  skillsDir: string,
  skillId: SkillId,
  relativePath: string,
): string {
  const root = path.resolve(skillsDir, skillFolders[skillId]);
  const target = path.resolve(root, relativePath);

  // path.resolve collapses "..", so this comparison is the whole check.
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new SkillAccessError(
      `"${relativePath}" is outside the ${skillId} skill folder.`,
    );
  }
  return target;
}

export async function readSkillFile(
  skillsDir: string,
  skillId: SkillId,
  relativePath: string,
): Promise<string> {
  const target = resolveInsideSkill(skillsDir, skillId, relativePath);

  try {
    const contents = await readFile(target, "utf8");
    // A whole CSV database would swamp the context for no benefit.
    const LIMIT = 120_000;
    return contents.length > LIMIT
      ? `${contents.slice(0, LIMIT)}\n\n[truncated: the file is ${contents.length} characters]`
      : contents;
  } catch {
    throw new SkillAccessError(
      `There is no file "${relativePath}" in the ${skillId} skill.`,
    );
  }
}

/** The skill's own SKILL.md, which goes into the prompt verbatim. */
export function readSkillDefinition(
  skillsDir: string,
  skillId: SkillId,
): Promise<string> {
  return readSkillFile(skillsDir, skillId, "SKILL.md");
}

/** TAWD-PROFILE.md, which outranks every skill. */
export function readProfile(skillsDir: string): Promise<string> {
  return readFile(path.resolve(skillsDir, "TAWD-PROFILE.md"), "utf8");
}

/*
  The UI UX Pro Max search tool.

  Python 3, no dependencies, no network - the skill says so and the image
  provides nothing more. Arguments are passed as an array, never through a
  shell, so nothing the model writes can become a shell command.
*/
export async function runSkillSearch(
  skillsDir: string,
  query: string,
  options: { domain?: string; variance?: number } = {},
): Promise<string> {
  const script = resolveInsideSkill(
    skillsDir,
    "ui_ux_pro_max",
    "scripts/search.py",
  );

  const args = [script, query, "-f", "markdown"];
  if (options.domain) args.push("--domain", options.domain);
  if (options.variance !== undefined) {
    args.push("--variance", String(Math.max(1, Math.min(10, options.variance))));
  }

  try {
    const { stdout } = await run("python3", args, {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      // No shell, and no inherited environment beyond what it needs.
      // The cast is for the web app's type check, which also compiles this
      // file (its tests run the worker) and whose Next.js types insist on
      // NODE_ENV. Leaving it out is the point: nothing else is passed on.
      env: { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv,
    });
    return stdout.slice(0, 60_000);
  } catch (error) {
    return `The search tool did not run: ${
      error instanceof Error ? error.message : "unknown error"
    }. Carry on using your own judgment and the profile.`;
  }
}
