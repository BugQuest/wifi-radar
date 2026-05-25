"""Raspberry Pi resource monitoring — CPU%, temp, load, memory, throttling.

Reads /proc and /sys directly to avoid extra dependencies. The `throttled` field
is Pi-specific and comes from `vcgencmd get_throttled` (a bitfield where bit 0
means currently undervoltage, bit 2 means currently throttled, etc.).
"""
from __future__ import annotations
import os
import subprocess
import time
from dataclasses import dataclass, field
from typing import Any


THROTTLE_FLAGS = {
    0: "under-voltage (now)",
    1: "arm-freq-capped (now)",
    2: "throttled (now)",
    3: "soft-temp-limit (now)",
    16: "under-voltage (occurred)",
    17: "arm-freq-capped (occurred)",
    18: "throttled (occurred)",
    19: "soft-temp-limit (occurred)",
}


@dataclass
class SystemStats:
    ts: float = 0.0
    cpu_percent: float = 0.0
    cpu_per_core: list[float] = field(default_factory=list)
    temperature_c: float | None = None
    load_avg: list[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])
    cpu_count: int = 0
    uptime_s: float = 0.0
    # Memory in kB (raw from /proc/meminfo)
    mem_total_kb: int = 0
    mem_available_kb: int = 0
    mem_free_kb: int = 0
    mem_used_pct: float = 0.0
    # Pi throttling
    throttled_raw: int | None = None
    throttled_flags: list[str] = field(default_factory=list)
    # Disk usage of /
    disk_total_gb: float = 0.0
    disk_used_gb: float = 0.0
    disk_pct: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()


class SystemMonitor:
    """Periodic snapshots of Pi resource usage."""

    def __init__(self) -> None:
        self.stats = SystemStats()
        self._prev_cpu = self._read_cpu_jiffies()
        self._prev_per_core = self._read_per_core_jiffies()
        # Disk and process-start are slower → only read every N seconds.
        self._disk_cache_until = 0.0

    # ---------- low-level readers ----------

    @staticmethod
    def _read_cpu_jiffies() -> list[int]:
        with open("/proc/stat") as f:
            line = f.readline()  # "cpu  ..."
        return [int(x) for x in line.split()[1:]]

    @staticmethod
    def _read_per_core_jiffies() -> list[list[int]]:
        out: list[list[int]] = []
        with open("/proc/stat") as f:
            for line in f:
                if line.startswith("cpu") and not line.startswith("cpu "):
                    out.append([int(x) for x in line.split()[1:]])
                elif not line.startswith("cpu"):
                    break
        return out

    @staticmethod
    def _read_temperature_c() -> float | None:
        for path in ("/sys/class/thermal/thermal_zone0/temp",):
            try:
                with open(path) as f:
                    return int(f.read().strip()) / 1000.0
            except OSError:
                continue
        return None

    @staticmethod
    def _read_loadavg() -> list[float]:
        try:
            with open("/proc/loadavg") as f:
                parts = f.read().split()
            return [float(parts[0]), float(parts[1]), float(parts[2])]
        except (OSError, IndexError, ValueError):
            return [0.0, 0.0, 0.0]

    @staticmethod
    def _read_meminfo() -> dict[str, int]:
        info: dict[str, int] = {}
        try:
            with open("/proc/meminfo") as f:
                for line in f:
                    name, _, rest = line.partition(":")
                    parts = rest.split()
                    if parts:
                        try:
                            info[name] = int(parts[0])
                        except ValueError:
                            pass
        except OSError:
            pass
        return info

    @staticmethod
    def _read_uptime() -> float:
        try:
            with open("/proc/uptime") as f:
                return float(f.read().split()[0])
        except (OSError, IndexError, ValueError):
            return 0.0

    @staticmethod
    def _read_throttled() -> int | None:
        try:
            r = subprocess.run(
                ["vcgencmd", "get_throttled"],
                capture_output=True,
                text=True,
                timeout=0.5,
            )
            if r.returncode != 0:
                return None
            # Output: "throttled=0x50000"
            _, _, hex_part = r.stdout.strip().partition("=")
            return int(hex_part, 16)
        except (FileNotFoundError, subprocess.TimeoutExpired, ValueError):
            return None

    @staticmethod
    def _read_disk_root() -> tuple[float, float, float]:
        """Return (total_gb, used_gb, used_pct) for /."""
        try:
            s = os.statvfs("/")
            total = s.f_blocks * s.f_frsize
            free = s.f_bavail * s.f_frsize
            used = total - free
            return (
                total / (1024**3),
                used / (1024**3),
                (used / total * 100) if total > 0 else 0.0,
            )
        except OSError:
            return (0.0, 0.0, 0.0)

    # ---------- main update ----------

    def update(self) -> None:
        now = time.time()

        # Aggregate CPU %
        cur = self._read_cpu_jiffies()
        prev = self._prev_cpu
        if cur and prev and len(cur) >= 5 and len(prev) >= 5:
            d_idle = (cur[3] - prev[3]) + (cur[4] - prev[4])  # idle + iowait
            d_total = sum(cur) - sum(prev)
            cpu_pct = max(0.0, min(100.0, (1.0 - d_idle / d_total) * 100.0)) if d_total > 0 else 0.0
        else:
            cpu_pct = 0.0
        self._prev_cpu = cur

        # Per-core %
        per_core_cur = self._read_per_core_jiffies()
        per_core: list[float] = []
        for i, core in enumerate(per_core_cur):
            if i < len(self._prev_per_core):
                prev_core = self._prev_per_core[i]
                if len(core) >= 5 and len(prev_core) >= 5:
                    d_idle = (core[3] - prev_core[3]) + (core[4] - prev_core[4])
                    d_total = sum(core) - sum(prev_core)
                    p = max(0.0, min(100.0, (1.0 - d_idle / d_total) * 100.0)) if d_total > 0 else 0.0
                    per_core.append(p)
        self._prev_per_core = per_core_cur

        # Memory
        meminfo = self._read_meminfo()
        total = meminfo.get("MemTotal", 0)
        available = meminfo.get("MemAvailable", 0)
        free = meminfo.get("MemFree", 0)
        used_pct = ((total - available) / total * 100) if total > 0 else 0.0

        # Throttled flags
        thr = self._read_throttled()
        flags: list[str] = []
        if thr is not None:
            for bit, label in THROTTLE_FLAGS.items():
                if thr & (1 << bit):
                    flags.append(label)

        # Disk (refresh every 30 s — slow call)
        if now >= self._disk_cache_until:
            self.stats.disk_total_gb, self.stats.disk_used_gb, self.stats.disk_pct = self._read_disk_root()
            self._disk_cache_until = now + 30.0

        self.stats.ts = now
        self.stats.cpu_percent = cpu_pct
        self.stats.cpu_per_core = per_core
        self.stats.temperature_c = self._read_temperature_c()
        self.stats.load_avg = self._read_loadavg()
        self.stats.cpu_count = os.cpu_count() or 0
        self.stats.uptime_s = self._read_uptime()
        self.stats.mem_total_kb = total
        self.stats.mem_available_kb = available
        self.stats.mem_free_kb = free
        self.stats.mem_used_pct = used_pct
        self.stats.throttled_raw = thr
        self.stats.throttled_flags = flags


system_monitor = SystemMonitor()
