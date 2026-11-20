import type { Browser } from "playwright-core";

import {
  applyElementFindings,
  checkAssets,
  checkIcons,
  fillIcons,
  iconWordsWithNoIcon,
  measureRichness,
  numberElements,
  photoTokenUses,
  replaceFixStyle,
  runHtmlChecks,
  spreadRepeatedPhotos,
  type CheckFacts,
  type PageAsset,
} from "@tawd/core/mockups";

import { computeRenderedFixes } from "./rendered-fixes";
import { renderConcept, runRenderedChecks, type RenderExpectations } from "./render";

/*
  The canary (stage 3 of docs/plans/self-check.md, built 10 November 2026).

  TAWD had 2,102 passing tests while the full SEO audit had never worked,
  while every concept over 12,000px was photographed as its own hero, and
  while Design + content projects were all measured as having no pictures.
  None of those were found by the suite. Every one was found by Jason paying
  for a real run and looking at the result with his own eyes.

  So this does not test that functions work. It MEASURES WHAT TAWD PRODUCES
  from a fixed set of pages and compares the measurements with a recorded
  baseline, failing on any difference. A fault that changes nothing a test
  asserts - a count, a height, an icon, a colour - still changes a number
  here, and the run says which number and by how much.

  It costs nothing: no AI, no network, no database. `pnpm canary` runs it on
  any machine with Chrome. Stage B, replaying a real project's saved AI
  answers through the same measurement, needs the server and Jason's go on
  using a client's data.

  Changing a measurement is allowed - TAWD is meant to improve. It is
  allowed DELIBERATELY: `pnpm canary --update` rewrites the baseline, the
  diff goes in the pull request, and a reviewer sees exactly what changed
  about TAWD's output.
*/

export interface CanaryFixture {
  /** Stable name: it keys the baseline, so renaming one loses its history. */
  name: string;
  /** Why this page is in the set, and which real fault it stands for. */
  why: string;
  html: string;
  facts: CheckFacts;
  expectations?: RenderExpectations;
  assets?: PageAsset[];
}

/*
  Everything measured about one page. Only values that are stable across
  machines: no byte sizes, no timings, no screenshot bytes. A pixel height
  is stable because the viewport and the fonts are fixed; a font that fails
  to load would change it, which is itself worth failing on.
*/
export interface CanaryMeasurement {
  /** Every check's id, sorted, with its severity: the shape of what TAWD found. */
  checks: string[];
  placeholders: number;
  /** The rendered checks, which need a browser: ids only, sorted. */
  rendered: string[];
  heightPx: number;
  /** The full-page picture's height as render.ts REPORTS it. */
  imageHeightPx: number;
  /*
    The height of the picture that was actually produced, read out of the
    PNG itself. F35 was the reported number and the real one disagreeing in
    silence: a page past the cap was photographed as its first screen while
    every report said otherwise. Measuring what render.ts says would repeat
    the fault this exists to catch - rule 7 of docs/CODE-REVIEW-STANDARD.md,
    test the derived view against the artefact. Found by reverting F35 and
    watching the canary stay quiet.
  */
  pictureHeightPx: number;
  pictureWidthPx: number;
  truncated: boolean;
  bands: number;
  /** Words TAWD has no icon for, so the page shows a plain dot (F6). */
  noIconWords: string[];
  /** Each of the client's photos and how many bands use it (F8). */
  photoUses: Record<string, number>;
  /** What measureRichness sees: the numbers that decide the image-poor must-fix (F30). */
  richness: { clientPhotos: number; stockFrames: number; emptyFrames: number; bands: number; branded: boolean };
  /*
    What TAWD's own code does to the page after the builder wrote it, and
    whether it worked (New Dawn, 10 November 2026).

    The run showed why measuring the checks alone is not enough: the contrast
    fixer wrote a rule the page's own CSS outranked, so the labels on the
    quote form stayed white on white, TAWD spent two fix rounds re-fixing
    text that never changed, and every report said the contrast was fixed.
    The rules are what code wrote; the notes are what it told the team it
    did; and renderedAfterFixes is the only one of the three that can prove
    the page actually changed - the same checks, run again on the fixed page.
  */
  fixRules: string[];
  fixNotes: string[];
  renderedAfterFixes: string[];
}

const ids = (list: { id: string; severity?: string }[]) => [...new Set(list.map((i) => `${i.id}${i.severity && i.severity !== "fail" ? `:${i.severity}` : ""}`))].sort();

/*
  One page, measured through TAWD's own code - the same functions the
  pipeline calls, in the order it calls them: icons filled, repeats spread,
  then checked and rendered.
*/
export async function measureFixture(browser: Browser, fixture: CanaryFixture): Promise<CanaryMeasurement> {
  const assets = fixture.assets ?? [];
  const iconed = fillIcons(fixture.html, { refill: true });
  const spread = spreadRepeatedPhotos(iconed.html, assets.filter((a) => a.kind === "photo").map((a) => a.token));
  const html = spread.html;

  const outcome = runHtmlChecks(html, fixture.facts);
  const rendered = await runRenderedChecks(browser, html, fixture.expectations ?? {});
  const shot = await renderConcept(browser, html);
  const rich = measureRichness(html, fixture.facts.pictures?.brandColors ?? []);

  /*
    The fix pass, the way the pipeline runs it: measure in the browser, put
    the findings on the page as classes, keep the rules in the page's own
    fix stylesheet - then check the page again. Nothing here is a different
    implementation; it is pipeline.ts's own functions in pipeline.ts's order.
  */
  const brandColors = fixture.facts.pictures?.brandColors ?? [];
  const findings = await computeRenderedFixes(browser, numberElements(html), brandColors);
  const applied = applyElementFindings(html, findings);
  const fixedHtml = replaceFixStyle(applied.html, applied.rules.join("\n"));
  const afterFixes = await runRenderedChecks(browser, fixedHtml, fixture.expectations ?? {});

  return {
    checks: ids([...outcome.issues, ...checkIcons(html), ...checkAssets(html, assets)]),
    placeholders: outcome.placeholderCount,
    rendered: ids(rendered),
    heightPx: shot.heightPx,
    imageHeightPx: shot.imageHeightPx,
    ...pngSize(shot.fullPage),
    truncated: shot.truncated,
    bands: shot.bands.length,
    noIconWords: iconWordsWithNoIcon(html),
    photoUses: Object.fromEntries([...photoTokenUses(html)].sort()),
    richness: { clientPhotos: rich.clientPhotos, stockFrames: rich.stockFrames, emptyFrames: rich.emptyFrames, bands: rich.bands, branded: rich.branded },
    fixRules: [...applied.rules].sort(),
    fixNotes: findings.notes.map((note) => `${note.step}: ${note.action} ${note.what}${note.with ? ` with ${note.with}` : ""}`).sort(),
    renderedAfterFixes: ids(afterFixes),
  };
}

/*
  A PNG's own width and height, from its IHDR: the signature is 8 bytes,
  then the chunk's length and type, then width and height as big-endian
  32-bit numbers. No image library needed to read two numbers.
*/
function pngSize(png: Buffer): { pictureWidthPx: number; pictureHeightPx: number } {
  const isPng = png.length > 24 && png.toString("latin1", 1, 4) === "PNG";
  return isPng
    ? { pictureWidthPx: png.readUInt32BE(16), pictureHeightPx: png.readUInt32BE(20) }
    : { pictureWidthPx: 0, pictureHeightPx: 0 };
}

/** Every measurement for a run, keyed by fixture name. */
export type CanaryBaseline = Record<string, CanaryMeasurement>;

/*
  What changed, in words a person can act on. Nothing clever: a flat
  comparison, because the point is that a difference is impossible to miss,
  not that the diff is pretty.
*/
export function compareToBaseline(baseline: CanaryBaseline, now: CanaryBaseline): string[] {
  const differences: string[] = [];
  for (const name of Object.keys(baseline)) {
    if (!(name in now)) differences.push(`${name}: in the baseline but not in this run (a fixture was removed or renamed).`);
  }
  for (const [name, measured] of Object.entries(now)) {
    const before = baseline[name];
    if (!before) {
      differences.push(`${name}: new, with no baseline. Run with --update to record it.`);
      continue;
    }
    for (const key of Object.keys(measured) as (keyof CanaryMeasurement)[]) {
      const was = JSON.stringify(before[key]);
      const is = JSON.stringify(measured[key]);
      if (was !== is) differences.push(`${name}.${key}: was ${was}, now ${is}`);
    }
  }
  return differences;
}
