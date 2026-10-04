# dev/fake_devices.py
#
# Serves a fake Envoy and a fake Easee API from dev/simulation.py so the
# collector can run end-to-end without touching the real devices. Point a dev
# config at it:  [ENVOY] Url = http://127.0.0.1:8099   [EASEE] ApiUrl = http://127.0.0.1:8099
#
#   python dev/fake_devices.py [--port 8099]

import argparse
import json
import random
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from simulation import Simulation

PRODUCTION_EID, NET_EID, CHARGER_ID = 704643328, 704643584, 'EHFAKE01'

sim = Simulation()
sim.advance(datetime.now(timezone.utc))
lock = threading.Lock()


def current():
    with lock:
        sim.advance(datetime.now(timezone.utc), step=10)
        return sim.snapshot()


def jitter(watts):
    return watts + random.uniform(-15, 15) if watts else 0.0


class Handler(BaseHTTPRequestHandler):
    def _json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        if self.headers.get('Authorization', '').startswith('Bearer '):
            return True
        self._json({'error': 'unauthorized'}, 401)
        return False

    def do_GET(self):
        path = urlparse(self.path).path
        if not self._authorized():
            return
        if path == '/ivp/meters':
            self._json([
                {'eid': PRODUCTION_EID, 'state': 'enabled', 'measurementType': 'production',
                 'phaseMode': 'three', 'phaseCount': 3, 'meteringStatus': 'normal', 'statusFlags': []},
                {'eid': NET_EID, 'state': 'enabled', 'measurementType': 'net-consumption',
                 'phaseMode': 'three', 'phaseCount': 3, 'meteringStatus': 'normal', 'statusFlags': []},
            ])
        elif path == '/ivp/meters/readings':
            s, now = current(), int(datetime.now(timezone.utc).timestamp())
            self._json([
                {'eid': PRODUCTION_EID, 'timestamp': now, 'activePower': jitter(s['envoy.pv_power']),
                 'actEnergyDlvd': s['envoy.pv_energy'], 'actEnergyRcvd': 1234.5, 'channels': []},
                {'eid': NET_EID, 'timestamp': now, 'activePower': jitter(s['envoy.grid_power']),
                 'actEnergyDlvd': s['envoy.grid_import_energy'],
                 'actEnergyRcvd': s['envoy.grid_export_energy'], 'channels': []},
            ])
        elif path == '/api/accounts/chargers':
            self._json([{'id': 1, 'circuits': [{'id': 2, 'chargers': [{'id': CHARGER_ID}]}]}])
        elif path == f'/state/{CHARGER_ID}/observations':
            s, ts = current(), datetime.now(timezone.utc).isoformat()
            self._json({'observations': [
                {'id': 109, 'timestamp': ts, 'dataType': 4, 'value': s['easee.op_mode']},
                {'id': 120, 'timestamp': ts, 'dataType': 3, 'value': s['easee.power'] / 1000},
                {'id': 121, 'timestamp': ts, 'dataType': 3, 'value': s['easee.session_energy'] / 1000},
                {'id': 124, 'timestamp': ts, 'dataType': 3, 'value': s['easee.lifetime_energy'] / 1000},
            ]})
        else:
            self._json({'error': 'not found'}, 404)

    def do_POST(self):
        if urlparse(self.path).path in ('/api/accounts/login', '/api/accounts/refresh_token'):
            self._json({'accessToken': 'fake-access', 'refreshToken': 'fake-refresh', 'expiresIn': 86400})
        else:
            self._json({'error': 'not found'}, 404)

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8099)
    args = parser.parse_args()
    print(f"Fake Envoy + Easee on http://127.0.0.1:{args.port}")
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
