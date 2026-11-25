import {
  BEHAVIOR_META,
  BEHAVIOR_ORDER,
  CHART_INK,
  CONSISTENCY_BANDS,
  RAMP,
} from "@/lib/constants";
import { formatSigma } from "@/lib/format";
import { clamp } from "@/lib/rng";
import type { BehaviorSource, ConsistencyMetrics } from "@/lib/types";

export interface ConsistencyBarsProps {
  metrics: ConsistencyMetrics[];
  className?: string;
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ *
 * Percentage x-coordinates inside an SVG with no viewBox: the chart is fluid,
 * yet strokes stay hairlines, corner radii stay 4px and text stays at its real
 * size. A viewBox + preserveAspectRatio="none" would stretch all three.
 */

const LABEL_PCT = 24; // row label column
const GUTTER_PCT = 12; // reserved room for the direct end-label
const PLOT_PCT = 100 - LABEL_PCT - GUTTER_PCT;

const ROW_H = 38;
const BAR_H = 10;
const AXIS_H = 22;
const TICKS = [0, 25, 50, 75, 100] as const;

/**
 * Magnitude ramp, single hue. Read bright -> dim on a dark plane: the darkest
 * steps recede into the surface, so the lightest step marks the largest value.
 */
const MAGNITUDE_STEPS = [RAMP[4], RAMP[3], RAMP[2], RAMP[1], RAMP[0]] as const;

function rampStep(index: number): string {
  const i = clamp(
    Math.floor((clamp(index, 0, 100) / 100) * MAGNITUDE_STEPS.length),
    0,
    MAGNITUDE_STEPS.length - 1,
  );
  return MAGNITUDE_STEPS[i];
}

/**
 * The band is decided by the engine, not re-derived here: it is keyed off the
 * NORMALISED sigma, because a 5-day slip on a 7-day FASTag rhythm and the same
 * 5 days on a 90-day service rhythm are not the same event. The presentation
 * layer only looks the band's tokens up.
 */
function bandTokens(metric: ConsistencyMetrics) {
  const byBand = CONSISTENCY_BANDS.find((entry) => entry.band === metric.band);
  if (byBand !== undefined) return byBand;
  const bySigma = CONSISTENCY_BANDS.find(
    (entry) => metric.normalisedStdDevDays <= entry.maxStdDevDays,
  );
  return bySigma === undefined
    ? CONSISTENCY_BANDS[CONSISTENCY_BANDS.length - 1]
    : bySigma;
}

const x = (value: number): string =>
  `${(LABEL_PCT + (clamp(value, 0, 100) / 100) * PLOT_PCT).toFixed(3)}%`;

interface Row {
  source: BehaviorSource;
  label: string;
  icon: string;
  index: number;
  stdDevDays: number;
  band: (typeof CONSISTENCY_BANDS)[number];
  scorable: boolean;
  seasonalityAdjusted: boolean;
}

/**
 * Magnitude across named categories -> horizontal bars. Rows are locked to
 * BEHAVIOR_ORDER rather than sorted by value, so a given behaviour sits on the
 * same line for every customer and a loan officer can compare two profiles
 * without re-reading the labels.
 */
export function ConsistencyBars({ metrics, className }: ConsistencyBarsProps) {
  const rows: Row[] = BEHAVIOR_ORDER.reduce<Row[]>((acc, source) => {
    const metric = metrics.find((entry) => entry.source === source);
    if (metric === undefined) return acc;
    const meta = BEHAVIOR_META[source];
    acc.push({
      source,
      label: meta.short,
      icon: meta.icon,
      index: metric.consistencyIndex,
      stdDevDays: metric.stdDevDays,
      band: bandTokens(metric),
      scorable: metric.scorable,
      seasonalityAdjusted: metric.seasonalityAdjusted,
    });
    return acc;
  }, []);

  if (rows.length === 0) {
    return (
      <p
        className={["text-[13px] text-vistara-muted", className ?? ""]
          .filter(Boolean)
          .join(" ")}
      >
        No behavioural rhythm observed yet — nothing to plot.
      </p>
    );
  }

  const plotH = rows.length * ROW_H;
  const height = plotH + AXIS_H;

  const summary = rows
    .map((row) =>
      row.scorable
        ? `${row.label} ${Math.round(row.index)} of 100, sigma ${row.stdDevDays.toFixed(1)} days, ${row.band.label}`
        : `${row.label} not scorable, too few events`,
    )
    .join("; ");

  return (
    <div className={className}>
      <div
        role="img"
        aria-label={`Consistency index by behaviour. ${summary}.`}
      >
        <svg
          width="100%"
          height={height}
          className="block overflow-visible"
          aria-hidden
          focusable="false"
        >
          {/* Recessive chrome: solid hairlines one shade off the surface. */}
          {TICKS.map((tick) => (
            <line
              key={`grid-${tick}`}
              x1={x(tick)}
              x2={x(tick)}
              y1={0}
              y2={plotH}
              stroke={tick === 0 ? CHART_INK.axis : CHART_INK.gridline}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
          ))}
          <line
            x1={x(0)}
            x2={x(100)}
            y1={plotH}
            y2={plotH}
            stroke={CHART_INK.axis}
            strokeWidth={1}
            shapeRendering="crispEdges"
          />

          {rows.map((row, rowIndex) => {
            const top = rowIndex * ROW_H;
            const band = row.band;
            const fill = rampStep(row.index);
            const barWidth = row.scorable
              ? (clamp(row.index, 0, 100) / 100) * PLOT_PCT
              : 0;

            return (
              <g key={row.source}>
                <text
                  x={0}
                  y={top + 15}
                  className="text-[12px]"
                  fill={CHART_INK.primary}
                >
                  <tspan aria-hidden fill={CHART_INK.muted}>
                    {row.icon}
                  </tspan>
                  <tspan dx={6}>{row.label}</tspan>
                </text>

                {/* Band icon + label: the quality reading is never colour-only. */}
                {row.scorable ? (
                  <text x={0} y={top + 29} className="text-[11px]">
                    <tspan aria-hidden fill={band.color}>
                      {band.icon}
                    </tspan>
                    <tspan dx={6} fill={CHART_INK.muted}>
                      {band.label}
                      {row.seasonalityAdjusted ? " · seasonal" : ""}
                    </tspan>
                  </text>
                ) : (
                  <text
                    x={0}
                    y={top + 29}
                    className="text-[11px]"
                    fill={CHART_INK.muted}
                  >
                    Too few events
                  </text>
                )}

                {/* 0–100 domain, so a short bar still reads as a share. */}
                <rect
                  x={x(0)}
                  y={top + 17}
                  width={`${PLOT_PCT}%`}
                  height={BAR_H}
                  rx={4}
                  fill={CHART_INK.gridline}
                />

                {row.scorable ? (
                  <rect
                    x={x(0)}
                    y={top + 17}
                    width={`${barWidth.toFixed(3)}%`}
                    height={BAR_H}
                    rx={4}
                    fill={fill}
                  />
                ) : null}
                {/* Squares off the baseline end; the data-end keeps its 4px. */}
                {barWidth > 0.5 ? (
                  <rect
                    x={x(0)}
                    y={top + 17}
                    width={5}
                    height={BAR_H}
                    fill={fill}
                  />
                ) : null}

                {/* Direct label at the bar end — the value the row is about. */}
                <text
                  x={x(row.scorable ? row.index : 0)}
                  dx={8}
                  y={top + 26}
                  className="tabular text-[11px]"
                  fill={CHART_INK.secondary}
                >
                  {row.scorable ? formatSigma(row.stdDevDays) : "—"}
                </text>
              </g>
            );
          })}

          {TICKS.map((tick) => (
            <text
              key={`tick-${tick}`}
              x={x(tick)}
              y={plotH + 15}
              textAnchor="middle"
              className="tabular text-[10px]"
              fill={CHART_INK.muted}
            >
              {tick}
            </text>
          ))}
        </svg>
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-vistara-muted">
        Bar length is the consistency index (0–100). σ is the standard deviation
        of the gap between events in that domain — lower is tighter rhythm. The
        band beside each label compares σ against that behaviour&rsquo;s own
        expected cadence, so a 90-day and a 7-day rhythm are judged fairly.
      </p>
    </div>
  );
}
