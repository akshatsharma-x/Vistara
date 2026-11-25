"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

/* ------------------------------------------------------------------ *
 * The session-level demo signal.
 * ------------------------------------------------------------------ *
 * Distinct from the profile eyebrow on /score/live, which names *which*
 * synthetic customer is on screen. This one says only that the session is in
 * demo mode, so a judge who has navigated away from the scorecard still knows
 * nothing here is real.
 *
 * Deliberately NOT exported from '@/components/ui'. The landing page imports
 * that barrel, and a "use client" module re-exported through it risks pulling a
 * client reference into a route that today ships no JavaScript at all. The one
 * consumer deep-imports this file instead.
 */

/** Matches the h-9 bar below. The body needs the same figure to offset by. */
const BANNER_HEIGHT_PX = 36;

/**
 * sessionStorage key. Holds the literal "true" and nothing else.
 *
 * Local to this file rather than lifted into constants.ts, unlike
 * LOAN_REQUEST_KEY: that one is written on one route and read on another, so a
 * typo would silently break a handoff with nothing failing. This key is written
 * and read in this component alone, which is the compile-time link.
 *
 * sessionStorage rather than localStorage, matching the rest of the app: demo
 * mode is a property of the tab, and closing it is the eraser.
 */
const DEMO_SESSION_KEY = "vistara_demo";

/* The two accessors follow the pattern in lib/hooks/useVistara.ts: window is
   absent during prerender, and setItem throws outright in some private-browsing
   modes. Neither is worth taking a route down for — the banner is a disclosure,
   and the URL param still carries it on the current page if storage is dead. */

function readDemoFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(DEMO_SESSION_KEY) === "true";
  } catch {
    return false;
  }
}

function writeDemoFlag(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(DEMO_SESSION_KEY, "true");
  } catch {
    // Storage disabled or over quota. Demo mode then lasts as long as the query
    // string does, which is the behaviour this component started with.
  }
}

export function DemoBanner() {
  const searchParams = useSearchParams();

  /**
   * Latched, not derived. `?demo=true` appears on the URL once — on the link out
   * of the landing page's demo grid — and the judge then browses to /method or
   * /about, where there is no query string to read. Reading the param alone made
   * the banner vanish on exactly the navigation it exists to cover, so the first
   * sighting is recorded for the tab and every later route reads that instead.
   *
   * Starts false so the prerendered HTML and the first client render agree;
   * the flag can only be known after mount, so it is set in an effect.
   */
  const [active, setActive] = useState(false);

  useEffect(() => {
    const fromUrl = searchParams.get("demo") === "true";
    const fromSession = readDemoFlag();

    if (fromUrl) writeDemoFlag();

    setActive(fromUrl || fromSession);
  }, [searchParams]);

  useEffect(() => {
    if (!active) return;

    // The padding moves the page down; the custom property moves the sticky
    // header down with it. Without the second, the header pins to top: 0 under
    // this fixed bar as soon as the page scrolls, and the nav stops taking
    // clicks. The root layout reads it with a 0px fallback, so routes that never
    // mount this component pay nothing.
    const root = document.documentElement;
    document.body.style.paddingTop = `${BANNER_HEIGHT_PX}px`;
    root.style.setProperty("--demo-banner-h", `${BANNER_HEIGHT_PX}px`);
    return () => {
      document.body.style.paddingTop = "";
      root.style.removeProperty("--demo-banner-h");
    };
  }, [active]);

  if (!active) return null;

  return (
    // `print:hidden` here rather than on a wrapper in the (demo) layout, which is
    // where this is mounted: this component returns null when the session is not
    // in demo mode, so a wrapper would leave an empty div on three routes to carry
    // one class. A fixed element is exactly the kind that prints — engines lay it
    // out at the top of the first sheet — and the body offset it sets in an effect
    // is undone in the @media print block, which cannot be done from here because
    // an inline style needs !important to beat.
    <div
      role="status"
      className="fixed left-0 right-0 top-0 z-50 flex h-9 items-center justify-center gap-2 bg-vistara-accent/90 backdrop-blur-sm print:hidden"
    >
      <span aria-hidden className="h-2 w-2 rounded-full bg-white/70 motion-safe:animate-pulse" />
      <span className="text-xs text-white">
        Demo mode — synthetic profiles, fixed seed, no real data
      </span>
    </div>
  );
}
