import type { ReactNode } from "react";

export type BadgeSize = "sm" | "md";

export interface BadgeProps {
  /** A hex token from COLOR_MAP / CONSISTENCY_BANDS. Never a free-chosen hue. */
  color: string;
  /** Non-colour redundant channel — the geometric glyph that rides the label. */
  icon?: string;
  /** ALWAYS rendered. Colour is never the only carrier of meaning. */
  label: string;
  /** Drop the tint + ring and render as a bare glyph-and-label run of text. */
  subtle?: boolean;
  size?: BadgeSize;
  trailing?: ReactNode;
  className?: string;
}

const SIZES: Record<BadgeSize, string> = {
  sm: "gap-1.5 px-2 py-[3px] text-[11px]",
  md: "gap-2 px-2.5 py-1 text-[12px]",
};

/**
 * The generic status chip. A tinted ring rather than a solid saturated block:
 * a filled chip at these chromas fights the data marks for attention.
 */
export function Badge({
  color,
  icon,
  label,
  subtle = false,
  size = "sm",
  trailing,
  className,
}: BadgeProps) {
  return (
    <span
      className={[
        "inline-flex items-center rounded-md font-medium text-vistara-text",
        SIZES[size],
        subtle ? "px-0 py-0" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={
        subtle
          ? undefined
          : {
              backgroundColor: `${color}14`,
              boxShadow: `inset 0 0 0 1px ${color}52`,
            }
      }
    >
      {icon !== undefined ? (
        <span aria-hidden className="leading-none" style={{ color }}>
          {icon}
        </span>
      ) : null}
      <span className="leading-none">{label}</span>
      {trailing !== undefined ? (
        <span className="leading-none text-vistara-muted">{trailing}</span>
      ) : null}
    </span>
  );
}
