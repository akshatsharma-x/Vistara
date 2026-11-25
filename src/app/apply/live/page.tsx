"use client";

/**
 * /apply/live — the wizard that scores a genuinely NEW applicant.
 *
 * WHY THIS IS A SEPARATE ROUTE FROM /apply. There are two application paths in
 * this build and they are different products:
 *
 *   /apply       identity + AA/DPDP consent + review, then a deterministic match
 *                to one of the twelve frozen histories -> /score?id=...
 *                This is the stage path: every profile it can reach is tuned and
 *                verified by `npm run verify:data`, and its consent step is the
 *                privacy answer a judge asks for.
 *
 *   /apply/live  this file. Raw form input -> useVistara().submit() -> a history
 *                generated for this applicant alone -> /score/live.
 *
 * The split mirrors the one already made at /score vs /score/live and for the
 * same reason: the tuned demo path stays untouched, and the live path gets its
 * own route rather than being retrofitted into the page the demo depends on.
 *
 * SCOPE OF THIS FILE. All three steps are complete: identity, consent, and the
 * three mindset questions that hand the form to useVistara().submit() and land
 * on /score/live. The only thing this page does not own is the score itself —
 * nothing here computes one.
 *
 * DETERMINISM: no Math.random(), no Date.now(), no argless new Date(). Every
 * value on this page is either typed by the applicant or a constant — including
 * the processing screen, which counts its own elapsed time by accumulating a
 * fixed tick rather than reading a clock.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";

import {
  BEHAVIOR_META,
  BEHAVIOR_ORDER,
  LOAN_REQUEST_KEY,
  MAX_SEASONAL_EXCLUSIONS,
  MIN_STREAMS_TO_SCORE,
  OCCUPATION_META,
  SCORE_MAX,
  SCORE_MIN,
  SEASONAL_OCCUPATIONS,
  TIER_LOAN_CONFIG,
} from "@/lib/constants";
import { formatINR } from "@/lib/format";
import { PROCESSING_MS, useVistara } from "@/lib/hooks/useVistara";
import { defaultStreamAvailability } from "@/lib/synthetic-data";
import type { BehaviorSource, Occupation } from "@/lib/types";
import { Button, Card, SectionHeading } from "@/components/ui";

/* ------------------------------------------------------------------ *
 * Form bounds — prototype input limits, not model parameters
 * ------------------------------------------------------------------ */

const MIN_AGE = 18;
const MAX_AGE = 65;

const INCOME_MIN = 5_000;
const INCOME_MAX = 100_000;
const INCOME_STEP = 2_500;
const INCOME_DEFAULT = 25_000;

const LOAN_MIN = 20_000;
// The most any tier lends. A request above it could only ever be answered with
// "improve your score to unlock" for an amount no score unlocks.
const LOAN_MAX = TIER_LOAN_CONFIG.PRIME.maxLoanAmount;
const LOAN_STEP = 5_000;
const LOAN_DEFAULT = 60_000;

const MAX_NAME_LENGTH = 60;
const MAX_CITY_LENGTH = 40;

/**
 * Streams required before the consent step will let you continue.
 *
 * Note this is LOWER than MIN_STREAMS_TO_SCORE (3), the engine's own floor for
 * claiming a cross-domain rhythm exists. An applicant who shares exactly two is
 * therefore guaranteed a THIN_FILE-on-coverage verdict — /score/live reports
 * that outcome honestly rather than hiding it, so the form permits it. Step 2
 * does not paper over the gap: at two shared signals it says on screen that the
 * engine wanted three and what happens instead.
 */
const MIN_CONSENTED_SOURCES = 2;

/** Panel enter/leave duration. Must match the CSS transition below. */
const TRANSITION_MS = 200;
/** Height the bureau-score field reveals to. Fits label + 40px input + gap. */
const CIBIL_REVEAL_PX = 72;

const OCCUPATION_OPTIONS: Occupation[] = [
  "gig_worker",
  "small_merchant",
  "salaried_informal",
  "farmer",
  "self_employed",
];

/**
 * Applicant-facing gloss for each occupation. The LABEL always comes from
 * OCCUPATION_META so the word on the form is the word on the scorecard; this
 * only adds the plain-language "is this me?" line a self-service form needs.
 */
const OCCUPATION_HINT: Record<Occupation, string> = {
  gig_worker: "Delivery, ride-hailing or other platform work.",
  small_merchant: "You run a shop, stall or small business.",
  salaried_informal: "A regular wage, paid in cash or without a payslip.",
  farmer: "Agricultural work, on your own or leased land.",
  self_employed: "Freelance or contract work you find yourself.",
};

/**
 * Eligibility for the seasonal exception is read from SEASONAL_OCCUPATIONS —
 * the same list `isSeasonalOccupation` reads inside the engine, and the list
 * OCCUPATION_META's `seasonal` flag is now derived from.
 */
function seasonallyEligible(occupation: Occupation): boolean {
  return SEASONAL_OCCUPATIONS.indexOf(occupation) !== -1;
}

/* ------------------------------------------------------------------ *
 * Step 2 — the five consentable signals
 * ------------------------------------------------------------------ */

/**
 * The two things BEHAVIOR_META does not carry.
 *
 * BEHAVIOR_META already owns `label`, `short`, `icon` and
 * `expectedIntervalDays`, and this panel reads all of them from there so the
 * name on the consent screen is the name on the scorecard — /score/live prints
 * `BEHAVIOR_META[...].short` for the same five rows. What it has no field for is
 * applicant-facing prose, so only that lives here.
 */
const SOURCE_COPY: Record<
  BehaviorSource,
  { description: string; explanation: string }
> = {
  vehicle_service: {
    description:
      "Your maintenance rhythm is your strongest financial signal.",
    explanation:
      "People who service on schedule show the same discipline in financial commitments. This signal exists only at TVS Credit — no other lender can see it.",
  },
  upi_recurring: {
    description: "We look at when you transact, not how much.",
    explanation:
      "Recurring UPI payment timing reveals whether your financial life runs on a predictable schedule. Amounts are never read or stored.",
  },
  utility_bill: {
    description: "Paying on the same date every month is a strong signal.",
    explanation:
      "Utility and EMI payments are both fixed-date obligations from the same monthly budget. Timing consistency on one predicts the other.",
  },
  phone_recharge: {
    description: "Recharge regularity shows cash-flow stability.",
    explanation:
      "A consistent recharge cycle signals predictable disposable income — even for informal earners where bank data is limited.",
  },
  fastag_toll: {
    description: "Regular commute patterns indicate regular income activity.",
    explanation:
      "Consistent highway usage correlates with business activity or regular employment — both indicators of predictable income rhythm.",
  },
};

/**
 * What is ticked when the step opens.
 *
 * These three are the heaviest-weighted signals in the engine (0.30 / 0.25 /
 * 0.20 — three quarters of the score) and, not coincidentally, the three whose
 * cadence is slow enough for the seasonal exception to reach. That is exactly
 * MIN_STREAMS_TO_SCORE signals, so the step opens already past its own gate:
 * the amber warning below the cards is reachable only by revoking, which is the
 * only way an applicant should ever meet it.
 */
const DEFAULT_CONSENT: BehaviorSource[] = [
  "vehicle_service",
  "upi_recurring",
  "utility_bill",
];

/** Every "Why this signal?" panel starts closed. */
const NO_EXPLANATIONS: Record<BehaviorSource, boolean> = {
  vehicle_service: false,
  upi_recurring: false,
  utility_bill: false,
  phone_recharge: false,
  fastag_toll: false,
};

/* ------------------------------------------------------------------ *
 * Step 3 — the three mindset questions
 * ------------------------------------------------------------------ */

/**
 * The questionnaire. Answer index maps 0-3 to A-D, which is the order
 * ANSWER_POINTS in useVistara.ts scores — so the wording here and the scoring
 * matrix there are two halves of one contract, and reordering an answer list
 * without reordering that row would silently rescore everybody.
 *
 * These answers do not set the score. They seed the CHARACTER of the generated
 * history; `classifyArchetype` then reads the resulting timestamps and may
 * disagree with what the applicant said about themselves. That disagreement is
 * the engine's whole claim, so the panel says so rather than implying the
 * questionnaire is the assessment.
 */
const MINDSET_QUESTIONS: { prompt: string; answers: string[] }[] = [
  {
    prompt: "Your EMI is due tomorrow. You're ₹300 short. What do you do?",
    answers: [
      "Transfer from savings immediately",
      "Ask a family member or friend",
      "Wait and see if it resolves",
      "Call the lender to explain",
    ],
  },
  {
    prompt: "You get an unexpected ₹5,000. What happens to it first?",
    answers: [
      "Into savings before I think about it",
      "Pay off a pending bill",
      "Treat myself — I'll save next month",
      "Split between a treat and savings",
    ],
  },
  {
    prompt: "Your vehicle service is due but you're busy. You:",
    answers: [
      "Book it right away, even if inconvenient",
      "Reschedule within the same week",
      "Do it whenever I find time",
      "Skip this cycle, do double next time",
    ],
  },
];

const ANSWER_LETTERS = ["A", "B", "C", "D"];

/** No answer given. Matches the guard in `archetypeFromAnswers`, which scores
 *  an out-of-range index as zero rather than returning NaN. */
const UNANSWERED = -1;

/* ------------------------------------------------------------------ *
 * The processing screen
 * ------------------------------------------------------------------ */

/**
 * How long the row sequence occupies, and how often it repaints.
 *
 * PROCESSING_MS (3000) is owned by the hook; these two numbers divide the window
 * it opens. The sequence finishes at 2600ms, the status line turns to "ready" at
 * 2700ms, and the hook navigates at 3000 — so the last thing on screen is a
 * finished list, never a row still spinning when the page changes.
 *
 * TICK_MS accumulates rather than sampling a clock: `Date.now()` is banned in
 * this app and an interval that adds a fixed step needs no clock at all. 50ms
 * divides all three thresholds exactly and costs 60 renders across the whole
 * animation.
 */
const SEQUENCE_MS = 2600;
const STATUS_CYCLE_MS = 650;
const STATUS_READY_MS = 2700;
const TICK_MS = 50;

/**
 * The cycling status line.
 *
 * Two of the four name a specific signal, and are dropped when that signal was
 * not shared — the alternative is telling somebody we mapped a vehicle service
 * rhythm they withheld, on the screen immediately before /score/live lists it
 * under "Not observed". With the step-2 defaults both survive and the schedule
 * is the full four lines; unticking one leaves three, which simply holds the
 * last line longer.
 */
const STATUS_LINES: { source?: BehaviorSource; text: string }[] = [
  { source: "vehicle_service", text: "Mapping your vehicle service rhythm..." },
  { source: "upi_recurring", text: "Analysing UPI timing patterns..." },
  { text: "Measuring cross-domain consistency..." },
  { text: "Calculating your Vistara Score..." },
];

const STATUS_READY = "Your profile is ready.";

/**
 * `skipped` is not in the brief's three states, and it is the reason this screen
 * is honest. The sequence lights the signals that were actually consented to;
 * the other rows stay dark and say "not shared". Without it the default consent
 * (three of five) would show all five going green, and the very next screen
 * prints "Not observed: Phone recharge, FASTag tolls" — two consecutive screens
 * contradicting each other in front of whoever is watching.
 */
type RowState = "pending" | "active" | "complete" | "skipped";

const ROW_GLYPH: Record<RowState, string> = {
  pending: "bg-vistara-dark text-vistara-muted",
  active: "bg-vistara-accent/20 text-vistara-text",
  complete: "bg-vistara-green/10 text-vistara-text",
  skipped: "bg-vistara-dark/60 text-vistara-muted/60",
};

const ROW_LABEL: Record<RowState, string> = {
  pending: "text-vistara-muted",
  active: "text-vistara-text",
  complete: "text-vistara-text",
  skipped: "text-vistara-muted/60",
};

const ROW_DOT: Record<RowState, string> = {
  pending: "bg-vistara-border",
  active: "bg-vistara-accent",
  complete: "bg-vistara-green",
  skipped: "bg-vistara-border/50",
};

/* ------------------------------------------------------------------ *
 * Wizard model
 * ------------------------------------------------------------------ */

type StepIndex = 1 | 2 | 3;

const STEPS: { index: StepIndex; label: string }[] = [
  { index: 1, label: "Profile" },
  { index: 2, label: "Data" },
  { index: 3, label: "Mindset" },
];

type ProfileField = "name" | "age" | "city" | "occupation" | "cibilScore";

interface ProfileForm {
  name: string;
  age: string;
  /**
   * District / city. Not in the brief's field list, but `CustomerProfile.city`
   * is required and /score/live prints it in the identity line — so it is a
   * field the applicant has to be asked for rather than one we can invent.
   */
  city: string;
  occupation: Occupation | "";
  monthlyIncome: number;
  /** What they came for. Compared against the tier's ceiling on the scorecard. */
  loanAmount: number;
  hasCibilScore: boolean;
  cibilScore: string;
}

const EMPTY_PROFILE: ProfileForm = {
  name: "",
  age: "",
  city: "",
  occupation: "",
  monthlyIncome: INCOME_DEFAULT,
  loanAmount: LOAN_DEFAULT,
  hasCibilScore: false,
  cibilScore: "",
};

const NO_TOUCHED: Record<ProfileField, boolean> = {
  name: false,
  age: false,
  city: false,
  occupation: false,
  cibilScore: false,
};

/** Digits only, after stripping the separators people type into number fields. */
function parseWholeNumber(raw: string): number | null {
  const cleaned = raw.replace(/[\s,]/g, "");
  if (!/^\d{1,9}$/.test(cleaned)) return null;
  return Number.parseInt(cleaned, 10);
}

/* ------------------------------------------------------------------ *
 * Progress
 * ------------------------------------------------------------------ */

/**
 * Three dots on a filling line. The line is the progress bar — there is no
 * percentage, because a three-step form has three states and "67%" is a less
 * honest description of the second of them than "step 2 of 3".
 */
function Progress({ step }: { step: StepIndex }) {
  return (
    <nav aria-label="Application progress">
      <ol className="flex items-start">
        {STEPS.map((entry, index) => {
          const isCurrent = entry.index === step;
          const isDone = entry.index < step;

          return (
            <li
              key={entry.index}
              aria-current={isCurrent ? "step" : undefined}
              className={index === 0 ? "shrink-0" : "flex flex-1 items-start"}
            >
              {/* Connector, drawn before the dot it leads into. */}
              {index > 0 ? (
                <span
                  aria-hidden
                  className="mt-[11px] h-0.5 flex-1 overflow-hidden rounded-full bg-vistara-border"
                >
                  <span
                    className="block h-full rounded-full bg-vistara-accent transition-[width] duration-300 ease-out"
                    style={{ width: entry.index <= step ? "100%" : "0%" }}
                  />
                </span>
              ) : null}

              <span className="flex w-16 shrink-0 flex-col items-center">
                <span
                  aria-hidden
                  className={[
                    "grid h-6 w-6 place-items-center rounded-full border text-[11px] font-semibold transition-colors",
                    isDone
                      ? "border-vistara-green bg-vistara-green/15 text-vistara-green"
                      : isCurrent
                        ? "border-vistara-accent bg-vistara-accent text-white"
                        : "border-vistara-border text-vistara-muted",
                  ].join(" ")}
                >
                  {isDone ? "✓" : entry.index}
                </span>

                <span
                  className={[
                    "mt-2 text-[12px]",
                    isCurrent
                      ? "font-medium text-vistara-text"
                      : "text-vistara-muted",
                  ].join(" ")}
                >
                  {entry.label}
                </span>

                <span className="sr-only">
                  {isDone
                    ? " — completed"
                    : isCurrent
                      ? " — current step"
                      : " — not started"}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/* ------------------------------------------------------------------ *
 * Field primitives
 * ------------------------------------------------------------------ */

const LABEL_CLASS = "mb-1 block text-sm text-vistara-muted";

const INPUT_CLASS =
  "w-full rounded-xl border border-vistara-border bg-vistara-dark px-4 py-3 text-[14px] text-vistara-text outline-none transition-colors placeholder:text-vistara-muted/70 focus:border-vistara-accent";

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className={LABEL_CLASS}>
        {label}
      </label>
      {children}
      {error === undefined ? (
        hint === undefined ? null : (
          <p
            id={`${id}-hint`}
            className="mt-1.5 text-[12px] leading-relaxed text-vistara-muted"
          >
            {hint}
          </p>
        )
      ) : (
        <p
          id={`${id}-error`}
          className="mt-1.5 text-[12px] leading-relaxed text-vistara-red"
        >
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Occupation picker. A native <select> cannot carry a second line of text per
 * option, and the "is this me?" gloss is what makes an occupation question
 * answerable by someone who has never filled a credit form — so this is a
 * listbox: roving highlight over `aria-activedescendant`, full keyboard
 * handling, and the button itself owns focus throughout.
 */
function OccupationSelect({
  id,
  value,
  invalid,
  describedBy,
  onChange,
  onBlur,
}: {
  id: string;
  value: Occupation | "";
  invalid: boolean;
  describedBy: string;
  onChange: (next: Occupation) => void;
  onBlur: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const listId = `${id}-listbox`;
  const optionId = (index: number) => `${id}-option-${index}`;
  const selectedIndex = value === "" ? -1 : OCCUPATION_OPTIONS.indexOf(value);
  const lastIndex = OCCUPATION_OPTIONS.length - 1;

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const root = rootRef.current;
      if (root !== null && !root.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  const openAt = (index: number) => {
    setActive(index < 0 ? 0 : index);
    setOpen(true);
  };

  const commit = (index: number) => {
    onChange(OCCUPATION_OPTIONS[index]);
    setOpen(false);
    if (buttonRef.current !== null) buttonRef.current.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (open) setActive((prev) => (prev >= lastIndex ? lastIndex : prev + 1));
        else openAt(selectedIndex);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (open) setActive((prev) => (prev <= 0 ? 0 : prev - 1));
        else openAt(selectedIndex < 0 ? lastIndex : selectedIndex);
        break;
      case "Home":
        if (open) {
          event.preventDefault();
          setActive(0);
        }
        break;
      case "End":
        if (open) {
          event.preventDefault();
          setActive(lastIndex);
        }
        break;
      case "Enter":
      case " ":
        // Space would scroll the page and Enter would submit the form; in a
        // listbox both mean "choose".
        event.preventDefault();
        if (open) commit(active);
        else openAt(selectedIndex);
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          setOpen(false);
        }
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={buttonRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? optionId(active) : undefined}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        onClick={() => (open ? setOpen(false) : openAt(selectedIndex))}
        onKeyDown={handleKeyDown}
        onBlur={onBlur}
        // No open-state border override: the button keeps focus for as long as
        // the list is open, so INPUT_CLASS's own focus:border-vistara-accent
        // already draws it — and adding a second border-* class here would put
        // two colour utilities of equal specificity in one attribute, where the
        // winner is decided by Tailwind's output order rather than by intent.
        className={`${INPUT_CLASS} flex items-center justify-between text-left`}
      >
        <span className={value === "" ? "text-vistara-muted/70" : ""}>
          {value === "" ? "Select your occupation" : OCCUPATION_META[value].label}
        </span>
        <span aria-hidden className="ml-3 shrink-0 text-[11px] text-vistara-muted">
          ▾
        </span>
      </button>

      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Occupation"
          className="absolute z-20 mt-1.5 w-full overflow-hidden rounded-xl border border-vistara-border bg-vistara-surface py-1 shadow-card"
        >
          {OCCUPATION_OPTIONS.map((option, index) => (
            <li
              key={option}
              id={optionId(index)}
              role="option"
              aria-selected={option === value}
              onMouseEnter={() => setActive(index)}
              // mousedown, not click: click fires after blur, which closes the
              // list before the selection lands.
              onMouseDown={(event) => {
                event.preventDefault();
                commit(index);
              }}
              className={[
                "cursor-pointer px-4 py-2.5 transition-colors",
                index === active ? "bg-vistara-border/50" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <span className="flex items-baseline gap-2">
                <span className="text-[14px] text-vistara-text">
                  {OCCUPATION_META[option].label}
                </span>
                {seasonallyEligible(option) ? (
                  <span className="text-[11px] text-vistara-muted">
                    · seasonally adjustable
                  </span>
                ) : null}
              </span>
              <span className="mt-0.5 block text-[12px] text-vistara-muted">
                {OCCUPATION_HINT[option]}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * A slider with its value riding above the thumb.
 *
 * Track and fill are real elements wearing real tokens, with a transparent
 * range input laid over them — the alternative (a CSS gradient background)
 * would mean hard-coding the accent and border hexes into this file, away from
 * tailwind.config.
 */
function SliderField({
  id,
  label,
  value,
  min,
  max,
  step,
  hint,
  format,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  hint: string;
  format: (value: number) => string;
  onChange: (next: number) => void;
}) {
  const filled = ((value - min) / (max - min)) * 100;

  return (
    <div>
      <label htmlFor={id} className={LABEL_CLASS}>
        {label}
      </label>

      {/* The value flag. `translateX(-p%)` rather than -50% keeps it inside the
          track at both ends while staying centred over the thumb in between. */}
      <div className="relative h-6">
        <span
          aria-hidden
          className="tabular absolute top-0 whitespace-nowrap text-[14px] font-medium text-vistara-text"
          style={{
            left: `${filled}%`,
            transform: `translateX(-${filled}%)`,
          }}
        >
          {format(value)}
        </span>
      </div>

      {/* h-11 on mobile purely for the drag target: the range input is
          `absolute inset-0`, so the box it sits in IS the grabbable area, and at
          h-6 that is a 24px-tall strip for a 16px thumb. The painted track and
          the thumb are both centred on `top-1/2`, so they do not move — the box
          around them just gets taller. Desktop keeps the tighter original. */}
      <div className="relative h-11 sm:h-6">
        <span
          aria-hidden
          className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-vistara-border"
        >
          <span
            className="block h-full rounded-full bg-vistara-accent"
            style={{ width: `${filled}%` }}
          />
        </span>

        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-describedby={`${id}-hint`}
          aria-valuetext={format(value)}
          onChange={(event) => onChange(Number(event.target.value))}
          className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-vistara-dark [&::-moz-range-thumb]:bg-vistara-accent [&::-moz-range-track]:bg-transparent [&::-webkit-slider-runnable-track]:h-full [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-vistara-dark [&::-webkit-slider-thumb]:bg-vistara-accent"
        />
      </div>

      <div className="tabular mt-1.5 flex justify-between text-[11px] text-vistara-muted">
        <span>{format(min)}</span>
        <span>{format(max)}</span>
      </div>

      <p id={`${id}-hint`} className="mt-1.5 text-[12px] leading-relaxed text-vistara-muted">
        {hint}
      </p>
    </div>
  );
}

function ToggleSwitch({
  id,
  checked,
  label,
  onChange,
  disabled = false,
}: {
  id: string;
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={[
        "relative h-6 w-11 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-45",
        // 24 × 44 is a thumb's width and half its height. The pill itself cannot
        // simply grow — `rounded-full` on a 44px box is a circle, not a switch —
        // so the hit area is extended past the paint with a transparent
        // pseudo-element instead: 44px tall, centred on the track, mobile only.
        // Nothing sits above or below the switch in its column, so the larger
        // target overlaps no other control.
        "max-sm:after:absolute max-sm:after:inset-x-0 max-sm:after:top-1/2 max-sm:after:h-11 max-sm:after:-translate-y-1/2 max-sm:after:content-['']",
        checked
          ? "border-vistara-accent/60 bg-vistara-accent/25"
          : "border-vistara-border bg-vistara-dark",
      ].join(" ")}
    >
      <span
        aria-hidden
        className={[
          "absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full transition-all",
          checked
            ? "left-[calc(100%-1.25rem)] bg-vistara-accent"
            : "left-1 bg-vistara-muted",
        ].join(" ")}
      />
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Step 2 primitives
 * ------------------------------------------------------------------ */

/**
 * A left-ruled banner. `border-l-2` sets a width and `border-<token>` a colour,
 * so the two coexist — unlike two colour utilities in one attribute, where the
 * winner is decided by Tailwind's output order rather than by intent.
 */
function Notice({
  tone,
  children,
}: {
  tone: "accent" | "amber";
  children: ReactNode;
}) {
  return (
    <div
      className={[
        "rounded-lg border-l-2 p-3 text-sm leading-relaxed text-vistara-text",
        tone === "accent"
          ? "border-vistara-accent bg-vistara-accent/10"
          : "border-vistara-amber bg-vistara-amber/10",
      ].join(" ")}
    >
      {children}
    </div>
  );
}

/**
 * One consentable signal: what it is, why we want it, and a switch.
 *
 * The reveal transitions max-height, so the open value has to be a number
 * rather than "however tall the text is". 96px (max-h-24) is right from the
 * `sm` breakpoint up, where the explanation wraps to two or three lines; below
 * it the same sentence needs up to eight, so the narrow case gets its own
 * ceiling instead of silently clipping the last line off a promise about
 * privacy.
 */
function SourceCard({
  source,
  consented,
  unavailable,
  explained,
  onConsentChange,
  onExplainToggle,
}: {
  source: BehaviorSource;
  consented: boolean;
  /**
   * Why this signal cannot exist yet for this applicant, or undefined if it
   * can. Set by the same cold-start rule the engine applies, so the switch
   * cannot promise a signal the scorecard will then report as not observed.
   */
  unavailable?: string;
  explained: boolean;
  onConsentChange: (next: boolean) => void;
  onExplainToggle: () => void;
}) {
  const meta = BEHAVIOR_META[source];
  const copy = SOURCE_COPY[source];
  const panelId = `live-source-${source}-why`;
  const noteId = `live-source-${source}-unavailable`;

  return (
    <Card>
      <div className="flex items-start gap-4">
        <span
          aria-hidden
          className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-vistara-border bg-vistara-dark text-[17px] text-vistara-text"
        >
          {meta.icon}
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium text-vistara-text">
            {meta.label}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-vistara-muted">
            {copy.description}
          </p>
          {unavailable ? (
            <p
              id={noteId}
              className="mt-1.5 text-[13px] leading-relaxed text-vistara-amber"
            >
              {unavailable}
            </p>
          ) : null}

          <button
            type="button"
            aria-expanded={explained}
            aria-controls={panelId}
            onClick={onExplainToggle}
            className="mt-2 inline-flex items-center gap-1.5 text-xs text-vistara-accent underline underline-offset-2 max-sm:min-h-[44px]"
          >
            Why this signal?
            <span
              aria-hidden
              className={[
                "text-[9px] transition-transform duration-200 ease-out",
                explained ? "rotate-180" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              ▾
            </span>
          </button>

          <div
            id={panelId}
            // Nothing inside is focusable, so aria-hidden alone is enough to
            // keep the collapsed copy out of a screen reader's flow.
            aria-hidden={!explained}
            className={[
              "overflow-hidden transition-[max-height,opacity] duration-200 ease-out",
              explained ? "max-h-48 opacity-100 sm:max-h-24" : "max-h-0 opacity-0",
            ].join(" ")}
          >
            <p className="pt-2 text-[13px] leading-relaxed text-vistara-muted">
              {copy.explanation}
            </p>
          </div>
        </div>

        <ToggleSwitch
          id={`live-consent-${source}`}
          checked={consented && !unavailable}
          label={
            unavailable
              ? `${meta.label} — not available yet`
              : `Share ${meta.label}`
          }
          disabled={Boolean(unavailable)}
          onChange={onConsentChange}
        />
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Step 3 primitives
 * ------------------------------------------------------------------ */

/**
 * One answer. The whole card is the hit target and there is no visible radio.
 *
 * The input is a real, screen-reader-only <input type="radio">, not a button
 * wearing role="radio". That buys arrow-key movement within the group, "radio
 * button, 2 of 4" announcements and label association from the platform instead
 * of from forty lines of roving-tabindex code here — and none of it is visible,
 * so the letter chip remains the only selection affordance on screen.
 *
 * WHY peer-checked RATHER THAN A CONDITIONAL. Card hardcodes
 * `border-vistara-border` and `bg-vistara-surface`, so passing the selected
 * colours through its className would put two utilities of the same property in
 * one attribute, where the winner is decided by Tailwind's output order rather
 * than by intent — the hazard already flagged on OccupationSelect. A variant
 * dodges it outright: `.peer:checked ~ .peer-checked\:border-vistara-accent` is
 * three simple selectors against one, so it wins on specificity no matter what
 * order the stylesheet lands in. Everything on an element this file owns outright
 * stays a plain conditional.
 */
function AnswerOption({
  name,
  letter,
  text,
  selected,
  onSelect,
}: {
  name: string;
  letter: string;
  text: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label className="block cursor-pointer">
      <input
        type="radio"
        name={name}
        className="peer sr-only"
        checked={selected}
        onChange={onSelect}
      />
      <Card
        padded={false}
        sheen={false}
        className={[
          "flex items-center gap-3 p-4 transition-colors",
          "peer-checked:border-vistara-accent peer-checked:bg-vistara-accent/10",
          "peer-focus-visible:ring-2 peer-focus-visible:ring-vistara-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-vistara-dark",
          // Hover is suppressed once selected rather than losing to the checked
          // colour — one state, one class, nothing to resolve.
          selected ? "" : "hover:border-vistara-muted",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <span
          aria-hidden
          className={[
            "grid h-7 w-7 shrink-0 place-items-center rounded-md font-mono text-xs transition-colors",
            selected
              ? "bg-vistara-accent text-white"
              : "bg-vistara-dark text-vistara-muted",
          ].join(" ")}
        >
          {letter}
        </span>
        <span className="text-[14px] leading-snug text-vistara-text">
          {text}
        </span>
      </Card>
    </label>
  );
}

/**
 * A question and its four answers.
 *
 * <fieldset>/<legend> rather than role="radiogroup": it names the group for
 * assistive technology for free, and the prompt is already the name. `min-w-0`
 * is not decoration — a fieldset defaults to `min-width: min-content`, which
 * would stop the answers from wrapping inside the grid.
 */
function MindsetQuestion({
  index,
  prompt,
  answers,
  answer,
  onAnswer,
}: {
  index: number;
  prompt: string;
  answers: string[];
  answer: number;
  onAnswer: (choice: number) => void;
}) {
  return (
    <fieldset className="min-w-0 motion-safe:animate-fade-in">
      <legend className="text-[14px] font-medium leading-relaxed text-vistara-text">
        {prompt}
      </legend>

      <div className="mt-3 grid gap-2">
        {answers.map((text, choice) => (
          <AnswerOption
            key={text}
            name={`live-mindset-${index}`}
            letter={ANSWER_LETTERS[choice]}
            text={text}
            selected={answer === choice}
            onSelect={() => onAnswer(choice)}
          />
        ))}
      </div>
    </fieldset>
  );
}

/* ------------------------------------------------------------------ *
 * The processing screen
 * ------------------------------------------------------------------ */

/**
 * Five rows lighting up while the hook holds the score back.
 *
 * The row interval is SEQUENCE_MS divided by the number of signals actually
 * shared, not the brief's flat 520ms. At five signals it IS 520ms; at three it
 * is 867ms, and either way the sequence lands on 2600ms and the choreography
 * with the status line and the hook's 3000ms handover holds. A fixed 520ms would
 * finish a three-signal run at 1560ms and then stare at a finished list for a
 * second and a half.
 */
function ProcessingPanel({
  consented,
  reduced,
}: {
  consented: BehaviorSource[];
  reduced: boolean;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    // Reduced motion gets no sequence at all, so it needs no timer: `elapsed`
    // stays at 0 and every derived value below reads the finished state.
    if (reduced) return;
    const id = setInterval(() => {
      setElapsed((prev) => (prev >= PROCESSING_MS ? prev : prev + TICK_MS));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [reduced]);

  const lines = STATUS_LINES.filter(
    (line) => line.source === undefined || consented.indexOf(line.source) !== -1,
  );

  const rowInterval = SEQUENCE_MS / Math.max(consented.length, 1);
  const completed = reduced
    ? consented.length
    : Math.floor(elapsed / rowInterval);

  const stateFor = (source: BehaviorSource): RowState => {
    const position = consented.indexOf(source);
    if (position === -1) return "skipped";
    if (position < completed) return "complete";
    if (position === completed) return "active";
    return "pending";
  };

  const status = reduced
    ? lines[lines.length - 1].text
    : elapsed >= STATUS_READY_MS
      ? STATUS_READY
      : lines[Math.min(Math.floor(elapsed / STATUS_CYCLE_MS), lines.length - 1)]
          .text;

  return (
    <div className="mt-8 grid min-h-[320px] content-center gap-6">
      {/* The rows are theatre and are hidden from assistive technology; the
          live region below carries what they mean, and says it once instead of
          five times in two and a half seconds. */}
      <div aria-hidden className="grid gap-3">
        {BEHAVIOR_ORDER.map((source) => {
          const state = stateFor(source);
          return (
            <div key={source} className="flex items-center gap-3">
              <span
                className={[
                  "grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[16px] transition-colors duration-300",
                  ROW_GLYPH[state],
                ].join(" ")}
              >
                {BEHAVIOR_META[source].icon}
              </span>

              <span
                className={[
                  "flex-1 text-sm transition-colors duration-300",
                  ROW_LABEL[state],
                ].join(" ")}
              >
                {BEHAVIOR_META[source].label}
              </span>

              {state === "skipped" ? (
                <span className="text-[11px] text-vistara-muted">
                  not shared
                </span>
              ) : null}

              <span
                className={[
                  "h-2.5 w-2.5 shrink-0 rounded-full transition-colors duration-300",
                  ROW_DOT[state],
                  state === "active" ? "motion-safe:animate-dot-pulse" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              />
            </div>
          );
        })}
      </div>

      {/* key={status} remounts the line, which is what re-runs the fade. */}
      <p
        key={status}
        aria-hidden
        className="text-center text-[13px] text-vistara-muted motion-safe:animate-fade-in"
      >
        {status}
      </p>

      <p className="sr-only" aria-live="polite">
        {status === STATUS_READY
          ? STATUS_READY
          : `Building your profile from ${consented.length} of ${BEHAVIOR_ORDER.length} signals: ${consented
              .map((source) => BEHAVIOR_META[source].short)
              .join(", ")}.`}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

/** Which half of the transition a panel is in. */
type Motion = "settled" | "leaving" | "entering";

export default function ApplyLivePage() {
  /* --- wizard state ---------------------------------------------- */

  const [step, setStep] = useState<StepIndex>(1);
  const [profile, setProfile] = useState<ProfileForm>(EMPTY_PROFILE);
  const [touched, setTouched] =
    useState<Record<ProfileField, boolean>>(NO_TOUCHED);
  const [forceErrors, setForceErrors] = useState(false);

  const [consentedSources, setConsentedSources] =
    useState<BehaviorSource[]>(DEFAULT_CONSENT);
  const [explained, setExplained] =
    useState<Record<BehaviorSource, boolean>>(NO_EXPLANATIONS);

  const [archetypeAnswers, setArchetypeAnswers] = useState<
    [number, number, number]
  >([UNANSWERED, UNANSWERED, UNANSWERED]);

  /* --- the live scoring hand-off --------------------------------- */

  const router = useRouter();
  const { submit, isProcessing, profile: scored } = useVistara();
  /**
   * True once this page has called submit().
   *
   * The hook rehydrates any profile left in sessionStorage on mount, so
   * `scored !== null` is not evidence that a submission just finished — a judge
   * who scores once, comes back to the form and reloads would otherwise be
   * bounced straight to the previous result. This flag is what distinguishes
   * "a profile exists" from "this visit produced one".
   */
  const submitted = useRef(false);

  /* --- step transition ------------------------------------------- */

  const [motion, setMotion] = useState<Motion>("settled");
  const [direction, setDirection] = useState<1 | -1>(1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frame = useRef<number | null>(null);
  /**
   * Read once on mount. Without this the 200ms leave timer would still hold the
   * outgoing panel on screen for someone who has asked for no motion — they get
   * the lag with none of the animation it pays for.
   */
  const reducedMotion = useRef(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    reducedMotion.current = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
  }, []);

  // Land the incoming panel. It mounts at the offset (motion === "entering"),
  // and this releases it to its resting position one painted frame later — two
  // rAFs deep, because a single one can be batched into the same paint and the
  // transition then has nothing to interpolate from.
  useEffect(() => {
    if (motion !== "entering") return;
    frame.current = window.requestAnimationFrame(() => {
      frame.current = window.requestAnimationFrame(() => {
        frame.current = null;
        setMotion("settled");
      });
    });
  }, [motion]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  /**
   * Leave for the scorecard when the hook releases the score.
   *
   * The hook sets `profile` and clears `isProcessing` in the same update, so this
   * fires once. `source=form` tells /score/live that a real submission is in
   * sessionStorage and that an empty key is a bug to redirect on, rather than the
   * ordinary case of someone opening the URL directly.
   */
  useEffect(() => {
    if (!submitted.current || isProcessing || scored === null) return;
    router.push("/score/live?source=form");
  }, [isProcessing, scored, router]);

  const goTo = (next: StepIndex) => {
    if (next === step || motion !== "settled") return;

    setDirection(next > step ? 1 : -1);
    setForceErrors(false);

    if (reducedMotion.current) {
      setStep(next);
      return;
    }

    setMotion("leaving");
    timer.current = setTimeout(() => {
      timer.current = null;
      setStep(next);
      setMotion("entering");
    }, TRANSITION_MS);
  };

  /* --- validation ------------------------------------------------ */

  const age = parseWholeNumber(profile.age);
  const cibil = parseWholeNumber(profile.cibilScore);

  const errors = useMemo<Partial<Record<ProfileField, string>>>(() => {
    const next: Partial<Record<ProfileField, string>> = {};
    const name = profile.name.trim();
    const city = profile.city.trim();

    if (name.length === 0) next.name = "Your name is required.";
    else if (name.length > MAX_NAME_LENGTH)
      next.name = `Keep it under ${MAX_NAME_LENGTH} characters.`;

    if (profile.age.trim().length === 0) next.age = "Your age is required.";
    else if (age === null)
      next.age = `Enter your age in whole years, ${MIN_AGE} to ${MAX_AGE}.`;
    else if (age < MIN_AGE || age > MAX_AGE)
      next.age = `Must be between ${MIN_AGE} and ${MAX_AGE}`;

    if (city.length === 0) next.city = "Your city or district is required.";

    if (profile.occupation === "")
      next.occupation = "Select the closest match to how you earn.";

    if (profile.hasCibilScore) {
      if (profile.cibilScore.trim().length === 0)
        next.cibilScore = "Enter your score, or turn the switch off.";
      else if (cibil === null || cibil < SCORE_MIN || cibil > SCORE_MAX)
        next.cibilScore = `A bureau score sits between ${SCORE_MIN} and ${SCORE_MAX}.`;
    }

    return next;
  }, [profile, age, cibil]);

  const errorFor = (field: ProfileField): string | undefined =>
    touched[field] || forceErrors ? errors[field] : undefined;

  const setField = <K extends keyof ProfileForm>(
    key: K,
    value: ProfileForm[K],
  ) => setProfile((prev) => ({ ...prev, [key]: value }));

  const markTouched = (field: ProfileField) =>
    setTouched((prev) => ({ ...prev, [field]: true }));

  /**
   * Consent is rebuilt from BEHAVIOR_ORDER on every change, so the array in
   * state is the canonical list rather than a log of the order things were
   * clicked in. Consent is not part of `seedFor` in useVistara, so this changes
   * no timestamp — it only keeps the stored list in one canonical order.
   */
  const setConsent = (source: BehaviorSource, next: boolean) =>
    setConsentedSources((prev) =>
      BEHAVIOR_ORDER.filter((candidate) =>
        candidate === source ? next : prev.indexOf(candidate) !== -1,
      ),
    );

  const toggleExplanation = (source: BehaviorSource) =>
    setExplained((prev) => ({ ...prev, [source]: !prev[source] }));

  /**
   * Rebuilt as a fresh triple rather than mutated in place — the tuple type is
   * what `VistaraInput.archetypeAnswers` is declared as, and a spread of a
   * 3-tuple widens to number[], which would not satisfy it.
   */
  const setAnswer = (index: number, choice: number) =>
    setArchetypeAnswers((prev) => [
      index === 0 ? choice : prev[0],
      index === 1 ? choice : prev[1],
      index === 2 ? choice : prev[2],
    ]);

  const step1Valid = Object.keys(errors).length === 0;

  /**
   * The engine's own cold-start rule, read off Step 1. A gig worker or farmer
   * under 25 has no dealer-recorded service history to share, and useVistara
   * drops the signal whatever the switch says — so the count, the gate and the
   * processing screen use the sources that can actually be read, not the ones
   * ticked. Null until age and occupation are both valid.
   */
  const availability = useMemo(
    () =>
      age !== null && profile.occupation !== ""
        ? defaultStreamAvailability({ age, occupation: profile.occupation })
        : null,
    [age, profile.occupation],
  );
  const usableSources = consentedSources.filter(
    (source) => availability === null || availability[source],
  );
  const step2Valid = usableSources.length >= MIN_CONSENTED_SOURCES;
  const step3Valid = archetypeAnswers.every((answer) => answer >= 0);
  const canAdvance =
    step === 1 ? step1Valid : step === 2 ? step2Valid : step3Valid;

  /**
   * Eligibility for the seasonal exception, read off the occupation chosen in
   * Step 1 and checked against SEASONAL_OCCUPATIONS — the list the engine
   * itself reads. See `seasonallyEligible`.
   */
  const seasonalApplicant =
    profile.occupation !== "" && seasonallyEligible(profile.occupation);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (step === 1) {
      if (!step1Valid) {
        setForceErrors(true);
        return;
      }
      goTo(2);
      return;
    }

    if (step === 2) {
      if (step2Valid) goTo(3);
      return;
    }

    /* --- step 3: hand the form to the engine --------------------- */

    // Enter on a focused radio submits the form, so this branch is reachable
    // with the button still disabled. The two guards below are also what narrow
    // `age` off null and `occupation` off "" for the type checker — step1Valid
    // already implies both, but implying is not narrowing.
    if (!step3Valid || isProcessing) return;
    if (age === null || profile.occupation === "") return;

    // The loan is a REQUEST, not evidence: it is deliberately absent from
    // CustomerProfile and never reaches the engine, so it travels beside the
    // profile rather than inside it. /score/live prints it next to the ceiling
    // the tier actually allows.
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(
          LOAN_REQUEST_KEY,
          String(profile.loanAmount),
        );
      } catch {
        // Private-mode quota errors are not worth failing a submission over.
        // The scorecard simply omits the requested figure.
      }
    }

    submitted.current = true;
    submit({
      customer: {
        name: profile.name.trim(),
        age,
        city: profile.city.trim(),
        occupation: profile.occupation,
        monthlyIncome: profile.monthlyIncome,
        hasCibilScore: profile.hasCibilScore,
        // Only carried when the switch is on. `undefined` rather than 0, because
        // a bureau score of zero is a claim and absence is not.
        cibilScore:
          profile.hasCibilScore && cibil !== null ? cibil : undefined,
      },
      consentedSources,
      archetypeAnswers,
    });
  };

  /* --- panel motion classes -------------------------------------- */

  const panelMotion =
    motion === "leaving"
      ? direction === 1
        ? "opacity-0 -translate-x-5"
        : "opacity-0 translate-x-5"
      : motion === "entering"
        ? direction === 1
          ? "opacity-0 translate-x-5"
          : "opacity-0 -translate-x-5"
        : "opacity-100 translate-x-0";

  /* --- render ---------------------------------------------------- */

  return (
    // No bg or min-h-screen here: layout.tsx's <body> already carries both, and
    // a second min-h-screen inside <main> under a 56px sticky header buys a
    // permanent scrollbar on a form that fits the viewport.
    <div className="mx-auto max-w-2xl px-4 py-12">
      <SectionHeading
        as="h1"
        size="page"
        eyebrow="Application · live scoring"
        title="Build your Vistara profile"
        description="Three steps, about two minutes. Nothing you type here is scored — the score comes from the timing of rhythms you choose to share in step two."
      />

      <div className="mt-8">
        <Progress step={step} />
      </div>

      {/* The wizard is replaced, not overlaid: the form still holds a submitted
          applicant's answers, and leaving it under a loading state invites a
          second submission against a profile that is already being built. */}
      {isProcessing ? (
        <ProcessingPanel
          consented={usableSources}
          reduced={reducedMotion.current}
        />
      ) : (
        <form onSubmit={handleSubmit} noValidate className="mt-8">
          <div
            key={step}
            className={`transition-[opacity,transform] duration-200 ease-out ${panelMotion}`}
          >
            {/* ── Step 1 — profile ─────────────────────────────────── */}
            {step === 1 ? (
              <Card
                title="Tell us about yourself"
                description="This helps us benchmark your rhythm against the right peer group."
              >
                <div className="grid gap-6">
                  <Field id="live-name" label="Full name" error={errorFor("name")}>
                    <input
                      id="live-name"
                      name="name"
                      type="text"
                      autoComplete="name"
                      className={INPUT_CLASS}
                      placeholder="Your full name"
                      value={profile.name}
                      maxLength={MAX_NAME_LENGTH}
                      aria-invalid={errorFor("name") !== undefined}
                      aria-describedby={
                        errorFor("name") === undefined
                          ? undefined
                          : "live-name-error"
                      }
                      onChange={(event) => setField("name", event.target.value)}
                      onBlur={() => markTouched("name")}
                    />
                  </Field>

                  <div className="grid gap-6 sm:grid-cols-2">
                    <Field id="live-age" label="Age" error={errorFor("age")}>
                      <input
                        id="live-age"
                        name="age"
                        type="number"
                        inputMode="numeric"
                        min={MIN_AGE}
                        max={MAX_AGE}
                        className={INPUT_CLASS}
                        placeholder="Your age"
                        value={profile.age}
                        aria-invalid={errorFor("age") !== undefined}
                        aria-describedby={
                          errorFor("age") === undefined
                            ? undefined
                            : "live-age-error"
                        }
                        onChange={(event) => setField("age", event.target.value)}
                        onBlur={() => markTouched("age")}
                      />
                    </Field>

                    <Field
                      id="live-city"
                      label="City or district"
                      error={errorFor("city")}
                    >
                      <input
                        id="live-city"
                        name="city"
                        type="text"
                        autoComplete="address-level2"
                        className={INPUT_CLASS}
                        placeholder="Where you live"
                        value={profile.city}
                        maxLength={MAX_CITY_LENGTH}
                        aria-invalid={errorFor("city") !== undefined}
                        aria-describedby={
                          errorFor("city") === undefined
                            ? undefined
                            : "live-city-error"
                        }
                        onChange={(event) => setField("city", event.target.value)}
                        onBlur={() => markTouched("city")}
                      />
                    </Field>
                  </div>

                  <Field
                    id="live-occupation"
                    label="Occupation"
                    error={errorFor("occupation")}
                    hint={
                      profile.occupation !== "" &&
                      seasonallyEligible(profile.occupation)
                        ? "Cyclical income. Harvest and festival gaps in your dates can be set aside before your rhythm is measured — and it is always disclosed on your scorecard."
                        : "Occupation decides one thing only: whether seasonal gaps in your dates can be forgiven."
                    }
                  >
                    <OccupationSelect
                      id="live-occupation"
                      value={profile.occupation}
                      invalid={errorFor("occupation") !== undefined}
                      describedBy={
                        errorFor("occupation") === undefined
                          ? "live-occupation-hint"
                          : "live-occupation-error"
                      }
                      onChange={(next) => {
                        setField("occupation", next);
                        markTouched("occupation");
                      }}
                      onBlur={() => markTouched("occupation")}
                    />
                  </Field>

                  <SliderField
                    id="live-income"
                    label="Monthly income"
                    value={profile.monthlyIncome}
                    min={INCOME_MIN}
                    max={INCOME_MAX}
                    step={INCOME_STEP}
                    hint="Recorded for the loan file. It is never an input to your Vistara score."
                    format={(value) => `${formatINR(value)} / month`}
                    onChange={(next) => setField("monthlyIncome", next)}
                  />

                  <SliderField
                    id="live-loan"
                    label="Loan amount needed"
                    value={profile.loanAmount}
                    min={LOAN_MIN}
                    max={LOAN_MAX}
                    step={LOAN_STEP}
                    hint="What you are asking for. Your tier sets the ceiling we can actually offer."
                    format={formatINR}
                    onChange={(next) => setField("loanAmount", next)}
                  />

                  {/* Bureau score — off by default, because the whole point is
                      that Vistara does not need one. */}
                  <div className="rounded-xl border border-vistara-border bg-vistara-dark/50 p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-[14px] text-vistara-text">
                          I have a CIBIL / credit score
                        </p>
                        <p className="mt-1 text-[12px] leading-relaxed text-vistara-muted">
                          Recorded for comparison only. It never enters the score —
                          Vistara reads {SCORE_MIN}–{SCORE_MAX} from your rhythms
                          with no bureau input at all.
                        </p>
                      </div>
                      <ToggleSwitch
                        id="live-has-cibil"
                        checked={profile.hasCibilScore}
                        label="I have a CIBIL or credit score"
                        onChange={(next) => {
                          setField("hasCibilScore", next);
                          if (!next) setField("cibilScore", "");
                        }}
                      />
                    </div>

                    <div
                      className="overflow-hidden transition-[max-height] duration-200 ease-out"
                      style={{
                        maxHeight: profile.hasCibilScore ? CIBIL_REVEAL_PX : 0,
                      }}
                    >
                      {/* No second label: the switch beside it already says what
                          this field is, and 72px of reveal has to hold a control
                          that still clears a thumb-sized hit target. */}
                      <div className="pt-3">
                        <input
                          id="live-cibil"
                          name="cibilScore"
                          type="number"
                          inputMode="numeric"
                          min={SCORE_MIN}
                          max={SCORE_MAX}
                          aria-label="Your CIBIL or credit score"
                          // Off-switch means out of the tab order, not just hidden.
                          tabIndex={profile.hasCibilScore ? undefined : -1}
                          aria-hidden={profile.hasCibilScore ? undefined : true}
                          className={INPUT_CLASS}
                          placeholder="Enter score"
                          value={profile.cibilScore}
                          aria-invalid={errorFor("cibilScore") !== undefined}
                          onChange={(event) =>
                            setField("cibilScore", event.target.value)
                          }
                          onBlur={() => markTouched("cibilScore")}
                        />
                      </div>
                    </div>

                    {errorFor("cibilScore") === undefined ? null : (
                      <p
                        id="live-cibil-error"
                        className="mt-2 text-[12px] text-vistara-red"
                      >
                        {errorFor("cibilScore")}
                      </p>
                    )}
                  </div>
                </div>
              </Card>
            ) : null}

            {/* ── Step 2 — data ────────────────────────────────────── */}
            {step === 2 ? (
              <div className="grid gap-5">
                <SectionHeading
                  as="h2"
                  size="section"
                  title="Choose what you share"
                  description="We read timing patterns only — never transaction amounts or personal messages."
                />

                <div className="grid gap-2">
                  <Notice tone="accent">
                    Designed for the AA Framework · Timestamps only · Revoke access
                    anytime
                  </Notice>

                  {seasonalApplicant ? (
                    <Notice tone="amber">
                      Seasonal adjustment enabled — harvest and festival-cycle
                      gaps in your rhythm will not count against your score.
                      <span className="mt-1.5 block text-[12px] text-vistara-muted">
                        Your occupation decides eligibility; your dates decide
                        whether anything is actually forgiven — at most{" "}
                        {MAX_SEASONAL_EXCLUSIONS} gaps per signal, and only on the
                        signals that repeat monthly or slower. Every exclusion is
                        named on your scorecard.
                      </span>
                    </Notice>
                  ) : null}
                </div>

                <div className="grid gap-3">
                  {BEHAVIOR_ORDER.map((source) => (
                    <SourceCard
                      key={source}
                      source={source}
                      consented={consentedSources.indexOf(source) !== -1}
                      unavailable={
                        availability === null || availability[source]
                          ? undefined
                          : source === "vehicle_service"
                            ? "No service history to read yet. Under 25 in your line of work, this is most likely your first vehicle, so this signal starts with its first dealer-recorded service."
                            : "No history on file for this signal yet."
                      }
                      explained={explained[source]}
                      onConsentChange={(next) => setConsent(source, next)}
                      onExplainToggle={() => toggleExplanation(source)}
                    />
                  ))}
                </div>

                {/* One live region, three states: blocked, allowed but below the
                    engine's own floor, and fine. The middle state is the reason
                    this is not a plain error message — two signals is permitted
                    and does produce a verdict, just not a cross-domain one. */}
                <p
                  aria-live="polite"
                  className={[
                    "text-sm leading-relaxed",
                    step2Valid ? "text-vistara-muted" : "text-vistara-amber",
                  ].join(" ")}
                >
                  {!step2Valid ? (
                    `Select at least ${MIN_CONSENTED_SOURCES} signals for a meaningful score.`
                  ) : usableSources.length < MIN_STREAMS_TO_SCORE ? (
                    <>
                      {usableSources.length} of {BEHAVIOR_ORDER.length} shared.
                      The engine wants {MIN_STREAMS_TO_SCORE} before it will claim
                      a cross-domain rhythm exists — below that your file is
                      reported as thin on evidence, said plainly on the scorecard
                      rather than disguised as a low score.
                    </>
                  ) : (
                    <>
                      {usableSources.length} of {BEHAVIOR_ORDER.length} shared
                      — enough for a cross-domain reading. Absent signals are left
                      out of the weighting, never guessed at.
                    </>
                  )}
                </p>
              </div>
            ) : null}

            {/* ── Step 3 — mindset ─────────────────────────────────── */}
            {step === 3 ? (
              <div className="grid gap-5">
                <SectionHeading
                  as="h2"
                  size="section"
                  title="3 quick scenarios"
                  description="No right or wrong answers — this takes about 45 seconds."
                />

                {/* Revealed one at a time: a question appears once the one before
                    it is answered. Three scenarios at once reads as a test; one
                    at a time reads as a conversation, and it is also why the
                    answered questions stay on screen rather than being replaced —
                    an answer you cannot go back and change is not one you gave
                    freely. */}
                <div className="grid gap-6">
                  {MINDSET_QUESTIONS.map((question, index) =>
                    index === 0 ||
                    archetypeAnswers[index - 1] !== UNANSWERED ? (
                      <MindsetQuestion
                        key={question.prompt}
                        index={index}
                        prompt={question.prompt}
                        answers={question.answers}
                        answer={archetypeAnswers[index]}
                        onAnswer={(choice) => setAnswer(index, choice)}
                      />
                    ) : null,
                  )}
                </div>

                <p className="text-[12px] leading-relaxed text-vistara-muted">
                  These answers set the character of the history we read, not your
                  score. The engine measures the dates and may disagree with what
                  you said about yourself — where it does, your scorecard reports
                  what the timestamps show.
                </p>
              </div>
            ) : null}
          </div>

          {/* ── Navigation ─────────────────────────────────────────── */}
          <div className="mt-6 flex items-center gap-3">
            {step > 1 ? (
              <Button
                variant="ghost"
                size="md"
                onClick={() => goTo((step - 1) as StepIndex)}
              >
                ← Back
              </Button>
            ) : null}

            {/* Never disabled on step 1: a disabled submit swallows the click
                and the Enter key alike, so handleSubmit's forced errors could
                never run and a field nobody touched — an occupation never
                opened — was never flagged. Steps 2 and 3 state their gate on
                screen, so there the disabled state explains itself. */}
            <Button
              type="submit"
              size="md"
              disabled={step !== 1 && !canAdvance}
              className="ml-auto"
            >
              {step === 3 ? "Build My Profile →" : "Continue →"}
            </Button>
          </div>

          {/* Step 2 is excluded: its own panel already carries a live region
              saying the same thing, and two messages about one disabled button
              reads as a bug rather than as emphasis. */}
          {!canAdvance && step !== 2 ? (
            <p
              aria-live="polite"
              className="mt-3 text-right text-[12px] text-vistara-muted"
            >
              {step === 1
                ? "Complete the fields above to continue."
                : "Answer all three questions to continue."}
            </p>
          ) : null}
        </form>
      )}
    </div>
  );
}
