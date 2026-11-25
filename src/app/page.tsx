import type { CSSProperties } from "react";

import Link from "next/link";

import { Button, Card, SectionHeading, TierBadge } from "@/components/ui";
import {
  BEHAVIOR_META,
  BEHAVIOR_ORDER,
  CHART_INK,
  COLOR_MAP,
  DEMO_CUSTOMERS_BY_ARCHETYPE,
  OBSERVATION_MONTHS,
  MIN_STREAMS_TO_SCORE,
  OCCUPATION_META,
  SCORE_MAX,
  SCORE_MIN,
  bandEntry,
  formatScore,
  type BehaviorSource,
  type FinancialArchetype,
  type TemporalProfile,
} from "@/lib";

/* ================================================================== *
 * The landing page.
 * ================================================================== *
 * A Server Component with no client boundary anywhere in it. Everything it
 * renders is either static copy or a read of the frozen cohort, so the whole
 * page prerenders to HTML at build time and ships no JavaScript of its own —
 * which on the low-end Android this product is aimed at is the difference
 * between a first screen that arrives and one that waits.
 *
 * MOTION. Three sources, none of them JavaScript. The mesh drift behind the hero
 * and the smooth scroll to #demo are declared in globals.css under a
 * `prefers-reduced-motion: no-preference` query; the staggered entrance on the
 * four hero elements below is the `fade-up` keyframe from tailwind.config.ts,
 * gated behind `motion-safe:` and delayed per element.
 *
 * The entrance stops at the fold, deliberately. A CSS animation has no observer,
 * so it fires on load whether or not its element is on screen — every section
 * below the hero would animate to an empty room and be finished by the time
 * anybody scrolled to it. Entrance motion on this page therefore covers the
 * first screen and nothing else.
 * ================================================================== */

/**
 * The vistara-amber token, as a value.
 *
 * Read out of tailwind.config.ts, because an inline border colour cannot consult
 * a Tailwind class and this card's left edge has to be set as a style — Card
 * already paints `border-vistara-border` on the shorthand, so a competing
 * `border-l-*` class would be settled by Tailwind's emit order rather than here.
 *
 * Deliberately NOT read off COLOR_MAP.DEVELOPING or CONSISTENCY_BANDS.moderate,
 * which happen to carry the same hex: those are reserved status colours, and this
 * edge is a highlight, not a status. One place in this file knows a colour by
 * value; if the token moves, this moves with it.
 */
const TVS_EDGE_INK = "#F5A623";

/* ------------------------------------------------------------------ *
 * Section 2 — the problem
 * ------------------------------------------------------------------ */

/**
 * The three figures in the stat strip, in the order they are read.
 *
 * All three are external estimates and none of them is computed by the engine,
 * which is what the footnote under the strip is for. They are held here as data
 * rather than written into the markup so that the count drives the dividers — the
 * last cell must not carry one, and that is a fact about the array, not about the
 * design.
 */
const PROBLEM_STATS: {
  figure: string;
  ink: string;
  label: string;
}[] = [
  {
    figure: "190M",
    ink: "text-vistara-accent",
    label: "adults in India with no credit score",
  },
  {
    figure: "35–40%",
    ink: "text-vistara-amber",
    label: "NBFC applicants rejected for thin files",
  },
  {
    figure: "1 in 5",
    ink: "text-vistara-green",
    label: "rejected applicants are creditworthy but invisible",
  },
];

/* ------------------------------------------------------------------ *
 * Section 3 — how it works
 * ------------------------------------------------------------------ */

const STEPS: { step: string; title: string; body: string }[] = [
  {
    step: "01",
    title: "Share your rhythms",
    body: `Connect ${MIN_STREAMS_TO_SCORE}–${BEHAVIOR_ORDER.length} data sources — your vehicle service record, UPI patterns, utility bills. We read when, not how much.`,
  },
  {
    step: "02",
    title: "We measure consistency",
    body: "Our engine calculates the standard deviation of your timing patterns across every source. The bet: people who keep steady rhythms keep steady repayments.",
  },
  {
    step: "03",
    title: "You get a transparent score",
    body: "Every factor named. Every point accounted for. A path to a better rate, not just a number.",
  },
];

/* ------------------------------------------------------------------ *
 * Section 4 — the mini strip mockup
 * ------------------------------------------------------------------ *
 * Decorative, and the only drawing on this page that is not fed by the engine —
 * the real thing is EventStrip, which needs a measured stream and a width
 * observer. So the positions are literals: an even beat per row plus a fraction
 * of a percent of human slack, which is what an on-time rhythm actually looks
 * like. Nothing here is sampled, and nothing here is claimed to be a real
 * customer.
 */

const STRIP_ROWS: {
  source: BehaviorSource;
  y: number;
  /** Per-beat drift, in percent of the strip's width. Small enough to read as "on time". */
  slack: number[];
}[] = [
  {
    source: "vehicle_service",
    y: 16,
    slack: [0, 0.5, -0.4, 0.7, -0.6, 0.3, -0.3, 0.5],
  },
  {
    source: "upi_recurring",
    y: 48,
    slack: [0, -0.4, 0.6, -0.5, 0.4, -0.3, 0.5, -0.6, 0.3, -0.4],
  },
];

/** Half-height of a beat's tick mark. Two thirds of the 32px row, as before. */
const STRIP_TICK_REACH = 11;

/** The strip's drawable span, inset so the first and last dot are not clipped. */
const STRIP_START_PCT = 5;
const STRIP_END_PCT = 95;

function beatsFor(count: number): number[] {
  if (count < 2) return [STRIP_START_PCT];
  const step = (STRIP_END_PCT - STRIP_START_PCT) / (count - 1);
  return Array.from({ length: count }, (_, i) => STRIP_START_PCT + i * step);
}

function MiniStrip() {
  // Every dot is on beat, so the strip is drawn in the colour of the tightest
  // band rather than in a raw green: the mockup depicts an exceptional rhythm,
  // and that is the token for one.
  const dotInk = bandEntry("exceptional").color;

  return (
    <svg
      aria-hidden
      width="100%"
      height="64"
      className="overflow-visible"
      role="presentation"
    >
      {STRIP_ROWS.map((row) => {
        const beats = beatsFor(row.slack.length);
        return (
          <g key={row.source}>
            {beats.map((beat) => (
              <line
                key={`tick-${row.source}-${beat}`}
                x1={`${beat}%`}
                x2={`${beat}%`}
                y1={row.y - STRIP_TICK_REACH}
                y2={row.y + STRIP_TICK_REACH}
                stroke={CHART_INK.gridline}
                strokeWidth={1}
              />
            ))}
            {beats.map((beat, i) => (
              <circle
                key={`dot-${row.source}-${beat}`}
                cx={`${beat + row.slack[i]}%`}
                cy={row.y}
                r={5}
                fill={dotInk}
              />
            ))}
          </g>
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Section 5 — the demo grid
 * ------------------------------------------------------------------ */

/**
 * Four archetypes in descending score order, which is also one profile per tier:
 * a Planner in Prime, an Adapter in Near Prime, a Reactor in Developing and an
 * Avoider on the thin-file gate. Read as the first profile of each archetype
 * group rather than by id, so a rename in the cohort cannot leave this grid
 * pointing at customers who no longer exist.
 */
const DEMO_GRID_ARCHETYPES: FinancialArchetype[] = [
  "PLANNER",
  "ADAPTER",
  "REACTOR",
  "AVOIDER",
];

const DEMO_GRID: TemporalProfile[] = DEMO_GRID_ARCHETYPES.flatMap((archetype) =>
  DEMO_CUSTOMERS_BY_ARCHETYPE[archetype].slice(0, 1),
);

/**
 * Cut a sentence to `max` characters at a boundary a reader would have chosen.
 *
 * A blind `slice(0, 60)` is what this replaces, and it was not a style question.
 * Every explanation the engine writes opens on the same shape — "<source> repeats
 * about every N days, give or take M days." — and 60 characters lands inside
 * "give or take M" on all four profiles in the grid below. The card would print
 * "give or take 11" and stop: a number with its unit and its meaning cut off,
 * which is worse than saying less. So prefer the last clause boundary in range,
 * fall back to a word boundary, and mark the cut with an ellipsis so a reader can
 * see that there was more.
 *
 * The `max / 2` floor keeps the clause rule from firing on an early comma and
 * throwing away most of the line to honour it.
 */
function clampToClause(text: string, max: number): string {
  if (text.length <= max) return text;

  const head = text.slice(0, max);
  const clause = Math.max(head.lastIndexOf(", "), head.lastIndexOf(". "));
  const at = clause > max / 2 ? clause : head.lastIndexOf(" ");

  return `${text.slice(0, at > 0 ? at : max).trimEnd()}…`;
}

/** Longest card line that fits on one row at `text-xs` in a half-width card. */
const STRENGTH_LINE_MAX = 60;

/**
 * The strongest signal in a profile, as one line of card copy.
 *
 * "Strongest" is the most points contributed, which is the only ordering the
 * factor list supports: a ScoreFactor carries `points`, `band` and an
 * `explanation`, and points are a share of the 300–900 score attributable to a
 * source, so they are never negative. The `> 0` filter is therefore a guard
 * against a source that earned nothing rather than a way of picking out positive
 * factors from negative ones — there are no negative ones to exclude.
 *
 * Returns null rather than a placeholder when a profile has no scoring factor at
 * all, so the caller omits the line instead of reserving space for it.
 */
function topStrengthLine(profile: TemporalProfile): string | null {
  const [strongest] = [...profile.factors]
    .filter((factor) => factor.points > 0)
    .sort((a, b) => b.points - a.points);

  if (strongest === undefined) return null;

  const glyph = BEHAVIOR_META[strongest.source].icon;
  return clampToClause(`${glyph} ${strongest.explanation}`, STRENGTH_LINE_MAX);
}

function DemoCard({ profile }: { profile: TemporalProfile }) {
  const { customer, tier, vistaraScore } = profile;
  const ink = COLOR_MAP[tier].color;
  const strength = topStrengthLine(profile);
  // THIN_FILE by the data gate has no score to print — the scorecard this card
  // opens says "not scored yet", and so does the card.
  const scored = profile.scoredSources.length >= MIN_STREAMS_TO_SCORE;

  // Stated once and used twice: `width` is what the bar measures, and
  // `--bar-width` is the target the fill animation travels to. They must be the
  // same value — see the note on `.score-bar-fill` in globals.css for what breaks
  // if the plain width is dropped in favour of the custom property alone.
  // Measured over SCORE_MIN–SCORE_MAX, the scale the scorecard's gauge draws, so
  // a 520 sits at the same 37% on both rather than at 58% here.
  const barWidth = scored
    ? `${(((vistaraScore - SCORE_MIN) / (SCORE_MAX - SCORE_MIN)) * 100).toFixed(1)}%`
    : "0%";

  return (
    <Link
      href={`/score/live?demo=true&id=${customer.id}`}
      className="group block rounded-card"
    >
      {/* `transition` rather than `transition-colors` alongside a second
          `transition-transform`: both are the same property, so the later variant
          would have won outright and the border would have snapped. One
          declaration covering colour and transform settles it. The lift itself is
          motion, so it is gated; the border colour is not, so it is not. */}
      <Card
        className="h-full transition duration-150 group-hover:border-vistara-accent motion-safe:group-hover:-translate-y-0.5"
        title={customer.name}
        description={`${OCCUPATION_META[customer.occupation].label} · ${customer.city}`}
        action={<TierBadge tier={tier} size="sm" />}
      >
        {/* The bar restates the figure printed under it, so it is hidden from
            assistive tech rather than given an aria-label that would announce
            the same score twice. */}
        <div
          aria-hidden
          className="h-2 w-full overflow-hidden rounded-full bg-vistara-border"
        >
          <div
            className="score-bar-fill h-full rounded-full"
            style={
              {
                width: barWidth,
                backgroundColor: ink,
                "--bar-width": barWidth,
              } as CSSProperties
            }
          />
        </div>

        <p className="tabular mt-3 flex items-baseline gap-1">
          <span className="text-2xl font-black text-vistara-text">
            {scored ? formatScore(vistaraScore) : "—"}
          </span>
          <span className="text-sm text-vistara-muted">
            {scored ? `/ ${SCORE_MAX}` : "not scored yet"}
          </span>
        </p>

        {/* Already cut to length above; `truncate` is the backstop for a viewport
            narrow enough to break even 60 characters, where the browser's own
            ellipsis is the right answer. */}
        {strength !== null ? (
          <p className="mt-2 truncate text-xs text-vistara-muted">{strength}</p>
        ) : null}
      </Card>
    </Link>
  );
}

/* ================================================================== *
 * Page
 * ================================================================== */

export default function HomePage() {
  return (
    <div>
      {/* ── 1 · Hero ──────────────────────────────────────────────────── *
          `dot-grid` is a background on the section itself, so it holds still while
          the mesh below drifts over it — a fixed beat with soft light moving
          across, which is the effect wanted and also the cheaper arrangement: the
          grid never repaints. Both layers are decorative; only the mesh, being an
          element, can be dropped for print. */}
      <section className="dot-grid relative overflow-hidden bg-vistara-dark">
        {/* Purely decorative, so it is the first thing to drop on paper. There is
            no print button on this page — Ctrl-P is the only way here — but a
            reader who has background graphics switched on would otherwise get two
            radial washes across the top of the sheet, and this element carries
            nothing to lose. */}
        <div
          aria-hidden
          className="hero-mesh pointer-events-none absolute inset-0 print:hidden"
        />

        {/* Four elements, 100ms apart, reading top to bottom. `fade-up` carries
            `animation-fill-mode: both`, so each one holds its 0% keyframe —
            invisible, 6px low — until its own delay fires. The delays are
            arbitrary properties rather than inline styles so that they sit inside
            the same `motion-safe:` gate as the animation they offset: a reduced
            motion client gets no animation-name at all, which leaves nothing for
            a delay to hold back. */}
        <div className="relative mx-auto max-w-3xl px-4 py-24 text-center">
          <h1 className="text-5xl font-black tracking-tight text-vistara-text motion-safe:animate-fade-up sm:text-6xl">
            Credit scoring that reads
            <br />
            how you live.
          </h1>

          <p className="mx-auto mt-4 max-w-xl text-xl leading-relaxed text-vistara-muted motion-safe:animate-fade-up motion-safe:[animation-delay:100ms]">
            Vistara builds your credit profile from the rhythm of your daily life
            — your vehicle care, your bills, your routines. Not your bank
            balance.
          </p>

          <div className="mt-8 flex flex-wrap justify-center gap-4 motion-safe:animate-fade-up motion-safe:[animation-delay:200ms]">
            <Button href="/apply/live" size="lg">
              Apply for a Loan →
            </Button>
            <Button href="#demo" variant="secondary" size="lg">
              See a Demo →
            </Button>
          </div>

          <div className="mt-10 flex flex-wrap justify-center gap-6 motion-safe:animate-fade-up motion-safe:[animation-delay:300ms]">
            {[
              "Designed for the AA Framework",
              "Consent-first, timestamps only",
              "Explainable by Design",
            ].map((badge) => (
              <span
                key={badge}
                className="rounded-full border border-vistara-border bg-vistara-surface px-4 py-1.5 text-xs text-vistara-muted"
              >
                {badge}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── 2 · The problem ───────────────────────────────────────────── *
          The section carries the background and the container carries the width,
          which is the split every band below repeats. Putting `max-w-4xl` on the
          element that also holds the surface colour would paint a 896px stripe
          down the middle of the page instead of a band across it. */}
      <section className="border-t border-vistara-border bg-vistara-surface">
        <div className="mx-auto max-w-4xl px-4 py-12 text-center">
          {/* `[&>div]:w-full` is doing the centring, and `justify-center` is not
              here because it cannot: SectionHeading's root already carries
              `justify-between`, both set justify-content, and the winner is decided
              by Tailwind's emit order in the stylesheet rather than by the order
              written here — `justify-between` is emitted later and takes it. So the
              heading sat hard left under a centred strip. Giving the root's single
              child a full width lets the inherited `text-center` do the work
              instead, on a property nothing is competing for. */}
          <SectionHeading
            as="h2"
            size="page"
            title="The invisible customer"
            className="text-center [&>div]:w-full"
          />

          {/* One strip, three cells, divided rather than boxed. Three cards would
              have said "here are three unrelated things"; a divided strip says the
              three are one measurement of one problem, which is the claim. The
              dividers turn on the index because the last cell must not have one,
              and they switch axis at `sm` because a vertical rule between stacked
              rows is a rule in the wrong direction. */}
          <div className="mt-8 grid grid-cols-1 sm:grid-cols-3">
            {PROBLEM_STATS.map((stat, i) => (
              <div
                key={stat.figure}
                className={[
                  "px-8 py-8 text-center",
                  i < PROBLEM_STATS.length - 1
                    ? "border-b border-vistara-border sm:border-b-0 sm:border-r"
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <p className={`tabular text-5xl font-black ${stat.ink}`}>
                  {stat.figure}
                </p>
                <p className="mt-2 text-sm text-vistara-muted">{stat.label}</p>
              </div>
            ))}
          </div>

          <p className="mt-6 text-base text-vistara-muted">
            At a TVS dealership, this is not a statistic. It is the person at the
            counter right now.
          </p>

          {/* All three figures are external estimates for the Indian market, and
              they are the only numbers on this page that Vistara did not compute.
              Saying so is cheap; being caught not saying so is not. */}
          <p className="mt-3 text-[11px] leading-relaxed text-vistara-muted">
            All three figures are widely cited industry estimates for India,
            quoted as context. Every other number on this page is computed by the
            engine from the synthetic cohort.
          </p>
        </div>
      </section>

      {/* ── 3 · How it works ──────────────────────────────────────────── */}
      <section className="bg-vistara-dark">
        <div className="mx-auto max-w-4xl px-4 py-12">
          <SectionHeading as="h2" size="page" title="How it works" />

          {/* Rows joined by connectors, not three cards side by side. Three equal
              cards are read as three options; a numbered column with a line
              through it is read as an order, and the order is the whole point —
              you cannot get a score before the engine has measured anything.

              No `gap` on the stack: the 32px connector between rows IS the gap, so
              a gap here would double it and break the line. The connector sits at
              `ml-8`, the middle of the `w-16` numeral column. */}
          <div className="mt-8">
            {STEPS.map((step, i) => (
              <div key={step.step}>
                {i > 0 ? (
                  <div aria-hidden className="ml-8 h-8 w-px bg-vistara-border" />
                ) : null}

                <div className="flex gap-4">
                  <p
                    aria-hidden
                    className="tabular w-16 shrink-0 text-5xl font-black text-vistara-accent/20"
                  >
                    {step.step}
                  </p>

                  <div className="min-w-0 flex-1">
                    <h3 className="text-lg font-semibold tracking-tight text-vistara-text">
                      {step.title}
                    </h3>
                    <p className="mt-2 max-w-lg text-sm leading-relaxed text-vistara-muted">
                      {step.body}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── 4 · The TVS advantage ─────────────────────────────────────── */}
      <section className="border-t border-vistara-border bg-vistara-surface">
        <div className="mx-auto max-w-4xl px-4 py-12">
          <Card
            className="border-l-[3px]"
            style={{ borderLeftColor: TVS_EDGE_INK }}
          >
            <p className="mb-2 text-xs uppercase tracking-widest text-vistara-amber">
              Only at TVS Credit
            </p>

            <h2 className="text-lg font-semibold tracking-tight text-vistara-text">
              Your vehicle is your strongest signal.
            </h2>

            <p className="mt-2 leading-relaxed text-vistara-muted">
              Your TVS service record cannot be borrowed from another lender. It
              cannot be gamed. It can only be earned — one on-time visit at a
              time. No other credit engine in India has access to this data.
            </p>

            {/* Both children are exactly the strip's 64px, so `items-center` lines
                the two labels up with the two rows instead of approximately with
                them. The padding is the arithmetic that puts each 11px label on its
                row's centre line: rows sit at y=16 and y=48, half a line box is
                5.5px, so 10.5px of padding at each end lands both on the dot. The
                strip carries no top margin of its own for the same reason — a
                margin inside one flex child would offset it against the other. */}
            <div className="mt-6 flex items-center gap-4">
              <div className="flex h-16 w-[7.5rem] shrink-0 flex-col justify-between py-[10.5px] text-[11px] leading-none text-vistara-muted">
                <span>{BEHAVIOR_META.vehicle_service.short}</span>
                <span>{BEHAVIOR_META.upi_recurring.short}</span>
              </div>
              <div className="min-w-0 flex-1">
                <MiniStrip />
              </div>
            </div>

            <p className="mt-4 text-[12px] leading-relaxed text-vistara-muted">
              Two rhythms, plotted on time alone. Illustrative — the strips on a
              real scorecard are drawn from measured events.
            </p>
          </Card>
        </div>
      </section>

      {/* ── 5 · Demo ──────────────────────────────────────────────────── *
          `id` and `scroll-mt-20` belong on the outer section, which is what the
          hero's "See a Demo" anchor actually scrolls to. */}
      <section id="demo" className="scroll-mt-20 bg-vistara-dark">
        <div className="mx-auto max-w-4xl px-4 py-12">
          <SectionHeading
            as="h2"
            size="page"
            title={`See Vistara score ${DEMO_GRID.length} sample profiles`}
            description={`Each profile was built from ${OBSERVATION_MONTHS} months of synthetic history, generated from a fixed seed against a frozen reference date. Click any card to see the full scorecard.`}
          />

          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {DEMO_GRID.map((profile) => (
              <DemoCard key={profile.customer.id} profile={profile} />
            ))}
          </div>

          {/* A text link, not a third call to action: the two buttons in the hero
              are the page's asks, and this is an offer to read further. */}
          <p className="mt-8 text-center text-sm text-vistara-muted">
            {/* inline-flex so the mobile min-height can apply at all: min-height
                does nothing to a non-replaced inline box, which is what an anchor
                is by default. */}
            <Link
              href="/method"
              className="inline-flex items-center transition-colors hover:text-vistara-text max-sm:min-h-[44px]"
            >
              How the score works →
            </Link>
          </p>
        </div>
      </section>

      {/* ── 6 · Closing band ──────────────────────────────────────────── *
          A section, not a <footer>: layout.tsx already owns the page's footer
          landmark, and two of them would give a screen reader two "footer"
          regions to choose between. This one is the product sign-off; the one
          below it is the prototype and synthetic-data notice. */}
      <section className="border-t border-vistara-border bg-vistara-surface py-8 text-center">
        <p className="text-sm text-vistara-muted">
          Vistara — Alternative Credit Engine for the Invisible Customer
        </p>
        <p className="mt-1 text-sm text-vistara-muted">
          Built for TVS Credit Services · 2026
        </p>
      </section>
    </div>
  );
}
