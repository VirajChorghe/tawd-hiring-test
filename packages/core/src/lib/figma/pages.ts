/*
  The design's pages (28 September 2026, Lane 2 Option A "build it exactly",
  and any design with more than one page): each desktop frame is a page of
  the site, the first (or the one named home) the home page; a mobile frame
  is paired with its desktop page by name, or by order when the names don't
  say. The PM confirms the page names and addresses before the copies are
  built.
*/

export interface FrameForPages {
  id: string;
  name: string;
  width: number;
  height: number;
  isHome: boolean;
}

const MOBILE_WORDS = /\b(mobile|phone|iphone|android|small|sm|mob)\b|[-_ ](m|xs)$/i;

/*
  Below this width a frame named for a phone ("Home - Mobile") is a phone
  version; at a desktop width the words are part of the page's name ("Phone
  Repair" at 1440). 1200, not 600: an uploaded phone screenshot at 3x is
  about 1170 pixels wide (13 October 2026, the whole-code review).
*/
const NARROW_WITH_WORDS = 1200;

export function frameRole(frame: FrameForPages): "desktop" | "mobile" {
  if (frame.width < 600) return "mobile";
  return frame.width < NARROW_WITH_WORDS && MOBILE_WORDS.test(frame.name.replace(/[_-]/g, " ")) ? "mobile" : "desktop";
}

/* A frame's name without the words that say which screen it's for, to pair desktop and mobile frames. */
export function baseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\b(mobile|phone|iphone|android|desktop|web|tablet|small|large|sm|lg|mob|dt|\d{3,4}(px)?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function slugFor(name: string, isHome: boolean): string {
  if (isHome) return "";
  return (
    name
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "page"
  );
}

export interface ProposedPage {
  frameId: string;
  frameName: string;
  name: string;
  slug: string;
  isHome: boolean;
  mobileFrameId: string | null;
  position: number;
}

export function proposePages(frames: FrameForPages[]): ProposedPage[] {
  const desktop = frames.filter((f) => frameRole(f) === "desktop");
  const mobile = frames.filter((f) => frameRole(f) === "mobile");
  const pairs = new Map<string, string>();
  const free = [...mobile];
  // By name first ("Home" and "Home - Mobile"), then the rest in order.
  for (const d of desktop) {
    const match = free.find((m) => baseName(m.name) === baseName(d.name) && baseName(d.name) !== "");
    if (match) {
      pairs.set(d.id, match.id);
      free.splice(free.indexOf(match), 1);
    }
  }
  if (free.length > 0 && free.length === desktop.filter((d) => !pairs.has(d.id)).length) {
    for (const d of desktop.filter((x) => !pairs.has(x.id))) pairs.set(d.id, free.shift()!.id);
  }
  const homeIndex = Math.max(0, desktop.findIndex((d) => d.isHome));
  return desktop.map((d, position) => {
    const isHome = position === homeIndex;
    const name = isHome ? "Home" : d.name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().replace(/^./, (c) => c.toUpperCase());
    return { frameId: d.id, frameName: d.name, name, slug: slugFor(name, isHome), isHome, mobileFrameId: pairs.get(d.id) ?? null, position };
  });
}

/* A PM's page names and addresses, checked: one home, addresses unique and web-safe. */
export function checkPages(pages: { name: string; slug: string; isHome: boolean }[]): string | null {
  if (pages.filter((p) => p.isHome).length !== 1) return "Exactly one page is the home page.";
  const slugs = pages.filter((p) => !p.isHome).map((p) => p.slug.trim());
  if (slugs.some((s) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s))) return "Each address is lower-case letters, numbers and dashes (for example about-us).";
  if (new Set(slugs).size !== slugs.length) return "Two pages have the same address.";
  if (pages.some((p) => !p.name.trim())) return "Every page needs a name.";
  return null;
}
