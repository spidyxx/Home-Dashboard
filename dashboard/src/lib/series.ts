// Generic time-series queries shared by every page: latest values, per-minute
// series, and per-day counter deltas. Raw samples (`reading`) feed live views;
// everything else reads the per-minute rollup (`reading_1m`).

import { pool, TZ } from "./db";
import { addDays } from "./format";

export type Latest = { ts: Date; value: number };

/** Newest raw value per sensor key. */
export async function latest(keys: string[]): Promise<Map<string, Latest>> {
  const { rows } = await pool.query<{ key: string; ts: Date; value: number }>(
    "SELECT key, ts, value FROM sensor_latest WHERE key = ANY($1)",
    [keys],
  );
  return new Map(rows.map((r) => [r.key, { ts: r.ts, value: r.value }]));
}

/** Start and end of a local day ("YYYY-MM-DD") in the home time zone. */
export async function dayBounds(day: string): Promise<{ start: Date; end: Date }> {
  const { rows } = await pool.query<{ start: Date; end: Date }>(
    `SELECT $1::date::timestamp AT TIME ZONE $2 AS start, ($1::date + 1)::timestamp AT TIME ZONE $2 AS "end"`,
    [day, TZ],
  );
  return rows[0];
}

export type MinuteRow = { t: number; values: Record<string, number | null> };

/** Per-minute averages of several sensors in [start, end), one row per minute with data. */
export async function minuteSeries(start: Date, end: Date, keys: string[]): Promise<MinuteRow[]> {
  const { rows } = await pool.query<{ t: number; key: string; avg: number }>(
    `SELECT (extract(epoch FROM r.bucket) * 1000)::float8 AS t, s.key, r.avg
     FROM reading_1m r JOIN sensor s ON s.id = r.sensor_id
     WHERE s.key = ANY($3) AND r.bucket >= $1 AND r.bucket < $2
     ORDER BY r.bucket`,
    [start, end, keys],
  );
  const out: MinuteRow[] = [];
  for (const r of rows) {
    let row = out[out.length - 1];
    if (!row || row.t !== r.t) {
      row = { t: r.t, values: Object.fromEntries(keys.map((k) => [k, null])) };
      out.push(row);
    }
    row.values[r.key] = r.avg;
  }
  return out;
}

// Per local day and counter: last value of the day minus the last value before
// the day (or the day's first value when there is nothing earlier). A gap in
// the data lands on the day after the gap instead of being lost.
const COUNTER_DELTAS_SQL = `
WITH days AS (
  SELECT d::date AS day,
         d::date::timestamp AT TIME ZONE $3 AS day_start,
         (d::date + 1)::timestamp AT TIME ZONE $3 AS day_end
  FROM generate_series($1::date, $2::date, interval '1 day') d
)
SELECT days.day::text AS day, s.key,
       GREATEST(e.last - COALESCE(b.last, f.min), 0)::float8 AS delta
FROM days
CROSS JOIN sensor s
LEFT JOIN LATERAL (SELECT last FROM reading_1m WHERE sensor_id = s.id
                   AND bucket >= days.day_start AND bucket < days.day_end
                   ORDER BY bucket DESC LIMIT 1) e ON true
LEFT JOIN LATERAL (SELECT last FROM reading_1m WHERE sensor_id = s.id
                   AND bucket < days.day_start
                   ORDER BY bucket DESC LIMIT 1) b ON true
LEFT JOIN LATERAL (SELECT min FROM reading_1m WHERE sensor_id = s.id
                   AND bucket >= days.day_start
                   ORDER BY bucket LIMIT 1) f ON true
WHERE s.key = ANY($4) AND e.last IS NOT NULL`;

/** Growth of each counter per local day in [from, to]: day -> {key: delta}. Days without data are absent. */
export async function counterDeltas(from: string, to: string, keys: string[]): Promise<Map<string, Record<string, number>>> {
  const { rows } = await pool.query<{ day: string; key: string; delta: number }>(COUNTER_DELTAS_SQL, [from, to, TZ, keys]);
  const out = new Map<string, Record<string, number>>();
  for (const r of rows) out.set(r.day, { ...out.get(r.day), [r.key]: r.delta });
  return out;
}

// --- history ranges ------------------------------------------------------------

export const RANGES = {
  "30d": { label: "30 days", days: 30, monthly: false },
  "90d": { label: "90 days", days: 90, monthly: false },
  "12m": { label: "12 months", days: 0, monthly: true },
} as const;
export type Range = keyof typeof RANGES;

export function parseRange(value: string | undefined): Range {
  return value && value in RANGES ? (value as Range) : "30d";
}

/** First day to query for a range ending today. */
export function rangeStart(range: Range, today: string): string {
  const spec = RANGES[range];
  if (!spec.monthly) return addDays(today, -(spec.days - 1));
  const [y, m] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 12, 1)).toISOString().slice(0, 10);
}

/**
 * Per-day values -> one row per period of the range (days, or months for 12m),
 * in order; periods without data get null.
 */
export function toPeriods<T>(range: Range, today: string, byDay: Map<string, T>, sum: (list: T[]) => T) {
  const from = rangeStart(range, today);
  const periods: string[] = [];
  for (let day = from; day <= today; day = addDays(day, 1)) {
    const period = RANGES[range].monthly ? day.slice(0, 7) : day;
    if (periods[periods.length - 1] !== period) periods.push(period);
  }
  const grouped = new Map<string, T[]>();
  for (const [day, value] of byDay) {
    const period = RANGES[range].monthly ? day.slice(0, 7) : day;
    grouped.set(period, [...(grouped.get(period) ?? []), value]);
  }
  return periods.map((period) => {
    const list = grouped.get(period);
    return { period, value: list ? sum(list) : null };
  });
}
