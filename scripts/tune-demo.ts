/**
 * Vistara — demo cohort tuner.
 *
 *   npm run tune:demo
 *
 * WHY THIS EXISTS. The archetype parameters in ARCHETYPE_GENERATION fix each
 * customer's CHARACTER — how their rhythm breaks. They do not fix where that
 * character lands on the 300-900 scale, because the engine's own weighting decides
 * that. So each DEMO_SPEC carries tuned numbers — `seed`, `sigmaScale`,
 * `severityScale` and `weakestSource` — and this script searches for the
 * combination that puts the customer on their target score while the ENGINE still
 * independently classifies them as the archetype they are labelled with.
 *
 * The search runs here, offline, and the winning values are pasted back into
 * DEMO_SPECS as literals. The app never searches at page load: the demo cohort is
 * frozen data, so the number on stage is the number that was checked.
 *
 * TWO LEVERS, NOT ONE. `sigmaScale` scales the jitter around the cadence.
 * `severityScale` scales the discrete failures — skipped cycles, slow recovery,
 * month-long absences. Both are needed because they dominate at opposite ends of
 * the scale: a Planner's score is almost entirely jitter, an Avoider's is almost
 * entirely absences, and searching jitter alone leaves every Avoider stuck at the
 * same score no matter how far it is turned down.
 *
 * THE JOINT CONSTRAINTS. Two of the cohort's requirements belong to the cohort and
 * not to any customer: all twelve EMI dates distinct, and all twelve top
 * improvement actions distinct. Those cannot be satisfied by a per-customer search,
 * because fixing one customer can break another. So the second pass is a real
 * assignment search, described where it is implemented, minimising total score
 * error with collisions priced so high it will always trade score accuracy for
 * distinctness.
 *
 * It also proves its own ceiling, which matters more than the tuning. The engine's
 * action vocabulary has 13 ids; only some are REACHABLE by this cohort, and the
 * maximum matching between customers and reachable ids is the largest number that
 * can ever hold a distinct top action. When that comes out below twelve, the
 * shortfall is a fact about the engine's advice vocabulary, not about the seeds —
 * so the script says so explicitly rather than leaving a reader to wonder whether
 * more search would fix it.
 */

import { BEHAVIOR_META } from "@/lib/constants";
import {
  DEMO_SPECS,
  type DemoSpec,
  buildDemoProfile,
} from "@/lib/synthetic-data";
import type { BehaviorSource, FinancialArchetype, TemporalProfile } from "@/lib/types";

/** Seeds tried per spec. The seed shuffles which draw we get, not its character. */
const SEEDS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
];

/**
 * The (sigmaScale, severityScale) grids, per archetype.
 *
 * Coarse on purpose: a finer grid would fit the target score to the decimal and
 * make the cohort brittle against any future retune of the engine's thresholds. We
 * want a customer who is comfortably inside their tier, not one balanced on its
 * boundary.
 *
 * The grids differ per archetype because the archetypes live in different regimes.
 * A Planner has a 2% miss rate, so severity is nearly inert for them and the grid
 * spends its budget on jitter. An Avoider misses a quarter of their cycles and
 * takes three deliberate absences, so severity is the only lever with real
 * authority and the grid reaches well below 1 — an Avoider at severity 0.3 is
 * still recognisably an Avoider, just not a hopeless one.
 */
const GRIDS: Record<
  FinancialArchetype,
  { sigma: number[]; severity: number[] }
> = {
  PLANNER: {
    sigma: [0.5, 0.7, 0.9, 1.1, 1.3, 1.6, 1.9, 2.2],
    severity: [0.4, 0.7, 1.0, 1.4],
  },
  ADAPTER: {
    sigma: [0.4, 0.6, 0.8, 1.0, 1.3, 1.6, 2.0, 2.5],
    severity: [0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1.0, 1.3],
  },
  REACTOR: {
    sigma: [0.6, 0.9, 1.2, 1.6, 2.0, 2.5, 3.0, 3.6],
    severity: [0.2, 0.4, 0.6, 0.8, 1.0, 1.3, 1.6, 2.0],
  },
  AVOIDER: {
    sigma: [0.5, 0.8, 1.1, 1.5, 2.0, 2.6, 3.2, 4.0],
    severity: [0.1, 0.2, 0.35, 0.5, 0.7, 0.9, 1.1, 1.4],
  },
};

/** Beyond this many points from target we would rather report a miss than hide it. */
const ACCEPTABLE_SCORE_ERROR = 12;

/**
 * What one collision costs the assignment search, in units of score error.
 *
 * Set far above any reachable score error so distinctness always wins: we would
 * rather ship a customer 200 points off their target than two customers handed
 * word-for-word identical advice, because the second is visible on stage and the
 * first is not.
 */
const COLLISION_PENALTY = 100_000;

/** Candidates kept per customer for the assignment search. */
const POOL_LIMIT = 80;

/** Backstop on the branch-and-bound, so a hard cohort cannot hang the script. */
const MAX_NODES = 4_000_000;

function pad(value: string | number, width: number): string {
  const s = String(value);
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

function padLeft(value: string | number, width: number): string {
  const s = String(value);
  return s.length >= width ? s.slice(0, width) : " ".repeat(width - s.length) + s;
}

interface Candidate {
  seed: number;
  sigmaScale: number;
  severityScale: number;
  weakestSource?: BehaviorSource;
  score: number;
  error: number;
  emiDate: number;
  topAction: string;
  profile: TemporalProfile;
}

function evaluate(
  spec: DemoSpec,
  seed: number,
  sigmaScale: number,
  severityScale: number,
  weakestSource: BehaviorSource | undefined,
): Candidate | undefined {
  const profile = buildDemoProfile({
    ...spec,
    seed,
    sigmaScale,
    severityScale,
    weakestSource,
  });
  // Archetype agreement is a HARD filter, not a tiebreak: a customer whose own
  // data says Reactor must never ship labelled Planner, however close their score
  // is to target. Disagreeing draws are not candidates at all.
  if (profile.financialArchetype !== spec.archetype) return undefined;
  // Nor is a draw so tidy that the engine has nothing to advise. It is a real
  // output — every lever priced below MIN_ACTION_POINTS — but a scorecard whose
  // "next best action" panel is empty is a hole in the demo, and shipping one to
  // win a distinctness constraint would be gaming our own tuner.
  if (profile.improvementActions.length === 0) return undefined;
  return {
    seed,
    sigmaScale,
    severityScale,
    weakestSource,
    score: profile.vistaraScore,
    error: Math.abs(profile.vistaraScore - spec.targetScore),
    emiDate: profile.recommendedEmiDate,
    topAction: profile.improvementActions[0].id,
    profile,
  };
}

/**
 * The weakestSource values worth trying for a spec: each of its own available
 * sources, plus "none" (every rhythm drawn at the same quality).
 */
function weakestCandidates(spec: DemoSpec): (BehaviorSource | undefined)[] {
  return [undefined, ...spec.availableSources];
}

/**
 * Every agreeing draw for one spec, pooled down to the best draw per
 * (emiDate, topAction) pair.
 *
 * Pooling by that pair is what makes the assignment search tractable: two draws
 * that produce the same EMI date AND the same top action are interchangeable as
 * far as the joint constraints are concerned, so only the more accurate one is
 * ever worth considering.
 */
function poolFor(spec: DemoSpec): { pool: Candidate[]; tried: number } {
  const grid = GRIDS[spec.archetype];
  const best = new Map<string, Candidate>();
  let tried = 0;

  for (const weakestSource of weakestCandidates(spec)) {
    for (const sigmaScale of grid.sigma) {
      for (const severityScale of grid.severity) {
        for (const seed of SEEDS) {
          tried++;
          const candidate = evaluate(
            spec,
            seed,
            sigmaScale,
            severityScale,
            weakestSource,
          );
          if (candidate === undefined) continue;
          const key = `${candidate.emiDate}|${candidate.topAction}`;
          const incumbent = best.get(key);
          if (
            incumbent === undefined ||
            candidate.error < incumbent.error ||
            // Prefer the least-distorted draw on a tie: scales nearer 1 keep the
            // archetype's own published parameters, which is the more defensible
            // cohort to put in front of a judge.
            (candidate.error === incumbent.error &&
              Math.abs(candidate.sigmaScale - 1) + Math.abs(candidate.severityScale - 1) <
                Math.abs(incumbent.sigmaScale - 1) +
                  Math.abs(incumbent.severityScale - 1))
          ) {
            best.set(key, candidate);
          }
        }
      }
    }
  }

  const pool = Array.from(best.values())
    .sort((a, b) => a.error - b.error)
    .slice(0, POOL_LIMIT);
  return { pool, tried };
}

/* ------------------------------------------------------------------ *
 * Pass 1 — per-customer search
 * ------------------------------------------------------------------ */

console.log("");
console.log("VISTARA :: DEMO COHORT TUNER");

const pools = DEMO_SPECS.map((spec) => ({ spec, ...poolFor(spec) }));
const totalTried = pools.reduce((sum, p) => sum + p.tried, 0);

console.log(
  `${DEMO_SPECS.length} specs · ${totalTried} draws evaluated · ${pools.reduce(
    (sum, p) => sum + p.pool.length,
    0,
  )} pooled candidates`,
);
console.log("");

const HEAD =
  pad("customer", 14) +
  pad("archetype", 10) +
  padLeft("target", 7) +
  padLeft("best", 6) +
  padLeft("err", 5) +
  padLeft("pool", 6) +
  padLeft("emis", 6) +
  padLeft("acts", 6) +
  "  reachable top actions";
console.log(HEAD);
console.log("=".repeat(HEAD.length));

for (const { spec, pool } of pools) {
  const emis = new Set(pool.map((c) => c.emiDate));
  const actions = new Set(pool.map((c) => c.topAction));
  const top = pool[0];
  console.log(
    pad(spec.name, 14) +
      pad(spec.archetype, 10) +
      padLeft(spec.targetScore, 7) +
      padLeft(top?.score ?? "-", 6) +
      padLeft(top?.error ?? "-", 5) +
      padLeft(pool.length, 6) +
      padLeft(emis.size, 6) +
      padLeft(actions.size, 6) +
      "  " +
      Array.from(actions).join(" ") +
      (pool.length === 0 ? "   [NO DRAW AGREES WITH THE LABEL]" : ""),
  );
}
console.log("");

/* ------------------------------------------------------------------ *
 * Pass 2 — the joint constraints, as an assignment problem
 * ------------------------------------------------------------------ */

/**
 * Choose one candidate per customer minimising
 *
 *     total score error  +  COLLISION_PENALTY x (duplicate EMI dates + duplicate top actions)
 *
 * WHY NOT ONE FLAT BRANCH AND BOUND. The obvious version — walk the customers,
 * try every candidate, bound on accumulated error — does not work here, and the
 * reason is worth writing down. Its bound is driven by score error, but the cost is
 * dominated by collisions, so it cannot prune until it has stumbled on a
 * collision-free assignment by luck. With ~70 candidates each across twelve
 * customers it burns millions of nodes reshuffling near-perfect scores among three
 * customers all holding the same action id, and returns "2 collisions" simply
 * because it never reached a valid corner of the space.
 *
 * So the search is split along the structure of the problem. Distinctness of the
 * top action is a BIPARTITE MATCHING between customers and the engine's action
 * vocabulary, and matching comes with a bound: the maximum matching over the whole
 * cohort is exactly how many customers CAN hold a unique action, so the minimum
 * number of collisions is known before the search starts. The outer search assigns
 * actions with that number as its allowance, and prunes any prefix whose remaining
 * customers cannot be matched within the allowance still unspent. A branch where
 * three Adapters compete for one id therefore dies at the node that creates it,
 * not after everything beneath it has been explored.
 *
 * Then, with actions fixed, each customer is restricted to their draws carrying
 * that action and a small inner branch and bound settles the EMI dates and the
 * score error. Because the outer lower bound (the cheapest draw per assigned
 * action) never exceeds the inner result, walking the action assignments in
 * increasing lower-bound order and stopping when the bound passes the best result
 * found makes the whole thing provably optimal rather than merely good.
 *
 * (The iterator spreads a reader would expect — [...set], for..of over a Map — are
 * written as Array.from and forEach on purpose: this repo's tsconfig sets no
 * `target`, so `tsc --noEmit` downlevels to ES5 and rejects them.)
 */
interface Assignment {
  cost: number;
  picks: Candidate[];
}

/** Distinct top actions reachable by each customer, and their cheapest draw. */
const reachable = pools.map(({ pool }) => {
  const byAction = new Map<string, Candidate[]>();
  for (const candidate of pool) {
    const list = byAction.get(candidate.topAction);
    if (list === undefined) byAction.set(candidate.topAction, [candidate]);
    else list.push(candidate);
  }
  byAction.forEach((list) => list.sort((a, b) => a.error - b.error));
  return byAction;
});

/** Every action id any customer can top out on. */
const VOCABULARY: string[] = (() => {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const { pool } of pools) {
    for (const candidate of pool) {
      if (seen.has(candidate.topAction)) continue;
      seen.add(candidate.topAction);
      ids.push(candidate.topAction);
    }
  }
  return ids.sort();
})();

/**
 * Kuhn's algorithm: can every customer in `customers` be given a distinct action
 * drawn from `free`? Tiny instances (<= 12 x 13), so the simple version is right.
 */
function matchingSize(customers: number[], free: Set<string>): number {
  const matchedBy = new Map<string, number>();

  function augment(customer: number, seen: Set<string>): boolean {
    const actions = Array.from(reachable[customer].keys());
    for (const action of actions) {
      if (!free.has(action) || seen.has(action)) continue;
      seen.add(action);
      const holder = matchedBy.get(action);
      if (holder === undefined || augment(holder, seen)) {
        matchedBy.set(action, customer);
        return true;
      }
    }
    return false;
  }

  let size = 0;
  for (const customer of customers) {
    if (augment(customer, new Set<string>())) size++;
  }
  return size;
}

/**
 * Inner search: actions are fixed, so settle EMI distinctness and score error.
 * Returns Infinity if this action assignment cannot beat `ceiling`.
 */
function refine(
  actionOf: string[],
  order: number[],
  ceiling: number,
): Assignment {
  const options = order.map((customer) =>
    (reachable[customer].get(actionOf[customer]) ?? []).slice(0, 12),
  );
  const errorSuffix: number[] = new Array(order.length + 1).fill(0);
  for (let i = order.length - 1; i >= 0; i--) {
    errorSuffix[i] = errorSuffix[i + 1] + (options[i][0]?.error ?? 0);
  }

  let bestCost = ceiling;
  let bestPicks: Candidate[] | undefined;
  const usedEmi = new Set<number>();
  const picks: Candidate[] = [];

  function descend(depth: number, cost: number): void {
    if (cost + errorSuffix[depth] >= bestCost) return;
    if (depth === order.length) {
      bestCost = cost;
      bestPicks = picks.slice();
      return;
    }
    for (const candidate of options[depth]) {
      const clash = usedEmi.has(candidate.emiDate);
      const next = cost + candidate.error + (clash ? COLLISION_PENALTY : 0);
      if (next + errorSuffix[depth + 1] >= bestCost) continue;
      if (!clash) usedEmi.add(candidate.emiDate);
      picks.push(candidate);
      descend(depth + 1, next);
      picks.pop();
      if (!clash) usedEmi.delete(candidate.emiDate);
    }
  }

  descend(0, 0);

  if (bestPicks === undefined) return { cost: Number.POSITIVE_INFINITY, picks: [] };
  const byIndex: Candidate[] = new Array(pools.length);
  bestPicks.forEach((candidate, depth) => {
    byIndex[order[depth]] = candidate;
  });
  return { cost: bestCost, picks: byIndex };
}

function solve(): {
  assignment: Assignment;
  nodes: number;
  exhausted: boolean;
  ceiling: number;
} {
  // Most-constrained-first: a customer who can only ever top out on one action
  // must claim it before a customer with eight options takes it from them.
  const order = pools
    .map((_, index) => index)
    .sort(
      (a: number, b: number) =>
        reachable[a].size - reachable[b].size ||
        pools[a].pool.length - pools[b].pool.length,
    );

  // How many customers can hold a unique top action at all. Anything below
  // order.length is a statement about the ENGINE's action vocabulary, not about
  // the tuning: no choice of seeds can beat a maximum matching.
  const ceiling = matchingSize(order, new Set(VOCABULARY));
  const allowance = order.length - ceiling;

  let best: Assignment = { cost: Number.POSITIVE_INFINITY, picks: [] };
  let nodes = 0;
  let exhausted = true;
  const actionOf: string[] = new Array(pools.length).fill("");
  const used = new Set<string>();

  function complement(): Set<string> {
    const free = new Set<string>();
    for (const action of VOCABULARY) if (!used.has(action)) free.add(action);
    return free;
  }

  function descend(
    depth: number,
    lowerBound: number,
    collisions: number,
  ): void {
    if (nodes >= MAX_NODES) {
      exhausted = false;
      return;
    }
    if (lowerBound >= best.cost) return;

    if (depth === order.length) {
      // refine() only knows about EMI dates and score error, so the action
      // collisions this branch has already paid for have to be carried in
      // explicitly — both into its ceiling and into the cost it reports back.
      const paid = collisions * COLLISION_PENALTY;
      const refined = refine(actionOf, order, best.cost - paid);
      const total = refined.cost + paid;
      if (total < best.cost) best = { cost: total, picks: refined.picks };
      return;
    }

    const customer = order[depth];
    // Cheapest action first: the outer bound is only useful if good assignments
    // are found early, and the cheapest draw per action is exactly that ordering.
    const actions: [string, Candidate[]][] = [];
    reachable[customer].forEach((draws, action) => actions.push([action, draws]));
    actions.sort((a, b) => a[1][0].error - b[1][0].error);

    for (const entry of actions) {
      const action = entry[0];
      const draws = entry[1];
      nodes++;
      const clash = used.has(action);
      if (clash && collisions >= allowance) continue;

      if (!clash) used.add(action);
      // The matching bound, applied to the tail: if the customers still to be
      // placed cannot take that many distinct free ids, the shortfall is
      // collisions this branch has not paid for yet. Prune before descending.
      const tail = order.slice(depth + 1);
      const shortfall = tail.length - matchingSize(tail, complement());
      if (collisions + (clash ? 1 : 0) + shortfall > allowance) {
        if (!clash) used.delete(action);
        continue;
      }

      actionOf[customer] = action;
      descend(
        depth + 1,
        lowerBound + draws[0].error + (clash ? COLLISION_PENALTY : 0),
        collisions + (clash ? 1 : 0),
      );
      if (!clash) used.delete(action);

      if (nodes >= MAX_NODES) return;
    }
  }

  descend(0, 0, 0);
  return { assignment: best, nodes, exhausted, ceiling };
}

const { assignment, nodes, exhausted, ceiling } = solve();
const results = pools.map((p, i) => ({ ...p, best: assignment.picks[i] }));
const totalError = results.reduce((sum, r) => sum + (r.best?.error ?? 0), 0);
const collisions = Math.round((assignment.cost - totalError) / COLLISION_PENALTY);

console.log("JOINT ASSIGNMENT");
console.log(
  `  reachable action vocabulary: ${VOCABULARY.length} distinct ids -> at most ${ceiling}/${
    pools.length
  } customers can hold a unique top action${
    ceiling === pools.length
      ? ""
      : ` — ${pools.length - ceiling} collision(s) are UNAVOIDABLE, no seed fixes this`
  }`,
);
console.log(`  vocabulary: ${VOCABULARY.join(", ")}`);
console.log(
  `  branch and bound: ${nodes} nodes${
    exhausted
      ? " (search space exhausted — this assignment is optimal)"
      : ` (hit the ${MAX_NODES} node cap — best found, not proven optimal)`
  }`,
);
console.log(
  `  total score error ${totalError} points across ${results.length} customers · ${collisions} collision(s)`,
);
console.log("");

/* ------------------------------------------------------------------ *
 * Output — paste-ready literals
 * ------------------------------------------------------------------ */

console.log("FROZEN VALUES — paste into DEMO_SPECS");
console.log("");
for (const { spec, best } of results) {
  if (best === undefined) {
    console.log(`  ${pad(spec.name + ":", 14)} NO AGREEING DRAW — spec needs rethinking`);
    continue;
  }
  const weakest =
    best.weakestSource === undefined
      ? "weakestSource: undefined"
      : `weakestSource: "${best.weakestSource}"`;
  console.log(
    `  ${pad(spec.name + ":", 14)} seed: ${best.seed}, sigmaScale: ${
      best.sigmaScale
    }, severityScale: ${best.severityScale}, ${weakest},   // ${best.score} vs ${
      spec.targetScore
    } · emi ${best.emiDate} · ${best.topAction}`,
  );
}
console.log("");

const placed = results.filter((r) => r.best !== undefined);
const finalScores = placed.map((r) => r.best.score);
const emiDates = new Set(placed.map((r) => r.best.emiDate));
const topActions = new Set(placed.map((r) => r.best.topAction));
const overshoot = placed.filter((r) => r.best.error > ACCEPTABLE_SCORE_ERROR);

function duplicatesOf<T>(values: T[]): string {
  const seen = new Map<string, number>();
  for (const v of values) seen.set(String(v), (seen.get(String(v)) ?? 0) + 1);
  return (
    Array.from(seen.entries())
      .filter(([, n]) => n > 1)
      .map(([k, n]) => `${k} x${n}`)
      .join(", ") || "none"
  );
}

console.log("SUMMARY");
console.log(
  `  score range      ${Math.min(...finalScores)} - ${Math.max(...finalScores)}`,
);
console.log(
  `  distinct emi     ${emiDates.size}/${placed.length}   dupes: ${duplicatesOf(
    placed.map((r) => r.best.emiDate),
  )}`,
);
console.log(
  `  distinct actions ${topActions.size}/${placed.length}   dupes: ${duplicatesOf(
    placed.map((r) => r.best.topAction),
  )}`,
);
console.log(
  `  off target >${ACCEPTABLE_SCORE_ERROR}     ${overshoot.length}${
    overshoot.length > 0
      ? ` (${overshoot
          .map((r) => `${r.spec.name} ${r.best.score} vs ${r.spec.targetScore}`)
          .join(", ")})`
      : ""
  }`,
);
console.log("");

/* ------------------------------------------------------------------ *
 * Per-source diagnostics for the winning draws
 * ------------------------------------------------------------------ */

console.log("WINNING DRAWS — per-source detail");
console.log("");
for (const { spec, best } of results) {
  if (best === undefined) continue;
  console.log(
    `${spec.name} (${spec.archetype}, ${spec.occupation}) score ${best.score} ${
      best.profile.tier
    } · cover ${best.profile.scoredSources.length}/5 · cross ${
      best.profile.crossDomainConsistency
    }${best.profile.seasonalityAdjusted ? " · SEASONAL" : ""} · emi ${
      best.emiDate
    }`,
  );
  for (const m of best.profile.metrics) {
    console.log(
      "    " +
        pad(BEHAVIOR_META[m.source].short, 17) +
        padLeft(m.eventCount, 4) +
        padLeft(m.meanIntervalDays.toFixed(1), 8) +
        padLeft(`s${m.stdDevDays.toFixed(1)}`, 8) +
        padLeft(`n${m.normalisedStdDevDays.toFixed(1)}`, 8) +
        padLeft(`idx ${m.consistencyIndex.toFixed(0)}`, 9) +
        padLeft(m.band, 14) +
        (m.seasonalityAdjusted ? `  seasonal -${m.excludedSeasonalGaps}` : ""),
    );
  }
  for (const source of best.profile.missingSources) {
    console.log("    " + pad(BEHAVIOR_META[source].short, 17) + "   NO DATA");
  }
  for (const action of best.profile.improvementActions.slice(0, 3)) {
    console.log(`      · ${action.id} +${action.potentialPoints}`);
  }
  console.log("");
}
