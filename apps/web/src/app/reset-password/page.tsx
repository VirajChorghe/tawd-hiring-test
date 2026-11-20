import type { Metadata } from "next";

import { AuthLayout } from "@/components/brand/auth-layout";
import { ResetPasswordForm } from "./form";

export const metadata: Metadata = { title: "Set a new password - TAWD" };
export const dynamic = "force-dynamic";

/*
  The page the emailed link opens. The link is only checked when the new
  password is saved (Better Auth uses it up then), so a used or expired one
  says so at that point.
*/
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <AuthLayout>
      <ResetPasswordForm token={token ?? ""} />
    </AuthLayout>
  );
}
