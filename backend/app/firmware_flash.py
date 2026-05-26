"""Firmware-flash orchestrator.

We shell out to ``esptool.py`` (which the ESP-IDF toolchain installs) because
re-implementing the ESP32 ROM bootloader handshake in Python is silly when a
battle-tested CLI already does it.  The reader task for the target port is
torn down before we open it for esptool, and restarted after, via the
``serial_reader.{stop_port,start_port}`` helpers.

Endpoints in :mod:`app.api` wrap this into a StreamingResponse so the frontend
can show live progress.
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
from pathlib import Path
from typing import AsyncIterator

from . import serial_reader

log = logging.getLogger(__name__)

# Where the IDF toolchain places esptool — usually on PATH after `. export.sh`.
# Allow override via env for unusual setups (e.g. a venv-local copy).
ESPTOOL_BIN = os.environ.get("RADAR_ESPTOOL", "esptool.py")

# App partition offset for our default partition table (single-app, no OTA).
APP_OFFSET = "0x10000"

# Baud rate for flashing.  921600 works on every CP210x I've seen here; drop to
# 460800 if you're getting "no serial data" errors on iffy cables.
FLASH_BAUD = os.environ.get("RADAR_FLASH_BAUD", "921600")


def esptool_available() -> bool:
    return shutil.which(ESPTOOL_BIN) is not None


async def flash_app(device: str, bin_path: Path) -> AsyncIterator[str]:
    """Run esptool write_flash on *device* with *bin_path* (app-only at 0x10000).

    Yields stdout/stderr lines as they appear.  Caller is responsible for
    having stopped the serial reader for ``device`` first, and for restarting
    it afterwards.

    Wraps execution in the per-device async lock from ``serial_reader`` so two
    flash requests for the same port can't trample each other.
    """
    if not bin_path.is_file():
        yield f"FLASH_ERROR: file not found: {bin_path}"
        return
    if not esptool_available():
        yield f"FLASH_ERROR: '{ESPTOOL_BIN}' not on PATH — did you `. export.sh` in the ESP-IDF venv?"
        return

    lock = serial_reader.get_port_lock(device)
    if lock.locked():
        yield f"FLASH_ERROR: another flash is in progress on {device}"
        return

    async with lock:
        cmd = [
            ESPTOOL_BIN,
            "--chip", "esp32",
            "--port", device,
            "--baud", FLASH_BAUD,
            "--before", "default_reset",
            "--after", "hard_reset",
            "write_flash", APP_OFFSET, str(bin_path),
        ]
        yield f"$ {' '.join(cmd)}"

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        assert proc.stdout is not None

        try:
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                yield line.decode("utf-8", "replace").rstrip("\n")
        finally:
            if proc.returncode is None:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=5.0)
                except asyncio.TimeoutError:
                    proc.kill()
                    await proc.wait()

        code = proc.returncode if proc.returncode is not None else -1
        if code == 0:
            yield "FLASH_OK"
        else:
            yield f"FLASH_ERROR: esptool exited with code {code}"


async def flash_with_reader_cycle(
    device: str, bin_path: Path, baud_after: int,
) -> AsyncIterator[str]:
    """Convenience wrapper: stop_port → flash → start_port.

    Always restarts the reader, even on failure, so an aborted flash doesn't
    leave the port orphaned.
    """
    yield f"[supervisor] stopping serial reader on {device}"
    try:
        await serial_reader.stop_port(device)
    except Exception as e:  # noqa: BLE001
        yield f"FLASH_ERROR: could not release port: {e}"
        # Best-effort restart so we don't end up with a dead port permanently.
        serial_reader.start_port(device, baud_after)
        return

    try:
        async for line in flash_app(device, bin_path):
            yield line
    finally:
        yield f"[supervisor] restarting serial reader on {device}"
        serial_reader.start_port(device, baud_after)
