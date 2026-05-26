"""Reads JSON lines from the ESP32 over UART, normalizes them, publishes to the bus."""
from __future__ import annotations
import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any
import serial_asyncio_fast as serial_asyncio

from .event_bus import bus
from . import serial_writer

log = logging.getLogger(__name__)

# Strict whitelist — opening the serial pulls DTR low, resetting the ESP32. The
# bootloader emits at a different baud, so the buffered bytes contain garbage
# that occasionally parses as JSON. Validating against known event types drops
# those phantoms cleanly.
KNOWN_TYPES = {"sniff", "csi", "hb", "ack"}


@dataclass
class PortStats:
    device: str
    baud: int
    connected: bool = False
    bytes_received: int = 0
    lines_seen: int = 0
    events_published: int = 0
    rejected_boundary: int = 0
    rejected_json: int = 0
    rejected_type: int = 0
    rejected_sid: int = 0
    last_byte_ts: float = 0.0
    last_event_ts: float = 0.0
    last_sid_seen: str = ""
    error: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "device": self.device,
            "baud": self.baud,
            "connected": self.connected,
            "bytes_received": self.bytes_received,
            "lines_seen": self.lines_seen,
            "events_published": self.events_published,
            "rejected_boundary": self.rejected_boundary,
            "rejected_json": self.rejected_json,
            "rejected_type": self.rejected_type,
            "rejected_sid": self.rejected_sid,
            "last_byte_ts": self.last_byte_ts,
            "last_event_ts": self.last_event_ts,
            "last_sid_seen": self.last_sid_seen,
            "error": self.error,
        }


# Module-level registry: device path → PortStats. Exposed via API for the UI.
port_stats: dict[str, PortStats] = {}


class RadarProtocol(asyncio.Protocol):
    def __init__(self, stats: PortStats) -> None:
        self._buf = bytearray()
        self.stats = stats

    def connection_made(self, transport) -> None:  # type: ignore[no-untyped-def]
        self.stats.connected = True
        self.stats.error = ""

    def connection_lost(self, exc) -> None:  # type: ignore[no-untyped-def]
        self.stats.connected = False
        if exc is not None:
            self.stats.error = repr(exc)

    def data_received(self, data: bytes) -> None:
        self.stats.bytes_received += len(data)
        self.stats.last_byte_ts = time.time()
        self._buf.extend(data)
        while b"\n" in self._buf:
            line, _, rest = self._buf.partition(b"\n")
            self._buf = bytearray(rest)
            self._handle_line(line)

    def _handle_line(self, raw: bytes) -> None:
        self.stats.lines_seen += 1
        text = raw.decode("utf-8", errors="replace").strip()
        if not text or not text.startswith("{") or not text.endswith("}"):
            self.stats.rejected_boundary += 1
            return
        try:
            ev = json.loads(text)
        except json.JSONDecodeError:
            self.stats.rejected_json += 1
            return
        if not isinstance(ev, dict) or ev.get("t") not in KNOWN_TYPES:
            self.stats.rejected_type += 1
            return
        sid = ev.get("sid")
        if not isinstance(sid, str) or not sid or len(sid) > 16:
            self.stats.rejected_sid += 1
            return
        ev["ts"] = time.time()
        bus.publish(ev)
        self.stats.events_published += 1
        self.stats.last_event_ts = ev["ts"]
        self.stats.last_sid_seen = sid


# Auto-baud: per port we cycle through this list when nothing valid parses.
CANDIDATE_BAUDS = [115200, 921600]
# After this many bytes with zero events, we conclude the baud is wrong.
GARBAGE_BYTES_THRESHOLD = 4096
# How long to wait before declaring "no bytes at all" (port silent / unplugged).
SILENCE_TIMEOUT_SEC = 6.0


# Registry of running reader tasks, keyed by device.  The supervisor functions
# below let the firmware-flash code take exclusive ownership of a port (kill
# the reader → run esptool → restart the reader).
_tasks: dict[str, asyncio.Task] = {}
# Per-device async lock so concurrent flash requests serialize cleanly.
_port_locks: dict[str, asyncio.Lock] = {}


def get_port_lock(device: str) -> asyncio.Lock:
    lock = _port_locks.get(device)
    if lock is None:
        lock = asyncio.Lock()
        _port_locks[device] = lock
    return lock


def start_port(device: str, baud: int) -> asyncio.Task:
    """Spawn (or replace) the serial reader task for a device."""
    existing = _tasks.get(device)
    if existing is not None and not existing.done():
        return existing
    task = asyncio.create_task(run_serial(device, baud), name=f"serial-{device}")
    _tasks[device] = task
    return task


async def stop_port(device: str) -> None:
    """Cancel the reader task and wait for it to actually release the port.

    Safe to call when no task is running (no-op).
    """
    task = _tasks.pop(device, None)
    if task is None or task.done():
        # Ensure transport is unregistered even if the task was already gone.
        serial_writer.unregister_transport(device)
        return
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):
        pass
    serial_writer.unregister_transport(device)


def known_ports() -> list[str]:
    return sorted(_tasks.keys())


async def run_serial(device: str, initial_baud: int) -> None:
    """Open serial and auto-rotate baud rates if the data doesn't parse.

    Strategy: open at the requested baud, watch the protocol's counters. If
    after some bytes we still have 0 events, close and reopen at the next
    candidate baud. Locks in once we publish at least one event.
    """
    loop = asyncio.get_running_loop()
    stats = port_stats.setdefault(device, PortStats(device=device, baud=initial_baud))

    # Build a candidate order: try initial_baud first, then the others.
    candidates = [initial_baud] + [b for b in CANDIDATE_BAUDS if b != initial_baud]
    locked = False

    while True:
        for baud in candidates:
            stats.baud = baud
            stats.error = ""
            events_before = stats.events_published
            bytes_before = stats.bytes_received
            transport = None
            try:
                log.info("opening serial %s @ %d", device, baud)
                transport, _proto = await serial_asyncio.create_serial_connection(
                    loop, lambda: RadarProtocol(stats), device, baudrate=baud,
                )
                serial_writer.register_transport(device, transport)
            except (OSError, serial_asyncio.serial.SerialException) as e:
                stats.connected = False
                stats.error = repr(e)
                log.warning("open failed %s @ %d: %s", device, baud, e)
                await asyncio.sleep(2)
                continue

            # Probe this baud: wait either until we see events, until we accumulate
            # garbage bytes, or until the port is silent.
            t_open = asyncio.get_running_loop().time()
            try:
                while True:
                    await asyncio.sleep(1.0)
                    new_events = stats.events_published - events_before
                    new_bytes = stats.bytes_received - bytes_before
                    if new_events > 0:
                        if not locked:
                            log.info("locked %s @ %d (events flowing)", device, baud)
                            locked = True
                        # Stay open. Keep iterating forever (the protocol drives
                        # the bus directly; we just sit on this future).
                        continue
                    # No events yet.
                    if new_bytes >= GARBAGE_BYTES_THRESHOLD:
                        log.warning("garbage on %s @ %d (%d bytes, 0 events) — rotating baud",
                                    device, baud, new_bytes)
                        break
                    if (asyncio.get_running_loop().time() - t_open) > SILENCE_TIMEOUT_SEC:
                        log.warning("silence on %s @ %d after %.1fs — rotating baud",
                                    device, baud, SILENCE_TIMEOUT_SEC)
                        break
            finally:
                serial_writer.unregister_transport(device)
                if transport is not None:
                    try:
                        transport.close()
                    except Exception:
                        pass
                stats.connected = False
                # Small pause to let the port settle before reopening.
                await asyncio.sleep(0.5)
        # All candidates failed — back off briefly and retry the whole list.
        log.warning("all bauds failed on %s — retrying after 5s", device)
        await asyncio.sleep(5)
