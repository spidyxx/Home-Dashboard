"use client";

import { Area, CartesianGrid, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatClock } from "@/lib/format";
import { Legend, TooltipCard } from "./parts";

export type TimeSeries = { key: string; label: string; color: string };
export type TimePoint = { t: number } & Record<string, number | null>;
type TooltipRow = { label: string; value: string; color?: string };

const HOUR = 3_600_000;

/**
 * One day of per-minute values as lines with a light area wash: 2px lines,
 * crosshair tooltip listing every series at that minute.
 */
export function TimeChart({ points, start, end, tz, series, format, axisFormat, extraRows, ariaLabel }: {
  points: TimePoint[];
  start: number;
  end: number;
  tz: string;
  series: TimeSeries[];
  format: (value: number | null) => string;
  axisFormat: (value: number) => string;
  extraRows?: (point: TimePoint) => TooltipRow[];
  ariaLabel: string;
}) {
  if (points.length === 0) {
    return <p className="py-16 text-center text-sm text-muted">No data for this day.</p>;
  }
  const ticks: number[] = [];
  for (let t = start; t <= end; t += 3 * HOUR) ticks.push(t);

  return (
    <div role="img" aria-label={ariaLabel}>
      <Legend items={series.map((s) => ({ ...s, kind: "line" as const }))} />
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={[start, end]}
            ticks={ticks}
            tickFormatter={(t: number) => formatClock(t, tz)}
            stroke="var(--axis)"
            tick={{ fill: "var(--muted)", fontSize: 12 }}
            tickLine={false}
          />
          <YAxis
            width={44}
            tickFormatter={axisFormat}
            tick={{ fill: "var(--muted)", fontSize: 12 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            cursor={{ stroke: "var(--axis)", strokeWidth: 1 }}
            isAnimationActive={false}
            content={({ active, payload }) => {
              const p = payload?.[0]?.payload as TimePoint | undefined;
              if (!active || !p) return null;
              return (
                <TooltipCard
                  title={formatClock(p.t, tz)}
                  rows={[
                    ...series.map((s) => ({ label: s.label, value: format(p[s.key]), color: s.color })),
                    ...(extraRows?.(p) ?? []),
                  ]}
                />
              );
            }}
          />
          {series.map((s) => (
            <Area
              key={s.key}
              dataKey={s.key}
              name={s.label}
              type="linear"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              fill={s.color}
              fillOpacity={0.1}
              dot={false}
              activeDot={{ r: 4, stroke: "var(--surface)", strokeWidth: 2, fill: s.color }}
              isAnimationActive={false}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
