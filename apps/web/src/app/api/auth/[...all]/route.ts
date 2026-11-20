/*
  Better Auth's HTTP endpoints are closed (C4, audit F-022, 12 November 2026).

  TAWD never calls them from the browser: signing in, signing out, changing
  or resetting a password, reading the session and creating a user all run
  on the server through `getAuth().api` (lib/sign-in.ts, lib/session.ts, ...),
  and the reset email links to TAWD's own /reset-password page. But the
  endpoints were mounted here, and the audit showed what that cost:
  - POST /api/auth/sign-in/email skipped TAWD's per-email lockout and its
    "login.failed" record, limited only per IP, from a header the caller
    could change on every try (12 failures, 12 different addresses, never
    refused, 0 rows in login_attempt);
  - the admin plugin's endpoints, impersonation among them, were reachable
    for any admin session and wrote nothing to the activity log.

  So every request here gets a 404. If a browser-side Better Auth call is
  ever needed, open only that one path here, and give it TAWD's lockout and
  its record first.
*/
export const dynamic = "force-dynamic";

async function closed(request: Request): Promise<Response> {
  void request;
  return new Response("Not found", { status: 404 });
}

export { closed as GET, closed as POST };
