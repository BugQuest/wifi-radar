"""Offline MAC vendor lookup.

The mac-vendor-lookup library's sync wrapper runs its own event loop inside
lookup(), which throws when called while another asyncio loop is running. So
we use the async API once at startup to populate a plain dict, then do
trivially fast bytes.get() at runtime.
"""
from __future__ import annotations
import asyncio
from mac_vendor_lookup import AsyncMacLookup

_aml = AsyncMacLookup()
_prefixes: dict[bytes, str] = {}


async def warm_up() -> None:
    if _prefixes:
        return
    await _aml.load_vendors()
    for k, v in _aml.prefixes.items():
        try:
            _prefixes[k] = v.decode("utf-8", errors="replace") if isinstance(v, bytes) else str(v)
        except Exception:
            continue


def vendor(mac: str) -> str:
    oui = mac.replace(":", "").upper()[:6].encode("ascii", errors="replace")
    return _prefixes.get(oui, "Unknown")
