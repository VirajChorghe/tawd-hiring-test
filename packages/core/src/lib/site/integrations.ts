import { embedSrc, integrationKindLabels, type IntegrationKind } from "../intake/integrations";
import type { ChecklistItem } from "./publish";

/*
  Placing the client's online tools on the built site, and checking them
  (Jason, 26 September 2026). The builder is told where each belongs; a
  booking page that can sit inside the site is marked with a placeholder
  element that TAWD fills in itself, so the AI never writes a frame or a
  script. The build's checklist confirms each link is on the site and that
  it answers.
*/

export interface SiteIntegration {
  id: string;
  kind: IntegrationKind;
  provider: string;
  url: string;
  /** Show the booking page on the site (only for providers made for it). */
  embed: boolean;
}

const escapeAttr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* The button text for each kind. */
export function integrationButton(i: SiteIntegration): string {
  if (i.kind === "booking") return "Book online";
  if (i.kind === "shop") return "Shop";
  if (i.kind === "portal") return /patient/i.test(i.provider) ? "Patient portal" : "Client portal";
  return i.provider ? `Read our reviews on ${i.provider}` : "Read our reviews";
}

const framed = (i: SiteIntegration) => i.kind === "booking" && i.embed && embedSrc(i.url) !== null;

/* The part of the builder's instructions about the client's tools; empty when there are none. */
export function integrationsPrompt(list: SiteIntegration[]): string {
  const usable = list.filter((i) => i.url);
  if (usable.length === 0) return "";
  const where: Record<IntegrationKind, string> = {
    booking: 'a "Book online" button in the header beside the call button, in the homepage hero next to the call button, and on the Contact page',
    shop: 'a "Shop" link in the footer, and a button on the homepage where products or gift cards fit',
    portal: "a small link in the header (secondary, never louder than the call button) and in the footer",
    reviews: "a link under the homepage's reviews or trust section. Never write, quote or invent a review; the link is the proof",
  };
  const lines = usable.map((i) => {
    const frame = framed(i)
      ? ` Also, on the Contact page, put <div data-tawd-integration="${i.id}"></div> where the booking calendar should appear, full width, with a short heading above it; TAWD fills it in.`
      : "";
    return `- ${integrationKindLabels[i.kind]}${i.provider ? ` (${i.provider})` : ""}: ${i.url}. Place ${where[i.kind]}. The link text is "${integrationButton(i)}"; it opens the address exactly as written.${frame}`;
  });
  return `# The client's online tools

Links from the intake, placed as listed. They go to the provider's own pages: use each address exactly, never change it, and add no others.
${lines.join("\n")}`;
}

/* Fills TAWD's integration placeholders: a frame for a booking page made for it, a button for anything else. */
export function fillIntegrations(main: string, list: SiteIntegration[]): string {
  return main.replace(/<div\b[^>]*data-tawd-integration="([^"]*)"[^>]*>\s*<\/div>/gi, (_whole, id: string) => {
    const i = list.find((x) => x.id === id && x.url);
    if (!i) return "";
    const src = framed(i) ? embedSrc(i.url) : null;
    if (src) {
      return `<div class="tawd-embed"><iframe src="${escapeAttr(src)}" title="${escapeAttr(`${integrationButton(i)}${i.provider ? ` with ${i.provider}` : ""}`)}" loading="lazy" style="width:100%;min-height:700px;border:0"></iframe><p><a href="${escapeAttr(i.url)}" rel="noopener">Open the booking page</a></p></div>`;
    }
    return `<p><a class="button" href="${escapeAttr(i.url)}" rel="noopener">${escapeAttr(integrationButton(i))}</a></p>`;
  });
}

/* ---------- the link check ---------- */

export type LinkResult = { url: string; ok: boolean; detail: string };

/*
  Does each link answer? A HEAD first, then a GET when a server refuses HEAD.
  A site that answers but won't let a checker in (401, 403, 429) counts as
  working: it's there. Not found, a server error or no answer at all don't.

  Redirects are followed here, at most five, and every address is first
  passed to `refuse` (the worker's private-address guard): a link that
  leads to a private address is never opened (13 October 2026, the
  whole-code review).
*/
export async function checkIntegrationLinks(
  urls: string[],
  fetchImpl: typeof fetch,
  timeoutMs = 10_000,
  refuse: (url: string) => Promise<boolean> = async () => false,
): Promise<LinkResult[]> {
  const out: LinkResult[] = [];
  for (const url of [...new Set(urls.filter(Boolean))]) {
    const attempt = async (address: string, method: "HEAD" | "GET") => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetchImpl(address, { method, redirect: "manual", signal: controller.signal, headers: { "user-agent": "TAWD link check (Velocity Media Lab)" } });
      } finally {
        clearTimeout(timer);
      }
    };
    // Only the status and the Location are read: every body is cancelled at once, so no connection is left open (CodeRabbit, PR #13).
    const drop = (response: Response) => void response.body?.cancel().catch(() => undefined);
    const open = async (address: string) => {
      const response = await attempt(address, "HEAD");
      drop(response);
      if (response.status !== 405 && response.status !== 501) return response;
      const got = await attempt(address, "GET");
      drop(got);
      return got;
    };
    try {
      let current = url;
      let response: Response | null = null;
      for (let hop = 0; hop < 6; hop++) {
        if (!/^https?:\/\//i.test(current) || (await refuse(current))) {
          response = null;
          break;
        }
        response = await open(current);
        const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
        if (!location) break;
        current = new URL(location, current).toString();
        response = hop === 5 ? null : response;
      }
      if (!response) {
        out.push({ url, ok: false, detail: "not opened: it leads to a private address, or redirects too often" });
        continue;
      }
      const status = response.status;
      const ok = status < 400 || status === 401 || status === 403 || status === 429;
      out.push({ url, ok, detail: ok ? (status < 400 ? "Answers" : `Answers (${status}, a checker isn't let in)`) : `Answers ${status}` });
    } catch (error) {
      const reason = error instanceof Error && error.name === "AbortError" ? "no answer in time" : "no answer";
      out.push({ url, ok: false, detail: reason });
    }
  }
  return out;
}

/* The checklist line: every tool placed on the site, and every link answering. */
export function integrationsChecklistItem(list: SiteIntegration[], pages: string[], results: LinkResult[] | null): ChecklistItem | null {
  const usable = list.filter((i) => i.url);
  if (usable.length === 0) return null;
  const html = pages.join("\n");
  const missing = usable.filter((i) => !html.includes(escapeAttr(i.url)) && !html.includes(i.url) && !(framed(i) && html.includes(escapeAttr(embedSrc(i.url)!))));
  const broken = results ? usable.flatMap((i) => results.filter((r) => r.url === i.url && !r.ok).map((r) => `${integrationKindLabels[i.kind]} (${r.detail})`)) : [];
  const problems = [...missing.map((i) => `${integrationKindLabels[i.kind]} isn't on the site`), ...broken];
  return {
    key: "integrations",
    label: "Booking, shop, portal and review links placed and working",
    ok: problems.length === 0 && results !== null,
    detail: problems.length ? problems.join("; ") : results === null ? "Placed; the links couldn't be checked" : `${usable.length} link${usable.length === 1 ? "" : "s"}, each on the site and answering`,
    blocksGoLive: true,
  };
}
