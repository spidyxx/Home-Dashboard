-- Generic time-series storage for every device in the house.
--
-- Every measured quantity from any source (Envoy, Easee, later Shelly, Fritz!Box,
-- Home Assistant, ...) is a row in `sensor`; its samples go to `reading`. Adding a
-- device never needs a schema change - a new source just registers new sensors.
--
-- Conventions: power in W, energy in Wh, grid power positive = import from the
-- grid / negative = export. Counters are lifetime totals that only grow; daily
-- energy is the difference between day-end values.

CREATE TABLE sensor (
    id          serial PRIMARY KEY,
    key         text NOT NULL UNIQUE,     -- stable id, e.g. 'envoy.pv_power'
    source      text NOT NULL,            -- 'envoy', 'easee', ...
    name        text NOT NULL,            -- human-readable label
    unit        text NOT NULL,            -- 'W', 'Wh', 'enum', ...
    kind        text NOT NULL CHECK (kind IN ('gauge', 'counter', 'state')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Raw samples as polled (every ~10-120 s depending on the source).
CREATE TABLE reading (
    sensor_id  integer NOT NULL REFERENCES sensor (id),
    ts         timestamptz NOT NULL,
    value      double precision NOT NULL,
    PRIMARY KEY (sensor_id, ts)
);
-- Rollups and retention scan by time across all sensors. Rows arrive in time
-- order, so a BRIN index covers that for a few KB instead of a full B-tree.
CREATE INDEX reading_ts_brin ON reading USING brin (ts);

-- Per-minute rollup of `reading`, maintained by the collector and kept forever
-- (also when raw retention is enabled). Charts and energy totals read from here.
CREATE TABLE reading_1m (
    sensor_id  integer NOT NULL REFERENCES sensor (id),
    bucket     timestamptz NOT NULL,      -- start of the minute
    avg        double precision NOT NULL,
    min        double precision NOT NULL,
    max        double precision NOT NULL,
    last       double precision NOT NULL,
    samples    integer NOT NULL,
    PRIMARY KEY (sensor_id, bucket)
);

-- Most recent raw value of every sensor (one index probe per sensor).
CREATE VIEW sensor_latest AS
SELECT s.id AS sensor_id, s.key, s.name, s.unit, s.kind, r.ts, r.value
FROM sensor s
CROSS JOIN LATERAL (
    SELECT ts, value FROM reading
    WHERE sensor_id = s.id
    ORDER BY ts DESC
    LIMIT 1
) r;
