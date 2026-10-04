# db.py
#
# Postgres access for the collector: schema migrations, the sensor registry,
# buffered reading writes, and the per-minute rollup.

import os
import logging
import threading
import collections
from datetime import datetime, timezone

import psycopg
from psycopg.types.json import Jsonb

from sources.base import Entity, Event, Reading

logger = logging.getLogger(__name__)

MIGRATIONS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'migrations')

# Recomputes the 1-minute buckets touched since `since`. Idempotent, so the
# same minute can safely be rolled up again when late samples arrive.
ROLLUP_SQL = """
INSERT INTO reading_1m (sensor_id, bucket, avg, min, max, last, samples)
SELECT sensor_id, date_trunc('minute', ts), avg(value), min(value), max(value),
       (array_agg(value ORDER BY ts DESC))[1], count(*)
FROM reading
WHERE ts >= %(since)s
GROUP BY sensor_id, date_trunc('minute', ts)
ON CONFLICT (sensor_id, bucket) DO UPDATE
SET avg = EXCLUDED.avg, min = EXCLUDED.min, max = EXCLUDED.max,
    last = EXCLUDED.last, samples = EXCLUDED.samples
"""


class Database:
    """
    A single shared connection, (re)connected on demand and safe to use from
    the source threads.

    Postgres goes away regularly in a homelab (container updates, the nightly
    appdata backup stops it). write() therefore never raises: readings that
    cannot be stored stay in an in-memory buffer and go out with the next
    successful write, so a database outage of up to `buffer_limit` readings
    loses no data.
    """

    def __init__(self, url, sensors, buffer_limit=200_000):
        self.url = url
        self.sensors = sensors            # all Sensor definitions, registered on connect
        self.conn = None
        self.sensor_ids = {}
        self.pending = collections.deque(maxlen=buffer_limit)
        self.dropped = 0
        self.last_error = None
        # Earliest reading timestamp written since the last rollup.
        self.dirty_since = None
        self.lock = threading.Lock()

    # --- connection ----------------------------------------------------------

    def _ensure(self):
        """Returns a live connection; on a fresh connect applies migrations and registers sensors."""
        if self.conn is not None and not self.conn.closed:
            return self.conn
        conn = psycopg.connect(self.url, autocommit=True, connect_timeout=10)
        try:
            self._migrate(conn)
            self.sensor_ids = self._register_sensors(conn)
            if self.dirty_since is None:
                # Catch up on anything written before a crash but not yet rolled up.
                row = conn.execute("SELECT max(bucket) FROM reading_1m").fetchone()
                self.dirty_since = row[0] or datetime.fromtimestamp(0, timezone.utc)
        except Exception:
            conn.close()
            raise
        self.conn = conn
        logger.info("Connected to Postgres (%d sensors registered).", len(self.sensor_ids))
        return conn

    def _reset(self):
        if self.conn is not None:
            try:
                self.conn.close()
            except Exception:
                pass
        self.conn = None

    def _migrate(self, conn):
        """Applies migrations/NNN_*.sql in order, each once, each in its own transaction."""
        conn.execute("""CREATE TABLE IF NOT EXISTS schema_migrations (
                            version text PRIMARY KEY,
                            applied_at timestamptz NOT NULL DEFAULT now())""")
        applied = {row[0] for row in conn.execute("SELECT version FROM schema_migrations")}
        for filename in sorted(os.listdir(MIGRATIONS_DIR)):
            if not filename.endswith('.sql') or filename in applied:
                continue
            with open(os.path.join(MIGRATIONS_DIR, filename)) as f:
                sql = f.read()
            with conn.transaction():
                conn.execute(sql)
                conn.execute("INSERT INTO schema_migrations (version) VALUES (%s)", (filename,))
            logger.warning("Applied database migration %s.", filename)

    def _register_sensors(self, conn):
        """Upserts every sensor definition and returns {key: id}."""
        ids = {}
        with conn.transaction():
            for s in self.sensors:
                row = conn.execute(
                    """INSERT INTO sensor (key, source, name, unit, kind)
                       VALUES (%s, %s, %s, %s, %s)
                       ON CONFLICT (key) DO UPDATE
                       SET source = EXCLUDED.source, name = EXCLUDED.name,
                           unit = EXCLUDED.unit, kind = EXCLUDED.kind
                       RETURNING id""",
                    (s.key, s.key.split('.', 1)[0], s.name, s.unit, s.kind)).fetchone()
                ids[s.key] = row[0]
        return ids

    # --- writes --------------------------------------------------------------

    def write(self, items):
        """
        Queues Readings, Entities and Events and flushes everything pending.
        Never raises.

        Returns True if the queue was flushed, False if the items stay
        buffered for the next attempt.
        """
        with self.lock:
            for item in items:
                if len(self.pending) == self.pending.maxlen:
                    self.dropped += 1
                self.pending.append(item)
            if self.dropped:
                logger.error("Reading buffer full - dropped %d oldest readings so far.", self.dropped)
            return self._flush()

    def _flush(self):
        if not self.pending:
            return True
        batch = list(self.pending)
        readings = [r for r in batch if isinstance(r, Reading)]
        try:
            conn = self._ensure()
            with conn.transaction(), conn.cursor() as cur:
                if readings:
                    cur.executemany(
                        "INSERT INTO reading (sensor_id, ts, value) VALUES (%s, %s, %s) "
                        "ON CONFLICT DO NOTHING",
                        [(self.sensor_ids[r.key], r.ts, r.value) for r in readings])
                entities = [e for e in batch if isinstance(e, Entity)]
                if entities:
                    # GREATEST ignores NULL: an inactive report keeps last_seen.
                    cur.executemany(
                        """INSERT INTO entity (kind, key, attributes, first_seen, last_seen, updated_at)
                           VALUES (%s, %s, %s, %s, %s, %s)
                           ON CONFLICT (kind, key) DO UPDATE
                           SET attributes = EXCLUDED.attributes,
                               last_seen = GREATEST(entity.last_seen, EXCLUDED.last_seen),
                               updated_at = GREATEST(entity.updated_at, EXCLUDED.updated_at)""",
                        [(e.kind, e.key, Jsonb(e.attributes), e.ts, e.ts if e.active else None, e.ts)
                         for e in entities])
                events = [e for e in batch if isinstance(e, Event)]
                if events:
                    cur.executemany(
                        "INSERT INTO event (ts, source, kind, message, data) VALUES (%s, %s, %s, %s, %s)",
                        [(e.ts, e.source, e.kind, e.message, Jsonb(e.data)) for e in events])
        except Exception as e:
            # Logged (throttled) and alerted on by the caller via Health.
            self._reset()
            self.last_error = f"{len(batch)} readings buffered in memory - {e}"
            logger.debug("Database write failed: %s", self.last_error)
            return False
        self.pending.clear()
        self.dropped = 0
        if readings:
            earliest = min(r.ts for r in readings)
            if self.dirty_since is None or earliest < self.dirty_since:
                self.dirty_since = earliest
        return True

    def is_backlogged(self):
        with self.lock:
            return bool(self.pending)

    # --- maintenance ---------------------------------------------------------

    def rollup(self):
        """Rolls every minute touched since the last rollup into reading_1m. Raises on failure."""
        with self.lock:
            conn = self._ensure()
            if self.dirty_since is None:
                return 0
            since = self.dirty_since.replace(second=0, microsecond=0)
            started = datetime.now(timezone.utc)
            try:
                cur = conn.execute(ROLLUP_SQL, {'since': since})
            except Exception:
                self._reset()
                raise
            # The minute in progress keeps receiving samples - recompute it next time.
            # Late writes (buffer flushes) move dirty_since back on their own.
            self.dirty_since = started.replace(second=0, microsecond=0)
            return cur.rowcount

    def prune(self, retention_days):
        """Deletes raw readings older than `retention_days` (rollups are kept). Raises on failure."""
        with self.lock:
            conn = self._ensure()
            try:
                cur = conn.execute("DELETE FROM reading WHERE ts < now() - make_interval(days => %s)",
                                   (retention_days,))
            except Exception:
                self._reset()
                raise
            return cur.rowcount

    def close(self):
        with self.lock:
            self._flush()
            self._reset()
