/*
  A site that shows TAWD a bot check instead of its pages (6 October 2026,
  docs/plans/blocked-sites-and-makeover-words.md). Finley Pest Control's
  host answered TAWD's server with "One moment, please... Please wait while
  your request is being verified..." and TAWD kept that as the client's
  words. Code only: a short page with a known check's wording, or a refusal
  (403, 429, 503) with almost no words. A real page that mentions
  "verified" is long, so it's never caught.
*/

export interface BotCheck {
  /** "check": a known bot check's page; "refused": a refusal with almost no words (could be maintenance). */
  kind: "check" | "refused";
  /** What the page said, for the message: its title or the matched words. */
  said: string;
  status: number;
}

/** Only this much of a page is looked at, so a 6 MB page isn't scanned. */
const SAMPLE = 20_000;
/** A check page is short; past this many visible words it's a real page. */
const MAX_CHECK_WORDS = 400;
const MAX_REFUSAL_WORDS = 50;

const PHRASES: { re: RegExp; said?: string }[] = [
  { re: /please wait while your request is being verified/i },
  { re: /\bone moment,? please\b/i },
  { re: /sgcaptcha/i, said: "a SiteGround bot check" },
  { re: /\bjust a moment\.\.\./i },
  { re: /checking (?:if the site connection is secure|your browser)/i },
  { re: /verify(?:ing)? (?:that )?you are (?:a )?human/i },
  { re: /\bcf[-_]chl/i, said: "a Cloudflare bot check" },
  { re: /attention required! \| cloudflare/i },
  { re: /sucuri website firewall/i },
  { re: /ddos protection by/i },
  { re: /are you a robot\??/i },
  { re: /request unsuccessful\. incapsula/i },
];

function visibleText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function titleOf(html: string): string {
  return visibleText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
}

/* The page a site answered with: a bot check, a bare refusal, or null (a real page). */
export function botCheck(page: { status: number; text: string; title?: string }): BotCheck | null {
  const html = page.text.slice(0, SAMPLE);
  const title = (page.title ?? titleOf(html)).trim();
  const text = visibleText(html);
  const words = text ? text.split(" ").length : 0;
  if (words <= MAX_CHECK_WORDS) {
    // The page's title, when it's the check's own, is what the team would see in a browser tab.
    if (title && PHRASES.some((p) => !p.said && p.re.test(title))) return { kind: "check", said: title.slice(0, 80), status: page.status };
    for (const phrase of PHRASES) {
      // A marker only in the page's code (a named check) counts on a near-empty page only: some hosts add their scripts to every page.
      const hit = phrase.re.exec(text) ?? (phrase.said && words < MAX_REFUSAL_WORDS ? phrase.re.exec(html) : null);
      if (hit) return { kind: "check", said: (phrase.said ?? hit[0]).slice(0, 80), status: page.status };
    }
    if (page.status === 403 && /access denied/i.test(`${title} ${text}`)) return { kind: "check", said: "Access denied", status: page.status };
  }
  if ((page.status === 403 || page.status === 429 || page.status === 503) && words < MAX_REFUSAL_WORDS) return { kind: "refused", said: title, status: page.status };
  return null;
}

const hostName = (url: string) => {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/* The plain-English line for the team: what the site did, never "it's empty". */
export function botCheckMessage(siteUrl: string, check: BotCheck): string {
  const host = hostName(siteUrl);
  return check.kind === "check"
    ? `${host} showed TAWD a bot check ("${check.said}") instead of its pages, so nothing was read.`
    : `${host} refused or blocked TAWD's server (${check.status}), so nothing was read.`;
}

/*
  A site that blocks TAWD's server (0.96.0, docs/plans/flow-a-one-read.md
  section 4): said plainly, with what was seen, and that reading again
  won't help. Never "try again later": until a blocked route is wired in
  (Part D), the ways forward are the two that work today.
*/
export function blockedSiteMessage(siteUrl: string, check: BotCheck): string {
  const host = hostName(siteUrl);
  const seen = check.kind === "check" ? `it showed a bot check, "${check.said}"` : `it refused the request with ${check.status}`;
  return `${host} blocks TAWD's server (${seen}), so its pages can't be read from here. Reading again won't change that.`;
}

/*
  A host that doesn't answer TAWD's server at all (Fable's review M5): a
  shield that drops data-centre connections looks like this. Treated as
  blocked, so the paid routes get their turn.
*/
export function noAnswerMessage(siteUrl: string): string {
  return `${hostName(siteUrl)} didn't answer TAWD's server. If the site opens in your browser, its host is blocking servers like TAWD's, so its pages can't be read from here. Reading again won't change that.`;
}

/* What the team can do next when a read failed, picked by name. The paste and New site ways always work. */
export const WAYS_FORWARD = {
  readAgain: "Read again: the site didn't answer this time.",
  paste: "Paste the words: choose the project type “The client is sending their own words” in the intake's Content section.",
  newSite: "Let TAWD write new words: choose the project type “Everything new” in the intake's Content section.",
} as const;

/* A blocked site: Read again isn't a way forward (it can't change anything). */
export const BLOCKED_WAYS_FORWARD = [WAYS_FORWARD.paste, WAYS_FORWARD.newSite] as const;

/* The ways forward for a failure line: a blocked site's two, or Read again first for anything else. */
export function waysForwardFor(failure: string | null | undefined): string[] {
  // A site drawn only by JavaScript won't read better a second time either (Fable's review L4).
  return isBlockedMessage(failure) || /draws its words with JavaScript/.test(failure ?? "") ? [...BLOCKED_WAYS_FORWARD] : [WAYS_FORWARD.readAgain, WAYS_FORWARD.paste, WAYS_FORWARD.newSite];
}

/* A read saved before this check existed whose words are a bot check (Finley's, 6 October 2026). */
export function savedWordsBotCheck(title: string, words: string[]): BotCheck | null {
  return botCheck({ status: 200, title, text: words.join(" ") });
}

/* The failure line came from a blocked read (botCheckMessage). */
export function isBlockedMessage(text: string | null | undefined): boolean {
  return Boolean(text && /showed TAWD a bot check|refused or blocked TAWD's server|blocks TAWD's server|blocking servers like TAWD's/.test(text));
}
