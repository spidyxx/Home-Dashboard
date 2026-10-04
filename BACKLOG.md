# Backlog

What's planned, roughly in order. Done items move to the git history.

## Next up

- **UI rework.** More visual than the current grey boxes, designed for wall
  touchscreens first: big touch targets, no mouse-over-only details, landscape
  wall layout, dark at night. Start from design directions to choose from;
  bring examples of dashboards/apps you like.
- **Settings and options.** Collect what should be changeable from the
  dashboard instead of `config.ini` (presence, alerts, intervals, ...). Needs a
  write path - the dashboard's database role is read-only today.
- **Per-device online history.** Which device was online when, shown on the
  Network page. Today only the device *count* is stored, so "which devices
  left at 15:18 and 15:33" (2026-10-04) could not be answered.
- **First control: wallbox charging mode.** Switch between solar-automatic and
  manual charging from the dashboard. Comes with a login, one shared command
  path for dashboard/panels/voice, and an audit log. Wallbox-Steuerung must
  stop regulating in manual mode without pausing the charger - change and test
  it carefully.

## Later

- **VPN clients.** Show WireGuard peers (FRITZ!Box host entries without a MAC,
  192.168.178.201-203) as "connected via VPN".
- **Viessmann heating** as a data source (on the guest Wi-Fi as `Viessmann-4243`).
- **Secure smart-home network.** Plan firewall/VLANs (the FRITZ!Box can't) and
  the device protocol (Zigbee/Thread vs. Wi-Fi) before buying devices.
- **Local voice assistant.** Ollama + speech-to-text/text-to-speech + room
  satellites; a home MCP server exposing data and allowed commands. Decide
  build vs. Home Assistant.
- **Wall touchscreens** in kiosk mode.

## Open questions / housekeeping

- **Unknown wired device** `B8:A0:FE:FE:B8:88` in the living room (since
  2026-10-04 16:33, no IP, no traffic). Suspect: the Blu-ray player - unplug
  its network cable and watch the Network page.
- **Postgres collation mismatch** on the `postgres` and `wikidb` databases of
  the `postgresql16` container (glibc 2.36 → 2.41 after an image update):
  reindex and `ALTER DATABASE ... REFRESH COLLATION VERSION`. `home` and
  `finance` are not affected.
