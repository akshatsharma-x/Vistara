"use client";

/**
 * useVistara — the live scoring path.
 *
 * The application form hands this hook raw form inputs and gets back a scored
 * `TemporalProfile`. It is the only place in the app that turns a *person* into
 * a profile; everything else either reads the frozen demo cohort or renders a
 * profile it was given.
 *
 * WHAT IT IS NOT. This is not how /apply currently reaches /score. That flow
 * matches the entered occupation and income to one of the twelve frozen
 * histories and navigates to `/score?id=...`, which is the right call for a
 * stage demo: the twelve are tuned, verified by `npm run verify:data`, and each
 * one has a story. This hook is the other thing — a genuinely new applicant,
 * scored on history generated for them alone. Both are deterministic; they
 * differ in whether the history is looked up or generated.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { BEHAVIOR_ORDER } from "../constants";
import { scoreProfile } from "../consistency";
import { createRng, hashSeed } from "../rng";
import { defaultStreamAvailability, generateStreams } from "../synthetic-data";
import type {
  BehaviorSource,
  BehaviorStream,
  CustomerProfile,
  FinancialArchetype,
  TemporalProfile,
} from "../types";

/* ------------------------------------------------------------------ *
 * Contract
 * ------------------------------------------------------------------ */

/**
 * `id` and `streamAvailability` are absent because neither is a thing a person
 * can tell us: the id is derived from the answers (see `seedFor`) and
 * availability is consent intersected with the cold-start rule.
 */
export interface VistaraInput {
  customer: Omit<CustomerProfile, "id" | "streamAvailability">;
  /** The sources this applicant actually ticked on the consent step. */
  consentedSources: BehaviorSource[];
  /** Q1/Q2/Q3 answer indices, 0–3 for A–D. */
  archetypeAnswers: [number, number, number];
}

export interface UseVistaraResult {
  input: VistaraInput | null;
  profile: TemporalProfile | null;
  isProcessing: boolean;
  submit: (input: VistaraInput) => void;
  reset: () => void;
}

/** sessionStorage key. Holds one serialised `TemporalProfile`, nothing else. */
export const VISTARA_PROFILE_KEY = "vistara_profile";

/**
 * How long the score is withheld, in ms. Matches the reveal animation exactly.
 *
 * The wait is honest about what it is: theatre, not computation. Scoring twelve
 * profiles takes single-digit milliseconds, and generating one takes less. The
 * animation exists because a number that appears instantly reads as a lookup,
 * and the whole claim of this product is that it read eighteen months of
 * behaviour. Naming the constant here keeps the UI and the delay in one place.
 */
export const PROCESSING_MS = 3000;

/* ------------------------------------------------------------------ *
 * Archetype from the three questions
 * ------------------------------------------------------------------ */

const ANSWER_COUNT = 4;
const QUESTION_COUNT = 3;

/**
 * Points each answer contributes, as [Q][answer index] per archetype.
 *
 * Read a row as "answering B to Q3 is worth 3 points of Reactor". The zeros are
 * load-bearing: an answer that scores nothing for an archetype is evidence
 * against it, and writing the full 3x4 grid makes that explicit rather than
 * hiding it in a sparse lookup.
 */
const ANSWER_POINTS: Record<FinancialArchetype, number[][]> = {
  //          A  B  C  D
  PLANNER: [
    [3, 0, 0, 1], // Q1
    [3, 2, 0, 0], // Q2
    [3, 1, 0, 0], // Q3
  ],
  REACTOR: [
    [0, 2, 0, 2],
    [0, 2, 0, 2],
    [0, 3, 1, 0],
  ],
  ADAPTER: [
    [0, 1, 0, 3],
    [0, 1, 0, 3],
    [1, 2, 0, 0],
  ],
  AVOIDER: [
    [0, 0, 3, 0],
    [0, 0, 3, 0],
    [0, 0, 3, 2],
  ],
};

/** Evaluation order. Fixed so the function is total and reproducible. */
const ARCHETYPES: FinancialArchetype[] = [
  "PLANNER",
  "REACTOR",
  "ADAPTER",
  "AVOIDER",
];

/**
 * The self-declared archetype. Ties resolve to ADAPTER.
 *
 * That tie-break is not arbitrary. An applicant whose answers point equally at
 * two archetypes is, by definition, mixed — reliable on some axis and loose on
 * another — and that is precisely what ADAPTER means. Falling back to the
 * *strictest* archetype on a tie would flatter them; falling back to the
 * weakest would punish them for an ambiguous questionnaire.
 *
 * Note what this value is and is not. It seeds the *character* of the generated
 * history; it does not set the score, and it is not what the scorecard reports.
 * The scorecard's archetype comes from `classifyArchetype` reading the resulting
 * timestamps, so a self-declared Planner whose generated rhythm does not hold up
 * will be shown as something else. That gap is the engine disagreeing with a
 * questionnaire, which is the correct direction for it to disagree in.
 */
export function archetypeFromAnswers(
  answers: [number, number, number],
): FinancialArchetype {
  const totals = ARCHETYPES.map((archetype) => {
    let total = 0;
    for (let q = 0; q < QUESTION_COUNT; q++) {
      const answer = answers[q];
      // An out-of-range index scores nothing rather than yielding NaN and
      // poisoning the comparison. A malformed questionnaire must still return
      // an archetype.
      if (
        Number.isInteger(answer) &&
        answer >= 0 &&
        answer < ANSWER_COUNT
      ) {
        total += ANSWER_POINTS[archetype][q][answer];
      }
    }
    return total;
  });

  const best = Math.max.apply(null, totals);
  const winners = ARCHETYPES.filter((_, i) => totals[i] === best);
  return winners.length === 1 ? winners[0] : "ADAPTER";
}

/* ------------------------------------------------------------------ *
 * Input -> profile
 * ------------------------------------------------------------------ */

/**
 * The seed for this applicant's history.
 *
 * The brief said `customer.id ?? 'user-' + Date.now()`, but `VistaraInput` has
 * no id to fall back from — it is `Omit<..., 'id'>`, because the id is ours to
 * mint — so that expression is always the clock branch. Hashing the answers
 * instead buys three things the clock cannot:
 *
 *  - The same form yields the same score. A judge who fills the form twice, or
 *    reloads, or comes back after the demo, sees one number. With `Date.now()`
 *    every submission invents a different history for the same person, and the
 *    first thing anyone would try on stage is the thing that exposes it.
 *  - Nothing in the render path reads the clock, which is the invariant the
 *    whole app is built on (see REFERENCE_DATE) and the reason a Server
 *    Component and its hydration cannot disagree here.
 *  - Two different applicants still get different histories, because their
 *    answers differ. That was the only property `Date.now()` was buying.
 *
 * ONLY THE NAME AND THE ANSWERS. The name stands in for the identity a real
 * lookup would key on (a PAN, a phone number); the answers stand in for the
 * behaviour that lookup would find. Nothing else the form collects may reach
 * the seed, because the form promises it is not scored: income, the bureau
 * score and occupation are context, and putting them in the seed re-rolled
 * every timestamp, so moving the income slider moved the score across tiers.
 * Consent stays out for the same reason: each source draws from its own
 * `${seed}:${source}` stream, so sharing FASTag adds a strip without redrawing
 * the other four. Age reaches the profile through the cold-start rule only.
 */
function seedFor(input: VistaraInput): number {
  return hashSeed(
    [
      input.customer.name.trim().toLowerCase(),
      input.archetypeAnswers.join(""),
    ].join("|"),
  );
}

/**
 * Which sources we will actually generate: consent AND plausibility.
 *
 * Consent alone is not enough. A 22-year-old gig worker who ticks "vehicle
 * service" has consented to a signal that does not exist yet — they have never
 * owned the vehicle — and generating one anyway would manufacture the single
 * heaviest-weighted piece of evidence in the score out of nothing.
 * `defaultStreamAvailability` is the existing cold-start rule; this only
 * intersects it with what was consented to.
 */
function availabilityFor(
  input: VistaraInput,
): Record<BehaviorSource, boolean> {
  const natural = defaultStreamAvailability(input.customer);

  return BEHAVIOR_ORDER.reduce(
    (acc, source) => {
      acc[source] =
        natural[source] && input.consentedSources.indexOf(source) !== -1;
      return acc;
    },
    {} as Record<BehaviorSource, boolean>,
  );
}

/**
 * Scores one applicant. Pure, total, and independent of React — the hook is a
 * thin lifecycle wrapper over this, and a Server Component could call it
 * directly.
 */
export function buildLiveProfile(input: VistaraInput): TemporalProfile {
  const seed = seedFor(input);
  const archetype = archetypeFromAnswers(input.archetypeAnswers);

  const customer: CustomerProfile = {
    ...input.customer,
    // `live-` rather than `vst-`: an id collision with the frozen cohort would
    // make getDemoCustomer() answer for a person who is not in it.
    id: `live-${seed.toString(36)}`,
    streamAvailability: availabilityFor(input),
  };

  // Anchor days. Real recurring payments land on a DATE, not on an interval, and
  // without an anchor an 18-month walk on a flat 30-day step smears the
  // day-of-month across a fortnight — circular concentration then falls under
  // EMI_MIN_CONCENTRATION and the EMI recommendation degrades to the fallback
  // day for every live applicant. Drawing the anchors from the same seed keeps
  // them deterministic while letting the circular-mean inference actually run.
  const anchors = createRng(hashSeed(`${seed}:anchors`));
  const incomeDayOfMonth = anchors.int(1, 28);
  const utilityDayOfMonth = anchors.int(1, 28);

  const streams: BehaviorStream[] = generateStreams(archetype, seed, {
    availability: customer.streamAvailability,
    // Occupation is declared so the ENGINE can forgive a harvest gap it finds —
    // eligibility for the seasonal exception is a property of the trade.
    occupation: customer.occupation,
    // ...but no harvest pause is INJECTED, and that distinction is the whole
    // point. Measured over 30 applicants per cell, injecting pauses from
    // occupation alone cost a Planner-declaring farmer 213 points against a
    // gig worker with identical behaviour parameters (mean 613 vs 826) and a
    // merchant 165 (661). The mechanism: the generator writes a 2.2-2.8x
    // cadence pause into every seasonal window, three of them fall inside an
    // 18-month history, and the engine forgives at most
    // MAX_SEASONAL_EXCLUSIONS (2) per source — so the surplus pauses are
    // charged as irregularity. That is an occupation penalty wearing a
    // seasonality label, on exactly the two occupations this product exists to
    // serve, and it is the single most damaging thing the live path could do.
    //
    // Suppressed, the five occupations converge inside sampling noise
    // (849 / 844 / 826 / 819 / 824). The exception still fires — a farmer's
    // observed dates trip it in 13 of 30 Planner draws and 30 of 30 Avoider
    // draws — but now only when the DATES show a stretch, never because of the
    // job title. See StreamOptions.seasonalPauses: occupation is a prior, not a
    // fact, and for a live applicant we have observed nothing that entitles us
    // to assert a harvest. The frozen cohort may assert one because each of the
    // twelve is a hand-specified, tuned story; an anonymous applicant is not.
    seasonalPauses: false,
    incomeDayOfMonth,
    utilityDayOfMonth,
  });

  return scoreProfile(customer, streams);
}

/* ------------------------------------------------------------------ *
 * sessionStorage
 * ------------------------------------------------------------------ *
 * Why storage at all: the result is read on a different route from the one that
 * produced it, and threading a scored profile through the router would mean
 * either a query string far past any sane URL length or lifting state above two
 * pages that otherwise share nothing.
 *
 * sessionStorage rather than localStorage deliberately. The stored object is
 * derived from an applicant's name, age, income and consent choices; it should
 * not outlive the tab. Closing it is the eraser.
 */

/**
 * A profile after a JSON round trip: `Date` does not survive one, it becomes an
 * ISO string. Typing that honestly is what makes the revive in
 * `readStoredProfile` a conversion rather than a lie told with a cast.
 */
type SerialisedStream = Omit<BehaviorStream, "timestamps"> & {
  timestamps: string[];
};
type SerialisedProfile = Omit<TemporalProfile, "streams"> & {
  streams: SerialisedStream[];
};

/**
 * Reads the stored profile, reviving the timestamps.
 *
 * Returns null rather than throwing on anything unexpected — no storage (SSR,
 * or a browser with it disabled), no key, malformed JSON, or an object from an
 * older shape of the app. A stale key must degrade to "no profile", never to a
 * crashed scorecard.
 */
export function readStoredProfile(): TemporalProfile | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.sessionStorage.getItem(VISTARA_PROFILE_KEY);
    if (raw === null) return null;

    const parsed = JSON.parse(raw) as SerialisedProfile;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.streams) ||
      !Number.isFinite(parsed.vistaraScore)
    ) {
      return null;
    }

    return {
      ...parsed,
      streams: parsed.streams.map((stream) => ({
        ...stream,
        timestamps: stream.timestamps.map((value) => new Date(value)),
      })),
    };
  } catch {
    return null;
  }
}

function writeStoredProfile(profile: TemporalProfile): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      VISTARA_PROFILE_KEY,
      JSON.stringify(profile),
    );
  } catch {
    // Private-mode quota errors and disabled storage are not worth failing a
    // score over. The profile is still in React state for this session; only
    // the cross-route handoff is lost.
  }
}

export function clearStoredProfile(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(VISTARA_PROFILE_KEY);
  } catch {
    // Nothing to do — see writeStoredProfile.
  }
}

/* ------------------------------------------------------------------ *
 * The hook
 * ------------------------------------------------------------------ */

export function useVistara(): UseVistaraResult {
  const [input, setInput] = useState<VistaraInput | null>(null);
  const [profile, setProfile] = useState<TemporalProfile | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Rehydrate after mount, never during render: reading sessionStorage while
  // rendering would make the server's HTML and the client's first paint
  // disagree. This is what lets /score read the result without prop-drilling —
  // a component that mounts on another route still finds the profile.
  //
  // `input` is deliberately not restored. It is the live submission of this
  // component's lifetime; the profile is the artefact meant to outlive it.
  useEffect(() => {
    const stored = readStoredProfile();
    if (stored !== null) setProfile(stored);
  }, []);

  // A pending reveal must not outlive the component that started it.
  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const submit = useCallback((next: VistaraInput) => {
    if (timer.current !== null) clearTimeout(timer.current);

    setInput(next);
    // Clear the previous result up front. Leaving it visible under a loading
    // state shows one applicant's score while another's is computing.
    setProfile(null);
    setIsProcessing(true);

    timer.current = setTimeout(() => {
      timer.current = null;
      const built = buildLiveProfile(next);
      writeStoredProfile(built);
      setProfile(built);
      setIsProcessing(false);
    }, PROCESSING_MS);
  }, []);

  const reset = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setInput(null);
    setProfile(null);
    setIsProcessing(false);
    clearStoredProfile();
  }, []);

  return { input, profile, isProcessing, submit, reset };
}
