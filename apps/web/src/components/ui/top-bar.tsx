"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { signOutAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { progressStore } from "@/lib/progress";
import { unsavedChanges } from "@/lib/unsaved";

/*
  The top bar, on every signed-in page.

  The compact logo links to Projects. Sign out goes straight through unless
  the page has unsaved changes, in which case it asks first, naming what
  would be lost. Either way it lands on the Signed-out page.
*/

export interface TopBarUser {
  email: string;
  canManageUsers: boolean;
  canViewActivity: boolean;
  canViewSpend: boolean;
  /** Revenue and Pricing (admins). */
  canViewMoney?: boolean;
  /** The state privacy rules (admins). */
  /** settings.manage: Privacy laws and the hosting settings (System). */
  canViewPrivacyLaws?: boolean;
}

export function TopBar({ user }: { user?: TopBarUser }) {
  const pathname = usePathname();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [signingOut, startSigningOut] = useTransition();
  const [adminOpen, setAdminOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // The Admin menu (29 September 2026): four groups, each link shown only to who may open it.
  const groups = user
    ? [
        { title: "People", links: [
          { href: "/admin/users", label: "Team", show: user.canManageUsers },
          { href: "/admin/activity", label: "Activity", show: user.canViewActivity },
        ] },
        { title: "Money", links: [
          { href: "/admin/spend", label: "Spend", show: user.canViewSpend },
          { href: "/admin/revenue", label: "Revenue", show: Boolean(user.canViewMoney) },
          { href: "/admin/pricing", label: "Pricing", show: Boolean(user.canViewMoney) },
        ] },
        { title: "Rules", links: [
          { href: "/admin/privacy-laws", label: "Privacy laws", show: Boolean(user.canViewPrivacyLaws) },
          { href: "/runbook", label: "Run book", show: true },
        ] },
        { title: "System", links: [
          { href: "/admin/system#site-check", label: "Site check", show: Boolean(user.canViewPrivacyLaws) },
          { href: "/admin/system#hosting", label: "Hosting connections", show: Boolean(user.canViewPrivacyLaws) },
          { href: "/admin/failures", label: "Failed jobs", show: Boolean(user.canViewPrivacyLaws) },
        ] },
      ]
        .map((g) => ({ ...g, links: g.links.filter((l) => l.show) }))
        .filter((g) => g.links.some((l) => l.href !== "/runbook"))
    : [];
  const isAdminMenu = groups.length > 0;

  const links = user
    ? [
        { href: "/projects", label: "Projects", show: true },
        { href: "/my-work", label: "My work", show: true },
        // Admins find the Run book in the Admin menu.
        { href: "/runbook", label: "Run book", show: !isAdminMenu },
      ].filter((link) => link.show)
    : [];
  const onAdminPage = pathname.startsWith("/admin/") || (isAdminMenu && pathname === "/runbook");

  useEffect(() => {
    if (!adminOpen) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !menuRef.current?.contains(event.target as Node)) setAdminOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [adminOpen]);

  return (
    <header className="topbar">
      <div className="topbar-left">
        <Link
          href={user ? (isAdminMenu ? "/projects" : "/my-work") : "/login"}
          className="topbar-logo"
          aria-label="TAWD home"
        >
          {/* A plain img: an SVG with outlined lettering needs no optimizing. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/tawd-logo-compact.svg" alt="tawd" height={30} />
        </Link>

        {links.length > 0 ? (
          <nav className="topbar-nav" aria-label="Main">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={pathname === link.href || pathname.startsWith(`${link.href}/`) ? "page" : undefined}
              >
                {link.label}
              </Link>
            ))}
            {isAdminMenu ? (
              <div className="admin-menu" ref={menuRef}>
                <button
                  type="button"
                  className="admin-menu-button"
                  aria-expanded={adminOpen}
                  aria-haspopup="true"
                  aria-current={onAdminPage ? "page" : undefined}
                  onClick={() => setAdminOpen((open) => !open)}
                >
                  Admin
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
                {adminOpen ? (
                  <div className="admin-menu-panel">
                    {groups.map((group) => (
                      <div key={group.title} className="admin-menu-group">
                        <p className="admin-menu-heading">{group.title}</p>
                        {group.links.map((link) => (
                          <Link key={link.href} href={link.href} className="admin-menu-link" onClick={() => setAdminOpen(false)}>
                            {link.label}
                          </Link>
                        ))}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </nav>
        ) : null}
      </div>

      {user ? (
        <div className="topbar-right">
          <div className="topbar-account">
            <span className="topbar-email">{user.email}</span>
            <Link href="/change-password" className="topbar-account-link">
              Change password
            </Link>
          </div>
          <form
            action={signOutAction}
            data-progress
            onSubmit={(event) => {
              const pending = unsavedChanges();
              if (pending) {
                event.preventDefault();
                // Staying here to ask first: the top progress bar stops.
                progressStore().done();
                setConfirming(pending);
              }
            }}
          >
            <button type="submit" className="btn btn-secondary btn-small">
              Sign out
            </button>
          </form>
        </div>
      ) : null}

      {confirming ? (
        <SignOutConfirm
          description={confirming}
          busy={signingOut}
          onStay={() => setConfirming(null)}
          // The action itself, past the check that opened this dialog.
          onSignOut={() => {
            progressStore().start();
            startSigningOut(() => signOutAction());
          }}
        />
      ) : null}
    </header>
  );
}

/* "Sign out of TAWD?", only when the page has unsaved changes. */
export function SignOutConfirm({
  description,
  busy,
  onStay,
  onSignOut,
}: {
  description: string;
  busy: boolean;
  onStay: () => void;
  onSignOut: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onStay}>
      <div
        className="modal signout-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="signout-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="signout-title" className="section-title">
          Sign out of TAWD?
        </h2>
        <p>
          You have unsaved changes in {description}. Signing out will discard
          them.
        </p>
        <div className="modal-actions">
          <Button autoFocus disabled={busy} onClick={onStay}>
            Stay signed in
          </Button>
          <Button variant="primary" disabled={busy} onClick={onSignOut}>
            {busy ? "Signing out..." : "Sign out"}
          </Button>
        </div>
      </div>
    </div>
  );
}
