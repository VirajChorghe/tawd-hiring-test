/*
  Runs once when a TAWD web server starts (Next.js calls register before the
  server takes requests, so nothing here may wait).

  The Site check after each deploy (29 September 2026): on the production
  server only, a light once-a-minute timer starts the $0 check when the
  worker reports this same version. See lib/auto-site-check.ts.

  Connect the domain (F3, 1 October 2026): every 15 minutes, the domains
  clients are changing are checked until their records are right.

  WordPress on 20i (5 October 2026): an hourly tick queues the daily work
  (IP watch, certificate renewals) on the worker when it's due.
*/
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "production") return;
  const [{ getDb }, { scheduleAutoSiteCheck }, { scheduleConnectChecks }, { schedulePurge }, { scheduleDeliveryChecks }, { scheduleWpSitesDaily }, pkg] = await Promise.all([
    import("@tawd/core/db"),
    import("./lib/auto-site-check"),
    import("./lib/connect"),
    import("./lib/forms-relay"),
    import("./lib/delivery-checks"),
    import("./lib/wp-sites-daily"),
    import("../package.json"),
  ]);
  scheduleAutoSiteCheck(getDb(), pkg.default.version);
  // F3: the domains clients are pointing at their new sites, checked every 15 minutes until they're right.
  scheduleConnectChecks(getDb());
  // F2: form messages are kept 90 days (the client's customers' details), then removed, once a day.
  schedulePurge(getDb());
  // F4: each live site's form once a week, the test inboxes once a month.
  scheduleDeliveryChecks(getDb());
  // 20i: the IP watch and certificate renewals, at most once every 20 hours (the worker does the work).
  scheduleWpSitesDaily(getDb());
}
