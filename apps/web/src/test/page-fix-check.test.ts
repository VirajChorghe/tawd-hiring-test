import fs from "node:fs";
import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setStorageForTesting } from "@tawd/core/intake/storage";
import { checkFixedPage } from "../../../worker/src/page-fix-check";
import { FakeR2 } from "./worker-fakes";

/*
  TAWD's check after a fix (3c, 5 October 2026), in a real Chrome: the page
  served from the build's own files, only the changed parts measured, at
  computer and phone width. Skipped where Chrome isn't installed.
*/

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const hasChrome = fs.existsSync(CHROME);
const require = createRequire(import.meta.url);
type Browser = Parameters<typeof checkFixedPage>[0];
let browser: Browser;
let r2: FakeR2;
const BASE = "projects/p/site/v2/";

beforeAll(async () => {
  if (!hasChrome) return;
  const { chromium } = require("../../../worker/node_modules/playwright-core");
  browser = await chromium.launch({ executablePath: CHROME });
});
afterAll(async () => {
  await browser?.close();
});
beforeEach(() => {
  r2 = new FakeR2();
  setStorageForTesting(r2);
});
afterEach(() => setStorageForTesting(null));

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const page = (header: string, main: string) =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>
body{margin:0;font:16px/1.5 Arial,sans-serif}
header{display:flex;align-items:center;gap:16px;padding:12px 24px}
.menu-toggle{display:none}
@media (max-width:600px){header nav{display:none}.menu-toggle{display:inline-block}}
.btn{display:inline-block;padding:8px 12px;background:#205af2;color:#fff}
</style></head><body>${header}<main id="main">${main}</main><footer><p>Website by Velocity Media Lab</p></footer></body></html>`;

describe.skipIf(!hasChrome)("TAWD's check of the changed parts, in Chrome", () => {
  it("finds a wrapping phone number and button, something sticking out and a missing picture, only in the parts that changed", async () => {
    r2.objects.set(`${BASE}images/logo.png`, PNG);
    r2.objects.set(
      `${BASE}index.html`,
      Buffer.from(
        page(
          `<header><img src="/images/logo.png" alt="Logo" width="40" height="40"><nav><a href="/">Home</a><a href="/about/">About us</a></nav>
<a href="tel:+15555555555" style="display:inline-block;width:60px">(555) 555-5555</a>
<a class="btn" href="/contact/" style="width:70px">Send a question</a><button class="menu-toggle">Menu</button></header>`,
          `<section><h1>Fine</h1><img src="/images/missing.webp" alt="Gone" width="10" height="10"></section>
<section><p style="width:1500px">This line is far too wide for the page</p></section>
<section><a class="btn" href="/x/" style="width:40px">Call now please</a></section>`,
        ),
      ),
    );
    const found = await checkFixedPage(browser, BASE, "/", ["header", 0, 1]);
    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Header at computer width: the phone number "\(555\) 555-5555" wraps onto (two|three) lines\.$/),
        'Header at computer width: the button "Send a question" wraps onto two lines.',
        "Part 1 at computer width: a picture doesn't load (missing.webp).",
        expect.stringMatching(/^Part 2 at computer width: "This line is far too wide for the page" sticks out \d+ px past the edge of the page\.$/),
        expect.stringMatching(/^Part 2 at phone width: "This line is far too wide/),
      ]),
    );
    // Part 3 wasn't changed, so its wrapping button isn't checked; the logo loaded.
    expect(found.join("\n")).not.toContain("Call now");
    expect(found.join("\n")).not.toContain("logo.png");
  }, 60_000);

  it("finds nothing on a tidy header, a drawer waiting off-screen, a clipped slider or the phone menu", async () => {
    r2.objects.set(
      `${BASE}index.html`,
      Buffer.from(
        page(
          `<header><nav><a href="/">Home</a><a href="/services/">Our services</a></nav><a href="tel:+15555555555" style="white-space:nowrap">(555) 555-5555</a>
<a class="btn" href="/contact/" style="white-space:nowrap">Send a question</a><button class="menu-toggle">Menu</button>
<div style="position:fixed;top:0;left:100%;width:300px">A drawer waiting off to the side</div></header>`,
          `<section style="overflow:hidden"><div style="width:3000px;display:flex"><p>Slide one</p><p>Slide two</p></div></section>`,
        ),
      ),
    );
    expect(await checkFixedPage(browser, BASE, "/", ["header", 0])).toEqual([]);
  }, 60_000);
});
