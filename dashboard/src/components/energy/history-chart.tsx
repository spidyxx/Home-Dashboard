"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatDay, formatEnergy, formatMonth, formatPercent, formatShortDay } from "@/lib/format";
import { Legend, TooltipCard } from "./chart-parts";

export type HistoryPoint = {
  period: string; // YYYY-MM-DD or YYYY-MM
  produced: number | null; // Wh
  home: number | null;
  car: number | null;
  selfSufficiency: number | null;
};

const kwh = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
const RADIUS = 4;
const STACK_GAP = 2;

/** Path for a column with rounded top corners and a square base. */
function columnPath(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + rr}A${rr},${rr} 0 0 1 ${x + rr},${y}H${x + w - rr}A${rr},${rr} 0 0 1 ${x + w},${y + rr}V${y + h}Z`;
}

type ShapeProps = { x?: number; y?: number; width?: number; height?: number; fill?: string; payload?: HistoryPoint };

// Only the topmost segment of a column gets the rounded data-end, and a 2px
// surface gap separates the car segment from the home segment below it.
function makeShape(segment: "produced" | "home" | "car") {
  function ColumnShape({ x = 0, y = 0, width = 0, height = 0, fill, payload }: ShapeProps) {
    if (height <= 0 || width <= 0) return <g />;
    let h = height;
    let radius = RADIUS;
    if (segment === "home" && (payload?.car ?? 0) > 0) radius = 0;
    if (segment === "car" && (payload?.home ?? 0) > 0) h = Math.max(height - STACK_GAP, 0.5);
    return <path d={columnPath(x, y, width, h, radius)} fill={fill} />;
  }
  return ColumnShape;
}
const shapes = { produced: makeShape("produced"), home: makeShape("home"), car: makeShape("car") };

export function HistoryChart({ data, monthly }: { data: HistoryPoint[]; monthly: boolean }) {
  const label = (period: string) => (monthly ? formatMonth(period) : formatShortDay(period));
  const hasCar = data.some((d) => (d.car ?? 0) > 0);

  if (!data.some((d) => d.produced != null)) {
    return <p className="py-16 text-center text-sm text-muted">No data in this range yet.</p>;
  }

  return (
    <div role="img" aria-label="Energy produced versus consumed per period">
      <Legend
        items={[
          { label: "Produced (solar)", color: "var(--solar)", kind: "rect" },
          { label: "Home", color: "var(--home)", kind: "rect" },
          ...(hasCar ? [{ label: "Car", color: "var(--car)", kind: "rect" as const }] : []),
        ]}
      />
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2} barCategoryGap="20%">
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis
            dataKey="period"
            tickFormatter={label}
            stroke="var(--axis)"
            tick={{ fill: "var(--muted)", fontSize: 12 }}
            tickLine={false}
            minTickGap={16}
          />
          <YAxis
            width={44}
            tickFormatter={(wh: number) => kwh.format(wh / 1000)}
            tick={{ fill: "var(--muted)", fontSize: 12 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            cursor={{ fill: "var(--grid)", fillOpacity: 0.5 }}
            isAnimationActive={false}
            content={({ active, payload }) => {
              const d = payload?.[0]?.payload as HistoryPoint | undefined;
              if (!active || !d) return null;
              if (d.produced == null) return <TooltipCard title={monthly ? formatMonth(d.period) : formatDay(d.period)} rows={[{ label: "No data", value: "–" }]} />;
              return (
                <TooltipCard
                  title={monthly ? formatMonth(d.period) : formatDay(d.period)}
                  rows={[
                    { label: "Produced", value: formatEnergy(d.produced), color: "var(--solar)" },
                    { label: "Home", value: formatEnergy(d.home), color: "var(--home)" },
                    ...(hasCar ? [{ label: "Car", value: formatEnergy(d.car), color: "var(--car)" }] : []),
                    { label: "Consumed", value: formatEnergy((d.home ?? 0) + (d.car ?? 0)) },
                    { label: "Self-sufficiency", value: formatPercent(d.selfSufficiency) },
                  ]}
                />
              );
            }}
          />
          <Bar dataKey="produced" name="Produced" stackId="produced" fill="var(--solar)" maxBarSize={24} shape={shapes.produced} isAnimationActive={false} />
          <Bar dataKey="home" name="Home" stackId="consumed" fill="var(--home)" maxBarSize={24} shape={shapes.home} isAnimationActive={false} />
          {hasCar && (
            <Bar dataKey="car" name="Car" stackId="consumed" fill="var(--car)" maxBarSize={24} shape={shapes.car} isAnimationActive={false} />
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
