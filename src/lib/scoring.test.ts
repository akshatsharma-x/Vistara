/**
 * Vistara — scoring engine tests.
 *
 *   npm test
 *
 * A black-box suite over src/lib/consistency.ts. Every case here is built from
 * HAND-WRITTEN timestamps, not from the generator, so a bug in synthetic-data.ts
 * cannot hide a bug in the engine (and vice versa) — the two are checked against
 * each other only in the final cohort group. `npm run verify:data` covers the
 * generated demo cohort; this file covers the maths.
 *
 * The six numbered groups are the specified contract. Groups 7-9 guard the
 * Phase 4 visualisation contract, determinism, and the two cohort properties the
 * demo script depends on.
 *
 * No test framework is installed on purpose: this runs under `tsx` in about a
 * second, has no watch mode to leave running, and throws a non-zero exit on the
 * first failing assertion group. tsconfig sets no `target`, so this file is
 * downlevelled to ES5 — `for..of` over arrays only, no iterable spread.
 */

import {
  BEHAVIOR_META,
  BEHAVIOR_ORDER,
  MIN_EVENTS_TO_SCORE,
  MIN_STREAMS_TO_SCORE,
  SEASONAL_MONTHS,
} from "@/lib/constants";
import {
  buildEventStrip,
  computeCrossDomainConsistency,
  computeMetrics,
  computeVistaraScore,
  isSeasonalOccupation,
  recommendEmiDate,
  scoreProfile,
} from "@/lib/consistency";
import { REFERENCE_DATE, addDays, daysBetween } from "@/lib/rng";
import {
  DEMO_CUSTOMERS,
  defaultStreamAvailability,
  generateBehaviorStream,
  generateStreams,
} from "@/lib/synthetic-data";
import type {
  BehaviorSource,
  BehaviorStream,
  ConsistencyMetrics,
  CustomerProfile,
  Occupation,
} from "@/lib/types";

/* ================================================================== *
 * Harness
 * ================================================================== */

interface Result {
  name: string;
  failures: string[];
  notes: string[];
}

const results: Result[] = [];
let current: Result | undefined;

function test(name: string, body: () => void): void {
  current = { name, failures: [], notes: [] };
  try {
    body();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    current.failures.push(`threw ${message}`);
  }
  results.push(current);
  current = undefined;
}

function check(condition: boolean, message: string): void {
  if (current === undefined) throw new Error("check() called outside a test");
  if (!condition) current.failures.push(message);
}

function eq(actual: unknown, expected: unknown, label: string): void {
  check(
    actual === expected,
    `${label}: expected ${String(expected)}, got ${String(actual)}`,
  );
}

function near(actual: number, expected: number, tol: number, label: string): void {
  check(
    Math.abs(actual - expected) <= tol,
    `${label}: expected ${expected} +/-${tol}, got ${actual.toFixed(3)}`,
  );
}

/** Context printed under the test name whether it passes or fails. */
function note(message: string): void {
  if (current !== undefined) current.notes.push(message);
}

function fmt(n: number, dp = 1): string {
  return n.toFixed(dp);
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/* ================================================================== *
 * Stream builders — every timestamp in these tests is explicit
 * ================================================================== */

function streamOf(source: BehaviorSource, timestamps: Date[]): BehaviorStream {
  return {
    source,
    label: BEHAVIOR_META[source].label,
    timestamps,
    expectedIntervalDays: BEHAVIOR_META[source].expectedIntervalDays,
  };
}

/**
 * A stream with exactly these gaps, the last event one day inside the window.
 * Built backward from the anchor so the history always ends "now" regardless of
 * how long it is.
 */
function fromGaps(source: BehaviorSource, gaps: number[]): BehaviorStream {
  const timestamps: Date[] = [addDays(REFERENCE_DATE, -1)];
  for (let i = gaps.length - 1; i >= 0; i--) {
    timestamps.unshift(addDays(timestamps[0], -gaps[i]));
  }
  return streamOf(source, timestamps);
}

/** A perfectly even comb: `count` events, every gap exactly `gap` days. */
function comb(source: BehaviorSource, gap: number, count: number): BehaviorStream {
  const gaps: number[] = [];
  for (let i = 1; i < count; i++) gaps.push(gap);
  return fromGaps(source, gaps);
}

/** A comb on this source's own declared cadence. */
function onCadence(source: BehaviorSource, count: number): BehaviorStream {
  return comb(source, BEHAVIOR_META[source].expectedIntervalDays, count);
}

function utc(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/**
 * Events on the same day of month for `count` consecutive months, the last one
 * in August 2026 (inside the window, whose reference date is 2026-09-01).
 */
function monthlyOnDay(
  source: BehaviorSource,
  dayOfMonth: number,
  count: number,
): BehaviorStream {
  const lastMonthIndex = 2026 * 12 + 7; // August 2026
  const timestamps: Date[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const m = lastMonthIndex - i;
    timestamps.push(new Date(Date.UTC(Math.floor(m / 12), m % 12, dayOfMonth)));
  }
  return streamOf(source, timestamps);
}

function customerFor(
  occupation: Occupation,
  available: BehaviorSource[],
): CustomerProfile {
  const streamAvailability: Partial<Record<BehaviorSource, boolean>> = {};
  for (const source of BEHAVIOR_ORDER) {
    streamAvailability[source] = available.indexOf(source) !== -1;
  }
  return {
    id: `test-${occupation}`,
    name: "Test Subject",
    age: 33,
    city: "Coimbatore",
    occupation,
    monthlyIncome: 24000,
    hasCibilScore: false,
    streamAvailability,
  };
}

/** A ConsistencyMetrics with a chosen consistencyIndex and nothing else moving. */
function metricWithIndex(
  source: BehaviorSource,
  consistencyIndex: number,
): ConsistencyMetrics {
  const expected = BEHAVIOR_META[source].expectedIntervalDays;
  return {
    source,
    meanIntervalDays: expected,
    stdDevDays: 0,
    streakLength: 6,
    recoverySpeedDays: 0,
    consistencyIndex,
    expectedIntervalDays: expected,
    baselineIntervalDays: expected,
    normalisedStdDevDays: 0,
    band: "exceptional",
    eventCount: 12,
    scorable: true,
    seasonalityAdjusted: false,
    excludedSeasonalGaps: 0,
  };
}

/* ================================================================== *
 * 1. Perfect regularity scores 100 — at every cadence
 * ================================================================== */

test("1. sigma of zero is a consistency index of exactly 100", () => {
  // A comb with identical gaps has population sigma 0 by construction. The
  // index must saturate, not merely come close: this is the anchor the whole
  // 0-100 scale hangs off, and every explanation in the UI reads "give or take
  // under a day" from it.
  for (const source of BEHAVIOR_ORDER) {
    const stream = onCadence(source, 10);
    const metric = computeMetrics(stream);

    eq(metric.stdDevDays, 0, `${source} stdDevDays`);
    eq(metric.normalisedStdDevDays, 0, `${source} normalisedStdDevDays`);
    eq(metric.consistencyIndex, 100, `${source} consistencyIndex`);
    eq(metric.band, "exceptional", `${source} band`);
    eq(metric.scorable, true, `${source} scorable`);
    eq(metric.recoverySpeedDays, 0, `${source} recoverySpeedDays`);
    // Nine gaps, all on beat, so the trailing streak is all of them.
    eq(metric.streakLength, 9, `${source} streakLength`);
    near(
      metric.meanIntervalDays,
      BEHAVIOR_META[source].expectedIntervalDays,
      1e-9,
      `${source} meanIntervalDays`,
    );
  }

  // And it is regularity being scored, not compliance: a customer who reliably
  // services every 75 days against a 90-day cadence is still perfectly regular.
  const offCadence = computeMetrics(comb("vehicle_service", 75, 10));
  eq(offCadence.stdDevDays, 0, "off-cadence comb stdDevDays");
  eq(offCadence.consistencyIndex, 100, "off-cadence comb consistencyIndex");
  note("regularity, not compliance: a steady 75d rhythm on a 90d cadence = 100");
});

/* ================================================================== *
 * 2. Too little history degrades, never crashes
 * ================================================================== */

test("2. a single timestamp falls back gracefully instead of throwing", () => {
  const one = streamOf("upi_recurring", [addDays(REFERENCE_DATE, -30)]);
  const metric = computeMetrics(one);

  eq(metric.scorable, false, "1 event scorable");
  eq(metric.eventCount, 1, "1 event eventCount");
  eq(metric.consistencyIndex, 0, "1 event consistencyIndex");
  eq(metric.stdDevDays, 0, "1 event stdDevDays");
  eq(metric.seasonalityAdjusted, false, "1 event seasonalityAdjusted");

  // Zero, one, two and three events are all an ABSENCE of evidence, not a poor
  // rhythm. Two points in particular define a single gap and therefore a sigma
  // of exactly 0 — a fabricated perfect rhythm — which is why the guard sits at
  // MIN_EVENTS_TO_SCORE rather than at 2.
  for (let n = 0; n < MIN_EVENTS_TO_SCORE; n++) {
    const gaps: number[] = [];
    for (let i = 1; i < n; i++) gaps.push(30);
    const stream = n === 0 ? streamOf("upi_recurring", []) : fromGaps("upi_recurring", gaps);
    const m = computeMetrics(stream);
    eq(m.scorable, false, `${n} events scorable`);
    eq(m.consistencyIndex, 0, `${n} events consistencyIndex`);
  }
  eq(computeMetrics(onCadence("upi_recurring", MIN_EVENTS_TO_SCORE)).scorable, true,
    `${MIN_EVENTS_TO_SCORE} events scorable`);

  // Nothing downstream may throw on the degenerate stream either.
  const strip = buildEventStrip(one, metric);
  eq(strip.events.length, 1, "single-event strip length");
  eq(strip.events[0].onTime, true, "the first event has no gap to be late against");

  const day = recommendEmiDate([one]);
  check(
    Number.isInteger(day) && day >= 1 && day <= 28,
    `single-event recommendEmiDate returned ${day}, not an integer in 1..28`,
  );
  eq(recommendEmiDate([]), 5, "no streams at all falls through to the documented default");

  // A whole customer made of single events: a real cold-start file, and the
  // one most likely to be pasted into a demo by accident.
  const customer = customerFor("gig_worker", BEHAVIOR_ORDER.slice());
  const profile = scoreProfile(
    customer,
    BEHAVIOR_ORDER.map((s) => streamOf(s, [addDays(REFERENCE_DATE, -20)])),
  );
  eq(profile.scoredSources.length, 0, "all-single-event scoredSources");
  eq(profile.dataCompleteness, 0, "all-single-event dataCompleteness");
  eq(profile.tier, "THIN_FILE", "all-single-event tier");
  eq(profile.vistaraScore, 300, "all-single-event score is the floor, not NaN");
  check(Number.isFinite(profile.crossDomainConsistency), "crossDomainConsistency is NaN");
  note("0-3 events => scorable:false; score floors at 300 with no NaN anywhere");
});

/* ================================================================== *
 * 3. Cold start
 * ================================================================== */

test("3. zero available streams is THIN_FILE with dataCompleteness 0", () => {
  // The generator refuses to invent a history for a source the customer does
  // not have. Nothing is imputed; the absence is returned as an absence.
  const noneAvailable: Partial<Record<BehaviorSource, boolean>> = {};
  for (const source of BEHAVIOR_ORDER) {
    eq(
      generateBehaviorStream(source, "PLANNER", 1, { availability: noneAvailable }),
      null,
      `unavailable ${source} must generate null`,
    );
  }
  eq(generateStreams("PLANNER", 1, { availability: noneAvailable }).length, 0,
    "generateStreams with nothing available");

  const customer = customerFor("gig_worker", []);
  const profile = scoreProfile(customer, []);

  eq(profile.tier, "THIN_FILE", "no-stream tier");
  eq(profile.dataCompleteness, 0, "no-stream dataCompleteness");
  eq(profile.scoredSources.length, 0, "no-stream scoredSources");
  eq(profile.missingSources.length, BEHAVIOR_ORDER.length, "no-stream missingSources");
  eq(profile.crossDomainConsistency, 0, "no-stream crossDomainConsistency");
  eq(profile.factors.length, 0, "no-stream factors");
  eq(profile.maxLoanAmount, 0, "no-stream maxLoanAmount");
  check(
    Number.isInteger(profile.recommendedEmiDate) &&
      profile.recommendedEmiDate >= 1 &&
      profile.recommendedEmiDate <= 28,
    `no-stream recommendedEmiDate ${profile.recommendedEmiDate} is not a real date`,
  );

  // The documented default rule: a gig worker or farmer under 25 is a
  // first-time buyer, so no dealer has ever recorded a service for them.
  const firstTimer = defaultStreamAvailability({ age: 22, occupation: "gig_worker" });
  eq(firstTimer.vehicle_service, false, "22yo gig worker vehicle_service availability");
  eq(firstTimer.upi_recurring, true, "22yo gig worker keeps their other signals");
  eq(
    defaultStreamAvailability({ age: 40, occupation: "farmer" }).vehicle_service,
    true,
    "the rule keys off age AND occupation — 'farmers do not service' is false",
  );

  // The partial case is the one the officer actually sees. Weights renormalise
  // over what was observed, so a missing 0.30-weight service history is not a
  // silent 30-point deduction — but the stream-count gate still fires, because
  // two rhythms are not enough to form a view.
  const partial = scoreProfile(
    customerFor("gig_worker", ["upi_recurring", "phone_recharge"]),
    [onCadence("upi_recurring", 12), onCadence("phone_recharge", 12)],
  );
  eq(partial.scoredSources.length, 2, "partial scoredSources");
  near(partial.dataCompleteness, 0.4, 1e-9, "partial dataCompleteness");
  eq(partial.tier, "THIN_FILE", `fewer than ${MIN_STREAMS_TO_SCORE} rhythms must gate to THIN_FILE`);
  const partialWeight = partial.factors.reduce((sum, f) => sum + f.weight, 0);
  near(partialWeight, 1, 1e-9, "renormalised weights over 2 of 5 sources");

  // Three perfect rhythms clear the gate. Same maths, different verdict — which
  // is the whole point of separating the gate from the score.
  const enough = scoreProfile(
    customerFor("gig_worker", ["upi_recurring", "phone_recharge", "fastag_toll"]),
    [onCadence("upi_recurring", 12), onCadence("phone_recharge", 12), onCadence("fastag_toll", 20)],
  );
  eq(enough.scoredSources.length, 3, "3-stream scoredSources");
  near(enough.dataCompleteness, 0.6, 1e-9, "3-stream dataCompleteness");
  check(enough.tier !== "THIN_FILE", `3 perfect rhythms still gated: ${enough.tier}`);
  note(
    `gate at ${MIN_STREAMS_TO_SCORE} streams: 2 perfect rhythms => THIN_FILE, ` +
      `3 => ${enough.tier} (${enough.vistaraScore})`,
  );
});

/* ================================================================== *
 * 4. Seasonality — a harvest is not a character flaw
 * ================================================================== */

test("4. a farmer's harvest gaps are excluded, not charged", () => {
  // A rice farmer services in February post-harvest and August pre-sowing, not
  // every 90 days. These dates are literal so the case cannot drift: five gaps
  // of 90 days except one of 150 that CLOSES in November, inside the
  // harvest/festival window.
  const harvest = streamOf("vehicle_service", [
    utc("2025-03-12"),
    utc("2025-06-10"), // +90
    utc("2025-11-07"), // +150  <- the harvest pause, closing in November
    utc("2026-02-05"), // +90
    utc("2026-05-06"), // +90
    utc("2026-08-04"), // +90
  ]);

  const gaps: number[] = [];
  for (let i = 1; i < harvest.timestamps.length; i++) {
    gaps.push(daysBetween(harvest.timestamps[i - 1], harvest.timestamps[i]));
  }
  eq(gaps.join(","), "90,150,90,90,90", "fixture gaps");
  check(
    SEASONAL_MONTHS.indexOf(harvest.timestamps[2].getUTCMonth()) !== -1,
    "fixture error: the long gap does not close inside a seasonal window",
  );

  const farmer = computeMetrics(harvest, { seasonalityEligible: true });
  const other = computeMetrics(harvest, { seasonalityEligible: false });

  eq(farmer.seasonalityAdjusted, true, "farmer seasonalityAdjusted");
  eq(farmer.excludedSeasonalGaps, 1, "farmer excludedSeasonalGaps");
  eq(other.seasonalityAdjusted, false, "non-farmer seasonalityAdjusted");
  eq(other.excludedSeasonalGaps, 0, "non-farmer excludedSeasonalGaps");

  // Sigma is measured against the MEDIAN once adjusted, so the residual of the
  // forgiven gap cannot drag the centre with it.
  near(farmer.baselineIntervalDays, 90, 1e-9, "farmer baseline is the median gap");
  near(other.baselineIntervalDays, 102, 1e-9, "non-farmer baseline is the mean gap");

  check(
    farmer.consistencyIndex > other.consistencyIndex,
    `the exception did not help: farmer ${fmt(farmer.consistencyIndex)} vs ` +
      `non-farmer ${fmt(other.consistencyIndex)}`,
  );

  // The sharper claim, and the one a judge will press on: the adjusted farmer
  // scores the SAME as an identical customer who simply had no harvest at all.
  // Not "less penalised" — not penalised.
  const noHarvest = computeMetrics(comb("vehicle_service", 90, 5));
  eq(farmer.consistencyIndex, noHarvest.consistencyIndex,
    "adjusted farmer vs an equivalent uninterrupted rhythm");
  eq(farmer.stdDevDays, 0, "farmer sigma after exclusion");

  // Forgiving the gap in sigma and then charging it as a broken streak would be
  // dishonest bookkeeping, so the excluded gap is out of both.
  eq(farmer.streakLength, 4, "the forgiven gap must not also break the streak");

  // Eligibility comes from the occupation, never from the data. A rule that
  // decides for itself when to forgive a gap is not auditable.
  eq(isSeasonalOccupation("farmer"), true, "farmer is seasonal");
  eq(isSeasonalOccupation("small_merchant"), true, "small merchant is seasonal");
  eq(isSeasonalOccupation("gig_worker"), false, "gig worker is not seasonal");
  eq(isSeasonalOccupation("salaried_informal"), false, "salaried informal is not seasonal");

  // End to end, through scoreProfile, where occupation is the only difference.
  const streams = [
    harvest,
    onCadence("upi_recurring", 18),
    onCadence("utility_bill", 18),
    onCadence("phone_recharge", 18),
    onCadence("fastag_toll", 60),
  ];
  const farmerProfile = scoreProfile(customerFor("farmer", BEHAVIOR_ORDER.slice()), streams);
  const otherProfile = scoreProfile(customerFor("self_employed", BEHAVIOR_ORDER.slice()), streams);

  eq(farmerProfile.seasonalityAdjusted, true, "farmer profile seasonalityAdjusted");
  eq(otherProfile.seasonalityAdjusted, false, "non-farmer profile seasonalityAdjusted");
  check(
    farmerProfile.vistaraScore > otherProfile.vistaraScore,
    `farmer ${farmerProfile.vistaraScore} not above non-farmer ${otherProfile.vistaraScore}`,
  );
  const seasonalFactor = farmerProfile.factors.filter((f) => f.source === "vehicle_service")[0];
  check(seasonalFactor !== undefined, "no vehicle_service factor on the farmer scorecard");
  if (seasonalFactor !== undefined) {
    check(
      seasonalFactor.seasonalityAdjusted &&
        seasonalFactor.explanation.toLowerCase().indexOf("seasonal") !== -1,
      `the scorecard does not disclose the adjustment: "${seasonalFactor.explanation}"`,
    );
  }

  // The exception is bounded. It forgives at most MAX_SEASONAL_EXCLUSIONS gaps
  // and needs MIN_RETAINED_GAPS left over, so it can never launder a customer
  // who simply stopped showing up.
  const absentee = streamOf("vehicle_service", [
    utc("2025-03-12"),
    utc("2025-05-01"),
    utc("2025-10-28"), // long, seasonal
    utc("2025-12-20"),
    utc("2026-05-30"), // long, seasonal
    utc("2026-06-28"),
    utc("2026-11-15"), // long, seasonal — a third, beyond the budget
  ]);
  const laundered = computeMetrics(absentee, { seasonalityEligible: true });
  check(
    laundered.excludedSeasonalGaps <= 2,
    `forgave ${laundered.excludedSeasonalGaps} gaps — the cap is 2`,
  );
  check(
    laundered.consistencyIndex < 100,
    `a serial absentee was laundered to ${fmt(laundered.consistencyIndex)}`,
  );
  note(
    `harvest gap: farmer ${fmt(farmer.consistencyIndex)} (= clean rhythm) vs ` +
      `non-farmer ${fmt(other.consistencyIndex)}; profile ` +
      `${farmerProfile.vistaraScore} vs ${otherProfile.vistaraScore}`,
  );
});

/* ================================================================== *
 * 5. Cross-domain coherence — the actual thesis
 * ================================================================== */

test("5. two strong domains plus three broken ones lose to five even ones", () => {
  // This is the product's central claim in one assertion. Consistency in one
  // domain can be coincidence; consistency ACROSS unrelated domains is
  // character — so the split file must lose to the even one even though its
  // best two signals are far better than anything the even file has.
  const split = [
    metricWithIndex("vehicle_service", 95),
    metricWithIndex("utility_bill", 95),
    metricWithIndex("upi_recurring", 20),
    metricWithIndex("phone_recharge", 20),
    metricWithIndex("fastag_toll", 20),
  ];
  const even = BEHAVIOR_ORDER.map((source) => metricWithIndex(source, 60));

  const splitCross = computeCrossDomainConsistency(split);
  const evenCross = computeCrossDomainConsistency(even);
  const splitScore = computeVistaraScore(split, splitCross);
  const evenScore = computeVistaraScore(even, evenCross);

  check(
    splitCross < evenCross,
    `cross-domain: split ${fmt(splitCross)} is not below even ${fmt(evenCross)}`,
  );
  check(
    splitScore < evenScore,
    `score: split ${splitScore} is not below even ${evenScore}`,
  );

  // Five equal indices must return exactly that index: no dispersion, so no
  // penalty. If this drifts, every "evenly consistent" claim in the UI is off.
  near(evenCross, 60, 0.1, "five equal indices return themselves");

  // The central-tendency term is GEOMETRIC, which is what stops one perfect
  // domain buying off four broken ones. The arithmetic mean of this set is 36.
  const bought = [
    metricWithIndex("vehicle_service", 100),
    metricWithIndex("upi_recurring", 20),
    metricWithIndex("utility_bill", 20),
    metricWithIndex("phone_recharge", 20),
    metricWithIndex("fastag_toll", 20),
  ];
  const boughtCross = computeCrossDomainConsistency(bought);
  check(
    boughtCross < 36,
    `one perfect domain bought off four broken ones: ${fmt(boughtCross)} >= 36 ` +
      "(the arithmetic mean) — the geometric mean is not being used",
  );

  // A single observed rhythm is not cross-domain evidence of anything, and is
  // reported at half strength rather than as coherence.
  eq(
    computeCrossDomainConsistency([metricWithIndex("upi_recurring", 90)]),
    45,
    "a lone rhythm is reported at half strength",
  );
  eq(computeCrossDomainConsistency([]), 0, "no rhythms");

  // Unscorable metrics must not be averaged in as zeros — that would punish a
  // cold-start customer twice for the same missing signal.
  const withAbsence = [
    metricWithIndex("vehicle_service", 60),
    metricWithIndex("upi_recurring", 60),
    metricWithIndex("utility_bill", 60),
  ];
  const unscorable = metricWithIndex("fastag_toll", 0);
  unscorable.scorable = false;
  eq(
    computeCrossDomainConsistency(withAbsence.concat([unscorable])),
    computeCrossDomainConsistency(withAbsence),
    "an unavailable signal must not be scored as a zero-consistency one",
  );

  note(
    `split(95,95,20,20,20) cross ${fmt(splitCross)} score ${splitScore}  <  ` +
      `even(60x5) cross ${fmt(evenCross)} score ${evenScore}`,
  );
});

/* ================================================================== *
 * 6. EMI date — the buffer wraps forward across the month boundary
 * ================================================================== */

test("6. income on the 28th recommends the 1st or 2nd, not the 28th", () => {
  const paidOn28 = monthlyOnDay("upi_recurring", 28, 12);
  eq(computeMetrics(paidOn28).scorable, true, "the 28th fixture must be scorable");

  const day = recommendEmiDate([paidOn28]);
  check(
    day === 1 || day === 2,
    `income on the 28th recommended day ${day} — expected 1 or 2 (next month, ` +
      "after the buffer)",
  );
  check(
    day !== 28,
    "clamping instead of wrapping put the debit ON payday, with no buffer at all",
  );

  // The failure this guards against: clamping the buffered day back into the
  // month moves the debit EARLIER than the income it is buffered against, which
  // is the exact opposite of what a buffer is for. Check every day where the
  // wrap can bite, not just the 28th.
  const boundary: { paid: number; expect: number }[] = [
    { paid: 26, expect: 28 },
    { paid: 27, expect: 1 },
    { paid: 28, expect: 2 },
  ];
  for (const row of boundary) {
    const got = recommendEmiDate([monthlyOnDay("upi_recurring", row.paid, 12)]);
    eq(got, row.expect, `paid on the ${row.paid}th`);
  }

  // Mid-month is the boring case and must stay boring.
  eq(recommendEmiDate([monthlyOnDay("upi_recurring", 10, 12)]), 12, "paid on the 10th");

  // Every recommendation is a day that exists in February, so a monthly mandate
  // never silently skips a month.
  for (let paid = 1; paid <= 28; paid++) {
    const got = recommendEmiDate([monthlyOnDay("upi_recurring", paid, 8)]);
    check(
      Number.isInteger(got) && got >= 1 && got <= 28,
      `paid on the ${paid}th returned ${got}, which is not an integer in 1..28`,
    );
  }

  // UPI is the most direct read on income there is, so it wins over a utility
  // bill even when the bill is the more concentrated of the two.
  const chosen = recommendEmiDate([
    monthlyOnDay("upi_recurring", 28, 12),
    monthlyOnDay("utility_bill", 15, 12),
  ]);
  eq(chosen, 2, "UPI must outrank the utility bill as an income signal");
  note("28th -> 2nd, 27th -> 1st, 26th -> 28th: the buffer wraps forward");
});

/* ================================================================== *
 * 7. The event strip — the Phase 4 visualisation contract
 * ================================================================== */

test("7. buildEventStrip returns one dated verdict per observed event", () => {
  const stream = fromGaps("upi_recurring", [30, 30, 30, 75, 30, 30]);
  const metric = computeMetrics(stream);
  const strip = buildEventStrip(stream, metric);

  eq(strip.source, stream.source, "strip source");
  eq(strip.label, stream.label, "strip label");
  eq(strip.expectedIntervalDays, stream.expectedIntervalDays, "strip cadence");
  eq(strip.consistencyIndex, metric.consistencyIndex, "strip index");
  eq(strip.events.length, stream.timestamps.length, "strip event count");

  for (let i = 0; i < strip.events.length; i++) {
    eq(strip.events[i].date.getTime(), stream.timestamps[i].getTime(), `strip date ${i}`);
  }
  eq(strip.events[0].onTime, true, "the first event has no gap to be late against");

  // The 75-day gap closes at index 4, and that is the event that must read late.
  eq(strip.events[4].onTime, false, "the event closing a 75-day gap on a 30-day rhythm");
  const late = strip.events.filter((e) => !e.onTime).length;
  eq(late, 1, "exactly one late event in this fixture");

  // A perfect comb has nothing to mark late, and a metronome is what the strip
  // has to look like for a Planner or the visual says nothing.
  const perfect = buildEventStrip(onCadence("upi_recurring", 12), computeMetrics(onCadence("upi_recurring", 12)));
  eq(perfect.events.filter((e) => !e.onTime).length, 0, "late events in a perfect comb");
  note(`${late} of ${strip.events.length} events flagged late on the drifting fixture`);
});

/* ================================================================== *
 * 8. Determinism — the demo cannot be allowed to differ per render
 * ================================================================== */

test("8. the same seed always produces the same history", () => {
  const availability = defaultStreamAvailability({ age: 34, occupation: "small_merchant" });

  for (const source of BEHAVIOR_ORDER) {
    const a = generateBehaviorStream(source, "ADAPTER", 7, { availability });
    const b = generateBehaviorStream(source, "ADAPTER", 7, { availability });
    check(a !== null && b !== null, `${source} should be available`);
    if (a === null || b === null) continue;
    eq(
      a.timestamps.map(iso).join("|"),
      b.timestamps.map(iso).join("|"),
      `${source} regenerated identically`,
    );
    check(a.timestamps.length >= MIN_EVENTS_TO_SCORE, `${source} too short to score`);
    for (let i = 1; i < a.timestamps.length; i++) {
      check(
        a.timestamps[i].getTime() > a.timestamps[i - 1].getTime(),
        `${source} timestamps not strictly ascending at ${i}`,
      );
    }
  }

  // A different seed must actually produce a different history, or the seed is
  // being ignored and the whole cohort is one customer twelve times.
  const one = generateBehaviorStream("upi_recurring", "ADAPTER", 7, { availability });
  const two = generateBehaviorStream("upi_recurring", "ADAPTER", 8, { availability });
  check(
    one !== null && two !== null &&
      one.timestamps.map(iso).join("|") !== two.timestamps.map(iso).join("|"),
    "two different seeds produced the same history",
  );
});

/* ================================================================== *
 * 9. The demo cohort's on-stage properties
 * ================================================================== */

test("9. every demo customer is distinguishable on stage", () => {
  eq(DEMO_CUSTOMERS.length, 12, "cohort size");

  // Every scorecard must have something in its "next best action" panel. An
  // empty one is a hole in the demo, not a compliment.
  for (const profile of DEMO_CUSTOMERS) {
    check(
      profile.improvementActions.length > 0,
      `${profile.customer.id} has no improvement actions`,
    );
    check(
      profile.customer.name.indexOf("Vista ") === -1,
      `${profile.customer.id}: the product is Vistara, never Vista`,
    );
  }

  // Distinct EMI dates: the recommendation is the demo's most concrete output,
  // and twelve customers all told "pay on the 5th" would read as a hardcode.
  const emiDates = DEMO_CUSTOMERS.map((p) => p.recommendedEmiDate);
  const distinctEmi = emiDates.filter((d, i) => emiDates.indexOf(d) === i);
  eq(distinctEmi.length, DEMO_CUSTOMERS.length, "distinct recommendedEmiDate values");

  // Distinct top actions, with a documented ceiling. Only 10 of the engine's 13
  // action ids are REACHABLE as a top action by this cohort — a missing
  // low-weight signal is worth fewer points than tightening an existing weak
  // one, so coverage-phone_recharge, coverage-utility_bill and
  // coverage-fastag_toll can never rank first — and the maximum bipartite
  // matching between these twelve customers and those ten ids is therefore 10.
  // The two unavoidable repeats land on coherence-cross-domain, held by all
  // three Adapters, which is definitionally the Adapter weakness. 10 is optimal,
  // not a shortfall; see scripts/tune-demo.ts for the proof.
  const topActions = DEMO_CUSTOMERS.map((p) => p.improvementActions[0].id);
  const distinctActions = topActions.filter((a, i) => topActions.indexOf(a) === i);
  check(
    distinctActions.length >= 10,
    `only ${distinctActions.length} distinct top actions across the cohort ` +
      `(proven ceiling is 10): ${topActions.join(", ")}`,
  );

  // Both known weaknesses must be exercised by someone, or the code that
  // handles them is never seen to run.
  check(
    DEMO_CUSTOMERS.some((p) => p.missingSources.length > 0),
    "no demo customer exercises the cold-start path",
  );
  check(
    DEMO_CUSTOMERS.some((p) => p.seasonalityAdjusted),
    "no demo customer exercises the seasonal adjustment",
  );

  note(
    `${distinctEmi.length}/12 distinct EMI dates, ${distinctActions.length}/12 ` +
      "distinct top actions (ceiling 10)",
  );
});

/* ================================================================== *
 * Report
 * ================================================================== */

console.log("");
console.log("VISTARA :: TEMPORAL CONSISTENCY ENGINE :: SCORING TESTS");
console.log("");

let failed = 0;
for (const result of results) {
  const ok = result.failures.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? "  PASS  " : "  FAIL  "}${result.name}`);
  for (const n of result.notes) console.log(`          ${n}`);
  for (const f of result.failures) console.log(`          x ${f}`);
}

console.log("");
if (failed > 0) {
  const total = results.reduce((sum, r) => sum + r.failures.length, 0);
  console.error(`TESTS FAILED — ${failed} of ${results.length} groups, ${total} assertion(s).`);
  console.log("");
  throw new Error(`scoring.test: ${failed} group(s) failed`);
}
console.log(`TESTS PASSED — ${results.length} groups green.`);
console.log("");
