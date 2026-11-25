import { COLOR_MAP } from "@/lib/constants";
import { formatScore } from "@/lib/format";
import type { Tier } from "@/lib/types";

export type TierBadgeSize = "sm" | "md" | "lg";

export interface TierBadgeProps {
  tier: Tier;
  /** When given, the score rides the badge behind a hairline divider. */
  score?: number;
  size?: TierBadgeSize;
  className?: string;
}

const SIZES: Record<TierBadgeSize, { chip: string; icon: string; text: string }> =
  {
    sm: { chip: "gap-1.5 px-2 py-[3px]", icon: "text-[10px]", text: "text-[11px]" },
    md: { chip: "gap-2 px-2.5 py-1", icon: "text-[11px]", text: "text-[12px]" },
    lg: { chip: "gap-2.5 px-3 py-1.5", icon: "text-[13px]", text: "text-[14px]" },
  };

/**
 * A credit tier is a risk STATE, so it draws on the reserved status palette and
 * always ships colour + glyph + label together. The chip is a tinted ring, not a
 * solid saturated block — the tier is context for the score, not the headline.
 */
export function TierBadge({ tier, score, size = "md", className }: TierBadgeProps) {
  const presentation = COLOR_MAP[tier];
  const s = SIZES[size];

  return (
    <span
      className={[
        "inline-flex items-center rounded-md font-medium text-vistara-text",
        s.chip,
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        backgroundColor: `${presentation.color}14`,
        boxShadow: `inset 0 0 0 1px ${presentation.color}52`,
      }}
    >
      <span
        aria-hidden
        className={`leading-none ${s.icon}`}
        style={{ color: presentation.color }}
      >
        {presentation.icon}
      </span>

      <span className={`leading-none tracking-tight ${s.text}`}>
        {presentation.label}
      </span>

      {score !== undefined ? (
        <>
          <span
            aria-hidden
            className="h-3 w-px shrink-0"
            style={{ backgroundColor: `${presentation.color}52` }}
          />
          <span className={`tabular leading-none text-vistara-muted ${s.text}`}>
            {formatScore(score)}
          </span>
        </>
      ) : null}
    </span>
  );
}
