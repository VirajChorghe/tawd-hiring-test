import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AuthLayout } from "@/components/brand/auth-layout";
import { getCurrentUser } from "@/lib/session";

export const metadata: Metadata = { title: "Signed out - TAWD" };
export const dynamic = "force-dynamic";

/* Where Sign out always lands. */
export default async function SignedOutPage() {
  // Somebody still signed in (another tab, the back button) has nothing to
  // be told here.
  const current = await getCurrentUser();
  if (current && !current.isDisabled && !current.mustChangePassword) {
    redirect("/projects");
  }

  return (
    <AuthLayout>
      <div className="signin-form">
        <span className="signed-out-check" aria-hidden="true">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12l5 5L20 7" />
          </svg>
        </span>
        <div>
          <h1 className="section-title signed-out-title">You&apos;re signed out</h1>
          <p className="signin-lede">
            Your session on this device has ended. If you&apos;re on a shared
            computer, you can close this tab.
          </p>
        </div>
        <Link href="/login" className="btn btn-primary signin-submit">
          Sign in again
        </Link>
      </div>
    </AuthLayout>
  );
}
