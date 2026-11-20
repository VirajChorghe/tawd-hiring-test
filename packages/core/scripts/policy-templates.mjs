// Regenerates src/lib/site/policy-templates.ts from docs/policies: VML's privacy and cookie policy
// templates, and the state rules (state-laws.json, each rule's wording in states/<key>.md).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dir = path.join(root, "docs", "policies");
const read = (name) => readFileSync(path.join(dir, name), "utf8");
const rules = JSON.parse(read("state-laws.json")).map((rule) => {
  const file = path.join("states", `${rule.key}.md`);
  return { ...rule, addOn: existsSync(path.join(dir, file)) ? read(file) : "" };
});
const header = `/*
  VML's privacy and cookie policy templates and the state rules (28 September
  2026), exactly as in docs/policies, which is the source: after changing
  anything there, regenerate this file with
  \`node packages/core/scripts/policy-templates.mjs\` (a test checks they match).
*/
`;
writeFileSync(
  path.join(root, "packages", "core", "src", "lib", "site", "policy-templates.ts"),
  `${header}\nexport const PRIVACY_TEMPLATE = ${JSON.stringify(read("privacy-policy.md"))};\n\nexport const COOKIE_TEMPLATE = ${JSON.stringify(read("cookie-policy.md"))};\n\nexport const STATE_LAW_RULES = ${JSON.stringify(rules, null, 2)};\n`,
);
