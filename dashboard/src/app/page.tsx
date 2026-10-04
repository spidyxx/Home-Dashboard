import Link from "next/link";
import { TZ } from "@/lib/db";
import {
  RANGES,
  carSolarShare,
  getDay,
  getHistory,
  getLive,
  selfSufficiency,
  type DayData,
  type HistoryRow,
  type Range,
} from "@/lib/energy";
import {
  addDays,
  formatClock,
  formatDay,
  formatEnergy,
  formatMonth,
  formatPercent,
  isDay,
  kwh,
  todayIn,
} from "@/lib/format";
import { Card, SectionHeader, SegmentedLinks, StatTile } from "@/components/ui";
import { AutoRefresh } from "@/components/auto-refresh";
import { LiveTiles } from "@/components/energy/live-tiles";
import { PowerChart } from "@/components/energy/power-chart";
import { HistoryChart, type HistoryPoint } from "@/components/energy/history-chart";
import { ChartOrTable } from "@/components/energy/chart-parts";

export const dynamic = "force-dynamic";

const HOUR = 3_600_000;

export default async function EnergyPage({ searchParams }: {
  searchParams: Promise<{ day?: string; range?: string }>;
}) {
  const params = await searchParams;
  const today = todayIn(TZ);
  const day = isDay(params.day) && params.day <= today ? params.day : today;
  const range: Range = params.range && params.range in RANGES ? (params.range as Range) : "30d";

  const [live, dayData, history] = await Promise.all([getLive(), getDay(day), getHistory(range, today)]);

  // Links keep the other section's state; defaults stay out of the URL.
  const href = (p: { day?: string; range?: Range }) => {
    const q = new URLSearchParams();
    const d = p.day ?? day;
    const r = p.range ?? range;
    if (d !== today) q.set("day", d);
    if (r !== "30d") q.set("range", r);
    const s = q.toString();
    return s ? `/?${s}` : "/";
  };
  const t = dayData.totals;
  const share = t && carSolarShare(t);

  return (
    <div className="space-y-10">
      <AutoRefresh active={day === today} />

      <section>
        <LiveTiles initial={live} tz={TZ} />
      </section>

      <section>
        <SectionHeader title="Day">
          <nav className="flex items-center gap-1 text-sm" aria-label="Choose day">
            <Link href={href({ day: addDays(day, -1) })} className="rounded-md px-2 py-1 text-ink-2 hover:bg-grid/60" aria-label="Previous day">‹</Link>
            <span className="min-w-36 text-center font-medium text-ink">{formatDay(day)}</span>
            {day < today ? (
              <Link href={href({ day: addDays(day, 1) })} className="rounded-md px-2 py-1 text-ink-2 hover:bg-grid/60" aria-label="Next day">›</Link>
            ) : (
              <span className="px-2 py-1 text-axis" aria-hidden>›</span>
            )}
            {day !== today && (
              <Link href={href({ day: today })} className="ml-2 rounded-md border border-hairline px-2 py-0.5 text-ink-2 hover:bg-grid/60">Today</Link>
            )}
          </nav>
        </SectionHeader>

        <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatTile label="Produced" swatch="var(--solar)" value={formatEnergy(t?.produced)} />
          <StatTile label="Consumed" value={formatEnergy(t?.consumed)} sub={t ? `Home ${formatEnergy(t.home)}` : undefined} />
          <StatTile label="Self-sufficiency" value={formatPercent(t && selfSufficiency(t))} sub="Share of consumption from solar" />
          <StatTile label="Grid import" value={formatEnergy(t?.imported)} />
          <StatTile label="Grid export" value={formatEnergy(t?.exported)} />
          <StatTile
            label="Car charged"
            swatch="var(--car)"
            value={formatEnergy(t?.car)}
            sub={share != null ? `${formatPercent(share)} from solar` : undefined}
          />
        </div>

        <Card title="Power" subtitle="kW, average per minute">
          <ChartOrTable
            chart={<PowerChart points={dayData.points} start={dayData.start} end={dayData.end} tz={TZ} />}
            table={<HourlyTable data={dayData} />}
          />
        </Card>
      </section>

      <section>
        <SectionHeader title="History">
          <SegmentedLinks
            items={(Object.keys(RANGES) as Range[]).map((r) => ({
              href: href({ range: r }),
              label: RANGES[r].label,
              active: r === range,
            }))}
          />
        </SectionHeader>
        <Card
          title={RANGES[range].monthly ? "Energy per month" : "Energy per day"}
          subtitle="kWh, produced next to consumed (home + car)"
        >
          <ChartOrTable
            chart={<HistoryChart data={history.map(toPoint)} monthly={RANGES[range].monthly} />}
            table={<HistoryTable rows={history} monthly={RANGES[range].monthly} />}
          />
        </Card>
      </section>
    </div>
  );
}

function toPoint(row: HistoryRow): HistoryPoint {
  const t = row.totals;
  return {
    period: row.period,
    produced: t?.produced ?? null,
    home: t?.home ?? null,
    car: t?.car ?? null,
    selfSufficiency: t ? selfSufficiency(t) : null,
  };
}

// --- table views ---------------------------------------------------------------

const th = "px-2 py-1.5 text-right font-medium text-ink-2 first:text-left";
const td = "px-2 py-1 text-right tabular-nums text-ink first:text-left";
const empty = "px-2 py-1 text-muted";

function HourlyTable({ data }: { data: DayData }) {
  const hours = Math.round((data.end - data.start) / HOUR);
  const rows = Array.from({ length: hours }, () => ({ solar: 0, home: 0, car: 0, imp: 0, exp: 0, n: 0 }));
  for (const p of data.points) {
    const row = rows[Math.floor((p.t - data.start) / HOUR)];
    if (!row) continue;
    // 1-minute average power in W -> Wh
    row.solar += (p.solar ?? 0) / 60;
    row.home += (p.home ?? 0) / 60;
    row.car += (p.car ?? 0) / 60;
    const grid = (p.home ?? 0) + (p.car ?? 0) - (p.solar ?? 0);
    if (grid > 0) row.imp += grid / 60;
    else row.exp -= grid / 60;
    row.n++;
  }
  return (
    <table className="w-full text-sm">
      <caption className="pb-2 text-left text-xs text-muted">kWh per hour, from the 1-minute averages</caption>
      <thead className="sticky top-0 bg-surface">
        <tr className="border-b border-hairline">
          <th className={th}>Hour</th><th className={th}>Solar</th><th className={th}>Home</th>
          <th className={th}>Car</th><th className={th}>Import</th><th className={th}>Export</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-hairline last:border-0">
            <td className={td}>{formatClock(data.start + i * HOUR, TZ)}</td>
            {r.n === 0 ? (
              <td className={empty} colSpan={5}>No data</td>
            ) : (
              [r.solar, r.home, r.car, r.imp, r.exp].map((v, j) => <td key={j} className={td}>{kwh(v, 2)}</td>)
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HistoryTable({ rows, monthly }: { rows: HistoryRow[]; monthly: boolean }) {
  return (
    <table className="w-full text-sm">
      <caption className="pb-2 text-left text-xs text-muted">kWh, from the meter counters</caption>
      <thead className="sticky top-0 bg-surface">
        <tr className="border-b border-hairline">
          <th className={th}>{monthly ? "Month" : "Day"}</th><th className={th}>Produced</th>
          <th className={th}>Consumed</th><th className={th}>Home</th><th className={th}>Car</th>
          <th className={th}>Car solar</th><th className={th}>Import</th><th className={th}>Export</th>
          <th className={th}>Self-suff.</th>
        </tr>
      </thead>
      <tbody>
        {[...rows].reverse().map(({ period, totals: t }) => (
          <tr key={period} className="border-b border-hairline last:border-0">
            <td className={td}>{monthly ? formatMonth(period) : formatDay(period)}</td>
            {t == null ? (
              <td className={empty} colSpan={8}>No data</td>
            ) : (
              <>
                <td className={td}>{kwh(t.produced)}</td>
                <td className={td}>{kwh(t.consumed)}</td>
                <td className={td}>{kwh(t.home)}</td>
                <td className={td}>{kwh(t.car)}</td>
                <td className={td}>{formatPercent(carSolarShare(t))}</td>
                <td className={td}>{kwh(t.imported)}</td>
                <td className={td}>{kwh(t.exported)}</td>
                <td className={td}>{formatPercent(selfSufficiency(t))}</td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
