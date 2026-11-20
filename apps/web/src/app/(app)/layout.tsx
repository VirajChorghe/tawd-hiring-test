import type { ReactNode } from "react";

import { SpendWarning } from "@/components/spend-warning";
import { PrivacyLawReminder } from "@/components/privacy-law-reminder";
import { SiteCheckWarning } from "@/components/site-check-warning";
import { TopBar } from "@/components/ui/top-bar";
import { can } from "@tawd/core/permissions";
import { requireUser } from "@/lib/session";

/*
  The guard for every signed-in page.

  requireUser sends anyone not signed in to the login page, anyone disabled
  back out, and anyone still on a temporary password to change it. Because it
  reads the user row on each request, disabling somebody takes effect on their
  very next page load.
*/
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const current = await requireUser();

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <TopBar
        user={{
          email: current.email,
          canManageUsers: can(current, "user.manage"),
          canViewActivity: can(current, "activity.view_all"),
          canViewSpend: can(current, "spend.view"),
          canViewMoney: can(current, "money.manage"),
          canViewPrivacyLaws: can(current, "settings.manage"),
        }}
      />

      {can(current, "settings.manage") ? <SpendWarning /> : null}
      {can(current, "settings.manage") ? <PrivacyLawReminder /> : null}
      {can(current, "settings.manage") ? <SiteCheckWarning /> : null}

      <div id="main">{children}</div>
    </>
  );
}
