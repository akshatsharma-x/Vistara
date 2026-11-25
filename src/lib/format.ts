/**
 * Vistara — display formatting.
 *
 * DETERMINISM CONTRACT: every formatter here is a pure function of its input and
 * pins an explicit locale (and an explicit UTC time zone for dates). A
 * locale-default or time-zone-default format is a hydration bug: the Node server
 * and the browser can resolve different defaults, React re-renders the subtree,
 * and the demo flickers or throws mid-presentation.
 */

const EM_DASH = "—";

/** Indian digit grouping: 1,20,000 rather than 120,000. */
const INR_GROUPING = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
  useGrouping: true,
});

/** "12 Mar 2026" — day-first, short month, UTC so both passes agree. */
const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** Hand-rolled month abbreviations: axis ticks must never depend on ICU data. */
const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Rupees, no decimals, Indian grouping. `formatINR(120000) === "₹1,20,000"`.
 * The sign leads the symbol so a negative reads "-₹5,000", not "₹-5,000".
 */
export function formatINR(amount: number): string {
  if (!Number.isFinite(amount)) return EM_DASH;
  const rounded = Math.round(amount);
  const sign = rounded < 0 ? "-" : "";
  return `${sign}₹${INR_GROUPING.format(Math.abs(rounded))}`;
}

/** The 300–900 figure. Ungrouped: a four-digit ceiling never needs a comma. */
export function formatScore(score: number): string {
  if (!Number.isFinite(score)) return EM_DASH;
  return String(Math.round(score));
}

/** `ordinalDay(4) === "4th"` — used for the recommended EMI date. */
export function ordinalDay(day: number): string {
  if (!Number.isFinite(day)) return EM_DASH;
  const n = Math.round(day);
  const abs = Math.abs(n);
  const teen = abs % 100;
  if (teen >= 11 && teen <= 13) return `${n}th`;
  switch (abs % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** `formatDate(new Date("2026-03-12Z")) === "12 Mar 2026"`. */
export function formatDate(date: Date): string {
  if (Number.isNaN(date.getTime())) return EM_DASH;
  return DATE_FORMAT.format(date);
}

/**
 * A percentage that is ALREADY on a 0–100 scale (consistency index, cross-domain
 * coherence, interest rate). Does not multiply by 100.
 */
export function pct(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return EM_DASH;
  return `${value.toFixed(digits)}%`;
}

/** `formatDays(2.14) === "2.1d"` — compact enough to ride a bar end. */
export function formatDays(days: number, digits = 1): string {
  if (!Number.isFinite(days)) return EM_DASH;
  return `${days.toFixed(digits)}d`;
}

/** The direct label on every consistency bar: `σ 2.1d`. */
export function formatSigma(stdDevDays: number, digits = 1): string {
  return `σ ${formatDays(stdDevDays, digits)}`;
}

/** "Mar" or, when the year matters, "Jan '26". Axis ticks only. */
export function formatMonthShort(date: Date, withYear = false): string {
  if (Number.isNaN(date.getTime())) return EM_DASH;
  const month = MONTH_ABBR[date.getUTCMonth()];
  if (!withYear) return month;
  return `${month} ’${String(date.getUTCFullYear()).slice(2)}`;
}

/** Signed day offset for tooltips: "+4d late" / "3d early" / "on beat". */
export function formatBeatOffset(deltaDays: number, toleranceDays: number): string {
  if (!Number.isFinite(deltaDays)) return EM_DASH;
  if (Math.abs(deltaDays) <= toleranceDays) return "on beat";
  const magnitude = formatDays(Math.abs(deltaDays), 0);
  return deltaDays > 0 ? `${magnitude} late` : `${magnitude} early`;
}
