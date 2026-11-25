import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vistara — Temporal Consistency Engine",
  description:
    "Vistara scores how consistently you live, not what you earned. Alternative credit scoring for India's 190 million thin-file adults.",
};

export const viewport: Viewport = {
  themeColor: "#0A0A0F",
};

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/apply/live", label: "Apply" },
  // Relabelled from "Apply": the live intake above and this scripted
  // walkthrough are two different things, and both are in the nav now.
  { href: "/apply", label: "Demo Wizard" },
  { href: "/score", label: "Score" },
  { href: "/dashboard", label: "Loan Officer" },
  { href: "/method", label: "Method" },
  { href: "/about", label: "About" },
];

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">
        <header className="sticky top-[var(--demo-banner-h,0px)] z-40 border-b border-vistara-border/80 bg-vistara-dark/85 backdrop-blur-md">
          <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-5">
            <Link href="/" className="flex items-center gap-2.5">
              <span
                aria-hidden
                className="grid h-6 w-6 place-items-center rounded-md bg-vistara-accent/15 text-[11px] font-semibold text-vistara-accent ring-1 ring-vistara-accent/30"
              >
                V
              </span>
              <span className="text-[15px] font-semibold tracking-tight">
                Vistara
              </span>
            </Link>

            {/* SEVEN ITEMS, 350px OF ROOM. At a 390px viewport this nav wants
                roughly 580px and the flexbox would resolve that by letting each
                label wrap inside a 56px bar and then overflowing the body
                sideways anyway — one broken header on every route in the app.

                `min-w-0` is the fix: a flex item's automatic minimum size is its
                content, so without it the nav cannot shrink below max-content and
                something has to give. With it the nav shrinks to the space that is
                left and scrolls its own overflow, while `shrink-0
                whitespace-nowrap` on the links keeps each label intact inside the
                scroller instead of compressing to two lines.

                A hamburger would be the prettier answer and is the wrong one here:
                a disclosure needs state, state needs "use client", and this is the
                root layout — the client boundary the (demo) route group exists to
                keep off `/`. Nothing above is a client component, and a swipeable
                nav costs no JavaScript at all. At the `sm` breakpoint and up the
                row fits, so nothing overflows and nothing scrolls. */}
            {/* `print:hidden` on the nav and not on the header around it. Seven
                links are dead ink on paper, but the wordmark beside them is the
                letterhead of anything printed out of this app — the one page with
                a print button is a credit scorecard, and a scorecard wants to say
                who issued it. */}
            <nav className="ml-auto flex min-w-0 items-center gap-1 overflow-x-auto print:hidden">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="inline-flex shrink-0 items-center whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] text-vistara-muted transition-colors hover:bg-vistara-surface hover:text-vistara-text max-sm:min-h-[44px]"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>

        <main>{children}</main>

        <footer className="mt-24 border-t border-vistara-border/70">
          <div className="mx-auto max-w-6xl px-5 py-8 text-[12px] leading-relaxed text-vistara-muted">
            <p>
              Vistara — Verified Insights Scoring for Thin-file Applicants.
              Prototype. All customer data shown is synthetic and generated from
              a fixed seed; no real borrower data is present.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
