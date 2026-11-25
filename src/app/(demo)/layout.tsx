import { Suspense } from "react";

import { DemoBanner } from "@/components/ui/DemoBanner";

/* ================================================================== *
 * The (demo) route group.
 * ================================================================== *
 * A route group carries no URL segment, so the three routes underneath it stay
 * at /score/live, /method and /about. The group exists only to give them a
 * layout the landing page does not share: the root layout stays a Server
 * Component, and `/` keeps prerendering to HTML with no page JavaScript of its
 * own. Mounting the banner in the root layout would have put a client boundary
 * above every route in the app to serve three of them.
 *
 * This file itself is a Server Component — only DemoBanner is a client module,
 * so the boundary is as small as it can be.
 *
 * The Suspense wrapper is required, not decorative: DemoBanner reads
 * useSearchParams(), and a static prerender of these routes would otherwise
 * bail out at build time for want of a boundary to suspend at.
 */

export default function DemoLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Suspense fallback={null}>
        <DemoBanner />
      </Suspense>
      {children}
    </>
  );
}
