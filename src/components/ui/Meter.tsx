import { CONSISTENCY_BANDS, RAMP } from "@/lib/constants";
import { clamp } from "@/lib/rng";
import type { ConsistencyBand } from "@/lib/types";

export interface MeterProps {
  value: number;
  /** The limit the value is read against. Defaults to a 0–100 index. */
  max?: number;
  /**
   * When given, the fill takes that band's reserved status colour. The caller
   * MUST render the band label beside the meter — this component is a ratio, not
   * a legend, so colour here never carries the reading on its own.
   */
  band?: ConsistencyBand;
  /** The unfilled remainder. Off for a bare tick inside a dense table row. */
  showTrack?: boolean;
  /** Accessible name. Defaults to "<value> of <max>". */
  ariaLabel?: string;
  className?: string;
}

/**
 * Magnitude on a dark plane runs bright -> dim: the darkest ramp steps recede
 * into the surface, so a high ratio takes the lightest step and a low one the
 * darkest still-legible step. Same single hue throughout — never a value ramp
 * across hues.
 */
const MAGNITUDE_STEPS = [RAMP[4], RAMP[3], RAMP[2], RAMP[1], RAMP[0]] as const;

function bandColor(band: ConsistencyBand): string {
  const match = CONSISTENCY_BANDS.find((entry) => entry.band === band);
  return match === undefined ? RAMP[3] : match.color;
}

export function Meter({
  value,
  max = 100,
  band,
  showTrack = true,
  ariaLabel,
  className,
}: MeterProps) {
  const safeMax = max <= 0 ? 100 : max;
  const ratio = clamp(value / safeMax, 0, 1);
  const stepIndex = clamp(
    Math.floor(ratio * MAGNITUDE_STEPS.length),
    0,
    MAGNITUDE_STEPS.length - 1,
  );
  const fill = band === undefined ? MAGNITUDE_STEPS[stepIndex] : bandColor(band);

  return (
    <div
      role="img"
      aria-label={
        ariaLabel ?? `${Math.round(value)} of ${Math.round(safeMax)}`
      }
      className={[
        "h-2 w-full overflow-hidden rounded-[4px]",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      // The track is the fill's own hue at low alpha: state reads across the
      // whole bar, and no second colour enters the chart.
      style={{ backgroundColor: showTrack ? `${fill}24` : "transparent" }}
    >
      <div
        className="h-full rounded-[4px]"
        style={{
          width: `${(ratio * 100).toFixed(2)}%`,
          backgroundColor: fill,
        }}
      />
    </div>
  );
}
