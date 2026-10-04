-- Things a source knows about that are not time series: the devices in the
-- network now, later e.g. smart plugs or Home Assistant entities. Upserted on
-- every poll; `attributes` always holds the latest report.
CREATE TABLE entity (
    kind        text NOT NULL,            -- 'network_device', 'internet', ...
    key         text NOT NULL,            -- stable id within the kind, e.g. a MAC address
    attributes  jsonb NOT NULL DEFAULT '{}',
    first_seen  timestamptz NOT NULL,     -- first reported by its source
    last_seen   timestamptz,              -- last reported as present/active
    updated_at  timestamptz NOT NULL,     -- last reported at all
    PRIMARY KEY (kind, key)
);

-- Things that happened: internet outages, reconnects, IP changes, new devices, ...
CREATE TABLE event (
    id       bigserial PRIMARY KEY,
    ts       timestamptz NOT NULL,
    source   text NOT NULL,
    kind     text NOT NULL,
    message  text NOT NULL,
    data     jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX event_ts ON event (ts);
