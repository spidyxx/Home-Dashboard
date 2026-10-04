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

from db import Database                       # noqa: E402
from sources.envoy import EnvoySource         # noqa: E402
from sources.easee import EaseeSource         # noqa: E402
from simulation import Simulation             # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument('--db', required=True)
parser.add_argument('--days', type=int, default=30)
args = parser.parse_args()

if urlparse(args.db).hostname not in ('localhost', '127.0.0.1'):
    sys.exit("seed.py only writes to a local development database.")

db = Database(args.db, EnvoySource.SENSORS + EaseeSource.SENSORS)
conn = db._ensure()

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
            for key, sensor_id in db.sensor_ids.items():
                v = float(s[key])
                copy.write_row((sensor_id, bucket, v, v, v, v, 6))

print(f"Seeded {len(samples):,} minutes ({args.days} days) x {len(db.sensor_ids)} sensors.")
