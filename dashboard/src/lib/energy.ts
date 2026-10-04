// Energy queries. Raw samples (`reading`) feed the live view; everything else
// reads the per-minute rollup (`reading_1m`). Energy totals come from the
// lifetime counters (day-end minus previous day-end), so they stay correct
// across collector downtime; power curves come from the gauges.

import { pool, TZ } from "./db";
import { addDays, todayIn } from "./format";

export const SENSORS = {
  pvPower: "envoy.pv_power",
  gridPower: "envoy.grid_power", // + import / - export
  carPower: "easee.power",
  carMode: "easee.op_mode",
  carSession: "easee.session_energy",
  pvEnergy: "envoy.pv_energy",
  importEnergy: "envoy.grid_import_energy",
  exportEnergy: "envoy.grid_export_energy",
  carEnergy: "easee.lifetime_energy",
} as const;

// --- live --------------------------------------------------------------------

export type Live = {
  pvW: number | null;
  gridW: number | null;
  carW: number | null;
  homeW: number | null;
  carMode: number | null;
  carSessionWh: number | null;
  envoyAt: number | null; // epoch ms of the latest Envoy sample
  easeeAt: number | null;
};

export async function getLive(): Promise<Live> {
  const { rows } = await pool.query<{ key: string; ts: Date; value: number }>(
    "SELECT key, ts, value FROM sensor_latest WHERE key = ANY($1)",
    [[SENSORS.pvPower, SENSORS.gridPower, SENSORS.carPower, SENSORS.carMode, SENSORS.carSession]],
  );
  const by = new Map(rows.map((r) => [r.key, r]));
  const v = (key: string) => by.get(key)?.value ?? null;
  const pvW = v(SENSORS.pvPower);
  const gridW = v(SENSORS.gridPower);
  const carW = v(SENSORS.carPower);
  return {
    pvW: pvW == null ? null : Math.max(pvW, 0),
    gridW,
    carW,
    homeW: homePower(pvW, gridW, carW),
    carMode: v(SENSORS.carMode),
    carSessionWh: v(SENSORS.carSession),
    envoyAt: by.get(SENSORS.pvPower)?.ts.getTime() ?? null,
    easeeAt: by.get(SENSORS.carPower)?.ts.getTime() ?? null,
  };
}

/** House consumption without the car: production + grid import - car. */
function homePower(pv: number | null, grid: number | null, car: number | null) {
  if (pv == null || grid == null) return null;
  return Math.max(pv + grid - (car ?? 0), 0);
}

// --- energy totals -----------------------------------------------------------

export type EnergyTotals = {
  produced: number; // all Wh
  imported: number;
  exported: number;
  consumed: number;
  selfConsumed: number; // produced and used in the house (incl. car)
  home: number; // consumed without the car
  car: number;
  carSolar: number; // part of `car` covered by solar
};

export const selfSufficiency = (t: EnergyTotals) => (t.consumed > 0 ? t.selfConsumed / t.consumed : null);
export const carSolarShare = (t: EnergyTotals) => (t.car > 0 ? t.carSolar / t.car : null);

function derive(produced: number, imported: number, exported: number, car: number, carSolarRatio: number | null): EnergyTotals {
  const consumed = Math.max(produced + imported - exported, 0);
  const selfConsumed = Math.max(produced - exported, 0);
  return {
    produced,
    imported,
    exported,
    consumed,
    selfConsumed,
    car,
    home: Math.max(consumed - car, 0),
    carSolar: car * (carSolarRatio ?? 0),
  };
}

export function sumTotals(list: EnergyTotals[]): EnergyTotals {
  const keys = ["produced", "imported", "exported", "consumed", "selfConsumed", "home", "car", "carSolar"] as const;
  const out = Object.fromEntries(keys.map((k) => [k, 0])) as EnergyTotals;
  for (const t of list) for (const k of keys) out[k] += t[k];
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

// Solar share of car charging, power-weighted per minute: in each minute the
// car is attributed the same solar fraction as the whole house
// (1 - grid import / consumption). The sensor ids are scalar subqueries so the
// planner can use the primary key; a join on a CTE made it scan the table.
const CAR_SOLAR_SQL = `
SELECT (c.bucket AT TIME ZONE $3)::date::text AS day,
       sum(c.avg)::float8 AS car,
       sum(c.avg * CASE WHEN p.avg + g.avg > 0
                        THEN GREATEST(0, LEAST(1, 1 - GREATEST(g.avg, 0) / (p.avg + g.avg)))
                        ELSE 0 END)::float8 AS car_solar
FROM reading_1m c
JOIN reading_1m p ON p.sensor_id = (SELECT id FROM sensor WHERE key = $5) AND p.bucket = c.bucket
JOIN reading_1m g ON g.sensor_id = (SELECT id FROM sensor WHERE key = $6) AND g.bucket = c.bucket
WHERE c.sensor_id = (SELECT id FROM sensor WHERE key = $4)
  AND c.bucket >= $1::date::timestamp AT TIME ZONE $3
  AND c.bucket < ($2::date + 1)::timestamp AT TIME ZONE $3
  AND c.avg > 0
GROUP BY 1`;

// Finished days do not change any more, so their totals are cached for the life
// of the process. Today and yesterday are always recomputed: buffered writes and
// late rollups can still land there.
const settledDays = new Map<string, EnergyTotals | null>();

/** Energy totals per local day for [from, to]; days without solar/grid data are left out. */
export async function dailyTotals(from: string, to: string): Promise<Map<string, EnergyTotals>> {
  const settledUntil = addDays(todayIn(TZ), -2);
  let queryFrom = from;
  while (queryFrom <= to && queryFrom <= settledUntil && settledDays.has(queryFrom)) {
    queryFrom = addDays(queryFrom, 1);
  }
  const fresh = queryFrom <= to ? await queryDailyTotals(queryFrom, to) : new Map<string, EnergyTotals>();

  const out = new Map<string, EnergyTotals>();
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const totals = day < queryFrom ? settledDays.get(day) : fresh.get(day) ?? null;
    if (day >= queryFrom && day <= settledUntil) settledDays.set(day, totals ?? null);
    if (totals) out.set(day, totals);
  }
  return out;
}

async function queryDailyTotals(from: string, to: string): Promise<Map<string, EnergyTotals>> {
  const counterKeys = [SENSORS.pvEnergy, SENSORS.importEnergy, SENSORS.exportEnergy, SENSORS.carEnergy];
  const [counters, carSolar] = await Promise.all([
    pool.query<{ day: string; key: string; delta: number }>(COUNTER_DELTAS_SQL, [from, to, TZ, counterKeys]),
    pool.query<{ day: string; car: number; car_solar: number }>(CAR_SOLAR_SQL, [
      from, to, TZ, SENSORS.carPower, SENSORS.pvPower, SENSORS.gridPower,
    ]),
  ]);

  const deltas = new Map<string, Record<string, number>>();
  for (const r of counters.rows) {
    deltas.set(r.day, { ...deltas.get(r.day), [r.key]: r.delta });
  }
  const solarRatio = new Map(carSolar.rows.map((r) => [r.day, r.car > 0 ? r.car_solar / r.car : null]));

  const out = new Map<string, EnergyTotals>();
  for (const [day, d] of deltas) {
    const produced = d[SENSORS.pvEnergy];
    const imported = d[SENSORS.importEnergy];
    const exported = d[SENSORS.exportEnergy];
    if (produced == null || imported == null || exported == null) continue;
    out.set(day, derive(produced, imported, exported, d[SENSORS.carEnergy] ?? 0, solarRatio.get(day) ?? null));
  }
  return out;
}

// --- one day -----------------------------------------------------------------

export type PowerPoint = { t: number; solar: number | null; home: number | null; car: number | null };

export type DayData = {
  day: string;
  start: number; // epoch ms of local midnight
  end: number;
  points: PowerPoint[];
  totals: EnergyTotals | null;
};

const DAY_POWER_SQL = `
SELECT (extract(epoch FROM r.bucket) * 1000)::float8 AS t,
       max(r.avg) FILTER (WHERE s.key = $3) AS pv,
       max(r.avg) FILTER (WHERE s.key = $4) AS grid,
       max(r.avg) FILTER (WHERE s.key = $5) AS car
FROM reading_1m r JOIN sensor s ON s.id = r.sensor_id
WHERE s.key IN ($3, $4, $5) AND r.bucket >= $1 AND r.bucket < $2
GROUP BY r.bucket ORDER BY r.bucket`;

// The car is polled every 30-120 s, so some minutes have no sample of their own.
const CAR_FILL_MS = 3 * 60_000;

export async function getDay(day: string): Promise<DayData> {
  const bounds = await pool.query<{ start: Date; end: Date }>(
    `SELECT $1::date::timestamp AT TIME ZONE $2 AS start, ($1::date + 1)::timestamp AT TIME ZONE $2 AS "end"`,
    [day, TZ],
  );
  const { start, end } = bounds.rows[0];

  const [power, totals] = await Promise.all([
    pool.query<{ t: number; pv: number | null; grid: number | null; car: number | null }>(DAY_POWER_SQL, [
      start, end, SENSORS.pvPower, SENSORS.gridPower, SENSORS.carPower,
    ]),
    dailyTotals(day, day),
  ]);

  let lastCar: { t: number; w: number } | null = null;
  const points = power.rows.map((r): PowerPoint => {
    if (r.car != null) lastCar = { t: r.t, w: r.car };
    const car = r.car ?? (lastCar && r.t - lastCar.t <= CAR_FILL_MS ? lastCar.w : null);
    return {
      t: r.t,
      solar: r.pv == null ? null : Math.max(r.pv, 0),
      home: homePower(r.pv, r.grid, car),
      car,
    };
  });

  return { day, start: start.getTime(), end: end.getTime(), points, totals: totals.get(day) ?? null };
}

// --- history -----------------------------------------------------------------

export const RANGES = {
  "30d": { label: "30 days", days: 30, monthly: false },
  "90d": { label: "90 days", days: 90, monthly: false },
  "12m": { label: "12 months", days: 0, monthly: true },
} as const;
export type Range = keyof typeof RANGES;

export type HistoryRow = { period: string; totals: EnergyTotals | null };

/** Daily rows (or monthly for 12m) ending today; periods without data have totals = null. */
export async function getHistory(range: Range, today: string): Promise<HistoryRow[]> {
  const spec = RANGES[range];
  if (!spec.monthly) {
    const from = addDays(today, -(spec.days - 1));
    const totals = await dailyTotals(from, today);
    return Array.from({ length: spec.days }, (_, i) => {
      const day = addDays(from, i);
      return { period: day, totals: totals.get(day) ?? null };
    });
  }

  const [y, m] = today.split("-").map(Number);
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 12 + i, 1));
    return d.toISOString().slice(0, 7);
  });
  const totals = await dailyTotals(`${months[0]}-01`, today);
  const byMonth = new Map<string, EnergyTotals[]>();
  for (const [day, t] of totals) {
    const month = day.slice(0, 7);
    byMonth.set(month, [...(byMonth.get(month) ?? []), t]);
  }
  return months.map((month) => {
    const list = byMonth.get(month);
    return { period: month, totals: list ? sumTotals(list) : null };
  });
}
