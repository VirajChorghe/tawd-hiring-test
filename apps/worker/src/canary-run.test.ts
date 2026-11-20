import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";

import { compareToBaseline, measureFixture, type CanaryBaseline } from "./canary";
import { CANARY_FIXTURES } from "./canary-fixtures";

/*
  The canary (stage 3 of docs/plans/self-check.md). See canary.ts for why.

  It runs in the ordinary suite, so a change to what TAWD produces fails the
  suite like anything else, and it can be run on its own:

    pnpm canary            measure and compare
    pnpm canary --update   record the measurements as the new baseline

  A difference is not necessarily a fault - TAWD is meant to improve - but
  it must be deliberate: update the baseline in the same pull request, and
  say in that pull request what moved and why.
*/

const BASELINE = path.resolve(__dirname, "../../../fixtures/canary/baseline.json");
const updating = process.env.TAWD_CANARY === "update" || process.argv.includes("--update");

/*
  Chrome is required, and its absence FAILS rather than skips. Every other
  browser test in this repo skips politely when Chrome is missing, which is
  right for them; it is wrong here, because a canary nobody runs is exactly
  the disease this is meant to treat (docs/CODE-REVIEW-STANDARD.md).

  The one exception is GitHub's own machines (Jason, 13 November 2026: one
  batch checked on GitHub while another runs on the laptop). They have no
  Chrome at this path, and the baseline was measured on Windows fonts, so
  there it skips; a batch checked on GitHub has its Chrome tests, this one
  included, run on the laptop beside it.
*/
const CHROME = process.env.TAWD_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const skipOnGitHub = process.env.GITHUB_ACTIONS === "true" && !fs.existsSync(CHROME);

let browser: Browser;

beforeAll(async () => {
  if (!fs.existsSync(CHROME)) return;
  browser = await chromium.launch({ executablePath: CHROME });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

describe("the canary", () => {
  it.skipIf(skipOnGitHub)("has Chrome to measure with", () => {
    expect(fs.existsSync(CHROME), `The canary needs Chrome at ${CHROME}. Set TAWD_CHROME to its path.`).toBe(true);
  });

  it("every fixture says which real fault it stands for", () => {
    for (const fixture of CANARY_FIXTURES) {
      expect(fixture.why.length, `${fixture.name} has no reason to exist`).toBeGreaterThan(40);
    }
    // Names key the baseline, so a duplicate would silently overwrite another page's history.
    expect(new Set(CANARY_FIXTURES.map((f) => f.name)).size).toBe(CANARY_FIXTURES.length);
  });

  it.skipIf(skipOnGitHub)("measures every page and matches the baseline", async () => {
    const measured: CanaryBaseline = {};
    for (const fixture of CANARY_FIXTURES) {
      measured[fixture.name] = await measureFixture(browser, fixture);
    }

    if (updating) {
      fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
      fs.writeFileSync(BASELINE, `${JSON.stringify(measured, null, 2)}\n`, "utf8");
      console.log(`Canary baseline recorded: ${Object.keys(measured).length} pages in fixtures/canary/baseline.json.`);
      return;
    }

    expect(fs.existsSync(BASELINE), "No canary baseline. Record one with: pnpm canary --update").toBe(true);
    const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8")) as CanaryBaseline;
    const differences = compareToBaseline(baseline, measured);
    if (differences.length > 0) {
      console.error(`\nTAWD's output changed in ${differences.length} measurement${differences.length === 1 ? "" : "s"}:\n`);
      for (const line of differences) console.error(`  ${line}`);
      console.error("\nIf this is deliberate: pnpm canary --update, and say in the pull request what moved and why.\n");
    }
    expect(differences).toEqual([]);
  }, 300_000);
});
