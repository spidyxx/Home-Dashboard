# sources/easee.py
#
# Easee wallbox via the Easee cloud API - read-only. Charging control stays with
# Wallbox-Steuerung; this source never sends commands to the charger.
#
# Uses the Observations endpoint (the old /api/chargers/{id}/state was removed
# on 2026-09-01), ids per https://developer.easee.com/docs/charger-observation-ids

import json
import logging
import time

import requests

from sources.base import LOGIN_RETRY_SECONDS, Source, Sensor, SourceError

logger = logging.getLogger(__name__)

TOKEN_FILE = 'easee_token.json'
TIMEOUT = (10, 30)

# observation id -> (sensor key, factor to our units)
OBSERVATIONS = {
    109: ('easee.op_mode', 1),             # ChargerOpMode enum (OP_MODES)
    120: ('easee.power', 1000),            # TotalPower, kW -> W
    121: ('easee.session_energy', 1000),   # SessionEnergy, kWh -> Wh
    124: ('easee.lifetime_energy', 1000),  # LifetimeEnergy, kWh -> Wh
}

OP_MODES = {0: 'Offline', 1: 'Disconnected', 2: 'Awaiting start', 3: 'Charging',
            4: 'Completed', 5: 'Error', 6: 'Ready to charge',
            7: 'Awaiting authorization', 8: 'De-authorizing'}
# A car is plugged in and may start drawing power any moment.
ACTIVE_OP_MODES = (2, 3, 6)


class EaseeSource(Source):
    name = 'easee'
    SENSORS = [
        Sensor('easee.power', 'Wallbox charging power', 'W', 'gauge'),
        Sensor('easee.op_mode', 'Wallbox state', 'enum', 'state'),
        # Resets with every new session, so it is a gauge, not a counter.
        Sensor('easee.session_energy', 'Wallbox session energy', 'Wh', 'gauge'),
        Sensor('easee.lifetime_energy', 'Wallbox energy, lifetime', 'Wh', 'counter'),
    ]

    def __init__(self, section, data_dir):
        super().__init__(section, data_dir)
        # The cloud API is rate-limited and shared with Wallbox-Steuerung: poll
        # often only while a car is plugged in.
        self.poll_active = section.getint('PollSecondsActive', 30)
        self.poll_idle = section.getint('PollSecondsIdle', 120)
        self.api_url = section.get('ApiUrl', 'https://api.easee.com').rstrip('/')
        self.username = section.get('Username', '')
        self.password = section.get('Password', '')
        self.charger_id = section.get('ChargerId', '').strip() or None
        if not (self.username and self.password):
            raise ValueError("[EASEE] Username and Password are required")
        self.tokens = None
        self.login_failed_at = 0
        self.op_mode = None

    def interval(self):
        return self.poll_active if self.op_mode in ACTIVE_OP_MODES else self.poll_idle

    # --- auth ------------------------------------------------------------------

    def _store_tokens(self, data):
        self.tokens = {'access': data['accessToken'], 'refresh': data['refreshToken'],
                       'expires': time.time() + data['expiresIn']}
        self.save_json(TOKEN_FILE, self.tokens)

    def _login(self):
        wait = self.login_failed_at + LOGIN_RETRY_SECONDS - time.time()
        if wait > 0:
            raise SourceError(f"Easee login failed recently - next attempt in {wait / 60:.0f} min.")
        logger.info("Logging in to the Easee API...")
        try:
            resp = requests.post(f'{self.api_url}/api/accounts/login', timeout=TIMEOUT,
                                 json={'userName': self.username, 'password': self.password})
        except requests.RequestException:
            self.login_failed_at = time.time()
            raise
        if resp.status_code != 200:
            self.login_failed_at = time.time()
            raise SourceError(f"Easee login failed (HTTP {resp.status_code}).")
        self._store_tokens(resp.json())

    def _refresh(self):
        """Refreshes the access token, falling back to a full login."""
        try:
            resp = requests.post(f'{self.api_url}/api/accounts/refresh_token', timeout=TIMEOUT,
                                 headers={'Authorization': f"Bearer {self.tokens['access']}"},
                                 json={'refreshToken': self.tokens['refresh']})
            if resp.status_code == 200:
                self._store_tokens(resp.json())
                return
            logger.warning("Easee token refresh returned HTTP %s - logging in again.", resp.status_code)
        except requests.RequestException as e:
            logger.warning("Easee token refresh failed (%s) - logging in again.", e)
        self._login()

    def _get(self, path, params=None):
        if self.tokens is None:
            cached = self.load_json(TOKEN_FILE)
            if cached.get('access') and cached.get('refresh'):
                self.tokens = cached
            else:
                self._login()
        if self.tokens['expires'] < time.time() + 60:
            self._refresh()
        url = f'{self.api_url}{path}'
        for attempt in (1, 2):
            resp = requests.get(url, params=params, timeout=TIMEOUT,
                                headers={'Authorization': f"Bearer {self.tokens['access']}",
                                         'Accept': 'application/json'})
            if resp.status_code != 401 or attempt == 2:
                break
            self._refresh()
        if resp.status_code in (404, 410):
            # Easee removes endpoints without notice (see Wallbox-Steuerung README).
            raise SourceError(f"Easee endpoint {path} returned HTTP {resp.status_code} - "
                              "it appears to have been removed; the source needs an update.")
        if resp.status_code != 200:
            raise SourceError(f"Easee {path} returned HTTP {resp.status_code}: {resp.text[:200]}")
        return resp.json()

    # --- polling ---------------------------------------------------------------

    def _discover_charger(self):
        sites = self._get('/api/accounts/chargers')
        try:
            self.charger_id = sites[0]['circuits'][0]['chargers'][0]['id']
        except (IndexError, KeyError, TypeError):
            raise SourceError(f"No charger found in the Easee account: {str(sites)[:300]}")
        logger.info("Easee charger: %s", self.charger_id)

    def _observations(self):
        data = self._get(f'/state/{self.charger_id}/observations',
                         params={'ids': ','.join(str(i) for i in OBSERVATIONS)})
        # Either {"observations": [...]} or a bare list of {id, timestamp, dataType, value}.
        items = data.get('observations', []) if isinstance(data, dict) else data
        return {int(o['id']): o['value'] for o in items}

    def poll(self):
        if self.charger_id is None:
            self._discover_charger()
        values = self._observations()
        if 109 not in values:
            raise SourceError(f"Easee observations missing the op mode: {values}")
        self.op_mode = int(values[109])
        ts = self.now()
        return [self.reading(key, float(values[obs_id]) * factor, ts)
                for obs_id, (key, factor) in OBSERVATIONS.items() if obs_id in values]

    def probe(self):
        if self.charger_id is None:
            self._discover_charger()
        values = self._observations()
        print(f"GET /state/{self.charger_id}/observations")
        print(json.dumps(values, indent=2))
        if 109 in values:
            print(f"Op mode {values[109]}: {OP_MODES.get(int(values[109]), 'unknown')}")
