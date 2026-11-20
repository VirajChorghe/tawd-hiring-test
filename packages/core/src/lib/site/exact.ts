/*
  Build A for Lane 2, Option A (28 September 2026): the site is the
  client-approved design, copied exactly, page by page. No AI: each page's
  copy (with its phone CSS) is the page, with the parts every TAWD site gets
  added in: the title, description, canonical and schema in the head, the
  tracking behind consent, the forms made Netlify forms, the privacy links
  in the footer and the consent banner. The thank-you, 404 and privacy
  pages wear the home page's own header, footer and styles.
*/

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The copy's own title and description, when the page plan has none for it. */
export function pageMeta(html: string): { title: string | null; description: string | null } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() || null;
  const description = /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i.exec(html)?.[1]?.trim() || null;
  return { title, description };
}

/* The page, with TAWD's head, the Netlify forms, the privacy links and the consent banner. */
export function exactPage(input: {
  html: string;
  title: string;
  description: string;
  /** seoHead plus the tracking head, as one block. */
  head: string;
  /** privacyLinks(), for the end of the footer; empty without tracking. */
  footerEnd: string;
  /** consentBanner(), before </body>; empty without tracking. */
  bodyEnd: string;
  /** netlifyForms and fillIntegrations, applied to the whole page. */
  transform: (html: string) => string;
}): string {
  let html = input.html
    .replace(/<title[^>]*>[\s\S]*?<\/title>\s*/gi, "")
    .replace(/<meta\s+name=["']description["'][^>]*>\s*/gi, "");
  const headTags = `<title>${escapeHtml(input.title)}</title>\n<meta name="description" content="${escapeHtml(input.description)}" />\n${input.head}`;
  // Functions, not strings: "$" in the client's words is kept as written ("from $$89" was published "from $89"; 13 October 2026, the whole-code review).
  html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, () => `${headTags}\n</head>`) : `<head>${headTags}</head>${html}`;
  html = input.transform(html);
  if (input.footerEnd) {
    const at = html.toLowerCase().lastIndexOf("</footer>");
    html = at >= 0 ? `${html.slice(0, at)}${input.footerEnd}${html.slice(at)}` : html.replace(/<\/body>/i, () => `${input.footerEnd}\n</body>`);
  }
  if (input.bodyEnd) html = html.replace(/<\/body>/i, () => `${input.bodyEnd}\n</body>`);
  return html;
}

/* The home page's head (its styles and fonts), header and footer, for the pages TAWD adds. */
export function homeParts(html: string): { head: string; header: string; footer: string } {
  const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? "";
  const header = /<header\b[\s\S]*?<\/header>/i.exec(html)?.[0] ?? "";
  const footers = [...html.matchAll(/<footer\b[\s\S]*?<\/footer>/gi)];
  return {
    head: head.replace(/<title[^>]*>[\s\S]*?<\/title>\s*/gi, "").replace(/<meta\s+name=["']description["'][^>]*>\s*/gi, "").replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/gi, ""),
    header,
    footer: footers.at(-1)?.[0] ?? "",
  };
}

export function simpleExactPage(parts: { head: string; header: string; footer: string }, main: string, extraCss: string): string {
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n${parts.head}\n<style>${extraCss}</style>\n</head>\n<body>\n${parts.header}\n<main>${main}</main>\n${parts.footer}\n</body>\n</html>\n`;
}

/* Where a page's images go: under its own folder, since each frame names its images from 1. */
export function exactImagePath(slug: string, token: string, ext: string): string {
  return `/images/${slug || "home"}/${token.replace("tawd-asset:", "")}.${ext}`;
}
