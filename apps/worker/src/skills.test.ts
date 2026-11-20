import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SkillAccessError, readProfile, readSkillFile } from "./skills";

/*
  The skill reader is a security boundary, not a convenience.

  A design skill's text goes into a prompt, and the model can then ask to
  read more files from that skill's folder. If it could ask for anything at
  all, a skill - or a client who got a sentence past the intake fence -
  could read the environment. So the escaping tests here are the point of
  the file; the happy path is almost incidental.
*/

let root: string;
let skillDir: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "tawd-skills-"));
  skillDir = path.join(root, "ui-ux-pro-max-tawd");

  await mkdir(path.join(skillDir, "references"), { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), "# The skill\n");
  await writeFile(
    path.join(skillDir, "references", "quick.md"),
    "# A reference page\n",
  );
  await writeFile(path.join(root, "TAWD-PROFILE.md"), "# The profile\n");

  // Something worth stealing, one level above the skill folder.
  // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- a fake key the test makes sure is never read
  await writeFile(path.join(root, "secrets.env"), "ANTHROPIC_API_KEY=sk-real\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("reading inside a skill", () => {
  it("reads the skill's own definition", async () => {
    await expect(
      readSkillFile(root, "ui_ux_pro_max", "SKILL.md"),
    ).resolves.toContain("The skill");
  });

  it("reads a reference page in a subfolder", async () => {
    await expect(
      readSkillFile(root, "ui_ux_pro_max", "references/quick.md"),
    ).resolves.toContain("A reference page");
  });

  it("reads the profile, which sits beside the skills", async () => {
    await expect(readProfile(root)).resolves.toContain("The profile");
  });

  it("says plainly when a file is simply not there", async () => {
    await expect(
      readSkillFile(root, "ui_ux_pro_max", "nope.md"),
    ).rejects.toBeInstanceOf(SkillAccessError);
  });
});

describe("refusing to read outside a skill", () => {
  const escapes = [
    "../secrets.env",
    "../../secrets.env",
    "references/../../secrets.env",
    "./../secrets.env",
    "..",
    "../",
    "references/../../../../../../etc/passwd",
  ];

  for (const attempt of escapes) {
    it(`refuses "${attempt}"`, async () => {
      await expect(
        readSkillFile(root, "ui_ux_pro_max", attempt),
        `"${attempt}" escaped the skill folder`,
      ).rejects.toBeInstanceOf(SkillAccessError);
    });
  }

  it("refuses an absolute path", async () => {
    await expect(
      readSkillFile(root, "ui_ux_pro_max", path.join(root, "secrets.env")),
    ).rejects.toBeInstanceOf(SkillAccessError);
  });

  it("refuses to cross into another skill's folder", async () => {
    await expect(
      readSkillFile(root, "ui_ux_pro_max", "../impeccable-tawd/SKILL.md"),
    ).rejects.toBeInstanceOf(SkillAccessError);
  });

  it("never leaks the secret in the refusal message", async () => {
    try {
      await readSkillFile(root, "ui_ux_pro_max", "../secrets.env");
      expect.unreachable("should have refused");
    } catch (error) {
      expect((error as Error).message).not.toContain("sk-real");
    }
  });
});

describe("keeping a huge file from swamping the context", () => {
  it("truncates and says so", async () => {
    await writeFile(
      path.join(skillDir, "big.csv"),
      "x".repeat(200_000),
      "utf8",
    );

    const contents = await readSkillFile(root, "ui_ux_pro_max", "big.csv");
    expect(contents.length).toBeLessThan(200_000);
    expect(contents).toContain("truncated");
  });
});
