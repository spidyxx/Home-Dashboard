"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-renders the server components periodically, e.g. today's chart on a wall display. */
export function AutoRefresh({ active, intervalMs = 60_000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, router]);
  return null;
}
