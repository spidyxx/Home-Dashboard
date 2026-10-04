# notifications.py (shared with Wallbox-Steuerung)
#
# Proactive alerting so a failure pings the phone instead of sitting silently in
# the log. Uses signal-cli-rest-api (https://github.com/bbernhard/signal-cli-rest-api),
# a small self-hosted container that talks to Signal - no third-party cloud, no
# extra phone app beyond the Signal the user already has.

import time
import logging
import threading

import requests

logger = logging.getLogger(__name__)


class Notifier:
    """
    Fire-and-forget Signal notifier with per-key rate limiting.

    Reads a [NOTIFICATIONS] section from the config; if it is absent, disabled,
    or incomplete the notifier degrades to a silent no-op so the service runs
    exactly as before. notify() never raises and (unless blocking=True) never
    blocks the polling loop - sends run on a short-lived daemon thread.
    """

    def __init__(self, config):
        self.enabled = config.getboolean('NOTIFICATIONS', 'Enabled', fallback=False)
        self.api_url = config.get('NOTIFICATIONS', 'ApiUrl', fallback='').rstrip('/')
        self.sender = config.get('NOTIFICATIONS', 'Sender', fallback='').strip()
        recipients = config.get('NOTIFICATIONS', 'Recipients', fallback='')
        self.recipients = [r.strip() for r in recipients.split(',') if r.strip()]
        # One alert per key per cooldown window, so an ongoing outage pings once
        # every N minutes instead of every control cycle.
        self.cooldown = config.getint('NOTIFICATIONS', 'CooldownMinutes', fallback=30) * 60
        self.timeout = config.getint('NOTIFICATIONS', 'TimeoutSeconds', fallback=10)

        self._last_sent = {}
        self._lock = threading.Lock()

        if self.enabled and not (self.api_url and self.sender and self.recipients):
            logger.warning("Notifications enabled but ApiUrl/Sender/Recipients are incomplete "
                           "- notifications disabled.")
            self.enabled = False
        if self.enabled:
            logger.info("Signal notifications enabled (%s -> %d recipient(s)).",
                        self.api_url, len(self.recipients))

    def notify(self, key, title, message="", blocking=False):
        """
        Send a notification identified by `key`, rate-limited per key.

        blocking=True sends synchronously (with the configured timeout) - use it
        right before an exit so the message is actually delivered before the
        process dies. Never raises.
        """
        if not self.enabled:
            return
        now = time.time()
        with self._lock:
            if now - self._last_sent.get(key, 0) < self.cooldown:
                logger.debug("Notification '%s' suppressed (within cooldown).", key)
                return
            self._last_sent[key] = now

        text = f"{title}\n{message}" if message else title
        if blocking:
            self._send(text)
        else:
            threading.Thread(target=self._send, args=(text,), name="notify", daemon=True).start()

    def clear(self, key):
        """Forget a key's last-sent time so the next alert for it fires immediately.
        Used on recovery, so a fresh occurrence of the same condition is not swallowed
        by the cooldown from the previous one."""
        with self._lock:
            self._last_sent.pop(key, None)

    def _send(self, text):
        try:
            response = requests.post(
                f"{self.api_url}/v2/send",
                json={"message": text, "number": self.sender, "recipients": self.recipients},
                timeout=self.timeout,
            )
            if response.status_code >= 300:
                logger.error("Signal notification failed: HTTP %s - %s",
                             response.status_code, response.text[:200])
            else:
                logger.info("Signal notification sent: %s", text.splitlines()[0])
        except Exception:
            logger.exception("Signal notification could not be sent.")
