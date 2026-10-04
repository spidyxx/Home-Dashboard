"use client";

import type { TrafficPoint } from "@/lib/network";
import { formatBitrate, formatBytes } from "@/lib/format";
import { TimeChart, type TimePoint } from "@/components/charts/time-chart";
import { BarsChart } from "@/components/charts/bars-chart";

const SERIES = [
  { key: "download", label: "Download", color: "var(--download)" },
  { key: "upload", label: "Upload", color: "var(--upload)" },
];
const n = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });

export function ThroughputChart({ points, start, end, tz }: {
  points: TrafficPoint[];
  start: number;
  end: number;
  tz: string;
}) {
  return (
    <TimeChart
      points={points as TimePoint[]}
      start={start}
      end={end}
      tz={tz}
      series={SERIES}
      format={formatBitrate}
      axisFormat={(bits) => n.format(bits / 1e6)}
      ariaLabel="Internet download and upload rate over the day"
    />
  );
}

export type VolumePoint = { period: string; download: number | null; upload: number | null };

export function VolumeChart({ data, monthly }: { data: VolumePoint[]; monthly: boolean }) {
  return (
    <BarsChart
      data={data}
      series={SERIES}
      monthly={monthly}
      format={formatBytes}
      axisFormat={(bytes) => n.format(bytes / 1e9)}
      ariaLabel="Internet data volume per period, download next to upload"
    />
  );
}
