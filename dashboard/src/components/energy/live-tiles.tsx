"use client";

import { useEffect, useState } from "react";
import type { Live } from "@/lib/energy";
import { formatClock, formatEnergy, formatPower } from "@/lib/format";
import { SectionHeader, StatTile, StatusNote } from "@/components/ui";

const POLL_MS = 10_000;
// The collector samples the Envoy every 10 s; this much silence means it is down.
const STALE_MS = 2 * 60_000;

function carStatus(mode: number | null, sessionWh: number | null): { text: string; problem?: "warning" | "critical" } {
  switch (mode) {
    case 1: return { text: "Not plugged in" };
    case 2: return { text: "Plugged in, waiting for solar" };
    case 3: return { text: `Charging · ${formatEnergy(sessionWh)} this session` };
    case 4: return { text: `Charge complete · ${formatEnergy(sessionWh)}` };
    case 5: return { text: "Charger error", problem: "critical" };
    case 6: return { text: "Ready to charge" };
    case 0: return { text: "Charger offline", problem: "warning" };
    default: return { text: "No data" };
  }
}

export function LiveTiles({ initial, tz }: { initial: Live; tz: string }) {
  const [live, setLive] = useState(initial);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/live", { cache: "no-store" });
        if (res.ok && !cancelled) setLive(await res.json());
      } catch {
        // Keep showing the last values; the staleness note covers outages.
      }
      if (!cancelled) setNow(Date.now());
    };
    const pollTimer = setInterval(poll, POLL_MS);
    const clockTimer = setInterval(() => setNow(Date.now()), 5_000);
    return () => {
      cancelled = true;
      clearInterval(pollTimer);
      clearInterval(clockTimer);
    };
  }, []);

  const age = live.envoyAt == null ? null : now - live.envoyAt;
  const stale = age == null || age > STALE_MS;
  const car = carStatus(live.carMode, live.carSessionWh);
  const grid = live.gridW ?? 0;

  return (
    <div>
      <SectionHeader title="Now">
        <div className="ml-auto text-xs text-muted">
          {stale ? (
            <StatusNote tone="warning">
              {live.envoyAt == null
                ? "No live data yet - is the collector running?"
                : `No live data since ${formatClock(live.envoyAt, tz)} - is the collector running?`}
            </StatusNote>
          ) : (
            <span>Updated {Math.max(0, Math.round(age / 1000))} s ago</span>
          )}
        </div>
      </SectionHeader>
      <div className={`grid grid-cols-2 gap-3 lg:grid-cols-4 ${stale ? "opacity-60" : ""}`}>
        <StatTile label="Solar" swatch="var(--solar)" value={formatPower(live.pvW)} sub="Production" />
        <StatTile label="Home" swatch="var(--home)" value={formatPower(live.homeW)} sub="Consumption without the car" />
        <StatTile
          label="Car"
          swatch="var(--car)"
          value={formatPower(live.carW)}
          sub={car.problem ? <StatusNote tone={car.problem}>{car.text}</StatusNote> : car.text}
        />
        <StatTile
          label="Grid"
          value={formatPower(live.gridW == null ? null : Math.abs(grid))}
          sub={live.gridW == null ? "–" : Math.abs(grid) < 5 ? "Balanced" : grid > 0 ? "↓ Importing" : "↑ Exporting"}
        />
      </div>
    </div>
  );
}
