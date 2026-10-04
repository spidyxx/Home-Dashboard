"use client";

import type { PowerPoint } from "@/lib/energy";
import { formatPower } from "@/lib/format";
import { TimeChart, type TimePoint } from "@/components/charts/time-chart";

const kw = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });

export function PowerChart({ points, start, end, tz }: {
  points: PowerPoint[];
  start: number;
  end: number;
  tz: string;
}) {
  const hasCar = points.some((p) => (p.car ?? 0) > 0);
  const series = [
    { key: "solar", label: "Solar", color: "var(--solar)" },
    { key: "home", label: "Home", color: "var(--home)" },
    ...(hasCar ? [{ key: "car", label: "Car", color: "var(--car)" }] : []),
  ];
  return (
    <TimeChart
      points={points as TimePoint[]}
      start={start}
      end={end}
      tz={tz}
      series={series}
      format={formatPower}
      axisFormat={(w) => kw.format(w / 1000)}
      extraRows={(p) => {
        const grid = (p.home ?? 0) + (p.car ?? 0) - (p.solar ?? 0);
        return [{
          label: Math.abs(grid) < 5 ? "Grid" : grid > 0 ? "Grid import" : "Grid export",
          value: p.solar == null ? "–" : formatPower(Math.abs(grid)),
        }];
      }}
      ariaLabel="Solar production, home consumption and car charging power over the day"
    />
  );
}
