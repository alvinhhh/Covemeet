#!/bin/sh
set -eu
# Requires NET_ADMIN only in this dedicated container's own network namespace.
# Never run with host networking, a host namespace mount, or --privileged.
# This fixture config fixes plaintext listener to5060; fail before launch if rules fail.
iptables -w -I INPUT 1 -p tcp --dport 5060 -j REJECT
iptables -w -I INPUT 1 -p udp --dport 5060 -j REJECT
ip6tables -w -I INPUT 1 -p tcp --dport 5060 -j REJECT
ip6tables -w -I INPUT 1 -p udp --dport 5060 -j REJECT
# The SIP process receives no capabilities and cannot remove its guard.
exec setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs \
  /usr/bin/livekit-sip --config=/sip/config.yaml
