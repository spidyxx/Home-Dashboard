# collector.py
#
# Home data collector: polls every configured source (local devices and cloud
# APIs) and stores each reading in the `home` Postgres database. See README.md.
#
#   python collector.py --config config.ini            # run
#   python collector.py --config config.ini --probe    # print what each source reads, store nothing

import os
import sys
import time
import signal
import logging
import argparse
import threading
import configparser
from logging.handlers import TimedRotatingFileHandler

import requests

import notifications
from db import Database
from sources.base import SourceError
from sources.envoy import EnvoySource
from sources.easee import EaseeSource

# config.ini section -> source class. A source runs if its section exists and
# does not say Enabled = false.
SOURCE_TYPES = {
    'ENVOY': EnvoySource,
    'EASEE': EaseeSource,
}

ROLLUP_INTERVAL = 60
PRUNE_INTERVAL = 24 * 3600
# Repeated failures are logged at most this often per source, so a long outage
# does not flood the log with one line per poll.
FAILURE_LOG_INTERVAL = 300

logger = logging.getLogger()


def setup_logging(config, data_dir):
    level = getattr(logging, config.get('LOGGING', 'Level', fallback='INFO').upper(), logging.INFO)
    logger.setLevel(level)
    formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(name)s - %(message)s')
    console = logging.StreamHandler()
    console.setFormatter(formatter)
    logger.addHandler(console)
    file_handler = TimedRotatingFileHandler(os.path.join(data_dir, 'collector.log'), when='midnight',
                                            backupCount=config.getint('LOGGING', 'LogDays', fallback=7))
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)
    # One line per HTTP request at INFO is noise at a 10 s poll interval.
    logging.getLogger('urllib3').setLevel(logging.WARNING)


class Health:
    """
    Tracks failures per component ('envoy', 'easee', 'database', ...) and turns
    a failure that persists for `alert_after` seconds into a Signal alert, with
    a matching recovery message. Short glitches stay in the log only.
    """

    def __init__(self, notifier, alert_after):
        self.notifier = notifier
        self.alert_after = alert_after
        self.failing = {}   # name -> {'since', 'last_logged', 'alerted'}
        self.lock = threading.Lock()

    def ok(self, name):
        with self.lock:
            state = self.failing.pop(name, None)
        if state is None:
            return
        down_for = time.time() - state['since']
        logger.warning("%s recovered after %.0f s.", name, down_for)
        if state['alerted']:
            self.notifier.clear(f'{name}_failing')
            self.notifier.notify(f'{name}_recovered', f"✅ Home collector: {name} recovered",
                                 f"Back to normal after {down_for / 60:.0f} min.")

    def failed(self, name, error, unexpected=False):
        now = time.time()
        with self.lock:
            state = self.failing.setdefault(name, {'since': now, 'last_logged': 0, 'alerted': False})
            log_it = now - state['last_logged'] >= FAILURE_LOG_INTERVAL
            if log_it:
                state['last_logged'] = now
            alert_it = not state['alerted'] and now - state['since'] >= self.alert_after
            if alert_it:
                state['alerted'] = True
            down_for = now - state['since']
        if log_it:
            if unexpected:
                logger.exception("%s failed (failing for %.0f s).", name, down_for)
            else:
                logger.warning("%s failed (failing for %.0f s): %s", name, down_for, error)
        if alert_it:
            self.notifier.notify(f'{name}_failing', f"⚠️ Home collector: {name} failing",
                                 f"No data for {down_for / 60:.0f} min.\nLast error: {error}")


def run_source(source, db, health, stop):
    """Polls one source until stopped. A failed poll is retried at the next interval."""
    while not stop.is_set():
        started = time.time()
        try:
            readings = source.poll()
            health.ok(source.name)
            if db.write(readings):
                health.ok('database')
            else:
                health.failed('database', db.last_error)
        except (SourceError, requests.RequestException) as e:
            health.failed(source.name, e)
        except Exception as e:
            health.failed(source.name, e, unexpected=True)
        stop.wait(max(source.interval() - (time.time() - started), 1))


def run_maintenance(db, health, stop, retention_days, heartbeat_file):
    """Main-thread loop: per-minute rollup, daily raw-data pruning, heartbeat."""
    last_prune = 0
    while not stop.is_set():
        try:
            # Flush anything a source thread left buffered while the DB was away.
            if db.is_backlogged() and db.write([]):
                health.ok('database')
            db.rollup()
            if retention_days > 0 and time.time() - last_prune >= PRUNE_INTERVAL:
                deleted = db.prune(retention_days)
                last_prune = time.time()
                logger.info("Pruned %d raw readings older than %d days.", deleted, retention_days)
            health.ok('database')
        except Exception as e:
            health.failed('database', e)
        try:
            with open(heartbeat_file, 'w') as f:
                f.write(str(int(time.time())))
        except OSError:
            logger.warning("Could not write heartbeat file %s", heartbeat_file)
        stop.wait(ROLLUP_INTERVAL)


def build_sources(config, data_dir):
    sources = []
    for section_name, cls in SOURCE_TYPES.items():
        if config.has_section(section_name) and config.getboolean(section_name, 'Enabled', fallback=True):
            sources.append(cls(config[section_name], data_dir))
    return sources


def probe(sources):
    """Prints raw responses and parsed readings of every source; stores nothing."""
    ok = True
    for source in sources:
        print(f"\n===== {source.name} =====")
        try:
            source.probe()
            print("\nParsed readings:")
            for r in source.poll():
                print(f"  {r.key:28} {r.value:>14,.1f}")
        except Exception as e:
            ok = False
            print(f"FAILED: {e!r}")
    return ok


def main():
    parser = argparse.ArgumentParser(description="Home data collector")
    parser.add_argument('--config', default='config.ini')
    parser.add_argument('--probe', action='store_true',
                        help="poll every source once, print the results, store nothing")
    args = parser.parse_args()

    config = configparser.ConfigParser(interpolation=None)
    if not config.read(args.config):
        sys.exit(f"Config file not found: {args.config}")

    # All runtime state (tokens, logs, heartbeat) lives in the data dir so the
    # code can be redeployed without touching it. The Docker image sets /data.
    data_dir = os.environ.get('COLLECTOR_DATA_DIR') or config.get('GENERAL', 'DataDir', fallback='.')
    os.makedirs(data_dir, exist_ok=True)
    setup_logging(config, data_dir)

    sources = build_sources(config, data_dir)
    if not sources:
        sys.exit("No sources configured - add an [ENVOY] and/or [EASEE] section.")
    if args.probe:
        sys.exit(0 if probe(sources) else 1)

    db = Database(config.get('DATABASE', 'Url'), [s for src in sources for s in src.SENSORS])
    notifier = notifications.Notifier(config)
    health = Health(notifier, config.getint('NOTIFICATIONS', 'AlertAfterMinutes', fallback=15) * 60)
    retention_days = config.getint('STORAGE', 'RawRetentionDays', fallback=0)

    stop = threading.Event()

    def handle_signal(signum, frame):
        logger.warning("Received signal %s, shutting down...", signum)
        stop.set()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    logger.warning("Collector starting with sources: %s", ", ".join(s.name for s in sources))
    threads = [threading.Thread(target=run_source, args=(s, db, health, stop), name=s.name, daemon=True)
               for s in sources]
    for t in threads:
        t.start()

    run_maintenance(db, health, stop, retention_days, os.path.join(data_dir, 'heartbeat'))

    for t in threads:
        t.join(timeout=40)
    try:
        db.write([])
        db.rollup()
    except Exception:
        logger.warning("Final flush/rollup failed - the rollup catches up on the next start.")
    db.close()
    logger.warning("Collector stopped.")
    logging.shutdown()


if __name__ == '__main__':
    main()
