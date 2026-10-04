// Energy queries. Energy totals come from the lifetime counters (day-end minus
// previous day-end), so they stay correct across collector downtime; power
// curves come from the gauges.

import { pool, TZ } from "./db";
import { addDays, todayIn } from "./format";
import { counterDeltas, dayBounds, latest, minuteSeries, rangeStart, toPeriods, type Range } from "./series";

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
  const by = await latest([SENSORS.pvPower, SENSORS.gridPower, SENSORS.carPower, SENSORS.carMode, SENSORS.carSession]);
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
  const [deltas, carSolar] = await Promise.all([
    counterDeltas(from, to, counterKeys),
    pool.query<{ day: string; car: number; car_solar: number }>(CAR_SOLAR_SQL, [
      from, to, TZ, SENSORS.carPower, SENSORS.pvPower, SENSORS.gridPower,
    ]),
  ]);
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

// The car is polled every 30-120 s, so some minutes have no sample of their own.
const CAR_FILL_MS = 3 * 60_000;

export async function getDay(day: string): Promise<DayData> {
  const { start, end } = await dayBounds(day);
  const [power, totals] = await Promise.all([
    minuteSeries(start, end, [SENSORS.pvPower, SENSORS.gridPower, SENSORS.carPower]),
    dailyTotals(day, day),
  ]);

  let lastCar: { t: number; w: number } | null = null;
  const points = power.map(({ t, values }): PowerPoint => {
    const pv = values[SENSORS.pvPower];
    const grid = values[SENSORS.gridPower];
    const measured = values[SENSORS.carPower];
    if (measured != null) lastCar = { t, w: measured };
    const car = measured ?? (lastCar && t - lastCar.t <= CAR_FILL_MS ? lastCar.w : null);
    return { t, solar: pv == null ? null : Math.max(pv, 0), home: homePower(pv, grid, car), car };
  });

  return { day, start: start.getTime(), end: end.getTime(), points, totals: totals.get(day) ?? null };
}

// --- history -----------------------------------------------------------------

export type HistoryRow = { period: string; totals: EnergyTotals | null };

/** Daily rows (or monthly for 12m) ending today; periods without data have totals = null. */
export async function getHistory(range: Range, today: string): Promise<HistoryRow[]> {
  const totals = await dailyTotals(rangeStart(range, today), today);
  return toPeriods(range, today, totals, sumTotals).map(({ period, value }) => ({ period, totals: value }));
}
