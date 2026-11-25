import type { ReactNode } from "react";
import { formatDate } from "@/lib/format";

export type ColumnAlign = "left" | "center" | "right";

export interface DataTableColumn<T> {
  /** Property name on the row, or a synthetic id when `render` is supplied. */
  key: string;
  label: string;
  align?: ColumnAlign;
  /** Any CSS width, e.g. "38%" or "9rem". */
  width?: string;
  /** Tabular figures. Defaults to true for right-aligned (numeric) columns. */
  tabular?: boolean;
  /** Render this cell as a <th scope="row"> — the row's accessible name. */
  rowHeader?: boolean;
  render?: (row: T, rowIndex: number) => ReactNode;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  /** Real <caption>. This is the chart's title when the table IS the twin view. */
  caption?: ReactNode;
  /** Keep the caption for assistive tech only (the chart above already shows it). */
  captionHidden?: boolean;
  getRowKey?: (row: T, index: number) => string;
  emptyMessage?: string;
  dense?: boolean;
  className?: string;
}

const ALIGN_CLASS: Record<ColumnAlign, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

/** Renders a raw cell value without ever reaching for `any`. */
function renderValue(value: unknown): ReactNode {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value instanceof Date) return formatDate(value);
  return String(value);
}

/**
 * The table view every chart needs. Charts encode; this states. Nothing in the
 * app is readable only from a mark, and nothing is gated behind a hover.
 */
export function DataTable<T>({
  columns,
  rows,
  caption,
  captionHidden = false,
  getRowKey,
  emptyMessage = "No rows to show.",
  dense = false,
  className,
}: DataTableProps<T>) {
  const cellPad = dense ? "py-2" : "py-2.5";

  return (
    <div className={["w-full overflow-x-auto", className ?? ""].filter(Boolean).join(" ")}>
      <table className="w-full border-collapse text-[13px]">
        {caption !== undefined ? (
          <caption
            className={
              captionHidden
                ? "sr-only"
                : "mb-3 text-left text-[12px] leading-relaxed text-vistara-muted"
            }
          >
            {caption}
          </caption>
        ) : null}

        <colgroup>
          {columns.map((column) => (
            <col
              key={column.key}
              style={column.width === undefined ? undefined : { width: column.width }}
            />
          ))}
        </colgroup>

        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={[
                  "border-b border-vistara-border pb-2 pr-4 align-bottom text-[11px] font-medium uppercase tracking-[0.14em] text-vistara-muted last:pr-0",
                  ALIGN_CLASS[column.align ?? "left"],
                ].join(" ")}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className={`${cellPad} text-[13px] text-vistara-muted`}
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row, rowIndex) => {
              const record = row as unknown as Record<string, unknown>;

              return (
                <tr
                  key={getRowKey === undefined ? String(rowIndex) : getRowKey(row, rowIndex)}
                  className="border-b border-vistara-border/60 last:border-b-0"
                >
                  {columns.map((column) => {
                    const align = column.align ?? "left";
                    const isTabular = column.tabular ?? align === "right";
                    const content =
                      column.render === undefined
                        ? renderValue(record[column.key])
                        : column.render(row, rowIndex);

                    const classes = [
                      cellPad,
                      "pr-4 last:pr-0 align-middle",
                      ALIGN_CLASS[align],
                      isTabular ? "tabular" : "",
                    ]
                      .filter(Boolean)
                      .join(" ");

                    if (column.rowHeader === true) {
                      return (
                        <th
                          key={column.key}
                          scope="row"
                          className={`${classes} font-medium text-vistara-text`}
                        >
                          {content}
                        </th>
                      );
                    }

                    return (
                      <td key={column.key} className={`${classes} text-vistara-text`}>
                        {content}
                      </td>
                    );
                  })}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
