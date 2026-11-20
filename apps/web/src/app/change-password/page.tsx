import type { Metadata } from "next";

import { AuthLayout } from "@/components/brand/auth-layout";
import { requireUserPendingPasswordChange } from "@/lib/session";
import { ChangePasswordForm } from "./form";

export const metadata: Metadata = { title: "Choose a password - TAWD" };
export const dynamic = "force-dynamic";

/*
  First sign-in: swap the temporary password for one only you know. Later,
  "Change password" under your email in the top bar comes here too.
*/
export default async function ChangePasswordPage() {
  const current = await requireUserPendingPasswordChange();

  return (
    <AuthLayout>
      <ChangePasswordForm email={current.email} forced={current.mustChangePassword} />
    </AuthLayout>
  );
}
