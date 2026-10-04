"use client";

import { useState } from "react";
import { Swatch, cn } from "@/components/ui";

export type SeriesKey = { label: string; color: string; kind: "rect" | "line" };

export function Legend({ items }: { items: SeriesKey[] }) {
  return (
    <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
      {items.map((s) => (
        <li key={s.label} className="flex items-center gap-1.5">
          <Swatch color={s.color} kind={s.kind} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/** Tooltip shell: values lead in strong ink, series names follow in secondary ink. */
export function TooltipCard({ title, rows }: {
  title: string;
  rows: { label: string; value: string; color?: string }[];
}) {
  return (
    <div className="min-w-44 rounded-lg border border-hairline bg-surface px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 font-medium text-ink-2">{title}</div>
      <table className="w-full">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td className="w-4 pr-2 align-middle">{r.color && <Swatch color={r.color} kind="line" />}</td>
              <td className="pr-3 text-right font-semibold tabular-nums text-ink">{r.value}</td>
              <td className="text-ink-2">{r.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Chart / Table switch - every chart has a table twin with the same numbers. */
export function ChartOrTable({ chart, table }: { chart: React.ReactNode; table: React.ReactNode }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  return (
    <div>
      <div className="mb-2 flex justify-end">
        <div className="inline-flex rounded-md border border-hairline p-0.5 text-xs">
          {(["chart", "table"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={cn(
                "rounded px-2 py-0.5 capitalize",
                view === v ? "bg-grid font-medium text-ink" : "text-ink-2 hover:bg-grid/60",
              )}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
      {view === "chart" ? chart : <div className="max-h-[420px] overflow-auto">{table}</div>}
    </div>
  );
}
