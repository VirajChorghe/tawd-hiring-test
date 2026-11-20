import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/*
  Gap 8 (5 November 2026): Clear Sky Awning's free Build & preview check
  failed with "page.setContent: Timeout 30000ms exceeded - waiting until
  load". The style kit's preview wrote the whole design PNG into every
  photo area, and every generated page waited for "load" with no limit of
  its own. Now the picture is in the page once, every page TAWD generates
  waits for its structure and then carries on, a failure is said in plain
  words, and a failed kit is marked failed.
*/

import { setDbForTesting, type Database } from "@tawd/core/db";
import { figmaDesign, styleKit } from "@tawd/core/schema";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { kitPreviewHtml, DESIGN_PICTURE_CLASS } from "@tawd/core/style-kit/preview";
import type { PageInventory } from "@tawd/core/style-kit/elements";
import type { StyleKit } from "@tawd/core/style-kit/kit";
import { eq } from "drizzle-orm";
import { createProject } from "@/lib/projects";

import { loadHtml, PageLoadError } from "../../../worker/src/page-load";
import { currentKit } from "../../../worker/src/design-site";

import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

const WORKER_SRC = path.resolve(__dirname, "../../../worker/src");

describe("the style kit's preview carries the design picture once", () => {
  it("stays small with thirty photo areas from a long design", () => {
    const picture = `data:image/png;base64,${"A".repeat(5_000_000)}`;
    const elements = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, kind: "picture", role: "photo", box: { x: 40 * i, y: 300 * i, w: 400, h: 260 } }));
    const page = { width: 1440, height: 9186, sections: [{ number: 1, name: "Home", top: 0, height: 9186, background: "#fff", elements }] } as unknown as PageInventory;
    const kit = { map: {}, icons: [] } as unknown as StyleKit;
    const html = kitPreviewHtml({ title: "Clear Sky", page, kit, css: "", picture });
    expect(html.split(picture.slice(0, 60)).length - 1).toBe(1);
    expect(html.length).toBeLessThan(picture.length + 50_000);
    expect(html.match(new RegExp(`class="${DESIGN_PICTURE_CLASS}"`, "g"))).toHaveLength(30);
    expect(html).toContain("background-position:-40px -300px");
  });
});

describe("a generated page never hangs on load", () => {
  it("says what went wrong in plain words when the page's structure can't be read", async () => {
    const page = {
      setContent: async () => {
        throw new Error("page.setContent: Timeout 60000ms exceeded.");
      },
      waitForLoadState: async () => undefined,
    };
    const error = await loadHtml(page as never, "<html></html>", { what: "The style kit's preview" }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(PageLoadError);
    expect((error as Error).message).toContain("The style kit's preview couldn't be opened in the browser in time");
    expect((error as Error).message).not.toContain("page.setContent");
  });

  it("never throws on a page that has no load state to wait for (the tests' stand-in browsers)", async () => {
    const page = { setContent: async () => undefined };
    await expect(loadHtml(page as never, "<html></html>")).resolves.toBe(true);
  });

  it("no worker file loads its own pages waiting for load or network idle (only real client websites do)", () => {
    const offenders: string[] = [];
    const files = (fs.readdirSync(WORKER_SRC, { recursive: true }) as string[])
      .map((f) => f.split(path.sep).join("/"))
      .filter((f) => f.endsWith(".ts") && !f.includes(".test.") && !["page-load.ts", "home-look.ts", "liked-sites.ts"].includes(f));
    for (const file of files) {
      fs.readFileSync(path.join(WORKER_SRC, file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          const waitsForAll = /\.setContent\(|waitUntil:\s*["'](load|networkidle)["']|waitForLoadState\(\s*["'](load|networkidle)["']/.test(line);
          // A goto that doesn't say it waits only for the structure waits for "load" by default.
          const gotoForLoad = /\.goto\(/.test(line) && !/waitUntil:\s*["'](domcontentloaded|commit)["']/.test(line);
          if (waitsForAll || gotoForLoad) offenders.push(`${file}:${i + 1}`);
        });
    }
    expect(files.length).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });
});

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const hasChrome = fs.existsSync(CHROME);
const require = createRequire(import.meta.url);
type Browser = { newContext: (o?: object) => Promise<{ newPage: () => Promise<never>; close: () => Promise<void> }>; close: () => Promise<void> };
let browser: Browser;
beforeAll(async () => {
  if (!hasChrome) return;
  const { chromium } = require("../../../worker/node_modules/playwright-core");
  browser = await chromium.launch({ executablePath: CHROME });
});
afterAll(async () => {
  await browser?.close();
});

describe.skipIf(!hasChrome)("in a real browser", () => {
  it("carries on when a picture never answers, after the short wait", async () => {
    const context = await browser.newContext();
    const page = (await context.newPage()) as unknown as Parameters<typeof loadHtml>[0];
    // A picture whose request is never answered: "load" would never fire.
    await page.route("https://never.test/**", () => new Promise(() => undefined));
    const started = Date.now();
    await loadHtml(page, `<html><body><h1>Built page</h1><img src="https://never.test/photo.jpg"></body></html>`, { settleMs: 1_500 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await page.textContent("h1")).toBe("Built page");
    await context.close();
  }, 30_000);
});

describe("a style kit that fails is marked failed, with a plain reason", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    setDbForTesting(h.db as Database);
    setStorageForTesting(new FakeR2());
  });
  afterEach(async () => {
    setStorageForTesting(null);
    setDbForTesting(null);
    await h.close();
  });

  it("never leaves the kit 'working' for ever", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Clear Sky 3", trade: "home_services", tier: "starter", lane: "lane_2", laneOption: "a", conceptCount: null, status: "mockups", memberUserIds: [] });
    // A design with no pages: the kit step throws.
    await h.db.insert(figmaDesign).values({ projectId: id, url: "upload", fileKey: "upload-1", source: "upload", importStatus: "done", importedVersion: "upload-1", frames: [] });
    const error = await currentKit({} as never, id, "upload-1").catch((e: Error) => e);
    expect((error as Error).message).toContain("The design's style kit couldn't be made: The design has no pages");
    const rows = await h.db.select().from(styleKit).where(eq(styleKit.projectId, id));
    expect(rows.map((r) => r.status)).toEqual(["failed"]);
    expect(rows[0]!.failureReason).toContain("no pages");
  });
});
