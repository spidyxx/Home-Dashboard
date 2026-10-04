"use client";

import { Area, CartesianGrid, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { PowerPoint } from "@/lib/energy";
import { formatClock, formatPower } from "@/lib/format";
import { Legend, TooltipCard, type SeriesKey } from "./chart-parts";

const SERIES: (SeriesKey & { key: "solar" | "home" | "car" })[] = [
  { key: "solar", label: "Solar", color: "var(--solar)", kind: "line" },
  { key: "home", label: "Home", color: "var(--home)", kind: "line" },
  { key: "car", label: "Car", color: "var(--car)", kind: "line" },
];

const HOUR = 3_600_000;
const kw = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });

export function PowerChart({ points, start, end, tz }: {
  points: PowerPoint[];
  start: number;
  end: number;
  tz: string;
}) {
  const ticks: number[] = [];
  for (let t = start; t <= end; t += 3 * HOUR) ticks.push(t);
  const hasCar = points.some((p) => (p.car ?? 0) > 0);
  const series = hasCar ? SERIES : SERIES.filter((s) => s.key !== "car");

  if (points.length === 0) {
    return <p className="py-16 text-center text-sm text-muted">No data for this day.</p>;
  }

  return (
    <div role="img" aria-label="Solar production, home consumption and car charging power over the day">
      <Legend items={series} />
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
            tickFormatter={(w: number) => `${kw.format(w / 1000)}`}
            tick={{ fill: "var(--muted)", fontSize: 12 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            cursor={{ stroke: "var(--axis)", strokeWidth: 1 }}
            isAnimationActive={false}
            content={({ active, payload }) => {
              const p = payload?.[0]?.payload as PowerPoint | undefined;
              if (!active || !p) return null;
              const grid = (p.home ?? 0) + (p.car ?? 0) - (p.solar ?? 0);
              return (
                <TooltipCard
                  title={formatClock(p.t, tz)}
                  rows={[
                    ...series.map((s) => ({ label: s.label, value: formatPower(p[s.key]), color: s.color })),
                    {
                      label: Math.abs(grid) < 5 ? "Grid" : grid > 0 ? "Grid import" : "Grid export",
                      value: p.solar == null ? "–" : formatPower(Math.abs(grid)),
                    },
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
