import {
  BEHAVIOR_META,
  CHART_INK,
  CONSISTENCY_BANDS,
  OBSERVATION_DAYS,
  OBSERVATION_MONTHS,
} from "@/lib/constants";
import { formatBeatOffset, formatDate, formatMonthShort } from "@/lib/format";
import { REFERENCE_DATE, addDays, clamp, daysBetween } from "@/lib/rng";
import type { BehaviorStream, ConsistencyBand } from "@/lib/types";

export interface EventStripProps {
  stream: BehaviorStream;
  /** The cadence this behaviour is expected to repeat on, in days. */
  expectedIntervalDays: number;
  className?: string;
}

/* ------------------------------------------------------------------ *
 * Geometry — percentage x, pixel y (no viewBox, so nothing is scaled)
 * ------------------------------------------------------------------ */

const X0 = 1.2; // left inset in %, wide enough that an edge dot is never clipped
const X1 = 98.8;
const LANE_Y = 30; // centre of the event lane
const AXIS_Y = 58;
const MONTH_TICK_Y = 63;
const MONTH_LABEL_Y = 78;
const HEIGHT = 84;
const DOT_R = 5; // 10px marks, comfortably over the 8px floor
const DENSE_BEATS = 30;
const MISS_GLYPH = "✕";

type BeatKind = "onBeat" | "offBeat" | "missed";

/**
 * Beat status is a risk STATE, so it wears the reserved status tokens already
 * defined for the consistency bands — no new hue enters the system — and every
 * state also changes marker SHAPE, so colour is never the only channel.
 */
function statusColor(band: ConsistencyBand): string {
  const match = CONSISTENCY_BANDS.find((entry) => entry.band === band);
  return match === undefined ? CHART_INK.secondary : match.color;
}

const BEAT_STYLE: Record<BeatKind, { color: string; label: string }> = {
  onBeat: { color: statusColor("exceptional"), label: "On beat" },
  offBeat: { color: statusColor("moderate"), label: "Off beat" },
  missed: { color: statusColor("developing"), label: "Missed beat" },
};

interface PlottedEvent {
  date: Date;
  kind: Exclude<BeatKind, "missed">;
  /** Days away from the expected beat. Negative is early. */
  deltaDays: number;
  isFirst: boolean;
}

interface Classified {
  events: PlottedEvent[];
  missed: Date[];
  tolerance: number;
}

/**
 * Rhythm is measured gap-by-gap against the expected interval, not against a
 * rigid grid pinned to the first event: over 18 months even a tight rhythm
 * random-walks a few days off an absolute grid, and grading that as failure
 * would misread the very signal this product sells.
 */
function classify(timestamps: Date[], interval: number): Classified {
  const tolerance = Math.max(2, interval * 0.12);
  const events: PlottedEvent[] = [];
  const missed: Date[] = [];

  timestamps.forEach((date, i) => {
    if (i === 0) {
      events.push({ date, kind: "onBeat", deltaDays: 0, isFirst: true });
      return;
    }

    const previous = timestamps[i - 1];
    const gap = daysBetween(previous, date);
    const skipped = Math.max(0, Math.round(gap / interval) - 1);

    for (let k = 1; k <= Math.min(skipped, 24); k += 1) {
      missed.push(addDays(previous, k * interval));
    }

    // Residual against the beat this event actually landed on.
    const deltaDays = gap - (skipped + 1) * interval;
    events.push({
      date,
      kind: Math.abs(deltaDays) <= tolerance ? "onBeat" : "offBeat",
      deltaDays,
      isFirst: false,
    });
  });

  return { events, missed, tolerance };
}

/** Rigid expected-cadence grid, drawn faint as the reference beat. */
function expectedBeats(anchor: Date, interval: number, end: Date): Date[] {
  const beats: Date[] = [];
  const total = Math.floor(daysBetween(anchor, end) / interval);
  for (let k = 0; k <= Math.min(total, 400); k += 1) {
    beats.push(addDays(anchor, k * interval));
  }
  return beats;
}

function monthStarts(start: Date, end: Date): Date[] {
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();
  if (start.getUTCDate() !== 1) {
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }

  const months: Date[] = [];
  for (let i = 0; i < 48; i += 1) {
    const date = new Date(Date.UTC(year, month, 1));
    if (date.getTime() > end.getTime()) break;
    months.push(date);
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  return months;
}

function LegendGlyph({ kind }: { kind: BeatKind }) {
  const { color } = BEAT_STYLE[kind];
  return (
    <svg width={12} height={12} aria-hidden focusable="false" className="shrink-0">
      {kind === "onBeat" ? (
        <circle cx={6} cy={6} r={4} fill={color} />
      ) : null}
      {kind === "offBeat" ? (
        <circle
          cx={6}
          cy={6}
          r={3.5}
          fill={CHART_INK.surface}
          stroke={color}
          strokeWidth={2}
        />
      ) : null}
      {kind === "missed" ? (
        <text
          x={6}
          y={10}
          textAnchor="middle"
          className="text-[13px]"
          fill={color}
        >
          {MISS_GLYPH}
        </text>
      ) : null}
    </svg>
  );
}

/**
 * THE signature visual. An 18-month timeline of nothing but timestamps: a
 * regular life renders as an even comb of dots, an irregular one visibly
 * clusters and gaps. Every value is legible without hover — the counts are in
 * the header, the beat grid is drawn, and the shapes carry the state.
 */
export function EventStrip({
  stream,
  expectedIntervalDays,
  className,
}: EventStripProps) {
  const interval =
    expectedIntervalDays > 0 ? expectedIntervalDays : stream.expectedIntervalDays;
  const meta = BEHAVIOR_META[stream.source];
  const timestamps = [...stream.timestamps].sort(
    (a, b) => a.getTime() - b.getTime(),
  );

  if (timestamps.length === 0 || interval <= 0) {
    return (
      <p
        className={["text-[13px] text-vistara-muted", className ?? ""]
          .filter(Boolean)
          .join(" ")}
      >
        {stream.label} — no events observed in the trailing{" "}
        {OBSERVATION_MONTHS} months.
      </p>
    );
  }

  const first = timestamps[0];
  const last = timestamps[timestamps.length - 1];
  const windowStart = addDays(REFERENCE_DATE, -OBSERVATION_DAYS);
  const start =
    first.getTime() < windowStart.getTime() ? first : windowStart;
  const end =
    last.getTime() > REFERENCE_DATE.getTime() ? last : REFERENCE_DATE;
  const span = Math.max(1, daysBetween(start, end));

  const xOf = (date: Date): string => {
    const t = clamp(daysBetween(start, date) / span, 0, 1);
    return `${(X0 + t * (X1 - X0)).toFixed(3)}%`;
  };

  const { events, missed, tolerance } = classify(timestamps, interval);
  const beats = expectedBeats(first, interval, end);
  const dense = beats.length > DENSE_BEATS;
  const months = monthStarts(start, end);
  const labelStep = months.length > 12 ? 3 : months.length > 6 ? 2 : 1;

  const onBeatCount = events.filter((event) => event.kind === "onBeat").length;
  const offBeatCount = events.length - onBeatCount;

  return (
    <div className={className}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1">
        <h3 className="text-[14px] font-medium tracking-tight text-vistara-text">
          <span aria-hidden className="mr-2 text-vistara-muted">
            {meta.icon}
          </span>
          {stream.label}
        </h3>
        <p className="tabular text-[12px] text-vistara-muted">
          Expected every {interval} days · {timestamps.length} events observed
        </p>
      </div>

      {/* The reading, in words, before the chart: never hover-gated. */}
      <p className="mt-1.5 text-[12px] leading-relaxed text-vistara-muted">
        <span className="tabular">{onBeatCount}</span> on beat ·{" "}
        <span className="tabular">{offBeatCount}</span> off beat ·{" "}
        <span className="tabular">{missed.length}</span> missed beats
      </p>

      <div
        role="img"
        aria-label={`${stream.label}: ${timestamps.length} events over the trailing ${Math.round(span)} days, expected every ${interval} days. ${onBeatCount} on beat, ${offBeatCount} off beat, ${missed.length} missed beats.`}
        className="mt-2"
      >
        <svg
          width="100%"
          height={HEIGHT}
          className="block overflow-visible"
          aria-hidden
          focusable="false"
        >
          {/* Expected cadence: the beat the dots are read against. */}
          {beats.map((beat) => (
            <line
              key={`beat-${beat.getTime()}`}
              x1={xOf(beat)}
              x2={xOf(beat)}
              y1={dense ? AXIS_Y - 10 : LANE_Y - 14}
              y2={AXIS_Y + 4}
              stroke={CHART_INK.gridline}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
          ))}

          <line
            x1={`${X0}%`}
            x2={`${X1}%`}
            y1={AXIS_Y}
            y2={AXIS_Y}
            stroke={CHART_INK.axis}
            strokeWidth={1}
            shapeRendering="crispEdges"
          />

          {/* Missed beats sit where the event should have been. A third SHAPE,
              so the three states survive greyscale and full-severity CVD. */}
          {missed.map((beat, i) => (
            <text
              key={`missed-${i}`}
              x={xOf(beat)}
              y={LANE_Y + 4.5}
              textAnchor="middle"
              className="text-[13px]"
              fill={BEAT_STYLE.missed.color}
              stroke={CHART_INK.surface}
              strokeWidth={2}
              style={{ paintOrder: "stroke" }}
            >
              {MISS_GLYPH}
            </text>
          ))}

          {events.map((event, i) => {
            const style = BEAT_STYLE[event.kind];
            const cx = xOf(event.date);
            const detail = event.isFirst
              ? "first observed event"
              : formatBeatOffset(event.deltaDays, tolerance);

            return (
              <g key={`event-${i}`}>
                <title>{`${formatDate(event.date)} · ${detail}`}</title>
                {/* Oversized transparent pad: the native title tooltip needs a
                    hit target, and a 10px dot is not one. */}
                <circle cx={cx} cy={LANE_Y} r={13} fill="rgba(0,0,0,0)" />
                {event.kind === "onBeat" ? (
                  <circle
                    cx={cx}
                    cy={LANE_Y}
                    r={DOT_R}
                    fill={style.color}
                    stroke={CHART_INK.surface}
                    strokeWidth={2}
                  />
                ) : (
                  <circle
                    cx={cx}
                    cy={LANE_Y}
                    r={DOT_R - 1}
                    fill={CHART_INK.surface}
                    stroke={style.color}
                    strokeWidth={2}
                  />
                )}
              </g>
            );
          })}

          {months.map((month, i) => {
            const showLabel = i % labelStep === 0;
            const t = clamp(daysBetween(start, month) / span, 0, 1);
            const anchor = t < 0.04 ? "start" : t > 0.96 ? "end" : "middle";
            return (
              <g key={`month-${month.getTime()}`}>
                <line
                  x1={xOf(month)}
                  x2={xOf(month)}
                  y1={AXIS_Y}
                  y2={MONTH_TICK_Y}
                  stroke={CHART_INK.axis}
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                {showLabel ? (
                  <text
                    x={xOf(month)}
                    y={MONTH_LABEL_Y}
                    textAnchor={anchor}
                    className="tabular text-[10px]"
                    fill={CHART_INK.muted}
                  >
                    {formatMonthShort(month, i === 0 || month.getUTCMonth() === 0)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>

      <ul className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px] text-vistara-muted">
        <li className="flex items-center gap-1.5">
          <LegendGlyph kind="onBeat" />
          <span>
            {BEAT_STYLE.onBeat.label} (within {Math.round(tolerance)}d)
          </span>
        </li>
        <li className="flex items-center gap-1.5">
          <LegendGlyph kind="offBeat" />
          <span>{BEAT_STYLE.offBeat.label} — early or late</span>
        </li>
        <li className="flex items-center gap-1.5">
          <LegendGlyph kind="missed" />
          <span>{BEAT_STYLE.missed.label}</span>
        </li>
        <li className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-3 w-px shrink-0"
            style={{ backgroundColor: CHART_INK.gridline }}
          />
          <span>Expected beat</span>
        </li>
      </ul>
    </div>
  );
}
