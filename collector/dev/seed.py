# dev/seed.py
#
# Fills a LOCAL development database with simulated per-minute history (the same
# simulation fake_devices.py serves live), so the dashboard has days of data to
# show. Refuses to touch anything but localhost.
#
#   python dev/seed.py --db postgresql://home:home@127.0.0.1:55432/home [--days 30]

import argparse
import os
import sys
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

import simulation as sim                      # noqa: E402
from db import Database                       # noqa: E402
from psycopg.types.json import Jsonb          # noqa: E402
from sources.base import Sensor               # noqa: E402
from sources.envoy import EnvoySource         # noqa: E402
from sources.easee import EaseeSource         # noqa: E402
from sources.fritz import FritzSource, slug   # noqa: E402
from simulation import Simulation             # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument('--db', required=True)
parser.add_argument('--days', type=int, default=30)
args = parser.parse_args()

if urlparse(args.db).hostname not in ('localhost', '127.0.0.1'):
    sys.exit("seed.py only writes to a local development database.")

presence = [Sensor(f'fritz.home.{slug(p)}', f'{p} at home', 'bool', 'state') for p in sim.PEOPLE]
db = Database(args.db, EnvoySource.SENSORS + EaseeSource.SENSORS + FritzSource.BASE_SENSORS + presence)
conn = db._ensure()
energy_keys = [s.key for s in EnvoySource.SENSORS + EaseeSource.SENSORS]

# History ends at the start of the current minute; the collector takes over from there.
end = datetime.now(timezone.utc).replace(second=0, microsecond=0)
samples = Simulation(days_back=args.days).advance(end, step=60, collect=True)
start = samples[0]['t'] - timedelta(minutes=1)

with conn.transaction():
    conn.execute("DELETE FROM reading_1m WHERE bucket >= %s", (start,))
    with conn.cursor().copy(
            "COPY reading_1m (sensor_id, bucket, avg, min, max, last, samples) FROM STDIN") as copy:
        for s in samples:
            bucket = s['t'] - timedelta(minutes=1)
            for key in energy_keys:
                v = float(s[key])
                copy.write_row((db.sensor_ids[key], bucket, v, v, v, v, 6))

    # Network: traffic, outage, devices online and presence per minute.
    rx = tx = 0.0
    with conn.cursor().copy(
            "COPY reading_1m (sensor_id, bucket, avg, min, max, last, samples) FROM STDIN") as copy:
        for s in samples:
            bucket = s['t'] - timedelta(minutes=1)
            local = bucket.astimezone(sim.TZ)
            down, up, online, devices = sim.network_minute(local)
            rx += down * 60 / 8
            tx += up * 60 / 8
            values = {'fritz.download_rate': down, 'fritz.upload_rate': up, 'fritz.bytes_received': rx,
                      'fritz.bytes_sent': tx, 'fritz.online': float(online),
                      'fritz.devices_online': devices, 'fritz.devices_wifi': devices - 4}
            for person in sim.PEOPLE:
                values[f'fritz.home.{slug(person)}'] = float(sim.is_home(person, local))
            for key, v in values.items():
                copy.write_row((db.sensor_ids[key], bucket, v, v, v, v, 4))

    # Device inventory, internet status, and a few events.
    now = end
    conn.execute("DELETE FROM entity")
    conn.execute("DELETE FROM event")
    local_now = now.astimezone(sim.TZ)
    for name, interface, owner, suffix in sim.DEVICES:
        active = sim.is_home(owner, local_now) if owner else name not in ('nintendo-switch', 'guest-phone')
        first_seen = now - timedelta(days=3 if name == 'nintendo-switch' else args.days)
        last_seen = now if active else now - timedelta(hours=26)
        conn.execute(
            "INSERT INTO entity VALUES ('network_device', %s, %s, %s, %s, %s)",
            (sim.device_mac(suffix), Jsonb({'name': name, 'ip': f'192.168.178.{int(suffix, 16) + 20}',
                                            'interface': interface, 'active': active,
                                            'speed_mbit': 1000 if interface == 'lan' else 866,
                                            'guest': name == 'guest-phone'}),
             first_seen, last_seen, now))
    conn.execute("INSERT INTO entity VALUES ('internet', 'wan', %s, %s, %s, %s)",
                 (Jsonb({'online': True, 'connection_uptime': 4 * 86400 + 3600, 'ipv4': '203.0.113.42',
                         'ipv6_prefix': '2001:db8:42:100::/56', 'model': 'FRITZ!Box 4050',
                         'firmware': '287.08.25', 'box_uptime': 12 * 86400}), now - timedelta(days=args.days), now, now))
    outage = (local_now - timedelta(days=5)).replace(hour=3, minute=12, second=0, microsecond=0)
    events = [
        (outage, 'offline', "Internet connection lost", {}),
        (outage + timedelta(minutes=12), 'online', "Internet is back after 12 min", {'down_seconds': 720}),
        (outage + timedelta(minutes=13), 'ip_change', "Public IPv4 address changed: 203.0.113.17 → 203.0.113.42", {}),
        (now - timedelta(days=3, hours=4), 'new_device', "New device on the network: nintendo-switch (192.168.178.32, Wi-Fi)",
         {'key': sim.device_mac('0C')}),
        (now - timedelta(days=12), 'firmware', "FRITZ!OS updated: 287.08.21 → 287.08.25", {}),
        (now - timedelta(days=12, minutes=-2), 'restart', "FRITZ!Box restarted", {}),
    ]
    for ts, kind, message, data in events:
        conn.execute("INSERT INTO event (ts, source, kind, message, data) VALUES (%s, 'fritz', %s, %s, %s)",
                     (ts, kind, message, Jsonb(data)))

print(f"Seeded {len(samples):,} minutes ({args.days} days) x {len(db.sensor_ids)} sensors, "
      f"{len(sim.DEVICES)} devices, {len(events)} events.")
