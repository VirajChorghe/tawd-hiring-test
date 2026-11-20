/*
  The warning banner from DESIGN.md: an alert mark, a bold title, one plain
  sentence, and an optional action on the right.
*/
export function Banner({
  tone = "warning",
  title,
  children,
  action,
}: {
  tone?: "warning" | "error" | "done";
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  const className = [
    "banner",
    tone === "error" ? "banner-error" : null,
    tone === "done" ? "banner-done" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={className} role="status">
      <AlertIcon tone={tone} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p className="banner-title">{title}</p>
        {children ? <p>{children}</p> : null}
      </div>
      {action ? <div style={{ flex: "none" }}>{action}</div> : null}
    </div>
  );
}

/* One stroke icon set, no emoji. DESIGN.md rules. */
function AlertIcon({ tone }: { tone: "warning" | "error" | "done" }) {
  const stroke =
    tone === "error"
      ? "var(--red)"
      : tone === "done"
        ? "var(--blue-text)"
        : "var(--amber-text)";

  if (tone === "done") {
    return (
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke={stroke}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ flex: "none" }}
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M8 12.5l2.5 2.5L16 9.5" />
      </svg>
    );
  }

  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: "none" }}
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="7" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
