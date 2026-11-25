/**
 * Vistara — the public surface of the data layer.
 *
 * The UI imports from `@/lib` and nothing below it. Everything a page, a form or
 * a chart legitimately needs is re-exported here, so the application layer never
 * has to know which module a symbol happens to live in and lib-internal
 * reorganisation stays invisible above this line.
 *
 * THREE THINGS TO KNOW BEFORE USING THIS FILE.
 *
 * 1. IT HAS A SIDE EFFECT. Re-exporting `DEMO_CUSTOMERS` means importing
 *    *anything* from `@/lib` evaluates synthetic-data.ts, which generates all
 *    twelve profiles and runs the cohort self-check. That is deliberate — the
 *    cohort is frozen module-scope data the whole demo is built on, and the
 *    self-check firing early is the point — but it is why a module that needs
 *    only a formatter or a type may prefer the deep import.
 *
 * 2. rng.ts IS NOT RE-EXPORTED. It is the determinism substrate — the seeded
 *    generator, `REFERENCE_DATE`, and the statistics helpers — and it stays an
 *    implementation detail on purpose: nothing in the UI should be reaching for
 *    a PRNG. The charts that genuinely need `clamp`, `addDays`, `daysBetween` or
 *    `REFERENCE_DATE` continue to deep-import `@/lib/rng`, which keeps those
 *    call sites visible and countable rather than diffused through a barrel.
 *
 * 3. NAMES. The engine's real names differ from the ones the phase plan uses.
 *    The plan's name is on the left, the actual export on the right:
 *
 *      buildTemporalProfile         ->  scoreProfile
 *      calculateConsistencyMetrics  ->  computeAllMetrics (all streams)
 *                                       computeMetrics    (one stream)
 *
 *    No aliases are published for the plan's spellings. One function with two
 *    public names is a maintenance trap, and the mapping belongs in the plan
 *    rather than in the code.
 *
 * `useVistara` is deliberately absent: it is a client hook, and pulling React
 * into the import graph of a Server Component that only wanted a constant is
 * exactly the kind of accident a barrel makes easy. Import it from
 * `@/lib/hooks/useVistara`.
 */

/* ------------------------------------------------------------------ *
 * Type contract — every interface and union in the system
 * ------------------------------------------------------------------ */

export * from "./types";

/* ------------------------------------------------------------------ *
 * Constants, thresholds and presentation tokens
 * ------------------------------------------------------------------ *
 * Exported wholesale rather than curated. constants.ts is by design the single
 * source of truth with no magic numbers anywhere else, so any subset would be an
 * arbitrary line that the next screen has to come back and move. Includes the
 * four the UI layer reads most: BEHAVIOR_WEIGHTS, BEHAVIOR_META,
 * TIER_THRESHOLDS, TIER_LOAN_CONFIG and COLOR_MAP.
 */

export * from "./constants";

/* ------------------------------------------------------------------ *
 * Display formatting
 * ------------------------------------------------------------------ *
 * Presentation-only and clock-free — every helper is a pure function of its
 * arguments, so a server render and a client hydration cannot disagree.
 */

export * from "./format";

/* ------------------------------------------------------------------ *
 * The engine
 * ------------------------------------------------------------------ *
 * Curated, unlike the two above: consistency.ts also exports the intermediate
 * steps of the score so the test suite can pin them individually, and those are
 * not things a page should be recomputing for itself. What is here is the entry
 * point, the visualisation contract, and the read-only helpers the scorecard
 * needs to describe a number it was given.
 */

export {
  /** THE entry point. Runs the whole engine over one customer's streams. */
  scoreProfile,
  /** The event-strip data contract. One verdict per observed timestamp. */
  buildEventStrip,
  /** Per-source metrics for a set of streams. */
  computeAllMetrics,
  /** Per-source metrics for a single stream. */
  computeMetrics,
  computeCrossDomainConsistency,
  classifyArchetype,
  recommendEmiDate,
  tierForScore,
  /** Band lookup + tolerance maths, for describing a score without rescoring. */
  bandForStdDev,
  bandEntry,
  onBeatToleranceDays,
  normalisedSigmaDays,
  /** Whether the seasonal exception could apply at all. Ask the engine, not a map. */
  isSeasonalOccupation,
} from "./consistency";

export type { ConsistencyBandEntry, MetricOptions } from "./consistency";

/* ------------------------------------------------------------------ *
 * Synthetic history + the frozen demo cohort
 * ------------------------------------------------------------------ */

export {
  generateBehaviorStream,
  generateStreams,
  /** The cold-start rule: which signals a customer plausibly has at all. */
  defaultStreamAvailability,
  /** The twelve frozen profiles. Identical in every process, every render. */
  DEMO_CUSTOMERS,
  DEMO_CUSTOMERS_BY_ARCHETYPE,
  getDemoCustomer,
} from "./synthetic-data";

export type { StreamOptions } from "./synthetic-data";
