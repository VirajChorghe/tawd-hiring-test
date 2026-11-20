import { describe, expect, it } from "vitest";

import { GET, POST } from "@/app/api/auth/[...all]/route";

/*
  C4 (audit F-022): Better Auth's HTTP endpoints went round TAWD's per-email
  lockout and its record (12 tries from 12 forwarded addresses, never
  refused, nothing logged), and the admin plugin's impersonation endpoint was
  reachable. TAWD calls Better Auth only on the server, so every HTTP path
  here is closed.
*/

const paths = ["/api/auth/sign-in/email", "/api/auth/admin/impersonate-user", "/api/auth/admin/list-users", "/api/auth/admin/create-user", "/api/auth/get-session", "/api/auth/sign-up/email"];

describe("the Better Auth HTTP endpoints", () => {
  it("answer 404 to every path, by POST and by GET", async () => {
    for (const path of paths) {
      const post = await POST(new Request(`https://tawd.example${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.1" }, body: JSON.stringify({ email: "a@b.example", password: "wrong-password" }) }));
      expect(post.status, path).toBe(404);
      const get = await GET(new Request(`https://tawd.example${path}`));
      expect(get.status, path).toBe(404);
    }
  });
});
