"use client";

import { formatEnergy, formatPercent } from "@/lib/format";
import { BarsChart } from "@/components/charts/bars-chart";

export type HistoryPoint = {
  period: string; // YYYY-MM-DD or YYYY-MM
  produced: number | null; // Wh
  home: number | null;
  car: number | null;
  selfSufficiency: number | null;
};

const kwh = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });

export function HistoryChart({ data, monthly }: { data: HistoryPoint[]; monthly: boolean }) {
  const hasCar = data.some((d) => (d.car ?? 0) > 0);
  return (
    <BarsChart
      data={data}
      series={[
        { key: "produced", label: "Produced (solar)", color: "var(--solar)" },
        { key: "home", label: "Home", color: "var(--home)", stack: "consumed" },
        ...(hasCar ? [{ key: "car", label: "Car", color: "var(--car)", stack: "consumed" }] : []),
      ]}
      monthly={monthly}
      format={formatEnergy}
      axisFormat={(wh) => kwh.format(wh / 1000)}
      extraRows={(point) => {
        const d = point as HistoryPoint;
        return [
          { label: "Consumed", value: formatEnergy((d.home ?? 0) + (d.car ?? 0)) },
          { label: "Self-sufficiency", value: formatPercent(d.selfSufficiency) },
        ];
      }}
      ariaLabel="Energy produced versus consumed per period"
    />
  );
}
