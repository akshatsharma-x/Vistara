/**
 * Vistara — loan-officer dashboard (dealer desk).
 *
 * The operational view: a queue an officer works top to bottom, plus the two
 * panels that say how much of the queue the engine can actually see. Every
 * figure on this page is derived from DEMO_CUSTOMERS at module scope — nothing
 * is hardcoded, nothing reads the clock, so the numbers are identical on the
 * server and in the browser for every render of the demo.
 *
 * Server Component: no state, no hover-only readings, no client bundle.
 */

import Link from "next/link";

import {
  ARCHETYPE_META,
  BEHAVIOR_META,
  BEHAVIOR_ORDER,
  BEHAVIOR_WEIGHTS,
  CHART_INK,
  COLOR_MAP,
  CONSISTENCY_BANDS,
  MIN_EVENTS_TO_SCORE,
  OBSERVATION_DAYS,
  OBSERVATION_MONTHS,
  OCCUPATION_META,
  RAMP,
  SCORE_MAX,
  SCORE_MIN,
  TIER_LOAN_CONFIG,
  TIER_ORDER,
} from "@/lib/constants";
import {
  formatDate,
  formatDays,
  formatINR,
  formatScore,
  formatSigma,
  ordinalDay,
  pct,
} from "@/lib/format";
import { REFERENCE_DATE, addDays, clamp, mean } from "@/lib/rng";
import { DEMO_CUSTOMERS } from "@/lib/synthetic-data";
import type {
  BehaviorSource,
  ConsistencyMetrics,
  TemporalProfile,
  Tier,
} from "@/lib/types";
import {
  Badge,
  Card,
  DataTable,
  Meter,
  SectionHeading,
  StatTile,
  TierBadge,
} from "@/components/ui";
import type { DataTableColumn } from "@/components/ui";

/* ================================================================== *
 * Cohort aggregates — computed once, from the data layer only
 * ================================================================== */

const COHORT_SIZE = DEMO_CUSTOMERS.length;

const WINDOW_START = addDays(REFERENCE_DATE, -OBSERVATION_DAYS);

/**
 * Deterministic ordering. Scores are distinct across the demo cohort, so the id
 * tie-break never fires — it is here because `localeCompare` resolves against
 * host ICU data and a queue that reorders between the server and the client
 * pass is a hydration mismatch.
 */
const QUEUE: TemporalProfile[] = [...DEMO_CUSTOMERS].sort((a, b) => {
  if (b.vistaraScore !== a.vistaraScore) return b.vistaraScore - a.vistaraScore;
  return a.customer.id < b.customer.id ? -1 : 1;
});

const APPROVABLE = QUEUE.filter((profile) => profile.tier !== "THIN_FILE");
const APPROVABLE_SHARE = (APPROVABLE.length / COHORT_SIZE) * 100;

const SCORES = QUEUE.map((profile) => profile.vistaraScore);
const MEAN_SCORE = Math.round(mean(SCORES));
const LOWEST_SCORE = SCORES.reduce((low, score) => Math.min(low, score), SCORES[0]);
const HIGHEST_SCORE = SCORES.reduce((high, score) => Math.max(high, score), SCORES[0]);

const NO_BUREAU = QUEUE.filter((profile) => !profile.customer.hasCibilScore);
const NO_BUREAU_SHARE = (NO_BUREAU.length / COHORT_SIZE) * 100;

const THIN_FILE_COUNT = COHORT_SIZE - APPROVABLE.length;

interface TierRow {
  tier: Tier;
  count: number;
  share: number;
}

const TIER_ROWS: TierRow[] = TIER_ORDER.map((tier) => {
  const count = QUEUE.filter((profile) => profile.tier === tier).length;
  return { tier, count, share: (count / COHORT_SIZE) * 100 };
});

interface CoverageRow {
  source: BehaviorSource;
  /** Applicants whose stream is present AND has enough events to score. */
  scorable: number;
  /** Applicants with no record of this behaviour at all. */
  absent: number;
  /** Applicants who have the stream but sit under the event floor. */
  tooThin: number;
}

const COVERAGE_ROWS: CoverageRow[] = BEHAVIOR_ORDER.map((source) => {
  let scorable = 0;
  let absent = 0;
  let tooThin = 0;

  for (const profile of QUEUE) {
    const metric = profile.metrics.find((entry) => entry.source === source);
    if (metric === undefined) {
      absent += 1;
    } else if (metric.scorable) {
      scorable += 1;
    } else {
      tooThin += 1;
    }
  }

  return { source, scorable, absent, tooThin };
});

const COVERAGE_POSSIBLE = COHORT_SIZE * BEHAVIOR_ORDER.length;
const COVERAGE_SCORABLE = COVERAGE_ROWS.reduce(
  (sum, row) => sum + row.scorable,
  0,
);

/** The column where the evidence base is thinnest, whatever it turns out to be. */
const THINNEST_COVERAGE = COVERAGE_ROWS.reduce(
  (low, row) => (row.scorable < low.scorable ? row : low),
  COVERAGE_ROWS[0],
);

/** The heaviest-weighted behaviour, read off the weights rather than assumed. */
const HEAVIEST_SOURCE = BEHAVIOR_ORDER.reduce((heaviest, source) =>
  BEHAVIOR_WEIGHTS[source] > BEHAVIOR_WEIGHTS[heaviest] ? source : heaviest,
);
const HEAVIEST_COVERAGE = COVERAGE_ROWS.reduce(
  (found, row) => (row.source === HEAVIEST_SOURCE ? row : found),
  COVERAGE_ROWS[0],
);

/* ================================================================== *
 * Tier distribution — magnitude across an ORDERED set of categories,
 * so: horizontal bars, single-hue ramp walked along the tier order.
 * ================================================================== *
 * Percentage x-coordinates inside an SVG with no viewBox: the chart is fluid
 * while hairlines stay 1px, the data-end radius stays 4px and text stays at its
 * real size. Bar length encodes the count against a fixed 0..cohort domain, so
 * a short bar still reads as a share of the queue.
 */

const LABEL_PCT = 32;
const GUTTER_PCT = 14;
const PLOT_PCT = 100 - LABEL_PCT - GUTTER_PCT;

const ROW_H = 34;
const BAR_H = 10;
const BAR_OFFSET = 11;
const AXIS_H = 20;
const TICK_DIVISIONS = 4;

/**
 * The ramp is walked along the tier order (Prime -> Thin File), bright to dim:
 * on a dark plane the darkest steps recede into the surface, so the darkest
 * ramp step is left out. The tier's own risk-state token never encodes
 * magnitude — it rides the row label as glyph + words, as it does everywhere
 * else in the app.
 */
const TIER_STEPS = [RAMP[0], RAMP[1], RAMP[2], RAMP[3]] as const;

function tierStep(index: number): string {
  return TIER_STEPS[clamp(index, 0, TIER_STEPS.length - 1)];
}

const AXIS_TICKS: number[] = Array.from(
  { length: TICK_DIVISIONS + 1 },
  (_, i) => (COHORT_SIZE * i) / TICK_DIVISIONS,
);

function tickLabel(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

const plotX = (value: number): string =>
  `${(LABEL_PCT + (clamp(value / COHORT_SIZE, 0, 1)) * PLOT_PCT).toFixed(3)}%`;

function TierDistributionChart() {
  const plotH = TIER_ROWS.length * ROW_H;
  const height = plotH + AXIS_H;

  const summary = TIER_ROWS.map(
    (row) =>
      `${COLOR_MAP[row.tier].label} ${row.count} of ${COHORT_SIZE} applicants, ${Math.round(row.share)} percent`,
  ).join("; ");

  return (
    <div
      role="img"
      aria-label={`Applicants by Vistara tier. ${summary}.`}
      className="mt-1"
    >
      <svg
        width="100%"
        height={height}
        className="block overflow-visible"
        aria-hidden
        focusable="false"
      >
        {/* Recessive chrome: solid hairlines one shade off the surface. */}
        {AXIS_TICKS.map((tick) => (
          <line
            key={`grid-${tick}`}
            x1={plotX(tick)}
            x2={plotX(tick)}
            y1={0}
            y2={plotH}
            stroke={tick === 0 ? CHART_INK.axis : CHART_INK.gridline}
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
        ))}
        <line
          x1={plotX(0)}
          x2={plotX(COHORT_SIZE)}
          y1={plotH}
          y2={plotH}
          stroke={CHART_INK.axis}
          strokeWidth={1}
          shapeRendering="crispEdges"
        />

        {TIER_ROWS.map((row, rowIndex) => {
          const top = rowIndex * ROW_H;
          const presentation = COLOR_MAP[row.tier];
          const fill = tierStep(rowIndex);
          const barWidth = (row.count / COHORT_SIZE) * PLOT_PCT;

          return (
            <g key={row.tier}>
              <text
                x={0}
                y={top + BAR_OFFSET + 9}
                className="text-[12px]"
                fill={CHART_INK.primary}
              >
                <tspan aria-hidden fill={presentation.color}>
                  {presentation.icon}
                </tspan>
                <tspan dx={6}>{presentation.label}</tspan>
              </text>

              {/* Full-domain track: the row is a share of the whole queue. */}
              <rect
                x={plotX(0)}
                y={top + BAR_OFFSET}
                width={`${PLOT_PCT}%`}
                height={BAR_H}
                rx={4}
                fill={CHART_INK.gridline}
              />

              {row.count > 0 ? (
                <>
                  <rect
                    x={plotX(0)}
                    y={top + BAR_OFFSET}
                    width={`${barWidth.toFixed(3)}%`}
                    height={BAR_H}
                    rx={4}
                    fill={fill}
                  />
                  {/* Squares the baseline end; the data-end keeps its 4px. */}
                  <rect
                    x={plotX(0)}
                    y={top + BAR_OFFSET}
                    width={5}
                    height={BAR_H}
                    fill={fill}
                  />
                </>
              ) : null}

              {/* Direct label at the data end — four rows, four readings. */}
              <text
                x={plotX(row.count)}
                dx={8}
                y={top + BAR_OFFSET + 9}
                className="tabular text-[11px]"
                fill={CHART_INK.secondary}
              >
                {row.count}
                <tspan dx={4} fill={CHART_INK.muted}>
                  {pct(row.share)}
                </tspan>
              </text>
            </g>
          );
        })}

        {AXIS_TICKS.map((tick) => (
          <text
            key={`tick-${tick}`}
            x={plotX(tick)}
            y={plotH + 14}
            textAnchor="middle"
            className="tabular text-[10px]"
            fill={CHART_INK.muted}
          >
            {tickLabel(tick)}
          </text>
        ))}
      </svg>
    </div>
  );
}

const TIER_TWIN_COLUMNS: DataTableColumn<TierRow>[] = [
  {
    key: "tier",
    label: "Tier",
    width: "32%",
    rowHeader: true,
    render: (row) => <TierBadge tier={row.tier} size="sm" />,
  },
  {
    key: "count",
    label: "Files",
    align: "right",
    width: "12%",
    render: (row) => row.count,
  },
  {
    key: "share",
    label: "Share",
    align: "right",
    width: "14%",
    render: (row) => pct(row.share),
  },
  {
    key: "action",
    label: "Standing instruction",
    width: "42%",
    render: (row) => (
      <span className="text-[12px] leading-relaxed text-vistara-muted">
        {COLOR_MAP[row.tier].lendingAction}
      </span>
    ),
  },
];

/* ================================================================== *
 * Applicant queue
 * ================================================================== */

const QUEUE_COLUMNS: DataTableColumn<TemporalProfile>[] = [
  {
    key: "applicant",
    label: "Applicant",
    width: "17%",
    rowHeader: true,
    render: (profile) => (
      <>
        <span className="block leading-tight">{profile.customer.name}</span>
        <span className="mt-0.5 block text-[11px] font-normal leading-tight text-vistara-muted">
          {profile.customer.city} · {ARCHETYPE_META[profile.financialArchetype].label}
        </span>
      </>
    ),
  },
  {
    key: "occupation",
    label: "Occupation",
    width: "11%",
    render: (profile) => (
      <span className="text-vistara-muted">
        {OCCUPATION_META[profile.customer.occupation].label}
      </span>
    ),
  },
  {
    key: "income",
    label: "Income / mo",
    align: "right",
    width: "10%",
    render: (profile) => formatINR(profile.customer.monthlyIncome),
  },
  {
    key: "cibil",
    label: "CIBIL",
    align: "right",
    width: "7%",
    render: (profile) =>
      profile.customer.cibilScore === undefined ? (
        <span className="text-vistara-muted">None</span>
      ) : (
        formatScore(profile.customer.cibilScore)
      ),
  },
  {
    key: "score",
    label: "Vistara",
    align: "right",
    width: "9%",
    render: (profile) => (
      <>
        <span className="block font-semibold leading-tight">
          {formatScore(profile.vistaraScore)}
        </span>
        <span className="mt-0.5 block text-[11px] leading-tight text-vistara-muted">
          {profile.scoredSources.length} of {BEHAVIOR_ORDER.length} signals
        </span>
      </>
    ),
  },
  {
    key: "tier",
    label: "Tier",
    width: "11%",
    tabular: false,
    render: (profile) => <TierBadge tier={profile.tier} size="sm" />,
  },
  {
    key: "cross",
    label: "Cross-domain",
    align: "right",
    width: "9%",
    render: (profile) => pct(profile.crossDomainConsistency),
  },
  {
    key: "emi",
    label: "EMI date",
    align: "right",
    width: "8%",
    render: (profile) => (
      <span
        className={
          profile.tier === "THIN_FILE" ? "text-vistara-muted" : undefined
        }
      >
        {ordinalDay(profile.recommendedEmiDate)}
      </span>
    ),
  },
  {
    key: "product",
    label: "Recommended product",
    align: "right",
    width: "13%",
    render: (profile) => {
      const config = TIER_LOAN_CONFIG[profile.tier];

      if (config.maxLoanAmount === 0) {
        return (
          <>
            <span className="block leading-tight text-vistara-muted">
              No offer yet
            </span>
            <span className="mt-0.5 block text-[11px] leading-tight text-vistara-muted">
              Rhythm-building path
            </span>
          </>
        );
      }

      return (
        <>
          <span className="block leading-tight">
            {formatINR(config.maxLoanAmount)}
          </span>
          <span className="mt-0.5 block text-[11px] leading-tight text-vistara-muted">
            {pct(config.interestRate, 1)} · {config.tenureMonths} mo
          </span>
        </>
      );
    },
  },
  {
    key: "open",
    label: "File",
    align: "right",
    width: "5%",
    tabular: false,
    render: (profile) => (
      <Link
        href={`/score?id=${profile.customer.id}`}
        aria-label={`Open the scorecard for ${profile.customer.name}`}
        className="-my-1 inline-flex min-h-[24px] items-center rounded-md px-2 py-1 text-[12px] text-vistara-accent transition-colors hover:bg-vistara-border/50"
      >
        Open
        <span aria-hidden className="ml-1.5 text-[10px]">
          ▸
        </span>
      </Link>
    ),
  },
];

/* ================================================================== *
 * "Why this applicant scores what they score" — top of the queue
 * ================================================================== */

const TOP = QUEUE[0];

/**
 * Ranked on the consistency index, with normalised sigma as the tie-break: two
 * rhythms can both round to 100, and only the cadence-normalised sigma is
 * comparable across a 7-day and a 90-day behaviour. Third key is the canonical
 * behaviour order, so the ranking is total and stable.
 */
const TOP_RANKED: ConsistencyMetrics[] = TOP.metrics
  .filter((metric) => metric.scorable)
  .slice()
  .sort((a, b) => {
    if (b.consistencyIndex !== a.consistencyIndex) {
      return b.consistencyIndex - a.consistencyIndex;
    }
    if (a.normalisedStdDevDays !== b.normalisedStdDevDays) {
      return a.normalisedStdDevDays - b.normalisedStdDevDays;
    }
    return (
      BEHAVIOR_ORDER.indexOf(a.source) - BEHAVIOR_ORDER.indexOf(b.source)
    );
  });

const TOP_STRONGEST = TOP_RANKED.slice(0, Math.min(2, TOP_RANKED.length));
const TOP_WEAKEST = TOP_RANKED.slice(
  Math.max(TOP_STRONGEST.length, TOP_RANKED.length - 2),
)
  .slice()
  .reverse();

/** Sources with no record at all, versus present-but-under-the-event-floor. */
const TOP_ABSENT: BehaviorSource[] = BEHAVIOR_ORDER.filter(
  (source) => !TOP.metrics.some((metric) => metric.source === source),
);
const TOP_TOO_THIN: BehaviorSource[] = TOP.metrics
  .filter((metric) => !metric.scorable)
  .map((metric) => metric.source);

const TOP_ABSENT_WEIGHT = [...TOP_ABSENT, ...TOP_TOO_THIN].reduce(
  (sum, source) => sum + BEHAVIOR_WEIGHTS[source],
  0,
);

function bandTokens(band: ConsistencyMetrics["band"]) {
  const found = CONSISTENCY_BANDS.find((entry) => entry.band === band);
  return found ?? CONSISTENCY_BANDS[CONSISTENCY_BANDS.length - 1];
}

function sourceList(sources: BehaviorSource[]): string {
  const labels = sources.map((source) => BEHAVIOR_META[source].short);
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

interface FactorLineProps {
  metric: ConsistencyMetrics;
  profile: TemporalProfile;
}

function FactorLine({ metric, profile }: FactorLineProps) {
  const meta = BEHAVIOR_META[metric.source];
  const band = bandTokens(metric.band);
  const factor = profile.factors.find((entry) => entry.source === metric.source);

  return (
    <li className="border-b border-vistara-border/60 py-3 last:border-b-0 last:pb-0">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[13px] font-medium text-vistara-text">
          <span aria-hidden className="mr-2 text-vistara-muted">
            {meta.icon}
          </span>
          {meta.short}
        </p>
        <Badge color={band.color} icon={band.icon} label={band.label} />
      </div>

      <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-vistara-muted">
        <div className="flex gap-1.5">
          <dt>Index</dt>
          <dd className="tabular text-vistara-text">
            {formatScore(metric.consistencyIndex)}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt>Drift</dt>
          <dd className="tabular text-vistara-text">
            {formatSigma(metric.stdDevDays)}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt>On a 30-day cadence</dt>
          <dd className="tabular text-vistara-text">
            {formatDays(metric.normalisedStdDevDays)}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt>Streak</dt>
          <dd className="tabular text-vistara-text">
            {metric.streakLength} of {metric.eventCount} events
          </dd>
        </div>
        {factor === undefined ? null : (
          <div className="flex gap-1.5">
            <dt>Points</dt>
            <dd className="tabular text-vistara-text">
              {formatScore(factor.points)} at weight {pct(factor.weight * 100)}
            </dd>
          </div>
        )}
      </dl>
    </li>
  );
}

/* ================================================================== *
 * Page
 * ================================================================== */

/**
 * The worst band present in a set, read off CONSISTENCY_BANDS order rather than
 * off the index: the band is keyed to normalised sigma, so the lowest index is
 * not automatically the lowest band.
 */
function worstBandLabel(metrics: ConsistencyMetrics[]): string {
  const severity = (metric: ConsistencyMetrics): number =>
    CONSISTENCY_BANDS.findIndex((entry) => entry.band === metric.band);
  const worst = metrics.reduce(
    (low, metric) => (severity(metric) > severity(low) ? metric : low),
    metrics[0],
  );
  return bandTokens(worst.band).label.toLowerCase();
}

export default function DashboardPage() {
  const weakestAllTight =
    TOP_WEAKEST.length > 0 &&
    TOP_WEAKEST.every(
      (metric) => metric.band === "exceptional" || metric.band === "strong",
    );
  const weakestNote = weakestAllTight
    ? `Even the lowest-ranked rhythms here band ${worstBandLabel(TOP_WEAKEST)} or better. Nothing in this file is loose — the score sits ${SCORE_MAX - TOP.vistaraScore} points off the top of the ${SCORE_MIN}–${SCORE_MAX} range.`
    : `These carry the least weight-adjusted contribution in the file${TOP_WEAKEST.length === 0 ? "" : `, and ${BEHAVIOR_META[TOP_WEAKEST[0].source].short} is where the largest remaining gain sits`}.`;

  return (
    <div className="mx-auto max-w-6xl px-5 py-10 sm:py-12">
      <SectionHeading
        as="h1"
        size="page"
        eyebrow="Dealer desk · underwriting queue"
        title="Loan officer dashboard"
        description={`${COHORT_SIZE} live applications, scored on timestamps alone. Observation window ${formatDate(WINDOW_START)} to ${formatDate(REFERENCE_DATE)} — ${OBSERVATION_MONTHS} months of recurring life events, no amounts and no categories. Synthetic cohort from a fixed seed: the same file always returns the same score.`}
      />

      {/* ── KPI row ──────────────────────────────────────────────────── */}
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Applicants in queue"
          value={COHORT_SIZE}
          emphasis
          hint={`Scores span ${formatScore(LOWEST_SCORE)} to ${formatScore(HIGHEST_SCORE)}.`}
        />
        <StatTile
          label="Approvable share"
          value={pct(APPROVABLE_SHARE)}
          hint={`${APPROVABLE.length} of ${COHORT_SIZE} files clear the Thin File boundary and carry a product recommendation today.`}
        />
        <StatTile
          label="Mean Vistara score"
          value={formatScore(MEAN_SCORE)}
          hint={`Unweighted mean across all ${COHORT_SIZE} files, including the ${THIN_FILE_COUNT} that do not yet clear the lending floor.`}
        />
        <StatTile
          label="No bureau record"
          value={NO_BUREAU.length}
          hint={`${pct(NO_BUREAU_SHARE)} of the queue has no CIBIL score at all — invisible to conventional underwriting, fully readable here.`}
        />
      </div>

      {/* ── Queue ────────────────────────────────────────────────────── */}
      <section className="mt-10">
        <Card
          eyebrow="Applicant queue"
          title="Ranked by Vistara score"
          description="Cross-domain is the coherence index across every rhythm observed for that applicant — the figure that separates one lucky habit from character. EMI date is aligned to the applicant's own cash-flow rhythm, not to the dealer's billing cycle. Products come straight from the tier's standing configuration."
        >
          <DataTable
            columns={QUEUE_COLUMNS}
            rows={QUEUE}
            getRowKey={(profile) => profile.customer.id}
            caption={`${COHORT_SIZE} applicants sorted by Vistara score, highest first. The CIBIL column reads "None" where no bureau record exists.`}
            captionHidden
            dense
            /* Ten columns need room: below this the table scrolls sideways
               inside its own region rather than crushing every cell. */
            className="[&_table]:min-w-[62rem]"
          />
        </Card>
      </section>

      {/* ── Portfolio shape ──────────────────────────────────────────── */}
      <section className="mt-10 grid gap-4 lg:grid-cols-2">
        <Card
          eyebrow="Portfolio shape"
          title="Applicants by tier"
          description="Bar length is the count against the full queue; the ramp runs along the tier order. The tier's own status colour stays on its label, where it always sits with its glyph and its name."
        >
          <TierDistributionChart />

          <div className="mt-5 border-t border-vistara-border pt-4">
            <DataTable
              columns={TIER_TWIN_COLUMNS}
              rows={TIER_ROWS}
              getRowKey={(row) => row.tier}
              caption="Applicants by Vistara tier, with the standing instruction for each tier."
              captionHidden
              dense
              className="[&_table]:min-w-[24rem]"
            />
          </div>
        </Card>

        <Card
          eyebrow="Data honesty"
          title="Signal coverage"
          description={`How many of the ${COHORT_SIZE} files carry a readable rhythm for each behaviour. A stream needs ${MIN_EVENTS_TO_SCORE} events before the engine will claim a rhythm exists; anything short of that is excluded from the score rather than imputed, and the remaining weights are renormalised.`}
        >
          <ul className="mt-1 space-y-4">
            {COVERAGE_ROWS.map((row) => {
              const meta = BEHAVIOR_META[row.source];

              return (
                <li key={row.source}>
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-[13px] text-vistara-text">
                      <span aria-hidden className="mr-2 text-vistara-muted">
                        {meta.icon}
                      </span>
                      {meta.short}
                      <span className="ml-2 text-[11px] text-vistara-muted">
                        every {meta.expectedIntervalDays}d · weight{" "}
                        {pct(BEHAVIOR_WEIGHTS[row.source] * 100)}
                      </span>
                    </p>
                    <p className="tabular shrink-0 text-[13px] text-vistara-text">
                      {row.scorable}
                      <span className="text-vistara-muted"> / {COHORT_SIZE}</span>
                    </p>
                  </div>

                  <Meter
                    value={row.scorable}
                    max={COHORT_SIZE}
                    className="mt-2"
                    ariaLabel={`${meta.short}: ${row.scorable} of ${COHORT_SIZE} applicants have a scorable stream`}
                  />

                  <p className="mt-1.5 text-[11px] leading-relaxed text-vistara-muted">
                    {row.absent} with no record on file · {row.tooThin} under the{" "}
                    {MIN_EVENTS_TO_SCORE}-event floor
                  </p>
                </li>
              );
            })}
          </ul>

          <p className="mt-5 border-t border-vistara-border pt-4 text-[12px] leading-relaxed text-vistara-muted">
            {COVERAGE_SCORABLE} of {COVERAGE_POSSIBLE} possible streams are
            readable across the queue ({pct((COVERAGE_SCORABLE / COVERAGE_POSSIBLE) * 100)}).
            The evidence base is thinnest on{" "}
            {BEHAVIOR_META[THINNEST_COVERAGE.source].short} at{" "}
            {THINNEST_COVERAGE.scorable} of {COHORT_SIZE}.{" "}
            {BEHAVIOR_META[HEAVIEST_SOURCE].short} carries the heaviest weight at{" "}
            {pct(BEHAVIOR_WEIGHTS[HEAVIEST_SOURCE] * 100)} and is readable on{" "}
            {HEAVIEST_COVERAGE.scorable} of {COHORT_SIZE}
            {HEAVIEST_SOURCE === "vehicle_service"
              ? " — the one column no other lender holds, which is why an absent service history is treated as a coverage gap to close rather than a rhythm to assume."
              : "."}
          </p>
        </Card>
      </section>

      {/* ── Top-of-queue explanation ─────────────────────────────────── */}
      <section className="mt-10">
        <Card
          eyebrow="Adjudication note"
          title={`Why ${TOP.customer.name} scores ${formatScore(TOP.vistaraScore)}`}
          description="Ranked on the per-behaviour consistency index; ties break on sigma restated at a 30-day cadence, the only drift figure comparable across a weekly and a quarterly rhythm."
          action={<TierBadge tier={TOP.tier} score={TOP.vistaraScore} size="md" />}
        >
          <div className="grid gap-6 lg:grid-cols-[minmax(0,15rem)_1fr]">
            <dl className="space-y-3 text-[13px]">
              {[
                {
                  term: "Archetype",
                  value: ARCHETYPE_META[TOP.financialArchetype].label,
                  numeric: false,
                },
                {
                  term: "Cross-domain coherence",
                  value: pct(TOP.crossDomainConsistency),
                  numeric: true,
                },
                {
                  term: "Signals scored",
                  value: `${TOP.scoredSources.length} of ${BEHAVIOR_ORDER.length}`,
                  numeric: true,
                },
                {
                  term: "Rhythm-aligned EMI",
                  value: ordinalDay(TOP.recommendedEmiDate),
                  numeric: true,
                },
                {
                  term: "Sanction ceiling",
                  value:
                    TIER_LOAN_CONFIG[TOP.tier].maxLoanAmount === 0
                      ? "No offer yet"
                      : `${formatINR(TIER_LOAN_CONFIG[TOP.tier].maxLoanAmount)} at ${pct(TIER_LOAN_CONFIG[TOP.tier].interestRate, 1)}`,
                  numeric: TIER_LOAN_CONFIG[TOP.tier].maxLoanAmount > 0,
                },
                {
                  term: "Monthly income",
                  value: formatINR(TOP.customer.monthlyIncome),
                  numeric: true,
                },
                {
                  term: "Bureau record",
                  value:
                    TOP.customer.cibilScore === undefined
                      ? "None"
                      : `CIBIL ${formatScore(TOP.customer.cibilScore)}`,
                  numeric: TOP.customer.cibilScore !== undefined,
                },
              ].map((item) => (
                <div
                  key={item.term}
                  className="flex items-baseline justify-between gap-3 border-b border-vistara-border/60 pb-3 last:border-b-0 last:pb-0"
                >
                  <dt className="text-vistara-muted">{item.term}</dt>
                  <dd
                    className={[
                      "text-right font-medium text-vistara-text",
                      item.numeric ? "tabular" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {item.value}
                  </dd>
                </div>
              ))}
            </dl>

            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-vistara-muted">
                  Carrying the score
                </p>
                <ul className="mt-2">
                  {TOP_STRONGEST.map((metric) => (
                    <FactorLine
                      key={metric.source}
                      metric={metric}
                      profile={TOP}
                    />
                  ))}
                </ul>
              </div>

              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-vistara-muted">
                  Weakest observed rhythms
                </p>
                <ul className="mt-2">
                  {TOP_WEAKEST.map((metric) => (
                    <FactorLine
                      key={metric.source}
                      metric={metric}
                      profile={TOP}
                    />
                  ))}
                </ul>
                <p className="mt-3 text-[12px] leading-relaxed text-vistara-muted">
                  {weakestNote}
                </p>
              </div>
            </div>
          </div>

          {TOP_ABSENT.length > 0 || TOP_TOO_THIN.length > 0 ? (
            <p className="mt-6 border-t border-vistara-border pt-4 text-[12px] leading-relaxed text-vistara-muted">
              Scored on {TOP.scoredSources.length} of {BEHAVIOR_ORDER.length}{" "}
              signals.
              {TOP_ABSENT.length > 0
                ? ` ${sourceList(TOP_ABSENT)} has no record on this file.`
                : ""}
              {TOP_TOO_THIN.length > 0
                ? ` ${sourceList(TOP_TOO_THIN)} sits under the ${MIN_EVENTS_TO_SCORE}-event floor.`
                : ""}{" "}
              That is {pct(TOP_ABSENT_WEIGHT * 100)} of the weight budget, which
              was redistributed across the observed rhythms — every surviving
              weight scaled by{" "}
              {(1 / (1 - TOP_ABSENT_WEIGHT)).toFixed(2)}× — rather than imputed
              from a rhythm nobody has seen.
              {TOP.seasonalityAdjusted
                ? " Harvest and festival-window gaps were excluded before sigma was measured on at least one stream, and that exclusion is disclosed on the applicant's own scorecard."
                : ""}
            </p>
          ) : (
            <p className="mt-6 border-t border-vistara-border pt-4 text-[12px] leading-relaxed text-vistara-muted">
              Scored on all {BEHAVIOR_ORDER.length} signals at their published
              weights — no renormalisation, nothing imputed.
              {TOP.seasonalityAdjusted
                ? " Harvest and festival-window gaps were excluded before sigma was measured on at least one stream, and that exclusion is disclosed on the applicant's own scorecard."
                : ""}
            </p>
          )}
        </Card>
      </section>
    </div>
  );
}
