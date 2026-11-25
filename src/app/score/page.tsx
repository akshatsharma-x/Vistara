/**
 * /score — the customer-facing result.
 *
 * The whole page is a Server Component and every figure on it is read from the
 * scored profile (or computed here from the profile's own loan terms with the
 * arithmetic stated). Nothing reads the clock: the observation window, the
 * horizons and the re-score date are all derived from the frozen REFERENCE_DATE
 * the cohort was generated against, so the server render and the client
 * hydration cannot disagree.
 */

import { ConsistencyBars, EventStrip, ScoreGauge } from "@/components/charts";
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
import { bandEntry, isSeasonalOccupation } from "@/lib/consistency";
import {
  ARCHETYPE_META,
  BEHAVIOR_META,
  BEHAVIOR_ORDER,
  BEHAVIOR_WEIGHTS,
  CHART_INK,
  COLOR_MAP,
  COVERAGE_ACTIONS,
  CROSS_DOMAIN_WEIGHT,
  MIN_STREAMS_TO_SCORE,
  OBSERVATION_DAYS,
  OBSERVATION_MONTHS,
  OCCUPATION_META,
  SCORE_MAX,
  SCORE_MIN,
  TIER_LOAN_CONFIG,
  TIER_THRESHOLDS,
} from "@/lib/constants";
import {
  formatDate,
  formatDays,
  formatINR,
  ordinalDay,
  pct,
} from "@/lib/format";
import { REFERENCE_DATE, addDays } from "@/lib/rng";
import { DEMO_CUSTOMERS, getDemoCustomer } from "@/lib/synthetic-data";
import type {
  BehaviorSource,
  ConsistencyMetrics,
  ImprovementAction,
  TemporalProfile,
  Tier,
} from "@/lib/types";

/* ================================================================== *
 * Local arithmetic — stated, not invented
 * ================================================================== */

/**
 * The share of the score the five single-domain rhythms carry between them; the
 * remainder is the cross-domain coherence term. Mirrors the engine exactly, so
 * the "unrealised points" figures below reconcile with the scorecard's own
 * per-source points.
 */
const SINGLE_DOMAIN_SHARE = 1 - CROSS_DOMAIN_WEIGHT;
const SCORE_SPAN = SCORE_MAX - SCORE_MIN;

/** How long a rhythm-building path runs before the file is worth re-reading. */
const RESCORE_MONTHS = 3;

/** The first quarter: everything an action can deliver inside the re-score window. */
const NEAR_TERM_HORIZON_MONTHS = 3;

const WINDOW_START = addDays(REFERENCE_DATE, -OBSERVATION_DAYS);

/** Calendar-month arithmetic in UTC. Never touches local time or the clock. */
function addMonthsUtc(date: Date, months: number): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + months,
      date.getUTCDate(),
    ),
  );
}

/**
 * Equated monthly instalment on a reducing balance — the standard amortisation
 * identity, run on the tier's own amount, rate and tenure. Shown so the offer is
 * a schedule the customer can check, not a headline.
 */
function monthlyEmi(
  principal: number,
  annualRatePercent: number,
  months: number,
): number {
  if (principal <= 0 || months <= 0) return 0;
  const monthlyRate = annualRatePercent / 100 / 12;
  if (monthlyRate <= 0) return principal / months;
  const growth = Math.pow(1 + monthlyRate, months);
  return (principal * monthlyRate * growth) / (growth - 1);
}

/** The next tier up and the score that reaches it. Undefined at Prime. */
function nextTierTarget(tier: Tier): { tier: Tier; threshold: number } | undefined {
  switch (tier) {
    case "PRIME":
      return undefined;
    case "NEAR_PRIME":
      return { tier: "PRIME", threshold: TIER_THRESHOLDS.PRIME };
    case "DEVELOPING":
      return { tier: "NEAR_PRIME", threshold: TIER_THRESHOLDS.NEAR_PRIME };
    default:
      return { tier: "DEVELOPING", threshold: TIER_THRESHOLDS.DEVELOPING };
  }
}

/* ================================================================== *
 * Profile selection — never crash on a bad id
 * ================================================================== */

/**
 * Preference order for the landing view: a strong file the bureau cannot see at
 * all, with every signal present. That contrast is the product, so it is what
 * the page opens on when no id is supplied.
 */
const DEFAULT_TIER_RANK: Record<Tier, number> = {
  NEAR_PRIME: 0,
  PRIME: 1,
  DEVELOPING: 2,
  THIN_FILE: 3,
};

function pickDefaultProfile(): TemporalProfile {
  const ranked = [...DEMO_CUSTOMERS].sort((a, b) => {
    const byTier = DEFAULT_TIER_RANK[a.tier] - DEFAULT_TIER_RANK[b.tier];
    if (byTier !== 0) return byTier;
    // A file with no bureau score first: it is the case the product exists for.
    const byBureau =
      Number(a.customer.hasCibilScore) - Number(b.customer.hasCibilScore);
    if (byBureau !== 0) return byBureau;
    const byCompleteness = b.dataCompleteness - a.dataCompleteness;
    if (byCompleteness !== 0) return byCompleteness;
    return a.customer.id.localeCompare(b.customer.id);
  });
  return ranked[0];
}

/* ================================================================== *
 * Plain-language tier copy — read aloud to the customer, not the officer
 * ================================================================== */

const TIER_SENTENCE: Record<Tier, string> = {
  PRIME:
    "Every rhythm we can see repeats on time, and it repeats across unrelated parts of your life — so this file prices at the standard rate with no guarantor and no bureau history.",
  NEAR_PRIME:
    "Your rhythm is dependable in most domains and still settling in one. That is enough to lend against today, with a larger ticket once six instalments land on time.",
  DEVELOPING:
    "Your habits are regular in places and drifting in others. We can start smaller and shorter, with the due date placed where your money actually arrives rather than where the calendar says.",
  // Data-gate case only: scoredSources.length < MIN_STREAMS_TO_SCORE.
  // Low-score THIN_FILE (sufficient signals, score < DEVELOPING threshold)
  // uses a computed sentence at the render site — see below.
  THIN_FILE:
    "We have not yet observed enough steady rhythm to price a loan. That is a limit on what we can see, not a verdict on you — and it is fixable in one quarter.",
};

/* ================================================================== *
 * Weakness ranking — the two sources the improvement path is built on
 * ================================================================== */

interface Weakness {
  source: BehaviorSource;
  /** False when the signal is not on file at all — the cold-start case. */
  present: boolean;
  consistencyIndex: number;
  /** Weight the engine actually applied, after renormalising. 0 when absent. */
  appliedWeight: number;
  /** Raw model weight this signal carries when it is present. */
  modelWeight: number;
  /**
   * Points of the 300–900 range this signal is not currently earning.
   *
   * Present sources: appliedWeight x (100 - index)/100 x 0.75 x 600 — the exact
   * inverse of the scorecard's own per-source points, so the two reconcile.
   * Absent sources: the full model weight, because the engine is earning none of
   * it. Labelled "up to" wherever it is shown.
   */
  unrealisedPoints: number;
}

function buildWeaknesses(profile: TemporalProfile): Weakness[] {
  return BEHAVIOR_ORDER.map((source): Weakness => {
    const factor = profile.factors.find((entry) => entry.source === source);
    const modelWeight = BEHAVIOR_WEIGHTS[source];

    if (factor === undefined) {
      return {
        source,
        present: false,
        consistencyIndex: 0,
        appliedWeight: 0,
        modelWeight,
        unrealisedPoints: modelWeight * SINGLE_DOMAIN_SHARE * SCORE_SPAN,
      };
    }

    return {
      source,
      present: true,
      consistencyIndex: factor.consistencyIndex,
      appliedWeight: factor.weight,
      modelWeight,
      unrealisedPoints:
        factor.weight *
        ((100 - factor.consistencyIndex) / 100) *
        SINGLE_DOMAIN_SHARE *
        SCORE_SPAN,
    };
  }).sort(
    (a, b) =>
      b.unrealisedPoints - a.unrealisedPoints ||
      b.modelWeight - a.modelWeight ||
      a.source.localeCompare(b.source),
  );
}

function actionsForSource(
  profile: TemporalProfile,
  source: BehaviorSource,
): ImprovementAction[] {
  return profile.improvementActions.filter((action) => action.lever === source);
}

/* ================================================================== *
 * Pieces
 * ================================================================== */

function BureauComparison({ profile }: { profile: TemporalProfile }) {
  const { customer } = profile;
  const cibil = customer.cibilScore;

  if (!customer.hasCibilScore || cibil === undefined) {
    return (
      <div className="self-start rounded-card border border-vistara-border bg-vistara-dark/50 p-4">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-vistara-muted">
          Bureau score
        </p>
        <p className="mt-2 text-[22px] font-semibold leading-none tracking-tight text-vistara-text">
          No hit
        </p>
        <p className="mt-2.5 text-[12px] leading-relaxed text-vistara-muted">
          No CIBIL score exists for {customer.name} — no card, no prior loan, no
          repayment history to enquire against. A bureau-only decision here is
          not a low score; it is a blank page, and it is why this application
          would normally stop.
        </p>
        <p className="mt-2.5 text-[12px] leading-relaxed text-vistara-muted">
          Vistara returned{" "}
          <span className="tabular font-medium text-vistara-text">
            {profile.vistaraScore}
          </span>{" "}
          from {profile.scoredSources.length} observed{" "}
          {profile.scoredSources.length === 1 ? "rhythm" : "rhythms"} over{" "}
          {OBSERVATION_MONTHS} months, without reading a single amount.
        </p>
      </div>
    );
  }

  const delta = profile.vistaraScore - cibil;
  const ahead = delta > 0;

  return (
    <div className="self-start rounded-card border border-vistara-border bg-vistara-dark/50 p-4">
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-vistara-muted">
        Bureau score on file
      </p>

      <div className="mt-3 flex items-end gap-4">
        <span>
          <span className="tabular block text-[22px] font-semibold leading-none tracking-tight text-vistara-text">
            {cibil}
          </span>
          <span className="mt-1.5 block text-[11px] text-vistara-muted">
            CIBIL
          </span>
        </span>
        <span aria-hidden className="mb-4 h-px w-4 bg-vistara-border" />
        <span>
          <span className="tabular block text-[22px] font-semibold leading-none tracking-tight text-vistara-text">
            {profile.vistaraScore}
          </span>
          <span className="mt-1.5 block text-[11px] text-vistara-muted">
            Vistara
          </span>
        </span>
        <span className="ml-auto mb-0.5">
          <Badge
            color={ahead ? COLOR_MAP.PRIME.color : COLOR_MAP.DEVELOPING.color}
            icon={ahead ? "▲" : "▼"}
            label={`${ahead ? "+" : ""}${delta} pts`}
            size="md"
          />
        </span>
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-vistara-muted">
        {ahead
          ? "The bureau sees a short, sparse repayment file and prices the absence of history. Vistara reads eighteen months of behaviour the bureau never receives, and it disagrees."
          : "Vistara is the more conservative of the two here. The bureau is reading a repayment record; Vistara is reading the rhythm underneath it, and that rhythm is not yet steady. Two independent readings that disagree are a reason to look closer at the evidence below, not to average them."}
      </p>
      <p className="mt-2 text-[12px] leading-relaxed text-vistara-muted">
        The two numbers share a 300–900 range but not a method. They are shown
        side by side as two readings, never added together.
      </p>
    </div>
  );
}

function BandLegend({ profile }: { profile: TemporalProfile }) {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-2">
      {BEHAVIOR_ORDER.map((source) => {
        const metric = profile.metrics.find((entry) => entry.source === source);
        const meta = BEHAVIOR_META[source];

        if (metric === undefined || !metric.scorable) {
          return (
            <li key={source}>
              <Badge
                color={CHART_INK.muted}
                icon={meta.icon}
                label={`${meta.short} — ${
                  metric === undefined ? "not on file" : "too few events to score"
                }`}
              />
            </li>
          );
        }

        const band = bandEntry(metric.band);
        const factor = profile.factors.find((entry) => entry.source === source);

        return (
          <li key={source}>
            <Badge
              color={band.color}
              icon={band.icon}
              label={`${meta.short} — ${band.label}`}
              trailing={
                factor === undefined
                  ? undefined
                  : `· ${pct(factor.weight * 100)} of score`
              }
            />
          </li>
        );
      })}
    </ul>
  );
}

interface MetricRow {
  source: BehaviorSource;
  label: string;
  present: boolean;
  metric?: ConsistencyMetrics;
}

function RhythmTable({ profile }: { profile: TemporalProfile }) {
  const rows: MetricRow[] = BEHAVIOR_ORDER.map((source) => {
    const metric = profile.metrics.find((entry) => entry.source === source);
    return {
      source,
      label: BEHAVIOR_META[source].short,
      present: metric !== undefined,
      ...(metric === undefined ? {} : { metric }),
    };
  });

  const numeric = (
    row: MetricRow,
    read: (metric: ConsistencyMetrics) => string,
  ): string => (row.metric === undefined ? "—" : read(row.metric));

  return (
    <DataTable<MetricRow>
      rows={rows}
      getRowKey={(row) => row.source}
      caption={`Every value plotted above, stated numerically. σ is the standard deviation of the gap between events; the normalised column restates σ on a 30-day reference cadence, which is the only figure comparable across a weekly toll and a quarterly service — and the figure the engine bands and scores. Window ${formatDate(WINDOW_START)} to ${formatDate(REFERENCE_DATE)}.`}
      columns={[
        {
          key: "label",
          label: "Signal",
          rowHeader: true,
          width: "22%",
          render: (row) => (
            <span className="inline-flex items-center gap-2">
              <span aria-hidden className="text-vistara-muted">
                {BEHAVIOR_META[row.source].icon}
              </span>
              {row.label}
            </span>
          ),
        },
        {
          key: "band",
          label: "Band",
          width: "17%",
          render: (row) => {
            if (row.metric === undefined || !row.metric.scorable) {
              return (
                <span className="text-vistara-muted">
                  {row.present ? "Too few events" : "Not on file"}
                </span>
              );
            }
            const band = bandEntry(row.metric.band);
            return (
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <span aria-hidden style={{ color: band.color }}>
                  {band.icon}
                </span>
                {band.label}
                {row.metric.seasonalityAdjusted ? (
                  <span className="text-vistara-muted">· seasonal</span>
                ) : null}
              </span>
            );
          },
        },
        {
          key: "events",
          label: "Events",
          align: "right",
          render: (row) => numeric(row, (m) => String(m.eventCount)),
        },
        {
          key: "mean",
          label: "Mean interval",
          align: "right",
          render: (row) => numeric(row, (m) => formatDays(m.meanIntervalDays)),
        },
        {
          // Spelled out, not "σ": the table head is uppercased by the primitive,
          // and an uppercased sigma is a summation sign.
          key: "sigma",
          label: "Sigma",
          align: "right",
          render: (row) => numeric(row, (m) => formatDays(m.stdDevDays)),
        },
        {
          key: "normalised",
          label: "Sigma at 30d",
          align: "right",
          render: (row) =>
            numeric(row, (m) => formatDays(m.normalisedStdDevDays)),
        },
        {
          key: "streak",
          label: "Streak",
          align: "right",
          render: (row) => numeric(row, (m) => String(m.streakLength)),
        },
        {
          key: "recovery",
          label: "Recovery",
          align: "right",
          render: (row) => numeric(row, (m) => formatDays(m.recoverySpeedDays)),
        },
        {
          key: "index",
          label: "Index",
          align: "right",
          render: (row) =>
            numeric(row, (m) =>
              m.scorable ? `${Math.round(m.consistencyIndex)}` : "—",
            ),
        },
      ]}
    />
  );
}

function ActionCard({
  action,
  emphasis = false,
}: {
  action: ImprovementAction;
  emphasis?: boolean;
}) {
  const visibleBy = addMonthsUtc(REFERENCE_DATE, action.horizonMonths);

  return (
    <div
      className={[
        "rounded-card border bg-vistara-dark/40 p-4",
        emphasis ? "border-vistara-accent/35" : "border-vistara-border",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-4">
        <p className="text-[14px] font-medium leading-snug tracking-tight text-vistara-text">
          {action.title}
        </p>
        <p className="shrink-0 text-right">
          <span className="tabular block text-[18px] font-semibold leading-none text-vistara-text">
            +{action.potentialPoints}
          </span>
          <span className="mt-1 block text-[10px] uppercase tracking-[0.14em] text-vistara-muted">
            points
          </span>
        </p>
      </div>

      <p className="mt-2 text-[13px] leading-relaxed text-vistara-muted">
        {action.detail}
      </p>

      <p className="mt-3 border-t border-vistara-border pt-2.5 text-[12px] text-vistara-muted">
        Takes{" "}
        <span className="tabular text-vistara-text">
          {action.horizonMonths}
        </span>{" "}
        {action.horizonMonths === 1 ? "month" : "months"} of the new rhythm to
        show up in the data — visible from{" "}
        <span className="tabular text-vistara-text">
          {formatDate(visibleBy)}
        </span>
        .
      </p>
    </div>
  );
}

function WeaknessBlock({
  profile,
  weakness,
  rank,
}: {
  profile: TemporalProfile;
  weakness: Weakness;
  rank: number;
}) {
  const meta = BEHAVIOR_META[weakness.source];
  const actions = actionsForSource(profile, weakness.source);
  const coverage = COVERAGE_ACTIONS[weakness.source];

  return (
    <div className="border-t border-vistara-border pt-5 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h3 className="text-[15px] font-semibold tracking-tight text-vistara-text">
          <span aria-hidden className="mr-2 text-vistara-muted">
            {meta.icon}
          </span>
          {rank}. {meta.label}
        </h3>
        <p className="text-[12px] text-vistara-muted">
          {weakness.present ? (
            <>
              index{" "}
              <span className="tabular text-vistara-text">
                {Math.round(weakness.consistencyIndex)}
              </span>{" "}
              of 100 · carries{" "}
              <span className="tabular text-vistara-text">
                {pct(weakness.appliedWeight * 100)}
              </span>{" "}
              of your score
            </>
          ) : (
            <>
              not on file ·{" "}
              <span className="tabular text-vistara-text">
                {pct(weakness.modelWeight * 100)}
              </span>{" "}
              of the model&rsquo;s weight when present
            </>
          )}
        </p>
      </div>

      <p className="mt-2 max-w-prose text-[13px] leading-relaxed text-vistara-muted">
        {weakness.present ? (
          <>
            Up to{" "}
            <span className="tabular text-vistara-text">
              {Math.round(weakness.unrealisedPoints)}
            </span>{" "}
            points of the 300&ndash;900 range sit behind this one rhythm and are
            not being earned yet &mdash; that is its applied weight multiplied by
            the distance from a perfect index, on exactly the arithmetic the
            scorecard above uses.
          </>
        ) : (
          <>
            This signal is missing entirely, so the engine renormalised its
            weight onto the rhythms it could see. Up to{" "}
            <span className="tabular text-vistara-text">
              {Math.round(weakness.unrealisedPoints)}
            </span>{" "}
            points of the range are unreachable until there is something to read.{" "}
            {coverage.detail}
          </>
        )}
      </p>

      {actions.length > 0 ? (
        <div className="mt-4 grid gap-3">
          {actions.map((action) => (
            <ActionCard key={action.id} action={action} emphasis />
          ))}
        </div>
      ) : (
        <p className="mt-3 text-[13px] leading-relaxed text-vistara-muted">
          The engine priced every change to this rhythm below five points, so
          there is nothing worth asking you to change here. Keep it exactly as it
          is.
        </p>
      )}
    </div>
  );
}

/* ================================================================== *
 * The offer (every tier except THIN_FILE)
 * ================================================================== */

function LoanOffer({ profile }: { profile: TemporalProfile }) {
  const { customer } = profile;
  const loan = TIER_LOAN_CONFIG[profile.tier];
  const emi = monthlyEmi(
    profile.maxLoanAmount,
    profile.interestRate,
    loan.tenureMonths,
  );
  const incomeShare = (emi / Math.max(1, customer.monthlyIncome)) * 100;
  const archetype = ARCHETYPE_META[profile.financialArchetype];
  const firstDebit = addMonthsUtc(REFERENCE_DATE, 1);

  return (
    <Card
      eyebrow="Indicative offer"
      title="What this rhythm qualifies for"
      description={`Priced from the ${COLOR_MAP[profile.tier].label} band the score falls in. Terms are the band's, the instalment is the amortisation of those terms, and the due date is read from this customer's own calendar.`}
      action={<TierBadge tier={profile.tier} score={profile.vistaraScore} />}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Amount"
          value={formatINR(profile.maxLoanAmount)}
          emphasis
          hint="Sanctioned limit for this band."
        />
        <StatTile
          label="Rate"
          value={`${profile.interestRate}%`}
          hint="Per annum, reducing balance."
        />
        <StatTile
          label="Tenure"
          value={`${loan.tenureMonths} mo`}
          hint={`${loan.tenureMonths} instalments, first on ${formatDate(firstDebit)}.`}
        />
        <StatTile
          label="Instalment"
          value={formatINR(emi)}
          hint={`Computed from the three terms at left. ${pct(incomeShare, 1)} of the ${formatINR(customer.monthlyIncome)} monthly income on file.`}
        />
      </div>

      {/* The differentiator. Not the amount — the date. */}
      <div className="mt-5 rounded-card border border-vistara-accent/30 bg-vistara-accent/[0.06] p-5">
        <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
          <div className="shrink-0">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-vistara-muted">
              Recommended EMI date
            </p>
            <p className="mt-2 text-[40px] font-semibold leading-none tracking-tight text-vistara-text">
              {ordinalDay(profile.recommendedEmiDate)}
            </p>
            <p className="mt-2 text-[12px] text-vistara-muted">
              of every month
            </p>
          </div>

          <div className="min-w-0 flex-1">
            <p className="max-w-prose text-[14px] leading-relaxed text-vistara-text">
              Your instalment falls on the{" "}
              {ordinalDay(profile.recommendedEmiDate)} because that is when your
              money reliably arrives.
            </p>
            <p className="mt-2 max-w-prose text-[13px] leading-relaxed text-vistara-muted">
              The engine takes the day of the month your monthly rhythms
              actually land on &mdash; measured as circular concentration, so a
              recharge cycle that drifts backwards through the calendar is not
              mistaken for an income date &mdash; and places the debit a short
              buffer after it. A 1st-of-month due date would fight your cash
              flow: it debits before the rhythm delivers, and the first bounce
              would be an artefact of the schedule rather than of your ability to
              pay.
            </p>
          </div>
        </div>
      </div>

      <div className="mt-5 border-t border-vistara-border pt-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h4 className="text-[14px] font-semibold tracking-tight text-vistara-text">
            Behavioural archetype
          </h4>
          <Badge
            color={COLOR_MAP[profile.tier].color}
            icon={COLOR_MAP[profile.tier].icon}
            label={archetype.label}
            size="md"
          />
        </div>
        <p className="mt-2 max-w-prose text-[13px] leading-relaxed text-vistara-muted">
          {archetype.blurb}
        </p>
        <p className="mt-3 text-[13px] leading-relaxed text-vistara-text">
          <span className="mr-2 text-[11px] font-medium uppercase tracking-[0.14em] text-vistara-muted">
            Servicing
          </span>
          {archetype.emiGuidance}
        </p>
      </div>
    </Card>
  );
}

/* ================================================================== *
 * THIN_FILE — a different product, not a rejection
 * ================================================================== */

function RhythmBuildingPath({ profile }: { profile: TemporalProfile }) {
  const gated = profile.scoredSources.length < MIN_STREAMS_TO_SCORE;
  const rescoreDate = addMonthsUtc(REFERENCE_DATE, RESCORE_MONTHS);
  const target = nextTierTarget(profile.tier);
  const unlocks = TIER_LOAN_CONFIG.DEVELOPING;

  const nearTerm = profile.improvementActions.filter(
    (action) => action.horizonMonths <= NEAR_TERM_HORIZON_MONTHS,
  );
  const laterTerm = profile.improvementActions.filter(
    (action) => action.horizonMonths > NEAR_TERM_HORIZON_MONTHS,
  );

  return (
    <Card
      eyebrow={`${RESCORE_MONTHS}-month rhythm-building path`}
      title="No offer today. A dated plan instead."
      description="We are not declining this application; we are declining to guess. Nothing below asks for money, a guarantor or a document — every step is a change to when something already happening happens."
    >
      <div className="rounded-card border border-vistara-border bg-vistara-dark/50 p-4">
        <p className="max-w-prose text-[13px] leading-relaxed text-vistara-muted">
          {gated ? (
            <>
              Vistara scored{" "}
              <span className="tabular text-vistara-text">
                {profile.scoredSources.length}
              </span>{" "}
              of five signals, below the{" "}
              <span className="tabular text-vistara-text">
                {MIN_STREAMS_TO_SCORE}
              </span>{" "}
              it needs before it will claim to have seen a pattern. One habit can
              be a coincidence; the engine will not price one. The fix is
              coverage, not effort &mdash; there are rhythms in this life that we
              are simply not receiving yet.
            </>
          ) : (
            <>
              The{" "}
              <span className="tabular text-vistara-text">
                {profile.scoredSources.length}
              </span>{" "}
              {profile.scoredSources.length === 1 ? "rhythm" : "rhythms"} we can
              see cleared the evidence bar and were scored in full &mdash; they
              are simply irregular, with long absences rather than late arrivals.
              {profile.missingSources.length > 0 ? (
                <>
                  {" "}
                  <span className="tabular text-vistara-text">
                    {profile.missingSources.length}
                  </span>{" "}
                  of five signals also reached us with nothing in them, so there
                  is both something to steady and something to switch on.
                </>
              ) : null}{" "}
              Timing is the only input this engine reads, which makes it the one
              input you can change without earning more.
            </>
          )}
        </p>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <StatTile
          label="Re-score on"
          value={formatDate(rescoreDate)}
          emphasis
          hint={`${RESCORE_MONTHS} months after the close of the current observation window (${formatDate(REFERENCE_DATE)}). No application needed — the file re-reads itself.`}
        />
        <StatTile
          label="Points needed"
          value={
            target === undefined
              ? "—"
              : `+${Math.max(0, target.threshold - profile.vistaraScore)}`
          }
          hint={
            target === undefined
              ? "Already at the top band."
              : `${COLOR_MAP[target.tier].label} starts at ${target.threshold}. You are at ${profile.vistaraScore}.`
          }
        />
        <StatTile
          label="What that unlocks"
          value={formatINR(unlocks.maxLoanAmount)}
          hint={`${unlocks.interestRate}% per annum over ${unlocks.tenureMonths} months, with the due date placed on your own income date. Shown as the destination, not as an offer.`}
        />
      </div>

      {nearTerm.length > 0 ? (
        <div className="mt-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-vistara-muted">
            Do these before {formatDate(rescoreDate)}
          </p>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {nearTerm.map((action) => (
              <ActionCard key={action.id} action={action} emphasis />
            ))}
          </div>
        </div>
      ) : null}

      {laterTerm.length > 0 ? (
        <div className="mt-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-vistara-muted">
            Beyond the first quarter
          </p>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {laterTerm.map((action) => (
              <ActionCard key={action.id} action={action} />
            ))}
          </div>
        </div>
      ) : null}

      {profile.improvementActions.length === 0 ? (
        <p className="mt-5 text-[13px] leading-relaxed text-vistara-muted">
          The engine could not price a single change worth five points on the
          evidence it holds, which means the next step is coverage rather than
          correction: bring one more recurring payment onto a channel we can
          read, and the file becomes scorable in one cycle.
        </p>
      ) : null}

      <p className="mt-6 border-t border-vistara-border pt-4 text-[12px] leading-relaxed text-vistara-muted">
        Point figures are the engine&rsquo;s own arithmetic, produced by
        re-running this file with that one change applied and rounding to the
        nearest five. They are priced one at a time and they overlap, so they do
        not simply add &mdash; the re-score on {formatDate(rescoreDate)} reads
        the real data, not this projection.
      </p>
    </Card>
  );
}

/* ================================================================== *
 * Page
 * ================================================================== */

export default function ScorePage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const raw = searchParams.id;
  const requestedId = typeof raw === "string" ? raw : undefined;
  const requested =
    requestedId === undefined ? undefined : getDemoCustomer(requestedId);
  const profile = requested ?? pickDefaultProfile();
  const unresolvedId =
    requestedId !== undefined && requested === undefined ? requestedId : undefined;

  const { customer, metrics, streams } = profile;
  const occupation = OCCUPATION_META[customer.occupation];
  // Eligibility is asked of the engine, not of the display metadata: the two
  // must never disagree on screen about whether an exception could apply.
  const seasonalEligible = isSeasonalOccupation(customer.occupation);
  const isThinFile = profile.tier === "THIN_FILE";
  // THIN_FILE by the data gate rather than by the score. There is no score to
  // show — see ScoreGauge's `scored` — and points are not what moves the file:
  // another observed signal is.
  const gated = profile.scoredSources.length < MIN_STREAMS_TO_SCORE;
  const signalsNeeded = MIN_STREAMS_TO_SCORE - profile.scoredSources.length;
  const target = nextTierTarget(profile.tier);

  const scorableIndices = metrics
    .filter((metric) => metric.scorable)
    .map((metric) => metric.consistencyIndex);
  const strongestIndex =
    scorableIndices.length === 0 ? 0 : Math.max(...scorableIndices);
  const weakestIndex =
    scorableIndices.length === 0 ? 0 : Math.min(...scorableIndices);

  const weaknesses = buildWeaknesses(profile);
  const primaryWeaknesses = weaknesses.slice(0, 2);
  const primarySources = primaryWeaknesses.map((entry) => entry.source);
  const secondaryActions = profile.improvementActions.filter((action) => {
    if (typeof action.lever !== "string") return false;
    return !primarySources.some((source) => source === action.lever);
  });

  return (
    <div className="mx-auto max-w-6xl px-5 py-10 sm:py-14">
      <Button href="/apply" variant="ghost" size="sm" className="-ml-3">
        ← All applicants
      </Button>

      {/* ── Applicant identity ───────────────────────────────────────── */}
      <div className="mt-6">
        <SectionHeading
          as="h1"
          size="page"
          eyebrow={`Score result · ${customer.id}`}
          title={customer.name}
          description={
            <>
              {occupation.label} · {customer.city} · age {customer.age} ·{" "}
              <span className="text-vistara-text">
                {formatINR(customer.monthlyIncome)}
              </span>{" "}
              a month declared.{" "}
              {seasonalEligible
                ? `A cyclical income, so up to two harvest- or festival-window gaps are eligible for the documented seasonal exception${profile.seasonalityAdjusted ? " — and it was used on this file." : ", which this file did not need."}`
                : "A non-cyclical income, so the seasonal exception does not apply to this file at all."}
            </>
          }
          action={
            <div className="flex flex-wrap items-center justify-end gap-2">
              <TierBadge tier={profile.tier} size="lg" />
              <Badge
                color={CHART_INK.muted}
                label={`${ARCHETYPE_META[profile.financialArchetype].label} archetype`}
                size="md"
              />
            </div>
          }
        />
      </div>

      {unresolvedId !== undefined ? (
        <p className="mt-5 rounded-card border border-vistara-border bg-vistara-surface px-4 py-3 text-[13px] leading-relaxed text-vistara-muted">
          No applicant matches the id{" "}
          <span className="tabular text-vistara-text">{unresolvedId}</span> in
          this prototype&rsquo;s twelve-customer cohort, so{" "}
          <span className="text-vistara-text">{customer.name}</span> is shown
          instead. Nothing on this page was inferred from that id.
        </p>
      ) : null}

      {/* ── Hero: the score, the tier, the bureau contrast ───────────── */}
      <section className="mt-8">
        <Card>
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
            <div className="min-w-0">
              <ScoreGauge
                score={profile.vistaraScore}
                tier={profile.tier}
                scored={!gated}
              />

              <p className="mt-6 max-w-prose border-t border-vistara-border pt-5 text-[14px] leading-relaxed text-vistara-text">
                {isThinFile &&
                profile.scoredSources.length >= MIN_STREAMS_TO_SCORE
                  ? "Your rhythm has been observed across most signals — it is developing but below the minimum threshold for standard lending terms. A focused rhythm-building path over the next six months should bring you into the Developing tier."
                  : TIER_SENTENCE[profile.tier]}
              </p>

              <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-[12px] text-vistara-muted">
                <li>
                  Scored on{" "}
                  <span className="tabular text-vistara-text">
                    {profile.scoredSources.length}
                  </span>{" "}
                  of {BEHAVIOR_ORDER.length} signals ·{" "}
                  {pct(profile.dataCompleteness * 100)} complete
                </li>
                <li>
                  Window {formatDate(WINDOW_START)} &ndash;{" "}
                  {formatDate(REFERENCE_DATE)}
                </li>
                {profile.seasonalityAdjusted ? (
                  <li className="text-vistara-text">
                    Seasonal exception applied and disclosed
                  </li>
                ) : null}
                {gated ? (
                  <li>
                    <span className="tabular text-vistara-text">
                      {signalsNeeded}
                    </span>{" "}
                    more {signalsNeeded === 1 ? "signal" : "signals"} to a scored
                    result
                  </li>
                ) : target === undefined ? (
                  <li>Top band — no higher tier to reach</li>
                ) : (
                  <li>
                    <span className="tabular text-vistara-text">
                      {Math.max(0, target.threshold - profile.vistaraScore)}
                    </span>{" "}
                    points to {COLOR_MAP[target.tier].label}
                  </li>
                )}
              </ul>

              {profile.missingSources.length > 0 ? (
                <p className="mt-4 text-[12px] leading-relaxed text-vistara-muted">
                  Not scored on this file:{" "}
                  <span className="text-vistara-text">
                    {profile.missingSources
                      .map((source) => BEHAVIOR_META[source].short)
                      .join(", ")}
                  </span>{" "}
                  &mdash; either no events are on file at all, or too few to
                  claim a rhythm exists. The weights were renormalised over what
                  was observed rather than scoring an absence as a failure.
                </p>
              ) : null}
            </div>

            <BureauComparison profile={profile} />
          </div>
        </Card>
      </section>

      {/* ── Rhythm profile ──────────────────────────────────────────── */}
      <section className="mt-12">
        <SectionHeading
          eyebrow="Behavioural evidence"
          title="Your financial rhythm profile"
          description="Five recurring rhythms, read as timestamps only. No amount, no merchant, no category enters this section — the entire reading is when things happened and how evenly."
        />

        <Card className="mt-5" eyebrow="Consistency index by domain">
          <ConsistencyBars metrics={metrics} />
          <div className="mt-5 border-t border-vistara-border pt-5">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-vistara-muted">
              Band and applied weight per signal
            </p>
            <div className="mt-3">
              <BandLegend profile={profile} />
            </div>
          </div>
        </Card>

        <Card
          className="mt-5"
          eyebrow={`${OBSERVATION_MONTHS}-month event strips`}
          title="The rhythm itself, not a number about it"
          description={`All five rows share one time axis, ${formatDate(WINDOW_START)} to ${formatDate(REFERENCE_DATE)}. A steady life renders as an even comb; a broken one visibly clusters and gaps. Every dot is a timestamp on file.`}
        >
          <div className="space-y-8">
            {BEHAVIOR_ORDER.map((source) => {
              const stream = streams.find((entry) => entry.source === source);
              const meta = BEHAVIOR_META[source];

              if (stream === undefined) {
                return (
                  <div
                    key={source}
                    className="rounded-card border border-vistara-border bg-vistara-dark/40 p-4"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1">
                      <h3 className="text-[14px] font-medium tracking-tight text-vistara-text">
                        <span aria-hidden className="mr-2 text-vistara-muted">
                          {meta.icon}
                        </span>
                        {meta.label}
                      </h3>
                      <p className="text-[12px] text-vistara-muted">
                        No events on file · cold start
                      </p>
                    </div>
                    <p className="mt-2 max-w-prose text-[12px] leading-relaxed text-vistara-muted">
                      Expected every {meta.expectedIntervalDays} days when
                      present, and worth{" "}
                      {pct(BEHAVIOR_WEIGHTS[source] * 100)} of the model. Nothing
                      was imputed here — an unobserved rhythm is recorded as
                      unobserved. {COVERAGE_ACTIONS[source].title}.
                    </p>
                  </div>
                );
              }

              return (
                <EventStrip
                  key={source}
                  stream={stream}
                  expectedIntervalDays={stream.expectedIntervalDays}
                />
              );
            })}
          </div>
        </Card>

        <Card
          className="mt-5"
          eyebrow="Accessibility twin"
          title="Every plotted value, in numbers"
        >
          <RhythmTable profile={profile} />
        </Card>
      </section>

      {/* ── Cross-domain coherence ──────────────────────────────────── */}
      <section className="mt-12">
        <Card
          eyebrow="The signal that decides the score"
          title="Cross-domain consistency"
        >
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
            <div>
              <p className="flex items-baseline gap-2">
                <span className="text-[44px] font-semibold leading-none tracking-tight text-vistara-text">
                  {Math.round(profile.crossDomainConsistency)}
                </span>
                <span className="tabular text-[13px] text-vistara-muted">
                  / 100
                </span>
              </p>

              <Meter
                className="mt-4"
                value={profile.crossDomainConsistency}
                ariaLabel={`Cross-domain consistency ${Math.round(profile.crossDomainConsistency)} of 100.`}
              />

              <p className="mt-3 text-[12px] leading-relaxed text-vistara-muted">
                Weakest observed rhythm{" "}
                <span className="tabular text-vistara-text">
                  {Math.round(weakestIndex)}
                </span>
                , strongest{" "}
                <span className="tabular text-vistara-text">
                  {Math.round(strongestIndex)}
                </span>
                . The spread between those two is what this figure charges for.
              </p>
            </div>

            <div className="min-w-0">
              <p className="max-w-prose text-[14px] leading-relaxed text-vistara-text">
                Consistency in one domain can be coincidence. Consistency across
                unrelated domains is character.
              </p>
              <p className="mt-3 max-w-prose text-[13px] leading-relaxed text-vistara-muted">
                This term is the geometric mean of the per-domain indices minus a
                penalty on their spread, and it carries{" "}
                {pct(CROSS_DOMAIN_WEIGHT * 100)} of the final score. The
                geometric mean matters: an arithmetic average would let one
                flawless habit buy off four broken ones, which is exactly the
                profile a fraudster can manufacture and a real life rarely has.
                Being evenly reliable scores higher here than being brilliant in
                one place, because a lender is buying the floor of your
                behaviour, not its ceiling.
              </p>
              <p className="mt-3 max-w-prose text-[13px] leading-relaxed text-vistara-muted">
                Nothing in this figure is coordinated across the five sources —
                a vehicle dealer, a UPI mandate, a power utility, a telecom
                operator and a toll plaza have no reason to agree about you.
                That independence is what makes their agreement worth pricing.
              </p>
            </div>
          </div>
        </Card>
      </section>

      {/* ── Offer, or the path that replaces it ─────────────────────── */}
      <section className="mt-12">
        {isThinFile ? (
          <RhythmBuildingPath profile={profile} />
        ) : (
          <LoanOffer profile={profile} />
        )}
      </section>

      {/* ── Path to prime (offer-bearing tiers only) ────────────────── */}
      {isThinFile ? null : (
        <section className="mt-12">
          <SectionHeading
            eyebrow="Path to prime"
            title={
              target === undefined
                ? "Holding prime"
                : `The ${Math.max(0, target.threshold - profile.vistaraScore)} points to ${COLOR_MAP[target.tier].label}`
            }
            description={
              target === undefined
                ? "There is no higher band to reach, so the only useful advice is which two rhythms carry the most unearned points if they ever slip."
                : "Built from the two rhythms with the most unearned points on this file. Each figure below is the engine re-run on this customer's own data with that single change applied — never a rule of thumb."
            }
          />

          <Card className="mt-5">
            <div className="space-y-6">
              {primaryWeaknesses.map((weakness, i) => (
                <WeaknessBlock
                  key={weakness.source}
                  profile={profile}
                  weakness={weakness}
                  rank={i + 1}
                />
              ))}
            </div>

            {secondaryActions.length > 0 ? (
              <div className="mt-7 border-t border-vistara-border pt-5">
                <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-vistara-muted">
                  Other levers on this file, priced the same way
                </p>
                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  {secondaryActions.map((action) => (
                    <ActionCard key={action.id} action={action} />
                  ))}
                </div>
              </div>
            ) : null}

            <p className="mt-6 border-t border-vistara-border pt-4 text-[12px] leading-relaxed text-vistara-muted">
              Every point figure is produced by re-scoring this file with one
              change applied and rounding to the nearest five, so it is an
              estimate of that change alone. The gains overlap and do not add:
              tightening a rhythm also narrows the spread the cross-domain term
              charges for, and that improvement is counted once, not twice.
              Anything the engine priced below five points is not shown at all.
            </p>
          </Card>
        </section>
      )}

      {/* ── Footer nav ──────────────────────────────────────────────── */}
      <div className="mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-vistara-border pt-6">
        <Button href="/apply" variant="secondary" size="sm">
          ← All applicants
        </Button>
        <Button href="/dashboard" variant="ghost" size="sm">
          Loan officer dashboard →
        </Button>
      </div>
    </div>
  );
}
