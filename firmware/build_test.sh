#!/usr/bin/env bash
cd "$(dirname "$0")"
source ~/esp/esp-idf/export.sh >/dev/null
idf.py build 2>&1 | grep -E 'error|Error|FAILED|undefined' | head -30
