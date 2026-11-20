import fs from "node:fs";
import path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildPolishCritiqueSystemPrompt, buildReviewerSystemPrompt, EMBED_STAND_IN_LABEL } from "@tawd/core/mockups";
import { lockedAllows, originOf, ownPageContext } from "../../../worker/src/locked-context";
import { phoneCheck } from "../../../worker/src/phone-by-code";

/*
  Option B (Jason 22 October 2026, built 3 November): every Chrome page the
  worker opens goes through one lock. A page TAWD built may load only inline
  content, Google Fonts and the addresses the caller names; the real-Chrome
  part proves a request to anywhere else never leaves the browser. Skipped
  where Chrome is not installed.
*/

const WORKER_SRC = path.resolve(__dirname, "../../../worker/src");

describe("lockedAllows", () => {
  const local = "http://127.0.0.1:4100";

  it("lets inline content and Google Fonts through", () => {
    expect(lockedAllows("data:image/png;base64,AAAA", [])).toBe(true);
    expect(lockedAllows("blob:http://127.0.0.1:4100/abc", [])).toBe(true);
    expect(lockedAllows("about:blank", [])).toBe(true);
    expect(lockedAllows("https://fonts.googleapis.com/css2?family=Inter", [])).toBe(true);
    expect(lockedAllows("https://fonts.gstatic.com/s/inter/v1/a.woff2", [])).toBe(true);
  });

  it("lets the named origin through, and only that origin", () => {
    expect(lockedAllows(`${local}/services/`, [local])).toBe(true);
    expect(lockedAllows("http://127.0.0.1:4101/", [local])).toBe(false);
    expect(lockedAllows("https://127.0.0.1:4100/", [local])).toBe(false);
  });

  it("refuses everything else", () => {
    expect(lockedAllows("https://example.com/pixel.gif", [local])).toBe(false);
    expect(lockedAllows("http://169.254.169.254/latest/meta-data/", [local])).toBe(false);
    expect(lockedAllows("http://fonts.googleapis.com/css2?family=Inter", [])).toBe(false);
    expect(lockedAllows("https://fonts.googleapis.com.evil.test/x", [])).toBe(false);
    expect(lockedAllows("not an address", [local])).toBe(false);
  });
});

describe("originOf", () => {
  it("reads an address's origin and ignores HTML", () => {
    expect(originOf("http://127.0.0.1:4100/about/")).toBe("http://127.0.0.1:4100");
    expect(originOf("<!doctype html><p>hello</p>")).toBeNull();
  });
});

describe("every Chrome page goes through the lock", () => {
  it("no worker file opens a browser context or page except locked-context.ts", () => {
    const offenders: string[] = [];
    for (const file of fs.readdirSync(WORKER_SRC)) {
      if (!file.endsWith(".ts") || file.includes(".test.") || file === "locked-context.ts") continue;
      const text = fs.readFileSync(path.join(WORKER_SRC, file), "utf8");
      text.split("\n").forEach((line, i) => {
        if (/\.newContext\(|browser\.newPage\(/.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("only the two real-website readers use the unlocked context", () => {
    const users = fs
      .readdirSync(WORKER_SRC)
      .filter((f) => f.endsWith(".ts") && !f.includes(".test.") && f !== "locked-context.ts")
      .filter((f) => fs.readFileSync(path.join(WORKER_SRC, f), "utf8").includes("publicSiteContext("))
      .sort();
    expect(users).toEqual(["home-look.ts", "liked-sites.ts"]);
  });
});

describe("a blocked map or booking widget is not a defect", () => {
  it("tells the Creative Director and the polish critic the grey box is expected", () => {
    for (const prompt of [buildReviewerSystemPrompt("brief", "profile"), buildPolishCritiqueSystemPrompt("reference")]) {
      expect(prompt).toContain(`labeled "${EMBED_STAND_IN_LABEL}"`);
      expect(prompt).toContain("never score it down, never write a note about it");
    }
  });
});

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const hasChrome = fs.existsSync(CHROME);
const require = createRequire(import.meta.url);

type Browser = Parameters<typeof ownPageContext>[0];
let browser: Browser;
let site: Server;
let outside: Server;
let siteOrigin = "";
let outsideOrigin = "";
const outsideHits: string[] = [];

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

beforeAll(async () => {
  if (!hasChrome) return;
  outside = createServer((req, res) => {
    outsideHits.push(req.url ?? "");
    res.writeHead(200, { "Content-Type": "image/gif" });
    res.end();
  });
  outsideOrigin = await listen(outside);
  site = createServer((req, res) => {
    if (req.url === "/own.css") {
      res.writeHead(200, { "Content-Type": "text/css" });
      res.end("body{background:rgb(1, 2, 3)}");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><html><head><link rel="stylesheet" href="/own.css"></head><body>
<img id="away" src="${outsideOrigin}/pixel.gif">
<iframe id="map" src="${outsideOrigin}/maps/embed" width="400" height="300"></iframe>
<script>fetch("${outsideOrigin}/beacon").catch(() => {}); window.open("${outsideOrigin}/popup");</script>
</body></html>`);
  });
  siteOrigin = await listen(site);
  const { chromium } = require("../../../worker/node_modules/playwright-core");
  browser = await chromium.launch({ executablePath: CHROME });
});

afterAll(async () => {
  await browser?.close();
  site?.close();
  outside?.close();
});

describe.skipIf(!hasChrome)("a locked page in real Chrome", () => {
  it("loads the site's own files and nothing from elsewhere, popups included", async () => {
    const context = await ownPageContext(browser, {}, [siteOrigin]);
    try {
      const page = await context.newPage();
      await page.goto(`${siteOrigin}/`, { waitUntil: "load" });
      await page.waitForTimeout(300);
      const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const pictureLoaded = await page.evaluate(() => (document.getElementById("away") as HTMLImageElement).naturalWidth > 0);
      expect(background).toBe("rgb(1, 2, 3)");
      expect(pictureLoaded).toBe(false);
      expect(outsideHits).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("draws an embedded map from elsewhere as a labeled grey box, not an error page", async () => {
    const context = await ownPageContext(browser, {}, [siteOrigin]);
    try {
      const page = await context.newPage();
      await page.goto(`${siteOrigin}/`, { waitUntil: "load" });
      const frame = page.frames().find((f) => f.parentFrame() !== null);
      expect(await frame?.evaluate(() => document.body.innerText.trim())).toBe(EMBED_STAND_IN_LABEL);
      expect(outsideHits).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("the phone check doesn't call a picture from elsewhere missing, but still flags the page's own", async () => {
    const html = `<!doctype html><html><body style="margin:0"><img alt="Van" src="${outsideOrigin}/van.jpg" width="200" height="100"><img alt="Own" src="data:image/png;base64,broken" width="200" height="100"></body></html>`;
    const { problems } = await phoneCheck(browser, html);
    const missing = problems.filter((p) => p.kind === "missing image").map((p) => p.detail);
    expect(missing).toEqual(["Own"]);
    expect(outsideHits).toEqual([]);
  });

  it("refuses the site's own address when the caller didn't name it", async () => {
    const context = await ownPageContext(browser);
    try {
      const page = await context.newPage();
      await expect(page.goto(`${siteOrigin}/`)).rejects.toThrow();
    } finally {
      await context.close();
    }
  });
});
