# sources/envoy.py
#
# Enphase IQ Gateway (Envoy) on the LAN: solar production and grid import/export,
# read from the gateway's own CT meters - no Enphase cloud involved at runtime.
#
#   GET /ivp/meters           -> meter list, maps eid -> measurementType
#   GET /ivp/meters/readings  -> per meter: activePower (W) and the lifetime
#                                counters actEnergyDlvd / actEnergyRcvd (Wh)
#
# Production meter: activePower = PV power, actEnergyDlvd = lifetime production.
# Net-consumption meter (CT at the grid connection): activePower > 0 means
# importing, actEnergyDlvd = lifetime import, actEnergyRcvd = lifetime export.
#
# Firmware 7+ requires a JWT for local access. It is valid for about a year and
# is fetched once from Enlighten with the account credentials (same flow as
# Wallbox-Steuerung), or can be pasted into the config as Token.

import base64
import json
import logging
import time

import requests
import urllib3

from sources.base import LOGIN_RETRY_SECONDS, Source, Sensor, SourceError

logger = logging.getLogger(__name__)

# The gateway uses a self-signed certificate.
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

ENLIGHTEN_LOGIN_URL = 'https://enlighten.enphaseenergy.com/login/login.json?'
ENTREZ_TOKEN_URL = 'https://entrez.enphaseenergy.com/tokens'
TOKEN_FILE = 'envoy_token.json'
# Local requests are fast; anything slower means the gateway is struggling.
LOCAL_TIMEOUT = (5, 15)
CLOUD_TIMEOUT = (10, 30)


def jwt_expiry(token):
    """Returns the token's exp claim (unix seconds), or None if it cannot be read."""
    try:
        payload = token.split('.')[1]
        return int(json.loads(base64.urlsafe_b64decode(payload + '==').decode())['exp'])
    except (IndexError, ValueError, KeyError, TypeError):
        return None


class EnvoySource(Source):
    name = 'envoy'
    SENSORS = [
        Sensor('envoy.pv_power', 'Solar production', 'W', 'gauge'),
        Sensor('envoy.grid_power', 'Grid power (+import / -export)', 'W', 'gauge'),
        Sensor('envoy.pv_energy', 'Solar production, lifetime', 'Wh', 'counter'),
        Sensor('envoy.grid_import_energy', 'Grid import, lifetime', 'Wh', 'counter'),
        Sensor('envoy.grid_export_energy', 'Grid export, lifetime', 'Wh', 'counter'),
    ]

    def __init__(self, section, data_dir):
        super().__init__(section, data_dir)
        self.poll_seconds = section.getint('PollSeconds', 10)
        self.url = section.get('Url', '').rstrip('/')
        self.serial = section.get('Serial', '')
        self.username = section.get('Username', '')
        self.password = section.get('Password', '')
        self.configured_token = section.get('Token', '').strip()
        # Readings older than this mean the gateway's meter data is frozen
        # (the 2026-07-03 wallbox incident) - never store them as current.
        self.max_age = section.getint('MaxAgeSeconds', 60)
        if not self.url:
            raise ValueError("[ENVOY] Url is required, e.g. https://192.168.178.x")
        if not self.configured_token and not (self.username and self.password and self.serial):
            raise ValueError("[ENVOY] needs either Token or Username + Password + Serial")
        self.session = requests.Session()
        self.session.verify = False
        self.token = None
        self.token_failed_at = 0
        self.meter_eids = None   # {'production': eid, 'net-consumption': eid}

    # --- auth ------------------------------------------------------------------

    def _get_token(self):
        if self.configured_token:
            return self.configured_token
        cached = self.load_json(TOKEN_FILE)
        if cached.get('token') and cached.get('expires', 0) > time.time() + 86400:
            return cached['token']
        return self._fetch_token()

    def _fetch_token(self):
        """Fetches a fresh local-access token from Enlighten and caches it."""
        wait = self.token_failed_at + LOGIN_RETRY_SECONDS - time.time()
        if wait > 0:
            raise SourceError(f"Envoy token fetch failed recently - next attempt in {wait / 60:.0f} min.")
        try:
            return self._fetch_token_now()
        except Exception:
            self.token_failed_at = time.time()
            raise

    def _fetch_token_now(self):
        logger.info("Fetching a new Envoy token from Enlighten...")
        login = requests.post(ENLIGHTEN_LOGIN_URL, timeout=CLOUD_TIMEOUT,
                              data={'user[email]': self.username, 'user[password]': self.password})
        if login.status_code != 200 or not login.json().get('session_id'):
            raise SourceError(f"Enlighten login failed (HTTP {login.status_code}).")
        resp = requests.post(ENTREZ_TOKEN_URL, timeout=CLOUD_TIMEOUT,
                             json={'session_id': login.json()['session_id'],
                                   'serial_num': self.serial, 'username': self.username})
        token = resp.text.strip()
        if resp.status_code != 200 or not token:
            raise SourceError(f"Envoy token request failed (HTTP {resp.status_code}).")
        expires = jwt_expiry(token) or int(time.time() + 300 * 86400)
        self.save_json(TOKEN_FILE, {'token': token, 'expires': expires})
        logger.info("New Envoy token valid until %s.", time.strftime('%Y-%m-%d', time.localtime(expires)))
        return token

    def _get(self, path):
        """GET a local API path, renewing the token once if the gateway rejects it."""
        if self.token is None:
            self.token = self._get_token()
        for attempt in (1, 2):
            resp = self.session.get(f'{self.url}{path}', timeout=LOCAL_TIMEOUT,
                                    headers={'Authorization': f'Bearer {self.token}'})
            if resp.status_code != 401:
                break
            if self.configured_token:
                raise SourceError("The Envoy rejected the configured Token (HTTP 401) - replace it.")
            if attempt == 1:
                logger.warning("Envoy token rejected - fetching a new one.")
                self.token = self._fetch_token()
        if resp.status_code != 200:
            raise SourceError(f"Envoy {path} returned HTTP {resp.status_code}: {resp.text[:200]}")
        return resp.json()

    # --- meters ----------------------------------------------------------------

    def _discover_meters(self):
        meters = self._get('/ivp/meters')
        eids = {m['measurementType']: m['eid'] for m in meters if m.get('state') == 'enabled'}
        if 'production' not in eids:
            raise SourceError(f"No enabled production meter on the Envoy: {meters}")
        if 'net-consumption' not in eids:
            # A consumption CT in 'total-consumption' mode measures the house
            # load, not the grid connection - import and export cannot be told
            # apart from its counters.
            raise SourceError("No enabled net-consumption meter on the Envoy (found: "
                              f"{sorted(eids)}). Only a consumption CT in net mode is supported.")
        self.meter_eids = eids
        logger.info("Envoy meters: production eid %s, net-consumption eid %s.",
                    eids['production'], eids['net-consumption'])

    def poll(self):
        if self.meter_eids is None:
            self._discover_meters()
        by_eid = {r['eid']: r for r in self._get('/ivp/meters/readings')}
        try:
            prod = by_eid[self.meter_eids['production']]
            net = by_eid[self.meter_eids['net-consumption']]
        except KeyError:
            self.meter_eids = None   # meters changed - rediscover next cycle
            raise SourceError(f"Meter readings missing an expected eid: {sorted(by_eid)}")

        age = time.time() - min(prod['timestamp'], net['timestamp'])
        if age > self.max_age:
            raise SourceError(f"Envoy meter data is stale ({age:.0f}s old).")

        ts = self.now()
        return [
            self.reading('envoy.pv_power', prod['activePower'], ts),
            self.reading('envoy.grid_power', net['activePower'], ts),
            self.reading('envoy.pv_energy', prod['actEnergyDlvd'], ts),
            self.reading('envoy.grid_import_energy', net['actEnergyDlvd'], ts),
            self.reading('envoy.grid_export_energy', net['actEnergyRcvd'], ts),
        ]

    def probe(self):
        print("GET /ivp/meters")
        print(json.dumps(self._get('/ivp/meters'), indent=2))
        print("GET /ivp/meters/readings (channels omitted)")
        readings = self._get('/ivp/meters/readings')
        print(json.dumps([{k: v for k, v in r.items() if k != 'channels'} for r in readings], indent=2))
