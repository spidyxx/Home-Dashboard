import { Pool } from "pg";

// Reuse one pool across hot-reloads in dev to avoid exhausting connections.
const globalForPg = globalThis as unknown as { pool?: Pool };

export const pool =
  globalForPg.pool ?? new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

if (process.env.NODE_ENV !== "production") {
  globalForPg.pool = pool;
}

/** Time zone for day boundaries and clock labels. */
export const TZ = process.env.HOME_TZ || "Europe/Berlin";
