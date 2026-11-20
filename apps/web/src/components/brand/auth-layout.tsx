/*
  The split layout of Sign in and Signed out: the navy brand panel on the
  left with the dark logo, the page's own content on the right.
*/
export function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-split">
      <aside className="auth-brand">
        <p className="auth-brand-org">Velocity Media Lab</p>
        <div className="auth-brand-main">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/tawd-logo-dark-bg.svg"
            alt="tawd by Velocity"
            className="auth-brand-logo"
          />
          <p className="auth-brand-line">
            Websites for local service businesses, from intake to launch, built
            by AI and checked by the VML team.
          </p>
        </div>
        <p className="auth-brand-foot">Internal tool. Team accounts only.</p>
      </aside>
      <main className="auth-main">{children}</main>
    </div>
  );
}
