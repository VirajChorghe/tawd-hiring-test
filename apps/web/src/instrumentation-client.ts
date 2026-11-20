/*
  Runs in the browser before TAWD's screens start (Next.js 15.3+). The
  server side is instrumentation.ts, which stays as it is.

  The top progress bar (0.95.0): Next calls onRouterTransitionStart at the
  start of every <Link> click, router.push/replace and Back/Forward (not on
  router.refresh(), so saves that stay on the same screen show nothing).
  See lib/progress.ts.
*/
import { isRealMove, progressStore } from "@/lib/progress";

export function onRouterTransitionStart(url: string): void {
  if (isRealMove(url, window.location.href)) progressStore().start();
}
