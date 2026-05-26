"""REST endpoints."""
from __future__ import annotations
import asyncio
import json as _json
import os
import time
import uuid
from pathlib import Path
from urllib import request as _urlreq
from urllib.error import URLError
from fastapi import APIRouter, HTTPException, Query, UploadFile, File
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, field_validator

from .state import state
from .presence import presence_detector
from .serial_reader import port_stats
from .system_stats import system_monitor
from . import config as config_mod
from .config import WifiConfig, ConfigManager
from . import serial_writer
from . import persistence as p
from . import firmware_flash
from . import oui

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


class PingRatePayload(BaseModel):
    interval_ms: int

    @field_validator("interval_ms")
    @classmethod
    def _check_interval(cls, v: int) -> int:
        if not (10 <= int(v) <= 5000):
            raise ValueError("interval_ms must be in [10, 5000]")
        return int(v)


def _port_for_sid(sid: str) -> str | None:
    """Resolve a sensor id (sid) to the serial device path it last reported on.

    Returns None if the sid is unknown.  We rely on the live port-stats table
    rather than a dedicated mapping because the firmware can rename itself at
    runtime, and we don't want to chase that bookkeeping here.
    """
    for ps in port_stats.values():
        if ps.last_sid_seen == sid and ps.connected:
            return ps.device
    return None


_SID_RE = __import__("re").compile(r"^[a-z][a-z0-9_-]{0,15}$")


class RenameSidPayload(BaseModel):
    new_sid: str

    @field_validator("new_sid")
    @classmethod
    def _check(cls, v: str) -> str:
        v = v.strip()
        if not _SID_RE.match(v):
            raise ValueError("new_sid must match ^[a-z][a-z0-9_-]{0,15}$")
        return v


@router.post("/sensors/{sid}/rename")
def rename_sensor(sid: str, payload: RenameSidPayload) -> dict:
    """Tell an ESP32 to persist a new sensor id in NVS and reboot.

    Resolution: we look up which serial port is currently emitting events with
    that sid, then forward ``{"cmd":"set_sid","sid":new}`` on that port only —
    never broadcast, otherwise every connected sensor would adopt the same id.
    """
    if payload.new_sid == sid:
        return {"ok": True, "noop": True, "sid": sid}
    # Refuse to clash with an existing sid.
    for ps in port_stats.values():
        if ps.last_sid_seen == payload.new_sid and ps.device != _port_for_sid(sid):
            raise HTTPException(409, f"sid '{payload.new_sid}' already in use on {ps.device}")
    port = _port_for_sid(sid)
    if port is None:
        raise HTTPException(404, f"no live sensor matches sid '{sid}'")
    sent = serial_writer.write_command(port, {"cmd": "set_sid", "sid": payload.new_sid})
    if not sent:
        raise HTTPException(503, f"could not write to {port}")
    return {
        "ok": True,
        "port": port,
        "old_sid": sid,
        "new_sid": payload.new_sid,
        "note": "ESP rebooting; will reappear under the new sid in a few seconds",
    }


@router.post("/ping-rate")
def set_ping_rate(payload: PingRatePayload) -> dict:
    """Tell every connected ESP32 to change its gateway-ping interval.

    Lower interval = more frames on the channel = higher CSI rate, at the cost
    of airtime.  50 ms (20 Hz) is the firmware default.
    """
    cmd = {"cmd": "set_ping_rate", "interval_ms": int(payload.interval_ms)}
    reached = serial_writer.write_command_all(cmd)
    return {"ok": True, "pushed_to": reached, "count": len(reached), "interval_ms": payload.interval_ms}


# -------- Path-loss calibration --------

class PathLossPayload(BaseModel):
    rssi_0: float
    n: float


@router.get("/path-loss")
def get_path_loss() -> dict:
    if config_mod.config_manager is None:
        raise HTTPException(503, "config manager not initialized")
    return {
        "rssi_0": config_mod.config_manager.path_loss_rssi_0,
        "n": config_mod.config_manager.path_loss_n,
    }


@router.post("/path-loss")
def set_path_loss(payload: PathLossPayload) -> dict:
    if config_mod.config_manager is None:
        raise HTTPException(503, "config manager not initialized")
    # Sanity-check the values
    if not (-100 <= payload.rssi_0 <= 0):
        raise HTTPException(400, "rssi_0 must be in [-100, 0] dBm")
    if not (1.0 <= payload.n <= 6.0):
        raise HTTPException(400, "n must be in [1.0, 6.0] (typical 2.0 free-space to 4.0 obstructed)")
    config_mod.config_manager.set_path_loss(payload.rssi_0, payload.n)
    return {
        "ok": True,
        "rssi_0": config_mod.config_manager.path_loss_rssi_0,
        "n": config_mod.config_manager.path_loss_n,
    }


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
# macvendorlookup.com doesn't send CORS headers, so the browser can't call them
# directly.  We proxy + cache in-memory to limit upstream traffic.  The upstream
# is flaky: it occasionally returns an empty body, a 204, a rate-limit page in
# HTML, or just times out.  We absorb all of those silently and fall back to the
# offline OUI table (mac-vendor-lookup) loaded at startup — the user still gets
# a vendor name, just less detailed than what the API would have returned.
_oui_cache: dict[str, dict] = {}


def _local_oui_payload(mac: str) -> dict:
    """Build a shaped result from the in-memory OUI table (offline)."""
    vendor = oui.vendor(mac)
    if vendor and vendor != "Unknown":
        return {"mac": mac, "results": [{"company": vendor, "source": "offline-oui"}]}
    return {"mac": mac, "results": [], "source": "offline-oui"}


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

    def _fetch() -> tuple[int, bytes, str]:
        """Return (status, body, content_type).  Never raises for HTTP errors."""
        req = _urlreq.Request(url, headers={"User-Agent": "wifi-radar/1.0", "Accept": "application/json"})
        try:
            with _urlreq.urlopen(req, timeout=8) as r:
                return r.status, r.read(), (r.headers.get("Content-Type") or "")
        except _urlreq.HTTPError as e:
            # 4xx / 5xx from upstream — still return body so we can log if useful.
            return e.code, e.read() if hasattr(e, "read") else b"", e.headers.get("Content-Type", "") if e.headers else ""

    data: object = None
    upstream_note: str | None = None
    try:
        status, body, ctype = await asyncio.to_thread(_fetch)
        if status >= 400:
            upstream_note = f"upstream HTTP {status}"
        elif not body or not body.strip():
            upstream_note = "upstream returned empty body"
        elif "json" not in ctype.lower() and not body.lstrip().startswith((b"[", b"{")):
            # Got an HTML rate-limit page or similar.
            upstream_note = f"upstream non-json content-type: {ctype}"
        else:
            try:
                data = _json.loads(body)
            except _json.JSONDecodeError as e:
                upstream_note = f"invalid upstream json: {e}"
    except URLError as e:
        upstream_note = f"upstream unreachable: {e.reason if hasattr(e, 'reason') else e}"
    except Exception as e:  # noqa: BLE001 - keep the proxy robust
        upstream_note = f"lookup failed: {e}"

    if data is None:
        # Fall back to the offline table.  Always cache so we don't pound the API
        # for the same MAC over and over when it's flaky.
        payload = _local_oui_payload(cleaned)
        if upstream_note:
            payload["upstream_note"] = upstream_note
        _oui_cache[key] = payload
        return payload

    if isinstance(data, list):
        results = data
    elif isinstance(data, dict):
        results = [data]
    else:
        results = []
    payload = {"mac": cleaned, "results": results, "source": "macvendorlookup"}
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


# -------- Firmware flashing --------

# Uploaded .bin files land here.  Same directory is shared across requests; each
# upload gets a uuid-based name to avoid clashes.  Cleaned opportunistically.
_FW_UPLOAD_DIR = Path(os.environ.get("RADAR_FW_DIR", "/tmp/wifi-radar-fw"))
_FW_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
# Hard cap so a malicious client can't fill the disk.  ESP32 app partition is
# typically ~1 MB; 4 MB is plenty.
_FW_MAX_BYTES = 4 * 1024 * 1024


@router.get("/firmware/status")
def firmware_status() -> dict:
    """Report whether esptool is callable from the backend's environment."""
    return {
        "esptool_available": firmware_flash.esptool_available(),
        "esptool_bin": firmware_flash.ESPTOOL_BIN,
        "app_offset": firmware_flash.APP_OFFSET,
        "flash_baud": firmware_flash.FLASH_BAUD,
        "upload_dir": str(_FW_UPLOAD_DIR),
    }


@router.post("/firmware/upload")
async def firmware_upload(file: UploadFile = File(...)) -> dict:
    """Receive a .bin app image and stash it for a subsequent flash request."""
    # Reject anything that doesn't look like a binary image up front.
    name = (file.filename or "").lower()
    if not name.endswith(".bin"):
        raise HTTPException(400, "expected a .bin file")
    # Stream to disk in 64KiB chunks so we don't buffer the whole image in RAM
    # while we count bytes against the cap.
    file_id = uuid.uuid4().hex
    dest = _FW_UPLOAD_DIR / f"{file_id}.bin"
    total = 0
    try:
        with dest.open("wb") as fh:
            while True:
                chunk = await file.read(64 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > _FW_MAX_BYTES:
                    fh.close()
                    dest.unlink(missing_ok=True)
                    raise HTTPException(413, f"file exceeds {_FW_MAX_BYTES} bytes")
                fh.write(chunk)
    finally:
        await file.close()
    return {"ok": True, "file_id": file_id, "size": total, "filename": file.filename}


class FlashPayload(BaseModel):
    file_id: str
    sid: str
    # If set, send {"cmd":"set_sid","sid":new_sid} once the flashed sensor comes
    # back online.  Useful when reprovisioning a fresh ESP32 that boots with
    # the default sid baked in.
    new_sid: str | None = None
    baud_after: int = 921600

    @field_validator("file_id")
    @classmethod
    def _check_file_id(cls, v: str) -> str:
        if not v.isalnum() or not (8 <= len(v) <= 64):
            raise ValueError("file_id must be the uuid hex returned by /upload")
        return v


@router.post("/firmware/flash")
async def firmware_flash_route(payload: FlashPayload) -> StreamingResponse:
    """Stream esptool output as it flashes the upload onto the sensor's port."""
    bin_path = _FW_UPLOAD_DIR / f"{payload.file_id}.bin"
    if not bin_path.is_file():
        raise HTTPException(404, f"upload {payload.file_id} not found — re-upload")

    port = _port_for_sid(payload.sid)
    if port is None:
        raise HTTPException(404, f"no live sensor matches sid '{payload.sid}'")

    async def gen():
        async for line in firmware_flash.flash_with_reader_cycle(
            port, bin_path, baud_after=payload.baud_after,
        ):
            yield (line + "\n").encode("utf-8")
        # Best-effort cleanup of the uploaded file.  Keep on disk if flash
        # failed in case the user wants to retry.
        if bin_path.exists():
            try:
                bin_path.unlink()
            except OSError:
                pass

    return StreamingResponse(gen(), media_type="text/plain")


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
