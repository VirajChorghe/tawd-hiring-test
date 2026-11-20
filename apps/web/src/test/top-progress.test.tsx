import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  The top progress bar (0.95.0, Jason 7 October 2026): a 3px line in the
  logo blue while the next screen loads, shown after 150 ms, always gone by
  15 s, never for links that don't load another TAWD screen.
*/

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects",
  useSearchParams: () => new URLSearchParams("month=2026-10"),
}));

import { TopProgress, barWidth } from "@/components/ui/top-progress";
import { onRouterTransitionStart } from "@/instrumentation-client";
import {
  FADE_MS,
  MAX_MS,
  MAX_TRICKLE_WIDTH,
  SHOW_DELAY_MS,
  START_WIDTH,
  createProgressStore,
  isRealMove,
  progressStore,
  shouldStartForClick,
  trickle,
} from "@/lib/progress";

const here = "https://tawd.velocitymedialab.com/projects/p1?tab=history";

describe("isRealMove", () => {
  it("is a move to another path or another query", () => {
    expect(isRealMove("/projects/p1/build", here)).toBe(true);
    expect(isRealMove("/projects/p1?tab=settings", here)).toBe(true);
    expect(isRealMove("/projects/p1", here)).toBe(true);
    expect(isRealMove("https://tawd.velocitymedialab.com/projects", here)).toBe(true);
  });

  it("is not a move for the same page, a hash, another site, mailto or tel", () => {
    expect(isRealMove("/projects/p1?tab=history", here)).toBe(false);
    expect(isRealMove("#invoice-title", here)).toBe(false);
    expect(isRealMove("/projects/p1?tab=history#main", here)).toBe(false);
    expect(isRealMove("https://example.com/projects", here)).toBe(false);
    expect(isRealMove("mailto:team@velocitymedialab.com", here)).toBe(false);
    expect(isRealMove("tel:+19165550142", here)).toBe(false);
    expect(isRealMove("http://[bad", here)).toBe(false);
  });
});

describe("shouldStartForClick", () => {
  const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
  const link = { href: "https://tawd.velocitymedialab.com/projects/p1/updates", target: "", hasDownload: false };

  it("starts for a plain left click on an internal link", () => {
    expect(shouldStartForClick(click, link, here)).toBe(true);
    expect(shouldStartForClick(click, { ...link, target: "_self" }, here)).toBe(true);
  });

  it("never starts for a new tab, a modifier key or the middle button", () => {
    for (const key of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
      expect(shouldStartForClick({ ...click, [key]: true }, link, here)).toBe(false);
    }
    expect(shouldStartForClick({ ...click, button: 1 }, link, here)).toBe(false);
    expect(shouldStartForClick(click, { ...link, target: "_blank" }, here)).toBe(false);
  });

  it("never starts for downloads, files, other sites, hashes or a click someone else handled", () => {
    expect(shouldStartForClick(click, { ...link, hasDownload: true }, here)).toBe(false);
    expect(shouldStartForClick(click, { ...link, href: `${link.href}?download=1` }, here)).toBe(false);
    expect(shouldStartForClick(click, { ...link, href: "https://tawd.velocitymedialab.com/api/files/1" }, here)).toBe(false);
    expect(shouldStartForClick(click, { ...link, href: "https://www.netlify.com/" }, here)).toBe(false);
    expect(shouldStartForClick(click, { ...link, href: `${here}#main` }, here)).toBe(false);
    // Next's <Link> prevents its click; the router hook covers it instead.
    expect(shouldStartForClick({ ...click, defaultPrevented: true }, link, here)).toBe(false);
  });
});

describe("the store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows only after the delay, and finishes then goes idle", () => {
    const store = createProgressStore();
    const seen: string[] = [];
    store.subscribe((phase) => seen.push(phase));
    store.start();
    expect(store.phase()).toBe("waiting");
    vi.advanceTimersByTime(SHOW_DELAY_MS - 1);
    expect(store.phase()).toBe("waiting");
    vi.advanceTimersByTime(1);
    expect(store.phase()).toBe("loading");
    store.done();
    expect(store.phase()).toBe("finishing");
    vi.advanceTimersByTime(FADE_MS);
    expect(store.phase()).toBe("idle");
    expect(seen).toEqual(["waiting", "loading", "finishing", "idle"]);
  });

  it("never draws a quick move", () => {
    const store = createProgressStore();
    const seen: string[] = [];
    store.subscribe((phase) => seen.push(phase));
    store.start();
    vi.advanceTimersByTime(SHOW_DELAY_MS - 10);
    store.done();
    vi.advanceTimersByTime(MAX_MS);
    expect(seen).toEqual(["waiting", "idle"]);
  });

  it("ends by itself at 15 s", () => {
    const store = createProgressStore();
    store.start();
    vi.advanceTimersByTime(MAX_MS - 1);
    expect(store.phase()).toBe("loading");
    vi.advanceTimersByTime(1);
    expect(store.phase()).toBe("finishing");
    vi.advanceTimersByTime(FADE_MS);
    expect(store.phase()).toBe("idle");
  });

  it("starts cleanly again after it ended, and a second click keeps the same line", () => {
    const store = createProgressStore();
    store.start();
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    store.start();
    expect(store.phase()).toBe("loading");
    // The second start resets the 15 s cap.
    vi.advanceTimersByTime(MAX_MS - 1);
    expect(store.phase()).toBe("loading");
    store.done();
    vi.advanceTimersByTime(FADE_MS);
    store.start();
    expect(store.phase()).toBe("waiting");
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(store.phase()).toBe("loading");
  });

  it("does nothing when done is called while idle; an unsubscribed listener hears nothing", () => {
    const store = createProgressStore();
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    store.done();
    expect(listener).not.toHaveBeenCalled();
    stop();
    store.start();
    expect(listener).not.toHaveBeenCalled();
  });

  it("the router hook starts it for a real move only", () => {
    vi.stubGlobal("window", { location: { href: here } });
    try {
      onRouterTransitionStart("/projects/p1?tab=history");
      expect(progressStore().phase()).toBe("idle");
      onRouterTransitionStart("/projects/p1/content");
      expect(progressStore().phase()).toBe("waiting");
      progressStore().done();
      expect(progressStore().phase()).toBe("idle");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the line", () => {
  it("creeps towards 90% and never past it", () => {
    expect(trickle(0)).toBe(START_WIDTH);
    let width = START_WIDTH;
    for (let i = 0; i < 200; i += 1) {
      const next = trickle(width);
      expect(next).toBeGreaterThanOrEqual(width);
      width = next;
    }
    expect(width).toBeLessThanOrEqual(MAX_TRICKLE_WIDTH);
    expect(width).toBeGreaterThan(85);
    expect(barWidth("loading", 120)).toBe(MAX_TRICKLE_WIDTH);
    expect(barWidth("finishing", 40)).toBe(100);
    expect(barWidth("idle", 40)).toBe(0);
    expect(barWidth("waiting", 40)).toBe(0);
  });

  it("renders hidden, with its role and label", () => {
    const html = renderToStaticMarkup(<TopProgress />);
    expect(html).toContain('class="top-progress"');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-label="Loading the next screen"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-phase="idle"');
    expect(html).toContain("width:0%");
  });

  it("is in the root layout, 3px of the logo blue, still under reduced motion", () => {
    const src = (file: string) => readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
    expect(src("app/layout.tsx")).toContain("<TopProgress />");
    const css = src("app/globals.css");
    expect(css).toContain("--logo-blue: #2b59ff;");
    const block = css.slice(css.indexOf(".top-progress {"), css.indexOf("}", css.indexOf(".top-progress {")));
    expect(block).toContain("height: 3px;");
    expect(block).toContain("background: var(--logo-blue);");
    expect(block).not.toContain("gradient");
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.top-progress \{\s*transition: none;/);
  });

  it("every form whose server action ends in redirect() starts it", () => {
    const src = (file: string) => readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
    const forms = ["app/login/form.tsx", "app/change-password/form.tsx", "app/reset-password/form.tsx", "components/project-form.tsx"];
    for (const file of forms) {
      const text = src(file);
      expect(text, file).toMatch(/<form [^>]*data-progress/);
      expect(text, file).toContain("useProgressDoneOn(state)");
    }
    expect(src("components/ui/top-bar.tsx")).toMatch(/action=\{signOutAction\}\s*data-progress/);
    // The six redirecting actions: sign in, sign out, change password,
    // new project, edit project, reset password. A new one needs a form here.
    const actions = src("app/actions.ts");
    expect(actions.match(/^\s*(if \(.*\) )?redirect\(/gm)?.length).toBe(6);
  });
});
