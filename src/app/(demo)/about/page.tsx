import type { Metadata } from "next";
import Link from "next/link";

import { SectionHeading } from "@/components/ui";
import {
  BEHAVIOR_META,
  BEHAVIOR_ORDER,
  OBSERVATION_MONTHS,
} from "@/lib/constants";

/* ================================================================== *
 * /about — what Vistara is, and what it stands on.
 * ================================================================== *
 * A Server Component with no engine calls: this page describes the product
 * rather than demonstrating it, so /method carries the computed proof and this
 * one carries the claim, the moat and the citations. The five cadences are
 * still read out of BEHAVIOR_META rather than written down, so a change to a
 * cadence cannot leave this page quietly stating the old one.
 * ================================================================== */

export const metadata: Metadata = {
  title: "About — Vistara",
  description:
    "Vistara measures how consistently you live rather than what you earned. The signals, the TVS moat, the behavioural science and the stack.",
};

// Background reading only. Neither book tests payment timing against repayment,
// so neither is cited as evidence for the hypothesis this page states — and no
// study is cited for it, because this prototype has not tested it.
const REFERENCES = [
  "Duhigg, C. (2012). The Power of Habit. Random House.",
  "Thaler, R. & Sunstein, C. (2008). Nudge. Yale University Press.",
];

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <SectionHeading as="h1" size="page" title="About Vistara" />

      {/* ── 1 · What Vistara measures ─────────────────────────────────── */}
      <section className="mt-12">
        <SectionHeading as="h2" title="What Vistara measures" />

        <p className="mt-4 text-[14px] leading-relaxed text-vistara-muted">
          Traditional credit scores ask: what did you do? Vistara asks: how
          consistently do you do everything? The hypothesis is that financial
          reliability is a behavioural trait — that people who keep steady
          rhythms across unrelated parts of life repay steadily too. This
          prototype runs on synthetic data and has not tested that against
          repayment outcomes; doing so is the first job of a pilot.
        </p>

        <ul className="mt-6 space-y-3">
          {BEHAVIOR_ORDER.map((source) => {
            const meta = BEHAVIOR_META[source];

            return (
              // flex-wrap because the row is 343px of content in 358px of
              // iPhone 15, and 15px less than that on an SE. The cadence carries
              // `shrink-0`, so without a wrap the only thing that can give is the
              // label, and "Vehicle Service Rhythm" breaking across two lines
              // beside an unbroken cadence reads worse than the cadence dropping
              // to its own line.
              <li key={source} className="flex flex-wrap items-baseline gap-3">
                <span
                  aria-hidden
                  className="w-4 shrink-0 text-[15px] text-vistara-muted"
                >
                  {meta.icon}
                </span>
                <span className="text-[14px] text-vistara-text">
                  {meta.label}
                </span>
                <span className="tabular ml-auto shrink-0 text-[13px] text-vistara-muted">
                  observed every {meta.expectedIntervalDays} days
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {/* ── 2 · The TVS signal ────────────────────────────────────────── */}
      <section className="mt-12">
        <SectionHeading as="h2" title="The TVS signal" />

        <p className="mt-4 text-[14px] leading-relaxed text-vistara-muted">
          Vehicle service records are available only to a vehicle lender. No
          generic credit engine can see them — they cannot be borrowed, bought,
          or approximated from any other data source.
        </p>
      </section>

      {/* ── 3 · The science ───────────────────────────────────────────── */}
      <section className="mt-12">
        <SectionHeading as="h2" title="Background reading" />

        <p className="mt-4 text-[14px] leading-relaxed text-vistara-muted">
          On habit formation and choice architecture. Neither book tests payment
          timing against loan repayment; that link is the hypothesis above.
        </p>

        <div className="mt-4 space-y-1.5">
          {REFERENCES.map((reference) => (
            <p
              key={reference}
              className="text-sm leading-relaxed text-vistara-muted"
            >
              {reference}
            </p>
          ))}
        </div>
      </section>

      {/* ── 4 · Technical stack ───────────────────────────────────────── */}
      <section className="mt-12">
        <SectionHeading as="h2" title="Technical stack" />

        <p className="mt-4 text-[14px] leading-relaxed text-vistara-muted">
          Next.js 14 · TypeScript · Tailwind CSS · Pure TypeScript scoring
          engine (no external ML library) · Synthetic data via seeded RNG ·{" "}
          {OBSERVATION_MONTHS}-month observation window per profile
        </p>
      </section>

      {/* ── Exits ─────────────────────────────────────────────────────── */}
      {/* Both exits are `inline-flex` before they are given a height: a
          min-height does nothing at all to a non-replaced inline box, which is
          what an anchor is by default. These two are standalone navigation
          rather than links inside a sentence, so the 44px floor applies to them
          — unlike the inline links in the notices on /score/live. */}
      <div className="mt-12 flex gap-6 border-t border-vistara-border pt-8 text-sm">
        <Link
          href="/"
          className="inline-flex items-center text-vistara-muted transition-colors hover:text-vistara-text max-sm:min-h-[44px]"
        >
          ← Back to Vistara
        </Link>
        <Link
          href="/method"
          className="inline-flex items-center text-vistara-muted transition-colors hover:text-vistara-text max-sm:min-h-[44px]"
        >
          See the method →
        </Link>
      </div>
    </div>
  );
}
