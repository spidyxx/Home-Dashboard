import Link from "next/link";
import { TZ } from "@/lib/db";
import { getDevices, getEvents, getNetworkDay, getNetworkNow, getVolumeHistory, type Device } from "@/lib/network";
import { RANGES, parseRange, type Range } from "@/lib/series";
import {
  addDays,
  formatAgo,
  formatBitrate,
  formatBytes,
  formatClock,
  formatDateTime,
  formatDay,
  formatDuration,
  formatMonth,
  formatPercent,
  isDay,
  todayIn,
} from "@/lib/format";
import { Card, SectionHeader, SegmentedLinks, StatTile, StatusNote, cn } from "@/components/ui";
import { AutoRefresh } from "@/components/auto-refresh";
import { ChartOrTable } from "@/components/charts/parts";
import { ThroughputChart, VolumeChart } from "@/components/network/charts";

export const dynamic = "force-dynamic";

// The collector samples traffic every 15 s; this much silence means it is down.
const STALE_MS = 2 * 60_000;

export default async function NetworkPage({ searchParams }: {
  searchParams: Promise<{ day?: string; range?: string }>;
}) {
  const params = await searchParams;
  const today = todayIn(TZ);
  const day = isDay(params.day) && params.day <= today ? params.day : today;
  const range = parseRange(params.range);
  const [now, dayData, history, devices, events] = await Promise.all([
    getNetworkNow(), getNetworkDay(day), getVolumeHistory(range, today), getDevices(), getEvents(),
  ]);
  const at = Date.now();

  const href = (p: { day?: string; range?: Range }) => {
    const q = new URLSearchParams();
    const d = p.day ?? day;
    const r = p.range ?? range;
    if (d !== today) q.set("day", d);
    if (r !== "30d") q.set("range", r);
    const s = q.toString();
    return s ? `/network?${s}` : "/network";
  };
  const stale = now.at == null || at - now.at > STALE_MS;
  const peak = Math.max(0, ...dayData.points.map((p) => p.download ?? 0));
  const clients = devices.filter((d) => !d.meshRole);
  const onlineCount = clients.filter((d) => d.online).length;

  return (
    <div className="space-y-10">
      <AutoRefresh active={day === today} intervalMs={30_000} />

      <section>
        <SectionHeader title="Now">
          <div className="ml-auto text-xs text-muted">
            {stale ? (
              <StatusNote tone="warning">
                {now.at == null ? "No network data yet - is the collector running?"
                  : `No network data since ${formatClock(now.at, TZ)} - is the collector running?`}
              </StatusNote>
            ) : (
              <span>Updated {Math.max(0, Math.round((at - now.at!) / 1000))} s ago</span>
            )}
          </div>
        </SectionHeader>
        <div className={cn("grid grid-cols-2 gap-3 lg:grid-cols-4", stale && "opacity-60")}>
          <StatTile
            label="Internet"
            value={now.online == null ? "–" : now.online ? "Online" : "Offline"}
            sub={now.online === false ? <StatusNote tone="critical">No internet connection</StatusNote>
              : now.connectionUptime != null ? `Connected for ${formatDuration(now.connectionUptime)}` : undefined}
          />
          <StatTile label="Download" swatch="var(--download)" value={formatBitrate(now.downBit)} sub="Average of the last 15 s" />
          <StatTile label="Upload" swatch="var(--upload)" value={formatBitrate(now.upBit)} sub="Average of the last 15 s" />
          <StatTile
            label="Devices online"
            value={now.devices == null ? "–" : String(now.devices)}
            sub={now.wifi != null && now.devices != null ? `${now.wifi} via Wi-Fi, ${now.devices - now.wifi} via LAN` : undefined}
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span className="text-ink-2">Who&apos;s home</span>
          {now.people.length === 0 ? (
            <span className="text-xs text-muted">Add <code>Presence = Name=MAC</code> to the collector&apos;s [FRITZ] config.</span>
          ) : now.people.map((p) => (
            <span key={p.name} className="flex items-center gap-1.5">
              <span aria-hidden className={p.home ? "text-good" : "text-muted"}>{p.home ? "●" : "○"}</span>
              <span className="font-medium text-ink">{p.name}</span>
              <span className="text-muted">
                {p.home ? "home" : "away"}
                {p.since ? ` since ${at - p.since < 86_400_000 ? formatClock(p.since, TZ) : formatDateTime(p.since, TZ)}` : ""}
              </span>
            </span>
          ))}
          {now.ipv4 && <span className="ml-auto text-xs text-muted">Public IP {now.ipv4}</span>}
        </div>
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
        <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Downloaded" swatch="var(--download)" value={formatBytes(dayData.volume?.received)} />
          <StatTile label="Uploaded" swatch="var(--upload)" value={formatBytes(dayData.volume?.sent)} />
          <StatTile
            label="Internet online"
            value={formatPercent(dayData.onlineShare)}
            sub={dayData.outages === 0 ? "No outages" : `${dayData.outages} outage${dayData.outages > 1 ? "s" : ""}`}
          />
          <StatTile label="Peak download" value={dayData.points.length ? formatBitrate(peak) : "–"} sub="Highest 1-minute average" />
        </div>
        <Card title="Throughput" subtitle="Mbit/s, average per minute">
          <ChartOrTable
            chart={<ThroughputChart points={dayData.points} start={dayData.start} end={dayData.end} tz={TZ} />}
            table={<HourlyTraffic points={dayData.points} start={dayData.start} end={dayData.end} />}
          />
        </Card>
      </section>

      <section>
        <SectionHeader title="History">
          <SegmentedLinks
            items={(Object.keys(RANGES) as Range[]).map((r) => ({ href: href({ range: r }), label: RANGES[r].label, active: r === range }))}
          />
        </SectionHeader>
        <Card title={RANGES[range].monthly ? "Data volume per month" : "Data volume per day"} subtitle="GB, download next to upload">
          <ChartOrTable
            chart={<VolumeChart monthly={RANGES[range].monthly}
              data={history.map(({ period, value }) => ({ period, download: value?.received ?? null, upload: value?.sent ?? null }))} />}
            table={<VolumeTable rows={history} monthly={RANGES[range].monthly} />}
          />
        </Card>
      </section>

      <section>
        <SectionHeader title="Devices">
          <span className="text-sm text-muted">{clients.length} known · {onlineCount} online</span>
        </SectionHeader>
        <Card>
          <div className="max-h-[520px] overflow-auto">
            <DeviceTable devices={devices} now={at} />
          </div>
        </Card>
      </section>

      <section>
        <SectionHeader title="Events" />
        <Card>
          {events.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">Nothing has happened yet.</p>
          ) : (
            <ul className="divide-y divide-hairline text-sm">
              {events.map((e) => (
                <li key={e.id} className="flex flex-wrap gap-x-4 py-2">
                  <span className="w-28 shrink-0 tabular-nums text-muted">{formatDateTime(e.ts, TZ)}</span>
                  <span className="text-ink">{e.message}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
    </div>
  );
}

// --- tables ----------------------------------------------------------------------

const th = "px-2 py-1.5 text-right font-medium text-ink-2 first:text-left";
const td = "px-2 py-1 text-right tabular-nums text-ink first:text-left";
const HOUR = 3_600_000;

function HourlyTraffic({ points, start, end }: { points: { t: number; download: number | null; upload: number | null }[]; start: number; end: number }) {
  const rows = Array.from({ length: Math.round((end - start) / HOUR) }, () => ({ down: 0, up: 0, n: 0 }));
  for (const p of points) {
    const row = rows[Math.floor((p.t - start) / HOUR)];
    if (!row) continue;
    // 1-minute average in bit/s -> bytes in that minute
    row.down += ((p.download ?? 0) * 60) / 8;
    row.up += ((p.upload ?? 0) * 60) / 8;
    row.n++;
  }
  return (
    <table className="w-full text-sm">
      <caption className="pb-2 text-left text-xs text-muted">Volume per hour, from the 1-minute averages</caption>
      <thead className="sticky top-0 bg-surface">
        <tr className="border-b border-hairline"><th className={th}>Hour</th><th className={th}>Download</th><th className={th}>Upload</th></tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-hairline last:border-0">
            <td className={td}>{formatClock(start + i * HOUR, TZ)}</td>
            {r.n === 0 ? <td className="px-2 py-1 text-muted" colSpan={2}>No data</td> : (
              <><td className={td}>{formatBytes(r.down)}</td><td className={td}>{formatBytes(r.up)}</td></>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function VolumeTable({ rows, monthly }: { rows: { period: string; value: { received: number; sent: number } | null }[]; monthly: boolean }) {
  return (
    <table className="w-full text-sm">
      <caption className="pb-2 text-left text-xs text-muted">From the FRITZ!Box byte counters</caption>
      <thead className="sticky top-0 bg-surface">
        <tr className="border-b border-hairline"><th className={th}>{monthly ? "Month" : "Day"}</th><th className={th}>Download</th><th className={th}>Upload</th></tr>
      </thead>
      <tbody>
        {[...rows].reverse().map(({ period, value }) => (
          <tr key={period} className="border-b border-hairline last:border-0">
            <td className={td}>{monthly ? formatMonth(period) : formatDay(period)}</td>
            {value == null ? <td className="px-2 py-1 text-muted" colSpan={2}>No data</td> : (
              <><td className={td}>{formatBytes(value.received)}</td><td className={td}>{formatBytes(value.sent)}</td></>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DeviceTable({ devices, now }: { devices: Device[]; now: number }) {
  if (devices.length === 0) {
    return <p className="py-6 text-center text-sm text-muted">No devices yet - the device list is read once a minute.</p>;
  }
  const speed = (mbit: number) => (mbit >= 1000 ? `${mbit / 1000} Gbit/s` : `${mbit} Mbit/s`);
  const connection = (d: Device) => {
    const kind = d.interface === "wifi" ? ["Wi-Fi", d.band].filter(Boolean).join(" ") : d.interface === "lan" ? "LAN" : "–";
    return d.online && d.speedMbit && kind !== "–" ? `${kind} · ${speed(d.speedMbit)}` : kind;
  };
  return (
    <table className="w-full whitespace-nowrap text-sm">
      <thead className="sticky top-0 bg-surface">
        <tr className="border-b border-hairline">
          <th className="px-2 py-1.5 text-left font-medium text-ink-2">Device</th>
          <th className="px-2 py-1.5 text-left font-medium text-ink-2">IP</th>
          <th className="px-2 py-1.5 text-left font-medium text-ink-2">Connection</th>
          <th className="px-2 py-1.5 text-left font-medium text-ink-2">Via</th>
          <th className="px-2 py-1.5 text-left font-medium text-ink-2">Last seen</th>
          <th className="px-2 py-1.5 text-left font-medium text-ink-2">First seen</th>
        </tr>
      </thead>
      <tbody>
        {devices.map((d) => (
          <tr key={d.mac} className="border-b border-hairline last:border-0" title={d.mac}>
            <td className="px-2 py-1">
              <span className="flex items-center gap-2">
                <span aria-hidden className={d.online ? "text-good" : "text-muted"}>{d.online ? "●" : "○"}</span>
                <span className={d.online ? "text-ink" : "text-ink-2"}>{d.name}</span>
                {d.guest && <span className="rounded border border-hairline px-1 text-xs text-muted">guest</span>}
                {d.meshRole && (
                  <span className="rounded border border-hairline px-1 text-xs text-muted">
                    {d.meshRole === "master" ? "mesh base" : "mesh repeater"}
                  </span>
                )}
              </span>
            </td>
            <td className="px-2 py-1 tabular-nums text-ink-2">{d.ip || "–"}</td>
            <td className="px-2 py-1 text-ink-2">{connection(d)}</td>
            <td className="px-2 py-1 text-ink-2">{d.online && d.via ? d.via : "–"}</td>
            <td className="px-2 py-1 text-ink-2">{d.online ? "Online now" : d.lastSeen ? formatAgo(d.lastSeen, now, TZ) : "–"}</td>
            <td className="px-2 py-1 text-ink-2">{formatAgo(d.firstSeen, now, TZ)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
