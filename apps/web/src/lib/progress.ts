/*
  The top progress bar (0.95.0, Jason 7 October 2026; plan
  docs/plans/top-progress-bar.md).

  A thin line at the very top of the window while the next screen loads.
  This file has no React and no DOM, so the rules and the timing are tested
  on their own: the store says when the line shows and when it goes, and
  components/ui/top-progress.tsx draws it.

  - It starts on every move Next.js makes (src/instrumentation-client.ts),
    on the forms marked `data-progress` (server actions that end in
    redirect()) and on plain internal links (full page loads).
  - It shows only after SHOW_DELAY_MS, so quick moves never flicker.
  - It always ends: when the address changes, when the browser shows a
    cached page, or after MAX_MS at the latest.
  - router.refresh() after a save stays on the same screen and never starts
    it (Jason's decision 3).
*/

export const SHOW_DELAY_MS = 150;
export const MAX_MS = 15_000;
/** How long the line takes to fill and fade once the next screen shows (globals.css: 150 ms fill, 200 ms fade). */
export const FADE_MS = 400;
/** Where the line starts, and the most it creeps to before the screen arrives. */
export const START_WIDTH = 8;
export const MAX_TRICKLE_WIDTH = 90;

/**
 * idle: nothing. waiting: started, inside the show delay (not drawn).
 * loading: drawn and creeping. finishing: full width, fading out.
 */
export type ProgressPhase = "idle" | "waiting" | "loading" | "finishing";

export interface ProgressStore {
  start(): void;
  done(): void;
  phase(): ProgressPhase;
  subscribe(listener: (phase: ProgressPhase) => void): () => void;
}

export function createProgressStore(): ProgressStore {
  let current: ProgressPhase = "idle";
  const listeners = new Set<(phase: ProgressPhase) => void>();
  let showTimer: ReturnType<typeof setTimeout> | null = null;
  let capTimer: ReturnType<typeof setTimeout> | null = null;
  let fadeTimer: ReturnType<typeof setTimeout> | null = null;

  const set = (next: ProgressPhase) => {
    if (next === current) return;
    current = next;
    for (const listener of listeners) listener(next);
  };
  const clear = () => {
    if (showTimer) clearTimeout(showTimer);
    if (capTimer) clearTimeout(capTimer);
    if (fadeTimer) clearTimeout(fadeTimer);
    showTimer = capTimer = fadeTimer = null;
  };

  const done = () => {
    if (current === "idle" || current === "finishing") return;
    const wasShown = current === "loading";
    clear();
    if (!wasShown) {
      set("idle");
      return;
    }
    set("finishing");
    fadeTimer = setTimeout(() => {
      fadeTimer = null;
      set("idle");
    }, FADE_MS);
  };

  return {
    start() {
      // A second move while one is loading carries on with the same line.
      if (current === "waiting" || current === "loading") {
        if (capTimer) clearTimeout(capTimer);
        capTimer = setTimeout(done, MAX_MS);
        return;
      }
      clear();
      set("waiting");
      showTimer = setTimeout(() => {
        showTimer = null;
        set("loading");
      }, SHOW_DELAY_MS);
      capTimer = setTimeout(done, MAX_MS);
    },
    done,
    phase: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/*
  One store per browser tab. Kept on globalThis so the router hook
  (instrumentation-client.ts, its own entry) and the component always share
  it, however the bundler splits them.
*/
const globalKey = "__tawdTopProgress";
export function progressStore(): ProgressStore {
  const holder = globalThis as typeof globalThis & { [globalKey]?: ProgressStore };
  const store = holder[globalKey] ?? createProgressStore();
  holder[globalKey] = store;
  return store;
}

/** The next width while loading: a step towards MAX_TRICKLE_WIDTH, smaller the closer it gets. */
export function trickle(width: number): number {
  if (width < START_WIDTH) return START_WIDTH;
  if (width >= MAX_TRICKLE_WIDTH) return MAX_TRICKLE_WIDTH;
  const next = width + (MAX_TRICKLE_WIDTH - width) * 0.1;
  return Math.min(MAX_TRICKLE_WIDTH, Math.round(next * 10) / 10);
}

function parse(url: string, base?: string): URL | null {
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
}

/**
 * Whether moving to `target` loads another screen of TAWD: false for the
 * same path and query (a hash-only link, the same page), other sites,
 * mailto: and tel:. A different query (a filter, a month) is a move.
 */
export function isRealMove(target: string, current: string): boolean {
  const from = parse(current);
  const to = parse(target, current);
  if (!from || !to) return false;
  if (to.protocol !== "http:" && to.protocol !== "https:") return false;
  if (to.origin !== from.origin) return false;
  return to.pathname !== from.pathname || to.search !== from.search;
}

export interface ClickLike {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}

export interface AnchorLike {
  href: string;
  target: string;
  hasDownload: boolean;
}

/**
 * Whether a click on a plain link loads the next TAWD screen in this tab.
 * Next's own <Link> prevents the click and is covered by the router hook,
 * so a prevented click is ignored here. New tabs (modifier keys, middle
 * click, a target), downloads (the attribute, ?download=1, files under
 * /api/) and other sites never start the line.
 */
export function shouldStartForClick(click: ClickLike, anchor: AnchorLike, current: string): boolean {
  if (click.defaultPrevented) return false;
  if (click.button !== 0) return false;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return false;
  if (anchor.target && anchor.target !== "_self") return false;
  if (anchor.hasDownload) return false;
  const to = parse(anchor.href, current);
  if (!to) return false;
  if (to.searchParams.has("download")) return false;
  if (to.pathname.startsWith("/api/")) return false;
  return isRealMove(to.href, current);
}
