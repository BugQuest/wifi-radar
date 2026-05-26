#!/usr/bin/env bash
# Build + flash the firmware with a specific SENSOR_ID.
# Stops the backend (it holds the serial port) before flashing. Does NOT
# restart it — relaunch the backend manually once you're done flashing.
# Usage: ./flash_sid.sh r1 [/dev/ttyUSB0]
set -euo pipefail

SID="${1:?usage: flash_sid.sh <sid> [port]}"
PORT="${2:-/dev/ttyUSB0}"

cd "$(dirname "$0")"

# Force the UART console baud post-sdkconfig-regen. sdkconfig.defaults sometimes
# loses to other Kconfig choices on the BAUDRATE; this guarantees 921600.
force_baud_in_sdkconfig() {
    if [ -f sdkconfig ]; then
        sed -i 's|^CONFIG_ESP_CONSOLE_UART_BAUDRATE=.*|CONFIG_ESP_CONSOLE_UART_BAUDRATE=921600|' sdkconfig
        sed -i 's|^CONFIG_CONSOLE_UART_BAUDRATE=.*|CONFIG_CONSOLE_UART_BAUDRATE=921600|' sdkconfig
    fi
}

# Free the port — backend keeps /dev/ttyUSB* open, esptool needs exclusive access.
if pgrep -f uvicorn >/dev/null; then
    echo ">>> stopping backend (it holds the serial port)"
    pkill -f uvicorn || true
    sleep 2
fi

# Patch the default of CONFIG_RADAR_SENSOR_ID only — there are other `default "..."`
# lines in the file (WIFI_SSID, WIFI_PASSWORD) that must NOT be touched. Restrict
# the substitution to the range between RADAR_SENSOR_ID and the next config block.
sed -i -E '/^    config RADAR_SENSOR_ID$/,/^    config / s|^(        default )"[^"]*"$|\1"'"$SID"'"|' main/Kconfig.projbuild

# Force a regen since the cached sdkconfig holds the previous value.
rm -f sdkconfig

source ~/esp/esp-idf/export.sh >/dev/null
idf.py set-target esp32 2>&1 | tail -1
force_baud_in_sdkconfig
idf.py build 2>&1 | tail -3
idf.py -p "$PORT" flash 2>&1 | tail -3

# Restore SID default to "r0" so subsequent flashes start fresh.
if [ "$SID" != "r0" ]; then
    sed -i -E '/^    config RADAR_SENSOR_ID$/,/^    config / s|^(        default )"[^"]*"$|\1"r0"|' main/Kconfig.projbuild
    rm -f sdkconfig
fi

echo "=== flashed SID=$SID on $PORT ==="
