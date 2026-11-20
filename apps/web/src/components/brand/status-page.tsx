import Link from "next/link";

/*
  The 404 and error pages: the logo, one plain sentence, and a way back.
  No top bar, because the visitor may not be signed in.
*/
export function StatusPage({
  title,
  line,
  action,
}: {
  title: string;
  line: string;
  /** Defaults to a link back to Projects. */
  action?: React.ReactNode;
}) {
  return (
    <main className="status-page">
      <div className="status-page-body">
        <Link href="/projects" aria-label="TAWD home" className="status-page-logo">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/tawd-logo.svg" alt="tawd by Velocity" />
        </Link>
        <h1 className="section-title">{title}</h1>
        <p>{line}</p>
        <div className="status-page-actions">
          {action ?? (
            <Link href="/projects" className="btn btn-primary">
              Back to Projects
            </Link>
          )}
        </div>
      </div>
    </main>
  );
}
