/**
 * Vistara — scoring constants, thresholds and presentation tokens.
 * Single source of truth. No magic numbers anywhere else in the app.
 */

import type {
  BehaviorSource,
  ConsistencyBand,
  FinancialArchetype,
  LoanConfig,
  Occupation,
  Tier,
  TierPresentation,
} from "./types";

/* ------------------------------------------------------------------ *
 * Score range
 * ------------------------------------------------------------------ */

export const SCORE_MIN = 300;
export const SCORE_MAX = 900;

/** Months of trailing behavioural history the engine reads. */
export const OBSERVATION_MONTHS = 18;
export const OBSERVATION_DAYS = Math.round(OBSERVATION_MONTHS * 30.44);

/* ------------------------------------------------------------------ *
 * Behaviour weights
 * ------------------------------------------------------------------ *
 * vehicle_service carries the heaviest weight deliberately: it is the one
 * signal only TVS Credit holds, and it is physical-world evidence that cannot
 * be fabricated retroactively. Weights sum to 1.0.
 */

export const BEHAVIOR_WEIGHTS: Record<BehaviorSource, number> = {
  vehicle_service: 0.3,
  upi_recurring: 0.25,
  utility_bill: 0.2,
  phone_recharge: 0.15,
  fastag_toll: 0.1,
};

/** Display metadata + the cadence each behaviour is *expected* to repeat on. */
export const BEHAVIOR_META: Record<
  BehaviorSource,
  { label: string; short: string; expectedIntervalDays: number; icon: string }
> = {
  vehicle_service: {
    label: "Vehicle Service Rhythm",
    short: "Vehicle service",
    expectedIntervalDays: 90,
    icon: "◎",
  },
  upi_recurring: {
    label: "UPI Recurring Payments",
    short: "UPI recurring",
    expectedIntervalDays: 30,
    icon: "⇄",
  },
  utility_bill: {
    label: "Utility Payment Rhythm",
    short: "Electricity bill",
    expectedIntervalDays: 30,
    icon: "◈",
  },
  phone_recharge: {
    label: "Phone Recharge Rhythm",
    short: "Phone recharge",
    expectedIntervalDays: 28,
    icon: "◐",
  },
  fastag_toll: {
    label: "FASTag Commute Rhythm",
    short: "FASTag tolls",
    expectedIntervalDays: 7,
    icon: "▤",
  },
};

/** Canonical render / iteration order for the five behaviours. */
export const BEHAVIOR_ORDER: BehaviorSource[] = [
  "vehicle_service",
  "upi_recurring",
  "utility_bill",
  "phone_recharge",
  "fastag_toll",
];

/* ------------------------------------------------------------------ *
 * Tiers
 * ------------------------------------------------------------------ */

export const TIER_THRESHOLDS = {
  PRIME: 750,
  NEAR_PRIME: 650,
  DEVELOPING: 550,
} as const;

export const TIER_ORDER: Tier[] = [
  "PRIME",
  "NEAR_PRIME",
  "DEVELOPING",
  "THIN_FILE",
];

export const TIER_LOAN_CONFIG: Record<Tier, LoanConfig> = {
  PRIME: { maxLoanAmount: 120000, interestRate: 12.5, tenureMonths: 36 },
  NEAR_PRIME: { maxLoanAmount: 80000, interestRate: 14.5, tenureMonths: 24 },
  DEVELOPING: { maxLoanAmount: 45000, interestRate: 17.5, tenureMonths: 12 },
  THIN_FILE: { maxLoanAmount: 0, interestRate: 0, tenureMonths: 0 },
};

/**
 * Tier colour tokens.
 *
 * A credit tier IS a risk state, so these draw on the reserved status palette
 * rather than a categorical set — and per the accessibility rule every tier is
 * rendered with its label and icon, never colour alone. Validated for >= 3:1
 * contrast against the vistara-surface (#13131A) chart plane.
 */
export const COLOR_MAP: Record<Tier, TierPresentation> = {
  PRIME: {
    label: "Prime",
    color: "#00D49A",
    icon: "▲",
    description: "Exceptional cross-domain rhythm",
    lendingAction: "Approve at standard rate",
  },
  NEAR_PRIME: {
    label: "Near Prime",
    color: "#6C63FF",
    icon: "◆",
    description: "Strong rhythm, one developing domain",
    lendingAction: "Approve; step up ticket after 6 on-time EMIs",
  },
  DEVELOPING: {
    label: "Developing",
    color: "#F5A623",
    icon: "●",
    description: "Rhythm forming, inconsistent across domains",
    lendingAction: "Smaller ticket, 12-month tenure, rhythm-aligned EMI",
  },
  THIN_FILE: {
    label: "Thin File",
    color: "#FF4D6D",
    icon: "○",
    description: "Not enough observed rhythm to score",
    lendingAction: "Offer 3-month rhythm-building path, then re-score",
  },
};

/* ------------------------------------------------------------------ *
 * Consistency bands (per-source qualitative label)
 * ------------------------------------------------------------------ *
 * Keyed off sigma in DAYS, not off the index, so the band means the same
 * physical thing for every behaviour.
 */

export const CONSISTENCY_BANDS: {
  band: ConsistencyBand;
  maxStdDevDays: number;
  label: string;
  color: string;
  icon: string;
  stars: number;
}[] = [
  {
    band: "exceptional",
    maxStdDevDays: 3,
    label: "Exceptional",
    color: "#00D49A",
    icon: "▲",
    stars: 5,
  },
  {
    band: "strong",
    maxStdDevDays: 6,
    label: "Strong",
    color: "#6C63FF",
    icon: "◆",
    stars: 4,
  },
  {
    band: "moderate",
    maxStdDevDays: 10,
    label: "Moderate",
    color: "#F5A623",
    icon: "●",
    stars: 3,
  },
  {
    band: "developing",
    maxStdDevDays: Infinity,
    label: "Developing",
    color: "#FF4D6D",
    icon: "○",
    stars: 2,
  },
];

/* ------------------------------------------------------------------ *
 * Archetypes
 * ------------------------------------------------------------------ */

export const ARCHETYPE_META: Record<
  FinancialArchetype,
  { label: string; blurb: string; emiGuidance: string }
> = {
  PLANNER: {
    label: "Planner",
    blurb:
      "Acts ahead of every deadline. Tight rhythm in every domain observed.",
    emiGuidance: "Any due date works. Auto-debit two days after the salary credit.",
  },
  REACTOR: {
    label: "Reactor",
    blurb:
      "Pays reliably but close to the deadline. Responds to prompts, not calendars.",
    emiGuidance: "Set EMI 2 days after income lands; send a 24h reminder.",
  },
  AVOIDER: {
    label: "Avoider",
    blurb:
      "Long gaps and late recovery. Rhythm breaks under pressure and stays broken.",
    emiGuidance: "Small ticket, weekly nudges, EMI two days after income lands.",
  },
  ADAPTER: {
    label: "Adapter",
    blurb:
      "Highly reliable where it matters to them, loose elsewhere. Income is uneven, intent is not.",
    emiGuidance:
      "Align EMI to their strongest rhythm; allow one flex month per year.",
  },
};

/** Generator parameters per archetype. Consumed by synthetic-data.ts. */
export const ARCHETYPE_GENERATION: Record<
  FinancialArchetype,
  {
    /**
     * The archetype's headline sigma, in days, quoted at the 30-day reference
     * cadence. The generator scales it by each source's own cadence so that a
     * "Planner" is equally tight on a 7-day FASTag rhythm and a 90-day service
     * rhythm — a flat day figure would make the same person look exceptional on
     * one and erratic on the other.
     */
    sigmaTargetDays: number;
    /** Inclusive sigma range, in days, applied to event-gap jitter. */
    sigmaRange: [number, number];
    /** Probability any given expected event is skipped entirely. */
    missRate: number;
    /** Days of extra delay once the rhythm slips. */
    recoveryRange: [number, number];
    /** If set, these sources get sigmaRange and the rest get weakSigmaRange. */
    strongSources?: BehaviorSource[];
    weakSigmaTargetDays?: number;
    weakSigmaRange?: [number, number];
    weakMissRate?: number;
    /** Gaps are clamped to this multiple of the cadence — they recover fast. */
    maxGapMultiple?: number;
    /** Deliberate long absences injected across the window. */
    longGapCount?: number;
    longGapMultipleRange?: [number, number];
  }
> = {
  PLANNER: {
    sigmaTargetDays: 1.5,
    sigmaRange: [1, 3],
    missRate: 0.02,
    recoveryRange: [1, 3],
  },
  REACTOR: {
    sigmaTargetDays: 6,
    sigmaRange: [5, 8],
    missRate: 0.09,
    recoveryRange: [2, 5],
    // A Reactor is late, never absent: the rhythm never stretches past 1.5x.
    maxGapMultiple: 1.5,
  },
  AVOIDER: {
    sigmaTargetDays: 12,
    sigmaRange: [10, 15],
    missRate: 0.26,
    recoveryRange: [9, 20],
    longGapCount: 3,
    longGapMultipleRange: [2, 3],
  },
  ADAPTER: {
    sigmaTargetDays: 2,
    sigmaRange: [1.5, 3.5],
    missRate: 0.03,
    recoveryRange: [2, 4],
    strongSources: ["vehicle_service", "utility_bill"],
    weakSigmaTargetDays: 9,
    weakSigmaRange: [9, 14],
    weakMissRate: 0.22,
  },
};

/* ------------------------------------------------------------------ *
 * Scoring shape
 * ------------------------------------------------------------------ */

/**
 * How much the cross-domain coherence term can move the score, as a share of
 * the weighted single-domain total. Single-domain consistency can be luck;
 * coherence across unrelated domains is the actual signal.
 */
export const CROSS_DOMAIN_WEIGHT = 0.25;

/** Sigma at or below which a behaviour is treated as perfectly rhythmic. */
export const SIGMA_FLOOR_DAYS = 1;
/** Sigma at or above which a behaviour contributes nothing. */
export const SIGMA_CEILING_DAYS = 21;

/** A stream with fewer events than this is too thin to score. */
export const MIN_EVENTS_TO_SCORE = 4;
/** Fewer than this many scorable streams => THIN_FILE regardless of score. */
export const MIN_STREAMS_TO_SCORE = 3;

/* ------------------------------------------------------------------ *
 * Seasonality
 * ------------------------------------------------------------------ *
 * Two windows where Indian rural and retail cash flow legitimately breaks
 * rhythm. Apr–Jun: pre-monsoon sowing spend and the pre-harvest lean months.
 * Oct–Dec: the festival + harvest-sale cycle. Gaps that close inside these
 * windows are a season, not a habit — so the engine may exclude the two worst
 * of them before measuring sigma.
 *
 * This is a documented, auditable exception, applied only to occupations whose
 * income is genuinely cyclical, capped at two gaps, and always disclosed on the
 * scorecard. It is not a general-purpose way to make bad rhythm look good.
 */
export const SEASONAL_WINDOWS: { label: string; months: number[] }[] = [
  { label: "Apr–Jun (sowing / lean season)", months: [3, 4, 5] },
  { label: "Oct–Dec (harvest sale / festival)", months: [9, 10, 11] },
];

/** UTC month indices that sit inside any seasonal window. */
export const SEASONAL_MONTHS: number[] = SEASONAL_WINDOWS.flatMap(
  (w) => w.months,
);

/** Occupations eligible for seasonal adjustment. */
export const SEASONAL_OCCUPATIONS: Occupation[] = ["farmer", "small_merchant"];

/** At most this many gaps may be excluded, ever. */
export const MAX_SEASONAL_EXCLUSIONS = 2;
/** A gap must be at least this multiple of the median to count as seasonal. */
export const SEASONAL_GAP_MIN_MULTIPLE = 1.4;
/** Never leave fewer than this many gaps behind to measure sigma from. */
export const MIN_RETAINED_GAPS = 3;

/* ------------------------------------------------------------------ *
 * Occupation labels
 * ------------------------------------------------------------------ */

export const OCCUPATION_META: Record<
  Occupation,
  { label: string; seasonal: boolean }
> = {
  gig_worker: { label: "Gig worker", seasonal: false },
  small_merchant: { label: "Small merchant", seasonal: false },
  salaried_informal: { label: "Salaried (informal)", seasonal: false },
  farmer: { label: "Farmer", seasonal: true },
  self_employed: { label: "Self-employed", seasonal: false },
};

/* ------------------------------------------------------------------ *
 * Chart tokens
 * ------------------------------------------------------------------ *
 * Single-hue ordinal ramp, validated against the dark surface with the
 * dataviz validator (monotone L, adjacent dL >= 0.06, hue spread 10deg).
 * Magnitude only — never used to encode identity.
 */

export const RAMP = [
  "#C9C4FF",
  "#ADA6FF",
  "#9089FF",
  "#6C63FF",
  "#564EDB",
  "#413AA6",
] as const;

export const CHART_INK = {
  primary: "#E8E8F0",
  secondary: "#A9A9BE",
  muted: "#6B6B80",
  gridline: "#1E1E2E",
  axis: "#2A2A3D",
  surface: "#13131A",
} as const;

/* ------------------------------------------------------------------ *
 * Path to Prime — the improvement action catalogue
 * ------------------------------------------------------------------ *
 * Every action is something the customer can actually do, phrased as a rhythm
 * change rather than a money change. "Pay on the same date each month" is
 * actionable; "improve your credit score" is not. Point estimates are computed
 * from the customer's own gap to the next band, never hard-coded.
 */

/** Offered when a signal is missing entirely — the cold-start path. */
export const COVERAGE_ACTIONS: Record<
  BehaviorSource,
  { title: string; detail: string; horizonMonths: number }
> = {
  vehicle_service: {
    title: "Book your first service at a TVS dealer",
    detail:
      "One dealer-recorded service starts your vehicle-care rhythm — the single heaviest signal Vistara reads, and the one no other lender can see.",
    horizonMonths: 3,
  },
  upi_recurring: {
    title: "Move one fixed monthly payment to UPI AutoPay",
    detail:
      "Rent, a subscription, or a chit contribution paid on the same date each month gives Vistara a clean income-and-outgo rhythm to read.",
    horizonMonths: 2,
  },
  utility_bill: {
    title: "Link your electricity account on BBPS",
    detail:
      "Paying the same bill through the same channel each month is the fastest signal to establish — one billing cycle and it starts counting.",
    horizonMonths: 2,
  },
  phone_recharge: {
    title: "Switch to a fixed 28-day recharge pack",
    detail:
      "A repeating pack of the same validity turns a scatter of top-ups into a measurable cycle.",
    horizonMonths: 2,
  },
  fastag_toll: {
    title: "Use FASTag for your regular commute",
    detail:
      "A weekly toll pattern is the highest-frequency rhythm available, so it stabilises your profile faster than any monthly signal.",
    horizonMonths: 2,
  },
};

/** Offered when a signal exists but wobbles. */
export const TIGHTEN_ACTIONS: Record<
  BehaviorSource,
  { title: string; detail: string; horizonMonths: number }
> = {
  vehicle_service: {
    title: "Service your vehicle on schedule, not on symptom",
    detail:
      "Book the next service by odometer or calendar rather than waiting for a noise. Two on-time services visibly tighten your strongest signal.",
    horizonMonths: 6,
  },
  upi_recurring: {
    title: "Fix your recurring UPI payments to one date",
    detail:
      "Your recurring transfers drift across the month. Anchoring them to a single date is the largest single gain available to you.",
    horizonMonths: 4,
  },
  utility_bill: {
    title: "Pay the electricity bill on the day it arrives",
    detail:
      "You pay it — just at an unpredictable point in the window. Same-day payment converts a moderate signal into a strong one.",
    horizonMonths: 3,
  },
  phone_recharge: {
    title: "Recharge before expiry, not after",
    detail:
      "Recharging a day early each cycle removes the lapse gaps that currently break your streak.",
    horizonMonths: 3,
  },
  fastag_toll: {
    title: "Keep your FASTag topped up above one week of tolls",
    detail:
      "Your commute is regular; the balance is not. Blocked passages read as broken rhythm.",
    horizonMonths: 2,
  },
};

export const GENERIC_ACTIONS: Record<
  "cross_domain" | "recovery" | "streak",
  { title: string; detail: string; horizonMonths: number }
> = {
  cross_domain: {
    title: "Even out your weakest rhythm to match your strongest",
    detail:
      "You are highly reliable in some domains and loose in others. Vistara rewards coherence across domains more than excellence in one, because one good habit can be circumstance and several is character.",
    horizonMonths: 6,
  },
  recovery: {
    title: "Recover within three days when you slip",
    detail:
      "Missing a cycle costs you far less than taking weeks to return to it. Speed of recovery is scored on its own.",
    horizonMonths: 3,
  },
  streak: {
    title: "Build a six-month unbroken streak",
    detail:
      "Your rhythm is reasonable but keeps restarting. An uninterrupted run is what moves you into the next tier.",
    horizonMonths: 6,
  },
};

/* ------------------------------------------------------------------ *
 * Cross-route session handoff
 * ------------------------------------------------------------------ */

/**
 * sessionStorage key holding the loan the live applicant asked for.
 *
 * Separate from the scored profile because it is not part of one: `loanAmount`
 * is a request, not evidence, so it is deliberately absent from
 * `CustomerProfile` and never reaches the engine. /apply/live writes it and
 * /score/live reads it to print the requested figure beside the offered
 * ceiling. It lives here rather than in either page because a string literal
 * duplicated across two routes has no compile-time link — a typo in one of them
 * would silently drop the comparison with nothing failing.
 *
 * The profile itself travels under VISTARA_PROFILE_KEY, declared in
 * hooks/useVistara.ts alongside the code that writes it.
 */
export const LOAN_REQUEST_KEY = "vistara_loan_requested";
