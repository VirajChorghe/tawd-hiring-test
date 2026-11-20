import { describe, expect, it } from "vitest";

/*
  F-008 (audit, November 2026): the read's planning step compared every
  skipped address with every other (skipped.some inside the loop), so 40,000
  sitemap addresses took 21 minutes and froze the worker. It is linear now,
  and only the first MAX_PLAN_ADDRESSES addresses are considered.
*/

import { crawlSite, importPath, leftOutUrls, MAX_PLAN_ADDRESSES, planCandidates, skipReason, type FetchedText, type SiteFetch } from "@tawd/core/site";

/** The planning loop as it was before the fix, kept to prove the new one gives the same plan. */
function oldPlan(candidates: string[], host: string, origin: string, listFrom = Infinity) {
  const skipped: { url: string; reason: string }[] = [];
  const seen = new Set<string>(["/"]);
  const list: string[] = [`${origin}/`];
  let ownCount = 1;
  for (const [index, url] of candidates.entries()) {
    const fromList = index >= listFrom;
    const reason = skipReason(url, host);
    const path = importPath(url);
    if (reason) {
      if (!fromList && reason !== "Another website" && !skipped.some((s) => importPath(s.url) === path)) skipped.push({ url, reason });
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    list.push(`${origin}${path}`);
    if (!fromList) ownCount = list.length;
  }
  return { skipped, list, ownCount };
}

const ok = (url: string, text: string, contentType = "text/html"): FetchedText => ({ url, status: 200, contentType, text });
const HOME = "<!doctype html><html><head><title>Home</title></head><body><main><h1>Home</h1><p>Synthetic home page words for the test.</p></main></body></html>";

describe("the page plan", () => {
  it("is the same plan the old quadratic loop made", () => {
    const host = "synthetic.example";
    const origin = "https://synthetic.example";
    const candidates = [
      "https://synthetic.example/about/",
      "https://synthetic.example/About",
      "https://synthetic.example/wp-content/uploads/a.pdf",
      "https://synthetic.example/wp-content/uploads/a.pdf?x=1",
      "https://synthetic.example/category/news/",
      "https://other.example/x/",
      "https://synthetic.example/feed/",
      "https://synthetic.example/services/ants/",
      "https://synthetic.example/services/ants/#top",
      "not a url",
      "https://synthetic.example/from-route/",
      "https://synthetic.example/wp-json/x/",
      "https://synthetic.example/privacy-policy/",
    ];
    for (const listFrom of [Infinity, 10, 0]) {
      expect(planCandidates(candidates, host, origin, listFrom)).toEqual(oldPlan(candidates, host, origin, listFrom));
    }
    expect(planCandidates(candidates, host, origin).skipped.length).toBeGreaterThan(3);
  });

  it("plans 40,000 sitemap addresses in seconds, considering the first 5,000, and says so", async () => {
    const total = Number(process.env.D1_N ?? 40_000);
    const urls = Array.from({ length: total }, (_, i) => `<url><loc>https://synthetic.example/wp-content/uploads/file-${i}.pdf</loc></url>`).join("");
    const sitemap = `<?xml version="1.0"?><urlset>${urls}</urlset>`;
    const fetch: SiteFetch = async (url) => {
      if (url.endsWith("/sitemap.xml")) return ok(url, sitemap, "application/xml");
      if (/robots|sitemap/.test(url)) return { url, status: 404, contentType: "text/plain", text: "" };
      return ok(url, HOME);
    };
    const started = Date.now();
    const result = await crawlSite("https://synthetic.example", { fetch, maxPages: 25, wait: async () => undefined });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(MAX_PLAN_ADDRESSES).toBe(5000);
    // 5,000 files plus the one note.
    expect(result.skipped.length).toBe(Math.min(total, MAX_PLAN_ADDRESSES) + (total > MAX_PLAN_ADDRESSES ? 1 : 0));
    if (total > MAX_PLAN_ADDRESSES) {
      expect(result.skipped.at(-1)!.reason).toBe(`The sitemap listed ${total.toLocaleString("en-US")} addresses; the first 2,500 and the last 2,500 were considered.`);
      // The end of the list is kept too (posts come last), and the note is never taken for an address to redirect.
      expect(result.skipped.some((s) => s.url.endsWith(`file-${total - 1}.pdf`))).toBe(true);
      expect(leftOutUrls({ skipped: result.skipped })).not.toContain("https://synthetic.example/sitemap.xml");
    }
  }, 120_000);
});
