"use client";

/**
 * /score/live — the result of a form the user actually filled in.
 *
 * WHY THIS IS A SEPARATE ROUTE. /score is a Server Component, and every figure
 * on it is read from a profile resolved on the server from `?id=`. A live result
 * lives in sessionStorage, which only the browser can see, so the two cannot
 * share a render path without making the whole scorecard client-rendered — which
 * would cost the server/hydration-agreement guarantee that page is built on, for
 * the sake of a code path the stage demo does not use. So the live path gets its
 * own route and its own smaller scorecard, and /score stays untouched.
 *
 * THREE WAYS IN. `?source=form` after a submission, `?demo=true&id=…` for a named
 * cohort profile (the landing page's demo grid links here), and a bare visit,
 * which falls back to the cohort's first customer behind a banner saying so. The
 * query string wins over sessionStorage: somebody who clicked a named profile must
 * get that profile even if they filled in the form earlier in the same tab.
 *
 * SCOPE. The score hero, the loan offer it earns, the event strips underneath it,
 * the factors that built it and the ranked path to the next band. No gauge and no
 * bureau comparison — those live on /score, which this page links to.
 *
 * NOTHING HERE RE-SCORES ANYTHING, and that is worth being exact about, because
 * three of the sections look like they would have to. The factor columns split
 * `profile.factors`, which `scoreProfile` already built. The path panel slices
 * `profile.improvementActions`, whose point estimates the engine priced by
 * re-running itself on this customer's own file. The only figures this page
 * computes are the EMI and whether the tier caps the request, both arithmetic
 * over TIER_LOAN_CONFIG. No engine function is called from this file at all.
 *
 * The strips render the same EventStrip component /score uses, fed the same
 * `BehaviorStream` objects, so the two pages cannot drift into drawing the same
 * evidence two different ways.
 */

import { memo, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import {
  ARCHETYPE_META,
  BEHAVIOR_META,
  BEHAVIOR_ORDER,
  COLOR_MAP,
  CONSISTENCY_BANDS,
  DEMO_CUSTOMERS,
  LOAN_REQUEST_KEY,
  MIN_STREAMS_TO_SCORE,
  OBSERVATION_DAYS,
  OBSERVATION_MONTHS,
  OCCUPATION_META,
  SCORE_MAX,
  SCORE_MIN,
  TIER_LOAN_CONFIG,
  TIER_THRESHOLDS,
  bandEntry,
  defaultStreamAvailability,
  formatDate,
  formatINR,
  formatScore,
  getDemoCustomer,
  ordinalDay,
  type ConsistencyBand,
  type FinancialArchetype,
  type ScoreFactor,
  type TemporalProfile,
  type Tier,
} from "@/lib";
import { useCountUp } from "@/lib/hooks/useCountUp";
import {
  clearStoredProfile,
  readStoredProfile,
} from "@/lib/hooks/useVistara";
// Deep import, deliberately. rng.ts is the determinism substrate and is kept out
// of the @/lib barrel so that every reach for it stays visible and countable —
// see the note in lib/index.ts. This is the same import /score, /dashboard and
// EventStrip itself use.
import { REFERENCE_DATE, addDays, clamp } from "@/lib/rng";
import { EventStrip } from "@/components/charts";
import { Button, Card, Meter, SectionHeading } from "@/components/ui";

/**
 * `reading` is not a loading spinner for slow work — the read is synchronous and
 * instant. It exists because sessionStorage cannot be touched during render
 * without the server's HTML and the client's first paint disagreeing. So the
 * first paint commits to nothing, the effect reads, and the page resolves. The
 * alternative — rendering the fallback immediately — would flash a demo
 * customer's name at someone who just submitted their own.
 */
type ViewState =
  | { status: "reading" }
  /** `?source=form` was set but there is no profile — /apply/live is the answer. */
  | { status: "redirecting" }
  | { status: "live"; profile: TemporalProfile; loanRequested: number }
  /** `?demo=true&id=…` — a cohort profile asked for by name from the landing page. */
  | { status: "demo"; profile: TemporalProfile; loanRequested: number }
  | { status: "fallback"; profile: TemporalProfile; loanRequested: number };

/** True once a profile exists to render. The two negatives are the only states
 *  without one, so testing for them keeps every new resolved status working. */
function isResolved(
  view: ViewState,
): view is Extract<ViewState, { profile: TemporalProfile }> {
  return view.status !== "reading" && view.status !== "redirecting";
}

const FALLBACK_PROFILE: TemporalProfile = DEMO_CUSTOMERS[0];

/**
 * The left edge of every event strip, stated once so the caption and the strips
 * cannot disagree about the window.
 *
 * Module scope is safe in a client component here only because both inputs are
 * frozen: REFERENCE_DATE is a literal and OBSERVATION_DAYS is a constant, so this
 * is the same instant in the build's prerender and in the browser. A `new Date()`
 * here would be the exact hydration bug the whole rng module exists to prevent.
 */
const WINDOW_START = addDays(REFERENCE_DATE, -OBSERVATION_DAYS);

/**
 * What the applicant asked for, written by /apply/live beside the profile.
 *
 * Absent, unparseable and non-positive all collapse to 0, which the render reads
 * as "no request to compare against" — a missing key must cost one line, never
 * the scorecard.
 */
function readLoanRequested(): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.sessionStorage.getItem(LOAN_REQUEST_KEY);
    if (raw === null) return 0;
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * The one-word reading of each archetype, for the badge under the score.
 *
 * Deliberately not derived from `ARCHETYPE_META.blurb`: the blurb is two
 * sentences written to be read aloud to a customer, so truncating it yields
 * "Acts ahead of every…". A badge needs a label, not a prefix.
 */
const ARCHETYPE_DESCRIPTOR: Record<FinancialArchetype, string> = {
  PLANNER: "Highly Consistent",
  REACTOR: "Fast Recovery",
  ADAPTER: "Selectively Consistent",
  AVOIDER: "Developing Rhythm",
};

/**
 * Standard reducing-balance EMI: P·r·(1+r)^n / ((1+r)^n − 1).
 *
 * The two guards are not defensive padding. THIN_FILE carries a 0% rate and a
 * 0-month tenure in TIER_LOAN_CONFIG, which puts (1+r)^n − 1 at exactly zero —
 * the textbook formula returns NaN there, so the tier that most needs handling
 * honestly is the one that would otherwise print "₹NaN / month". The render
 * never reaches this for THIN_FILE, but a formula that is only correct because
 * of where it is called is a formula waiting to be called somewhere else.
 */
function monthlyEmi(
  principal: number,
  annualRatePercent: number,
  months: number,
): number {
  if (principal <= 0 || months <= 0) return 0;
  const r = annualRatePercent / 12 / 100;
  if (r === 0) return principal / months;
  const growth = Math.pow(1 + r, months);
  return (principal * r * growth) / (growth - 1);
}

/**
 * Which column a factor belongs in.
 *
 * CONSISTENCY_BANDS is ordered tightest-first, so the question "is this a
 * strength?" is just "is it in the top half of the band table?". Derived from
 * the array's own length rather than written as a list of band names, so adding
 * a fifth band cannot silently reclassify an existing one — and it is the same
 * cut the engine already makes when it decides whether a source is worth
 * offering a tightening action for (`bandIndex <= 0` in consistency.ts only
 * skips the very top band, so everything below it has headroom by definition).
 */
function isStrengthBand(band: ConsistencyBand): boolean {
  const rank = CONSISTENCY_BANDS.findIndex((entry) => entry.band === band);
  // findIndex returning -1 for an unknown band lands it in the strength column,
  // so it is treated as the worst case instead: unknown means unproven.
  if (rank === -1) return false;
  return rank * 2 < CONSISTENCY_BANDS.length;
}

/**
 * The two column inks, read off the band table rather than written as hex.
 *
 * They have to be inline styles rather than Tailwind classes because an
 * arbitrary `border-l-[#...]` value needs a JIT safelist entry that
 * tailwind.config.ts does not carry. Sourcing them from CONSISTENCY_BANDS
 * instead of literals keeps them from drifting from the palette the meters and
 * the contribution rows already use: the top band's colour *is* vistara-green
 * and moderate's *is* vistara-amber, so this is the same two colours the brief
 * asks for, expressed as the tokens they come from.
 */
const STRENGTH_INK = bandEntry("exceptional").color;
const HEADROOM_INK = bandEntry("moderate").color;

/**
 * How long "Copied" stays on the button. Long enough to be read, short enough
 * that the button is back to naming its own action before anyone reaches for it
 * again.
 */
const COPY_FEEDBACK_MS = 2000;

/**
 * The two take-away buttons at the foot of the page, sharing one class string so
 * that a pair the eye reads as a pair cannot drift into two shapes.
 *
 * Not the Button primitive, and not a new size on it: these are wider and rounder
 * than any of its three, and adding a fourth size to serve two buttons on one
 * route would put an unused variant in front of every other call site. The touch
 * floor is the same `max-sm:min-h-[44px]` Button carries in its own BASE, which is
 * the one thing here that is a rule rather than a look.
 */
const TERMINAL_BUTTON_CLASS =
  "rounded-xl border border-vistara-border px-6 py-2.5 text-sm text-vistara-muted transition-colors hover:border-vistara-accent hover:text-vistara-text max-sm:min-h-[44px]";

/**
 * When an improvement action pays off, in the customer's words.
 *
 * The engine prices actions in whole months (`horizonMonths`), not days, and
 * nothing in the catalogue is shorter than a month — so there is no "this week"
 * branch to write. Inventing one would promise a turnaround the model cannot
 * price.
 */
function horizonLabel(months: number): string {
  if (months <= 1) return "This month";
  return `Within ${months} months`;
}

/** How many of the engine's ranked actions the panel shows. */
const PATH_ACTIONS_SHOWN = 3;

/**
 * How many factors each column shows. `profile.factors` arrives sorted by points
 * contributed, so taking the head of each filtered list takes the ones that
 * matter most — the strongest strengths and the costliest weaknesses.
 */
const FACTORS_PER_COLUMN = 3;

/**
 * The distance to the next band, as a heading, a sentence and a ratio.
 *
 * All four branches read their boundaries out of TIER_THRESHOLDS rather than
 * repeating 550/650/750, so the bar and the sentence cannot disagree with the
 * engine that assigned the tier. Returns null at PRIME, which is the signal to
 * omit the panel: there is no next band to describe.
 */
function tierGap(
  tier: Tier,
  score: number,
  signalCount: number,
): { title: string; line: string; ratio: number; ariaLabel: string } | null {
  if (tier === "PRIME") return null;

  if (tier === "NEAR_PRIME") {
    const floor = TIER_THRESHOLDS.NEAR_PRIME;
    const ceiling = TIER_THRESHOLDS.PRIME;
    return {
      title: "Your path to Prime",
      line: `${ceiling - score} points to Prime`,
      ratio: (score - floor) / (ceiling - floor),
      ariaLabel: "Progress from Near Prime to Prime",
    };
  }

  if (tier === "DEVELOPING") {
    const floor = TIER_THRESHOLDS.DEVELOPING;
    const ceiling = TIER_THRESHOLDS.NEAR_PRIME;
    return {
      title: "Your path to Near Prime",
      line: `${ceiling - score} points to Near Prime`,
      ratio: (score - floor) / (ceiling - floor),
      ariaLabel: "Progress from Developing to Near Prime",
    };
  }

  /**
   * THIN_FILE is two findings wearing one label — the same split the page body
   * makes — and the bar has to measure whichever one is actually binding. For a
   * customer short of signals that is coverage; for one who shared plenty and
   * scored low it is points. Using the signal-count ratio for both would park
   * the bar at 100% beside a sentence saying they are forty points short.
   */
  if (signalCount < MIN_STREAMS_TO_SCORE) {
    const short = MIN_STREAMS_TO_SCORE - signalCount;
    return {
      title: "Building your score",
      line: `Share ${short} more ${short === 1 ? "signal" : "signals"} to reach a scored result`,
      ratio: signalCount / MIN_STREAMS_TO_SCORE,
      ariaLabel: `${signalCount} of ${MIN_STREAMS_TO_SCORE} signals needed for a scored result`,
    };
  }

  return {
    title: "Building your score",
    line: `${TIER_THRESHOLDS.DEVELOPING - score} points to Developing`,
    ratio: (score - SCORE_MIN) / (TIER_THRESHOLDS.DEVELOPING - SCORE_MIN),
    ariaLabel: "Progress towards the Developing band",
  };
}

/**
 * The event strips, memoised on the profile.
 *
 * WHY THIS IS A SEPARATE COMPONENT AND NOT INLINE JSX. The score count-up sets
 * state once per animation frame for 1.4 seconds, and it starts on the very
 * commit that mounts these strips. Rendered inline, the whole subtree — around a
 * thousand SVG nodes across five sources, each rebuilding its own beat grid and
 * month labels out of Date arithmetic — was being rebuilt and re-reconciled on
 * every one of those ~75 renders, for a number that appears nowhere inside it.
 * /score never paid this cost because it is a Server Component that renders
 * once. The memo lets React skip the subtree entirely while the score counts.
 *
 * The prop is the whole `profile` rather than a ready-made `streams` array on
 * purpose: `profile` is the object held in `view` state and is therefore
 * referentially stable across the count-up, whereas an array derived by the
 * caller would be a fresh identity on every render and would defeat the memo.
 */
const RhythmStrips = memo(function RhythmStrips({
  profile,
}: {
  profile: TemporalProfile;
}) {
  /**
   * In BEHAVIOR_ORDER rather than in `profile.streams` order.
   *
   * The engine builds streams in whatever order the consent flags came in, so
   * iterating them directly would let two applicants who shared the same four
   * signals see them in different sequences — and would let this page disagree
   * with /score and with the contribution rows below it about which signal is
   * first. BEHAVIOR_ORDER exists to be the one answer to that.
   *
   * Unlike /score, an absent signal renders nothing at all rather than a
   * cold-start placeholder. On /score an empty row is a teaching moment about a
   * signal the customer could add; here it is most often a box they chose not to
   * tick two screens ago, and drawing five rows to leave two of them empty reads
   * as five failures. The disclosure below carries the absence instead, and the
   * contribution card names the missing signals outright.
   */
  const strips = BEHAVIOR_ORDER.flatMap((source) => {
    const stream = profile.streams.find((entry) => entry.source === source);
    return stream === undefined ? [] : [stream];
  });

  return (
    <>
      {/* One EventStrip per stream, which is the component's actual contract —
          it takes a single BehaviorStream. The shared axis is not a product of
          batching them into one instance: each strip derives its own edges from
          the frozen REFERENCE_DATE and the same OBSERVATION_DAYS window, so
          they land identically. Verified across the cohort — every stream's
          first event sits inside the window, so start and end resolve to
          WINDOW_START and REFERENCE_DATE for all of them. */}
      <div className="space-y-8">
        {strips.map((stream) => (
          <EventStrip
            key={stream.source}
            stream={stream}
            expectedIntervalDays={stream.expectedIntervalDays}
            forgivenGapIndices={
              profile.metrics.find((metric) => metric.source === stream.source)
                ?.excludedGapIndices
            }
          />
        ))}
      </div>

      {/* Absence is stated without attributing a cause, because this page cannot
          tell the two causes apart and they are not the same admission. A signal
          is missing either because it was not shared, or because
          `defaultStreamAvailability` judged it implausible — a 22-year-old gig
          worker who ticks "vehicle service" has consented to a history they do
          not have yet, and useVistara intersects consent with that rule. Saying
          "signals not shared are not shown" to that applicant tells them they
          withheld something they explicitly handed over. */}
      {profile.dataCompleteness < 1 ? (
        <p className="mt-6 border-t border-vistara-border pt-4 text-[12px] leading-relaxed text-vistara-muted">
          A signal with no events on file is not drawn — whether it was never
          shared, or has no history on it yet.{" "}
          <span className="tabular text-vistara-text">
            {profile.scoredSources.length}
          </span>{" "}
          of {BEHAVIOR_ORDER.length} observed.
        </p>
      ) : null}
    </>
  );
});

export default function LiveScorePage() {
  const [view, setView] = useState<ViewState>({ status: "reading" });
  const router = useRouter();

  /**
   * Called above the early return, and with a target of 0 until the read
   * resolves, because hook order cannot be allowed to depend on `view`. Nobody
   * sees that 0 — the "reading" branch renders no score at all — and when the
   * real target arrives the hook restarts from zero, which is exactly the
   * count-up this is for.
   */
  const scoreTarget = isResolved(view) ? view.profile.vistaraScore : 0;
  const countedScore = useCountUp(scoreTarget);

  /**
   * Whether the tier-gap bar has been released to its final width.
   *
   * Declared here with the other hooks rather than beside the bar it drives,
   * because the bar renders below an early return and hook order cannot be
   * allowed to depend on `view`.
   */
  const [barGrown, setBarGrown] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Nothing to animate until the read resolves and the bar actually exists.
    // Spelled out rather than routed through isResolved(), because that predicate
    // takes the whole `view` and the effect must depend on nothing but its status
    // — otherwise a `clear()` re-runs the two frames and re-grows a settled bar.
    if (view.status === "reading" || view.status === "redirecting") return;

    // Two frames, not one. The first lets React's commit of the 0%-width fill
    // reach layout; the second flips to the final width so the transition has a
    // starting value to animate from. Setting it in the same frame as the mount
    // makes the browser coalesce both widths into one style recalculation and
    // the bar simply appears full.
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => setBarGrown(true));
    });
    return () => {
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
    };
  }, [view.status]);

  /**
   * Reverts the copy button's label. Keyed off `copied` rather than set inside
   * the click handler so the timer is owned by the effect that can cancel it —
   * a bare setTimeout in the handler survives unmount and fires setState on a
   * dead component if the user navigates within the two seconds.
   */
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    // window.location, not useSearchParams(): this effect already runs only in
    // the browser and only after mount, whereas useSearchParams() in a client
    // component forces the route out of static prerendering unless it is wrapped
    // in its own Suspense boundary. One read of a query string is not worth
    // restructuring the page for.
    const params = new URLSearchParams(window.location.search);
    const fromForm = params.get("source") === "form";

    /**
     * `?demo=true&id=…` — a named cohort profile, and it wins over anything in
     * sessionStorage. The landing page's demo cards point here, and somebody who
     * clicked "Priya V." must get Priya V. even if they filled in the form
     * earlier in the same tab. `id` is required and must resolve: a typo lands on
     * the ordinary paths below rather than silently showing a different customer.
     */
    if (params.get("demo") === "true") {
      const id = params.get("id");
      const requested = id === null ? undefined : getDemoCustomer(id);
      if (requested !== undefined) {
        // Zero, not `readLoanRequested()`. A cohort profile never asked for a
        // loan, so there is no request to cap against and no requested figure to
        // print — borrowing the live applicant's number would attribute it to
        // somebody who never typed it.
        setView({ status: "demo", profile: requested, loanRequested: 0 });
        return;
      }
    }

    const stored = readStoredProfile();

    if (stored === null) {
      // Arriving from the form with nothing stored means the write failed or the
      // tab was replaced. Showing a demo customer's name to someone who just
      // submitted their own would be the worst possible reading of that, so send
      // them back to the form instead.
      if (fromForm) {
        setView({ status: "redirecting" });
        router.replace("/apply/live");
        return;
      }
      setView({
        status: "fallback",
        profile: FALLBACK_PROFILE,
        loanRequested: 0,
      });
      return;
    }

    setView({
      status: "live",
      profile: stored,
      loanRequested: readLoanRequested(),
    });
  }, [router]);

  const clear = useCallback(() => {
    clearStoredProfile();
    setView({ status: "fallback", profile: FALLBACK_PROFILE, loanRequested: 0 });
  }, []);

  if (view.status === "reading" || view.status === "redirecting") {
    return (
      <div className="mx-auto max-w-4xl px-5 py-10 sm:py-14">
        <p className="text-[13px] text-vistara-muted">
          {view.status === "redirecting" ? (
            <>
              No submitted profile in this session &mdash; returning to the
              application&hellip;
            </>
          ) : (
            <>Reading this session&rsquo;s result&hellip;</>
          )}
        </p>
      </div>
    );
  }

  const { profile } = view;
  const { customer, factors } = profile;
  const occupation = OCCUPATION_META[customer.occupation];
  const signalCount = profile.scoredSources.length;

  /**
   * Where the back link goes, stated once for the two places it renders.
   *
   * A demo arrival came from the landing page's profile grid, not from the form,
   * so "back" means that grid. Sending them to /apply/live instead would offer a
   * three-step form as the way out of a scorecard they only wanted to look at.
   */
  const exit =
    view.status === "demo"
      ? { href: "/#demo", label: "← Back to the demo profiles" }
      : { href: "/apply/live", label: "← Back to the application" };

  const fullScorecardId =
    view.status === "live" ? FALLBACK_PROFILE.customer.id : customer.id;

  // The two THIN_FILE code paths are different findings and must not share a
  // sentence. One is "we could not observe enough of you to score"; the other is
  // "we observed you fully and the rhythm scored low". Reading dataCompleteness
  // separately from the tier is what tells them apart.
  const thinByCoverage =
    profile.tier === "THIN_FILE" && signalCount < MIN_STREAMS_TO_SCORE;
  const thinByScore =
    profile.tier === "THIN_FILE" && signalCount >= MIN_STREAMS_TO_SCORE;

  const tierInk = COLOR_MAP[profile.tier];
  /**
   * THIN_FILE is the only tier whose badge does not say its own name, because
   * THIN_FILE is two findings wearing one label — see the split above. The other
   * three read straight off COLOR_MAP rather than repeating four strings here.
   */
  const tierLabel = thinByCoverage
    ? "Thin File — Insufficient Data"
    : thinByScore
      ? "Thin File — Below the Developing Floor"
      : tierInk.label;

  const archetype = ARCHETYPE_META[profile.financialArchetype];

  // TIER_LOAN_CONFIG rather than profile.maxLoanAmount/interestRate. The profile
  // does carry those two — scoreProfile copies them out of this very table — but
  // it does not carry tenureMonths, and reading two of the three terms from one
  // place and the third from another is how they come to disagree.
  const loan = TIER_LOAN_CONFIG[profile.tier];
  /**
   * A request of 0 means there is nothing to cap against: the fallback path, or
   * a session whose stored request was lost. `Math.min` alone would read that
   * absence as a request for nothing and offer ₹0 to a Prime customer, so an
   * absent request falls back to the tier ceiling.
   */
  const loanOffered =
    view.loanRequested > 0
      ? Math.min(view.loanRequested, loan.maxLoanAmount)
      : loan.maxLoanAmount;
  const emi = monthlyEmi(loanOffered, loan.interestRate, loan.tenureMonths);
  const cappedByTier = view.loanRequested > loan.maxLoanAmount;
  // Above every tier's ceiling: no score unlocks it, so say that instead. Only
  // reachable through a request stored before the slider was capped at Prime.
  const programmeMax = TIER_LOAN_CONFIG.PRIME.maxLoanAmount;
  const aboveProgramme = view.loanRequested > programmeMax;

  /**
   * The factor columns.
   *
   * `profile.factors` is already the scorecard — `scoreProfile` runs
   * `buildScoreFactors` and stores the result, sorted by points contributed —
   * so this splits a list it was handed rather than recomputing one. Nothing on
   * this page calls into the engine.
   *
   * The split is by band, not by sign: a ScoreFactor's `points` is a share of
   * the 300–900 score attributable to that source, so it is always positive and
   * there is no such thing as a factor that subtracted. What separates the two
   * columns is how tight the rhythm is, which is exactly what `band` records.
   */
  const strengths = factors.filter((factor) => isStrengthBand(factor.band));
  const headroom = factors.filter((factor) => !isStrengthBand(factor.band));

  /**
   * What tightening a wobbling signal is worth, in the engine's own arithmetic.
   *
   * The amber column needs a number, and the honest one is not the factor's own
   * contribution — that is something it earned. It is the gain the engine
   * already priced for fixing it, by re-scoring this customer's own file with
   * that one change applied (`projectedScore` in consistency.ts). Joining on
   * `lever` is the same join /score makes. Not every weak signal has a matching
   * action: the engine drops anything worth under five points and keeps only the
   * best five, so this can legitimately come back undefined.
   */
  const gainFor = (factor: ScoreFactor): number | undefined =>
    profile.improvementActions.find((action) => action.lever === factor.source)
      ?.potentialPoints;

  const seasonalCount = profile.metrics.filter(
    (metric) => metric.seasonalityAdjusted,
  ).length;

  /**
   * Path to Prime. Skipped at PRIME, where there is no next band to describe,
   * and skipped when the engine priced no action worth showing — an empty
   * "here is what to do next" panel is worse than no panel.
   */
  const gap = tierGap(profile.tier, profile.vistaraScore, signalCount);
  const actions = profile.improvementActions.slice(0, PATH_ACTIONS_SHOWN);
  // Not-yet-observed signals this customer could actually start sharing.
  const plausible = defaultStreamAvailability(profile.customer);
  const shareable = profile.missingSources.filter((source) => plausible[source]);

  /**
   * The scorecard as plain text, in the order the page states it.
   *
   * `tierLabel` rather than COLOR_MAP's label so the pasted summary says what
   * the screen says — including the THIN_FILE split, where the badge reads
   * "Thin File — Below the Developing Floor" and a bare "Thin File" in the clipboard
   * would contradict it. The EMI goes in unrounded for the reason the offer card
   * gives: formatINR rounds to the rupee itself.
   */
  const summaryLines = [
    thinByCoverage
      ? `Vistara Score: not scored — ${signalCount} of ${BEHAVIOR_ORDER.length} signals observed, ${MIN_STREAMS_TO_SCORE} needed (${tierLabel})`
      : `Vistara Score: ${formatScore(profile.vistaraScore)} / ${SCORE_MAX} (${tierLabel})`,
    `Archetype: ${archetype.label}`,
    `Signals: ${signalCount} of ${BEHAVIOR_ORDER.length} observed`,
  ];
  // The EMI date belongs to a loan, so it travels with the offer: a Thin File
  // has neither.
  if (profile.tier !== "THIN_FILE") {
    summaryLines.push(
      `Loan offer: ${formatINR(loanOffered)} at ${loan.interestRate}% · EMI ${formatINR(emi)}/month`,
      `Recommended EMI date: ${ordinalDay(profile.recommendedEmiDate)} of each month`,
    );
  }

  /**
   * Not a useCallback: it closes over the profile and is handed to an
   * unmemoised Button, so a stable identity would buy nothing, and it has to be
   * declared below the early return where `profile` exists.
   */
  const copySummary = () => {
    // Absent on http origins and in older embedded webviews. This button is a
    // convenience beside a scorecard that is fully readable on screen, so a
    // missing API is silence — an error toast would report a problem the
    // customer has no way to act on.
    if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
      return;
    }
    navigator.clipboard.writeText(summaryLines.join("\n")).then(
      () => setCopied(true),
      () => {
        // A denied clipboard permission reads the same as an absent API.
      },
    );
  };

  /**
   * `print-score-root` exists for exactly one rule: `#print-score-root::before`
   * in globals.css hangs the provenance line off the top of the printout. It sits
   * on this wrapper div rather than on any of the semantic elements inside,
   * because generated content on a <section> or an <h1> would land inside a
   * landmark and be read out as part of it. One id, one div, one rule.
   */
  return (
    <div id="print-score-root" className="mx-auto max-w-4xl px-5 py-10 sm:py-14">
      {/* The breadcrumb and the exits at the foot of the page are the same link,
          and neither is a thing a sheet of paper can offer. */}
      <Button
        href={exit.href}
        variant="ghost"
        size="sm"
        className="-ml-3 print:hidden"
      >
        {exit.label}
      </Button>

      <div className="mt-6">
        <SectionHeading
          as="h1"
          size="page"
          eyebrow={
            view.status === "live"
              ? `Live result · ${customer.id}`
              : view.status === "demo"
                ? `Cohort profile · ${customer.id}`
                : "Sample result"
          }
          title={customer.name}
          description={
            <>
              {occupation.label} · {customer.city} · age {customer.age} ·{" "}
              <span className="text-vistara-text">
                {formatINR(customer.monthlyIncome)}
              </span>{" "}
              a month declared. Scored on the timing of recurring events — no
              amounts, no categories.
            </>
          }
        />
      </div>

      {view.status === "fallback" ? (
        <p className="mt-5 rounded-card border border-vistara-border bg-vistara-surface px-4 py-3 text-[13px] leading-relaxed text-vistara-muted">
          Nothing was submitted in this browser session, so{" "}
          <span className="text-vistara-text">{customer.name}</span> from the
          twelve-customer cohort is shown instead.{" "}
          <a className="text-vistara-text underline" href="/apply/live">
            Fill in the application
          </a>{" "}
          to score a new applicant.
        </p>
      ) : null}

      {/* The demo banner is a different sentence from the fallback one on
          purpose. Fallback means "we found nothing of yours"; this means "you
          asked for this person by name" — and it is the one place that has to say
          out loud that the figures below belong to a generated profile. */}
      {view.status === "demo" ? (
        <p className="mt-5 rounded-card border border-vistara-border bg-vistara-surface px-4 py-3 text-[13px] leading-relaxed text-vistara-muted">
          A worked example from the {DEMO_CUSTOMERS.length}-customer cohort —{" "}
          {OBSERVATION_MONTHS} months of synthetic history generated from a fixed
          seed, with no real borrower data.{" "}
          <a className="text-vistara-text underline" href="/apply/live">
            Fill in the application
          </a>{" "}
          to score somebody new.
        </p>
      ) : null}

      {/* ── The score ────────────────────────────────────────────────── */}
      <section className="flex flex-col items-center py-12 text-center">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-vistara-muted">
          Vistara score
        </p>

        {/* The counting digits are hidden from assistive tech and the settled
            figure is announced once beside them. A live count-up in the
            accessibility tree is read either as a stream of meaningless
            intermediate numbers or as whatever value the cursor happened to
            land on — and neither of those is the score. */}
        {/* THE SCORE, TWICE, AND ONLY EVER ONE OF THEM AT A TIME.
            This one counts and is the only one anybody sees on a screen.

            It cannot be the one that prints. What it renders is `countedScore`,
            which is a value climbing towards the real one over COUNT_UP_MS, and
            print is a snapshot of whenever the button was pressed. Printing this
            element put "58" on a scorecard whose score is 828 — found by rendering
            the page through Chrome's print path, not by reading this file, because
            nothing about the markup says when the reader reaches for Cmd-P.

            No CSS could have fixed it: the counting figure is JavaScript state,
            and `@media print` can restyle an element but not tell it a different
            number. Hence a twin, which is what the print:hidden / print:block pair
            is for. */}
        <p
          aria-hidden
          className="tabular mt-3 text-7xl font-black leading-none tracking-tight print:hidden"
          style={{ color: tierInk.color }}
        >
          {thinByCoverage ? "—" : formatScore(countedScore)}
        </p>

        {/* The settled figure, for paper only. Reads `profile.vistaraScore`
            directly rather than the hook, so it is right from the first commit and
            cannot be caught mid-count.

            `aria-hidden` like its twin, because the announced score is the sr-only
            sentence below — two hidden figures and one spoken sentence, rather
            than a screen reader meeting the same number three times. The ink is a
            token rather than the inline tier colour, which is what lets the
            `[class*="text-vistara"]` rule in globals.css blacken it for print. */}
        <p
          aria-hidden
          className="tabular mt-3 hidden text-7xl font-black leading-none tracking-tight text-vistara-text print:block"
        >
          {thinByCoverage ? "—" : formatScore(profile.vistaraScore)}
        </p>
        {/* A gated file has no score. The engine still adds up what it saw, but
            two clean signals sum to 900, and a 900 beside "insufficient data"
            reads as a perfect score refused. The per-signal breakdown below
            keeps the arithmetic visible. */}
        <p aria-hidden className="mt-2 text-[13px] text-vistara-muted">
          {thinByCoverage
            ? `not scored yet · ${MIN_STREAMS_TO_SCORE} signals needed`
            : `/ ${SCORE_MAX}`}
        </p>
        <p className="sr-only">
          {thinByCoverage
            ? `Not scored yet: ${signalCount} of ${BEHAVIOR_ORDER.length} signals observed, and the engine needs ${MIN_STREAMS_TO_SCORE}.`
            : `Vistara score ${formatScore(profile.vistaraScore)} out of ${SCORE_MAX}.`}
        </p>

        {/* Tier colour carries the glyph and the label with it, never on its
            own — the accessibility rule COLOR_MAP is documented under. The chip
            is a tinted ring rather than a solid block because tier-coloured text
            on a tier-coloured fill is the one combination that cannot be read.

            THE DELAY. The count-up above runs for COUNT_UP_MS (1400ms), and this
            chip is the verdict that figure is climbing towards, so it arrives at
            1200ms — while the last digits are still settling. `fade-in` carries
            `animation-fill-mode: both`, so the chip holds opacity 0 through the
            delay rather than flashing in and out.

            Both classes sit inside `motion-safe:`, which is what makes this safe
            rather than merely quiet: a reduced-motion client gets no
            animation-name, so there is nothing for the delay to hold back and the
            chip paints immediately — and useCountUp already returns its settled
            value on that client, so the two agree. The element mounts in the same
            commit that starts the count (both are behind the sessionStorage read),
            so the 1200ms is measured from the same instant. */}
        <span
          className="mt-5 inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-semibold motion-safe:animate-fade-in motion-safe:[animation-delay:1200ms]"
          style={{
            color: tierInk.color,
            backgroundColor: `${tierInk.color}1F`,
            boxShadow: `inset 0 0 0 1px ${tierInk.color}52`,
          }}
        >
          <span aria-hidden className="text-[13px] leading-none">
            {tierInk.icon}
          </span>
          {tierLabel}
        </span>

        <span className="mt-3 inline-flex items-center rounded-full border border-vistara-border bg-vistara-surface px-3 py-1 text-[12px] text-vistara-muted">
          <span className="text-vistara-text">{archetype.label}</span>
          <span aria-hidden className="mx-1.5">
            —
          </span>
          {ARCHETYPE_DESCRIPTOR[profile.financialArchetype]}
        </span>

        {/* signalCount rather than Math.round(dataCompleteness * 5): the engine
            defines dataCompleteness as scored.length / BEHAVIOR_ORDER.length
            (consistency.ts), so the two are the same integer by construction and
            this one does not have to be rounded back out of a ratio. */}
        {profile.dataCompleteness < 1 ? (
          <p className="mt-4 text-sm text-vistara-muted">
            Score built from{" "}
            <span className="tabular text-vistara-text">{signalCount}</span> of{" "}
            {BEHAVIOR_ORDER.length} signals
          </p>
        ) : null}
      </section>

      {/* ── The offer ────────────────────────────────────────────────── */}
      {profile.tier === "THIN_FILE" ? (
        <Card
          padded
          titleAs="h2"
          title={
            thinByCoverage
              ? "Score data insufficient for a loan offer"
              : "No loan offer at this score"
          }
        >
          {/* Two findings, two sentences — including the title. Telling someone
              whose signals were all observed that the data was "insufficient",
              directly above a line saying four of five were read, is the page
              contradicting itself; the split above is what keeps them apart. */}
          <p className="text-[13px] leading-relaxed text-vistara-muted">
            {thinByCoverage ? (
              <>
                Fewer than {MIN_STREAMS_TO_SCORE} of {BEHAVIOR_ORDER.length}{" "}
                signals were observed, which is too little to claim a
                cross-domain rhythm exists, so no score is given yet. Share more
                signals to build a complete picture; what each signal you did
                share contributes is still shown below.
              </>
            ) : (
              <>
                <span className="text-vistara-text">
                  {signalCount} of {BEHAVIOR_ORDER.length}
                </span>{" "}
                signals were observed, so nothing about this file is thin. The
                rhythm in them scored below the band boundary, which makes the
                path a tighter rhythm rather than more data.
              </>
            )}
          </p>
          <Button
            href="/apply/live"
            variant="ghost"
            size="sm"
            className="-ml-3 mt-3"
          >
            {thinByCoverage ? "← Add more data" : "← Adjust the application"}
          </Button>
        </Card>
      ) : (
        <Card padded>
          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-vistara-muted">
                Loan offer
              </p>
              <p className="tabular mt-2 text-3xl font-semibold text-vistara-text">
                {formatINR(loanOffered)}
              </p>
              {loanOffered < view.loanRequested ? (
                <p className="tabular mt-1 text-[13px] text-vistara-muted">
                  of {formatINR(view.loanRequested)} requested
                </p>
              ) : null}
            </div>

            <dl className="grid content-center gap-2 text-[13px]">
              {[
                { label: "Rate", value: `${loan.interestRate}% p.a.` },
                { label: "Tenure", value: `${loan.tenureMonths} months` },
                // formatINR rounds to the nearest rupee itself, so the EMI goes
                // in unrounded rather than being rounded twice.
                { label: "EMI", value: `${formatINR(emi)} / month` },
              ].map((term) => (
                <div
                  key={term.label}
                  className="flex items-baseline justify-between gap-6 sm:justify-end"
                >
                  <dt className="text-vistara-muted">{term.label}</dt>
                  <dd className="tabular text-vistara-text">{term.value}</dd>
                </div>
              ))}
            </dl>
          </div>

          {/* ramp-100 rather than vistara-accent as the ink: #6C63FF on the card
              surface measures 4.30:1, which is under AA for 14px body text.
              ramp-100 is the same hue stepped light enough to read (11.5:1), and
              the accent stays present as the tint behind it. */}
          <div className="mt-5 rounded-lg bg-vistara-accent/10 px-4 py-3">
            <p className="text-sm text-ramp-100">
              Recommended EMI date:{" "}
              <span className="tabular font-semibold">
                {ordinalDay(profile.recommendedEmiDate)}
              </span>{" "}
              of each month
            </p>
            <p className="mt-1 text-[12px] text-vistara-muted">
              Based on your income rhythm
            </p>
          </div>

          {/* A link only when there is something to land on. `gap` is null at
              PRIME, and a Prime customer who asked for more than the tier
              ceiling still gets this line — so anchoring it unconditionally
              would point at an id that is not rendered, and clicking would do
              nothing. Same sentence either way; only the affordance differs. */}
          {cappedByTier ? (
            <p className="mt-4 text-sm">
              {aboveProgramme ? (
                <span className="text-vistara-amber">
                  {formatINR(view.loanRequested)} is above the{" "}
                  {formatINR(programmeMax)} this programme lends at any tier.
                </span>
              ) : gap === null ? (
                <span className="text-vistara-amber">
                  Improve your score to unlock{" "}
                  {formatINR(view.loanRequested)}
                </span>
              ) : (
                <a
                  href="#path-to-prime"
                  className="text-vistara-amber underline-offset-2 hover:underline"
                >
                  Improve your score to unlock{" "}
                  {formatINR(view.loanRequested)} →
                </a>
              )}
            </p>
          ) : null}
        </Card>
      )}

      {/* ── The evidence ─────────────────────────────────────────────── */}
      {/* An h2 above the three cards that follow, so the outline runs h1 → h2 →
          h3 rather than jumping from the page title straight to card titles. All
          three are the rhythm profile: the strips are the evidence, the meter is
          what it coheres into, the rows are where the points came from. */}
      <div className="mt-12">
        <SectionHeading
          as="h2"
          title="Your rhythm profile"
          description={`${OBSERVATION_MONTHS} months of observed behaviour — your timing, not your amounts.`}
        />
      </div>

      {/* Dropped from the printout, and it is the one omission worth arguing for.
          The strips are the page's best evidence on screen and its worst on paper:
          each is an SVG whose dots carry their meaning in fill colour on a dark
          plane, and a browser prints neither the plane nor the fills unless the
          reader has gone looking for the "background graphics" checkbox. What
          prints instead is five empty rectangles where the proof used to be. The
          per-signal figures below say the same thing in numbers, which is the form
          that survives a laser printer. */}
      <Card
        className="mt-5 print:hidden"
        eyebrow={`${OBSERVATION_MONTHS}-month event strips`}
        title="The rhythm itself, not a number about it"
        description={`Every strip shares one time axis, ${formatDate(WINDOW_START)} to ${formatDate(REFERENCE_DATE)}. A steady life renders as an even comb; a broken one visibly clusters and gaps. Every dot is a timestamp on file.`}
      >
        <RhythmStrips profile={profile} />
      </Card>

      {/* ── What built the score ─────────────────────────────────────── */}
      {/* h3, not the p the brief sketched: this is a heading, and outside a Card
          it nests correctly under "Your rhythm profile" instead of being invisible
          to the outline. The rule it must not break is a *second* h3 inside a
          Card, and this sits above them. */}
      <h3 className="mb-3 mt-6 text-sm font-medium text-vistara-muted">
        What built your score
      </h3>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* Both columns are headed and the points figure is spelled out, so the
            left border is decoration rather than the carrier of the reading —
            which is the rule the palette is documented under. */}
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-vistara-muted">
            Working for you
          </p>
          {strengths.length === 0 ? (
            <Card>
              <p className="text-sm leading-relaxed text-vistara-muted">
                No signal is in the top two bands yet. Every rhythm on file still
                has room to tighten, which is what the column beside this one is
                for.
              </p>
            </Card>
          ) : (
            <div className="space-y-4">
              {strengths.slice(0, FACTORS_PER_COLUMN).map((factor) => (
                <Card
                  key={factor.source}
                  className="border-l-[3px]"
                  style={{ borderLeftColor: STRENGTH_INK }}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-medium text-vistara-text">
                      <span aria-hidden>{BEHAVIOR_META[factor.source].icon}</span>{" "}
                      {factor.label}
                    </span>
                    <span
                      className="tabular whitespace-nowrap text-sm"
                      style={{ color: STRENGTH_INK }}
                    >
                      +{factor.points.toFixed(0)} pts
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-vistara-muted">
                    {factor.explanation}
                  </p>
                </Card>
              ))}
            </div>
          )}
        </div>

        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-vistara-muted">
            Room to improve
          </p>
          {headroom.length === 0 ? (
            <Card>
              <p className="text-sm leading-relaxed text-vistara-muted">
                Every signal on file is in the top two bands. There is no weak
                rhythm to point at — coverage is the only thing left to add.
              </p>
            </Card>
          ) : (
            <div className="space-y-4">
              {headroom.slice(0, FACTORS_PER_COLUMN).map((factor) => {
                const gain = gainFor(factor);
                return (
                  <Card
                    key={factor.source}
                    className="border-l-[3px]"
                    style={{ borderLeftColor: HEADROOM_INK }}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm font-medium text-vistara-text">
                        <span aria-hidden>
                          {BEHAVIOR_META[factor.source].icon}
                        </span>{" "}
                        {factor.label}
                      </span>
                      {/* The engine's priced gain when it has one, the band it
                          landed in when it does not. Never the factor's own
                          points as a negative: it did not subtract them. */}
                      <span
                        className="tabular whitespace-nowrap text-sm"
                        style={{ color: HEADROOM_INK }}
                      >
                        {gain === undefined
                          ? bandEntry(factor.band).label
                          : `+${gain} pts available`}
                      </span>
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-vistara-muted">
                      {factor.explanation}
                    </p>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {seasonalCount > 0 ? (
        <p className="mt-2 text-[12px] leading-relaxed text-vistara-muted">
          * Seasonal adjustment applied to {seasonalCount}{" "}
          {seasonalCount === 1 ? "signal" : "signals"} — harvest and festival
          gaps are not charged.
        </p>
      ) : null}

      {/* ── The part one good habit cannot fake ──────────────────────── */}
      <Card
        className="mt-4"
        padded
        title="Cross-domain consistency"
        description="How evenly the rhythm holds across unrelated domains. Consistency in one domain can be circumstance; coherence across several is character."
      >
        <Meter
          value={profile.crossDomainConsistency}
          ariaLabel="Cross-domain consistency"
        />
        <p className="tabular mt-2 text-[12px] text-vistara-muted">
          <span className="text-vistara-text">
            {profile.crossDomainConsistency.toFixed(1)}
          </span>{" "}
          of 100
        </p>
      </Card>

      {/* ── Per-source breakdown ─────────────────────────────────────── */}
      <Card
        className="mt-4"
        padded
        title="What each signal contributed"
        description="Ordered by points contributed. Every row is derived from timestamps alone."
      >
        <ul className="mt-2 divide-y divide-vistara-border">
          {factors.map((factor) => {
            const band = bandEntry(factor.band);
            return (
              <li
                key={factor.source}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
              >
                <span className="w-[190px] text-[13px] text-vistara-text">
                  {BEHAVIOR_META[factor.source].icon}{" "}
                  {BEHAVIOR_META[factor.source].short}
                </span>
                <span className="min-w-[130px] flex-1">
                  <Meter
                    value={factor.consistencyIndex}
                    band={factor.band}
                    ariaLabel={`${BEHAVIOR_META[factor.source].short} consistency`}
                  />
                </span>
                <span
                  className="tabular w-[92px] text-[12px]"
                  style={{ color: band.color }}
                >
                  {band.icon} {factor.consistencyIndex.toFixed(0)}
                </span>
                <span className="tabular w-[74px] text-right text-[13px] text-vistara-text">
                  +{factor.points.toFixed(0)} pts
                </span>
                {factor.seasonalityAdjusted ? (
                  <span className="text-[11px] text-vistara-muted">
                    seasonally adjusted
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>

        {profile.missingSources.length > 0 ? (
          <p className="mt-4 text-[12px] leading-relaxed text-vistara-muted">
            Not observed:{" "}
            {profile.missingSources
              .map((source) => BEHAVIOR_META[source].short)
              .join(", ")}
            . Absent signals are excluded from the weighted score rather than
            imputed, which is why coverage is reported under the score itself.
          </p>
        ) : null}
      </Card>

      {/* ── Path to Prime ────────────────────────────────────────────── */}
      {/* Omitted at PRIME, where tierGap returns null: there is no next band to
          describe, and "your path to Prime" shown to someone already there reads
          as the page not knowing who it is talking to. */}
      {gap !== null ? (
        <div id="path-to-prime" className="scroll-mt-24">
          <h3 className="mb-1 mt-8 text-sm font-medium text-vistara-muted">
            {gap.title}
          </h3>
          <p className="tabular text-sm text-vistara-muted">{gap.line}</p>

          {/* role="img" with a label rather than a progressbar role: this is a
              static picture of a distance, not a task in progress, and the
              sentence above it already states the figure in words. */}
          <div
            role="img"
            aria-label={gap.ariaLabel}
            className="mb-4 mt-3 h-1.5 w-full overflow-hidden rounded-full bg-vistara-border"
          >
            <div
              className="h-full rounded-full bg-vistara-accent motion-safe:transition-[width] motion-safe:duration-700 motion-safe:ease-out"
              style={{
                width: `${(barGrown ? clamp(gap.ratio, 0, 1) * 100 : 0).toFixed(1)}%`,
              }}
            />
          </div>

          {actions.length === 0 && thinByCoverage ? (
            <Card>
              {/* The engine prices actions in points, and on a gated file with
                  strong signals adding one can be priced at nothing — but what
                  this file lacks is a signal, not points. Name the ones that
                  could still be shared; the cold-start rule rules some out. */}
              <p className="text-sm leading-relaxed text-vistara-muted">
                Points are not what this file is short of: another observed
                signal is.
                {shareable.length > 0 ? (
                  <>
                    {" "}
                    Share{" "}
                    {shareable.length === 1 ? "" : "any of "}
                    <span className="text-vistara-text">
                      {shareable
                        .map((source) => BEHAVIOR_META[source].short)
                        .join(", ")}
                    </span>
                    , and re-score once it has a few cycles on file.
                  </>
                ) : null}
              </p>
            </Card>
          ) : actions.length === 0 ? (
            <Card>
              <p className="text-sm leading-relaxed text-vistara-muted">
                No single change is worth enough points yet to be worth naming.
                The rhythm on file needs more time rather than a different
                habit — keep the cycles you have and re-score in three months.
              </p>
            </Card>
          ) : (
            <div className="space-y-3">
              {actions.map((action) => (
                <Card key={action.id}>
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-vistara-text">
                        {action.title}
                      </p>
                      <p className="mt-0.5 text-[12px] text-vistara-muted">
                        {horizonLabel(action.horizonMonths)}
                      </p>
                    </div>
                    {/* The engine's own arithmetic on this customer's own file —
                        projectedScore re-runs the score with the one change
                        applied — rounded to 5s at source because it is an
                        estimate and should not look like a promise. */}
                    <span className="tabular shrink-0 whitespace-nowrap rounded-full bg-vistara-green/10 px-3 py-1 text-xs font-semibold text-vistara-green">
                      +{action.potentialPoints} pts
                    </span>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      ) : null}

      <hr className="my-8 border-vistara-border print:hidden" />

      <div className="flex flex-col items-center gap-5">
        {/* The two ways to take the scorecard away with you. Neither belongs on
            the paper it produces: a clipboard button is a screen affordance, and a
            printout offering to print itself is the one control a printed page can
            be certain nobody will use. */}
        <div className="flex flex-wrap items-center justify-center gap-3 print:hidden">
          <button
            type="button"
            onClick={copySummary}
            className={TERMINAL_BUTTON_CLASS}
          >
            {copied ? "Copied" : "Copy score summary"}
          </button>

          {/* No state, no handler of its own and nothing to await. window.print()
              blocks on the browser's own dialog, which is also the only feedback
              worth giving — a "Printing…" label would be describing a modal the
              customer is already looking at. The `copied` pattern beside it exists
              because the clipboard writes silently; this does not. */}
          <button
            type="button"
            onClick={() => window.print()}
            className={TERMINAL_BUTTON_CLASS}
          >
            Print scorecard
          </button>
        </div>

        {/* The page's terminal navigation. The back link is repeated here rather
            than moved down from the top of the page: after this much scrolling
            the breadcrumb is off screen, and a scorecard that can only be left
            by scrolling back up is worse than one exit stated twice. */}
        <div className="flex flex-wrap items-center justify-center gap-3 print:hidden">
          {/* A live profile has no server-resolvable id — it exists only in this
              tab's sessionStorage — so it borrows the cohort's first customer to
              demonstrate the full scorecard. A cohort profile has its own id and
              links to its own. */}
          <Button href={`/score?id=${fullScorecardId}`} size="sm">
            See a full scorecard
          </Button>
          {view.status === "live" ? (
            <Button variant="ghost" size="sm" onClick={clear}>
              Clear this result
            </Button>
          ) : null}
          <Button href={exit.href} variant="ghost" size="sm">
            {exit.label}
          </Button>
        </div>
      </div>
    </div>
  );
}
