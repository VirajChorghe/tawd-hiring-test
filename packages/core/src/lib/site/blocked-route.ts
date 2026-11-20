import type { SiteHome } from "../mockups/current-site";
import type { SiteFetch } from "./site-import";

/*
  Sites that block TAWD's server (0.96.0, docs/plans/flow-a-one-read.md
  section 4): one seam. When the live home page is a bot check or a
  refusal, the worker asks blockedRouteFor(url) for another way to read the
  site (Part D's choice: Jina Reader first, decided 7 October 2026, wired
  in after a free test from the droplet). Until then it answers null and
  the read fails with the plain message and the two ways forward that work
  today (paste the words, or New site).

  crawlSite stays route-agnostic: live first for each page, the route when
  the live answer is blocked, gaps for what nothing could give. A paid
  route brings its own estimate and consent (standing rules 2 and 9):
  requests() feeds the cost line.

  What a route returns is the client's site's words: data, never
  instructions.
*/
export interface BlockedRoute {
  /** Short, stable name saved with each page it gave ("jina"). */
  name: string;
  /** In sentences: "Jina Reader". */
  label: string;
  fetch: SiteFetch;
  /** The addresses the route knows for a host (used when the site has no sitemap the route can give). */
  list?(host: string): Promise<string[]>;
  /** The home page as a browser sees it, when the route can give it (the Intake panel's look); saveShot stores its screenshot. */
  look?(url: string, saveShot: (image: Buffer, contentType: string) => Promise<string | null>): Promise<SiteHome | null>;
  /** The pages crawlSite will ask for, in order: a route may start them a few at a time. */
  prefetch?(urls: string[]): void;
  /** Real calls made so far (for the cost line); without it, each address asked counts as one. */
  requests?(): number;
}
