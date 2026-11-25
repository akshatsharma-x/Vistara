/**
 * Vistara — Temporal Consistency Engine
 * Shared type contract. Every module in the app builds against this file.
 *
 * Core thesis: financial reliability is a *behavioural* trait, not a financial
 * one. We do not score amounts or categories — we score the TIMING of recurring
 * life events. Every metric below is derived from timestamps alone.
 */

/* ------------------------------------------------------------------ *
 * Enumerations
 * ------------------------------------------------------------------ */

export type Occupation =
  | "gig_worker"
  | "small_merchant"
  | "salaried_informal"
  | "farmer"
  | "self_employed";

/**
 * NOTE: spelled `fastag_toll` (FASTag, the Indian electronic toll system).
 * The original spec draft had `fastack_toll` in this union but `fastag_toll`
 * in BEHAVIOR_WEIGHTS — a mismatch that would have made the weight lookup
 * silently return undefined. Canonical spelling is `fastag_toll`.
 */
export type BehaviorSource =
  | "vehicle_service"
  | "upi_recurring"
  | "utility_bill"
  | "phone_recharge"
  | "fastag_toll";

export type Tier = "PRIME" | "NEAR_PRIME" | "DEVELOPING" | "THIN_FILE";

export type FinancialArchetype = "PLANNER" | "REACTOR" | "AVOIDER" | "ADAPTER";

/* ------------------------------------------------------------------ *
 * Customer
 * ------------------------------------------------------------------ */

export interface CustomerProfile {
  id: string;
  name: string;
  age: number;
  /** District / city. Display only — never an input to the score. */
  city: string;
  occupation: Occupation;
  monthlyIncome: number;
  hasCibilScore: boolean;
  cibilScore?: number;
  /**
   * COLD START. Which behavioural signals this customer actually has.
   *
   * A first-time two-wheeler buyer has no TVS service history at all — and that
   * is precisely the customer in the problem statement. Rather than quietly
   * imputing a rhythm we do not observe, an absent source is recorded as
   * absent, excluded from the weighted score, and surfaced to the officer as
   * reduced data completeness. Absent keys are treated as unavailable.
   */
  streamAvailability: Partial<Record<BehaviorSource, boolean>>;
}

/* ------------------------------------------------------------------ *
 * Raw behavioural evidence
 * ------------------------------------------------------------------ */

/**
 * A single recurring behaviour observed over the trailing 18 months.
 * `timestamps` is ascending (oldest first) — consumers may rely on that order.
 */
export interface BehaviorStream {
  source: BehaviorSource;
  label: string;
  timestamps: Date[];
  expectedIntervalDays: number;
}

/* ------------------------------------------------------------------ *
 * Derived signal
 * ------------------------------------------------------------------ */

export interface ConsistencyMetrics {
  source: BehaviorSource;
  /** Mean gap between consecutive events, in days. */
  meanIntervalDays: number;
  /** THE core signal. Population sigma of the gaps. Lower = more consistent. */
  stdDevDays: number;
  /** Current unbroken run of on-rhythm events (trailing). */
  streakLength: number;
  /** Mean days beyond the expected interval when the rhythm slips. */
  recoverySpeedDays: number;
  /** 0–100 per-source consistency score derived from the four fields above. */
  consistencyIndex: number;

  /* --- context needed to read the four fields above honestly --- */

  /** The cadence this behaviour is expected to repeat on (90d, 30d, 7d…). */
  expectedIntervalDays: number;
  /**
   * The rhythm baseline sigma was actually measured against: the median gap for
   * seasonally-adjusted profiles, the mean gap otherwise.
   */
  baselineIntervalDays: number;
  /**
   * `stdDevDays` rescaled to a 30-day reference cadence. A 5-day slip on a
   * 7-day FASTag rhythm is a broken habit; the same 5 days on a 90-day service
   * rhythm is near-perfect. Only this figure is comparable across sources, so
   * only this figure is scored or banded.
   */
  normalisedStdDevDays: number;
  band: ConsistencyBand;
  eventCount: number;
  /** False when there are too few events to claim a rhythm exists. */
  scorable: boolean;

  /**
   * SEASONALITY. True when harvest/festival-cycle gaps were excluded before
   * sigma was computed. A rice farmer services in February and August, not
   * every 90 days; scoring that as irregularity would penalise exactly the
   * customers this product exists to serve.
   */
  seasonalityAdjusted: boolean;
  /** How many gaps the seasonal adjustment removed (0–2). */
  excludedSeasonalGaps: number;
  /**
   * Which gaps it removed: index i is the gap between timestamps[i] and
   * timestamps[i + 1]. Lets the event strip draw a forgiven gap as forgiven
   * instead of as late, so the picture agrees with the streak. Optional only
   * so a hand-built exhibit, or a profile stored by an older build, can omit it.
   */
  excludedGapIndices?: number[];
}

/* ------------------------------------------------------------------ *
 * Full scored profile
 * ------------------------------------------------------------------ */

export interface TemporalProfile {
  customer: CustomerProfile;
  streams: BehaviorStream[];
  metrics: ConsistencyMetrics[];
  /**
   * 0–100. Rewards being *evenly* consistent across domains and penalises
   * single-domain consistency: one reliable habit can be coincidence, a
   * reliable pattern across unrelated domains is character.
   */
  crossDomainConsistency: number;
  /** 300–900, mirroring the range Indian lenders already read fluently. */
  vistaraScore: number;
  tier: Tier;
  financialArchetype: FinancialArchetype;
  /** Day of month (1–28) aligned to the customer's own cash-flow rhythm. */
  recommendedEmiDate: number;
  maxLoanAmount: number;
  /** Annual interest rate as a percentage, e.g. 14.5 */
  interestRate: number;

  /* --- honesty about the evidence base --- */

  /**
   * 0–1. Share of the five signals that were available AND had enough events
   * to score. Rendered verbatim on the scorecard ("Score based on 3 of 5
   * signals") so nobody mistakes a sparse score for a complete one.
   */
  dataCompleteness: number;
  scoredSources: BehaviorSource[];
  missingSources: BehaviorSource[];
  /** True if any stream had harvest/festival gaps excluded. */
  seasonalityAdjusted: boolean;

  /** Per-source breakdown, ordered by points contributed. The scorecard. */
  factors: ScoreFactor[];
  /** Ranked, highest-gain first. Drives the "Path to Prime" panel. */
  improvementActions: ImprovementAction[];
}

/* ------------------------------------------------------------------ *
 * Explainability
 * ------------------------------------------------------------------ */

/** One row of the scorecard: what this behaviour contributed, and why. */
export interface ScoreFactor {
  source: BehaviorSource;
  label: string;
  /** Weight actually applied, after renormalising over available sources. */
  weight: number;
  consistencyIndex: number;
  band: ConsistencyBand;
  /** Points of the 300–900 score attributable to this source. */
  points: number;
  /** Plain-language reason, safe to read aloud to the customer. */
  explanation: string;
  seasonalityAdjusted: boolean;
}

export type ImprovementLever =
  | BehaviorSource
  | "cross_domain"
  | "coverage"
  | "recovery"
  | "streak";

export interface ImprovementAction {
  id: string;
  lever: ImprovementLever;
  title: string;
  detail: string;
  /** Estimated score gain if followed. Rounded to 5s — it is an estimate. */
  potentialPoints: number;
  horizonMonths: number;
}

/* ------------------------------------------------------------------ *
 * Visualisation contract
 * ------------------------------------------------------------------ */

/**
 * The event strip is Vistara's signature visual: one row per behaviour, 18
 * months of real timestamps as dots against the expected cadence behind them.
 * A Planner renders as an even comb, an Avoider visibly clusters and gaps —
 * the thesis becomes self-evident without a sentence of explanation.
 *
 * This is a pure data contract: the chart component reads it and never touches
 * the scoring layer.
 */
export interface EventStripData {
  source: BehaviorSource;
  label: string;
  events: { date: Date; onTime: boolean }[];
  expectedIntervalDays: number;
  consistencyIndex: number;
}

/* ------------------------------------------------------------------ *
 * Presentation helpers
 * ------------------------------------------------------------------ */

/** Qualitative band for a single consistency index. Drives status colour. */
export type ConsistencyBand =
  | "exceptional"
  | "strong"
  | "moderate"
  | "developing";

export interface TierPresentation {
  label: string;
  /** Hex token; always rendered alongside the label + icon, never alone. */
  color: string;
  /** Non-colour redundant channel, required by the accessibility pass. */
  icon: string;
  description: string;
  lendingAction: string;
}

export interface LoanConfig {
  maxLoanAmount: number;
  interestRate: number;
  tenureMonths: number;
}
