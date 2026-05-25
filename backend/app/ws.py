"""WebSocket endpoint streaming live events to the frontend."""
from __future__ import annotations
import asyncio
import json
import logging
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .event_bus import bus
from .state import state
from .presence import presence_detector
from .serial_reader import port_stats
from .system_stats import system_monitor

log = logging.getLogger(__name__)
router = APIRouter()


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    await ws.accept()

    # Initial snapshot so the client can paint immediately.
    snapshot = {
        "t": "snapshot",
        "devices": [d.to_dict(state.sensors) for d in state.devices.values()],
        "stats": state.stats.to_dict(),
        "sensors": [s.to_dict() for s in sorted(state.sensors.values(), key=lambda s: s.id)],
        "baseline_half_m": state.baseline_half_m,
        "presence": presence_detector.state.to_dict(),
        "ports": [p.to_dict() for p in sorted(port_stats.values(), key=lambda x: x.device)],
        "system": system_monitor.stats.to_dict(),
    }
    await ws.send_text(json.dumps(snapshot))

    async def pump_events() -> None:
        async for ev in bus.subscribe(replay_recent=False):
            await ws.send_text(json.dumps(ev))

    async def pump_stats() -> None:
        while True:
            await asyncio.sleep(1.0)
            payload = {
                "t": "stats",
                **state.stats.to_dict(),
                "sensors": [s.to_dict() for s in sorted(state.sensors.values(), key=lambda s: s.id)],
                "presence": presence_detector.state.to_dict(),
                "ports": [p.to_dict() for p in sorted(port_stats.values(), key=lambda x: x.device)],
                "system": system_monitor.stats.to_dict(),
            }
            await ws.send_text(json.dumps(payload))

    try:
        await asyncio.gather(pump_events(), pump_stats())
    except WebSocketDisconnect:
        log.info("client disconnected")
    except Exception as e:
        log.warning("ws error: %s", e)
