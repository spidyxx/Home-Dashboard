# sources/fritz.py
#
# FRITZ!Box via TR-064 on the LAN. Needs "Zugriff für Anwendungen zulassen"
# (Heimnetz > Netzwerk > Netzwerkeinstellungen) and a FRITZ!Box user with the
# "FRITZ!Box Einstellungen" right.
#
# Every PollSeconds: internet traffic (64-bit byte counters -> volume and
# average rates) and whether the internet connection is up.
# Every DevicePollSeconds: the device list (-> device inventory, devices
# online, who's home) combined with the mesh map (which box each device is
# connected to, band, link rate), public IPs, and the box's own uptime/firmware.
# Changes become events: outages, reconnects, IP changes, restarts, firmware
# updates, and devices the network has never seen before.

import logging
import re
import time

from fritzconnection import FritzConnection
from fritzconnection.core.exceptions import FritzAuthorizationError, FritzConnectionException
from fritzconnection.lib.fritzhosts import FritzHosts

from sources.base import LOGIN_RETRY_SECONDS, Entity, Sensor, Source, SourceError

logger = logging.getLogger(__name__)

# Counters, last known IPs, known devices, ... - survives restarts so nothing
# that happened while the collector was down is mistaken for something new.
STATE_FILE = 'fritz_state.json'
# A longer gap between two polls says nothing about the current rate.
MAX_RATE_GAP = 300
INTERFACES = {'802.11': 'wifi', 'Ethernet': 'lan'}


def slug(name):
    return re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_')


def parse_presence(value):
    """'Alex=AA:BB:..., Alex=CC:DD:..., Sam=EE:FF:...' -> {'Alex': {'AA:BB:..', 'CC:DD:..'}, 'Sam': {...}}"""
    people = {}
    for pair in filter(None, (p.strip() for p in value.split(','))):
        name, sep, mac = pair.partition('=')
        if not sep or not name.strip() or not mac.strip():
            raise ValueError(f"[FRITZ] Presence entry '{pair}' is not Name=MAC")
        people.setdefault(name.strip(), set()).add(mac.strip().upper())
    return people


def is_box_itself(host, address):
    """The FRITZ!Box lists itself among its hosts - not a device on the network."""
    return host.get('IPAddress') == address or (host.get('HostName') or '').lower() == 'fritz.box'


def band(interface_name):
    """Mesh access-point interface name ('AP:5G:0', 'AP_GUEST:2G:0') -> band."""
    for tag, label in (('2G', '2.4 GHz'), ('5G', '5 GHz'), ('6G', '6 GHz')):
        if f':{tag}:' in interface_name:
            return label
    return ''


def parse_mesh(mesh):
    """
    The FRITZ! mesh map -> ({client MAC: link}, {mesh box MAC: {'name', 'role'}}).

    A link says which mesh box the client hangs on ('via'), the Wi-Fi band and
    the current link rate. A client can show several connected links (e.g.
    after roaming); the fastest one is the live one.
    """
    nodes = {n['uid']: n for n in mesh.get('nodes', [])}
    meshed = {uid for uid, n in nodes.items() if n.get('is_meshed')}
    interface_names = {i['uid']: i.get('name', '') for n in nodes.values() for i in n.get('node_interfaces', [])}
    links, boxes = {}, {}
    for uid, node in nodes.items():
        mac = (node.get('device_mac_address') or '').upper()
        if uid in meshed:
            boxes[mac] = {'name': node.get('device_name', ''), 'role': node.get('mesh_role', '')}
            continue
        for interface in node.get('node_interfaces', []):
            for link in interface.get('node_links', []):
                if link.get('state') != 'CONNECTED':
                    continue
                mine = link.get('node_1_uid') == uid
                peer = link.get('node_2_uid') if mine else link.get('node_1_uid')
                if peer not in meshed:
                    continue
                peer_interface = link.get('node_interface_2_uid') if mine else link.get('node_interface_1_uid')
                rate = max(link.get('cur_data_rate_rx') or 0, link.get('cur_data_rate_tx') or 0) / 1000
                if mac not in links or rate > links[mac]['link_mbit']:
                    links[mac] = {'via': nodes[peer].get('device_name', ''),
                                  'band': band(interface_names.get(peer_interface, '')),
                                  'link_mbit': round(rate)}
    return links, boxes


def correct_wired_links(hosts, links, boxes):
    """
    The mesh map can place a wired device behind a repeater that it is not
    behind (2026-10-04: a device on the main box's LAN 2 was attributed to the
    repeater's uplink port). The host list's X_AVM-DE_Port - the main box's
    port where a device's traffic arrives - settles it: everything behind a
    repeater arrives on the same port as the repeater itself.
    """
    master = next((b['name'] for b in boxes.values() if b['role'] == 'master'), None)
    repeater_ports = {}
    for host in hosts:
        box = boxes.get((host.get('MACAddress') or '').upper())
        if box and box['role'] == 'slave':
            repeater_ports[box['name']] = host.get('X_AVM-DE_Port')
    for host in hosts:
        mac = (host.get('MACAddress') or '').upper()
        link = links.get(mac)
        if not (master and link and host.get('InterfaceType') == 'Ethernet'):
            continue
        port, repeater_port = host.get('X_AVM-DE_Port'), repeater_ports.get(link['via'])
        if port and repeater_port and port != repeater_port:
            links[mac] = {**link, 'via': master}
    return links


def read_mesh(fritz_hosts, hosts):
    """Mesh links (corrected) and mesh boxes; empty if the box has no mesh map to offer."""
    try:
        links, boxes = parse_mesh(fritz_hosts.get_mesh_topology())
    except Exception as e:
        # The mesh map only adds detail - without it the device list still works.
        logger.debug("FRITZ!Box mesh map unavailable: %s", e)
        return {}, {}
    return correct_wired_links(hosts, links, boxes), boxes


def duration(seconds):
    minutes = round(seconds / 60)
    return f"{minutes} min" if minutes < 120 else f"{minutes / 60:.1f} h"


class FritzSource(Source):
    name = 'fritz'
    BASE_SENSORS = [
        Sensor('fritz.download_rate', 'Internet download rate', 'bit/s', 'gauge'),
        Sensor('fritz.upload_rate', 'Internet upload rate', 'bit/s', 'gauge'),
        # Made monotonic across FRITZ!Box restarts (which reset its counters).
        Sensor('fritz.bytes_received', 'Internet download volume, total', 'B', 'counter'),
        Sensor('fritz.bytes_sent', 'Internet upload volume, total', 'B', 'counter'),
        Sensor('fritz.online', 'Internet connected', 'bool', 'state'),
        Sensor('fritz.devices_online', 'Devices online', 'count', 'gauge'),
        Sensor('fritz.devices_wifi', 'Devices online via Wi-Fi', 'count', 'gauge'),
    ]

    def __init__(self, section, data_dir):
        super().__init__(section, data_dir)
        self.poll_seconds = section.getint('PollSeconds', 15)
        self.device_poll_seconds = section.getint('DevicePollSeconds', 60)
        self.address = section.get('Address', '192.168.178.1')
        self.username = section.get('Username', '')
        self.password = section.get('Password', '')
        if not (self.username and self.password):
            raise ValueError("[FRITZ] Username and Password are required")
        # Phones drop off Wi-Fi while asleep; only call someone away after this long.
        self.away_after = section.getint('AwayAfterMinutes', 10) * 60
        self.notify_new_devices = section.getboolean('NotifyNewDevices', True)
        self.people = parse_presence(section.get('Presence', ''))
        self.SENSORS = self.BASE_SENSORS + [
            Sensor(f'fritz.home.{slug(person)}', f'{person} at home', 'bool', 'state') for person in self.people]

        self.fc = None
        self.connection_service = None
        self.auth_failed_at = 0
        self.last_traffic = None      # (time, rx, tx) of the previous poll, for rates
        self.last_device_poll = 0
        self.state = self.load_json(STATE_FILE)

    # --- connection ------------------------------------------------------------

    def _connect(self):
        if self.fc is not None:
            return
        fc = FritzConnection(address=self.address, user=self.username, password=self.password,
                             timeout=10, use_cache=True, cache_directory=self.data_dir)
        # PPPoE and IP-based internet access live in different services.
        default = fc.call_action('Layer3Forwarding1', 'GetDefaultConnectionService')['NewDefaultConnectionService']
        self.connection_service = 'WANPPPConnection1' if 'WANPPPConnection' in default else 'WANIPConn1'
        self.fc = fc
        logger.info("Connected to %s (internet via %s).", self.address, self.connection_service)

    def poll(self):
        wait = self.auth_failed_at + LOGIN_RETRY_SECONDS - time.time()
        if wait > 0:
            raise SourceError(f"FRITZ!Box login failed recently - next attempt in {wait / 60:.0f} min.")
        try:
            self._connect()
            items = self._poll_traffic()
            if time.time() - self.last_device_poll >= self.device_poll_seconds:
                items += self._poll_devices()
                self.last_device_poll = time.time()
        except FritzAuthorizationError:
            self.auth_failed_at = time.time()
            raise SourceError("FRITZ!Box rejected the login - check Username/Password and that the "
                              "user has the 'FRITZ!Box Einstellungen' right.")
        except FritzConnectionException as e:
            raise SourceError(f"FRITZ!Box: {e}")
        finally:
            self.save_json(STATE_FILE, self.state)
        return items

    # --- traffic and connection (every poll) -----------------------------------

    def _monotonic(self, name, raw):
        """Raw FRITZ!Box counter -> ever-growing total; a drop means the box reset its counters."""
        counter = self.state.setdefault('counters', {}).setdefault(name, {'raw': raw, 'offset': 0})
        if raw < counter['raw']:
            counter['offset'] += counter['raw']
        counter['raw'] = raw
        return raw + counter['offset']

    def _poll_traffic(self):
        ts, now = self.now(), time.time()
        addon = self.fc.call_action('WANCommonIFC1', 'GetAddonInfos')
        rx = int(addon['NewX_AVM_DE_TotalBytesReceived64'])
        tx = int(addon['NewX_AVM_DE_TotalBytesSent64'])
        items = [
            self.reading('fritz.bytes_received', self._monotonic('rx', rx), ts),
            self.reading('fritz.bytes_sent', self._monotonic('tx', tx), ts),
        ]
        # Average rate since the previous poll - exact, unlike the box's
        # momentary rate, which a poll every few seconds would only sample.
        if self.last_traffic:
            t0, rx0, tx0 = self.last_traffic
            if 0 < now - t0 <= MAX_RATE_GAP and rx >= rx0 and tx >= tx0:
                items.append(self.reading('fritz.download_rate', (rx - rx0) * 8 / (now - t0), ts))
                items.append(self.reading('fritz.upload_rate', (tx - tx0) * 8 / (now - t0), ts))
        self.last_traffic = (now, rx, tx)

        status = self.fc.call_action(self.connection_service, 'GetStatusInfo')
        online = status['NewConnectionStatus'] == 'Connected'
        uptime = int(status['NewUptime'])
        items.append(self.reading('fritz.online', 1 if online else 0, ts))

        was_online, last_uptime = self.state.get('online'), self.state.get('connection_uptime')
        if was_online and not online:
            self.state['offline_since'] = now
            items.append(self.event('offline', "Internet connection lost", ts=ts))
        elif was_online is False and online:
            down = now - self.state.get('offline_since', now)
            items.append(self.event('online', f"Internet is back after {duration(down)}",
                                    {'down_seconds': round(down)}, notify=True, ts=ts))
        elif online and last_uptime is not None and uptime < last_uptime:
            # Online at both polls but a new session: a reconnect in between.
            items.append(self.event('reconnect', "Internet connection was re-established (reconnect)", ts=ts))
        self.state['online'] = online
        self.state['connection_uptime'] = uptime
        return items

    # --- devices, IPs, box (every DevicePollSeconds) ---------------------------

    def _poll_devices(self):
        ts, now = self.now(), time.time()
        items = []
        fritz_hosts = FritzHosts(fc=self.fc)
        hosts = fritz_hosts.get_hosts_attributes()
        links, boxes = read_mesh(fritz_hosts, hosts)

        first_run = 'known_macs' not in self.state
        known = set(self.state.get('known_macs', []))
        online = wifi = 0
        active_macs = set()
        for host in hosts:
            mac = (host.get('MACAddress') or '').upper()
            if not mac or is_box_itself(host, self.address):
                continue
            active = bool(host.get('Active'))
            interface = INTERFACES.get(host.get('InterfaceType') or '', '')
            link = links.get(mac, {})
            attributes = {
                'name': host.get('HostName') or mac,
                'ip': host.get('IPAddress') or '',
                'interface': interface,
                'speed_mbit': link.get('link_mbit') or host.get('X_AVM-DE_Speed') or 0,
                'via': link.get('via', ''),
                'band': link.get('band', ''),
                'guest': bool(host.get('X_AVM-DE_Guest')),
                'mesh_role': boxes.get(mac, {}).get('role', ''),
                'active': active,
            }
            items.append(Entity('network_device', mac, attributes, active, ts))
            if active:
                active_macs.add(mac)
                # Mesh repeaters are network infrastructure, not devices using it.
                if not attributes['mesh_role']:
                    online += 1
                    wifi += interface == 'wifi'
            if mac not in known:
                known.add(mac)
                # The first run learns the existing network silently; a device
                # the box learned while we were down is recorded, not alerted.
                if not first_run:
                    via = {'wifi': 'Wi-Fi', 'lan': 'LAN'}.get(interface, 'unknown connection')
                    items.append(self.event(
                        'new_device', f"New device on the network: {attributes['name']} "
                                      f"({attributes['ip'] or 'no IP'}, {via})",
                        {'key': mac, **attributes}, notify=active and self.notify_new_devices, ts=ts))
        self.state['known_macs'] = sorted(known)
        items.append(self.reading('fritz.devices_online', online, ts))
        items.append(self.reading('fritz.devices_wifi', wifi, ts))

        last_active = self.state.setdefault('last_active', {})
        for person, macs in self.people.items():
            for mac in macs & active_macs:
                last_active[mac] = now
            home = any(now - last_active.get(mac, 0) <= self.away_after for mac in macs)
            items.append(self.reading(f'fritz.home.{slug(person)}', 1 if home else 0, ts))

        items += self._poll_box(ts)
        return items

    def _poll_box(self, ts):
        items = []
        ipv4 = self.fc.call_action(self.connection_service, 'GetExternalIPAddress')['NewExternalIPAddress']
        try:
            info = self.fc.call_action('WANIPConn1', 'X_AVM_DE_GetIPv6Prefix')
            ipv6_prefix = f"{info['NewIPv6Prefix']}/{info['NewPrefixLength']}" if info['NewIPv6Prefix'] else ''
        except (FritzConnectionException, KeyError):
            ipv6_prefix = ''
        device = self.fc.call_action('DeviceInfo1', 'GetInfo')
        box_uptime, firmware = int(device['NewUpTime']), device['NewSoftwareVersion']

        changes = [
            ('ipv4', ipv4, 'ip_change', "Public IPv4 address changed: {old} → {new}"),
            ('ipv6_prefix', ipv6_prefix, 'ip_change', "Public IPv6 prefix changed: {old} → {new}"),
            ('firmware', firmware, 'firmware', "FRITZ!OS updated: {old} → {new}"),
        ]
        for field, new, kind, message in changes:
            old = self.state.get(field)
            # An empty address is a connection gap, not a change worth reporting.
            if old and new and new != old:
                items.append(self.event(kind, message.format(old=old, new=new), {'old': old, 'new': new}, ts=ts))
            if new:
                self.state[field] = new
        if self.state.get('box_uptime') is not None and box_uptime < self.state['box_uptime']:
            items.append(self.event('restart', "FRITZ!Box restarted", ts=ts))
        self.state['box_uptime'] = box_uptime

        items.append(Entity('internet', 'wan', {
            'online': bool(self.state.get('online')),
            'connection_uptime': self.state.get('connection_uptime'),
            'ipv4': ipv4, 'ipv6_prefix': ipv6_prefix,
            'model': device['NewModelName'], 'firmware': firmware, 'box_uptime': box_uptime,
        }, True, ts))
        return items

    # --- setup check -----------------------------------------------------------

    def probe(self):
        self._connect()
        device = self.fc.call_action('DeviceInfo1', 'GetInfo')
        print(f"{device['NewModelName']}, FRITZ!OS {device['NewSoftwareVersion']}, "
              f"up {duration(int(device['NewUpTime']))}")
        status = self.fc.call_action(self.connection_service, 'GetStatusInfo')
        print(f"Internet via {self.connection_service}: {status['NewConnectionStatus']}, "
              f"session up {duration(int(status['NewUptime']))}")
        link = self.fc.call_action('WANCommonIFC1', 'GetCommonLinkProperties')
        print(f"Link: {link['NewWANAccessType']}, {int(link['NewLayer1DownstreamMaxBitRate']) / 1e6:.0f} / "
              f"{int(link['NewLayer1UpstreamMaxBitRate']) / 1e6:.0f} Mbit/s")
        fritz_hosts = FritzHosts(fc=self.fc)
        all_hosts = fritz_hosts.get_hosts_attributes()
        links, boxes = read_mesh(fritz_hosts, all_hosts)
        if not boxes:
            print("No mesh map - devices are listed without 'via'.")
        hosts = [h for h in all_hosts if not is_box_itself(h, self.address)]
        active = [h for h in hosts if h.get('Active')]
        print(f"Devices: {len(hosts)} known, {len(active)} online now:")
        for h in sorted(active, key=lambda h: (h.get('HostName') or '').lower()):
            mac = (h.get('MACAddress') or '').upper()
            link = links.get(mac, {})
            via = f"via {link['via']} {link['band']}".strip() if link else ''
            role = f"mesh {boxes[mac]['role']}" if mac in boxes else ''
            print(f"  {h.get('HostName') or '?':30} {h.get('IPAddress') or '':16} "
                  f"{INTERFACES.get(h.get('InterfaceType') or '', '?'):5} {mac}  {via or role}"
                  f"{'  (guest)' if h.get('X_AVM-DE_Guest') else ''}")
        if self.people:
            for person, macs in self.people.items():
                seen = [m for m in macs if any((h.get('MACAddress') or '').upper() == m for h in hosts)]
                print(f"Presence '{person}': {len(seen)} of {len(macs)} MAC(s) known to the box")
