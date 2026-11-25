# Vistara

**Verified Insights Scoring for Thin-file Applicants** — a credit-scoring prototype for people with no bureau history, built for the TVS Credit hackathon.

Vistara scores only the *timing* of recurring life events: when a vehicle is serviced, when a UPI mandate debits, when the electricity bill is paid, when the phone is recharged, when FASTag tolls are crossed. It never reads amounts, balances or merchant categories. A steady rhythm across unrelated parts of someone's life is the signal; how consistent that rhythm is becomes a 300–900 score with a loan offer, a recommended EMI date and a dated path to the next tier.

> All customer data in this repository is synthetic, generated from a fixed seed. No real borrower data is present, and the link between rhythm and repayment is the hypothesis a pilot would have to test.

## Running it

Requires Node.js 18.17 or later.

```bash
npm ci
npm run dev          # http://localhost:3000
```

Production build:

```bash
npm run build
npm run start
```

## What to open

| Route | What it shows |
| --- | --- |
| `/` | Landing page, with four sample profiles to open. Static; ships no page JavaScript. |
| `/apply/live` | The live application: profile, consent to five signals, three mindset questions. A history is generated and scored in the browser. |
| `/score/live` | The scorecard for that application. `?demo=true&id=vst-planner-1` opens a sample profile instead. |
| `/apply` | A demo wizard that matches the form to one of the twelve sample histories. |
| `/score` | Server-rendered scorecard for a sample applicant, e.g. `/score?id=vst-adapter-2` (the default). |
| `/dashboard` | The loan officer's queue: all twelve applicants ranked, with tier and signal coverage. |
| `/method` | How the score is computed, run through the real engine: coherence table, worked example, objections. |
| `/about` | What Vistara measures and what it stands on. |

## How the score works

| Signal | Expected cadence | Weight |
| --- | --- | --- |
| Vehicle service (dealer-recorded) | 90 days | 30% |
| UPI recurring payments | 30 days | 25% |
| Electricity bill | 30 days | 20% |
| Phone recharge | 28 days | 15% |
| FASTag tolls | 7 days | 10% |

- **Per signal:** the standard deviation of the gaps between events, rescaled to a 30-day reference cadence so a weekly and a quarterly rhythm compare fairly, plus a current-streak bonus and a penalty for slow recovery after a slip. A signal needs at least 4 events to be scored.
- **Across signals:** cross-domain coherence (geometric mean of the per-signal indices, minus a dispersion penalty) carries 25% of the score, so being evenly consistent beats being excellent at one habit.
- **Tiers:** Prime from 750, Near Prime from 650, Developing from 550. Below that, or with fewer than 3 observed signals, the file is Thin File and gets a rhythm-building path instead of an offer.
- **Absent signals** are left out and the weights renormalised; nothing is imputed. For farmers and small merchants, up to two harvest- or festival-window gaps per signal can be excused on vehicle service, UPI and the electricity bill (not on the 28-day recharge or weekly tolls), and only where excusing them raises the score. Every exclusion is disclosed on the scorecard.
- **EMI date:** two days after the day of the month the customer's money reliably lands.

The engine is plain TypeScript in [src/lib/consistency.ts](src/lib/consistency.ts), with no ML library. Every date is UTC and every random draw comes from a seeded generator, so the same input always produces the same score.

## Checks

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # next lint
npm test             # engine test suite
npm run verify:data  # assertions over the twelve-profile cohort
npm run verify:demo  # after a build: /, /method and /about still prerender
npm run tune:demo    # re-search the cohort's frozen seeds (slow)
```

## Layout

```
src/lib/          engine (consistency.ts), constants, types, seeded RNG,
                  synthetic cohort (synthetic-data.ts), formatting, useVistara hook
src/components/   UI primitives and the EventStrip / ConsistencyBars / ScoreGauge charts
src/app/          routes; (demo)/ groups the pages that show the demo banner
scripts/          data checks, seed tuning, the prerender smoke test, screenshot capture
docs/screenshots/ captures of the running app
```

`scripts/capture-screenshots.py` regenerates the screenshots from a production build on port 3210 using Playwright and an installed Chrome; its header has the exact commands.
