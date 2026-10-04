// Number and date formatting. Numbers use German conventions (3,4 kW), labels
// stay English - same as Finance-Tracking.

const num = (digits: number) =>
  new Intl.NumberFormat("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const n0 = num(0);
const n1 = num(1);
const n2 = num(2);
const pct = new Intl.NumberFormat("de-DE", { style: "percent", maximumFractionDigits: 0 });

/** 230 W, 3,86 kW, 11,0 kW */
export function formatPower(watts: number | null | undefined): string {
  if (watts == null) return "–";
  const w = Math.abs(watts) < 5 ? 0 : watts;
  if (Math.abs(w) < 1000) return `${n0.format(w)} W`;
  return `${(Math.abs(w) < 10_000 ? n2 : n1).format(w / 1000)} kW`;
}

/** Wh in, kWh out: 18,4 kWh, 412 kWh */
export function formatEnergy(wh: number | null | undefined): string {
  if (wh == null) return "–";
  const kwh = wh / 1000;
  return `${(Math.abs(kwh) < 100 ? n1 : n0).format(kwh)} kWh`;
}

/** Bare kWh number for table cells and axis ticks. */
export function kwh(wh: number | null | undefined, digits = 1): string {
  if (wh == null) return "–";
  return num(digits).format(wh / 1000);
}

/** Internet rates, decimal units as providers quote them: 850 kbit/s, 23,4 Mbit/s */
export function formatBitrate(bits: number | null | undefined): string {
  if (bits == null) return "–";
  if (bits < 1e6) return `${n0.format(bits / 1e3)} kbit/s`;
  if (bits < 1e9) return `${(bits < 1e8 ? n1 : n0).format(bits / 1e6)} Mbit/s`;
  return `${n2.format(bits / 1e9)} Gbit/s`;
}

/** Data volume, decimal units: 850 MB, 12,3 GB, 1,23 TB */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "–";
  if (bytes < 1e9) return `${n0.format(bytes / 1e6)} MB`;
  if (bytes < 1e12) return `${(bytes < 1e11 ? n1 : n0).format(bytes / 1e9)} GB`;
  return `${n2.format(bytes / 1e12)} TB`;
}

/** 45 s, 12 min, 5 h 12 min, 3 d 4 h */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "–";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
}

export function formatPercent(ratio: number | null | undefined): string {
  return ratio == null || !Number.isFinite(ratio) ? "–" : pct.format(ratio);
}

// --- dates -------------------------------------------------------------------
// Days travel as "YYYY-MM-DD" strings in the home time zone; arithmetic on them
// is done in UTC so it never depends on the server's own time zone.

export function todayIn(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function isDay(value: string | undefined): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

const dayLabel = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" });
const shortDay = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
const monthLabel = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "short", year: "2-digit" });

const asUtc = (day: string) => new Date(`${day.length === 7 ? `${day}-01` : day}T00:00:00Z`);

/** Sun 4 Oct 2026 */
export const formatDay = (day: string) => dayLabel.format(asUtc(day));
/** 4 Oct */
export const formatShortDay = (day: string) => shortDay.format(asUtc(day));
/** Oct 26 (takes "YYYY-MM") */
export const formatMonth = (month: string) => monthLabel.format(asUtc(month));

/** 13:05 in the given zone */
export function formatClock(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);
}

/** 4 Oct, 13:05 in the given zone */
export function formatDateTime(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(ms);
}

/** 3 min ago, 5 h ago - or the date once it is more than a day back */
export function formatAgo(ms: number, now: number, tz: string): string {
  const s = (now - ms) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short" }).format(ms);
}
