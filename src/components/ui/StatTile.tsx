import type { ReactNode } from "react";

export type StatDeltaTone = "good" | "bad" | "neutral";

export interface StatDelta {
  /** Always rendered as text — the arrow and colour only reinforce it. */
  label: string;
  direction?: "up" | "down" | "flat";
  /** Direction is not polarity: a rising sigma is bad. Say which this is. */
  tone?: StatDeltaTone;
}

export interface StatTileProps {
  label: string;
  value: ReactNode;
  delta?: StatDelta | string;
  hint?: string;
  /** Bumps the figure a step for the one tile that leads a row. */
  emphasis?: boolean;
  className?: string;
}

const DIRECTION_GLYPH = { up: "▲", down: "▼", flat: "–" } as const;

const TONE_CLASS: Record<StatDeltaTone, string> = {
  good: "text-vistara-green",
  bad: "text-vistara-red",
  neutral: "text-vistara-muted",
};

/**
 * The KPI primitive, and the reason this app contains no one-bar bar charts: a
 * single headline value has no categories to compare, so it gets a figure, not a
 * plot. Proportional figures — `tabular-nums` makes a large number look loose.
 */
export function StatTile({
  label,
  value,
  delta,
  hint,
  emphasis = false,
  className,
}: StatTileProps) {
  const resolved: StatDelta | undefined =
    typeof delta === "string" ? { label: delta } : delta;
  const tone: StatDeltaTone = resolved?.tone ?? "neutral";
  const direction = resolved?.direction;

  return (
    <div
      className={[
        "rounded-card border border-vistara-border bg-vistara-surface p-4",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-vistara-muted">
        {label}
      </p>

      <div className="mt-2 flex items-baseline gap-2">
        <span
          className={[
            "font-semibold tracking-tight text-vistara-text",
            emphasis ? "text-[34px] leading-none" : "text-[26px] leading-none",
          ].join(" ")}
        >
          {value}
        </span>

        {resolved !== undefined ? (
          <span
            className={`inline-flex items-baseline gap-1 text-[12px] ${TONE_CLASS[tone]}`}
          >
            {direction !== undefined ? (
              <span aria-hidden className="text-[9px] leading-none">
                {DIRECTION_GLYPH[direction]}
              </span>
            ) : null}
            <span>{resolved.label}</span>
          </span>
        ) : null}
      </div>

      {hint !== undefined ? (
        <p className="mt-2 text-[12px] leading-relaxed text-vistara-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
