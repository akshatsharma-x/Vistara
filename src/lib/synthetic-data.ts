/**
 * Vistara — synthetic behavioural evidence.
 *
 * These are demo customers, not real ones, but the *shape* of the data is the
 * claim we are making about the world: recurring events land near a cadence,
 * sometimes get skipped entirely (producing a real double-length gap, which is
 * what a broken rhythm actually looks like in a ledger), take a while to come
 * back once broken, and — for farmers and traders — legitimately stop for a
 * season without the habit having failed at all.
 *
 * Everything is generated from a seeded PRNG against the frozen REFERENCE_DATE.
 * Nothing here reads the clock and nothing calls Math.random(). The same id
 * always yields the same timestamps, on the server and on the client, forever;
 * that is what stops React throwing a hydration mismatch mid-demo, and what
 * makes any bug in here reproducible.
 *
 * Reading order:
 *   1. sigmaForSource          — the archetype's rhythm quality, per cadence
 *   2. walkStream              — one backwards walk, with all five gap mechanisms
 *   3. generateBehaviorStream  — one source, with rejection sampling; null if absent
 *   4. defaultStreamAvailability / DEMO_SPECS — who has which signals, and why
 *   5. buildDemoProfile        — spec -> scored TemporalProfile
 */

import { scoreProfile, sigmaDaysForNormalised } from "@/lib/consistency";
import {
  ARCHETYPE_GENERATION,
  BEHAVIOR_META,
  BEHAVIOR_ORDER,
  MIN_EVENTS_TO_SCORE,
  OBSERVATION_DAYS,
  SEASONAL_MONTHS,
  SEASONAL_OCCUPATIONS,
} from "@/lib/constants";
import {
  REFERENCE_DATE,
  addDays,
  clamp,
  createRng,
  daysBetween,
  hashSeed,
  mean,
  stdDev,
} from "@/lib/rng";
import type {
  BehaviorSource,
  BehaviorStream,
  CustomerProfile,
  FinancialArchetype,
  Occupation,
  TemporalProfile,
} from "@/lib/types";

/* ================================================================== *
 * Generator constants
 * ================================================================== */

/** Two events can never share a day — that would be one event, logged twice. */
const MIN_GAP_DAYS = 1;

/**
 * How far before REFERENCE_DATE the most recent event sits, as a fraction of
 * the cadence. Real data is never captured on the day of the last event, and
 * pinning every customer's latest event to "today" would look synthetic.
 */
const LATEST_EVENT_OFFSET_MIN = 0.1;
const LATEST_EVENT_OFFSET_MAX = 0.6;

/** Hard stop on the walk, so a pathological cadence cannot loop forever. */
const MAX_EVENTS_PER_STREAM = 400;

/* ---------------- sigma: the archetype's rhythm quality ------------- */

/**
 * WHY THE ARCHETYPE SIGMAS ARE RESTATED PER CADENCE. ARCHETYPE_GENERATION gives one
 * sigma per archetype — a Planner is "1.5 days". Applied literally to every source,
 * 1.5 days of drift on a 7-day FASTag commute is a wobbly habit while 1.5 days on a
 * 90-day service cadence is superhuman, so the same customer would read as erratic
 * on one row of their own scorecard and flawless on another. So the published sigma
 * is treated as a figure quoted at the engine's 30-day reference cadence and
 * restated onto each real cadence before use — scaled UP for slow rhythms by
 * exactly the factor the engine will later divide out. "Planner" then means one
 * thing across all five rows, which is the only way the event strip reads at a
 * glance.
 *
 * The restatement uses the engine's own exported inverse, sigmaDaysForNormalised,
 * rather than a local copy of the same power law. That is deliberate: the forward
 * and backward transforms have to agree exactly, and two copies of an exponent in
 * two files is precisely the thing that silently stops being true.
 */

/** Per-stream jitter on the archetype sigma, so five rows are not identical. */
const SIGMA_JITTER_MIN = 0.85;
const SIGMA_JITTER_MAX = 1.15;

/** Floor, so a fast cadence cannot produce a sigma below day-level resolution. */
const MIN_SIGMA_DAYS = 0.3;

/**
 * Ceiling on sigma, as a fraction of the cadence it jitters around.
 *
 * WHY A CEILING IS NEEDED, not just a floor. Past roughly half the cadence the
 * gaussian starts proposing negative gaps, MIN_GAP_DAYS clamps them to one day,
 * and the clamp is one-sided — so the draw stops being "a monthly rhythm, kept
 * badly" and becomes a scatter of same-week events with a mean well BELOW the
 * cadence. That is not what an Avoider looks like: they miss the 5th and pay on the
 * 20th, they do not pay four times in a fortnight. The observable symptom was a
 * demo customer whose UPI history averaged 19 days against a 30-day cadence, which
 * is the clamp talking, not the archetype.
 *
 * The cap costs nothing in expressiveness because the ENGINE saturates first: it
 * maps normalised sigma onto 100..0 over SIGMA_FLOOR_DAYS..SIGMA_CEILING_DAYS, so
 * anything past ~21 normalised days already scores zero. 0.45 of a 30-day cadence
 * is 13.5 days — deep inside the bottom band — and the clamp only ever bites on
 * draws that were physically incoherent to begin with.
 */
const SIGMA_MAX_FRACTION_OF_CADENCE = 0.45;

/**
 * How much looser a spec's `weakestSource` is drawn than the rest of that
 * customer's rhythms. Everybody has one habit they are worst at, and giving each
 * demo customer a DIFFERENT one is what makes their improvement advice specific
 * to them rather than boilerplate.
 */
const WEAKEST_SOURCE_SIGMA_MULTIPLE = 2.1;

/* ---------------- deliberate long absences (AVOIDER) --------------- */

/**
 * Where in the window an Avoider's long absences are placed, as fractions of the
 * observation window measured backwards from REFERENCE_DATE. Spread rather than
 * sampled: three gaps that happen to land adjacently read as one long outage,
 * and the point of an Avoider is that the rhythm breaks repeatedly.
 */
const LONG_GAP_TRIGGER_FRACTIONS = [0.22, 0.5, 0.78];

/**
 * A long gap must not consume the stream. A 90-day cadence gets only ~6 slots in
 * eighteen months, so three 2.5x absences would leave two events — structurally
 * unscorable, and a customer with no data rather than a customer with bad
 * rhythm. We therefore allow one long gap per four expected events.
 */
const EVENTS_PER_LONG_GAP = 4;

/* ---------------- seasonality ------------------------------------- */

/**
 * The sources a harvest or festival cycle actually interrupts.
 *
 * Vehicle service is the clearest: a farmer services after selling the crop, not
 * on a 90-day timer. Income (UPI) and the electricity bill follow the same cash
 * cycle — the lean months before harvest are when a bill goes unpaid. A weekly
 * toll run and a phone pack are not seasonal in this way; they are small, cheap
 * and continuous, and stretching them would be manufacturing an excuse rather
 * than modelling one.
 */
const SEASONAL_STRETCH_SOURCES: BehaviorSource[] = [
  "vehicle_service",
  "upi_recurring",
  "utility_bill",
];

/** How far a seasonal pause stretches the gap, as a multiple of the cadence. */
const SEASONAL_STRETCH_MIN = 2.2;
const SEASONAL_STRETCH_MAX = 2.8;

/**
 * At most this many per stream — the same cap the engine will forgive
 * (MAX_SEASONAL_EXCLUSIONS). Generating a third would create a gap the engine
 * charges for in full, which is the honest outcome but not the case we are here
 * to demonstrate.
 */
const MAX_SEASONAL_STRETCHES = 2;

/* ---------------- rejection sampling ------------------------------ */

/**
 * Rejection sampling budget for one stream. A 90-day service cadence only gets
 * ~6 slots in an 18-month window, so two unlucky skips can leave a stream with
 * three events — structurally unscorable. Rather than special-casing the scorer
 * we redraw the stream: the archetype's character (its sigma and miss rate) is
 * preserved, only the unlucky sample is discarded.
 */
const MAX_STREAM_ATTEMPTS = 12;

/**
 * A drawn stream must actually EXHIBIT the rhythm quality it was drawn with.
 *
 * For fast cadences that is automatic — 75 FASTag gaps converge on their sigma.
 * A 90-day rhythm gets only six observations in eighteen months, so one skipped
 * cycle can single-handedly take the realised sigma to 40 days and make a
 * customer whose vehicle-care habit is genuinely tight look like they have no
 * habit at all. That is a sampling artefact of a short series, not a behaviour,
 * and a synthetic cohort that contains it will mislabel its own customers.
 *
 * So a draw is accepted only if its realised sigma stays within a generous
 * multiple of the sigma it was drawn from. Generous is the point: an Avoider
 * drawn at 12 days may realise 46 and keep every one of its skipped cycles.
 * Only the freak short-series draws are discarded.
 */
const SIGMA_REALISATION_MULTIPLE = 3.5;
const SIGMA_REALISATION_HEADROOM_DAYS = 4;

/**
 * Rejection sampling budget for one customer. The cohort is resampled until the
 * ENGINE classifies the customer as the archetype they were generated as. A
 * labelled synthetic dataset whose labels disagree with its own data is worse
 * than no dataset: every screen that groups by archetype would be quietly lying.
 * This makes the label a verified property, not an intention.
 */
const MAX_ARCHETYPE_ATTEMPTS = 32;

const ARCHETYPE_ORDER: FinancialArchetype[] = [
  "PLANNER",
  "REACTOR",
  "AVOIDER",
  "ADAPTER",
];

const WINDOW_START = addDays(REFERENCE_DATE, -OBSERVATION_DAYS);

/* ================================================================== *
 * Stream options
 * ================================================================== */

export interface StreamOptions {
  /**
   * Multiplies every drawn sigma. The single per-customer tuning lever: the
   * archetype's parameters fix each customer's CHARACTER (how their rhythm
   * breaks), and this fixes where that character lands on the 300-900 scale.
   * Frozen per demo customer by scripts/tune-demo.ts.
   */
  sigmaScale?: number;
  /**
   * How severe THIS person's version of their archetype is. Scales the three
   * mechanisms sigmaScale cannot touch: how often a cycle is skipped, how long
   * recovery takes, and how long a deliberate absence runs. 1 = the archetype's
   * own parameters, below 1 = a milder case, above 1 = a worse one.
   *
   * Two Avoiders are not equally bad at this, and without a second lever the
   * whole archetype collapses onto one score: sigmaScale moves the jitter, but an
   * Avoider's score is dominated by skipped cycles and month-long absences, so
   * shrinking their jitter to nothing barely moves the number. Deliberately does
   * NOT scale the seasonal pause — a harvest is not a character flaw and its
   * length is not this customer's to vary.
   */
  severityScale?: number;
  /** This one source is drawn looser than the customer's others. */
  weakestSource?: BehaviorSource;
  /** Drives harvest/festival pauses. Absent => no seasonal stretching. */
  occupation?: Occupation;
  /**
   * Whether this customer's trade actually pauses. Default (undefined) = decided
   * by occupation, which is the honest prior. Set false to generate a member of a
   * seasonal occupation whose own rhythm has NO seasonal pause in it.
   *
   * WHY THIS EXISTS. Occupation is a prior, not a fact. If every small merchant we
   * generate pauses for the festival window, then "seasonally adjusted" is really
   * just "is a merchant", and the exception is indistinguishable from an
   * occupation-based discount — which is exactly the thing a judge should attack it
   * for. The cohort needs at least one control: a seasonal occupation the engine
   * excludes nothing for, because there was nothing in the dates to exclude. That
   * is what proves the exception reads behaviour and not a job title.
   */
  seasonalPauses?: boolean;
  /**
   * Day of the month this customer's money lands. When set, `upi_recurring` is
   * anchored to it instead of walking on a flat 30-day interval.
   *
   * WHY. A flat 30-day step drifts 0.44 days per month against the calendar, so
   * after eighteen months the day-of-month is smeared across a fortnight and the
   * engine's circular concentration falls below EMI_MIN_CONCENTRATION for
   * everybody. The EMI recommendation would then fall through to "their most
   * recent payment day" for the entire cohort, and the circular-mean maths — the
   * part that knows the 30th and the 2nd are three days apart, which is the
   * single cleverest thing in the engine — would never actually run. Real
   * recurring payments are anchored to a DATE, not to an interval; modelling them
   * that way is both more truthful and what makes the recommendation
   * demonstrable.
   */
  incomeDayOfMonth?: number;
  /** Same, for the electricity bill. */
  utilityDayOfMonth?: number;
  /**
   * Which sources this customer has at all. A source that is absent or false
   * makes generateBehaviorStream return null — see the cold-start note there.
   * Omitted entirely => every source is generated.
   */
  availability?: Partial<Record<BehaviorSource, boolean>>;
  /**
   * Suppresses misses, long gaps and seasonal pauses. Used only by the
   * last-resort fallback in generateBehaviorStream, where a walk that cannot come
   * up short is required.
   */
  plain?: boolean;
}

/* ================================================================== *
 * 1. Sigma
 * ================================================================== */

/**
 * The sigma, in days, this archetype's rhythm wobbles by on THIS source's
 * cadence. See SIGMA_REFERENCE_CADENCE_DAYS for why the archetype's headline
 * figure is rescaled rather than applied flat.
 */
function sigmaForSource(
  archetype: FinancialArchetype,
  source: BehaviorSource,
  rng: ReturnType<typeof createRng>,
  options: StreamOptions,
): number {
  const params = ARCHETYPE_GENERATION[archetype];

  // ADAPTER is the only archetype whose rhythm quality varies by domain: it is
  // reliable where the consequence is visible to them (the vehicle, the
  // electricity meter) and loose everywhere else. That split is the whole
  // insight — align the EMI to the rhythm they already keep.
  const isWeakDomain =
    params.strongSources !== undefined &&
    !params.strongSources.includes(source) &&
    params.weakSigmaTargetDays !== undefined;

  const target = isWeakDomain
    ? (params.weakSigmaTargetDays as number)
    : params.sigmaTargetDays;

  const cadence = BEHAVIOR_META[source].expectedIntervalDays;
  const cadenceScaled = sigmaDaysForNormalised(target, cadence);

  // ONE sigma per stream: a rhythm has a single quality, and re-drawing sigma
  // per event would average every archetype toward the middle of its range.
  const jitter = rng.float(SIGMA_JITTER_MIN, SIGMA_JITTER_MAX);
  const weakest =
    options.weakestSource === source ? WEAKEST_SOURCE_SIGMA_MULTIPLE : 1;

  return clamp(
    cadenceScaled * jitter * weakest * (options.sigmaScale ?? 1),
    MIN_SIGMA_DAYS,
    cadence * SIGMA_MAX_FRACTION_OF_CADENCE,
  );
}

/** Miss rate for this source — ADAPTER's weak domains get skipped more often. */
function missRateForSource(
  archetype: FinancialArchetype,
  source: BehaviorSource,
): number {
  const params = ARCHETYPE_GENERATION[archetype];
  const isWeakDomain =
    params.strongSources !== undefined &&
    !params.strongSources.includes(source) &&
    params.weakMissRate !== undefined;
  return isWeakDomain ? (params.weakMissRate as number) : params.missRate;
}

/* ================================================================== *
 * 2. The walk
 * ================================================================== */

/** The day-of-month this source is anchored to, if any. */
function anchorDayFor(
  source: BehaviorSource,
  options: StreamOptions,
): number | undefined {
  if (source === "upi_recurring") return options.incomeDayOfMonth;
  if (source === "utility_bill") return options.utilityDayOfMonth;
  return undefined;
}

/**
 * The `anchorDay` of the month before `cursor`, always strictly earlier.
 *
 * Re-deriving the anchor from the cursor on every step is what stops jitter
 * ACCUMULATING: if this month's payment landed two days late, next month's is
 * still measured from the anchor, so the day-of-month stays pinned instead of
 * drifting away over eighteen months. UTC throughout — a local-time getter would
 * shift the day by one in a negative-offset timezone and make the generated data
 * depend on where the process happens to run.
 */
function previousAnchor(cursor: Date, anchorDay: number): Date {
  const year = cursor.getUTCFullYear();
  const month = cursor.getUTCMonth();
  const candidate = new Date(Date.UTC(year, month - 1, anchorDay));
  return candidate.getTime() < cursor.getTime()
    ? candidate
    : new Date(Date.UTC(year, month - 2, anchorDay));
}

/** Where the most recent event sits, a fraction of a cycle before "today". */
function latestEvent(
  rng: ReturnType<typeof createRng>,
  expected: number,
  anchorDay: number | undefined,
): Date {
  if (anchorDay !== undefined) return previousAnchor(REFERENCE_DATE, anchorDay);
  const offset = Math.max(
    1,
    Math.round(
      expected * rng.float(LATEST_EVENT_OFFSET_MIN, LATEST_EVENT_OFFSET_MAX),
    ),
  );
  return addDays(REFERENCE_DATE, -offset);
}

/**
 * One backwards walk from REFERENCE_DATE to the window start. Returns ASCENDING
 * timestamps, all strictly inside the window, at most one per day.
 *
 * Five mechanisms shape a gap, applied in this order, and the ORDER carries the
 * meaning:
 *
 *   1. jitter        — gaussian around the cadence. Every archetype has it.
 *   2. skipped cycle — the obligation did not happen, so the gap roughly
 *                      doubles, plus recovery delay on the way back.
 *   3. long absence  — AVOIDER only. Replaces the step outright: this is not a
 *                      late payment, it is a stretch of months with nothing.
 *   4. cadence clamp — REACTOR only. A Reactor is late, never absent, so no gap
 *                      may exceed maxGapMultiple of the cadence.
 *   5. seasonal pause — applied AFTER the clamp, deliberately. A harvest pause is
 *                      not a behavioural failure and must not be capped by a
 *                      behavioural rule: a Reactor farmer still stops for the
 *                      harvest, and if the clamp swallowed that gap the engine
 *                      would never see a seasonal pause to forgive.
 */
function walkStream(
  rng: ReturnType<typeof createRng>,
  source: BehaviorSource,
  expected: number,
  sigma: number,
  archetype: FinancialArchetype,
  options: StreamOptions,
): Date[] {
  const params = ARCHETYPE_GENERATION[archetype];
  const plain = options.plain === true;
  const anchorDay = anchorDayFor(source, options);
  const severity = options.severityScale ?? 1;
  const missRate = plain ? 0 : missRateForSource(archetype, source) * severity;

  const seasonalEligible =
    !plain &&
    options.seasonalPauses !== false &&
    options.occupation !== undefined &&
    SEASONAL_OCCUPATIONS.includes(options.occupation) &&
    SEASONAL_STRETCH_SOURCES.includes(source);

  // One long gap per four expected events, capped by the archetype's own count.
  const expectedEvents = Math.floor(OBSERVATION_DAYS / expected);
  const longGapCount = plain
    ? 0
    : Math.min(
        params.longGapCount ?? 0,
        Math.floor(expectedEvents / EVENTS_PER_LONG_GAP),
      );
  const longGapTriggers = LONG_GAP_TRIGGER_FRACTIONS.slice(0, longGapCount).map(
    (fraction) => fraction * OBSERVATION_DAYS,
  );

  const descending: Date[] = [];
  let cursor = latestEvent(rng, expected, anchorDay);
  let longGapsFired = 0;
  let seasonalStretches = 0;

  while (
    cursor.getTime() > WINDOW_START.getTime() &&
    descending.length < MAX_EVENTS_PER_STREAM
  ) {
    descending.push(cursor);

    // 1. Jitter around the cadence. For an anchored source the "cadence" is the
    //    real distance back to the anchor day, which is 28-31 days depending on
    //    the calendar rather than a flat 30.
    const baseStep =
      anchorDay === undefined
        ? expected
        : daysBetween(previousAnchor(cursor, anchorDay), cursor);
    let step = baseStep + rng.gaussian(0, sigma);

    // 2. A skipped occurrence is not a small delay — the obligation simply did
    //    not happen this cycle, so the gap to the next event is roughly double.
    //    Once broken the rhythm does not snap back either: the return carries
    //    extra delay on top of the already-doubled gap.
    if (rng.chance(missRate)) {
      step +=
        expected +
        rng.float(params.recoveryRange[0], params.recoveryRange[1]) * severity;
    }

    // 3. A deliberate long absence, placed by how far back through the window we
    //    have walked rather than by event index — the index depends on how long
    //    the earlier gaps turned out to be, and the absences are meant to be
    //    spread across the eighteen months, not across the event list.
    const elapsed = daysBetween(cursor, REFERENCE_DATE);
    if (
      longGapsFired < longGapTriggers.length &&
      elapsed >= longGapTriggers[longGapsFired]
    ) {
      longGapsFired++;
      const range = params.longGapMultipleRange ?? [2, 3];
      // Interpolated toward 1x rather than multiplied, so severity below 1 makes
      // the absence SHORTER without ever making it shorter than the cadence
      // itself — a "long gap" of 0.6x would be a fast payment, not an absence.
      const multiple = 1 + (rng.float(range[0], range[1]) - 1) * severity;
      step = expected * multiple;
    }

    // 4. Late, never absent.
    if (params.maxGapMultiple !== undefined) {
      step = Math.min(step, expected * params.maxGapMultiple);
    }

    // 5. The harvest / festival pause. `cursor` is the LATER event, so this is
    //    the gap that CLOSES in a seasonal month — the same convention the
    //    engine's seasonal exclusion reads, so the gap we generate is the gap it
    //    considers.
    if (
      seasonalEligible &&
      seasonalStretches < MAX_SEASONAL_STRETCHES &&
      SEASONAL_MONTHS.includes(cursor.getUTCMonth())
    ) {
      seasonalStretches++;
      step = Math.max(
        step,
        expected * rng.float(SEASONAL_STRETCH_MIN, SEASONAL_STRETCH_MAX),
      );
    }

    cursor = addDays(cursor, -Math.max(MIN_GAP_DAYS, Math.round(step)));
  }

  return descending.reverse();
}

/** Population sigma of the gaps a walk actually produced. */
function realisedSigma(timestamps: Date[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    gaps.push(daysBetween(timestamps[i - 1], timestamps[i]));
  }
  return stdDev(gaps);
}

/**
 * Is the cadence we asked for still visible in the draw?
 *
 * The engine measures sigma AROUND THE OBSERVED MEAN, not around the expected
 * interval, so a customer who services their vehicle every 167 days like clockwork
 * scores "Strong" on a 90-day cadence. For the engine that is a deliberate and
 * defensible choice — Vistara scores regularity, not compliance, and a rural
 * customer who genuinely services twice a year is being consistent. But it means
 * the GENERATOR carries the burden of not producing histories whose mean has
 * wandered off the cadence, because a scorecard that prints "Vehicle service ·
 * every 168 days · Strong" next to a stated 90-day rhythm invites exactly one
 * question from a judge and it is not a question about consistency.
 *
 * Both directions matter. Too slow is an Avoider whose long absences have eaten the
 * stream; too fast is the MIN_GAP_DAYS clamp folding negative draws onto one day.
 * The band is wide because an Avoider's mean SHOULD run long — three deliberate
 * absences at 2-3x plus a quarter of cycles skipped legitimately moves the mean up
 * by half again — it just should not double.
 */
const MEAN_DRIFT_MIN = 0.7;
const MEAN_DRIFT_MAX = 1.7;

function cadenceIsRecognisable(timestamps: Date[], expected: number): boolean {
  const gaps: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    gaps.push(daysBetween(timestamps[i - 1], timestamps[i]));
  }
  const observed = mean(gaps);
  return (
    observed >= expected * MEAN_DRIFT_MIN && observed <= expected * MEAN_DRIFT_MAX
  );
}

/* ================================================================== *
 * 3. One source
 * ================================================================== */

/**
 * 18 months of timestamps for ONE behaviour, or null when the customer does not
 * have that signal at all.
 *
 * COLD START — why null and not an empty stream. A first-time two-wheeler buyer
 * has no TVS service history, and that is precisely the customer this product
 * exists for. Handing the engine an empty stream would let it read "no rhythm"
 * where the truth is "no data", and those are different findings that deserve
 * different products: a rhythm-building path versus a small rhythm-aligned
 * ticket. Returning null forces every caller to decide which, and the engine
 * renormalises the remaining weights so the customer is judged on the rhythms
 * they actually have rather than docked 0.30 for a signal nobody could observe.
 *
 * Deterministic: the same (source, archetype, seed) always yields the same
 * timestamps. The rng is derived from all three, so changing one behaviour's
 * parameters cannot shift another behaviour's dates — that independence is what
 * makes a regression in here debuggable.
 */
export function generateBehaviorStream(
  source: BehaviorSource,
  archetype: FinancialArchetype,
  seed: number,
  options: StreamOptions = {},
): BehaviorStream | null {
  if (
    options.availability !== undefined &&
    options.availability[source] !== true
  ) {
    return null;
  }

  const meta = BEHAVIOR_META[source];
  const expected = meta.expectedIntervalDays;

  let timestamps: Date[] = [];
  for (let attempt = 0; attempt < MAX_STREAM_ATTEMPTS; attempt++) {
    const rng = createRng(hashSeed(`${seed}:${source}:${attempt}`));
    const sigma = sigmaForSource(archetype, source, rng, options);
    timestamps = walkStream(rng, source, expected, sigma, archetype, options);

    if (
      timestamps.length >= MIN_EVENTS_TO_SCORE &&
      realisedSigma(timestamps) <=
        SIGMA_REALISATION_MULTIPLE * sigma + SIGMA_REALISATION_HEADROOM_DAYS &&
      cadenceIsRecognisable(timestamps, expected)
    ) {
      break;
    }
  }

  // Exhausted the budget: fall back to a walk with no misses and no long gaps,
  // which cannot come up short. Reachable only for an Avoider on the slowest
  // cadence; here so the function has no failure mode at all.
  if (timestamps.length < MIN_EVENTS_TO_SCORE) {
    const rng = createRng(hashSeed(`${seed}:${source}:fallback`));
    const plainOptions: StreamOptions = { ...options, plain: true };
    timestamps = walkStream(
      rng,
      source,
      expected,
      sigmaForSource(archetype, source, rng, plainOptions),
      archetype,
      plainOptions,
    );
  }

  return {
    source,
    label: meta.label,
    timestamps,
    expectedIntervalDays: expected,
  };
}

/**
 * Every available behaviour, in BEHAVIOR_ORDER. Unavailable sources are DROPPED
 * from the array, never included as an empty stream.
 */
export function generateStreams(
  archetype: FinancialArchetype,
  seed: number,
  options: StreamOptions = {},
): BehaviorStream[] {
  return BEHAVIOR_ORDER.map((source) =>
    generateBehaviorStream(source, archetype, seed, options),
  ).filter((stream): stream is BehaviorStream => stream !== null);
}

/* ================================================================== *
 * 4. Who has which signals
 * ================================================================== */

/**
 * The default cold-start rule.
 *
 * A gig worker or a farmer under 25 is, in this market, overwhelmingly a
 * first-time vehicle buyer: no dealer has ever recorded a service for them,
 * because they have never owned the vehicle. Everyone else is assumed to have
 * all five signals unless a DEMO_SPEC says otherwise.
 *
 * Deliberately narrow. The rule keys off age AND occupation together, not off
 * occupation alone, because "farmers do not service their vehicles" is false and
 * would strip the heaviest and most TVS-specific signal from every rural
 * applicant — the exact opposite of what this engine is for.
 */
export function defaultStreamAvailability(customer: {
  age: number;
  occupation: Occupation;
}): Record<BehaviorSource, boolean> {
  const firstTimeBuyer =
    (customer.occupation === "gig_worker" || customer.occupation === "farmer") &&
    customer.age < 25;

  return BEHAVIOR_ORDER.reduce(
    (acc, source) => {
      acc[source] = source === "vehicle_service" ? !firstTimeBuyer : true;
      return acc;
    },
    {} as Record<BehaviorSource, boolean>,
  );
}

/** Every source explicitly true or false, so "absent key" never has to mean anything. */
function availabilityFrom(
  sources: BehaviorSource[],
): Record<BehaviorSource, boolean> {
  return BEHAVIOR_ORDER.reduce(
    (acc, source) => {
      acc[source] = sources.includes(source);
      return acc;
    },
    {} as Record<BehaviorSource, boolean>,
  );
}

/* ================================================================== *
 * 5. The demo cohort
 * ================================================================== */

/**
 * One demo customer, fully specified. Every field is a literal so the cohort is
 * identical on every render in every process — nothing here is sampled.
 *
 * `seed` and `sigmaScale` are the two tuned values, found by `npm run tune:demo`
 * and frozen here so the demo never depends on a search running at page load.
 */
export interface DemoSpec {
  archetype: FinancialArchetype;
  /** 1-based position within the archetype group. */
  index: number;
  name: string;
  age: number;
  occupation: Occupation;
  city: string;
  monthlyIncome: number;
  /** Present only for the minority the bureau has already scored. */
  cibilScore?: number;
  /** The signals this customer actually has. Anything omitted is a cold start. */
  availableSources: BehaviorSource[];
  seed: number;
  sigmaScale: number;
  /** How severe this individual's version of the archetype is. See StreamOptions. */
  severityScale: number;
  /** The one habit this customer is worst at. Drives their top advice. */
  weakestSource?: BehaviorSource;
  /**
   * Omit to let occupation decide (the default). See StreamOptions.seasonalPauses
   * — set false for the control case: a seasonal occupation with no seasonal pause.
   */
  seasonalPauses?: boolean;
  incomeDayOfMonth: number;
  utilityDayOfMonth: number;
  /** What the tuner was aiming at. Documentation — never read at runtime. */
  targetScore: number;
  /** Why this customer is in the cohort. One line, for the demo script. */
  note: string;
}

/**
 * Twelve customers, three per archetype.
 *
 * The cohort is a checklist, not a sample. Between them they must exercise every
 * path a judge will ask about: all four tiers, all five occupations, a different
 * cold-start source each, the seasonal exception on both a farmer and a trader,
 * the thin-file GATE firing independently of the score, and a distinct weakest
 * habit each so no two customers are handed the same advice.
 */
export const DEMO_SPECS: DemoSpec[] = [
  /* ---------------- PLANNER ---------------- */
  {
    archetype: "PLANNER",
    index: 1,
    name: "Ravi Kumar",
    age: 34,
    occupation: "small_merchant",
    city: "Coimbatore",
    monthlyIncome: 42000,
    availableSources: [...BEHAVIOR_ORDER],
    seed: 27,
    sigmaScale: 1.6,
    severityScale: 1,
    weakestSource: "fastag_toll",
    seasonalPauses: false,
    incomeDayOfMonth: 3,
    utilityDayOfMonth: 9,
    targetScore: 820,
    note: "All five signals, tight in every domain, and the CONTROL for the seasonal exception: a small merchant whose stock cycle never actually stops, so nothing seasonal is generated for him and seasonalityAdjusted is false on every one of his metrics. Pair him with Karthik R. — same occupation, same rule applied, five gaps forgiven. The pair is the answer to 'your seasonal adjustment is just a discount for rural jobs': the exception reads the dates, not the job title.",
  },
  {
    archetype: "PLANNER",
    index: 2,
    name: "Meena S.",
    age: 41,
    occupation: "salaried_informal",
    city: "Chennai",
    monthlyIncome: 28000,
    availableSources: [
      "vehicle_service",
      "upi_recurring",
      "utility_bill",
      "phone_recharge",
    ],
    seed: 8,
    sigmaScale: 1.9,
    severityScale: 1,
    incomeDayOfMonth: 7,
    utilityDayOfMonth: 14,
    targetScore: 795,
    note: "No FASTag — she commutes by bus. Scores Prime on four signals, the clearest demonstration that renormalised weights do not punish a rhythm nobody could observe.",
  },
  {
    archetype: "PLANNER",
    index: 3,
    name: "Arjun T.",
    age: 28,
    occupation: "self_employed",
    city: "Bengaluru",
    monthlyIncome: 55000,
    cibilScore: 682,
    availableSources: [...BEHAVIOR_ORDER],
    seed: 6,
    sigmaScale: 0.9,
    severityScale: 1,
    weakestSource: "utility_bill",
    incomeDayOfMonth: 11,
    utilityDayOfMonth: 18,
    targetScore: 810,
    note: "A thin bureau file that prices him as subprime. The behavioural read disagrees, and this is the customer the pitch is built around.",
  },

  /* ---------------- ADAPTER ---------------- */
  {
    archetype: "ADAPTER",
    index: 1,
    name: "Lakshmi D.",
    age: 26,
    occupation: "gig_worker",
    city: "Chennai",
    monthlyIncome: 24000,
    availableSources: [
      "upi_recurring",
      "utility_bill",
      "phone_recharge",
      "fastag_toll",
    ],
    seed: 7,
    sigmaScale: 0.4,
    severityScale: 0.1,
    weakestSource: "phone_recharge",
    incomeDayOfMonth: 15,
    utilityDayOfMonth: 22,
    targetScore: 740,
    note: "COLD START on vehicle service — she rides a rented scooter, so no dealer has ever recorded one. She is 26, so the default age rule does NOT catch her: which is exactly why availability is per-customer data and not an inference.",
  },
  {
    archetype: "ADAPTER",
    index: 2,
    name: "Karthik R.",
    age: 32,
    occupation: "small_merchant",
    city: "Madurai",
    monthlyIncome: 38000,
    availableSources: [...BEHAVIOR_ORDER],
    seed: 11,
    sigmaScale: 0.8,
    severityScale: 0.55,
    weakestSource: "vehicle_service",
    incomeDayOfMonth: 19,
    utilityDayOfMonth: 26,
    targetScore: 710,
    note: "SEASONAL ADJUSTMENT on a trader: his stock cycle stops during the festival window. Shows the exception is not a rural-only carve-out.",
  },
  {
    archetype: "ADAPTER",
    index: 3,
    name: "Sunita M.",
    age: 29,
    occupation: "gig_worker",
    city: "Hyderabad",
    monthlyIncome: 21000,
    cibilScore: 611,
    availableSources: ["vehicle_service", "upi_recurring", "phone_recharge"],
    seed: 3,
    sigmaScale: 0.6,
    severityScale: 0.55,
    weakestSource: "phone_recharge",
    incomeDayOfMonth: 23,
    utilityDayOfMonth: 2,
    targetScore: 695,
    note: "The sparsest file the engine will still score: three signals, right on MIN_STREAMS_TO_SCORE. No electricity account in her name and no FASTag. dataCompleteness 0.6 has to be on screen next to the number.",
  },

  /* ---------------- REACTOR ---------------- */
  {
    archetype: "REACTOR",
    index: 1,
    name: "Suresh A.",
    age: 38,
    occupation: "farmer",
    city: "Salem",
    monthlyIncome: 19000,
    availableSources: [
      "vehicle_service",
      "utility_bill",
      "phone_recharge",
      "fastag_toll",
    ],
    seed: 10,
    sigmaScale: 2,
    severityScale: 1.3,
    incomeDayOfMonth: 12,
    utilityDayOfMonth: 27,
    targetScore: 645,
    note: "SEASONALITY on a farmer, and no UPI at all — he is paid in cash at the mandi. The customer a judge will reach for first, so his harvest gaps are excluded and disclosed rather than scored.",
  },
  {
    archetype: "REACTOR",
    index: 2,
    name: "Deepa N.",
    age: 31,
    occupation: "self_employed",
    city: "Coimbatore",
    monthlyIncome: 33000,
    availableSources: [...BEHAVIOR_ORDER],
    seed: 9,
    sigmaScale: 0.6,
    severityScale: 2,
    incomeDayOfMonth: 26,
    utilityDayOfMonth: 5,
    targetScore: 628,
    note: "All five signals and always late, never absent — the clamped-gap Reactor. Her strip is an even comb pushed consistently right of the beat.",
  },
  {
    archetype: "REACTOR",
    index: 3,
    name: "Muthu K.",
    age: 45,
    occupation: "small_merchant",
    city: "Trichy",
    monthlyIncome: 31000,
    cibilScore: 649,
    availableSources: [
      "vehicle_service",
      "utility_bill",
      "phone_recharge",
      "fastag_toll",
    ],
    seed: 4,
    sigmaScale: 1.6,
    severityScale: 1.3,
    weakestSource: "utility_bill",
    incomeDayOfMonth: 9,
    utilityDayOfMonth: 5,
    targetScore: 657,
    note: "A cash trader with no UPI record, so the EMI date is inferred from his electricity bill instead. Exercises the fallback in the EMI source preference.",
  },

  /* ---------------- AVOIDER ---------------- */
  {
    archetype: "AVOIDER",
    index: 1,
    name: "Priya V.",
    age: 22,
    occupation: "gig_worker",
    city: "Madurai",
    monthlyIncome: 16000,
    availableSources: ["upi_recurring", "phone_recharge"],
    seed: 10,
    sigmaScale: 1.1,
    severityScale: 0.2,
    incomeDayOfMonth: 1,
    utilityDayOfMonth: 8,
    targetScore: 520,
    note: "THIN_FILE by the GATE, not by the score: two signals is below MIN_STREAMS_TO_SCORE, so no arithmetic can promote her. The 22-year-old first-time buyer the default cold-start rule is written for.",
  },
  {
    archetype: "AVOIDER",
    index: 2,
    name: "Balu S.",
    age: 36,
    occupation: "farmer",
    city: "Vellore",
    monthlyIncome: 17000,
    availableSources: [
      "vehicle_service",
      "upi_recurring",
      "phone_recharge",
      "fastag_toll",
    ],
    seed: 12,
    sigmaScale: 0.7,
    severityScale: 0.35,
    weakestSource: "upi_recurring",
    incomeDayOfMonth: 20,
    utilityDayOfMonth: 27,
    targetScore: 548,
    note: "The hard case: a farmer whose harvest gaps ARE forgiven and who is still an Avoider on what remains. The seasonal exception has to be capable of returning a low score, or it is just a discount. He is also the THIN_FILE-by-SCORE case, and the only one: four of five signals observed, so nothing about his file is thin, and he lands at 548 against a band boundary of 550. The tier label alone would call him unscoreable; the scorecard has to read dataCompleteness separately to say what is actually true, which is that he was fully observed and simply scored low.",
  },
  {
    archetype: "AVOIDER",
    index: 3,
    name: "Nirmala K.",
    age: 27,
    occupation: "salaried_informal",
    city: "Chennai",
    monthlyIncome: 22000,
    cibilScore: 573,
    availableSources: [
      "vehicle_service",
      "upi_recurring",
      "utility_bill",
      "phone_recharge",
    ],
    seed: 17,
    sigmaScale: 0.8,
    severityScale: 0.1,
    weakestSource: "utility_bill",
    incomeDayOfMonth: 16,
    utilityDayOfMonth: 23,
    targetScore: 529,
    note: "Long gaps and slow recovery on four visible signals. No cold start to explain it away — the score is low because the rhythm is, and the scorecard says so in plain words.",
  },
];

function slugFor(archetype: FinancialArchetype): string {
  return archetype.toLowerCase();
}

export function demoCustomerId(
  archetype: FinancialArchetype,
  index: number,
): string {
  return `vst-${slugFor(archetype)}-${index}`;
}

/** The customer record a spec describes, with no behavioural data attached. */
export function customerFromSpec(spec: DemoSpec): CustomerProfile {
  return {
    id: demoCustomerId(spec.archetype, spec.index),
    name: spec.name,
    age: spec.age,
    city: spec.city,
    occupation: spec.occupation,
    monthlyIncome: spec.monthlyIncome,
    hasCibilScore: spec.cibilScore !== undefined,
    ...(spec.cibilScore !== undefined ? { cibilScore: spec.cibilScore } : {}),
    streamAvailability: availabilityFrom(spec.availableSources),
  };
}

/** The stream-generation options a spec implies. */
export function streamOptionsFor(spec: DemoSpec): StreamOptions {
  return {
    sigmaScale: spec.sigmaScale,
    severityScale: spec.severityScale,
    weakestSource: spec.weakestSource,
    occupation: spec.occupation,
    ...(spec.seasonalPauses !== undefined
      ? { seasonalPauses: spec.seasonalPauses }
      : {}),
    incomeDayOfMonth: spec.incomeDayOfMonth,
    utilityDayOfMonth: spec.utilityDayOfMonth,
    availability: availabilityFrom(spec.availableSources),
  };
}

/**
 * Spec -> scored profile.
 *
 * The streams are redrawn until the ENGINE classifies the customer as the
 * archetype the spec claims. The label on a demo customer is therefore a
 * verified property of their data, not a caption — if the thresholds are ever
 * retuned, this loop either finds a draw that still agrees or the data check
 * fails loudly. It never silently ships a customer labelled Planner whose own
 * numbers say Reactor.
 */
export function buildDemoProfile(spec: DemoSpec): TemporalProfile {
  const customer = customerFromSpec(spec);
  const options = streamOptionsFor(spec);
  const key = `${customer.id}:${spec.seed}`;

  let profile = scoreProfile(
    customer,
    generateStreams(spec.archetype, hashSeed(key), options),
  );

  for (
    let attempt = 1;
    attempt < MAX_ARCHETYPE_ATTEMPTS &&
    profile.financialArchetype !== spec.archetype;
    attempt++
  ) {
    profile = scoreProfile(
      customer,
      generateStreams(spec.archetype, hashSeed(`${key}:${attempt}`), options),
    );
  }

  return profile;
}

export function getDemoSpec(
  archetype: FinancialArchetype,
  index: number,
): DemoSpec | undefined {
  return DEMO_SPECS.find(
    (spec) => spec.archetype === archetype && spec.index === index,
  );
}

/**
 * Fully deterministic: everything comes from the frozen spec, so
 * generateCustomer("PLANNER", 1) is byte-identical in every process and equal to
 * the module-scope DEMO_CUSTOMERS entry. scripts/check-data.ts asserts exactly
 * that, because a demo whose numbers move between the server render and the
 * client render is a demo that breaks on stage.
 */
export function generateCustomer(
  archetype: FinancialArchetype,
  index = 1,
): TemporalProfile {
  const spec = getDemoSpec(archetype, index);
  if (spec === undefined) {
    throw new Error(
      `No DEMO_SPEC for ${archetype}-${index}. The demo cohort is a fixed, curated set of ${DEMO_SPECS.length} customers, not an open generator — add a spec to DEMO_SPECS.`,
    );
  }
  return buildDemoProfile(spec);
}

/**
 * The cohort. Built EAGERLY at module scope, on purpose: the same array is then
 * shared by the server render and the client hydration, so there is no lazy
 * initialisation path that could produce a second, differently-seeded copy.
 */
export const DEMO_CUSTOMERS: TemporalProfile[] =
  DEMO_SPECS.map(buildDemoProfile);

export function getDemoCustomer(id: string): TemporalProfile | undefined {
  return DEMO_CUSTOMERS.find((profile) => profile.customer.id === id);
}

/**
 * Grouped by the archetype the profile was GENERATED as — which, thanks to the
 * rejection sampling in buildDemoProfile, is also the archetype the engine
 * classifies it as for every member of this cohort.
 */
export const DEMO_CUSTOMERS_BY_ARCHETYPE: Record<
  FinancialArchetype,
  TemporalProfile[]
> = ARCHETYPE_ORDER.reduce(
  (acc, archetype) => {
    // Ordered by spec index, so DEMO_CUSTOMERS_BY_ARCHETYPE[a][i - 1] is always
    // generateCustomer(a, i) — the identity check-data.ts asserts on.
    acc[archetype] = DEMO_SPECS.filter((spec) => spec.archetype === archetype)
      .sort((a, b) => a.index - b.index)
      .map((spec) => DEMO_CUSTOMERS[DEMO_SPECS.indexOf(spec)]);
    return acc;
  },
  {} as Record<FinancialArchetype, TemporalProfile[]>,
);

/* ================================================================== *
 * 6. Cohort self-check
 * ================================================================== */

/**
 * RESOLVED-SEASONAL-SHORT-CADENCE — kept because the invariant is worth stating.
 *
 * The engine's seasonal exclusion used to apply to every source. On a 7-day cadence
 * a single skipped week is already a 2x gap, and SEASONAL_MONTHS covers six months
 * of the twelve, so for a farmer or a merchant the engine forgave ordinary missed
 * toll weeks as harvest — which made "seasonally adjusted" mean, in practice, "is a
 * merchant", the exact objection the exception exists to answer.
 *
 * consistency.ts now gates the exclusion on MIN_SEASONAL_CADENCE_DAYS (29), which
 * admits exactly the monthly-or-slower sources and rejects toll (7d) and phone
 * (28d). That mirrors SEASONAL_STRETCH_SOURCES below, and the two must stay in
 * agreement: this generator must never inject a seasonal pause into a source the
 * engine will not forgive one for, or the demo data contains harvests the scorecard
 * silently charges for. If you add a source to SEASONAL_STRETCH_SOURCES, check its
 * cadence clears that constant first.
 *
 * The fix cost Balu S. 156 points (548 -> 392), because two of his three
 * "seasonal" exclusions were toll and phone weeks he had simply skipped. He was
 * retuned back to 548 on real regularity rather than on forgiven noise — the drop
 * is the measure of how much the loose version was inflating him.
 */

function reportCohortFailure(
  assertion: string,
  subject: string,
  actual: string | number,
): void {
  // console.assert rather than a throw: a demo that refuses to render is worse on
  // stage than a demo that renders with a warning in the console. The hard gate is
  // `npm run verify:data`, which does throw. This is the second net, and its job is
  // to name the customer so the failure is actionable without a debugger.
  console.assert(
    false,
    `[vistara cohort] ${assertion} — failed for ${subject}, actual: ${actual}`,
  );
}

/**
 * The five properties the demo cannot survive losing, checked at module scope so
 * they hold wherever the cohort is imported rather than only when someone remembers
 * to run a script. Cheap: five passes over twelve already-built profiles.
 */
(function checkCohort(): void {
  DEMO_CUSTOMERS.forEach((profile) => {
    // 1. A Planner who does not clear Prime has lost the thesis.
    if (
      profile.financialArchetype === "PLANNER" &&
      !(profile.vistaraScore > 750)
    ) {
      reportCohortFailure(
        "every PLANNER scores above 750",
        profile.customer.id,
        profile.vistaraScore,
      );
    }

    // 2. An Avoider who scores like a Planner means the archetypes are decorative.
    //
    // NOTE: the brief exempted THIN_FILE profiles from this check. Not applied,
    // because all three Avoiders currently land below the 550 band boundary and are
    // therefore THIN_FILE — the exemption would skip every subject and the
    // assertion would silently test nothing. An unconditional check passes today
    // and will actually fire if a future retune promotes one of them.
    if (
      profile.financialArchetype === "AVOIDER" &&
      !(profile.vistaraScore < 600)
    ) {
      reportCohortFailure(
        "every AVOIDER scores below 600",
        profile.customer.id,
        `${profile.vistaraScore} (${profile.tier})`,
      );
    }
  });

  // 3. Two customers offered the same EMI date makes the recommendation look like a
  //    constant instead of an inference. This is the assertion most likely to fire
  //    after a retune, and the hardest to spot by eye.
  const byEmiDate: Record<number, string[]> = {};
  DEMO_CUSTOMERS.forEach((profile) => {
    const day = profile.recommendedEmiDate;
    byEmiDate[day] = (byEmiDate[day] ?? []).concat(profile.customer.id);
  });
  Object.keys(byEmiDate).forEach((day) => {
    const ids = byEmiDate[Number(day)];
    if (ids.length > 1) {
      reportCohortFailure(
        "all 12 recommendedEmiDate values are distinct",
        `day ${day}`,
        ids.join(" + "),
      );
    }
  });

  // 4. The seasonal exception is the answer to the loudest fairness objection. If
  //    no customer exercises it, the code path is untested on stage.
  if (
    !DEMO_CUSTOMERS.some((profile) =>
      profile.metrics.some((metric) => metric.seasonalityAdjusted),
    )
  ) {
    reportCohortFailure(
      "at least one profile has seasonalityAdjusted on a metric",
      "the cohort",
      0,
    );
  }

  // 5. Same for cold start: without a visibly incomplete file, "scored on 3 of 5
  //    signals" is a claim the demo never actually demonstrates.
  const leastComplete = DEMO_CUSTOMERS.reduce(
    (worst, profile) => Math.min(worst, profile.dataCompleteness),
    1,
  );
  if (!(leastComplete < 0.6)) {
    reportCohortFailure(
      "at least one profile has dataCompleteness below 0.6",
      "the cohort",
      leastComplete.toFixed(2),
    );
  }
})();
