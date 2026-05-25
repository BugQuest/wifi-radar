#!/usr/bin/env bash
# Diagnose the bq-radar AP state on the Pi.
echo "=== iw dev ==="
iw dev

echo
echo "=== nmcli devices ==="
nmcli device status

echo
echo "=== nmcli bq-radar connection ==="
nmcli connection show bq-radar 2>/dev/null \
  | grep -E '(802-11-wireless\.|ipv4\.method|connection\.type|GENERAL\.STATE)' \
  | head -20 || echo "no bq-radar connection"

echo
DONGLE=$(iw dev | awk '/Interface/ {print $2}' | grep -v '^wlan0$' | head -1)
echo "=== Detected AP interface: $DONGLE ==="
if [ -n "$DONGLE" ]; then
  echo
  echo "--- $DONGLE info ---"
  iw dev "$DONGLE" info
  echo
  echo "--- associated stations ---"
  iw dev "$DONGLE" station dump 2>&1 | head -40
fi

echo
echo "=== hostapd / wpa_supplicant processes ==="
ps -ef | grep -E '(hostapd|wpa_supplicant)' | grep -v grep | head -5
