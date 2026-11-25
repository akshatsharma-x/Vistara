"use client";

/**
 * Vistara — application flow.
 *
 * Three steps: identity, consent, review. The consent step is the centrepiece:
 * it names every field Vistara reads, every field it refuses to read, the
 * Account Aggregator that moves the data, and the DPDP Act 2023 principles the
 * consent artefact is bound by. A judge who asks "what about privacy?" should
 * find the answer already on screen.
 *
 * DETERMINISM: no Math.random(), no Date.now(), no argless new Date(). The
 * sample profile an application routes to is selected by a pure function of the
 * entered occupation and income against the frozen DEMO_CUSTOMERS cohort, so the
 * same inputs always land on the same scorecard — on stage, twice, identically.
 */

import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import {
  ARCHETYPE_META,
  BEHAVIOR_META,
  BEHAVIOR_ORDER,
  BEHAVIOR_WEIGHTS,
  MAX_SEASONAL_EXCLUSIONS,
  MIN_STREAMS_TO_SCORE,
  OBSERVATION_DAYS,
  OBSERVATION_MONTHS,
  OCCUPATION_META,
  SCORE_MAX,
  SCORE_MIN,
  SEASONAL_WINDOWS,
} from "@/lib/constants";
import { DEMO_CUSTOMERS } from "@/lib/synthetic-data";
import { formatINR, pct } from "@/lib/format";
import type { BehaviorSource, Occupation, TemporalProfile } from "@/lib/types";
import {
  Button,
  Card,
  DataTable,
  SectionHeading,
  StatTile,
  TierBadge,
  type DataTableColumn,
} from "@/components/ui";

/* ------------------------------------------------------------------ *
 * Input bounds — prototype form limits, not model parameters
 * ------------------------------------------------------------------ */

const MIN_AGE = 18;
const MAX_AGE = 75;
const MIN_INCOME = 5000;
const MAX_INCOME = 500000;
const MAX_NAME_LENGTH = 60;
const NAME_PATTERN = /^[A-Za-z][A-Za-z .'-]*$/;

const OCCUPATION_OPTIONS: Occupation[] = [
  "gig_worker",
  "small_merchant",
  "salaried_informal",
  "farmer",
  "self_employed",
];

/* ------------------------------------------------------------------ *
 * Consent copy — one entry per behavioural signal
 * ------------------------------------------------------------------ *
 * `never` is the load-bearing line. Every one of these is a field that simply
 * does not appear in the fetch schema: an amount cannot leak out of a request
 * that never asks for it.
 */

const CONSENT_DETAIL: Record<
  BehaviorSource,
  { holder: string; reads: string; never: string }
> = {
  vehicle_service: {
    holder: "TVS dealer service records",
    reads:
      "the DATE a dealer closed a service job card on your vehicle — one timestamp per visit.",
    never:
      "the invoice amount, the parts or labour lines, the odometer reading, or which dealer you used.",
  },
  upi_recurring: {
    holder: "Account Aggregator — UPI mandate log",
    reads:
      "the DATE each standing UPI mandate was debited. Only mandates that repeat; one timestamp per debit.",
    never:
      "the amount, the payee's UPI ID or name, your one-off transactions, or your account balance.",
  },
  utility_bill: {
    holder: "BBPS biller confirmation",
    reads:
      "the DATE your electricity payment was confirmed against your own consumer number.",
    never:
      "units consumed, the bill amount, your meter number, or your service address.",
  },
  phone_recharge: {
    holder: "Telecom operator recharge log",
    reads: "the DATE each prepaid pack was activated.",
    never:
      "the pack price, your call or SMS records, your contacts, or your data usage.",
  },
  fastag_toll: {
    holder: "NETC FASTag (NPCI) passage log",
    reads: "the DATE of each toll-plaza passage.",
    never:
      "the toll amount, which plaza you crossed, your route or destination, or your wallet balance.",
  },
};

/* ------------------------------------------------------------------ *
 * Deterministic sample-profile matching
 * ------------------------------------------------------------------ */

/**
 * Matches the entered inputs to one of the twelve frozen synthetic histories:
 * occupation first, then nearest monthly income. Ties resolve to the earlier
 * profile in cohort order, so this is a total function of its arguments — the
 * same form always produces the same scorecard.
 */
function matchSampleProfile(
  occupation: Occupation | "",
  monthlyIncome: number | null,
): TemporalProfile {
  const pool =
    occupation === ""
      ? DEMO_CUSTOMERS
      : DEMO_CUSTOMERS.filter((p) => p.customer.occupation === occupation);
  const candidates = pool.length > 0 ? pool : DEMO_CUSTOMERS;
  const target = monthlyIncome ?? candidates[0].customer.monthlyIncome;

  let best = candidates[0];
  let bestGap = Math.abs(best.customer.monthlyIncome - target);
  for (let i = 1; i < candidates.length; i++) {
    const gap = Math.abs(candidates[i].customer.monthlyIncome - target);
    if (gap < bestGap) {
      best = candidates[i];
      bestGap = gap;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Form model
 * ------------------------------------------------------------------ */

type StepIndex = 1 | 2 | 3;
type IdentityField = "name" | "age" | "occupation" | "income" | "cibil";

interface IdentityForm {
  name: string;
  age: string;
  occupation: Occupation | "";
  income: string;
  noCibil: boolean;
  cibil: string;
}

const EMPTY_IDENTITY: IdentityForm = {
  name: "",
  age: "",
  occupation: "",
  income: "",
  noCibil: true,
  cibil: "",
};

const NO_TOUCHED: Record<IdentityField, boolean> = {
  name: false,
  age: false,
  occupation: false,
  income: false,
  cibil: false,
};

const ALL_CONSENTS: Record<BehaviorSource, boolean> = BEHAVIOR_ORDER.reduce(
  (acc, source) => ({ ...acc, [source]: true }),
  {} as Record<BehaviorSource, boolean>,
);

const NO_CONSENTS: Record<BehaviorSource, boolean> = BEHAVIOR_ORDER.reduce(
  (acc, source) => ({ ...acc, [source]: false }),
  {} as Record<BehaviorSource, boolean>,
);

/** Digits only, after stripping the separators people type into money fields. */
function parseWholeNumber(raw: string): number | null {
  const cleaned = raw.replace(/[\s,]/g, "");
  if (!/^\d{1,9}$/.test(cleaned)) return null;
  return Number.parseInt(cleaned, 10);
}

const STEPS: { index: StepIndex; label: string; hint: string }[] = [
  { index: 1, label: "Identity", hint: "Who is applying" },
  { index: 2, label: "Consent", hint: "What Vistara may read" },
  { index: 3, label: "Review", hint: "Confirm and score" },
];

/* ------------------------------------------------------------------ *
 * Local presentation helpers
 * ------------------------------------------------------------------ */

const INPUT_CLASS =
  "h-10 w-full rounded-md border border-vistara-border bg-vistara-dark px-3 text-[13px] text-vistara-text placeholder:text-vistara-muted/70 hover:border-vistara-border focus:border-vistara-accent focus:outline-none disabled:opacity-45";

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
      <label
        htmlFor={id}
        className="block text-[12px] font-medium text-vistara-text"
      >
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
      {error === undefined ? (
        hint === undefined ? null : (
          <p
            id={`${id}-hint`}
            className="mt-1.5 text-[11px] leading-relaxed text-vistara-muted"
          >
            {hint}
          </p>
        )
      ) : (
        <p
          id={`${id}-error`}
          className="mt-1.5 text-[11px] leading-relaxed text-vistara-red"
        >
          {error}
        </p>
      )}
    </div>
  );
}

function Stepper({
  step,
  furthestReached,
  onSelect,
}: {
  step: StepIndex;
  furthestReached: StepIndex;
  onSelect: (next: StepIndex) => void;
}) {
  return (
    <nav aria-label="Application progress">
      <ol className="grid gap-2 sm:grid-cols-3">
        {STEPS.map((entry) => {
          const isCurrent = entry.index === step;
          const isDone = entry.index < step;
          const reachable = entry.index <= furthestReached;

          return (
            <li
              key={entry.index}
              aria-current={isCurrent ? "step" : undefined}
              className="min-w-0"
            >
              <button
                type="button"
                disabled={!reachable}
                onClick={() => onSelect(entry.index)}
                className={[
                  "flex w-full items-center gap-3 rounded-card border px-4 py-3 text-left transition-colors",
                  isCurrent
                    ? "border-vistara-accent/60 bg-vistara-surface"
                    : "border-vistara-border bg-vistara-surface/40",
                  reachable && !isCurrent
                    ? "hover:border-vistara-border hover:bg-vistara-surface"
                    : "",
                  reachable ? "" : "cursor-not-allowed opacity-55",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <span
                  aria-hidden
                  className={[
                    "grid h-6 w-6 shrink-0 place-items-center rounded-md text-[11px] font-semibold",
                    isCurrent
                      ? "bg-vistara-accent/20 text-vistara-accent ring-2 ring-vistara-accent/50"
                      : isDone
                        ? "bg-vistara-accent/10 text-vistara-accent ring-1 ring-vistara-accent/30"
                        : "text-vistara-muted ring-1 ring-vistara-border",
                  ].join(" ")}
                >
                  {isDone ? "●" : entry.index}
                </span>

                <span className="min-w-0">
                  <span
                    className={[
                      "block truncate text-[13px]",
                      isCurrent
                        ? "font-semibold text-vistara-text"
                        : "font-medium text-vistara-text/85",
                    ].join(" ")}
                  >
                    {entry.label}
                    <span className="sr-only">
                      {isCurrent
                        ? " — current step"
                        : isDone
                          ? " — completed"
                          : " — not started"}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-vistara-muted">
                    {isDone ? "Completed" : entry.hint}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function ConsentSwitch({
  id,
  checked,
  label,
  onChange,
}: {
  id: string;
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2.5">
      <span
        className={[
          "hidden text-[11px] font-medium sm:inline",
          checked ? "text-vistara-text" : "text-vistara-muted",
        ].join(" ")}
        aria-hidden
      >
        {checked ? "Shared" : "Not shared"}
      </span>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={`${label} — ${checked ? "shared, select to revoke" : "not shared, select to allow"}`}
        onClick={() => onChange(!checked)}
        className={[
          "relative h-6 w-11 shrink-0 rounded-full border transition-colors",
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
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-vistara-border/60 py-2.5 last:border-b-0">
      <dt className="text-[12px] text-vistara-muted">{label}</dt>
      <dd className="text-right text-[13px] font-medium text-vistara-text">
        {value}
      </dd>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function ApplyPage() {
  const router = useRouter();

  const [step, setStep] = useState<StepIndex>(1);
  const [furthestReached, setFurthestReached] = useState<StepIndex>(1);
  const [identity, setIdentity] = useState<IdentityForm>(EMPTY_IDENTITY);
  const [touched, setTouched] =
    useState<Record<IdentityField, boolean>>(NO_TOUCHED);
  const [forceErrors, setForceErrors] = useState(false);
  const [consents, setConsents] =
    useState<Record<BehaviorSource, boolean>>(ALL_CONSENTS);
  const [revoked, setRevoked] = useState(false);

  const setField = <K extends keyof IdentityForm>(
    key: K,
    value: IdentityForm[K],
  ) => setIdentity((prev) => ({ ...prev, [key]: value }));

  const markTouched = (field: IdentityField) =>
    setTouched((prev) => ({ ...prev, [field]: true }));

  /* --- derived numbers ------------------------------------------- */

  const age = parseWholeNumber(identity.age);
  const income = parseWholeNumber(identity.income);
  const cibil = parseWholeNumber(identity.cibil);

  const errors = useMemo<Partial<Record<IdentityField, string>>>(() => {
    const next: Partial<Record<IdentityField, string>> = {};
    const name = identity.name.trim();

    if (name.length === 0) {
      next.name = "Enter the applicant's name as printed on their KYC document.";
    } else if (name.length < 3 || name.length > MAX_NAME_LENGTH) {
      next.name = `Name must be 3 to ${MAX_NAME_LENGTH} characters.`;
    } else if (!NAME_PATTERN.test(name)) {
      next.name = "Letters, spaces, hyphens, apostrophes and full stops only.";
    }

    if (identity.age.trim().length === 0) {
      next.age = "Age is required.";
    } else if (age === null) {
      next.age = "Age must be a whole number of years.";
    } else if (age < MIN_AGE || age > MAX_AGE) {
      next.age = `Age must be between ${MIN_AGE} and ${MAX_AGE}.`;
    }

    if (identity.occupation === "") {
      next.occupation =
        "Select an occupation — it decides whether seasonal adjustment applies.";
    }

    if (identity.income.trim().length === 0) {
      next.income = "Monthly income is required.";
    } else if (income === null) {
      next.income = "Enter a whole rupee figure, digits only.";
    } else if (income < MIN_INCOME || income > MAX_INCOME) {
      next.income = `This prototype accepts ${formatINR(MIN_INCOME)} to ${formatINR(MAX_INCOME)} a month.`;
    }

    if (!identity.noCibil && identity.cibil.trim().length > 0) {
      if (cibil === null || cibil < SCORE_MIN || cibil > SCORE_MAX) {
        next.cibil = `A bureau score sits between ${SCORE_MIN} and ${SCORE_MAX}.`;
      }
    }

    return next;
  }, [identity, age, income, cibil]);

  const errorFor = (field: IdentityField): string | undefined =>
    touched[field] || forceErrors ? errors[field] : undefined;

  const sharedSources = BEHAVIOR_ORDER.filter((source) => consents[source]);
  const sharedWeight = sharedSources.reduce(
    (sum, source) => sum + BEHAVIOR_WEIGHTS[source],
    0,
  );
  const appliedWeight = (source: BehaviorSource): number =>
    sharedWeight === 0 ? 0 : (BEHAVIOR_WEIGHTS[source] / sharedWeight) * 100;

  const step1Valid = Object.keys(errors).length === 0;
  const step2Valid = sharedSources.length >= MIN_STREAMS_TO_SCORE;
  const canAdvance = step === 1 ? step1Valid : step === 2 ? step2Valid : true;

  const matched = useMemo(
    () => matchSampleProfile(identity.occupation, income),
    [identity.occupation, income],
  );
  const incomeGap =
    income === null
      ? null
      : Math.abs(matched.customer.monthlyIncome - income);
  const targetHref = `/score?id=${matched.customer.id}`;

  const seasonal =
    identity.occupation !== "" && OCCUPATION_META[identity.occupation].seasonal;

  /* --- navigation ------------------------------------------------ */

  const goTo = (next: StepIndex) => {
    setStep(next);
    setForceErrors(false);
    setFurthestReached((prev) => (next > prev ? next : prev));
  };

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
      if (!step2Valid) return;
      goTo(3);
      return;
    }

    if (step1Valid && step2Valid) router.push(targetHref);
  };

  /* --- sample-applicant table ------------------------------------ */

  const sampleColumns: DataTableColumn<TemporalProfile>[] = [
    {
      key: "name",
      label: "Applicant",
      rowHeader: true,
      width: "26%",
      render: (row) => (
        <span className="block">
          <span className="block truncate">{row.customer.name}</span>
          <span className="block truncate text-[11px] font-normal text-vistara-muted">
            {row.customer.city} · age {row.customer.age}
          </span>
        </span>
      ),
    },
    {
      key: "occupation",
      label: "Occupation",
      width: "17%",
      render: (row) => OCCUPATION_META[row.customer.occupation].label,
    },
    {
      key: "archetype",
      label: "Archetype",
      width: "13%",
      render: (row) => ARCHETYPE_META[row.financialArchetype].label,
    },
    {
      key: "income",
      label: "Income / mo",
      align: "right",
      width: "13%",
      render: (row) => formatINR(row.customer.monthlyIncome),
    },
    {
      key: "signals",
      label: "Signals",
      align: "right",
      width: "9%",
      render: (row) => `${row.scoredSources.length} of ${BEHAVIOR_ORDER.length}`,
    },
    {
      key: "tier",
      label: "Tier",
      width: "12%",
      render: (row) => (
        <TierBadge tier={row.tier} score={row.vistaraScore} size="sm" />
      ),
    },
    {
      key: "open",
      label: "Scorecard",
      align: "right",
      width: "10%",
      render: (row) => (
        <Button
          href={`/score?id=${row.customer.id}`}
          variant="secondary"
          size="sm"
        >
          Open
        </Button>
      ),
    },
  ];

  /* --- render ---------------------------------------------------- */

  return (
    <div className="mx-auto max-w-6xl px-5 py-12">
      <SectionHeading
        as="h1"
        size="page"
        eyebrow="Application · Account Aggregator consent"
        title="Apply without a credit history"
        description="Three steps. Vistara asks for your identity once, asks permission for five timestamp streams, and then scores the regularity of those rhythms. It never asks what you earned, spent, or bought — and every figure quoted on this page comes from the engine's own constants."
        action={
          <Button href="#sample-applicants" variant="ghost" size="sm">
            Skip to sample applicants
          </Button>
        }
      />

      <div className="mt-8">
        <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.14em] text-vistara-muted">
          Step {step} of {STEPS.length} — {STEPS[step - 1].label}
        </p>
        <Stepper
          step={step}
          furthestReached={furthestReached}
          onSelect={goTo}
        />
      </div>

      <form
        onSubmit={handleSubmit}
        noValidate
        className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]"
      >
        <div className="min-w-0 space-y-6">
          {/* ── Step 1 — identity ───────────────────────────────── */}
          {step === 1 ? (
            <Card
              eyebrow="Step 1"
              title="Who is applying"
              description="Identity and income are used for KYC, eligibility and the officer's file. None of these four fields enters the Vistara score — the score is computed from timestamps alone."
            >
              <div className="grid gap-5 sm:grid-cols-2">
                <Field
                  id="applicant-name"
                  label="Full name"
                  error={errorFor("name")}
                  hint="As printed on the KYC document."
                >
                  <input
                    id="applicant-name"
                    name="name"
                    type="text"
                    autoComplete="name"
                    className={INPUT_CLASS}
                    placeholder="Lakshmi Narayanan"
                    value={identity.name}
                    maxLength={MAX_NAME_LENGTH}
                    aria-invalid={errorFor("name") !== undefined}
                    aria-describedby={
                      errorFor("name") === undefined
                        ? "applicant-name-hint"
                        : "applicant-name-error"
                    }
                    onChange={(e) => setField("name", e.target.value)}
                    onBlur={() => markTouched("name")}
                  />
                </Field>

                <Field
                  id="applicant-age"
                  label="Age"
                  error={errorFor("age")}
                  hint={`${MIN_AGE} is the age of majority in India; ${MAX_AGE} is this prototype's upper bound.`}
                >
                  <input
                    id="applicant-age"
                    name="age"
                    type="text"
                    inputMode="numeric"
                    className={INPUT_CLASS}
                    placeholder="34"
                    value={identity.age}
                    maxLength={3}
                    aria-invalid={errorFor("age") !== undefined}
                    aria-describedby={
                      errorFor("age") === undefined
                        ? "applicant-age-hint"
                        : "applicant-age-error"
                    }
                    onChange={(e) => setField("age", e.target.value)}
                    onBlur={() => markTouched("age")}
                  />
                </Field>

                <Field
                  id="applicant-occupation"
                  label="Occupation"
                  error={errorFor("occupation")}
                  hint={
                    seasonal
                      ? `Seasonal adjustment is available for this occupation: up to ${MAX_SEASONAL_EXCLUSIONS} gaps per monthly-or-slower signal falling inside ${SEASONAL_WINDOWS.map((w) => w.label).join(" or ")} may be excluded before sigma is measured — and it is always disclosed on the scorecard.`
                      : "Farmers and small merchants are additionally eligible for seasonal adjustment."
                  }
                >
                  <select
                    id="applicant-occupation"
                    name="occupation"
                    className={`${INPUT_CLASS} pr-8`}
                    value={identity.occupation}
                    aria-invalid={errorFor("occupation") !== undefined}
                    aria-describedby={
                      errorFor("occupation") === undefined
                        ? "applicant-occupation-hint"
                        : "applicant-occupation-error"
                    }
                    onChange={(e) =>
                      setField("occupation", e.target.value as Occupation | "")
                    }
                    onBlur={() => markTouched("occupation")}
                  >
                    <option value="">Select an occupation</option>
                    {OCCUPATION_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {OCCUPATION_META[option].label}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field
                  id="applicant-income"
                  label="Monthly income"
                  error={errorFor("income")}
                  hint={
                    income === null
                      ? `Rupees per month, digits only. ${formatINR(MIN_INCOME)} to ${formatINR(MAX_INCOME)}.`
                      : `${formatINR(income)} per month.`
                  }
                >
                  <div className="relative">
                    <span
                      aria-hidden
                      className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-vistara-muted"
                    >
                      ₹
                    </span>
                    <input
                      id="applicant-income"
                      name="income"
                      type="text"
                      inputMode="numeric"
                      className={`${INPUT_CLASS} pl-7`}
                      placeholder="28,000"
                      value={identity.income}
                      maxLength={9}
                      aria-invalid={errorFor("income") !== undefined}
                      aria-describedby={
                        errorFor("income") === undefined
                          ? "applicant-income-hint"
                          : "applicant-income-error"
                      }
                      onChange={(e) => setField("income", e.target.value)}
                      onBlur={() => markTouched("income")}
                    />
                  </div>
                </Field>
              </div>

              {/* No-CIBIL declaration */}
              <div className="mt-6 rounded-card border border-vistara-border bg-vistara-dark/50 p-4">
                <label
                  htmlFor="no-cibil"
                  className="flex cursor-pointer items-start gap-3"
                >
                  <input
                    id="no-cibil"
                    name="noCibil"
                    type="checkbox"
                    checked={identity.noCibil}
                    onChange={(e) => {
                      setField("noCibil", e.target.checked);
                      if (e.target.checked) setField("cibil", "");
                    }}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-vistara-accent"
                  />
                  <span>
                    <span className="block text-[13px] font-medium text-vistara-text">
                      I do not have a CIBIL score
                    </span>
                    <span className="mt-1 block text-[12px] leading-relaxed text-vistara-muted">
                      Checked by default, because this is the entire point.
                      Vistara computes its {SCORE_MIN}–{SCORE_MAX} score with no
                      bureau input at all. Unchecking this does not change your
                      score — it only records the bureau&rsquo;s view alongside
                      ours so an officer can see where the two disagree.
                    </span>
                  </span>
                </label>

                {!identity.noCibil ? (
                  <div className="mt-4 max-w-xs">
                    <Field
                      id="applicant-cibil"
                      label="Bureau score (optional)"
                      error={errorFor("cibil")}
                      hint="Recorded for comparison only. Never read by the engine."
                    >
                      <input
                        id="applicant-cibil"
                        name="cibil"
                        type="text"
                        inputMode="numeric"
                        className={INPUT_CLASS}
                        placeholder="612"
                        value={identity.cibil}
                        maxLength={3}
                        aria-invalid={errorFor("cibil") !== undefined}
                        aria-describedby={
                          errorFor("cibil") === undefined
                            ? "applicant-cibil-hint"
                            : "applicant-cibil-error"
                        }
                        onChange={(e) => setField("cibil", e.target.value)}
                        onBlur={() => markTouched("cibil")}
                      />
                    </Field>
                  </div>
                ) : null}
              </div>
            </Card>
          ) : null}

          {/* ── Step 2 — consent ────────────────────────────────── */}
          {step === 2 ? (
            <>
              <Card
                eyebrow="Step 2"
                title="What Vistara may read"
                description="Five streams, five separate permissions. Each one is a request for DATES and nothing else: we read WHEN things happened, never how much they cost, never who you paid, never who you know. Turn any of them off and the weight is redistributed across the rest."
              >
                <ul className="space-y-3">
                  {BEHAVIOR_ORDER.map((source) => {
                    const meta = BEHAVIOR_META[source];
                    const detail = CONSENT_DETAIL[source];
                    const on = consents[source];

                    return (
                      <li
                        key={source}
                        className={[
                          "rounded-card border p-4 transition-colors",
                          on
                            ? "border-vistara-border bg-vistara-dark/50"
                            : "border-vistara-border/60 bg-vistara-dark/20",
                        ].join(" ")}
                      >
                        <div className="flex items-start gap-3">
                          <span
                            aria-hidden
                            className={[
                              "mt-0.5 text-[15px]",
                              on
                                ? "text-vistara-accent"
                                : "text-vistara-muted/60",
                            ].join(" ")}
                          >
                            {meta.icon}
                          </span>

                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                              <p
                                className={[
                                  "text-[14px] font-medium",
                                  on
                                    ? "text-vistara-text"
                                    : "text-vistara-muted",
                                ].join(" ")}
                              >
                                {meta.label}
                              </p>
                              <p className="tabular text-[11px] text-vistara-muted">
                                expected every {meta.expectedIntervalDays} days
                              </p>
                            </div>

                            <p className="mt-0.5 text-[11px] text-vistara-muted">
                              Source: {detail.holder}
                            </p>

                            <dl className="mt-3 space-y-1.5 text-[12px] leading-relaxed">
                              <div>
                                <dt className="inline font-medium text-vistara-text">
                                  We read:{" "}
                                </dt>
                                <dd className="inline text-vistara-muted">
                                  {detail.reads}
                                </dd>
                              </div>
                              <div>
                                <dt className="inline font-medium text-vistara-text">
                                  We never read:{" "}
                                </dt>
                                <dd className="inline text-vistara-muted">
                                  {detail.never}
                                </dd>
                              </div>
                            </dl>

                            <p className="tabular mt-3 border-t border-vistara-border/60 pt-2 text-[11px] text-vistara-muted">
                              {on ? (
                                <>
                                  Base weight {pct(BEHAVIOR_WEIGHTS[source] * 100)} · applied{" "}
                                  <span className="font-medium text-vistara-text">
                                    {pct(appliedWeight(source))}
                                  </span>{" "}
                                  of your score
                                </>
                              ) : (
                                <>
                                  Base weight {pct(BEHAVIOR_WEIGHTS[source] * 100)} ·
                                  excluded, redistributed across the streams you
                                  did share
                                </>
                              )}
                            </p>
                          </div>

                          <ConsentSwitch
                            id={`consent-${source}`}
                            checked={on}
                            label={meta.label}
                            onChange={(next) => {
                              setConsents((prev) => ({
                                ...prev,
                                [source]: next,
                              }));
                              if (next) setRevoked(false);
                            }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>

                <div
                  aria-live="polite"
                  className="mt-4 text-[12px] leading-relaxed"
                >
                  {step2Valid ? (
                    <p className="text-vistara-muted">
                      Sharing{" "}
                      <span className="font-medium text-vistara-text">
                        {sharedSources.length} of {BEHAVIOR_ORDER.length}
                      </span>{" "}
                      streams. Data completeness will read{" "}
                      {pct(
                        (sharedSources.length / BEHAVIOR_ORDER.length) * 100,
                      )}{" "}
                      on the scorecard, printed beside the score so nobody
                      mistakes a sparse file for a complete one.
                    </p>
                  ) : (
                    <p className="text-vistara-red">
                      {sharedSources.length} of {BEHAVIOR_ORDER.length} streams
                      shared. Vistara needs at least {MIN_STREAMS_TO_SCORE}{" "}
                      independent rhythms before it will score anyone —
                      consistency in one domain can be coincidence, so with
                      fewer than {MIN_STREAMS_TO_SCORE} there is no
                      cross-domain signal to measure and the file stays a thin
                      file.
                    </p>
                  )}
                </div>
              </Card>

              <Card
                eyebrow="Legal basis"
                title="Account Aggregator framework · DPDP Act 2023"
              >
                <div className="grid gap-5 sm:grid-cols-2">
                  <div>
                    <p className="text-[12px] font-medium text-vistara-text">
                      Account Aggregator (RBI-regulated NBFC-AA)
                    </p>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-vistara-muted">
                      Financial data moves through an RBI-licensed Account
                      Aggregator. Vistara receives a signed consent artefact,
                      never your net-banking credentials, and the aggregator
                      itself is data-blind — it transports encrypted data it
                      cannot read. We can fetch only the streams the artefact
                      names, and nothing else.
                    </p>
                  </div>

                  <div>
                    <p className="text-[12px] font-medium text-vistara-text">
                      Purpose limitation
                    </p>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-vistara-muted">
                      The artefact names exactly one purpose: computing a
                      Vistara consistency score for this credit application. It
                      does not authorise marketing, cross-sell, resale, or
                      training a model on your data. A new purpose requires a
                      new consent.
                    </p>
                  </div>

                  <div>
                    <p className="text-[12px] font-medium text-vistara-text">
                      Data minimisation
                    </p>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-vistara-muted">
                      We request timestamps at field level. No amount, merchant,
                      counterparty, contact, location or message field appears in
                      the request schema at all — a value cannot leak from a
                      request that never asks for it. This is a design property,
                      not a policy promise.
                    </p>
                  </div>

                  <div>
                    <p className="text-[12px] font-medium text-vistara-text">
                      Retention
                    </p>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-vistara-muted">
                      Timestamps are held for the {OBSERVATION_MONTHS}-month
                      observation window ({OBSERVATION_DAYS} days) that the
                      engine reads, then purged. Only the derived score and its
                      per-signal explanation are retained, for the lending
                      decision&rsquo;s audit trail.
                    </p>
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-card border border-vistara-border bg-vistara-dark/50 p-4">
                  <div className="min-w-0">
                    <p className="text-[12px] font-medium text-vistara-text">
                      Revoke anytime
                    </p>
                    <p className="mt-1 max-w-xl text-[12px] leading-relaxed text-vistara-muted">
                      Every switch above is a live revoke: turn one off and that
                      stream stops being fetched from that moment. You can also
                      revoke from your Account Aggregator app without contacting
                      us. Revoking everything is a legitimate choice — Vistara
                      then has nothing to read and will decline to score you,
                      rather than falling back on a proxy for your behaviour.
                    </p>
                    {revoked ? (
                      <p
                        aria-live="polite"
                        className="mt-2 text-[12px] font-medium text-vistara-amber"
                      >
                        All five consents revoked. Nothing further will be read.
                      </p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setConsents(NO_CONSENTS);
                        setRevoked(true);
                      }}
                    >
                      Revoke all
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setConsents(ALL_CONSENTS);
                        setRevoked(false);
                      }}
                    >
                      Restore all
                    </Button>
                  </div>
                </div>
              </Card>
            </>
          ) : null}

          {/* ── Step 3 — review & submit ────────────────────────── */}
          {step === 3 ? (
            <>
              <Card
                eyebrow="Step 3"
                title="Review and submit"
                description="Check the file, then submit to compute the score. Nothing here is sent anywhere — this prototype renders the scorecard locally."
              >
                <div className="grid gap-6 sm:grid-cols-2">
                  <div>
                    <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-vistara-muted">
                      Applicant
                    </p>
                    <dl>
                      <SummaryRow label="Name" value={identity.name.trim()} />
                      <SummaryRow
                        label="Age"
                        value={age === null ? "—" : `${age}`}
                      />
                      <SummaryRow
                        label="Occupation"
                        value={
                          identity.occupation === ""
                            ? "—"
                            : OCCUPATION_META[identity.occupation].label
                        }
                      />
                      <SummaryRow
                        label="Monthly income"
                        value={income === null ? "—" : formatINR(income)}
                      />
                      <SummaryRow
                        label="Bureau score"
                        value={
                          identity.noCibil
                            ? "None declared"
                            : cibil === null
                              ? "Not provided"
                              : `${cibil} (comparison only)`
                        }
                      />
                      <SummaryRow
                        label="Seasonal adjustment"
                        value={seasonal ? "Eligible" : "Not applicable"}
                      />
                    </dl>
                  </div>

                  <div>
                    <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-vistara-muted">
                      Consented streams
                    </p>
                    <DataTable<BehaviorSource>
                      dense
                      caption={`${sharedSources.length} of ${BEHAVIOR_ORDER.length} streams shared. Weights are renormalised over what you shared, so a declined stream costs you nothing you cannot control.`}
                      columns={[
                        {
                          key: "signal",
                          label: "Signal",
                          rowHeader: true,
                          render: (row) => BEHAVIOR_META[row].short,
                        },
                        {
                          key: "cadence",
                          label: "Cadence",
                          align: "right",
                          render: (row) =>
                            `${BEHAVIOR_META[row].expectedIntervalDays}d`,
                        },
                        {
                          key: "base",
                          label: "Base",
                          align: "right",
                          render: (row) => pct(BEHAVIOR_WEIGHTS[row] * 100),
                        },
                        {
                          key: "applied",
                          label: "Applied",
                          align: "right",
                          render: (row) => pct(appliedWeight(row)),
                        },
                      ]}
                      rows={sharedSources}
                      getRowKey={(row) => row}
                      emptyMessage="No streams shared — nothing to score."
                    />
                  </div>
                </div>
              </Card>

              <Card
                eyebrow="Prototype disclosure"
                title="Which history this application will score"
              >
                <p className="text-[13px] leading-relaxed text-vistara-muted">
                  No live Account Aggregator fetch happens in this prototype.
                  Your inputs select one of the {DEMO_CUSTOMERS.length}{" "}
                  synthetic behavioural histories deterministically: occupation
                  match first, then nearest monthly income
                  {incomeGap === null ? "" : ` (a ${formatINR(incomeGap)} gap)`}.
                  The same inputs always select the same history — there is no
                  randomness anywhere in this build.
                </p>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-card border border-vistara-border bg-vistara-dark/50 p-4">
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-vistara-muted">
                      Matched history
                    </p>
                    <p className="mt-1.5 text-[14px] font-medium text-vistara-text">
                      {matched.customer.name}
                    </p>
                    <p className="tabular mt-0.5 text-[12px] text-vistara-muted">
                      {OCCUPATION_META[matched.customer.occupation].label} ·{" "}
                      {matched.customer.city} ·{" "}
                      {formatINR(matched.customer.monthlyIncome)}/mo ·{" "}
                      {matched.scoredSources.length} of {BEHAVIOR_ORDER.length}{" "}
                      signals scorable
                    </p>
                  </div>
                  <p className="tabular shrink-0 text-[12px] text-vistara-muted">
                    {OBSERVATION_MONTHS} months of timestamps
                  </p>
                </div>
              </Card>
            </>
          ) : null}

          {/* ── Navigation ──────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-3 border-t border-vistara-border pt-5">
            {step > 1 ? (
              <Button
                variant="secondary"
                size="md"
                onClick={() => goTo((step - 1) as StepIndex)}
              >
                Back
              </Button>
            ) : null}

            {step < 3 ? (
              <Button type="submit" size="md" disabled={!canAdvance}>
                {step === 1 ? "Continue to consent" : "Continue to review"}
              </Button>
            ) : (
              <Button
                type="submit"
                size="md"
                disabled={!(step1Valid && step2Valid)}
              >
                Submit and compute score
              </Button>
            )}

            {!canAdvance ? (
              <p className="text-[12px] text-vistara-muted" aria-live="polite">
                {step === 1
                  ? "Complete the fields above to continue."
                  : `Share at least ${MIN_STREAMS_TO_SCORE} streams to continue.`}
              </p>
            ) : null}
          </div>
        </div>

        {/* ── Right rail ────────────────────────────────────────── */}
        <aside className="min-w-0 space-y-4 lg:sticky lg:top-20 lg:self-start">
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
            <StatTile
              label="Streams shared"
              value={`${sharedSources.length} of ${BEHAVIOR_ORDER.length}`}
              hint={`Minimum ${MIN_STREAMS_TO_SCORE} required before Vistara will score a file.`}
            />
            <StatTile
              label="Fields read"
              value="Timestamps only"
              hint="No amount, merchant, counterparty, contact or location field is requested."
            />
            <StatTile
              label="Observation window"
              value={`${OBSERVATION_MONTHS} months`}
              hint={`${OBSERVATION_DAYS} days of trailing history, then purged.`}
            />
          </div>

          <Card
            eyebrow="Never requested"
            title="The list a lender usually asks for"
            className="text-[12px]"
          >
            <ul className="space-y-2 text-[12px] leading-relaxed text-vistara-muted">
              {[
                "Transaction amounts and account balances",
                "Merchant, payee and counterparty names",
                "Your contacts, call logs or SMS inbox",
                "Location history, routes or destinations",
                "Salary slips, ITRs or bank statements",
                "Your CIBIL or any other bureau score",
              ].map((item) => (
                <li key={item} className="flex gap-2">
                  <span aria-hidden className="text-vistara-muted/70">
                    ○
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <p className="mt-4 border-t border-vistara-border pt-3 text-[12px] leading-relaxed text-vistara-muted">
              A score built only from dates cannot be reverse-engineered into a
              spending profile, because the spending was never collected.
            </p>
          </Card>
        </aside>
      </form>

      {/* ── Sample applicants ─────────────────────────────────────── */}
      <section id="sample-applicants" className="mt-14 scroll-mt-20">
        <SectionHeading
          as="h2"
          size="section"
          eyebrow="Demo shortcut"
          title="Skip the form — use a sample applicant"
          description={`${DEMO_CUSTOMERS.length} synthetic applicants, three per archetype, each with ${OBSERVATION_MONTHS} months of seed-generated history. Open any scorecard directly.`}
        />

        <Card className="mt-5" padded={false}>
          <div className="px-5 py-5 sm:px-6 sm:py-6">
            <DataTable<TemporalProfile>
              dense
              columns={sampleColumns}
              rows={DEMO_CUSTOMERS}
              getRowKey={(row) => row.customer.id}
              caption="Every profile is generated from a fixed seed against a frozen reference date; the tier and score shown are the engine's own output, not labels attached by hand."
            />
          </div>
        </Card>
      </section>
    </div>
  );
}
