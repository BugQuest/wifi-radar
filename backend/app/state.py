"""In-memory rolling state for live frontend consumption — multi-sensor aware."""
from __future__ import annotations
import asyncio
import math
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from .event_bus import bus
from .oui import vendor
from .presence import presence_detector
from .system_stats import system_monitor


# Default radius of the sensor layout circle (and half-baseline for the 2-sensor case).
# The frontend reads the per-sensor positions from state, so this is only the seed.
DEFAULT_BASELINE_HALF_M = 2.0

# 1D bilateration: tanh squashing constant (only used with exactly 2 sensors).
PROPAGATION_K_DB = 15.0

# 2D trilateration: log-distance path loss model.
#   RSSI(d) = PATH_LOSS_RSSI_0 - 10 * PATH_LOSS_N * log10(d_meters)
# These defaults match indoor 2.4 GHz around 1-5 m. Calibrate per environment.
PATH_LOSS_RSSI_0 = -30.0   # RSSI at 1 m
PATH_LOSS_N = 2.5          # exponent

# A sensor's RSSI for a device is "fresh" if seen within this many seconds.
SENSOR_RSSI_FRESH_SEC = 8.0


def _rssi_to_distance(rssi: float) -> float:
    return 10.0 ** ((PATH_LOSS_RSSI_0 - rssi) / (10.0 * PATH_LOSS_N))


def trilaterate(observations: list[tuple[float, float, float]]) -> dict[str, Any] | None:
    """observations: list of (sensor_x_m, sensor_z_m, rssi_dbm). Need at least 3.

    Linearizes the circle equations against the first observation and solves
    (A^T A) x = (A^T b) for 2D position. Returns {x, z, confidence, residual_m}
    or None when degenerate.
    """
    if len(observations) < 3:
        return None
    pts = [(x, z, _rssi_to_distance(r), r) for (x, z, r) in observations]
    x0, z0, d0, _ = pts[0]
    # Build A and b: A[i] · [x, z] = b[i] for i ≥ 1
    rows: list[tuple[float, float]] = []
    b_vec: list[float] = []
    for (xi, zi, di, _) in pts[1:]:
        rows.append((2.0 * (xi - x0), 2.0 * (zi - z0)))
        b_vec.append((xi * xi + zi * zi - di * di) - (x0 * x0 + z0 * z0 - d0 * d0))
    # Normal equations: (A^T A) is 2x2, solve manually.
    ata00 = sum(a * a for (a, _) in rows)
    ata01 = sum(a * b for (a, b) in rows)
    ata11 = sum(b * b for (_, b) in rows)
    atb0 = sum(a * c for ((a, _), c) in zip(rows, b_vec))
    atb1 = sum(b * c for ((_, b), c) in zip(rows, b_vec))
    det = ata00 * ata11 - ata01 * ata01
    if abs(det) < 1e-9:
        return None
    x = (ata11 * atb0 - ata01 * atb1) / det
    z = (-ata01 * atb0 + ata00 * atb1) / det
    # Residual: how well the estimated point matches each observed distance
    rss = 0.0
    for (xi, zi, di, _) in pts:
        d_actual = math.hypot(x - xi, z - zi)
        rss += (d_actual - di) ** 2
    residual = math.sqrt(rss / len(pts))
    # Reject only impossible fits (NaN or absurd magnitudes). We keep low-confidence
    # estimates and let the frontend visualize them with reduced opacity.
    if not (math.isfinite(x) and math.isfinite(z)):
        return None
    if math.hypot(x, z) > 200.0 or residual > 200.0:
        return None
    max_rssi = max(r for (_, _, _, r) in pts)
    # Confidence drops smoothly with residual; with a 2 m baseline a 5 m residual
    # is still informational, but a 50 m one is meaningless.
    conf_residual = math.exp(-residual / 8.0)
    conf_signal = min(1.0, (max_rssi + 95) / 70.0)
    conf = conf_residual * conf_signal
    return {"x": x, "z": z, "confidence": conf, "residual_m": residual}


@dataclass
class Device:
    mac: str
    vendor: str
    first_seen: float
    last_seen: float
    last_rssi: int          # Strongest RSSI across all sensors (informational)
    packets: int = 0
    kinds: dict[str, int] = field(default_factory=dict)
    rssi_by_sensor: dict[str, int] = field(default_factory=dict)
    last_seen_by_sensor: dict[str, float] = field(default_factory=dict)

    def fresh_observations(self, sensors: dict[str, "Sensor"]) -> list[tuple[str, float, float, float]]:
        """Return (sid, x_m, z_m, rssi) for every sensor that has a fresh RSSI."""
        now = time.time()
        out: list[tuple[str, float, float, float]] = []
        for sid, sensor in sensors.items():
            r = self.rssi_by_sensor.get(sid)
            t = self.last_seen_by_sensor.get(sid, 0.0)
            if r is None or (now - t) > SENSOR_RSSI_FRESH_SEC:
                continue
            out.append((sid, sensor.position_x, sensor.position_z, float(r)))
        return out

    def bilateration(self, sensors: dict[str, "Sensor"]) -> dict[str, Any] | None:
        """1D bilateration along the line between exactly two fresh sensors."""
        fresh = self.fresh_observations(sensors)
        if len(fresh) < 2:
            return None
        # Use the two with strongest signal
        fresh.sort(key=lambda t: t[3], reverse=True)
        (sa, xa, za, ra), (sb, xb, zb, rb) = fresh[0], fresh[1]
        delta = ra - rb  # positive → closer to a
        # Project onto a-b axis using tanh squashing, return as a 2D point
        nx = (xa - xb)
        nz = (za - zb)
        norm = math.hypot(nx, nz)
        if norm < 1e-6:
            return None
        nx /= norm
        nz /= norm
        # midpoint biased toward stronger sensor
        bias = math.tanh(delta / PROPAGATION_K_DB)
        mx = (xa + xb) / 2 + nx * bias * norm / 2
        mz = (za + zb) / 2 + nz * bias * norm / 2
        confidence = min(1.0, abs(delta) / 30.0) * min(1.0, (max(ra, rb) + 95) / 70.0)
        return {
            "x": mx,
            "z": mz,
            "delta_rssi": delta,
            "confidence": confidence,
            "sensors_used": [sa, sb],
        }

    def position_2d(self, sensors: dict[str, "Sensor"]) -> dict[str, Any] | None:
        """2D position via trilateration when 3+ sensors have fresh RSSI."""
        fresh = self.fresh_observations(sensors)
        if len(fresh) < 3:
            return None
        obs = [(x, z, r) for (_sid, x, z, r) in fresh]
        result = trilaterate(obs)
        if result is None:
            return None
        result["sensors_used"] = [sid for (sid, _, _, _) in fresh]
        return result

    def to_dict(self, sensors: dict[str, "Sensor"] | None = None) -> dict[str, Any]:
        d: dict[str, Any] = {
            "mac": self.mac,
            "vendor": self.vendor,
            "first_seen": self.first_seen,
            "last_seen": self.last_seen,
            "last_rssi": self.last_rssi,
            "packets": self.packets,
            "kinds": self.kinds,
            "rssi_by_sensor": self.rssi_by_sensor,
            "last_seen_by_sensor": self.last_seen_by_sensor,
        }
        if sensors:
            d["position_2d"] = self.position_2d(sensors)
            d["bilateration"] = self.bilateration(sensors)
        return d


@dataclass
class Sensor:
    id: str
    port: str = ""
    # Physical placement in meters on the floor plane (Three.js x/z).
    # Auto-laid-out as a regular polygon around origin when sensors appear.
    position_x: float = 0.0
    position_z: float = 0.0
    first_seen: float = 0.0
    last_heartbeat: float = 0.0
    connected: bool = False
    ssid: str = ""           # SSID of the AP the STA is associated to (empty if not)
    channel: int = 0
    ap_rssi: int = 0
    drops: int = 0
    ring_free: int = 0
    sniff_count: int = 0
    csi_count: int = 0
    sniff_rate: float = 0.0
    csi_rate: float = 0.0
    _sniff_ts: deque[float] = field(default_factory=lambda: deque(maxlen=2048))
    _csi_ts: deque[float] = field(default_factory=lambda: deque(maxlen=2048))

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "port": self.port,
            "position_x": self.position_x,
            "position_z": self.position_z,
            "first_seen": self.first_seen,
            "last_heartbeat": self.last_heartbeat,
            "connected": self.connected,
            "ssid": self.ssid,
            "channel": self.channel,
            "ap_rssi": self.ap_rssi,
            "drops": self.drops,
            "ring_free": self.ring_free,
            "sniff_count": self.sniff_count,
            "csi_count": self.csi_count,
            "sniff_rate": self.sniff_rate,
            "csi_rate": self.csi_rate,
        }


@dataclass
class Stats:
    sniff_count: int = 0
    csi_count: int = 0
    sniff_rate: float = 0.0
    csi_rate: float = 0.0
    # Aggregate STA/channel/RSSI of the first connected sensor (legacy frontend).
    sta_connected: bool = False
    channel: int = 0
    ap_rssi: int = 0

    def to_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()


class State:
    CSI_RING = 1024
    RATE_WINDOW_SEC = 5.0
    PRUNE_AFTER_SEC = 600.0

    def __init__(self) -> None:
        self.devices: dict[str, Device] = {}
        self.csi: deque[dict] = deque(maxlen=self.CSI_RING)
        self.sensors: dict[str, Sensor] = {}
        self.stats = Stats()
        self.baseline_half_m = DEFAULT_BASELINE_HALF_M
        self._lock = asyncio.Lock()

    # --- per-sensor helpers ---
    def _ensure_sensor(self, sid: str) -> Sensor:
        s = self.sensors.get(sid)
        if s is None:
            s = Sensor(id=sid, first_seen=time.time())
            self.sensors[sid] = s
            self._update_sensor_layout()
        return s

    def _update_sensor_layout(self) -> None:
        """Lay out sensors.

        Priority:
        - User-calibrated positions (loaded from config.json) when available.
        - Otherwise auto-layout as a regular polygon:
            - 1 sensor: at origin.
            - 2 sensors: on the X axis at ±baseline_half_m.
            - N≥3 sensors: equally-spaced on a circle of radius baseline_half_m,
              first sensor (alphabetic) placed at angle -π/2 (front of scene).
        """
        from . import config as config_mod
        calibrated = (
            config_mod.config_manager.sensor_positions
            if config_mod.config_manager is not None
            else {}
        )

        ids = sorted(self.sensors.keys())
        # Apply calibration for sensors that have one.
        uncal = [sid for sid in ids if sid not in calibrated]
        for sid, pos in calibrated.items():
            if sid in self.sensors:
                self.sensors[sid].position_x = pos.x
                self.sensors[sid].position_z = pos.z

        # Auto-layout for the rest (only over the un-calibrated subset).
        n = len(uncal)
        r = self.baseline_half_m
        if n == 1:
            self.sensors[uncal[0]].position_x = 0.0
            self.sensors[uncal[0]].position_z = 0.0
        elif n == 2:
            self.sensors[uncal[0]].position_x = -r
            self.sensors[uncal[0]].position_z = 0.0
            self.sensors[uncal[1]].position_x = +r
            self.sensors[uncal[1]].position_z = 0.0
        elif n >= 3:
            for i, sid in enumerate(uncal):
                angle = -math.pi / 2 + (i / n) * 2 * math.pi
                self.sensors[sid].position_x = r * math.cos(angle)
                self.sensors[sid].position_z = r * math.sin(angle)

    def sorted_sensor_ids(self) -> list[str]:
        return sorted(self.sensors.keys())

    # --- event handlers ---
    def _on_sniff(self, ev: dict) -> None:
        sid = ev.get("sid", "?")
        sensor = self._ensure_sensor(sid)
        sensor._sniff_ts.append(ev["ts"])
        sensor.sniff_count += 1

        mac_hex = ev.get("src", "")
        if len(mac_hex) != 12:
            return
        canonical = ":".join(mac_hex[i:i+2] for i in range(0, 12, 2))
        now = ev["ts"]
        rssi = int(ev.get("rssi", 0))

        d = self.devices.get(canonical)
        if d is None:
            d = Device(
                mac=canonical,
                vendor=vendor(canonical),
                first_seen=now,
                last_seen=now,
                last_rssi=rssi,
            )
            self.devices[canonical] = d

        d.last_seen = now
        d.packets += 1
        d.rssi_by_sensor[sid] = rssi
        d.last_seen_by_sensor[sid] = now
        if abs(rssi) < abs(d.last_rssi) or d.last_rssi == 0:
            d.last_rssi = rssi
        k = ev.get("k", "?")
        d.kinds[k] = d.kinds.get(k, 0) + 1
        self.stats.sniff_count += 1

    def _on_csi(self, ev: dict) -> None:
        sid = ev.get("sid", "?")
        sensor = self._ensure_sensor(sid)
        sensor._csi_ts.append(ev["ts"])
        sensor.csi_count += 1
        self.csi.append(ev)
        self.stats.csi_count += 1
        data = ev.get("data")
        if isinstance(data, list):
            presence_detector.on_csi(sid, data)

    def _on_hb(self, ev: dict) -> None:
        sid = ev.get("sid", "?")
        sensor = self._ensure_sensor(sid)
        sensor.last_heartbeat = ev["ts"]
        sensor.connected = bool(ev.get("connected", False))
        ssid = ev.get("ssid")
        if isinstance(ssid, str):
            sensor.ssid = ssid
        elif not sensor.connected:
            sensor.ssid = ""
        sensor.channel = int(ev.get("ch", sensor.channel))
        sensor.ap_rssi = int(ev.get("rssi", sensor.ap_rssi))
        sensor.drops = int(ev.get("drops", sensor.drops))
        sensor.ring_free = int(ev.get("ring_free", sensor.ring_free))

        # Aggregate stats reflect the first connected sensor (legacy).
        connected = [s for s in self.sensors.values() if s.connected]
        if connected:
            primary = connected[0]
            self.stats.sta_connected = True
            self.stats.channel = primary.channel
            self.stats.ap_rssi = primary.ap_rssi
        else:
            self.stats.sta_connected = False

    def _update_rates(self) -> None:
        now = time.time()
        cutoff = now - self.RATE_WINDOW_SEC
        total_sniff = 0
        total_csi = 0
        for s in self.sensors.values():
            while s._sniff_ts and s._sniff_ts[0] < cutoff:
                s._sniff_ts.popleft()
            while s._csi_ts and s._csi_ts[0] < cutoff:
                s._csi_ts.popleft()
            s.sniff_rate = len(s._sniff_ts) / self.RATE_WINDOW_SEC
            s.csi_rate = len(s._csi_ts) / self.RATE_WINDOW_SEC
            total_sniff += len(s._sniff_ts)
            total_csi += len(s._csi_ts)
        self.stats.sniff_rate = total_sniff / self.RATE_WINDOW_SEC
        self.stats.csi_rate = total_csi / self.RATE_WINDOW_SEC

    def _prune(self) -> None:
        cutoff = time.time() - self.PRUNE_AFTER_SEC
        stale = [m for m, d in self.devices.items() if d.last_seen < cutoff]
        for m in stale:
            del self.devices[m]

    async def consume(self) -> None:
        async for ev in bus.subscribe(replay_recent=False):
            t = ev.get("t")
            if t == "sniff":
                self._on_sniff(ev)
            elif t == "csi":
                self._on_csi(ev)
            elif t == "hb":
                self._on_hb(ev)

    async def maintenance_loop(self) -> None:
        while True:
            await asyncio.sleep(1.0)
            self._update_rates()
            self._prune()
            presence_detector.update(self.sensors)
            try:
                system_monitor.update()
            except Exception:
                pass  # best effort, never crash the loop


state = State()
