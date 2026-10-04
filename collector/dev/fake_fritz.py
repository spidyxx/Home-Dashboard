# dev/fake_fritz.py
#
# Stand-ins for fritzconnection's FritzConnection and FritzHosts, driven by
# dev/simulation.py, so the real sources/fritz.py runs end-to-end in the dev
# stack (see run_collector.py). Development only.

import time
from datetime import datetime, timedelta

import simulation as sim

SEED_DAYS = 30   # must match the history seed.py writes (dev-stack.sh uses 30)


class FakeFritzConnection:
    def __init__(self, **kwargs):
        # Continue the byte counters from where the seeded history ends.
        t = (datetime.now(sim.TZ) - timedelta(days=SEED_DAYS)).replace(hour=0, minute=0, second=0, microsecond=0)
        end = datetime.now(sim.TZ)
        self.rx = self.tx = 0.0
        while t < end:
            down, up, _, _ = sim.network_minute(t)
            self.rx += down * 60 / 8
            self.tx += up * 60 / 8
            t += timedelta(minutes=1)
        self.last = time.time()
        self.booted = time.time() - 12 * 86400
        self.connected_since = time.time() - (4 * 86400 + 3600)

    def call_action(self, service, action, **kwargs):
        now = time.time()
        down, up, online, _ = sim.network_minute(datetime.now(sim.TZ))
        self.rx += down * (now - self.last) / 8
        self.tx += up * (now - self.last) / 8
        self.last = now
        if action == 'GetDefaultConnectionService':
            return {'NewDefaultConnectionService': '1.WANPPPConnection.1'}
        if action == 'GetAddonInfos':
            return {'NewX_AVM_DE_TotalBytesReceived64': str(int(self.rx)),
                    'NewX_AVM_DE_TotalBytesSent64': str(int(self.tx))}
        if action == 'GetStatusInfo':
            return {'NewConnectionStatus': 'Connected' if online else 'Disconnected',
                    'NewUptime': int(now - self.connected_since)}
        if action == 'GetExternalIPAddress':
            return {'NewExternalIPAddress': '203.0.113.42'}
        if action == 'X_AVM_DE_GetIPv6Prefix':
            return {'NewIPv6Prefix': '2001:db8:42:100::', 'NewPrefixLength': 56}
        if action == 'GetInfo':
            return {'NewModelName': 'FRITZ!Box 4050', 'NewSoftwareVersion': '287.08.25',
                    'NewUpTime': int(now - self.booted)}
        if action == 'GetCommonLinkProperties':
            return {'NewWANAccessType': 'Ethernet', 'NewLayer1DownstreamMaxBitRate': 1_000_000_000,
                    'NewLayer1UpstreamMaxBitRate': 1_000_000_000}
        raise KeyError(f"fake FRITZ!Box has no {service}/{action}")


class FakeFritzHosts:
    def __init__(self, fc=None):
        pass

    def get_mesh_topology(self):
        local = datetime.now(sim.TZ)
        on_repeater = {'alex-iphone', 'sam-pixel', 'ipad', 'LG-webOS-TV', 'sonos-kitchen'}
        nodes = [
            {'uid': 'n-master', 'device_name': 'fritz.box', 'device_mac_address': 'DE:AD:BE:EF:FF:01',
             'is_meshed': True, 'mesh_role': 'master', 'node_interfaces': [
                 {'uid': 'm-5g', 'name': 'AP:5G:0'}, {'uid': 'm-2g', 'name': 'AP:2G:0'}, {'uid': 'm-lan', 'name': 'LAN:1'}]},
            {'uid': 'n-repeater', 'device_name': 'fritz-repeater', 'device_mac_address': 'DE:AD:BE:EF:FF:02',
             'is_meshed': True, 'mesh_role': 'slave', 'node_interfaces': [
                 {'uid': 'r-5g', 'name': 'AP:5G:0'}, {'uid': 'r-lan', 'name': 'LAN:1'}]},
        ]
        for name, interface, owner, suffix in sim.DEVICES:
            active = sim.is_home(owner, local) if owner else name not in ('nintendo-switch', 'guest-phone')
            if not active:
                continue
            peer = 'n-repeater' if name in on_repeater else 'n-master'
            ap = ('r' if peer == 'n-repeater' else 'm') + ('-5g' if interface == 'wifi' else '-lan')
            rate = 1_000_000 if interface == 'lan' else 866_000
            nodes.append({'uid': f'n-{suffix}', 'device_name': name, 'device_mac_address': sim.device_mac(suffix),
                          'is_meshed': False, 'node_interfaces': [{'uid': f'i-{suffix}', 'name': 'eth0', 'node_links': [
                              {'state': 'CONNECTED', 'node_1_uid': peer, 'node_2_uid': f'n-{suffix}',
                               'node_interface_1_uid': ap, 'node_interface_2_uid': f'i-{suffix}',
                               'cur_data_rate_rx': rate, 'cur_data_rate_tx': rate}]}]})
        return {'schema_version': '8.7', 'nodes': nodes}

    def get_hosts_attributes(self):
        local = datetime.now(sim.TZ)
        hosts = []
        for name, interface, owner, suffix in sim.DEVICES:
            active = sim.is_home(owner, local) if owner else name not in ('nintendo-switch', 'guest-phone')
            hosts.append({
                'MACAddress': sim.device_mac(suffix), 'Active': active, 'HostName': name,
                'IPAddress': f'192.168.178.{int(suffix, 16) + 20}' if active else '',
                'InterfaceType': '802.11' if interface == 'wifi' else 'Ethernet',
                'X_AVM-DE_Speed': 1000 if interface == 'lan' else 866,
                'X_AVM-DE_Guest': name == 'guest-phone',
            })
        hosts.append({'MACAddress': 'DE:AD:BE:EF:FF:02', 'Active': True, 'HostName': 'fritz-repeater',
                      'IPAddress': '192.168.178.3', 'InterfaceType': 'Ethernet', 'X_AVM-DE_Speed': 1000})
        return hosts
