# dev/run_collector.py
#
# Runs the real collector with a simulated FRITZ!Box (dev/fake_fritz.py) in
# place of fritzconnection. Used by scripts/dev-stack.sh. Development only.
#
#   python dev/run_collector.py --config <dev config>

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

import fake_fritz       # noqa: E402
import sources.fritz    # noqa: E402

sources.fritz.FritzConnection = fake_fritz.FakeFritzConnection
sources.fritz.FritzHosts = fake_fritz.FakeFritzHosts

import collector        # noqa: E402

collector.main()
