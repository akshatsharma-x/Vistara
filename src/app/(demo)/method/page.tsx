import type { Metadata } from "next";
import type { ReactNode } from "react";

import { EventStrip } from "@/components/charts";
import {
  Badge,
  Button,
  Card,
  DataTable,
  Meter,
  SectionHeading,
  StatTile,
  TierBadge,
} from "@/components/ui";
import type { DataTableColumn } from "@/components/ui";
import { computeCrossDomainConsistency } from "@/lib/consistency";
import {
  ARCHETYPE_META,
  BEHAVIOR_META,
  BEHAVIOR_ORDER,
  BEHAVIOR_WEIGHTS,
  COLOR_MAP,
  CONSISTENCY_BANDS,
  COVERAGE_ACTIONS,
  CROSS_DOMAIN_WEIGHT,
  MAX_SEASONAL_EXCLUSIONS,
  MIN_EVENTS_TO_SCORE,
  MIN_STREAMS_TO_SCORE,
  OBSERVATION_DAYS,
  OBSERVATION_MONTHS,
  OCCUPATION_META,
  SCORE_MAX,
  SCORE_MIN,
  SEASONAL_OCCUPATIONS,
  SEASONAL_WINDOWS,
  TIER_LOAN_CONFIG,
  TIER_ORDER,
  TIER_THRESHOLDS,
} from "@/lib/constants";
import {
  formatDate,
  formatDays,
  formatINR,
  formatScore,
  formatSigma,
  pct,
} from "@/lib/format";
import { REFERENCE_DATE, addDays, mean } from "@/lib/rng";
import { DEMO_CUSTOMERS, DEMO_CUSTOMERS_BY_ARCHETYPE } from "@/lib/synthetic-data";
import type {
  BehaviorSource,
  BehaviorStream,
  ConsistencyMetrics,
  FinancialArchetype,
  TemporalProfile,
  Tier,
} from "@/lib/types";

/* ================================================================== *
 * /method — how the score works.
 * ================================================================== *
 * The technical case for the engine, and the answers to the two objections a
 * timing model has to survive. Recovered from the pre-5A landing page, which
 * was the only place this material ever lived.
 *
 * A Server Component. Every figure below is computed at build time by the real
 * engine against the frozen cohort — the coherence table, the worked example
 * and the tier table are engine output, not prose describing engine output,
 * which is the whole reason this page is worth having. EventStrip is drawn from
 * percentage geometry with no measuring hook of its own, so it renders here
 * without a client boundary and the page ships no JavaScript for the strips.
 * ================================================================== */

export const metadata: Metadata = {
  title: "How the score works — Vistara",
  description:
    "The Temporal Consistency Engine in detail: five timestamp-only signals, cross-domain coherence, and the answers to the cold-start and seasonality objections.",
};

const EM_DASH = "—";

/** The reference cadence every sigma on this page is normalised to. */
const REFERENCE_CADENCE_DAYS = 30;

/** What each rhythm actually tells a lender. One line, no hedging. */
const SIGNAL_INSIGHT: Record<BehaviorSource, string> = {
  vehicle_service:
    "Servicing to a schedule instead of to a symptom — foresight about an asset that only complains after the damage.",
  upi_recurring:
    "Rent, chit or subscription leaving on the same date every month — a household that runs on a calendar, not on a reminder.",
  utility_bill:
    "The electricity bill paid at the same point in its window each cycle — everyday follow-through against a hard deadline.",
  phone_recharge:
    "Recharging before expiry rather than after — a small, cheap decision made early, month after month.",
  fastag_toll:
    "The commute itself, at weekly resolution — the fastest rhythm to stabilise, so a new profile becomes readable sooner.",
};

const CONVENTIONAL_TESTS = [
  "Amounts — declared income, ticket size, account balances.",
  "Categories — which merchant, which basket, which wallet.",
  "Repayment history — a bureau file you can only own if somebody already lent to you.",
];

const VISTARA_TESTS = [
  "Timestamps only. Never an amount, never a category, never a merchant name.",
  "The standard deviation of the gaps between repeats is the entire signal: a tight sigma is a promise kept on a schedule nobody enforced.",
  `Every sigma is rescaled to a ${REFERENCE_CADENCE_DAYS}-day reference cadence, so a 7-day toll rhythm and a 90-day service rhythm are read on one comparable scale.`,
];

/**
 * The cross-domain argument, run through the real engine rather than asserted.
 * Only `consistencyIndex` and `scorable` are read by
 * computeCrossDomainConsistency; the remaining fields are filled with the
 * shape of an ordinary 30-day rhythm so the object satisfies the contract.
 */
const COHERENCE_CASES: { caption: string; indices: number[] }[] = [
  { caption: "Evenly reliable across all five domains", indices: [60, 60, 60, 60, 60] },
  { caption: "Three domains perfect, two broken", indices: [100, 100, 100, 20, 20] },
  { caption: "One domain perfect, four broken", indices: [100, 20, 20, 20, 20] },
];

function illustrativeMetric(
  source: BehaviorSource,
  consistencyIndex: number,
): ConsistencyMetrics {
  return {
    source,
    meanIntervalDays: REFERENCE_CADENCE_DAYS,
    stdDevDays: 3,
    streakLength: 6,
    recoverySpeedDays: 1,
    consistencyIndex,
    expectedIntervalDays: REFERENCE_CADENCE_DAYS,
    baselineIntervalDays: REFERENCE_CADENCE_DAYS,
    normalisedStdDevDays: 3,
    band: "moderate",
    eventCount: 18,
    scorable: true,
    seasonalityAdjusted: false,
    excludedSeasonalGaps: 0,
  };
}

interface CoherenceRow {
  caption: string;
  indices: string;
  arithmetic: string;
  coherence: string;
}

const COHERENCE_ROWS: CoherenceRow[] = COHERENCE_CASES.map((entry) => ({
  caption: entry.caption,
  indices: entry.indices.join(" · "),
  arithmetic: formatScore(mean(entry.indices)),
  coherence: formatScore(
    computeCrossDomainConsistency(
      entry.indices.map((index, i) =>
        illustrativeMetric(BEHAVIOR_ORDER[i % BEHAVIOR_ORDER.length], index),
      ),
    ),
  ),
}));

const COHERENCE_COLUMNS: DataTableColumn<CoherenceRow>[] = [
  { key: "caption", label: "Profile shape", rowHeader: true, width: "38%" },
  { key: "indices", label: "Per-domain index", tabular: true, width: "24%" },
  { key: "arithmetic", label: "Arithmetic mean", align: "right" },
  { key: "coherence", label: "Vistara coherence", align: "right" },
];

/* ================================================================== *
 * The worked example — selected from the cohort, never hard-coded
 * ================================================================== */

interface Exhibit {
  profile: TemporalProfile;
  stream: BehaviorStream;
  metric: ConsistencyMetrics | undefined;
}

/**
 * The comparison is only honest if both people are read on the SAME rhythm, so
 * the source is chosen as the heaviest-weighted one that both a Planner and an
 * Avoider in the cohort actually have. BEHAVIOR_ORDER is weight-descending, so
 * in practice this resolves to the vehicle-service moat.
 */
function pickExhibitSource(): BehaviorSource {
  const groupHas = (archetype: FinancialArchetype, source: BehaviorSource): boolean =>
    DEMO_CUSTOMERS_BY_ARCHETYPE[archetype].some((profile) =>
      profile.streams.some((stream) => stream.source === source),
    );

  for (const source of BEHAVIOR_ORDER) {
    if (groupHas("PLANNER", source) && groupHas("AVOIDER", source)) return source;
  }
  return BEHAVIOR_ORDER[0];
}

/** Tightest rhythm on the left, loosest on the right — the extremes read best. */
function pickExhibit(
  archetype: FinancialArchetype,
  source: BehaviorSource,
  extreme: "tightest" | "loosest",
): Exhibit | undefined {
  const candidates: Exhibit[] = [];
  for (const profile of DEMO_CUSTOMERS_BY_ARCHETYPE[archetype]) {
    const stream = profile.streams.find((entry) => entry.source === source);
    if (stream === undefined) continue;
    candidates.push({
      profile,
      stream,
      metric: profile.metrics.find((entry) => entry.source === source),
    });
  }
  if (candidates.length === 0) return undefined;

  const missing = extreme === "tightest" ? Number.POSITIVE_INFINITY : -1;
  const sigmaOf = (exhibit: Exhibit): number =>
    exhibit.metric === undefined ? missing : exhibit.metric.normalisedStdDevDays;

  return candidates.reduce((best, exhibit) =>
    extreme === "tightest"
      ? sigmaOf(exhibit) < sigmaOf(best)
        ? exhibit
        : best
      : sigmaOf(exhibit) > sigmaOf(best)
        ? exhibit
        : best,
  );
}

function bandPresentation(metric: ConsistencyMetrics | undefined) {
  if (metric === undefined) return undefined;
  return CONSISTENCY_BANDS.find((entry) => entry.band === metric.band);
}

function metricText(
  metric: ConsistencyMetrics | undefined,
  read: (value: ConsistencyMetrics) => string,
): string {
  return metric === undefined ? EM_DASH : read(metric);
}

/** "5 events", but "1 event". */
function formatStreak(streakLength: number): string {
  return `${streakLength} event${streakLength === 1 ? "" : "s"}`;
}

function identityLine(profile: TemporalProfile): string {
  const { occupation, city, age, hasCibilScore, cibilScore } = profile.customer;
  const bureau =
    hasCibilScore && cibilScore !== undefined
      ? `bureau file, CIBIL ${cibilScore}`
      : "no bureau file";
  return `${OCCUPATION_META[occupation].label}, ${city} · age ${age} · ${bureau}`;
}

/* ================================================================== *
 * Tier table
 * ================================================================== *
 * Every figure in this table is read out of TIER_LOAN_CONFIG and
 * TIER_THRESHOLDS at render time. Nothing here is transcribed.
 */

interface TierRow {
  tier: Tier;
}

function scoreBandFor(tier: Tier): string {
  switch (tier) {
    case "PRIME":
      return `${TIER_THRESHOLDS.PRIME}–${SCORE_MAX}`;
    case "NEAR_PRIME":
      return `${TIER_THRESHOLDS.NEAR_PRIME}–${TIER_THRESHOLDS.PRIME - 1}`;
    case "DEVELOPING":
      return `${TIER_THRESHOLDS.DEVELOPING}–${TIER_THRESHOLDS.NEAR_PRIME - 1}`;
    case "THIN_FILE":
      return `${SCORE_MIN}–${TIER_THRESHOLDS.DEVELOPING - 1}`;
  }
}

const TIER_ROWS: TierRow[] = TIER_ORDER.map((tier) => ({ tier }));

const TIER_COLUMNS: DataTableColumn<TierRow>[] = [
  {
    key: "tier",
    label: "Tier",
    rowHeader: true,
    width: "13rem",
    render: (row) => <TierBadge tier={row.tier} size="sm" />,
  },
  {
    key: "band",
    label: "Score",
    align: "right",
    render: (row) => scoreBandFor(row.tier),
  },
  {
    key: "cohort",
    label: "In cohort",
    align: "right",
    render: (row) =>
      String(DEMO_CUSTOMERS.filter((profile) => profile.tier === row.tier).length),
  },
  {
    key: "maxLoan",
    label: "Max ticket",
    align: "right",
    render: (row) => {
      const config = TIER_LOAN_CONFIG[row.tier];
      return config.maxLoanAmount === 0
        ? "Not offered"
        : formatINR(config.maxLoanAmount);
    },
  },
  {
    key: "rate",
    label: "Rate",
    align: "right",
    render: (row) => {
      const config = TIER_LOAN_CONFIG[row.tier];
      return config.interestRate === 0 ? EM_DASH : pct(config.interestRate, 1);
    },
  },
  {
    key: "tenure",
    label: "Tenure",
    align: "right",
    render: (row) => {
      const config = TIER_LOAN_CONFIG[row.tier];
      return config.tenureMonths === 0 ? EM_DASH : `${config.tenureMonths} mo`;
    },
  },
  {
    key: "action",
    label: "Lending action",
    width: "30%",
    render: (row) => COLOR_MAP[row.tier].lendingAction,
  },
];

/* ================================================================== *
 * Small local presentation pieces
 * ================================================================== */

function NeutralChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-vistara-border bg-vistara-border/40 px-2 py-[3px] text-[11px] font-medium text-vistara-text">
      {children}
    </span>
  );
}

function ClaimList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item} className="flex gap-2.5 text-[13px] leading-relaxed">
          <span aria-hidden className="mt-[2px] shrink-0 text-[10px] text-vistara-muted">
            ▸
          </span>
          <span className="text-vistara-muted">{item}</span>
        </li>
      ))}
    </ul>
  );
}

/* ================================================================== *
 * Page
 * ================================================================== */

export default function MethodPage() {
  const windowStart = addDays(REFERENCE_DATE, -OBSERVATION_DAYS);
  const exhibitSource = pickExhibitSource();
  const exhibitMeta = BEHAVIOR_META[exhibitSource];
  const rhythm = pickExhibit("PLANNER", exhibitSource, "tightest");
  const noise = pickExhibit("AVOIDER", exhibitSource, "loosest");

  const heaviestWeight = Math.max(
    ...BEHAVIOR_ORDER.map((source) => BEHAVIOR_WEIGHTS[source]),
  );
  const weightTotal = BEHAVIOR_ORDER.reduce(
    (total, source) => total + BEHAVIOR_WEIGHTS[source],
    0,
  );

  const seasonalOccupations = SEASONAL_OCCUPATIONS.map((occupation) =>
    OCCUPATION_META[occupation].label.toLowerCase(),
  ).join(" and ");

  /* --- the side-by-side comparison, stated in a table as well as drawn --- */

  interface CompareRow {
    label: string;
    left: ReactNode;
    right: ReactNode;
  }

  const compareRows: CompareRow[] =
    rhythm === undefined || noise === undefined
      ? []
      : [
          {
            label: `Events observed (${OBSERVATION_MONTHS} months)`,
            left: String(rhythm.stream.timestamps.length),
            right: String(noise.stream.timestamps.length),
          },
          {
            label: "Mean gap between events",
            left: metricText(rhythm.metric, (m) => formatDays(m.meanIntervalDays, 1)),
            right: metricText(noise.metric, (m) => formatDays(m.meanIntervalDays, 1)),
          },
          {
            label: "Timing sigma, as measured",
            left: metricText(rhythm.metric, (m) => formatSigma(m.stdDevDays)),
            right: metricText(noise.metric, (m) => formatSigma(m.stdDevDays)),
          },
          {
            label: `Sigma rescaled to ${REFERENCE_CADENCE_DAYS}-day cadence`,
            left: metricText(rhythm.metric, (m) => formatSigma(m.normalisedStdDevDays)),
            right: metricText(noise.metric, (m) => formatSigma(m.normalisedStdDevDays)),
          },
          {
            // Pluralised, unlike the pre-5A original: an Avoider's streak is
            // routinely 1, and "1 events" in the judge-facing comparison was a
            // visible copy bug rather than a faithful detail worth preserving.
            label: "Current on-rhythm streak",
            left: metricText(rhythm.metric, (m) => formatStreak(m.streakLength)),
            right: metricText(noise.metric, (m) => formatStreak(m.streakLength)),
          },
          {
            label: "Consistency index, this rhythm",
            left: metricText(rhythm.metric, (m) => `${formatScore(m.consistencyIndex)} / 100`),
            right: metricText(noise.metric, (m) => `${formatScore(m.consistencyIndex)} / 100`),
          },
          {
            label: "Signals scored, whole profile",
            left: `${rhythm.profile.scoredSources.length} of ${BEHAVIOR_ORDER.length}`,
            right: `${noise.profile.scoredSources.length} of ${BEHAVIOR_ORDER.length}`,
          },
          {
            label: "Cross-domain coherence",
            left: `${formatScore(rhythm.profile.crossDomainConsistency)} / 100`,
            right: `${formatScore(noise.profile.crossDomainConsistency)} / 100`,
          },
          {
            label: "Vistara score and tier",
            left: (
              <TierBadge
                tier={rhythm.profile.tier}
                score={rhythm.profile.vistaraScore}
                size="sm"
              />
            ),
            right: (
              <TierBadge
                tier={noise.profile.tier}
                score={noise.profile.vistaraScore}
                size="sm"
              />
            ),
          },
        ];

  const compareColumns: DataTableColumn<CompareRow>[] = [
    { key: "label", label: "Measure", rowHeader: true, width: "40%" },
    {
      key: "left",
      label:
        rhythm === undefined
          ? "Rhythm"
          : `${ARCHETYPE_META.PLANNER.label} · ${rhythm.profile.customer.name}`,
      align: "right",
      render: (row) => row.left,
    },
    {
      key: "right",
      label:
        noise === undefined
          ? "Noise"
          : `${ARCHETYPE_META.AVOIDER.label} · ${noise.profile.customer.name}`,
      align: "right",
      render: (row) => row.right,
    },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-16 px-5 py-12 sm:space-y-20 sm:py-14">
      {/* ── Page heading ──────────────────────────────────────────────── *
          No hero. /method is reached from the landing page, not instead of
          it, so it opens on the same rhythm as every other section here. */}
      <header>
        <SectionHeading
          as="h1"
          size="page"
          eyebrow="Vistara · Temporal Consistency Engine"
          title="How the score works"
          description="Technical detail for the curious judge."
        />

        <p className="tabular mt-4 text-[12px] leading-relaxed text-vistara-muted">
          Every figure below is computed on this page by the engine itself,
          reading a frozen window of {formatDate(windowStart)} to{" "}
          {formatDate(REFERENCE_DATE)} ({OBSERVATION_DAYS} days) ·{" "}
          {DEMO_CUSTOMERS.length} synthetic applicants, generated from a fixed
          seed · no real borrower data.
        </p>
      </header>

      {/* ── 1 · Why this exists ───────────────────────────────────────── */}
      <section aria-labelledby="why-heading">
        <SectionHeading
          as="h2"
          eyebrow="Why this exists"
          title={<span id="why-heading">The market the bureau cannot see</span>}
          description="A file-thin applicant is not a risky applicant; they are an unmeasured one. Vistara's job is to measure them from evidence that already exists."
        />

        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Adults with no credit score"
            value="190M"
            hint="India. Widely cited industry estimate — context, not a Vistara result."
            emphasis
          />
          <StatTile
            label="NBFC applicants declined thin-file"
            value="35–40%"
            hint="Industry estimate; varies by lender, product and geography."
          />
          <StatTile
            label="Timestamp-only signals read"
            value={BEHAVIOR_ORDER.length}
            hint="Engine parameter. Five recurring rhythms, weighted; amounts are never read."
          />
          <StatTile
            label="Months of history read"
            value={OBSERVATION_MONTHS}
            hint={`Engine parameter. ${OBSERVATION_DAYS}-day trailing window ending ${formatDate(REFERENCE_DATE)}.`}
          />
        </div>

        <p className="mt-3 text-[12px] leading-relaxed text-vistara-muted">
          The first two figures are external industry estimates for India&rsquo;s
          credit-invisible population and thin-file decline rates. They frame the
          problem; they are not measurements produced by this prototype. The last
          two are configured parameters of the engine running on this page, and
          every other number on this page is computed from the synthetic cohort.
        </p>
      </section>

      {/* ── 2 · The insight ───────────────────────────────────────────── */}
      <section aria-labelledby="insight-heading">
        <SectionHeading
          as="h2"
          eyebrow="The insight"
          title={<span id="insight-heading">Change the question, not the model</span>}
          description="Alternative-data scoring usually keeps the conventional question and widens the inputs. Vistara replaces the question."
        />

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <Card
            eyebrow="The conventional question"
            title={<span className="text-vistara-muted">&ldquo;What did you do?&rdquo;</span>}
          >
            <ClaimList items={CONVENTIONAL_TESTS} />
            <p className="mt-4 border-t border-vistara-border pt-4 text-[13px] leading-relaxed text-vistara-muted">
              A first-time borrower fails all three tests before the
              conversation starts — not because their behaviour is poor, but
              because none of it was ever written down in the format the
              question demands.
            </p>
          </Card>

          <Card
            eyebrow="Vistara's question"
            title="&ldquo;How consistently do you do everything?&rdquo;"
          >
            <ClaimList items={VISTARA_TESTS} />
            <p className="mt-4 border-t border-vistara-border pt-4 text-[13px] leading-relaxed text-vistara-muted">
              Timing is behavioural evidence that a thin-file applicant already
              generates, in five places at once, without ever having borrowed a
              rupee.
            </p>
          </Card>
        </div>

        <Card
          className="mt-4"
          eyebrow="Cross-domain coherence"
          title="One reliable habit can be coincidence. Reliability across unrelated domains is character."
          description={`So the engine refuses to average. Per-domain indices are combined with a geometric mean and then penalised for dispersion, which means one perfect domain cannot buy off four broken ones. Coherence carries ${pct(CROSS_DOMAIN_WEIGHT * 100, 0)} of the final blend in its own right.`}
        >
          <DataTable
            columns={COHERENCE_COLUMNS}
            rows={COHERENCE_ROWS}
            getRowKey={(row) => row.caption}
            caption="Three hypothetical profiles run through this build's coherence function. An arithmetic mean flatters both split profiles; coherence collapses toward the weakest domain, so only the evenly reliable life scores as one."
          />
        </Card>
      </section>

      {/* ── 3 · The five signals ──────────────────────────────────────── */}
      <section aria-labelledby="signals-heading">
        <SectionHeading
          as="h2"
          eyebrow="The evidence base"
          title={<span id="signals-heading">Five rhythms, one weighted blend</span>}
          description="Each signal is a recurring life event with a known cadence. The weight reflects how hard the rhythm is to fake and how much of it a lender cannot otherwise see."
        />

        <div className="mt-6 overflow-hidden rounded-card border border-vistara-border bg-vistara-surface shadow-card card-sheen">
          {BEHAVIOR_ORDER.map((source, index) => {
            const meta = BEHAVIOR_META[source];
            const weight = BEHAVIOR_WEIGHTS[source];
            const isMoat = source === "vehicle_service";

            return (
              <div
                key={source}
                className={[
                  "grid gap-x-6 gap-y-3 px-5 py-4 sm:grid-cols-[15rem_1fr_9rem] sm:items-start",
                  index < BEHAVIOR_ORDER.length - 1
                    ? "border-b border-vistara-border/70"
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-[14px] font-medium tracking-tight text-vistara-text">
                    <span aria-hidden className="text-[15px] text-vistara-muted">
                      {meta.icon}
                    </span>
                    {meta.label}
                  </p>
                  <p className="tabular mt-1 text-[12px] text-vistara-muted">
                    Expected every {meta.expectedIntervalDays} days
                  </p>
                  {isMoat ? (
                    <p className="mt-2">
                      <NeutralChip>TVS-exclusive moat</NeutralChip>
                    </p>
                  ) : null}
                </div>

                <p className="text-[13px] leading-relaxed text-vistara-muted">
                  {SIGNAL_INSIGHT[source]}
                  {isMoat ? (
                    <span className="text-vistara-text">
                      {" "}
                      Only TVS Credit holds dealer-recorded service dates: a
                      physical-world rhythm that cannot be back-filled after the
                      application is made.
                    </span>
                  ) : null}
                </p>

                <div className="sm:pt-0.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[11px] uppercase tracking-[0.14em] text-vistara-muted">
                      Weight
                    </span>
                    <span className="tabular text-[13px] font-medium text-vistara-text">
                      {pct(weight * 100, 0)}
                    </span>
                  </div>
                  <Meter
                    className="mt-2"
                    value={weight}
                    max={heaviestWeight}
                    ariaLabel={`${meta.label} weight ${pct(weight * 100, 0)} of the blend`}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <p className="mt-3 text-[12px] leading-relaxed text-vistara-muted">
          {`Weights sum to ${pct(weightTotal * 100, 0)}.`} Bar length shows each
          weight against the heaviest signal. When a
          signal is unavailable the remaining weights are renormalised over what
          was actually observed, so an applicant is never docked for evidence
          that does not exist.
        </p>
      </section>

      {/* ── 4 · The worked example ────────────────────────────────────── */}
      <section aria-labelledby="example-heading">
        <SectionHeading
          as="h2"
          eyebrow="Worked example · same signal, two people"
          title={
            <span id="example-heading">
              A kept rhythm and a broken one, read from timestamps alone
            </span>
          }
          description={`Both strips below plot the same behaviour — ${exhibitMeta.short}, expected every ${exhibitMeta.expectedIntervalDays} days — over the trailing ${OBSERVATION_MONTHS} months. No amount is plotted, because no amount is read. The difference a lender needs is visible before a single number is quoted.`}
        />

        {rhythm === undefined || noise === undefined ? (
          <Card className="mt-6">
            <p className="text-[13px] leading-relaxed text-vistara-muted">
              The synthetic cohort currently contains no Planner and Avoider pair
              sharing a single behaviour, so the side-by-side comparison is not
              shown. Individual profiles remain readable from the applicant list.
            </p>
            <div className="mt-4">
              <Button href="/apply" variant="secondary" size="sm">
                Open the applicant list
              </Button>
            </div>
          </Card>
        ) : (
          <>
            <div className="mt-6 grid gap-4 lg:grid-cols-2">
              {[rhythm, noise].map((exhibit) => {
                const band = bandPresentation(exhibit.metric);
                const archetypeMeta = ARCHETYPE_META[exhibit.profile.financialArchetype];

                return (
                  <Card
                    key={exhibit.profile.customer.id}
                    eyebrow={`${archetypeMeta.label} · synthetic profile`}
                    title={exhibit.profile.customer.name}
                    description={identityLine(exhibit.profile)}
                    action={
                      <TierBadge
                        tier={exhibit.profile.tier}
                        score={exhibit.profile.vistaraScore}
                        size="sm"
                      />
                    }
                  >
                    <EventStrip
                      stream={exhibit.stream}
                      expectedIntervalDays={
                        exhibit.metric === undefined
                          ? exhibitMeta.expectedIntervalDays
                          : exhibit.metric.expectedIntervalDays
                      }
                      forgivenGapIndices={exhibit.metric?.excludedGapIndices}
                    />

                    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-vistara-border pt-4">
                      {band === undefined ? null : (
                        <Badge color={band.color} icon={band.icon} label={band.label} />
                      )}
                      <span className="tabular text-[12px] text-vistara-muted">
                        {metricText(exhibit.metric, (m) => formatSigma(m.stdDevDays))} measured ·{" "}
                        {metricText(
                          exhibit.metric,
                          (m) => formatSigma(m.normalisedStdDevDays),
                        )}{" "}
                        normalised · index{" "}
                        {metricText(exhibit.metric, (m) => formatScore(m.consistencyIndex))}
                        /100
                      </span>
                    </div>

                    <p className="mt-3 text-[13px] leading-relaxed text-vistara-muted">
                      {archetypeMeta.blurb}
                    </p>
                  </Card>
                );
              })}
            </div>

            <Card className="mt-4" padded={false}>
              <div className="p-5 sm:p-6">
                <DataTable
                  columns={compareColumns}
                  rows={compareRows}
                  getRowKey={(row) => row.label}
                  caption={`The same two people, stated rather than drawn. The first six measures read the ${exhibitMeta.short} stream only; the last three read the whole profile across all ${BEHAVIOR_ORDER.length} signals. A stream needs at least ${MIN_EVENTS_TO_SCORE} events before Vistara will claim a rhythm exists.`}
                />
              </div>
            </Card>
          </>
        )}
      </section>

      {/* ── 5 · The two hard cases ────────────────────────────────────── *
          The reason this page exists. Prose preserved verbatim from the
          pre-5A page — these are the two objections a judge asks first, and
          the answers only count if they are stated in full. */}
      <section aria-labelledby="hard-cases-heading">
        <SectionHeading
          as="h2"
          eyebrow="Where a timing model can go wrong"
          title={<span id="hard-cases-heading">The two objections, answered in the engine</span>}
          description="Both of these are ways a consistency model could quietly harm the exact customer it claims to serve, so both are handled in code rather than in the pitch."
        />

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <Card eyebrow="Objection one" title="The moat does not exist for a first-time buyer">
            <p className="text-[13px] leading-relaxed text-vistara-muted">
              A first vehicle purchase means no service history at all — and that
              is precisely the applicant in the brief. An absent signal is
              recorded as absent, never imputed: the remaining weights are
              renormalised over what was observed, and the scorecard prints how
              many of the {BEHAVIOR_ORDER.length} signals it actually stood on.
              Below {MIN_STREAMS_TO_SCORE} observed rhythms the applicant is
              reported as {COLOR_MAP.THIN_FILE.label} rather than scored,
              because &ldquo;we could not observe enough&rdquo; and &ldquo;we
              observed it and it is poor&rdquo; deserve different products.
            </p>
            <p className="mt-4 border-t border-vistara-border pt-4 text-[13px] leading-relaxed text-vistara-muted">
              <span className="text-vistara-text">
                {`The offer instead: “${COVERAGE_ACTIONS.vehicle_service.title}”`}
              </span>{" "}
              — a rhythm-building path with a re-score in{" "}
              {COVERAGE_ACTIONS.vehicle_service.horizonMonths} months, not a
              decline letter.
            </p>
          </Card>

          <Card eyebrow="Objection two" title="Regularity is not the same as uniformity">
            <p className="text-[13px] leading-relaxed text-vistara-muted">
              A rice farmer services in February and August, not every 90 days.
              Scoring that as irregularity would penalise the cyclical incomes
              this product exists to serve. For {seasonalOccupations} profiles,
              at most {MAX_SEASONAL_EXCLUSIONS} gaps that fall inside two
              declared windows may be excluded before sigma is measured.
            </p>
            <ul className="mt-3 space-y-1.5">
              {SEASONAL_WINDOWS.map((window) => (
                <li key={window.label} className="text-[13px] text-vistara-muted">
                  <span aria-hidden className="mr-2 text-[10px]">
                    ▸
                  </span>
                  {window.label}
                </li>
              ))}
            </ul>
            <p className="mt-4 border-t border-vistara-border pt-4 text-[13px] leading-relaxed text-vistara-muted">
              It is capped, it is auditable, it applies only to occupations whose
              income is genuinely cyclical, and it is disclosed on every
              scorecard that used it. It is not a general-purpose way to make bad
              rhythm look good.
            </p>
          </Card>
        </div>
      </section>

      {/* ── 6 · The tiers ─────────────────────────────────────────────── */}
      <section aria-labelledby="tiers-heading">
        <SectionHeading
          as="h2"
          eyebrow="The decision"
          title={<span id="tiers-heading">From rhythm to a lending action</span>}
          description={`A score is only useful if it names the next step. The ${SCORE_MIN}–${SCORE_MAX} range maps onto four tiers, each with a configured ticket, rate, tenure and instruction to the officer.`}
        />

        <Card className="mt-6" padded={false}>
          <div className="p-5 sm:p-6">
            <DataTable
              columns={TIER_COLUMNS}
              rows={TIER_ROWS}
              getRowKey={(row) => row.tier}
              caption={`Tier bands, offers and lending actions as configured in this build. "In cohort" counts the ${DEMO_CUSTOMERS.length} synthetic applicants currently falling in each tier.`}
            />
          </div>
        </Card>

        <p className="mt-3 text-[12px] leading-relaxed text-vistara-muted">
          {COLOR_MAP.THIN_FILE.label} is also reached independently of the score:
          fewer than {MIN_STREAMS_TO_SCORE} observed rhythms means there is not
          enough evidence to form a view, whatever the arithmetic says. Ticket
          sizes, rates and tenures are this prototype&rsquo;s configured
          illustration of the policy, not a TVS Credit product offer.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-vistara-border pt-8">
          <Button href="/apply/live">Score an applicant</Button>
          <Button href="/dashboard" variant="secondary">
            Loan officer dashboard
          </Button>
          <span className="text-[12px] leading-relaxed text-vistara-muted">
            {DEMO_CUSTOMERS.length} synthetic profiles across{" "}
            {Object.keys(ARCHETYPE_META).length} behavioural archetypes, all
            generated from a fixed seed against a frozen reference date.
          </span>
        </div>
      </section>
    </div>
  );
}
