"use client";

import { useEffect } from "react";

// Shown when the database is unreachable (e.g. during the nightly appdata
// backup). Retries on its own so an unattended wall display recovers.
export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error(error);
    const timer = setInterval(reset, 30_000);
    return () => clearInterval(timer);
  }, [error, reset]);

  return (
    <div className="mx-auto max-w-md py-24 text-center">
      <p className="text-lg font-semibold text-ink"><span aria-hidden className="text-warning">⚠</span> Data is unavailable</p>
      <p className="mt-2 text-sm text-ink-2">The database could not be reached. Retrying every 30 seconds.</p>
      <button type="button" onClick={reset} className="mt-4 rounded-md border border-hairline px-3 py-1 text-sm text-ink-2 hover:bg-grid/60">
        Retry now
      </button>
    </div>
  );
}
