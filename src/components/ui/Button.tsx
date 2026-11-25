import Link from "next/link";
import type { MouseEventHandler, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** When present the control renders as a next/link anchor instead of a button. */
  href?: string;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  target?: string;
  rel?: string;
  title?: string;
  /** Required when the label is a bare glyph rather than words. */
  "aria-label"?: string;
  fullWidth?: boolean;
  className?: string;
  children: ReactNode;
}

// The corner radius lives in SIZES rather than here, because `lg` takes a larger
// one and two competing radius utilities on the same element would be settled by
// Tailwind's emit order rather than by this file.
//
// THE MOBILE FLOOR. `max-sm:min-h-[44px]` raises every button to the 44px target
// recommended for touch below the `sm` breakpoint, and is the one place in the app
// that needs to say so — 24 call sites inherit it from here. It belongs in BASE
// rather than in SIZES because it is a property of the input device, not of the
// button's rank: a `sm` ghost button and a `md` primary are the same size to a
// thumb. `min-height` clamps the used height above the `h-*` each size sets, so
// `sm` (32px) and `md` (40px) grow on a phone while `lg` (48px) is unaffected, and
// at `sm` and up every size renders exactly as it did before.
const BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium tracking-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vistara-accent focus-visible:ring-offset-2 focus-visible:ring-offset-vistara-dark max-sm:min-h-[44px]";

const SIZES: Record<ButtonSize, string> = {
  // Every size clears the 24px minimum of WCAG 2.5.8 on a pointer device, and
  // BASE lifts all of them to 44px on a touch-sized viewport.
  sm: "h-8 rounded-lg px-3 text-[12px]",
  md: "h-10 rounded-lg px-4 text-[13px]",
  /** The landing-page hero pair, and nothing else. A call to action that has to
   *  carry a whole first screen needs more presence than an in-page control. */
  lg: "h-12 rounded-xl px-6 text-[14px]",
};

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-vistara-accent text-white hover:bg-ramp-500 active:bg-ramp-600 disabled:hover:bg-vistara-accent",
  secondary:
    "border border-vistara-border bg-vistara-surface text-vistara-text hover:border-vistara-accent/40 hover:bg-vistara-border/45",
  ghost:
    "text-vistara-muted hover:bg-vistara-surface hover:text-vistara-text",
};

export function Button(props: ButtonProps) {
  const {
    variant = "primary",
    size = "md",
    href,
    type = "button",
    disabled = false,
    onClick,
    target,
    rel,
    title,
    fullWidth = false,
    className,
    children,
  } = props;
  const ariaLabel = props["aria-label"];

  const classes = [
    BASE,
    SIZES[size],
    VARIANTS[variant],
    fullWidth ? "w-full" : "",
    disabled ? "pointer-events-none opacity-45" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  if (href !== undefined) {
    return (
      <Link
        href={href}
        className={classes}
        target={target}
        rel={rel}
        title={title}
        aria-label={ariaLabel}
        aria-disabled={disabled ? true : undefined}
      >
        {children}
      </Link>
    );
  }

  return (
    <button
      type={type}
      className={classes}
      disabled={disabled}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
}
