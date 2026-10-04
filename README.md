# Home-Dashboard

One place for everything the house measures, stored in **our own Postgres**
instead of a dozen vendor apps and clouds. It starts with energy: solar
production, grid import/export, house consumption, and car charging.

```
 Enphase Envoy (LAN) ─┐                         ┌──────────────┐
 Easee cloud (read) ──┼─> home-collector ──────>│  Postgres 16 │──> home-dashboard
 … next sources …   ──┘   (Python, polls)       │  db `home`   │    (Next.js, :4010)
                                                └──────────────┘
```

- **collector/**: Python service. Polls each source on its own interval and
  writes every reading to the `home` database. It is read-only towards the
  devices. Charging control stays with
  [Wallbox-Steuerung](../Wallbox-Steuerung), which is untouched.
- **dashboard/**: Next.js app. It uses the same stack as Finance-Tracking and a
  read-only database role.

Everything runs on unRAID next to the existing `postgresql16` container. It is
LAN-only; off-site access goes through WireGuard. The dashboard has no login,
so do not expose it through the proxy.

## Data model

Any measured quantity from any source is a row in `sensor`, and its samples go
to `reading`. A new device never needs a schema change.

| Table | Content |
|---|---|
| `sensor` | `key` (e.g. `envoy.pv_power`), name, unit, kind: `gauge` / `counter` / `state` |
| `reading` | raw samples `(sensor_id, ts, value)`, every 10–120 s |
| `reading_1m` | per-minute avg/min/max/last, maintained by the collector, kept forever |
| `sensor_latest` | view: newest raw value per sensor |

Conventions:
- Power is stored in **W** and energy in **Wh**.
- **Grid power is positive when importing** and negative when exporting.
- Counters are lifetime meter totals. Daily energy is the day-end value minus
  the previous day-end value, so totals stay correct even when the collector
  was down for a while. Gaps only blur the 1-minute power curves.

| Sensor | Source |
|---|---|
| `envoy.pv_power`, `envoy.grid_power` | Envoy CT meters, `/ivp/meters/readings` |
| `envoy.pv_energy`, `envoy.grid_import_energy`, `envoy.grid_export_energy` | same, lifetime counters |
| `easee.power`, `easee.op_mode`, `easee.session_energy`, `easee.lifetime_energy` | Easee observations 120, 109, 121, 124 |

Derived on the dashboard:
- **Consumption** = solar + import − export.
- **Home** = consumption − car.
- **Self-sufficiency** = (solar − export) / consumption.
- **Car solar share**: each minute, the car gets the same solar fraction as the
  whole house, `1 − import / consumption`.

## First deployment

1. **Database.** Open psql as the superuser of the `postgresql16` container
   (`ssh root@192.168.178.70 docker exec -it postgresql16 psql -U postgres`) and run:
   ```sql
   CREATE ROLE home LOGIN PASSWORD '<collector password>';
   CREATE DATABASE home OWNER home;
   CREATE ROLE home_ro LOGIN PASSWORD '<dashboard password>';
   GRANT CONNECT ON DATABASE home TO home_ro;
   \c home
   GRANT USAGE ON SCHEMA public TO home_ro;
   ALTER DEFAULT PRIVILEGES FOR ROLE home IN SCHEMA public GRANT SELECT ON TABLES TO home_ro;
   ```
   The collector creates the tables itself on first start (`collector/migrations/`).

2. **Check the sources from this machine first.** This stores nothing.
   ```bash
   cp collector/config.example.ini collector/config.ini   # fill in; git-ignored
   python3 -m venv .dev/venv && .dev/venv/bin/pip install -r collector/requirements.txt
   .dev/venv/bin/python collector/collector.py --config collector/config.ini --probe
   ```
   It prints the raw Envoy meter list and readings plus the Easee observations.
   The Envoy needs a consumption CT in *net* mode (`net-consumption`); the
   probe says clearly if it finds something else. The Envoy token can be the
   one from Wallbox-Steuerung's `envoy_token.json` (`Token =`), so no Enlighten
   password needs to be stored.

3. **Server config.**
   - `/mnt/cache/appdata/home-dashboard/collector/config.ini`: the same file,
     with `[DATABASE] Url = postgresql://home:…@192.168.178.70:5432/home`.
   - `/mnt/user/appdata/home-dashboard/dashboard.env`: no quotes, because
     docker keeps them literally:
     ```
     DATABASE_URL=postgresql://home_ro:…@192.168.178.70:5432/home
     HOME_TZ=Europe/Berlin
     ```

4. **Deploy:** run `./deploy.sh`. It rsyncs the source, builds both images on
   the server, and restarts the containers. After that, every commit deploys
   what it touched (collector, dashboard, or nothing for docs-only commits) via
   the post-commit hook. The hook is versioned in `scripts/`; install it once per clone:
   `ln -s ../../scripts/post-commit .git/hooks/post-commit`. Afterwards:
   - Dashboard: http://192.168.178.70:4010
   - Logs: `ssh root@192.168.178.70 docker logs -f home-collector`

## Collector behaviour

- **Database outages** (container updates, the nightly appdata backup): readings
  are buffered in memory and written once Postgres is back (tested). The
  rollup recomputes the affected minutes.
- **Source failures** are logged at most every 5 minutes. With `[NOTIFICATIONS]`
  configured, a failure that lasts `AlertAfterMinutes` sends a Signal message
  through the existing Signal-API container, and recovery sends another.
- **Stale Envoy data** (meter timestamp older than `MaxAgeSeconds`) is rejected,
  not stored. This guards against the same frozen-meter problem the wallbox hit
  on 2026-07-03.
- **Easee API load**: polls every 30 s while a car is plugged in, otherwise
  every 120 s. The cloud API is shared with Wallbox-Steuerung.
- **Disk**: about 1–2 GB/year raw, about 0.5 GB/year rollups.
  `[STORAGE] RawRetentionDays` prunes raw samples; rollups are always kept.
- **Health**: a heartbeat file feeds the Docker healthcheck, the same as the
  wallbox.

## Local development

```bash
scripts/dev-stack.sh up        # Postgres (podman), 30 days of simulated history,
                               # fake Envoy + Easee, and the real collector against them
echo "DATABASE_URL=postgresql://home_ro:home_ro@127.0.0.1:55432/home" > dashboard/.env
dashboard/scripts/dev.sh install
dashboard/scripts/dev.sh dev   # http://localhost:3000
scripts/dev-stack.sh down      # stop everything, delete the dev database
```

The simulation (`collector/dev/simulation.py`) models a sun curve with clouds,
household appliances, and a car charged from surplus, so every chart has
realistic data. `dev/seed.py` refuses to write anywhere but localhost.

## Adding a data source

1. Create `collector/sources/<name>.py` with a `Source` subclass. It needs
   `name`, `SENSORS` (keys `<name>.<quantity>`), and `poll()` returning
   `Reading`s. Override `interval()` for adaptive polling, and `probe()` to
   print raw responses.
2. Register it in `SOURCE_TYPES` in `collector.py` and add a `[NAME]` section
   to `config.example.ini`.
3. The sensors register themselves on the next start. Add a dashboard page or
   section that reads them.

Natural next candidates: Shelly plugs/meters (local HTTP), Fritz!Box (TR-064:
bandwidth, devices online), and room climate sensors. When Home Assistant
arrives, it can become one more source (its REST/WebSocket API). Alternatively,
it can read from this database, so the history collected until then is kept.
