import { TierBadge } from "@/components/ui/TierBadge";
import {
  CHART_INK,
  COLOR_MAP,
  SCORE_MAX,
  SCORE_MIN,
  TIER_THRESHOLDS,
} from "@/lib/constants";
import { formatScore } from "@/lib/format";
import { clamp } from "@/lib/rng";
import type { Tier } from "@/lib/types";

export interface ScoreGaugeProps {
  score: number;
  tier: Tier;
  /**
   * False when the file is THIN_FILE by the data gate (fewer than
   * MIN_STREAMS_TO_SCORE observed rhythms). The engine still computes a figure
   * from what it saw, but that figure is not a score: two perfect signals add up
   * to 900, and a 900 printed beside "insufficient data" reads as a perfect
   * score refused. So there is no figure and no marker, only the scale.
   */
  scored?: boolean;
  className?: string;
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ *
 * A tier threshold IS a position on a scale, so the reading is linear: where
 * does this borrower sit between 300 and 900, and which side of each cut-off.
 * A donut or a radial dial destroys exactly that comparison.
 */

const PX0 = 1.5; // % inset — keeps the end marker and the "300" label on canvas
const PX1 = 98.5;

const ZONE_Y = 30;
const ZONE_H = 10;
const LABEL_Y = 9;
const MARKER_CY = 24;
const MARKER_R = 5;
const TICK_TOP = ZONE_Y + ZONE_H;
const TICK_BOTTOM = TICK_TOP + 6;
const TICK_LABEL_Y = 58;
const HEIGHT = 62;

interface Zone {
  tier: Tier;
  from: number;
  to: number;
}

const ZONES: Zone[] = [
  { tier: "THIN_FILE", from: SCORE_MIN, to: TIER_THRESHOLDS.DEVELOPING },
  {
    tier: "DEVELOPING",
    from: TIER_THRESHOLDS.DEVELOPING,
    to: TIER_THRESHOLDS.NEAR_PRIME,
  },
  {
    tier: "NEAR_PRIME",
    from: TIER_THRESHOLDS.NEAR_PRIME,
    to: TIER_THRESHOLDS.PRIME,
  },
  { tier: "PRIME", from: TIER_THRESHOLDS.PRIME, to: SCORE_MAX },
];

const THRESHOLDS = [
  TIER_THRESHOLDS.DEVELOPING,
  TIER_THRESHOLDS.NEAR_PRIME,
  TIER_THRESHOLDS.PRIME,
];

/** Score -> percentage across the plotted band. */
function position(score: number): number {
  const t =
    (clamp(score, SCORE_MIN, SCORE_MAX) - SCORE_MIN) / (SCORE_MAX - SCORE_MIN);
  return PX0 + t * (PX1 - PX0);
}

const pct = (value: number): string => `${value.toFixed(3)}%`;

export function ScoreGauge({
  score,
  tier,
  scored = true,
  className,
}: ScoreGaugeProps) {
  const presentation = COLOR_MAP[tier];
  const markerX = position(score);
  const clipId = `score-track-${tier}-${Math.round(clamp(score, SCORE_MIN, SCORE_MAX))}`;

  return (
    <div className={className}>
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-vistara-muted">
        Vistara score
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-x-5 gap-y-3">
        {/* Hero figure: proportional numerals, one per view. */}
        <p className="flex items-baseline gap-2">
          <span className="text-hero font-semibold tracking-tight text-vistara-text">
            {scored ? formatScore(score) : "—"}
          </span>
          <span className="tabular text-[13px] text-vistara-muted">
            {scored ? `/ ${SCORE_MAX}` : "not scored yet"}
          </span>
        </p>

        <TierBadge tier={tier} size="lg" className="mb-2.5" />
      </div>

      <p className="mt-2 max-w-prose text-[13px] leading-relaxed text-vistara-muted">
        {presentation.description}. {presentation.lendingAction}.
      </p>

      <div
        role="img"
        aria-label={
          scored
            ? `Score ${formatScore(score)} on the ${SCORE_MIN} to ${SCORE_MAX} scale. Tier ${presentation.label}. Tier cut-offs at ${THRESHOLDS.join(", ")}.`
            : `Not scored yet: too few signals observed to place this file on the ${SCORE_MIN} to ${SCORE_MAX} scale. Tier cut-offs at ${THRESHOLDS.join(", ")}.`
        }
        className="mt-5"
      >
        <svg
          width="100%"
          height={HEIGHT}
          className="block overflow-visible"
          aria-hidden
          focusable="false"
        >
          <defs>
            <clipPath id={clipId}>
              <rect
                x={pct(PX0)}
                y={ZONE_Y}
                width={pct(PX1 - PX0)}
                height={ZONE_H}
                rx={4}
              />
            </clipPath>
          </defs>

          {/* Tier bands, tinted. The borrower's own band carries the accent; the
              rest recede. Every band is named directly above it, so no reader
              has to decode a colour. */}
          <g clipPath={`url(#${clipId})`}>
            {ZONES.map((zone) => {
              const color = COLOR_MAP[zone.tier].color;
              const from = position(zone.from);
              return (
                <rect
                  key={`zone-${zone.tier}`}
                  x={pct(from)}
                  y={ZONE_Y}
                  width={pct(position(zone.to) - from)}
                  height={ZONE_H}
                  fill={`${color}${zone.tier === tier ? "42" : "1C"}`}
                />
              );
            })}
          </g>

          {/* 2px surface gaps do the separating between adjacent bands. */}
          {THRESHOLDS.map((threshold) => (
            <rect
              key={`gap-${threshold}`}
              x={pct(position(threshold))}
              transform="translate(-1,0)"
              y={ZONE_Y}
              width={2}
              height={ZONE_H}
              fill={CHART_INK.surface}
            />
          ))}

          {ZONES.map((zone) => {
            const zonePresentation = COLOR_MAP[zone.tier];
            const centre = (position(zone.from) + position(zone.to)) / 2;
            const isActive = zone.tier === tier;
            return (
              <text
                key={`label-${zone.tier}`}
                x={pct(centre)}
                y={LABEL_Y}
                textAnchor="middle"
                className="text-[10px]"
              >
                <tspan aria-hidden fill={zonePresentation.color}>
                  {zonePresentation.icon}
                </tspan>
                <tspan
                  dx={4}
                  fill={isActive ? CHART_INK.primary : CHART_INK.muted}
                >
                  {zonePresentation.label}
                </tspan>
              </text>
            );
          })}

          {/* Threshold hairlines + the numbers they stand for. */}
          {THRESHOLDS.map((threshold) => (
            <g key={`tick-${threshold}`}>
              <line
                x1={pct(position(threshold))}
                x2={pct(position(threshold))}
                y1={TICK_TOP}
                y2={TICK_BOTTOM}
                stroke={CHART_INK.axis}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text
                x={pct(position(threshold))}
                y={TICK_LABEL_Y}
                textAnchor="middle"
                className="tabular text-[10px]"
                fill={CHART_INK.muted}
              >
                {threshold}
              </text>
            </g>
          ))}

          <text
            x={pct(PX0)}
            y={TICK_LABEL_Y}
            textAnchor="start"
            className="tabular text-[10px]"
            fill={CHART_INK.muted}
          >
            {SCORE_MIN}
          </text>
          <text
            x={pct(PX1)}
            y={TICK_LABEL_Y}
            textAnchor="end"
            className="tabular text-[10px]"
            fill={CHART_INK.muted}
          >
            {SCORE_MAX}
          </text>

          {/* The single marker: plumb line through the band, disc above it. */}
          {scored ? (
            <>
              <rect
                x={pct(markerX)}
                transform="translate(-1,0)"
                y={MARKER_CY}
                width={2}
                height={TICK_TOP - MARKER_CY + 2}
                fill={presentation.color}
              />
              <circle
                cx={pct(markerX)}
                cy={MARKER_CY}
                r={MARKER_R}
                fill={presentation.color}
                stroke={CHART_INK.surface}
                strokeWidth={2}
              />
            </>
          ) : null}
        </svg>
      </div>
    </div>
  );
}
