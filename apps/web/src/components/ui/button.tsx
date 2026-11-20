import Link from "next/link";

/*
  One primary action per area. Danger is only for bypassing a rule or
  deleting something. See DESIGN.md.
*/
export type ButtonVariant = "primary" | "secondary" | "text" | "danger";

export function buttonClass(
  variant: ButtonVariant = "secondary",
  extra?: string,
): string {
  return ["btn", `btn-${variant}`, extra].filter(Boolean).join(" ");
}

export function Button({
  variant = "secondary",
  small = false,
  className,
  type = "button",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  small?: boolean;
}) {
  return (
    <button
      type={type}
      className={buttonClass(
        variant,
        [small ? "btn-small" : null, className].filter(Boolean).join(" "),
      )}
      {...rest}
    />
  );
}

export function ButtonLink({
  variant = "secondary",
  small = false,
  className,
  href,
  children,
}: {
  variant?: ButtonVariant;
  small?: boolean;
  className?: string;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={buttonClass(
        variant,
        [small ? "btn-small" : null, className].filter(Boolean).join(" "),
      )}
    >
      {children}
    </Link>
  );
}
