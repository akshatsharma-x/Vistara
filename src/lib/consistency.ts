/**
 * Vistara — the Temporal Consistency Engine.
 *
 * Every function in this file is PURE: no I/O, no randomness, no clock reads.
 * The only inputs are timestamps. We never look at an amount, a category or a
 * repayment outcome — the thesis is that *how consistently* someone repeats a
 * life event is a stronger character signal than *what* the event was.
 *
 * Reading order, if you are auditing the maths:
 *   1. computeMetrics                — per-behaviour dispersion -> 0-100 index
 *   2. computeCrossDomainConsistency — coherence across unrelated domains
 *   3. computeVistaraScore           — weighted blend -> 300-900
 *   4. tierForScore                  — risk state, with the thin-file gate
 *   5. classifyArchetype             — behavioural label
 *   6. recommendEmiDate              — circular-mean cash-flow alignment
 *   7. scoreProfile                  — the single entry point, + explainability
 *
 * Two rules govern every formula below:
 *   - Only cadence-NORMALISED dispersion is scored or banded, because only that
 *     figure is comparable between a 7-day and a 90-day rhythm.
 *   - Every number must be explainable to the customer in one sentence. If a
 *     term cannot be said out loud, it does not belong in a credit score.
 */

import {
  BEHAVIOR_META,
  BEHAVIOR_ORDER,
  BEHAVIOR_WEIGHTS,
  CONSISTENCY_BANDS,
  COVERAGE_ACTIONS,
  CROSS_DOMAIN_WEIGHT,
  GENERIC_ACTIONS,
  MAX_SEASONAL_EXCLUSIONS,
  MIN_EVENTS_TO_SCORE,
  MIN_RETAINED_GAPS,
  MIN_STREAMS_TO_SCORE,
  SCORE_MAX,
  SCORE_MIN,
  SEASONAL_GAP_MIN_MULTIPLE,
  SEASONAL_MONTHS,
  SEASONAL_OCCUPATIONS,
  SIGMA_CEILING_DAYS,
  SIGMA_FLOOR_DAYS,
  TIER_LOAN_CONFIG,
  TIER_THRESHOLDS,
  TIGHTEN_ACTIONS,
} from "@/lib/constants";
import {
  clamp,
  daysBetween,
  mapRange,
  mean,
  median,
  stdDevAround,
} from "@/lib/rng";
import type {
  BehaviorSource,
  BehaviorStream,
  ConsistencyBand,
  ConsistencyMetrics,
  CustomerProfile,
  EventStripData,
  FinancialArchetype,
  ImprovementAction,
  Occupation,
  ScoreFactor,
  TemporalProfile,
  Tier,
} from "@/lib/types";

/* ================================================================== *
 * Tunable engine constants
 * ------------------------------------------------------------------ *
 * Kept here rather than in constants.ts because they are *model
 * parameters* — the shape of the scorecard — not presentation tokens.
 * ================================================================== */

/**
 * A gap counts as "on beat" if it lands within this fraction of the expected
 * interval. 25% is the tolerance a collections team already works to: a monthly
 * bill paid within a week of its usual day is the same habit, a weekly commute
 * two days off is not. Expressed as a fraction so it scales with the cadence
 * instead of privileging slow rhythms.
 */
const ON_BEAT_RELATIVE_TOLERANCE = 0.25;

/**
 * Floor on that tolerance. Without it a 7-day FASTag cadence would demand
 * +/-1.75 days, which is finer than the day-level resolution of the data
 * itself, and every customer alive would read as permanently broken.
 */
const ON_BEAT_MIN_TOLERANCE_DAYS = 2;

/**
 * Reference cadence for normalisation. 30 days = the monthly rhythm most Indian
 * household obligations run on, so a normalised sigma reads as "the equivalent
 * slip on a monthly bill".
 */
const REFERENCE_CADENCE_DAYS = 30;

/**
 * Exponent on the cadence ratio when normalising sigma. 0.5 (square root)
 * encodes a deliberate judgement: dispersion tolerance grows with the cadence,
 * but SUB-linearly. A quarterly service may legitimately drift more days than a
 * weekly toll run, yet not proportionally more — nobody plans a 90-day interval
 * to +/-3 days but a 30-day one to +/-1.
 */
const CADENCE_NORMALISATION_EXPONENT = 0.5;

/**
 * Blend of the two dispersion views inside consistencyIndex.
 *
 * The cadence-normalised view carries the weight because it is the one that is
 * behaviourally true: a 5-day slip on a 7-day FASTag rhythm is a broken rhythm,
 * while a 5-day slip on a 90-day service rhythm is essentially perfect. Scoring
 * on absolute days alone would rate those two identically and make the whole
 * scorecard incoherent.
 *
 * A minority weight on absolute days is retained as a backstop: normalisation
 * divides by the square root of the cadence ratio, so a very slow rhythm could
 * otherwise normalise away a drift measured in months.
 */
const ABSOLUTE_SIGMA_WEIGHT = 0.25;
const RELATIVE_SIGMA_WEIGHT = 0.75;

/** On-beat run length at which the streak bonus saturates. */
const STREAK_SATURATION_EVENTS = 6;
/**
 * Maximum index points a trailing on-beat run can add. A current unbroken run
 * is the most forward-looking thing in the file — sigma is a verdict on 18
 * months, a streak is evidence about this month — but it stays a modifier, not
 * a second scorecard.
 */
const STREAK_BONUS_MAX = 8;

/**
 * Recovery is judged relative to the cadence: 10 days late on a monthly bill is
 * a missed cycle, 10 days late on a quarterly service is noise. The penalty
 * saturates once the average overshoot reaches 60% of the interval.
 *
 * The cap is deliberately modest. A skipped cycle already shows up once, and
 * strongly, inside sigma — one doubled gap in eighteen roughly doubles the
 * variance. Charging the same event again at full strength here would price it
 * twice, which is how a scorecard ends up unable to tell "slipped once" from
 * "has no rhythm at all".
 */
const RECOVERY_PENALTY_SATURATION_RATIO = 0.6;
const RECOVERY_PENALTY_MAX = 5;

/**
 * Cross-domain dispersion penalty, in index points per point of sigma across the
 * per-source indices.
 *
 * Kept deliberately modest because the geometric mean below ALREADY collapses
 * for an uneven profile — [100, 0, 100, 12, 27] has an arithmetic mean of 48 and
 * a geometric mean of 21. Charging a full dispersion penalty on top of that
 * prices incoherence twice, and the customer it lands on hardest is the Adapter:
 * someone with two exceptional eighteen-month rhythms would be handed the same
 * verdict as someone with no rhythm at all, which is neither true nor lendable.
 */
const CROSS_DOMAIN_DISPERSION_PENALTY = 0.35;

/** Archetype decision boundaries — see classifyArchetype for the reasoning. */
const ADAPTER_DISPERSION_MIN = 24;
const ADAPTER_STRONG_INDEX_MIN = 70;
const ADAPTER_WEAK_INDEX_MAX = 50;
const PLANNER_INDEX_MIN = 76;
const PLANNER_CROSS_DOMAIN_MIN = 68;
const AVOIDER_INDEX_MAX = 48;
const AVOIDER_RECOVERY_RATIO_MIN = 0.5;

/** Mean Gregorian month, used as the period of the day-of-month circle. */
const CIRCULAR_MONTH_DAYS = 30.44;
/** Days after the inferred income date on which we place the EMI. */
const EMI_BUFFER_DAYS = 2;
/** Latest day-of-month an EMI may fall on, so the date exists in February. */
const EMI_MAX_DAY = 28;
const EMI_MIN_DAY = 1;
/** Used only when a customer has no monthly rhythm at all to infer from. */
const EMI_FALLBACK_DAY = 5;
/**
 * A later source must beat a more-preferred one by this much circular R before
 * it is chosen. UPI recurring is the most direct read on income we have, so it
 * keeps the job unless something else is decisively more date-stable.
 */
const EMI_CONCENTRATION_MARGIN = 0.08;
/**
 * Below this circular R the day-of-month is effectively uniform: there is no
 * date to align to, and pretending otherwise would be false precision.
 */
const EMI_MIN_CONCENTRATION = 0.4;

/** Monthly-cadence sources, in preference order, for EMI inference. */
const EMI_SOURCE_PREFERENCE: BehaviorSource[] = [
  "upi_recurring",
  "utility_bill",
  "phone_recharge",
];

/**
 * Minimum expected cadence (days) for the seasonal-gap exclusion to apply.
 *
 * A seasonal pause is a coherent explanation only for behaviours whose natural
 * interval is long enough that a festival or harvest stretch can plausibly
 * interrupt the cycle. A 7-day toll rhythm's skipped week is a commute miss,
 * not a harvest. A 28-day phone-recharge skip is at most festival overspend.
 *
 * At 29 days: excludes fastag_toll (7d) and phone_recharge (28d), admits
 * utility_bill (30d), upi_recurring (30d), and vehicle_service (90d).
 *
 * CROSS-FILE INVARIANT — must stay in sync with SEASONAL_STRETCH_SOURCES in
 * src/lib/synthetic-data.ts. If the generator ever injects seasonal pauses into
 * a source whose cadence this engine will not forgive, the demo data contains
 * harvests the scorecard silently charges for — the inverse of the original bug
 * and harder to spot because it depresses a score rather than inflating one.
 * See RESOLVED-SEASONAL-SHORT-CADENCE in synthetic-data.ts for the full history
 * and the Balu S. (vst-avoider-2) worked example.
 */
const MIN_SEASONAL_CADENCE_DAYS = 29;

/** The share of the 300-900 range driven by single-domain consistency. */
const SINGLE_DOMAIN_WEIGHT = 1 - CROSS_DOMAIN_WEIGHT;
const SCORE_RANGE = SCORE_MAX - SCORE_MIN;

/** Index we assume a newly established rhythm reaches: the "strong" band. */
const NEW_SOURCE_TARGET_INDEX = 75;
/** Dispersion across domains above which the coherence action is offered. */
const COHERENCE_ACTION_DISPERSION_MIN = 16;
/** Mean recovery ratio above which the recovery action is offered. */
const RECOVERY_ACTION_RATIO_MIN = 0.35;
/** Below this many index points of gain an action is not worth showing. */
const MIN_ACTION_POINTS = 5;
/** Never show the customer more than this many things to do at once. */
const MAX_ACTIONS = 5;

export type ConsistencyBandEntry = (typeof CONSISTENCY_BANDS)[number];

/* ================================================================== *
 * 1. Per-behaviour metrics
 * ================================================================== */

/** The tolerance, in days, inside which a gap counts as on beat. */
export function onBeatToleranceDays(expectedIntervalDays: number): number {
  return Math.max(
    ON_BEAT_MIN_TOLERANCE_DAYS,
    expectedIntervalDays * ON_BEAT_RELATIVE_TOLERANCE,
  );
}

/**
 * Sigma restated as "the equivalent slip on a 30-day rhythm".
 * 12 days of drift on a 90-day service cadence normalises to ~6.9 days;
 * 2 days of drift on a 7-day FASTag cadence normalises to ~4.1 days.
 */
export function normalisedSigmaDays(
  stdDevDays: number,
  expectedIntervalDays: number,
): number {
  if (expectedIntervalDays <= 0) return stdDevDays;
  const ratio = REFERENCE_CADENCE_DAYS / expectedIntervalDays;
  return stdDevDays * ratio ** CADENCE_NORMALISATION_EXPONENT;
}

/**
 * The inverse of `normalisedSigmaDays`: given a slip expressed on the 30-day
 * reference cadence, the equivalent slip in real days on this cadence.
 *
 * Exported so the synthetic generator can express an archetype's rhythm quality
 * ONCE, at the reference cadence, and have it mean the same thing on a weekly
 * and a quarterly behaviour. Deriving it from the same two constants as the
 * forward transform is the point — a generator carrying its own copy of this
 * arithmetic would silently drift out of step with the scorer.
 */
export function sigmaDaysForNormalised(
  normalisedDays: number,
  expectedIntervalDays: number,
): number {
  if (expectedIntervalDays <= 0) return normalisedDays;
  const ratio = expectedIntervalDays / REFERENCE_CADENCE_DAYS;
  return normalisedDays * ratio ** CADENCE_NORMALISATION_EXPONENT;
}

/**
 * The qualitative band for a sigma.
 *
 * CONSISTENCY_BANDS is keyed off days so that a band means the same physical
 * thing everywhere; when the cadence is supplied we first restate sigma on the
 * 30-day reference cadence, so "Strong" describes comparable discipline on a
 * weekly and on a quarterly rhythm. Callers holding a ConsistencyMetrics should
 * pass `normalisedStdDevDays` with no cadence, or `stdDevDays` with one — both
 * routes give the same answer.
 */
export function bandForStdDev(
  stdDevDays: number,
  expectedIntervalDays?: number,
): ConsistencyBandEntry {
  const effective =
    expectedIntervalDays === undefined
      ? stdDevDays
      : normalisedSigmaDays(stdDevDays, expectedIntervalDays);

  for (const entry of CONSISTENCY_BANDS) {
    if (effective <= entry.maxStdDevDays) return entry;
  }
  return CONSISTENCY_BANDS[CONSISTENCY_BANDS.length - 1];
}

export function bandEntry(band: ConsistencyBand): ConsistencyBandEntry {
  const found = CONSISTENCY_BANDS.find((entry) => entry.band === band);
  return found ?? CONSISTENCY_BANDS[CONSISTENCY_BANDS.length - 1];
}

/** True when this occupation's income is cyclical enough to earn the exception. */
export function isSeasonalOccupation(occupation: Occupation): boolean {
  return SEASONAL_OCCUPATIONS.includes(occupation);
}

export interface MetricOptions {
  /**
   * Allow the documented seasonal exception. Set from the customer's occupation
   * via isSeasonalOccupation — never inferred from the data itself, because a
   * rule that decides for itself when to forgive a gap is not auditable.
   */
  seasonalityEligible?: boolean;
}

/** The zeroed metric returned for a stream too thin to score. */
function unscorableMetric(
  source: BehaviorSource,
  expectedIntervalDays: number,
  eventCount: number,
): ConsistencyMetrics {
  return {
    source,
    meanIntervalDays: 0,
    stdDevDays: 0,
    streakLength: 0,
    recoverySpeedDays: 0,
    consistencyIndex: 0,
    expectedIntervalDays,
    baselineIntervalDays: 0,
    normalisedStdDevDays: 0,
    // The band is meaningless while `scorable` is false; consumers must check
    // `scorable` before rendering it. We do not invent an "exceptional" band
    // out of an absence of evidence.
    band: "developing",
    eventCount,
    scorable: false,
    seasonalityAdjusted: false,
    excludedSeasonalGaps: 0,
  };
}

/**
 * Which gaps, if any, may be set aside as seasonal.
 *
 * A gap qualifies only if it CLOSES inside a seasonal window (the later event's
 * UTC month) and is at least SEASONAL_GAP_MIN_MULTIPLE times the median gap —
 * i.e. it is both in the right season and genuinely anomalous. We then exclude
 * at most the two largest, and never so many that fewer than MIN_RETAINED_GAPS
 * remain. Every constraint here exists to stop this exception becoming a
 * general-purpose way of making bad rhythm look good.
 */
function seasonalGapIndices(gaps: number[], timestamps: Date[]): number[] {
  if (gaps.length <= MIN_RETAINED_GAPS) return [];

  const medianGap = median(gaps);
  if (medianGap <= 0) return [];

  const candidates = gaps
    .map((gap, i) => ({ i, gap }))
    .filter(
      ({ i, gap }) =>
        gap >= SEASONAL_GAP_MIN_MULTIPLE * medianGap &&
        SEASONAL_MONTHS.includes(timestamps[i + 1].getUTCMonth()),
    )
    // Largest first: if we may only forgive two, forgive the two that a
    // seasonal explanation actually accounts for.
    .sort((a, b) => b.gap - a.gap || a.i - b.i);

  const budget = Math.min(
    MAX_SEASONAL_EXCLUSIONS,
    gaps.length - MIN_RETAINED_GAPS,
  );
  return candidates
    .slice(0, Math.max(0, budget))
    .map(({ i }) => i)
    .sort((a, b) => a - b);
}

export function computeMetrics(
  stream: BehaviorStream,
  options: MetricOptions = {},
): ConsistencyMetrics {
  const { source, timestamps, expectedIntervalDays } = stream;

  // GUARD: fewer than MIN_EVENTS_TO_SCORE observations is not a low score, it
  // is an absence of evidence. Two points define a single gap and therefore a
  // sigma of exactly zero — a fabricated "perfect" rhythm. We refuse instead,
  // and say so through `scorable`.
  if (timestamps.length < MIN_EVENTS_TO_SCORE) {
    return unscorableMetric(source, expectedIntervalDays, timestamps.length);
  }

  const allGaps: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    allGaps.push(daysBetween(timestamps[i - 1], timestamps[i]));
  }

  // Only cadences long enough for a harvest/festival pause to be a credible
  // explanation are eligible. fastag_toll (7d) and phone_recharge (28d) are
  // excluded: a skipped toll week or missed recharge is a commute/cash miss, not
  // a season. Threshold mirrors SEASONAL_STRETCH_SOURCES in synthetic-data.ts.
  const excluded =
    options.seasonalityEligible &&
    expectedIntervalDays >= MIN_SEASONAL_CADENCE_DAYS
      ? seasonalGapIndices(allGaps, timestamps)
      : [];
  const gaps = allGaps.filter((_, i) => !excluded.includes(i));
  const seasonalityAdjusted = excluded.length > 0;

  const meanIntervalDays = mean(gaps);
  // The baseline sigma is measured against. Median for seasonally-adjusted
  // profiles so a residual harvest gap cannot drag the centre with it; the mean
  // otherwise, where it is the natural centre of the distribution.
  const baselineIntervalDays = seasonalityAdjusted
    ? median(gaps)
    : meanIntervalDays;
  const stdDevDays = stdDevAround(gaps, baselineIntervalDays);
  const normalisedStdDevDays = normalisedSigmaDays(
    stdDevDays,
    expectedIntervalDays,
  );

  const tolerance = onBeatToleranceDays(expectedIntervalDays);

  // Trailing run of on-beat gaps. Two-sided: arriving far early is also a
  // departure from the rhythm, it is just a benign one. Excluded seasonal gaps
  // are not in `gaps`, so a forgiven harvest gap does not also break the streak
  // — forgiving it in one place and charging it in another would be dishonest.
  let streakLength = 0;
  for (let i = gaps.length - 1; i >= 0; i--) {
    if (Math.abs(gaps[i] - expectedIntervalDays) <= tolerance) streakLength++;
    else break;
  }

  // Recovery looks only at the gaps that broke the rhythm by running LATE, and
  // asks by how much. Someone who slips and returns quickly is a very different
  // risk from someone who slips and drifts.
  const overshoots = gaps
    .map((gap) => gap - expectedIntervalDays)
    .filter((delta) => delta > tolerance);
  const recoverySpeedDays = overshoots.length === 0 ? 0 : mean(overshoots);

  const consistencyIndex = consistencyIndexFrom(
    stdDevDays,
    normalisedStdDevDays,
    streakLength,
    recoverySpeedDays,
    expectedIntervalDays,
  );

  return {
    source,
    meanIntervalDays,
    stdDevDays,
    streakLength,
    recoverySpeedDays,
    consistencyIndex,
    expectedIntervalDays,
    baselineIntervalDays,
    normalisedStdDevDays,
    band: bandForStdDev(normalisedStdDevDays).band,
    eventCount: timestamps.length,
    scorable: true,
    seasonalityAdjusted,
    excludedSeasonalGaps: excluded.length,
  };
}

/**
 * consistencyIndex — 0 to 100.
 *
 *   absolute = mapRange(sigma,      1..21 -> 100..0)
 *   relative = mapRange(sigma_norm, 1..21 -> 100..0)
 *              where sigma_norm = sigma * (30 / interval) ^ 0.5
 *   base     = 0.25 * absolute + 0.75 * relative
 *   index    = clamp(base + streakBonus - recoveryPenalty, 0, 100)
 *
 *   streakBonus     = 0..8   over a 0..6 on-beat run
 *   recoveryPenalty = 0..5   over a 0..0.6 overshoot-to-interval ratio
 *
 * Both dispersion views use the same SIGMA_FLOOR/CEILING scale, so "21 days"
 * means one thing everywhere in the product. Said aloud: "your rhythm is this
 * tight, you are this far into an unbroken run, and this slow to come back
 * when you slip."
 */
function consistencyIndexFrom(
  stdDevDays: number,
  normalisedStdDevDays: number,
  streakLength: number,
  recoverySpeedDays: number,
  expectedIntervalDays: number,
): number {
  const absoluteIndex = mapRange(
    stdDevDays,
    SIGMA_FLOOR_DAYS,
    SIGMA_CEILING_DAYS,
    100,
    0,
  );
  const relativeIndex = mapRange(
    normalisedStdDevDays,
    SIGMA_FLOOR_DAYS,
    SIGMA_CEILING_DAYS,
    100,
    0,
  );
  const base =
    ABSOLUTE_SIGMA_WEIGHT * absoluteIndex +
    RELATIVE_SIGMA_WEIGHT * relativeIndex;

  return clamp(
    base +
      streakBonusFor(streakLength) -
      recoveryPenaltyFor(recoverySpeedDays, expectedIntervalDays),
    0,
    100,
  );
}

function streakBonusFor(streakLength: number): number {
  return mapRange(
    streakLength,
    0,
    STREAK_SATURATION_EVENTS,
    0,
    STREAK_BONUS_MAX,
  );
}

function recoveryPenaltyFor(
  recoverySpeedDays: number,
  expectedIntervalDays: number,
): number {
  return mapRange(
    expectedIntervalDays > 0 ? recoverySpeedDays / expectedIntervalDays : 0,
    0,
    RECOVERY_PENALTY_SATURATION_RATIO,
    0,
    RECOVERY_PENALTY_MAX,
  );
}

export function computeAllMetrics(
  streams: BehaviorStream[],
  options: MetricOptions = {},
): ConsistencyMetrics[] {
  return streams.map((stream) => computeMetrics(stream, options));
}

/* ================================================================== *
 * 2. Cross-domain consistency
 * ================================================================== */

/**
 * Coherence across unrelated domains — the actual thesis of the product.
 *
 *   cross = geometricMean(indices) - 0.35 * stdDev(indices)
 *
 * The central-tendency term is the GEOMETRIC mean, not the arithmetic one,
 * because the arithmetic mean lets one perfect domain buy off four broken ones:
 * [100, 20, 20, 20, 20] averages 36, which overstates a customer with exactly
 * one habit. The geometric mean of the same set is 31 and collapses toward zero
 * as any single domain does — it cannot be bought with excellence in one place.
 *
 * A dispersion penalty is then subtracted so that being EVENLY consistent is
 * explicitly rewarded: five indices of 60 return 60, while [100, 20, 20, 20,
 * 20] returns about 14. Consistency in one domain can be coincidence;
 * consistency across unrelated domains is character.
 */
export function computeCrossDomainConsistency(
  metrics: ConsistencyMetrics[],
): number {
  const indices = metrics
    .filter((m) => m.scorable)
    .map((m) => m.consistencyIndex);

  if (indices.length === 0) return 0;
  if (indices.length === 1) {
    // A single observed rhythm carries no cross-domain evidence at all, so we
    // report it at half strength rather than calling it coherence.
    return round1(indices[0] * 0.5);
  }

  // The +1 inside the log keeps a zero index finite while preserving the
  // collapse-toward-zero behaviour we want from the product.
  const logMean = mean(indices.map((v) => Math.log(v + 1)));
  const geometricMean = Math.exp(logMean) - 1;
  const dispersion = stdDevAround(indices, mean(indices));

  return round1(
    clamp(geometricMean - CROSS_DOMAIN_DISPERSION_PENALTY * dispersion, 0, 100),
  );
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/* ================================================================== *
 * 3. The Vistara score
 * ================================================================== */

/** Weights renormalised over the sources actually scored. */
function normalisedWeights(
  metrics: ConsistencyMetrics[],
): Map<BehaviorSource, number> {
  const scorable = metrics.filter((m) => m.scorable);
  const total = scorable.reduce(
    (sum, m) => sum + (BEHAVIOR_WEIGHTS[m.source] ?? 0),
    0,
  );
  const out = new Map<BehaviorSource, number>();
  if (total <= 0) return out;
  for (const m of scorable) {
    out.set(m.source, (BEHAVIOR_WEIGHTS[m.source] ?? 0) / total);
  }
  return out;
}

/**
 * Weighted single-domain consistency blended with the cross-domain term, then
 * mapped onto 300-900.
 *
 * Weights are renormalised over the streams actually SCORED, so a first-time
 * buyer with no service history is not silently docked 0.30 of missing weight.
 * They are judged on the rhythms they do have; the thin-file gate in
 * tierForScore handles the case where there are too few of them, and
 * dataCompleteness discloses it on the scorecard either way.
 */
export function computeVistaraScore(
  metrics: ConsistencyMetrics[],
  crossDomainConsistency: number,
): number {
  const weights = normalisedWeights(metrics);

  let singleDomain = 0;
  for (const metric of metrics) {
    const weight = weights.get(metric.source);
    if (weight === undefined) continue;
    singleDomain += weight * metric.consistencyIndex;
  }

  const blended =
    SINGLE_DOMAIN_WEIGHT * singleDomain +
    CROSS_DOMAIN_WEIGHT * crossDomainConsistency;

  return Math.round(mapRange(blended, 0, 100, SCORE_MIN, SCORE_MAX));
}

/* ================================================================== *
 * 4. Tier
 * ================================================================== */

/**
 * THIN_FILE is reached two ways, and only one of them is about the score.
 *
 * The gate comes first: with fewer than MIN_STREAMS_TO_SCORE observed rhythms
 * we have not seen enough to form a view, whatever the arithmetic says. "We
 * could not observe enough rhythm" and "we observed it and it is poor" call for
 * different products — a rhythm-building path versus a small rhythm-aligned
 * ticket — and collapsing the first into the second is exactly the failure this
 * engine exists to correct. Consumers should read `dataCompleteness` alongside
 * the tier to tell the two apart.
 */
export function tierForScore(score: number, scorableStreamCount: number): Tier {
  if (scorableStreamCount < MIN_STREAMS_TO_SCORE) return "THIN_FILE";
  if (score >= TIER_THRESHOLDS.PRIME) return "PRIME";
  if (score >= TIER_THRESHOLDS.NEAR_PRIME) return "NEAR_PRIME";
  if (score >= TIER_THRESHOLDS.DEVELOPING) return "DEVELOPING";
  return "THIN_FILE";
}

/* ================================================================== *
 * 5. Archetype
 * ================================================================== */

/**
 * Four behavioural shapes, tested in strict precedence order. The precedence
 * matters more than the thresholds:
 *
 * 1. ADAPTER first. A split profile (excellent somewhere, weak elsewhere) has
 *    middling averages, so any average-based rule would mislabel it as REACTOR
 *    or AVOIDER and we would lose the most lendable insight we have: align the
 *    EMI to the rhythm they already keep.
 * 2. PLANNER next — tight sigma AND coherent across domains. Requiring the
 *    cross-domain term too stops a two-strong-domain profile from claiming it.
 * 3. AVOIDER next — wide sigma AND slow recovery, both required. Wide sigma
 *    with quick recovery is a REACTOR, not an AVOIDER.
 * 4. REACTOR is the residual: middling dispersion, but it comes back fast.
 */
export function classifyArchetype(
  metrics: ConsistencyMetrics[],
  crossDomainConsistency: number,
): FinancialArchetype {
  const scorable = metrics.filter((m) => m.scorable);
  if (scorable.length === 0) return "AVOIDER";

  const indices = scorable.map((m) => m.consistencyIndex);
  const meanIndex = mean(indices);
  const dispersion = stdDevAround(indices, meanIndex);
  const strongest = Math.max(...indices);
  const weakest = Math.min(...indices);
  const meanRecoveryRatio = mean(
    scorable.map((m) => m.recoverySpeedDays / Math.max(1, m.baselineIntervalDays)),
  );

  if (
    dispersion >= ADAPTER_DISPERSION_MIN &&
    strongest >= ADAPTER_STRONG_INDEX_MIN &&
    weakest <= ADAPTER_WEAK_INDEX_MAX
  ) {
    return "ADAPTER";
  }

  if (
    meanIndex >= PLANNER_INDEX_MIN &&
    crossDomainConsistency >= PLANNER_CROSS_DOMAIN_MIN
  ) {
    return "PLANNER";
  }

  if (
    meanIndex <= AVOIDER_INDEX_MAX &&
    meanRecoveryRatio >= AVOIDER_RECOVERY_RATIO_MIN
  ) {
    return "AVOIDER";
  }

  return "REACTOR";
}

/* ================================================================== *
 * 6. EMI date recommendation
 * ================================================================== */

/**
 * Circular mean of a set of day-of-month values.
 *
 * THIS IS THE WHOLE POINT: day-of-month is a CIRCLE, not a number line. A
 * customer paid on the 30th, the 1st and the 2nd is paid at the turn of the
 * month — those days span 3 days, not 29. The arithmetic mean of that set is
 * the 11th, and a turn-of-month customer with an EMI on the 11th defaults for
 * reasons that have nothing to do with willingness to pay. So we map each day
 * onto an angle, average the unit vectors, and atan2 back:
 *
 *   theta_i = 2*pi * (day_i - 1) / 30.44
 *   day_bar = 1 + 30.44 * atan2(mean sin, mean cos) / (2*pi)
 *
 * The period is the mean Gregorian month (30.44 days) so the circle closes
 * consistently regardless of which calendar months were observed.
 */
export function circularMeanDayOfMonth(daysOfMonth: number[]): number {
  if (daysOfMonth.length === 0) return EMI_FALLBACK_DAY;

  const { sumCos, sumSin } = circularSums(daysOfMonth);

  // Degenerate case: the vectors cancel (perfectly antipodal days), so there is
  // no mean direction at all. Fall back to the first observation rather than
  // emitting the meaningless atan2(0, 0) = 0.
  if (Math.abs(sumCos) < 1e-9 && Math.abs(sumSin) < 1e-9) {
    return daysOfMonth[0];
  }

  let theta = Math.atan2(sumSin, sumCos);
  if (theta < 0) theta += 2 * Math.PI;
  return 1 + (theta / (2 * Math.PI)) * CIRCULAR_MONTH_DAYS;
}

function circularSums(daysOfMonth: number[]): {
  sumCos: number;
  sumSin: number;
} {
  let sumCos = 0;
  let sumSin = 0;
  for (const day of daysOfMonth) {
    const theta = (2 * Math.PI * (day - 1)) / CIRCULAR_MONTH_DAYS;
    sumCos += Math.cos(theta);
    sumSin += Math.sin(theta);
  }
  return { sumCos, sumSin };
}

/**
 * Circular concentration R, from 0 to 1: the resultant length of the same unit
 * vectors, divided by their count. 1 means every event landed on the same day
 * of the month; 0 means they are spread right around it.
 *
 * This — not gap sigma — is the right way to choose the source we read an income
 * date from. A 28-day recharge pack has a beautifully tight gap sigma and yet
 * walks backwards through the calendar by two days every month, so its
 * day-of-month carries no information about when money arrives. R sees that
 * immediately; sigma cannot see it at all.
 */
export function circularConcentration(daysOfMonth: number[]): number {
  if (daysOfMonth.length === 0) return 0;
  const { sumCos, sumSin } = circularSums(daysOfMonth);
  return Math.hypot(sumCos, sumSin) / daysOfMonth.length;
}

/**
 * Infer the day of the month on which this customer's money reliably lands,
 * then place the EMI a short buffer after it.
 *
 * Source choice: only a monthly rhythm can carry a day-of-month signal, so we
 * consider UPI recurring, then the utility bill, then the phone recharge. Among
 * those that are scorable we take the one whose day-of-month is most
 * CONCENTRATED (highest circular R), preferring the earlier source in that list
 * unless a later one is clearly better. Concentration, not gap regularity, is
 * the question being asked: "does their money land on the same date?"
 *
 * All day extraction uses UTC getters. Local-time getters would shift the
 * day-of-month by one in negative-offset timezones, making the recommendation
 * depend on where the server happens to run: a hydration mismatch waiting to
 * happen, and a support ticket nobody could reproduce.
 */
export function recommendEmiDate(streams: BehaviorStream[]): number {
  const candidates = EMI_SOURCE_PREFERENCE.map((source) =>
    streams.find((s) => s.source === source),
  ).filter((s): s is BehaviorStream => s !== undefined);

  let chosen: BehaviorStream | undefined;
  let bestConcentration = -1;

  for (const stream of candidates) {
    if (!computeMetrics(stream).scorable) continue;
    const r = circularConcentration(stream.timestamps.map((t) => t.getUTCDate()));
    // Strictly better by a margin, so the preference order wins ties and
    // near-ties: UPI recurring is the most direct read on income there is.
    if (r > bestConcentration + EMI_CONCENTRATION_MARGIN) {
      bestConcentration = r;
      chosen = stream;
    }
  }

  // Fallbacks, in order: any monthly candidate with an observation at all, then
  // any stream at all, then the documented default.
  if (chosen === undefined) {
    chosen =
      candidates.find((s) => s.timestamps.length > 0) ??
      streams.find((s) => s.timestamps.length > 0);
  }
  if (chosen === undefined) return EMI_FALLBACK_DAY;

  const daysOfMonth = chosen.timestamps.map((t) => t.getUTCDate());

  // When nothing lands on a stable date — a drifting recharge cycle, or a gig
  // worker paid whenever the work ends — the circular mean of eighteen months is
  // a direction with no magnitude behind it, and averaging it would be false
  // precision. Anchor to the most recent payment day instead: it is the one date
  // we know this customer had money on.
  const incomeDay =
    circularConcentration(daysOfMonth) < EMI_MIN_CONCENTRATION
      ? daysOfMonth[daysOfMonth.length - 1]
      : circularMeanDayOfMonth(daysOfMonth);

  // Buffer, then wrap FORWARD across the month boundary. The 28th + 2 days is
  // the 2nd of next month, not the 28th — clamping would move the debit
  // EARLIER than the income it is buffered against, which is the failure the
  // buffer exists to prevent. While-loop so the wrap is correct at every day
  // in 27–28 (single `if` with a hardcoded 30 missed both).
  let day = Math.round(incomeDay) + EMI_BUFFER_DAYS;
  while (day > EMI_MAX_DAY) day -= EMI_MAX_DAY;
  return clamp(day, EMI_MIN_DAY, EMI_MAX_DAY);
}

/* ================================================================== *
 * 7. Explainability — the scorecard and the path to prime
 * ================================================================== */

/** Points of the 300-900 score attributable to one source. */
function pointsFor(weight: number, consistencyIndex: number): number {
  return weight * (consistencyIndex / 100) * SINGLE_DOMAIN_WEIGHT * SCORE_RANGE;
}

/**
 * One plain sentence per behaviour, safe to read aloud to the customer. No
 * jargon, no index, no sigma: a cadence, a tolerance, and what it means.
 */
function explain(metric: ConsistencyMetrics): string {
  const short = BEHAVIOR_META[metric.source].short;
  const every = Math.round(metric.baselineIntervalDays);
  const slip = metric.stdDevDays < 1 ? "under a day" : `${metric.stdDevDays.toFixed(1)} days`;

  const verdict: Record<ConsistencyBand, string> = {
    exceptional: "That is a rhythm we can lend against.",
    strong: "That is a dependable rhythm.",
    moderate: "The rhythm is there, but it drifts.",
    developing: "This rhythm is not yet steady enough to rely on.",
  };

  const streak =
    metric.streakLength >= 3
      ? ` Your last ${metric.streakLength} were all on time.`
      : "";
  const seasonal = metric.seasonalityAdjusted
    ? ` ${metric.excludedSeasonalGaps === 1 ? "One seasonal gap was" : `${metric.excludedSeasonalGaps} seasonal gaps were`} set aside.`
    : "";

  return `${short} repeats about every ${every} days, give or take ${slip}. ${verdict[metric.band]}${streak}${seasonal}`;
}

/** The scorecard: one row per scored source, ordered by points contributed. */
export function buildScoreFactors(metrics: ConsistencyMetrics[]): ScoreFactor[] {
  const weights = normalisedWeights(metrics);

  return metrics
    .filter((m) => m.scorable && weights.has(m.source))
    .map((metric) => {
      const weight = weights.get(metric.source) ?? 0;
      return {
        source: metric.source,
        label: BEHAVIOR_META[metric.source].label,
        weight,
        consistencyIndex: metric.consistencyIndex,
        band: metric.band,
        points: Math.round(pointsFor(weight, metric.consistencyIndex)),
        explanation: explain(metric),
        seasonalityAdjusted: metric.seasonalityAdjusted,
      };
    })
    .sort((a, b) => b.points - a.points);
}

/**
 * Re-scores the customer with a hypothetical set of per-source indices. Used
 * only to price improvement actions, so that every "+25 points" we show is the
 * engine's own arithmetic on this customer's own file rather than a guess.
 */
function projectedScore(
  metrics: ConsistencyMetrics[],
  overrides: Map<BehaviorSource, number>,
): number {
  const projected: ConsistencyMetrics[] = metrics.map((m) => {
    const override = overrides.get(m.source);
    if (override === undefined) return m;
    return {
      ...m,
      consistencyIndex: clamp(override, 0, 100),
      // An overridden source is by definition one we are pretending to have.
      scorable: true,
    };
  });

  // Sources absent from `metrics` entirely (the cold-start case) still need a
  // row before they can carry weight.
  overrides.forEach((index, source) => {
    if (projected.some((m) => m.source === source)) return;
    const expected = BEHAVIOR_META[source].expectedIntervalDays;
    projected.push({
      ...unscorableMetric(source, expected, MIN_EVENTS_TO_SCORE),
      meanIntervalDays: expected,
      baselineIntervalDays: expected,
      consistencyIndex: clamp(index, 0, 100),
      scorable: true,
    });
  });

  return computeVistaraScore(projected, computeCrossDomainConsistency(projected));
}

/** Estimates are estimates: they are shown to the customer rounded to 5s. */
function round5(value: number): number {
  return Math.round(value / 5) * 5;
}

/**
 * Path to Prime. Every action is a rhythm change the customer can actually
 * make, priced by re-running the engine on their own file with that one change
 * applied. Ranked by gain, so the first row is always the best use of their
 * next three months.
 */
export function buildImprovementActions(
  metrics: ConsistencyMetrics[],
  currentScore: number,
  missingSources: BehaviorSource[],
): ImprovementAction[] {
  const actions: ImprovementAction[] = [];
  const scorable = metrics.filter((m) => m.scorable);

  // (a) Coverage — a signal we cannot see at all. The cold-start path.
  for (const source of missingSources) {
    const copy = COVERAGE_ACTIONS[source];
    const gain =
      projectedScore(
        metrics,
        new Map([[source, NEW_SOURCE_TARGET_INDEX]]),
      ) - currentScore;
    actions.push({
      id: `coverage-${source}`,
      lever: source,
      title: copy.title,
      detail: copy.detail,
      potentialPoints: round5(Math.max(0, gain)),
      horizonMonths: copy.horizonMonths,
    });
  }

  // (b) Tighten — a signal that exists but wobbles. Target is the top of the
  // next band up, never a fantasy of perfection.
  for (const metric of scorable) {
    const bandIndex = CONSISTENCY_BANDS.findIndex(
      (entry) => entry.band === metric.band,
    );
    if (bandIndex <= 0) continue; // already in the top band
    const nextBand = CONSISTENCY_BANDS[bandIndex - 1];
    const target = mapRange(
      nextBand.maxStdDevDays,
      SIGMA_FLOOR_DAYS,
      SIGMA_CEILING_DAYS,
      100,
      0,
    );
    if (target <= metric.consistencyIndex) continue;

    const copy = TIGHTEN_ACTIONS[metric.source];
    const gain =
      projectedScore(metrics, new Map([[metric.source, target]])) - currentScore;
    actions.push({
      id: `tighten-${metric.source}`,
      lever: metric.source,
      title: copy.title,
      detail: copy.detail,
      potentialPoints: round5(Math.max(0, gain)),
      horizonMonths: copy.horizonMonths,
    });
  }

  if (scorable.length >= 2) {
    const indices = scorable.map((m) => m.consistencyIndex);
    const dispersion = stdDevAround(indices, mean(indices));

    // (c) Coherence — lift the weakest domain to the middle of the pack. This is
    // the one action that moves the cross-domain term, which is why it often
    // outranks tightening an already-good rhythm.
    if (dispersion >= COHERENCE_ACTION_DISPERSION_MIN) {
      const weakest = scorable.reduce((lo, m) =>
        m.consistencyIndex < lo.consistencyIndex ? m : lo,
      );
      const target = median(indices);
      if (target > weakest.consistencyIndex) {
        const gain =
          projectedScore(metrics, new Map([[weakest.source, target]])) -
          currentScore;
        actions.push({
          id: "coherence-cross-domain",
          lever: "cross_domain",
          title: GENERIC_ACTIONS.cross_domain.title,
          detail: GENERIC_ACTIONS.cross_domain.detail,
          potentialPoints: round5(Math.max(0, gain)),
          horizonMonths: GENERIC_ACTIONS.cross_domain.horizonMonths,
        });
      }
    }

    // (d) Recovery — come back inside three days after a slip. Priced by
    // removing exactly the recovery penalty this customer is currently paying.
    const recoveryRatio = mean(
      scorable.map(
        (m) => m.recoverySpeedDays / Math.max(1, m.baselineIntervalDays),
      ),
    );
    if (recoveryRatio >= RECOVERY_ACTION_RATIO_MIN) {
      const overrides = new Map<BehaviorSource, number>();
      for (const m of scorable) {
        const penalty = recoveryPenaltyFor(
          m.recoverySpeedDays,
          m.expectedIntervalDays,
        );
        if (penalty > 0) overrides.set(m.source, m.consistencyIndex + penalty);
      }
      if (overrides.size > 0) {
        actions.push({
          id: "generic-recovery",
          lever: "recovery",
          title: GENERIC_ACTIONS.recovery.title,
          detail: GENERIC_ACTIONS.recovery.detail,
          potentialPoints: round5(
            Math.max(0, projectedScore(metrics, overrides) - currentScore),
          ),
          horizonMonths: GENERIC_ACTIONS.recovery.horizonMonths,
        });
      }
    }

    // (e) Streak — an unbroken run, priced by granting the full streak bonus.
    const overrides = new Map<BehaviorSource, number>();
    for (const m of scorable) {
      const headroom = STREAK_BONUS_MAX - streakBonusFor(m.streakLength);
      if (headroom > 0) overrides.set(m.source, m.consistencyIndex + headroom);
    }
    if (overrides.size > 0) {
      actions.push({
        id: "generic-streak",
        lever: "streak",
        title: GENERIC_ACTIONS.streak.title,
        detail: GENERIC_ACTIONS.streak.detail,
        potentialPoints: round5(
          Math.max(0, projectedScore(metrics, overrides) - currentScore),
        ),
        horizonMonths: GENERIC_ACTIONS.streak.horizonMonths,
      });
    }
  }

  return actions
    .filter((action) => action.potentialPoints >= MIN_ACTION_POINTS)
    .sort(
      (a, b) =>
        b.potentialPoints - a.potentialPoints ||
        a.horizonMonths - b.horizonMonths ||
        a.id.localeCompare(b.id),
    )
    .slice(0, MAX_ACTIONS);
}

/**
 * The event strip: 18 months of real timestamps, each marked on-beat or not
 * against its own cadence. Pure data — the chart component reads this and never
 * touches the scoring layer. `onTime` uses the same on-beat tolerance the
 * streak does, so the picture and the number can never disagree.
 *
 * Chronology is inherited, not imposed: `BehaviorStream.timestamps` is ascending
 * by contract, and `map` preserves that, so the strip needs no sort of its own.
 */
// Contract: one verdict per observed timestamp, chronological, first always onTime
export function buildEventStrip(
  stream: BehaviorStream,
  metric: ConsistencyMetrics,
): EventStripData {
  const tolerance = onBeatToleranceDays(stream.expectedIntervalDays);

  return {
    source: stream.source,
    label: stream.label,
    events: stream.timestamps.map((date, i) => ({
      date,
      // The first event has no preceding gap, so there is nothing it can be
      // late against. Treat it as on beat rather than inventing a verdict.
      onTime:
        i === 0 ||
        Math.abs(
          daysBetween(stream.timestamps[i - 1], date) -
            stream.expectedIntervalDays,
        ) <= tolerance,
    })),
    expectedIntervalDays: stream.expectedIntervalDays,
    consistencyIndex: metric.consistencyIndex,
  };
}

/* ================================================================== *
 * Entry point
 * ================================================================== */

/** Runs the whole engine over one customer's observed rhythms. */
export function scoreProfile(
  customer: CustomerProfile,
  streams: BehaviorStream[],
): TemporalProfile {
  const metrics = computeAllMetrics(streams, {
    seasonalityEligible: isSeasonalOccupation(customer.occupation),
  });

  const scored = metrics.filter((m) => m.scorable);
  const scoredSources = scored.map((m) => m.source);
  const missingSources = BEHAVIOR_ORDER.filter(
    (source) => !scoredSources.includes(source),
  );

  const crossDomainConsistency = computeCrossDomainConsistency(metrics);
  const vistaraScore = computeVistaraScore(metrics, crossDomainConsistency);
  const tier = tierForScore(vistaraScore, scored.length);
  const loan = TIER_LOAN_CONFIG[tier];

  return {
    customer,
    streams,
    metrics,
    crossDomainConsistency,
    vistaraScore,
    tier,
    financialArchetype: classifyArchetype(metrics, crossDomainConsistency),
    recommendedEmiDate: recommendEmiDate(streams),
    maxLoanAmount: loan.maxLoanAmount,
    interestRate: loan.interestRate,
    dataCompleteness: scored.length / BEHAVIOR_ORDER.length,
    scoredSources,
    missingSources,
    seasonalityAdjusted: metrics.some((m) => m.seasonalityAdjusted),
    factors: buildScoreFactors(metrics),
    improvementActions: buildImprovementActions(
      metrics,
      vistaraScore,
      missingSources,
    ),
  };
}
