/**
 * Deterministic randomness for Vistara's synthetic data layer.
 *
 * WHY THIS EXISTS — this is not incidental plumbing:
 *
 * The demo customers are generated at module scope and rendered on both the
 * server and the client. If generation used `Math.random()` or `new Date()`,
 * the two passes would produce different timestamps and React would throw
 * hydration mismatches — mid-demo, on stage. A seeded PRNG plus a frozen
 * reference date makes every profile byte-identical on every render, in every
 * process, forever. The same seed also means a bug is always reproducible.
 */

/** Frozen "today". All 18-month histories are generated backwards from here. */
export const REFERENCE_DATE = new Date("2026-09-01T00:00:00.000Z");

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * mulberry32 — small, fast, well-distributed 32-bit PRNG.
 * Chosen over an LCG because the low bits of an LCG are notoriously
 * non-random, and we sample day-level jitter from exactly those bits.
 */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;

  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,

    /** Uniform float in [min, max). */
    float: (min, max) => min + next() * (max - min),

    /** Uniform integer in [min, max], inclusive. */
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),

    /** Standard normal via Box–Muller, then scaled. Clamped at ±3 sigma so a
     *  single tail draw cannot invent a 40-day gap in a "Planner". */
    gaussian: (mean, stdDev) => {
      let u = 0;
      let v = 0;
      while (u === 0) u = next();
      while (v === 0) v = next();
      const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      return mean + stdDev * clamp(z, -3, 3);
    },

    /** True with probability p. */
    chance: (p) => next() < p,

    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
  };

  return rng;
}

export interface Rng {
  next: () => number;
  float: (min: number, max: number) => number;
  int: (min: number, max: number) => number;
  gaussian: (mean: number, stdDev: number) => number;
  chance: (p: number) => boolean;
  pick: <T>(items: readonly T[]) => T;
}

/* ------------------------------------------------------------------ *
 * Small numeric helpers used across the data + scoring layers
 * ------------------------------------------------------------------ */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Maps `value` from [inLow, inHigh] onto [outLow, outHigh], clamped. */
export function mapRange(
  value: number,
  inLow: number,
  inHigh: number,
  outLow: number,
  outHigh: number,
): number {
  if (inHigh === inLow) return outLow;
  const t = clamp((value - inLow) / (inHigh - inLow), 0, 1);
  return outLow + t * (outHigh - outLow);
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Population standard deviation (we observe the whole window, not a sample). */
export function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance =
    values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Median. Used wherever an outlier must not move the baseline — a farmer's two
 * harvest gaps would drag a mean interval upward and make the whole rhythm look
 * slower than it is, which is the opposite of what we want to measure.
 */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Population sigma measured around an arbitrary centre, not around the mean. */
export function stdDevAround(values: number[], centre: number): number {
  if (values.length === 0) return 0;
  const variance =
    values.reduce((sum, v) => sum + (v - centre) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

export function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / DAY_MS;
}

/** Stable 32-bit hash — turns a customer id into a reproducible seed. */
export function hashSeed(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
