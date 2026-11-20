"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import {
  MAX_TRICKLE_WIDTH,
  START_WIDTH,
  progressStore,
  shouldStartForClick,
  trickle,
  type ProgressPhase,
} from "@/lib/progress";

/*
  The top progress bar (DESIGN.md, Components): a 3px line in the logo blue
  across the top of the window while the next screen loads. The rules and
  timing are in lib/progress.ts; this draws the line and ends it when the
  address changes.
*/

const TRICKLE_EVERY_MS = 300;

/** The line's width in %: 0 unless drawn, full while fading. */
export function barWidth(phase: ProgressPhase, trail: number): number {
  if (phase === "finishing") return 100;
  if (phase === "loading") return Math.min(trail, MAX_TRICKLE_WIDTH);
  return 0;
}

export function TopProgress() {
  const pathname = usePathname();
  const search = useSearchParams()?.toString() ?? "";
  const [phase, setPhase] = useState<ProgressPhase>(() => progressStore().phase());
  const [trail, setTrail] = useState(START_WIDTH);

  // The store says when the line shows and goes; each new line starts short.
  useEffect(
    () =>
      progressStore().subscribe((next) => {
        if (next === "loading") setTrail(START_WIDTH);
        setPhase(next);
      }),
    [],
  );

  // The next screen is showing: finish the line.
  useEffect(() => {
    progressStore().done();
  }, [pathname, search]);

  // While loading, the line creeps towards 90%.
  useEffect(() => {
    if (phase !== "loading") return undefined;
    const timer = setInterval(() => setTrail((w) => trickle(w)), TRICKLE_EVERY_MS);
    return () => clearInterval(timer);
  }, [phase]);

  // Forms that end in a redirect, plain internal links (full page loads),
  // and a page the browser shows from its cache (Back after leaving TAWD).
  useEffect(() => {
    // React marks every form action's submit as prevented, so this listens
    // first (capture), and a form that stops its own move (Sign out asking
    // about unsaved changes) calls progressStore().done() itself.
    const onSubmit = (event: SubmitEvent) => {
      const form = event.target;
      if (form instanceof HTMLFormElement && form.hasAttribute("data-progress")) progressStore().start();
    };
    // After React's own handlers (on the document): a <Link> click is
    // already marked prevented by then, and the router hook covers it.
    const onClick = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const anchorLike = { href: anchor.href, target: anchor.target, hasDownload: anchor.hasAttribute("download") };
      if (shouldStartForClick(event, anchorLike, window.location.href)) progressStore().start();
    };
    const onPageShow = () => progressStore().done();
    window.addEventListener("submit", onSubmit, true);
    window.addEventListener("click", onClick);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("submit", onSubmit, true);
      window.removeEventListener("click", onClick);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  const shown = phase === "loading" || phase === "finishing";
  return (
    <div
      className="top-progress"
      data-phase={phase}
      role="progressbar"
      aria-label="Loading the next screen"
      aria-hidden={shown ? undefined : true}
      style={{ width: `${barWidth(phase, trail)}%` }}
    />
  );
}

/**
 * Ends the line when a form marked `data-progress` comes back without
 * moving on (a wrong password, a missing field): pass the form's action
 * state, which changes only when the server answers.
 */
export function useProgressDoneOn(state: unknown): void {
  useEffect(() => {
    progressStore().done();
  }, [state]);
}
