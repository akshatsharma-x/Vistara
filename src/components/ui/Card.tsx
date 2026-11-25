import type { CSSProperties, ReactNode } from "react";

export interface CardProps {
  /** Small caps label rendered above the title. */
  eyebrow?: string;
  title?: ReactNode;
  /**
   * The title's level in the document outline; size is unaffected. h3 by
   * default, for cards inside a section. A card that IS a page's section — the
   * first thing under the h1 — passes h2, or the outline skips from h1 to h3.
   */
  titleAs?: "h2" | "h3";
  description?: ReactNode;
  /** Top-right slot: a Button, a Badge, a legend. */
  action?: ReactNode;
  /** Set false when the child owns its own padding (e.g. a full-bleed table). */
  padded?: boolean;
  /** The hairline top-light. On by default; switch off for small dense tiles. */
  sheen?: boolean;
  className?: string;
  /**
   * Escape hatch for a value Tailwind cannot name, and only that.
   *
   * The one call site is the factor columns on /score/live, which tint a card's
   * left edge with a band colour read out of CONSISTENCY_BANDS at runtime — an
   * arbitrary `border-l-[#...]` cannot be generated from a runtime string, and a
   * class would in any case be racing this component's own `border-vistara-border`
   * for the same shorthand property. An inline style settles both. Do not reach
   * for it to restate something a token already says.
   */
  style?: CSSProperties;
  children?: ReactNode;
}

/**
 * The surface primitive. It composes and does not decorate: no gradients, no
 * glow, no accent — those belong to the content the card is holding.
 */
export function Card({
  eyebrow,
  title,
  titleAs: TitleTag = "h3",
  description,
  action,
  padded = true,
  sheen = true,
  className,
  style,
  children,
}: CardProps) {
  const hasHeader =
    eyebrow !== undefined ||
    title !== undefined ||
    description !== undefined ||
    action !== undefined;

  return (
    <section
      className={[
        "rounded-card border border-vistara-border bg-vistara-surface shadow-card",
        sheen ? "card-sheen" : "",
        padded ? "p-5 sm:p-6" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
    >
      {hasHeader ? (
        <div
          className={[
            "flex items-start justify-between gap-4",
            padded ? "" : "px-5 pt-5 sm:px-6 sm:pt-6",
            children !== undefined ? "mb-4" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <div className="min-w-0">
            {eyebrow !== undefined ? (
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-vistara-muted">
                {eyebrow}
              </p>
            ) : null}

            {title !== undefined ? (
              <TitleTag
                className={[
                  "text-[15px] font-semibold tracking-tight text-vistara-text",
                  eyebrow !== undefined ? "mt-1.5" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {title}
              </TitleTag>
            ) : null}

            {description !== undefined ? (
              <p
                className={[
                  "max-w-prose text-[13px] leading-relaxed text-vistara-muted",
                  title !== undefined || eyebrow !== undefined ? "mt-1.5" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {description}
              </p>
            ) : null}
          </div>

          {action !== undefined ? (
            <div className="shrink-0">{action}</div>
          ) : null}
        </div>
      ) : null}

      {children}
    </section>
  );
}
