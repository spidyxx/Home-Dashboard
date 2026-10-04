# sources/base.py
#
# The contract every data source implements. A source knows how to talk to one
# device or service and turns what it reads into Readings of its own Sensors;
# the collector takes care of scheduling, storage, and alerting.

import json
import os
from collections import namedtuple
from datetime import datetime, timezone

# key: '<source>.<quantity>', e.g. 'envoy.pv_power'. Units: W, Wh, enum, ...
# kind: 'gauge' (instantaneous), 'counter' (ever-growing total), 'state' (enum).
Sensor = namedtuple('Sensor', 'key name unit kind')
Reading = namedtuple('Reading', 'key ts value')


class SourceError(Exception):
    """The source could not deliver trustworthy readings this cycle."""


# After a failed cloud login, wait this long before trying again: retrying on
# every poll with bad credentials would hammer the vendor and can lock the account.
LOGIN_RETRY_SECONDS = 600


class Source:
    """
    Base class for a data source, configured from its own config.ini section.

    Subclasses define `name` and `SENSORS` and implement poll(); they may
    override interval() to poll faster while something interesting happens.
    """

    name = None
    SENSORS = []

    def __init__(self, section, data_dir):
        self.section = section
        self.data_dir = data_dir
        self.poll_seconds = section.getint('PollSeconds', 30)

    def interval(self):
        """Seconds until the next poll."""
        return self.poll_seconds

    def poll(self):
        """Returns a list of Readings. Raises SourceError (or anything) on failure."""
        raise NotImplementedError

    def probe(self):
        """Prints raw device responses for setup checks (collector --probe)."""

    @staticmethod
    def now():
        return datetime.now(timezone.utc)

    def reading(self, key, value, ts=None):
        return Reading(key, ts or self.now(), float(value))

    # --- token cache helpers (tokens live in the data dir, never in git) ------

    def load_json(self, filename):
        path = os.path.join(self.data_dir, filename)
        try:
            with open(path) as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    def save_json(self, filename, data):
        path = os.path.join(self.data_dir, filename)
        with open(path, 'w') as f:
            json.dump(data, f)
        os.chmod(path, 0o600)
