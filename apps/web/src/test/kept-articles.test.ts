import { describe, expect, it } from "vitest";

/*
  A makeover's blog articles (Jason, 7 October 2026, 0.98.0): read on top
  of the tier's page limit (up to KEPT_ARTICLE_LIMIT), and built by code
  after the first, in its layout. No network, no AI.
*/

import { articleAddress, crawlSite, extractPage, fillArticle, hasArticleSlot, keptMarkdownToHtml } from "@tawd/core/site";
import { KEPT_ARTICLE_LIMIT } from "@tawd/core/site-read";
import { SITE, siteFetch } from "./fixtures/keep-site";

/* The saved WordPress site as crawlSite asks it (one address at a time). */
const fixtureFetch = async (url: string) => {
  const answer = await siteFetch([])(url);
  return { url, status: answer.status, contentType: answer.headers.get("content-type") ?? "", text: await answer.text() };
};

const LAYOUT = `<main id="main"><div class="wrap"><article data-tawd-article class="post"><h1 class="t">Spring ants</h1><p class="body">Old words.</p></article><aside class="cta"><a href="/contact/">Call Harbor</a></aside></div></main>`;

describe("the first article's layout, filled by code", () => {
  it("is usable only with one marked element holding the one H1, and nothing of the article around it", () => {
    expect(hasArticleSlot(LAYOUT)).toBe(true);
    expect(hasArticleSlot(LAYOUT.replace(" data-tawd-article", ""))).toBe(false);
    // The H1 outside the marked element.
    expect(hasArticleSlot(`<main><h1>Spring ants</h1><div data-tawd-article><p>Words.</p></div></main>`)).toBe(false);
    // A breadcrumb with the title repeats on every article.
    expect(hasArticleSlot(LAYOUT.replace('<div class="wrap">', '<div class="wrap"><nav>Blog / Spring ants</nav>'))).toBe(false);
    // Two marked elements.
    expect(hasArticleSlot(LAYOUT.replace("<aside", "<aside data-tawd-article"))).toBe(false);
  });

  it("writes every block of the kept Markdown, escaped, with the layout's classes, and keeps what's around the article", () => {
    const md = "# Mice <in> winter\n\nMice come in when it's cold. See [our rodent page](/rodent-control/).\n\n## Signs\n\n- Droppings\n- Gnawing\n\n1. Seal gaps\n2. Call us\n\n> They were gone in a week.\n\n| Pest | Season |\n| Mice | Winter |\n\n" + String.fromCharCode(92) + "# Not a heading\n";
    const html = keptMarkdownToHtml(md);
    expect(html).toContain("<h1>Mice &lt;in&gt; winter</h1>");
    expect(html).toContain('<p>Mice come in when it\'s cold. See <a href="/rodent-control/">our rodent page</a>.</p>');
    expect(html).toContain("<h2>Signs</h2>");
    expect(html).toContain("<ul><li>Droppings</li><li>Gnawing</li></ul>");
    expect(html).toContain("<ol><li>Seal gaps</li><li>Call us</li></ol>");
    expect(html).toContain("<blockquote><p>They were gone in a week.</p></blockquote>");
    expect(html).toContain("<table><tbody><tr><td>Pest</td><td>Season</td></tr><tr><td>Mice</td><td>Winter</td></tr></tbody></table>");
    expect(html).toContain("<p># Not a heading</p>");
    const filled = fillArticle(LAYOUT, md);
    expect(filled).toContain('<h1 class="t">Mice &lt;in&gt; winter</h1>');
    expect(filled).toContain('<p class="body">Mice come in');
    expect(filled).not.toContain("Old words.");
    expect(filled).toContain('<aside class="cta"><a href="/contact/">Call Harbor</a></aside>');
    expect(filled.startsWith('<main id="main"><div class="wrap"><article data-tawd-article class="post">')).toBe(true);
    expect(hasArticleSlot(filled)).toBe(true);
  });
});

describe("a makeover reads its blog articles on top of the tier's limit", () => {
  it("knows an article by its address; reads the other pages up to the limit and the articles on top; the rest is listed", async () => {
    expect(articleAddress("/blog/spring-ants/")).toBe(true);
    expect(articleAddress("/blog/")).toBe(false);
    expect(articleAddress("/ant-control/")).toBe(false);
    expect(KEPT_ARTICLE_LIMIT).toBe(100);
    const plain = await crawlSite(SITE, { fetch: fixtureFetch, maxPages: 3, wait: async () => undefined });
    expect(plain.pages.map((p) => p.path)).toHaveLength(3);
    expect(plain.notImported).toContain(`${SITE}/blog/spring-ants/`);
    // One article on top: the newest (spring-ants, March) first; winter-mice still listed.
    const kept = await crawlSite(SITE, { fetch: fixtureFetch, maxPages: 3, extraArticles: 1, wait: async () => undefined });
    const paths = kept.pages.map((p) => p.path);
    expect(paths).toHaveLength(4);
    expect(paths).toContain("/blog/spring-ants/");
    expect(paths.filter((p) => p.startsWith("/blog/") && p !== "/blog/")).toEqual(["/blog/spring-ants/"]);
    expect(kept.notImported).toContain(`${SITE}/blog/winter-mice/`);
    expect(kept.notImported).not.toContain(`${SITE}/blog/spring-ants/`);
  });
});

describe("links in kept words (13 October 2026, the whole-code review)", () => {
  it("never keeps a javascript: link from the old site, however it's spelled", () => {
    const html = `<main><p>Read <a href="java&#9;script:alert(1)">this</a> and <a href="/drains/">drains</a> and <a href="vbscript:x">that</a>.</p></main>`;
    const page = extractPage(html, `${SITE}/blog/spring-ants/`);
    const text = page.blocks.map((b) => JSON.stringify(b)).join(" ");
    expect(text).not.toMatch(/script:/i);
    expect(page.links.map((l) => l.url)).toEqual([`${SITE}/drains/`]);
  });

  it("writes only site paths and http(s), mailto and tel addresses as links", () => {
    const html = keptMarkdownToHtml("See [one](javascript:alert(1)) and [two](/drains/) and [three](https://example.com/) and [four](data:text/html,x) and [five](//evil.example/x).");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:");
    expect(html).toContain(`<a href="/drains/">two</a>`);
    expect(html).toContain(`<a href="https://example.com/">three</a>`);
    expect(html).toContain("one");
    expect(html).toContain("four");
    expect(html).not.toContain(`href="//evil`);
  });
});
