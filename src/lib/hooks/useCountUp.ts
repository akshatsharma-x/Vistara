"use client";

/**
 * useCountUp — one number, counted up once, after mount.
 *
 * WHY THIS EXISTS. The score is the payoff of a three-step form and a three
 * second processing screen. A figure that is simply present when the page paints
 * reads as a value that was looked up; a figure that arrives reads as one that
 * was computed. The count-up is the last 1.4 seconds of that argument.
 *
 * DETERMINISM. The app bans clock reads in the render path — `Date.now()` and
 * argless `new Date()` — because a Server Component and its hydration must not
 * disagree. This hook does not break that rule and is worth being precise about
 * why: the only time it reads is the `DOMHighResTimeStamp` that
 * requestAnimationFrame hands its own callback, which is a monotonic offset from
 * the document's time origin rather than a wall clock, and it is read after
 * mount, in the browser, never during a render that a server also performed.
 * Whatever the frame timing turns out to be, the settled value is exactly
 * `target`, so the DOM this hook comes to rest on is fully determined by its
 * arguments. Only the frames in between depend on the machine.
 *
 * HYDRATION. The value starts at 0 on the server and on any client that has not
 * asked for reduced motion, so a prerendered first paint and its hydration
 * agree. The one case where they would not is a reduced-motion client hydrating
 * markup that already contains this hook's output — there the server wrote 0 and
 * the client wants `target` immediately. /score/live cannot hit that: the score
 * only renders after the sessionStorage read resolves in an effect, so the hook
 * mounts a render *later* than hydration rather than during it. Anything that
 * puts a count-up inside prerendered markup needs to check this again.
 */

import { useEffect, useState } from "react";

/** The reveal beat. Long enough to read as counting, short enough not to stall. */
export const COUNT_UP_MS = 1400;

/**
 * Read at call time rather than cached in a ref, because it is consulted from
 * both the state initialiser and the effect. The `matchMedia` guard matches the
 * one on /apply/live: jsdom and older embedded webviews expose `window` without
 * it, and an unguarded call there is a TypeError during first render.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Counts from 0 to `target`, easing out, and returns the integer to display.
 *
 * Changing `target` restarts the count rather than continuing from where it was:
 * this animates the *arrival* of a number, and interpolating between two scores
 * would read as a score changing its mind.
 */
export function useCountUp(target: number, duration: number = COUNT_UP_MS): number {
  // Normalised once so that both the initialiser and the effect agree on what
  // "finished" means, and so a NaN target degrades to 0 instead of rendering
  // "NaN" at 72px.
  const settled = Number.isFinite(target) ? Math.round(target) : 0;

  const [value, setValue] = useState(() =>
    prefersReducedMotion() ? settled : 0,
  );

  useEffect(() => {
    // No animation to run: reduced motion, a nonsense duration, or a target of
    // 0 that is already on screen. Assigning the settled value covers the case
    // where `target` changed after mount, which the initialiser cannot see.
    if (prefersReducedMotion() || duration <= 0 || settled === 0) {
      setValue(settled);
      return;
    }

    setValue(0);

    let frame = 0;
    // The first callback's timestamp, not the moment the effect ran. Measuring
    // from `origin` means the count starts on the first frame the browser
    // actually paints, so a slow mount shortens nothing.
    let origin: number | null = null;

    const step = (now: number) => {
      if (origin === null) origin = now;
      const progress = Math.min((now - origin) / duration, 1);
      // easeOutCubic. Fast out of the gate, long settle — the shape that reads
      // as a number landing. A linear ramp reads as a progress bar.
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(settled * eased));
      if (progress < 1) frame = window.requestAnimationFrame(step);
    };

    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, [settled, duration]);

  return value;
}
