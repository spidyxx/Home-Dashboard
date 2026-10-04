"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatDay, formatMonth, formatShortDay } from "@/lib/format";
import { Legend, TooltipCard } from "./parts";

/** Series sharing a `stack` are stacked; every other series gets a column of its own. */
export type BarSeries = { key: string; label: string; color: string; stack?: string };
export type BarPoint = { period: string; [key: string]: string | number | null };
type TooltipRow = { label: string; value: string; color?: string };

const valueOf = (d: BarPoint | undefined, key: string) => (typeof d?.[key] === "number" ? (d[key] as number) : null);

const RADIUS = 4;
const STACK_GAP = 2;

/** Path for a column with rounded top corners and a square base. */
function columnPath(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + rr}A${rr},${rr} 0 0 1 ${x + rr},${y}H${x + w - rr}A${rr},${rr} 0 0 1 ${x + w},${y + rr}V${y + h}Z`;
}

type ShapeProps = { x?: number; y?: number; width?: number; height?: number; fill?: string; payload?: BarPoint };

// Only the topmost non-empty segment of a column gets the rounded data-end, and
// a 2px surface gap separates a segment from the one below it.
function makeShape(series: BarSeries, all: BarSeries[]) {
  const peers = series.stack ? all.filter((s) => s.stack === series.stack) : [series];
  const index = peers.indexOf(series);
  const below = peers.slice(0, index);
  const above = peers.slice(index + 1);
  return function ColumnShape({ x = 0, y = 0, width = 0, height = 0, fill, payload }: ShapeProps) {
    if (height <= 0 || width <= 0) return <g />;
    const filled = (s: BarSeries) => (valueOf(payload, s.key) ?? 0) > 0;
    const top = !above.some(filled);
    const h = below.some(filled) ? Math.max(height - STACK_GAP, 0.5) : height;
    return <path d={columnPath(x, y, width, h, top ? RADIUS : 0)} fill={fill} />;
  };
}

/**
 * One column (or stack) per day or month, at most 24px wide, with a per-period
 * tooltip. Columns sit side by side in series order.
 */
export function BarsChart({ data, series, monthly, format, axisFormat, extraRows, ariaLabel }: {
  data: BarPoint[];
  series: BarSeries[];
  monthly: boolean;
  format: (value: number | null) => string;
  axisFormat: (value: number) => string;
  extraRows?: (point: BarPoint) => TooltipRow[];
  ariaLabel: string;
}) {
  if (!data.some((d) => series.some((s) => valueOf(d, s.key) != null))) {
    return <p className="py-16 text-center text-sm text-muted">No data in this range yet.</p>;
  }
  const title = (period: string) => (monthly ? formatMonth(period) : formatDay(period));

  return (
    <div role="img" aria-label={ariaLabel}>
      <Legend items={series.map((s) => ({ label: s.label, color: s.color, kind: "rect" as const }))} />
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2} barCategoryGap="20%">
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis
            dataKey="period"
            tickFormatter={(p: string) => (monthly ? formatMonth(p) : formatShortDay(p))}
            stroke="var(--axis)"
            tick={{ fill: "var(--muted)", fontSize: 12 }}
            tickLine={false}
            minTickGap={16}
          />
          <YAxis
            width={44}
            tickFormatter={axisFormat}
            tick={{ fill: "var(--muted)", fontSize: 12 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            cursor={{ fill: "var(--grid)", fillOpacity: 0.5 }}
            isAnimationActive={false}
            content={({ active, payload }) => {
              const d = payload?.[0]?.payload as BarPoint | undefined;
              if (!active || !d) return null;
              if (!series.some((s) => valueOf(d, s.key) != null)) {
                return <TooltipCard title={title(d.period)} rows={[{ label: "No data", value: "–" }]} />;
              }
              return (
                <TooltipCard
                  title={title(d.period)}
                  rows={[
                    ...series.map((s) => ({ label: s.label, value: format(valueOf(d, s.key)), color: s.color })),
                    ...(extraRows?.(d) ?? []),
                  ]}
                />
              );
            }}
          />
          {series.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              // Its own stack id keeps an unstacked series in declaration order.
              stackId={s.stack ?? s.key}
              fill={s.color}
              maxBarSize={24}
              shape={makeShape(s, series)}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
