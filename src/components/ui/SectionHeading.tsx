import type { ReactNode } from "react";

export type SectionHeadingSize = "page" | "section";
export type SectionHeadingLevel = "h1" | "h2" | "h3";

export interface SectionHeadingProps {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  /** Right-hand slot: a Button, a Badge, a chart legend. */
  action?: ReactNode;
  size?: SectionHeadingSize;
  /** Heading level for the document outline; independent of visual size. */
  as?: SectionHeadingLevel;
  className?: string;
}

const TITLE_CLASS: Record<SectionHeadingSize, string> = {
  page: "text-2xl sm:text-3xl font-semibold tracking-tight",
  section: "text-lg sm:text-xl font-semibold tracking-tight",
};

export function SectionHeading({
  eyebrow,
  title,
  description,
  action,
  size = "section",
  as = "h2",
  className,
}: SectionHeadingProps) {
  const Heading = as;

  return (
    <div
      className={[
        "flex flex-wrap items-end justify-between gap-x-6 gap-y-3",
        className ?? "",
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

        <Heading
          className={[
            TITLE_CLASS[size],
            "text-vistara-text",
            eyebrow !== undefined ? "mt-2" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {title}
        </Heading>

        {description !== undefined ? (
          <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-vistara-muted">
            {description}
          </p>
        ) : null}
      </div>

      {action !== undefined ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
