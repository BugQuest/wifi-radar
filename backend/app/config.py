"""Persisted WiFi configurations + AP scanning.

Configs are kept in a JSON file under the data directory so they survive
backend restarts. Scanning uses NetworkManager's `nmcli` to enumerate visible
2.4 GHz access points (since the ESP32s only support 2.4 GHz anyway).
"""
from __future__ import annotations
import json
import logging
import subprocess
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


@dataclass
class WifiConfig:
    name: str            # user-friendly label, must be unique
    ssid: str
    password: str
    created_ts: float
    notes: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class SensorPosition:
    sid: str
    x: float
    z: float

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class ConfigManager:
    """JSON-backed store of WiFi configs + selected active one."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.configs: list[WifiConfig] = []
        self.active_name: str | None = None
        # User-calibrated sensor positions (overrides the auto-layout).
        self.sensor_positions: dict[str, SensorPosition] = {}
        # Calibrated path-loss model: RSSI(d) = rssi_0 - 10*n*log10(d). Defaults
        # are generic indoor 2.4 GHz; user can override via /api/path-loss.
        self.path_loss_rssi_0: float = -30.0
        self.path_loss_n: float = 2.5
        self.load()

    def load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text())
            self.configs = [
                WifiConfig(
                    name=c.get("name", ""),
                    ssid=c.get("ssid", ""),
                    password=c.get("password", ""),
                    created_ts=float(c.get("created_ts", 0.0)),
                    notes=c.get("notes", ""),
                )
                for c in data.get("configs", [])
            ]
            self.active_name = data.get("active_name")
            self.sensor_positions = {
                p.get("sid", ""): SensorPosition(
                    sid=p.get("sid", ""),
                    x=float(p.get("x", 0.0)),
                    z=float(p.get("z", 0.0)),
                )
                for p in data.get("sensor_positions", [])
                if p.get("sid")
            }
            pl = data.get("path_loss") or {}
            if "rssi_0" in pl:
                self.path_loss_rssi_0 = float(pl["rssi_0"])
            if "n" in pl:
                self.path_loss_n = float(pl["n"])
        except (OSError, json.JSONDecodeError, ValueError) as e:
            log.warning("config load failed: %s", e)

    def save(self) -> None:
        data = {
            "configs": [c.to_dict() for c in self.configs],
            "active_name": self.active_name,
            "sensor_positions": [p.to_dict() for p in self.sensor_positions.values()],
            "path_loss": {"rssi_0": self.path_loss_rssi_0, "n": self.path_loss_n},
        }
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2))
        tmp.replace(self.path)

    def set_path_loss(self, rssi_0: float, n: float) -> None:
        self.path_loss_rssi_0 = float(rssi_0)
        self.path_loss_n = float(n)
        self.save()

    def set_sensor_position(self, sid: str, x: float, z: float) -> None:
        self.sensor_positions[sid] = SensorPosition(sid=sid, x=float(x), z=float(z))
        self.save()

    def clear_sensor_position(self, sid: str) -> bool:
        if sid in self.sensor_positions:
            del self.sensor_positions[sid]
            self.save()
            return True
        return False

    def upsert(self, cfg: WifiConfig) -> None:
        for i, c in enumerate(self.configs):
            if c.name == cfg.name:
                self.configs[i] = cfg
                self.save()
                return
        self.configs.append(cfg)
        self.save()

    def remove(self, name: str) -> bool:
        before = len(self.configs)
        self.configs = [c for c in self.configs if c.name != name]
        if self.active_name == name:
            self.active_name = None
        self.save()
        return len(self.configs) < before

    def set_active(self, name: str | None) -> bool:
        if name is None:
            self.active_name = None
            self.save()
            return True
        if not any(c.name == name for c in self.configs):
            return False
        self.active_name = name
        self.save()
        return True

    def to_dict(self) -> dict[str, Any]:
        return {
            "configs": [c.to_dict() for c in self.configs],
            "active_name": self.active_name,
        }

    @staticmethod
    def scan_aps(timeout: float = 12.0) -> list[dict[str, Any]]:
        """List visible 2.4 GHz APs via nmcli. Dedupes by SSID, keeps strongest."""
        try:
            r = subprocess.run(
                ["nmcli", "-t", "-f", "SSID,SIGNAL,SECURITY,FREQ,BSSID", "device", "wifi", "list", "--rescan", "auto"],
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            log.warning("nmcli scan failed: %s", e)
            return []
        if r.returncode != 0:
            log.warning("nmcli scan non-zero: %s", r.stderr.strip()[:120])
            return []

        best: dict[str, dict[str, Any]] = {}
        for line in r.stdout.strip().split("\n"):
            if not line:
                continue
            # nmcli -t outputs fields separated by `:`, with `\:` escaping inside fields.
            # SSIDs can contain `:` which makes naive split() unsafe. Split with awareness.
            parts = _nmcli_split(line)
            if len(parts) < 4:
                continue
            ssid = parts[0]
            signal_s = parts[1]
            security = parts[2]
            freq_s = parts[3]
            if not ssid:
                continue
            try:
                signal = int(signal_s) if signal_s else 0
                freq = int(freq_s.replace(" MHz", "").strip()) if freq_s else 0
            except ValueError:
                continue
            # Skip 5 GHz — ESP32 only supports 2.4 GHz
            if freq >= 5000:
                continue
            entry = {
                "ssid": ssid,
                "signal": signal,
                "security": security,
                "freq_mhz": freq,
            }
            if ssid not in best or signal > best[ssid]["signal"]:
                best[ssid] = entry
        return sorted(best.values(), key=lambda x: -x["signal"])


def _nmcli_split(line: str) -> list[str]:
    """Split an nmcli `-t` line on unescaped colons. Honors backslash escapes."""
    out: list[str] = []
    cur = []
    i = 0
    while i < len(line):
        c = line[i]
        if c == "\\" and i + 1 < len(line):
            cur.append(line[i + 1])
            i += 2
            continue
        if c == ":":
            out.append("".join(cur))
            cur = []
            i += 1
            continue
        cur.append(c)
        i += 1
    out.append("".join(cur))
    return out


config_manager: ConfigManager | None = None


def init(data_dir: Path) -> ConfigManager:
    global config_manager
    config_manager = ConfigManager(data_dir / "wifi-configs.json")
    return config_manager
