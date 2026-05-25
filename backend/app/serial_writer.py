"""Outbound serial commands.

Each opened serial port registers its asyncio Transport here so the rest of the
backend can send a JSON line to a specific ESP32 (or broadcast to all). The
firmware parses one JSON object per line as a command.
"""
from __future__ import annotations
import asyncio
import json
import logging
from typing import Any

log = logging.getLogger(__name__)


# device path → asyncio transport for that port
_transports: dict[str, asyncio.BaseTransport] = {}


def register_transport(device: str, transport: asyncio.BaseTransport) -> None:
    log.info("register transport %s", device)
    _transports[device] = transport


def unregister_transport(device: str) -> None:
    if device in _transports:
        log.info("unregister transport %s", device)
        _transports.pop(device, None)


def known_devices() -> list[str]:
    return sorted(_transports.keys())


def _write_line(transport: asyncio.BaseTransport, payload: dict[str, Any]) -> bool:
    try:
        line = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        transport.write(line)  # type: ignore[attr-defined]
        return True
    except Exception as e:
        log.warning("write failed: %s", e)
        return False


def write_command(device: str, payload: dict[str, Any]) -> bool:
    t = _transports.get(device)
    if t is None or t.is_closing():
        return False
    return _write_line(t, payload)


def write_command_all(payload: dict[str, Any]) -> list[str]:
    """Broadcast a command. Returns the list of devices we managed to write to."""
    reached: list[str] = []
    for dev, t in list(_transports.items()):
        if t is None or t.is_closing():
            continue
        if _write_line(t, payload):
            reached.append(dev)
    return reached
