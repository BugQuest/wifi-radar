"""REST endpoints."""
from __future__ import annotations
import asyncio
import json as _json
import time
from urllib import request as _urlreq
from urllib.error import URLError
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from .state import state
from .presence import presence_detector
from .serial_reader import port_stats
from .system_stats import system_monitor
from . import config as config_mod
from .config import WifiConfig, ConfigManager
from . import serial_writer
from . import persistence as p

router = APIRouter()


@router.get("/presence")
def get_presence() -> dict:
    return presence_detector.state.to_dict()


@router.get("/ports")
def get_ports() -> dict:
    return {"ports": [p.to_dict() for p in sorted(port_stats.values(), key=lambda x: x.device)]}


@router.get("/system")
def get_system() -> dict:
    return system_monitor.stats.to_dict()


# -------- WiFi config endpoints --------

class WifiConfigPayload(BaseModel):
    name: str
    ssid: str
    password: str = ""
    notes: str = ""


@router.get("/configs")
def list_configs() -> dict:
    if config_mod.config_manager is None:
        return {"configs": [], "active_name": None}
    return config_mod.config_manager.to_dict()


@router.post("/configs")
def upsert_config(payload: WifiConfigPayload) -> dict:
    if config_mod.config_manager is None:
        raise HTTPException(503, "config manager not initialized")
    name = payload.name.strip()
    ssid = payload.ssid.strip()
    if not name or not ssid:
        raise HTTPException(400, "name and ssid are required")
    cfg = WifiConfig(
        name=name,
        ssid=ssid,
        password=payload.password,
        notes=payload.notes,
        created_ts=time.time(),
    )
    config_mod.config_manager.upsert(cfg)
    return {"ok": True, "config": cfg.to_dict()}


@router.delete("/configs/{name}")
def delete_config(name: str) -> dict:
    if config_mod.config_manager is None:
        raise HTTPException(503, "config manager not initialized")
    removed = config_mod.config_manager.remove(name)
    if not removed:
        raise HTTPException(404, f"config '{name}' not found")
    return {"ok": True}


@router.post("/configs/{name}/activate")
def activate_config(name: str) -> dict:
    if config_mod.config_manager is None:
        raise HTTPException(503, "config manager not initialized")
    ok = config_mod.config_manager.set_active(name)
    if not ok:
        raise HTTPException(404, f"config '{name}' not found")
    return {"ok": True, "active_name": name}


@router.get("/aps")
def scan_aps() -> dict:
    aps = ConfigManager.scan_aps()
    return {"aps": aps}


@router.post("/configs/{name}/apply")
def apply_config(name: str) -> dict:
    """Push the saved WiFi config to all connected ESP32s via UART, then mark active.

    The ESP32 firmware receives `{"cmd":"set_wifi", ssid, password}`, writes the
    credentials to NVS, acknowledges, then reboots and reconnects with the new
    settings.
    """
    if config_mod.config_manager is None:
        raise HTTPException(503, "config manager not initialized")
    cfg = next((c for c in config_mod.config_manager.configs if c.name == name), None)
    if cfg is None:
        raise HTTPException(404, f"config '{name}' not found")
    payload = {"cmd": "set_wifi", "ssid": cfg.ssid, "password": cfg.password}
    reached = serial_writer.write_command_all(payload)
    config_mod.config_manager.set_active(name)
    return {
        "ok": True,
        "active_name": name,
        "pushed_to": reached,
        "count": len(reached),
        "known_devices": serial_writer.known_devices(),
    }


@router.post("/configs/broadcast")
def broadcast_command(payload: dict) -> dict:
    """Generic command broadcaster (ping, reboot, get_config, etc.)."""
    if not isinstance(payload, dict) or "cmd" not in payload:
        raise HTTPException(400, "payload must include 'cmd'")
    reached = serial_writer.write_command_all(payload)
    return {"ok": True, "pushed_to": reached, "count": len(reached)}


# -------- Sensor calibration --------

class SensorPositionPayload(BaseModel):
    x: float
    z: float


@router.post("/sensors/{sid}/position")
def set_sensor_position(sid: str, payload: SensorPositionPayload) -> dict:
    if config_mod.config_manager is None:
        raise HTTPException(503, "config manager not initialized")
    config_mod.config_manager.set_sensor_position(sid, payload.x, payload.z)
    # Apply immediately to the live sensor state if known.
    s = state.sensors.get(sid)
    if s is not None:
        s.position_x = float(payload.x)
        s.position_z = float(payload.z)
    return {"ok": True, "sid": sid, "x": payload.x, "z": payload.z}


@router.delete("/sensors/{sid}/position")
def clear_sensor_position(sid: str) -> dict:
    if config_mod.config_manager is None:
        raise HTTPException(503, "config manager not initialized")
    removed = config_mod.config_manager.clear_sensor_position(sid)
    # Trigger a layout recompute so the auto layout fills in.
    state._update_sensor_layout()
    return {"ok": True, "sid": sid, "had_calibration": removed}


# -------- MAC vendor lookup proxy --------
# macvendorlookup.com does not send CORS headers, so the browser can't call
# them directly. We proxy and cache in-memory to limit upstream traffic.
_oui_cache: dict[str, dict] = {}


@router.get("/oui-lookup/{mac}")
async def oui_lookup(mac: str) -> dict:
    cleaned = mac.replace("-", ":").strip()
    key = cleaned.replace(":", "").upper()
    if len(key) < 6:
        raise HTTPException(400, "mac too short")
    cached = _oui_cache.get(key)
    if cached is not None:
        return cached

    url = f"https://www.macvendorlookup.com/api/v2/{cleaned}"

    def _fetch() -> object:
        req = _urlreq.Request(url, headers={"User-Agent": "wifi-radar/1.0", "Accept": "application/json"})
        with _urlreq.urlopen(req, timeout=8) as r:
            return _json.loads(r.read())

    try:
        data = await asyncio.to_thread(_fetch)
    except URLError as e:
        raise HTTPException(502, f"upstream unreachable: {e.reason if hasattr(e, 'reason') else e}")
    except _json.JSONDecodeError as e:
        raise HTTPException(502, f"invalid upstream json: {e}")
    except Exception as e:  # noqa: BLE001 - keep the proxy robust
        raise HTTPException(502, f"lookup failed: {e}")

    if isinstance(data, list):
        results = data
    elif isinstance(data, dict):
        results = [data]
    else:
        results = []
    payload = {"mac": cleaned, "results": results}
    _oui_cache[key] = payload
    return payload


@router.get("/devices")
def list_devices() -> dict:
    devs = sorted(state.devices.values(), key=lambda d: d.last_seen, reverse=True)
    return {"devices": [d.to_dict(state.sensors) for d in devs]}


@router.get("/sensors")
def list_sensors() -> dict:
    return {
        "sensors": [s.to_dict() for s in sorted(state.sensors.values(), key=lambda s: s.id)],
        "baseline_half_m": state.baseline_half_m,
    }


@router.get("/stats")
def get_stats() -> dict:
    return {
        "stats": state.stats.to_dict(),
        "device_count": len(state.devices),
        "csi_buffer_size": len(state.csi),
        "sensor_count": len(state.sensors),
    }


@router.get("/csi/recent")
def csi_recent(n: int = Query(default=64, le=256)) -> dict:
    items = list(state.csi)[-n:]
    return {"csi": items}


@router.get("/history/devices")
def history_devices(since_minutes: int = Query(default=60, le=1440)) -> dict:
    if p.persistence is None:
        return {"devices": []}
    sql = f"""
        SELECT src_mac, COUNT(*) AS packets, AVG(rssi) AS avg_rssi,
               MIN(ts) AS first_seen, MAX(ts) AS last_seen
        FROM sniff_events
        WHERE ts > (EXTRACT(EPOCH FROM now()) - {since_minutes * 60})
        GROUP BY src_mac
        ORDER BY last_seen DESC
        LIMIT 500
    """
    return {"devices": p.persistence.query(sql)}
