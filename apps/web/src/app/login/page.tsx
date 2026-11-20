import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthLayout } from "@/components/brand/auth-layout";
import { getCurrentUser } from "@/lib/session";
import { SignInForm } from "./form";

export const metadata: Metadata = { title: "Sign in - TAWD" };
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; reset?: string }>;
}) {
  const current = await getCurrentUser();
  if (current && !current.isDisabled) {
    redirect(current.mustChangePassword ? "/change-password" : "/");
  }

  const { error, reset } = await searchParams;

  return (
    <AuthLayout>
      <SignInForm
        initialError={
          error === "disabled"
            ? "That account has been disabled. Speak to a TAWD admin if this is wrong."
            : null
        }
        initialNotice={reset === "1" ? "Your password is changed. Sign in with the new one." : null}
      />
    </AuthLayout>
  );
}
