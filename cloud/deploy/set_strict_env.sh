#!/bin/bash
set -e
UNIT=/etc/systemd/system/charge-cloud.service
if ! grep -q CHARGE_TOKEN_KEY_STRICT "$UNIT"; then
  awk '1; /^\[Service\]/{print "Environment=CHARGE_TOKEN_KEY_STRICT=1"}' "$UNIT" > /tmp/cc.unit
  mv /tmp/cc.unit "$UNIT"
fi
systemctl daemon-reload
systemctl restart charge-cloud
sleep 1
systemctl is-active charge-cloud
