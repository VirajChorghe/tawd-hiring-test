/*
  The four badge kinds from DESIGN.md. Nothing else is a badge.
*/
export type BadgeKind = "done" | "missing" | "warning" | "info";

export function Badge({
  kind,
  children,
}: {
  kind: BadgeKind;
  children: React.ReactNode;
}) {
  return <span className={`badge badge-${kind}`}>{children}</span>;
}
