/**
 * Vistara — data + scoring sanity harness.
 *
 *   npm run verify:data
 *
 * Prints every demo customer's derived signal, then asserts the properties the
 * demo depends on. If this script is green, the numbers on stage are coherent:
 * the archetypes actually separate, all four tiers are populated, every EMI date
 * is a real date, every history sits inside the observation window, the
 * scorecard adds up to the score it explains, and regeneration is bit-stable.
 */

import {
  BEHAVIOR_META,
  BEHAVIOR_ORDER,
  CROSS_DOMAIN_WEIGHT,
  MIN_STREAMS_TO_SCORE,
  OBSERVATION_DAYS,
  SCORE_MAX,
  SCORE_MIN,
  TIER_ORDER,
} from "@/lib/constants";
import {
  bandForStdDev,
  circularMeanDayOfMonth,
  tierForScore,
} from "@/lib/consistency";
import { REFERENCE_DATE, addDays, mean } from "@/lib/rng";
import {
  DEMO_CUSTOMERS,
  DEMO_CUSTOMERS_BY_ARCHETYPE,
  generateCustomer,
} from "@/lib/synthetic-data";
import type { FinancialArchetype, TemporalProfile } from "@/lib/types";

const WINDOW_START = addDays(REFERENCE_DATE, -OBSERVATION_DAYS);
const ARCHETYPES: FinancialArchetype[] = [
  "PLANNER",
  "REACTOR",
  "AVOIDER",
  "ADAPTER",
];

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function pad(value: string | number, width: number): string {
  const s = String(value);
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

function padLeft(value: string | number, width: number): string {
  const s = String(value);
  return s.length >= width ? s.slice(0, width) : " ".repeat(width - s.length) + s;
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function fmt(n: number, dp = 1): string {
  return n.toFixed(dp);
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

console.log("");
console.log("VISTARA :: TEMPORAL CONSISTENCY ENGINE :: DATA CHECK");
console.log(
  `reference ${iso(REFERENCE_DATE)}  |  window ${iso(WINDOW_START)} -> ${iso(
    REFERENCE_DATE,
  )}  (${OBSERVATION_DAYS}d)  |  cohort ${DEMO_CUSTOMERS.length}`,
);
console.log("");

const HEAD =
  pad("customer", 21) +
  pad("occupation", 18) +
  pad("archetype", 10) +
  padLeft("cross", 6) +
  padLeft("score", 6) +
  "  " +
  pad("tier", 11) +
  padLeft("emi", 4) +
  padLeft("cover", 7);

console.log(HEAD);
console.log("=".repeat(HEAD.length));

for (const profile of DEMO_CUSTOMERS) {
  console.log(
    pad(profile.customer.name, 21) +
      pad(profile.customer.occupation, 18) +
      pad(profile.financialArchetype, 10) +
      padLeft(fmt(profile.crossDomainConsistency), 6) +
      padLeft(profile.vistaraScore, 6) +
      "  " +
      pad(profile.tier, 11) +
      padLeft(profile.recommendedEmiDate, 4) +
      padLeft(`${profile.scoredSources.length}/5`, 7),
  );

  console.log(
    "    " +
      pad("source", 17) +
      padLeft("n", 4) +
      padLeft("mean", 7) +
      padLeft("sigma", 7) +
      padLeft("norm", 7) +
      padLeft("strk", 5) +
      padLeft("recov", 7) +
      padLeft("index", 7) +
      "  band",
  );

  for (const metric of profile.metrics) {
    const band = metric.scorable
      ? bandForStdDev(metric.normalisedStdDevDays).label +
        (metric.seasonalityAdjusted
          ? ` (seasonal -${metric.excludedSeasonalGaps})`
          : "")
      : "NOT SCORABLE";
    console.log(
      "    " +
        pad(metric.source, 17) +
        padLeft(metric.eventCount, 4) +
        padLeft(fmt(metric.meanIntervalDays), 7) +
        padLeft(fmt(metric.stdDevDays, 2), 7) +
        padLeft(fmt(metric.normalisedStdDevDays, 2), 7) +
        padLeft(metric.streakLength, 5) +
        padLeft(fmt(metric.recoverySpeedDays), 7) +
        padLeft(fmt(metric.consistencyIndex), 7) +
        "  " +
        band,
    );
  }

  for (const source of profile.missingSources) {
    console.log(
      "    " + pad(source, 17) + padLeft("-", 4) + "     NO DATA (cold start)",
    );
  }

  const top = profile.improvementActions[0];
  if (top !== undefined) {
    console.log(
      `    next best action: ${top.title} (+${top.potentialPoints} pts, ${top.horizonMonths}mo)`,
    );
  }
  console.log("");
}

/* ------------------------------------------------------------------ *
 * Archetype summary
 * ------------------------------------------------------------------ */

const meanScoreByArchetype: Record<FinancialArchetype, number> = {
  PLANNER: 0,
  REACTOR: 0,
  AVOIDER: 0,
  ADAPTER: 0,
};

console.log("ARCHETYPE SEPARATION");
console.log(
  pad("generated as", 15) +
    padLeft("n", 3) +
    padLeft("mean", 8) +
    padLeft("min", 6) +
    padLeft("max", 6) +
    "   tiers",
);
for (const archetype of ARCHETYPES) {
  const group = DEMO_CUSTOMERS_BY_ARCHETYPE[archetype];
  const scores = group.map((p) => p.vistaraScore);
  meanScoreByArchetype[archetype] = mean(scores);
  console.log(
    pad(archetype, 15) +
      padLeft(group.length, 3) +
      padLeft(fmt(meanScoreByArchetype[archetype]), 8) +
      padLeft(Math.min(...scores), 6) +
      padLeft(Math.max(...scores), 6) +
      "   " +
      group.map((p) => p.tier).join(", "),
  );
}
console.log("");

const tierCounts = new Map<string, number>();
for (const profile of DEMO_CUSTOMERS) {
  tierCounts.set(profile.tier, (tierCounts.get(profile.tier) ?? 0) + 1);
}
console.log(
  "TIER SPREAD   " +
    TIER_ORDER.map((t) => `${t}=${tierCounts.get(t) ?? 0}`).join("   "),
);

const cohortEmiDates = DEMO_CUSTOMERS.map((p) => p.recommendedEmiDate);
console.log(
  `EMI DATES     ${cohortEmiDates.join(", ")}  (range ${Math.min(
    ...cohortEmiDates,
  )}-${Math.max(...cohortEmiDates)})`,
);
console.log(
  `COLD START    ${DEMO_CUSTOMERS.filter((p) => p.missingSources.length > 0)
    .map((p) => `${p.customer.id} missing ${p.missingSources.join("+")}`)
    .join("; ")}`,
);
console.log(
  `SEASONAL      ${
    DEMO_CUSTOMERS.filter((p) => p.seasonalityAdjusted)
      .map((p) => p.customer.id)
      .join(", ") || "none"
  }`,
);
console.log("");

/* ------------------------------------------------------------------ *
 * Assertions
 * ------------------------------------------------------------------ */

// 1. All four tiers appear across the cohort.
for (const tier of TIER_ORDER) {
  check(
    (tierCounts.get(tier) ?? 0) > 0,
    `[1] tier ${tier} is unrepresented across the ${DEMO_CUSTOMERS.length} demo customers — the demo cannot show the full lending ladder`,
  );
}

// 2. The archetypes must actually separate on score.
check(
  meanScoreByArchetype.PLANNER > meanScoreByArchetype.REACTOR,
  `[2] PLANNER mean score (${fmt(
    meanScoreByArchetype.PLANNER,
  )}) is not above REACTOR (${fmt(meanScoreByArchetype.REACTOR)})`,
);
check(
  meanScoreByArchetype.REACTOR > meanScoreByArchetype.AVOIDER,
  `[2] REACTOR mean score (${fmt(
    meanScoreByArchetype.REACTOR,
  )}) is not above AVOIDER (${fmt(meanScoreByArchetype.AVOIDER)})`,
);

// 3. Every recommended EMI date is an integer day that exists in February.
for (const profile of DEMO_CUSTOMERS) {
  const day = profile.recommendedEmiDate;
  check(
    Number.isInteger(day) && day >= 1 && day <= 28,
    `[3] ${profile.customer.id} recommendedEmiDate=${day} is not an integer in 1..28`,
  );
}

// 3b. The circular mean must not behave like an arithmetic one. A customer paid
// on the 30th, 1st and 2nd is paid at the turn of the month; the arithmetic mean
// says the 11th, which is the worst answer available.
const turnOfMonth = circularMeanDayOfMonth([30, 1, 2, 31, 1]);
check(
  turnOfMonth <= 3 || turnOfMonth >= 29,
  `[3b] circularMeanDayOfMonth([30,1,2,31,1]) = ${fmt(
    turnOfMonth,
    2,
  )} — expected the turn of the month, not the middle`,
);
const midMonth = circularMeanDayOfMonth([14, 15, 16]);
check(
  Math.abs(midMonth - 15) < 0.5,
  `[3b] circularMeanDayOfMonth([14,15,16]) = ${fmt(midMonth, 2)}, expected ~15`,
);

// 4. Every timestamp array is ascending, duplicate-free and inside the window.
for (const profile of DEMO_CUSTOMERS) {
  const sources = profile.streams.map((s) => s.source);
  check(
    sources.join(",") ===
      BEHAVIOR_ORDER.filter((s) => sources.includes(s)).join(","),
    `[4] ${profile.customer.id} streams are not in BEHAVIOR_ORDER: ${sources.join(",")}`,
  );

  for (const stream of profile.streams) {
    check(
      stream.timestamps.length >= 2,
      `[4] ${profile.customer.id}/${stream.source} has only ${stream.timestamps.length} events`,
    );
    check(
      stream.expectedIntervalDays ===
        BEHAVIOR_META[stream.source].expectedIntervalDays,
      `[4] ${profile.customer.id}/${stream.source} expectedIntervalDays drifted from BEHAVIOR_META`,
    );
    for (let i = 0; i < stream.timestamps.length; i++) {
      const t = stream.timestamps[i];
      check(
        t.getTime() > WINDOW_START.getTime() &&
          t.getTime() < REFERENCE_DATE.getTime(),
        `[4] ${profile.customer.id}/${stream.source} timestamp ${iso(
          t,
        )} falls outside the observation window`,
      );
      if (i > 0) {
        check(
          t.getTime() > stream.timestamps[i - 1].getTime(),
          `[4] ${profile.customer.id}/${stream.source} timestamps not strictly ascending at index ${i}`,
        );
      }
    }
  }
}

// 5. Determinism: regenerating the same customer reproduces it exactly.
function fingerprint(p: TemporalProfile): string {
  return [
    p.customer.id,
    p.customer.name,
    p.customer.age,
    p.customer.city,
    p.customer.monthlyIncome,
    p.vistaraScore,
    p.tier,
    p.financialArchetype,
    p.crossDomainConsistency,
    p.recommendedEmiDate,
    p.improvementActions.map((a) => `${a.id}:${a.potentialPoints}`).join(","),
    p.streams
      .map((s) => `${s.source}:${s.timestamps.map((t) => iso(t)).join("|")}`)
      .join(";"),
  ].join("~");
}

for (const archetype of ARCHETYPES) {
  for (let i = 1; i <= DEMO_CUSTOMERS_BY_ARCHETYPE[archetype].length; i++) {
    const a = generateCustomer(archetype, i);
    const b = generateCustomer(archetype, i);
    check(
      a.vistaraScore === b.vistaraScore,
      `[5] ${a.customer.id} score is not deterministic (${a.vistaraScore} vs ${b.vistaraScore})`,
    );
    check(
      fingerprint(a) === fingerprint(b),
      `[5] ${a.customer.id} full profile is not deterministic across regeneration`,
    );
    check(
      fingerprint(a) ===
        fingerprint(DEMO_CUSTOMERS_BY_ARCHETYPE[archetype][i - 1]),
      `[5] ${a.customer.id} regenerated profile differs from the module-scope DEMO_CUSTOMERS entry`,
    );
  }
}

/* --- structural guards on the new explainability contract --- */

for (const profile of DEMO_CUSTOMERS) {
  const id = profile.customer.id;

  // 6. The scorecard must add up to the score it claims to explain.
  const factorPoints = profile.factors.reduce((sum, f) => sum + f.points, 0);
  const crossPoints =
    (profile.crossDomainConsistency / 100) *
    CROSS_DOMAIN_WEIGHT *
    (SCORE_MAX - SCORE_MIN);
  const rebuilt = SCORE_MIN + factorPoints + crossPoints;
  check(
    Math.abs(rebuilt - profile.vistaraScore) <= profile.factors.length + 1,
    `[6] ${id} scorecard does not reconstruct the score: 300 + ${factorPoints} + ${fmt(
      crossPoints,
    )} = ${fmt(rebuilt)} vs ${profile.vistaraScore}`,
  );
  const weightSum = profile.factors.reduce((sum, f) => sum + f.weight, 0);
  check(
    profile.factors.length === 0 || Math.abs(weightSum - 1) < 1e-9,
    `[6] ${id} renormalised factor weights sum to ${weightSum}, not 1`,
  );

  // 7. Coverage bookkeeping is honest.
  check(
    profile.scoredSources.length + profile.missingSources.length ===
      BEHAVIOR_ORDER.length,
    `[7] ${id} scored (${profile.scoredSources.length}) + missing (${profile.missingSources.length}) != 5`,
  );
  check(
    Math.abs(
      profile.dataCompleteness -
        profile.scoredSources.length / BEHAVIOR_ORDER.length,
    ) < 1e-9,
    `[7] ${id} dataCompleteness ${profile.dataCompleteness} disagrees with scoredSources`,
  );
  check(
    profile.missingSources.every((s) => !profile.scoredSources.includes(s)),
    `[7] ${id} lists a source as both scored and missing`,
  );

  // 8. Score, loan terms and tier stay inside their contracts.
  check(
    profile.vistaraScore >= SCORE_MIN && profile.vistaraScore <= SCORE_MAX,
    `[8] ${id} score ${profile.vistaraScore} outside ${SCORE_MIN}..${SCORE_MAX}`,
  );
  check(
    (profile.tier === "THIN_FILE") === (profile.maxLoanAmount === 0),
    `[8] ${id} tier ${profile.tier} but maxLoanAmount ${profile.maxLoanAmount}`,
  );
  for (const action of profile.improvementActions) {
    check(
      action.potentialPoints > 0 && action.potentialPoints % 5 === 0,
      `[8] ${id} action ${action.id} has potentialPoints ${action.potentialPoints} (must be a positive multiple of 5)`,
    );
  }
}

// 9. The thin-file GATE is a different code path from a low score, and must
// fire even on an otherwise excellent file.
check(
  tierForScore(880, MIN_STREAMS_TO_SCORE - 1) === "THIN_FILE",
  "[9] tierForScore did not force THIN_FILE for a high score with too few observed rhythms",
);
check(
  tierForScore(880, MIN_STREAMS_TO_SCORE) === "PRIME",
  "[9] tierForScore withheld PRIME from a high score with enough observed rhythms",
);

// 10. The cold-start path must actually be exercised by the cohort.
check(
  DEMO_CUSTOMERS.some((p) => p.missingSources.length > 0),
  "[10] no demo customer is missing a signal — the weight-renormalisation path is untested",
);

// Soft signal: does the classifier agree with the generator?
const misclassified = DEMO_CUSTOMERS.filter(
  (p) => !p.customer.id.includes(p.financialArchetype.toLowerCase()),
);
check(
  misclassified.length === 0,
  `[11] the engine disagrees with the generated label for: ${misclassified
    .map((p) => `${p.customer.id}->${p.financialArchetype}`)
    .join(", ")}`,
);
console.log(
  `CLASSIFIER    ${DEMO_CUSTOMERS.length - misclassified.length}/${
    DEMO_CUSTOMERS.length
  } profiles classified as the archetype they were generated as`,
);
console.log("");

if (failures.length > 0) {
  console.error(`DATA CHECK FAILED — ${failures.length} assertion(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  throw new Error(`check-data: ${failures.length} assertion(s) failed`);
}

console.log("DATA CHECK PASSED — all assertion groups green.");
console.log("");
