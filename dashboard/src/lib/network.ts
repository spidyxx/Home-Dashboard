// Network queries (FRITZ!Box): traffic, internet status, devices, who's home,
// and the event log.

import { pool } from "./db";
import { counterDeltas, dayBounds, latest, minuteSeries, rangeStart, toPeriods, type Range } from "./series";

export const NET = {
  down: "fritz.download_rate", // bit/s
  up: "fritz.upload_rate",
  received: "fritz.bytes_received", // B, counter
  sent: "fritz.bytes_sent",
  online: "fritz.online",
  devices: "fritz.devices_online",
  wifi: "fritz.devices_wifi",
} as const;

// --- now -----------------------------------------------------------------------

export type Person = { name: string; home: boolean; since: number | null };

export type NetworkNow = {
  downBit: number | null;
  upBit: number | null;
  online: boolean | null;
  devices: number | null;
  wifi: number | null;
  at: number | null; // epoch ms of the latest traffic sample
  connectionUptime: number | null; // s, as of the last device poll
  ipv4: string | null;
  ipv6Prefix: string | null;
  people: Person[];
};

// Presence per person: the current value and since when it holds - the first
// minute after the last minute with a different value (rollups, so it also
// works when raw samples are pruned).
const PEOPLE_SQL = `
SELECT s.name, l.value,
       (SELECT min(r.bucket) FROM reading_1m r
        WHERE r.sensor_id = s.id
          AND r.bucket > COALESCE((SELECT max(c.bucket) FROM reading_1m c
                                   WHERE c.sensor_id = s.id AND c.last <> l.value), '-infinity')) AS since
FROM sensor s JOIN sensor_latest l ON l.sensor_id = s.id
WHERE s.key LIKE 'fritz.home.%'
ORDER BY s.name`;

export async function getNetworkNow(): Promise<NetworkNow> {
  const [values, internet, people] = await Promise.all([
    latest(Object.values(NET)),
    pool.query<{ attributes: Record<string, unknown> }>(
      "SELECT attributes FROM entity WHERE kind = 'internet' AND key = 'wan'"),
    pool.query<{ name: string; value: number; since: Date | null }>(PEOPLE_SQL),
  ]);
  const v = (key: string) => values.get(key)?.value ?? null;
  const wan = internet.rows[0]?.attributes ?? {};
  return {
    downBit: v(NET.down),
    upBit: v(NET.up),
    online: v(NET.online) == null ? null : v(NET.online) === 1,
    devices: v(NET.devices),
    wifi: v(NET.wifi),
    at: values.get(NET.online)?.ts.getTime() ?? null,
    connectionUptime: typeof wan.connection_uptime === "number" ? wan.connection_uptime : null,
    ipv4: typeof wan.ipv4 === "string" && wan.ipv4 ? wan.ipv4 : null,
    ipv6Prefix: typeof wan.ipv6_prefix === "string" && wan.ipv6_prefix ? wan.ipv6_prefix : null,
    people: people.rows.map((r) => ({
      name: r.name.replace(/ at home$/, ""),
      home: r.value === 1,
      since: r.since?.getTime() ?? null,
    })),
  };
}

// --- one day -------------------------------------------------------------------

export type TrafficPoint = { t: number; download: number | null; upload: number | null };
export type Volume = { received: number; sent: number }; // bytes

export type NetworkDay = {
  start: number;
  end: number;
  points: TrafficPoint[];
  volume: Volume | null;
  onlineShare: number | null; // of the minutes with data
  outages: number;
};

export async function getNetworkDay(day: string): Promise<NetworkDay> {
  const { start, end } = await dayBounds(day);
  const [traffic, deltas, online, outages] = await Promise.all([
    minuteSeries(start, end, [NET.down, NET.up]),
    counterDeltas(day, day, [NET.received, NET.sent]),
    pool.query<{ share: number | null }>(
      `SELECT avg(avg)::float8 AS share FROM reading_1m
       WHERE sensor_id = (SELECT id FROM sensor WHERE key = $1) AND bucket >= $2 AND bucket < $3`,
      [NET.online, start, end]),
    pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM event WHERE source = 'fritz' AND kind = 'offline' AND ts >= $1 AND ts < $2",
      [start, end]),
  ]);
  const d = deltas.get(day);
  return {
    start: start.getTime(),
    end: end.getTime(),
    points: traffic.map(({ t, values }) => ({ t, download: values[NET.down], upload: values[NET.up] })),
    volume: d && d[NET.received] != null ? { received: d[NET.received], sent: d[NET.sent] ?? 0 } : null,
    onlineShare: online.rows[0]?.share ?? null,
    outages: outages.rows[0]?.n ?? 0,
  };
}

// --- history -------------------------------------------------------------------

export async function getVolumeHistory(range: Range, today: string) {
  const deltas = await counterDeltas(rangeStart(range, today), today, [NET.received, NET.sent]);
  const byDay = new Map<string, Volume>();
  for (const [day, d] of deltas) {
    if (d[NET.received] != null) byDay.set(day, { received: d[NET.received], sent: d[NET.sent] ?? 0 });
  }
  return toPeriods(range, today, byDay, (list) => ({
    received: list.reduce((a, v) => a + v.received, 0),
    sent: list.reduce((a, v) => a + v.sent, 0),
  }));
}

// --- devices and events ------------------------------------------------------------

export type Device = {
  mac: string;
  name: string;
  ip: string;
  interface: "wifi" | "lan" | "";
  speedMbit: number;
  via: string; // mesh box the device is connected to
  band: string; // Wi-Fi band, e.g. "5 GHz"
  meshRole: string; // "master" / "slave" for FRITZ! mesh boxes, else ""
  guest: boolean;
  online: boolean;
  firstSeen: number;
  lastSeen: number | null;
};

// "Online" also requires a recent report, so a stopped collector does not leave
// devices online forever. Mesh boxes (the network itself) come first.
export async function getDevices(): Promise<Device[]> {
  const { rows } = await pool.query<{
    key: string; attributes: Record<string, unknown>; first_seen: Date; last_seen: Date | null; online: boolean;
  }>(
    `SELECT key, attributes, first_seen, last_seen,
            (attributes->>'active')::boolean AND updated_at > now() - interval '5 minutes' AS online
     FROM entity WHERE kind = 'network_device'
     ORDER BY coalesce(attributes->>'mesh_role', '') = '', online DESC, last_seen DESC NULLS LAST,
              lower(attributes->>'name')`,
  );
  return rows.map((r) => ({
    mac: r.key,
    name: String(r.attributes.name ?? r.key),
    ip: String(r.attributes.ip ?? ""),
    interface: r.attributes.interface === "wifi" || r.attributes.interface === "lan" ? r.attributes.interface : "",
    speedMbit: Number(r.attributes.speed_mbit ?? 0),
    via: String(r.attributes.via ?? ""),
    band: String(r.attributes.band ?? ""),
    meshRole: String(r.attributes.mesh_role ?? ""),
    guest: r.attributes.guest === true,
    online: r.online,
    firstSeen: r.first_seen.getTime(),
    lastSeen: r.last_seen?.getTime() ?? null,
  }));
}

export type HomeEvent = { id: string; ts: number; source: string; kind: string; message: string };

export async function getEvents(limit = 30): Promise<HomeEvent[]> {
  const { rows } = await pool.query<{ id: string; ts: Date; source: string; kind: string; message: string }>(
    "SELECT id, ts, source, kind, message FROM event ORDER BY ts DESC LIMIT $1",
    [limit],
  );
  return rows.map((r) => ({ ...r, ts: r.ts.getTime() }));
}
