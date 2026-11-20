import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthLayout } from "@/components/brand/auth-layout";
import { getCurrentUser } from "@/lib/session";
import { ForgotPasswordForm } from "./form";

export const metadata: Metadata = { title: "Forgot password - TAWD" };
export const dynamic = "force-dynamic";

/* "Forgot password?" from Sign in: the email address, then always the same answer. */
export default async function ForgotPasswordPage() {
  const current = await getCurrentUser();
  if (current && !current.isDisabled) redirect("/change-password");
  return (
    <AuthLayout>
      <ForgotPasswordForm />
    </AuthLayout>
  );
}
