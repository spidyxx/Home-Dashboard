# dev/simulation.py
#
# A deterministic stand-in for the house: solar production, household load and
# a PV-surplus-charged car. Used by fake_devices.py (live API) and seed.py
# (history), so both agree on the lifetime counters. Development only.

import math
import random
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

TZ = ZoneInfo('Europe/Berlin')
KWP = 8000


def _rng(*key):
    # Tuples of ints hash deterministically across runs (unlike strings).
    return random.Random(hash(key))


class Simulation:
    def __init__(self, days_back=30, now=None):
        now = now or datetime.now(timezone.utc)
        # Anchored to local midnight so every run on the same day follows the same path.
        start = (now.astimezone(TZ) - timedelta(days=days_back)).replace(
            hour=0, minute=0, second=0, microsecond=0)
        self.t = start.astimezone(timezone.utc)
        self.pv_energy = 41_250_000.0
        self.import_energy = 18_400_000.0
        self.export_energy = 27_900_000.0
        self.car_energy = 9_870_000.0
        self.session_energy = 0.0
        self.op_mode = 1
        self.power = {'pv': 0.0, 'house': 0.0, 'car': 0.0, 'grid': 0.0}

    @staticmethod
    def _hour(local):
        return local.hour + local.minute / 60 + local.second / 3600

    def _pv(self, local):
        season = math.cos(2 * math.pi * (local.timetuple().tm_yday - 172) / 365)
        half_day = 6.1 + 2.3 * season
        hour = self._hour(local)
        x = (hour - (13.3 - half_day)) / (2 * half_day)
        if not 0 < x < 1:
            return 0.0
        day = local.toordinal()
        clear = _rng(day).uniform(0.3, 1.0)
        r = _rng(day, 1)
        wobble = sum(math.sin(hour * f + r.uniform(0, 6.28)) for f in (1.7, 4.3, 11.9)) / 3
        cloud = 1 - (1 - clear) * (0.5 + 0.5 * wobble)
        return KWP * (0.62 + 0.3 * season) * math.sin(math.pi * x) ** 1.3 * cloud

    def _house(self, local):
        hour = self._hour(local)
        load = 230 + 260 * math.exp(-((hour - 19.5) / 2) ** 2) + 150 * math.exp(-((hour - 7.3) / 1.0) ** 2)
        r = _rng(local.toordinal(), local.hour, 2)
        if r.random() < 0.3:   # an appliance runs during this hour
            start, duration, watts = r.uniform(0, 45), r.uniform(8, 40), r.choice((800, 1600, 2200))
            if start <= local.minute < start + duration:
                load += watts
        return load

    def _car(self, local, surplus):
        """Car plugged in on some days, charged from PV surplus like Wallbox-Steuerung does."""
        r = _rng(local.toordinal(), 3)
        plugged, plug_at, unplug_at, target = r.random() < 0.5, r.uniform(8, 11), r.uniform(16, 19), r.uniform(8000, 24000)
        if not (plugged and plug_at <= self._hour(local) < unplug_at):
            self.op_mode = 1
            return 0.0
        if self.op_mode == 1:          # just plugged in: new session
            self.session_energy = 0.0
            self.op_mode = 2
        if self.op_mode == 4 or self.session_energy >= target:
            self.op_mode = 4
            return 0.0
        usable = surplus - 100
        if usable < 6 * 230:
            self.op_mode = 2
            return 0.0
        phases = 3 if usable >= 6 * 690 else 1
        amps = max(6, min(16, int(usable // (230 * phases))))
        self.op_mode = 3
        return amps * 230 * phases

    def advance(self, to, step=60.0, collect=False):
        """Steps the house forward to `to`; returns per-step snapshots if collect=True."""
        samples = []
        while self.t < to:
            dt = min(step, (to - self.t).total_seconds())
            self.t += timedelta(seconds=dt)
            local = self.t.astimezone(TZ)
            pv, house = self._pv(local), self._house(local)
            car = self._car(local, pv - house)
            grid = house + car - pv
            hours = dt / 3600
            self.pv_energy += pv * hours
            if grid > 0:
                self.import_energy += grid * hours
            else:
                self.export_energy -= grid * hours
            self.car_energy += car * hours
            self.session_energy += car * hours
            self.power = {'pv': pv, 'house': house, 'car': car, 'grid': grid}
            if collect:
                samples.append(self.snapshot())
        return samples

    def snapshot(self):
        return {
            't': self.t,
            'envoy.pv_power': self.power['pv'],
            'envoy.grid_power': self.power['grid'],
            'envoy.pv_energy': self.pv_energy,
            'envoy.grid_import_energy': self.import_energy,
            'envoy.grid_export_energy': self.export_energy,
            'easee.power': self.power['car'],
            'easee.op_mode': self.op_mode,
            'easee.session_energy': self.session_energy,
            'easee.lifetime_energy': self.car_energy,
        }


# --- network (FRITZ!Box) -------------------------------------------------------

PEOPLE = ('Alex', 'Sam')
DEVICES = [  # name, interface, owner (for presence), MAC suffix
    ('alex-iphone', 'wifi', 'Alex', '01'), ('sam-pixel', 'wifi', 'Sam', '02'),
    ('macbook-pro', 'wifi', None, '03'), ('LG-webOS-TV', 'lan', None, '04'),
    ('unraid', 'lan', None, '05'), ('envoy', 'lan', None, '06'),
    ('Easee-EHFAKE01', 'wifi', None, '07'), ('bazzite', 'lan', None, '08'),
    ('sonos-kitchen', 'wifi', None, '09'), ('HP-LaserJet', 'wifi', None, '0A'),
    ('ipad', 'wifi', None, '0B'), ('nintendo-switch', 'wifi', None, '0C'),
    ('guest-phone', 'wifi', None, '0D'),
]


def device_mac(suffix):
    return f'DE:AD:BE:EF:00:{suffix}'


def is_home(person, local):
    """Alex works away on weekdays; Sam is out some mornings."""
    hour, weekday, day = local.hour + local.minute / 60, local.weekday(), local.toordinal()
    if person == 'Alex':
        return not (weekday < 5 and 7.75 <= hour < 17.5)
    return not (_rng(day, 7).random() < 0.5 and 9 <= hour < 12.5)


def network_minute(local):
    """Download/upload rate (bit/s), online flag, devices online at this local minute."""
    hour, day = local.hour + local.minute / 60, local.toordinal()
    # One outage five days ago, 03:12-03:24.
    online = not (day == datetime.now(TZ).toordinal() - 5 and 3.2 <= hour < 3.4)
    r = _rng(day, local.hour, local.minute // 10, 5)
    down = 0.3e6 + r.uniform(0, 0.4e6)
    if 19 <= hour < 23:
        down += r.uniform(12e6, 28e6)                     # evening streaming
    elif 8 <= hour < 18 and local.weekday() < 5 and r.random() < 0.4:
        down += r.uniform(2e6, 6e6)                       # video calls
    if _rng(day, 6).random() < 0.25 and 21 <= hour < 21.25:
        down += 280e6                                     # a big game update
    up = down * 0.08 + r.uniform(0.05e6, 0.3e6)
    home = sum(is_home(p, local) for p in PEOPLE)
    devices = 7 + 2 * home + (3 if 18 <= hour < 23 else 0)
    if not online:
        down = up = 0.0
    return down, up, online, devices
