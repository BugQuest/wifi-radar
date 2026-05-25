"""CSI-based presence and motion detection.

For each sensor we keep a rolling buffer of its most recent CSI samples and
compute the temporal variance per subcarrier — i.e. how much the channel
response between that sensor and its CSI source is fluctuating. A still
environment has near-zero variance ; a moving body produces multi-subcarrier
fluctuations correlated across nearby sensors.

The activity is summed across subcarriers to give one scalar per sensor. We
then weight each sensor's position by its activity to estimate a "presence
centroid" on the floor. Pearson correlation across sensors tells us whether
the activity is consistent (real motion) or local noise on one sensor.
"""
from __future__ import annotations
import math
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any


WINDOW_SAMPLES = 30          # CSI samples per sensor for variance computation
ACTIVITY_HISTORY_LEN = 30    # samples for cross-sensor correlation
HISTORY_TRAIL_SEC = 30.0     # how long to keep the presence trail
NOISE_FLOOR = 30.0           # activity below this is treated as no motion
MAX_ACTIVITY = 500.0         # activity above this normalizes to intensity 1.0

# --- Floor heatmap parameters ---
HEATMAP_SIZE = 40            # cells per side → 1600 cells total
HEATMAP_EXTENT_M = 10.0      # ±10 m, so each cell ≈ 0.5 m
HEATMAP_DECAY = 0.012        # per-tick decay (half-life ≈ 57 ticks @ 1 Hz ≈ 1 min)
HEATMAP_SPLAT_SIGMA = 1.5    # gaussian splat sigma in cells


@dataclass
class PresenceState:
    sensor_activity: dict[str, float] = field(default_factory=dict)
    position: tuple[float, float] | None = None       # (x, z) in meters
    intensity: float = 0.0                            # 0..1
    correlation: float = 0.0                          # -1..1 (typically 0..1 with motion)
    history: deque = field(default_factory=lambda: deque(maxlen=240))
    last_update: float = 0.0
    # heatmap[i][j] : accumulated intensity at cell (i, j) where i is x-axis, j is z-axis
    heatmap: list[list[float]] = field(
        default_factory=lambda: [[0.0] * HEATMAP_SIZE for _ in range(HEATMAP_SIZE)]
    )
    heatmap_max: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        # Quantize heatmap to int8 [0..127] for compact transport. Max is computed
        # over the current grid so the colormap auto-scales as motion grows/decays.
        m = self.heatmap_max if self.heatmap_max > 0 else 1.0
        flat: list[int] = []
        for row in self.heatmap:
            for v in row:
                q = int(min(127, max(0, v / m * 127)))
                flat.append(q)
        return {
            "sensor_activity": dict(self.sensor_activity),
            "position": {"x": self.position[0], "z": self.position[1]} if self.position else None,
            "intensity": self.intensity,
            "correlation": self.correlation,
            "history": [
                {"ts": t, "x": x, "z": z, "i": i} for (t, x, z, i) in self.history
            ],
            "last_update": self.last_update,
            "heatmap": {
                "size": HEATMAP_SIZE,
                "extent_m": HEATMAP_EXTENT_M,
                "max": self.heatmap_max,
                "values": flat,
            },
        }


def _amp(data: list[int], k: int) -> float:
    """Amplitude of subcarrier k from interleaved (imag, real) int8 buffer."""
    if 2 * k + 1 >= len(data):
        return 0.0
    return math.sqrt(data[2 * k] * data[2 * k] + data[2 * k + 1] * data[2 * k + 1])


def _variance(samples: list[list[int]]) -> float:
    """Mean per-subcarrier temporal variance over a window of CSI samples."""
    if len(samples) < 2:
        return 0.0
    sc_count = min(64, min(len(s) for s in samples) // 2)
    if sc_count == 0:
        return 0.0
    total = 0.0
    counted = 0
    for k in range(sc_count):
        amps = [_amp(s, k) for s in samples]
        m = sum(amps) / len(amps)
        v = sum((a - m) ** 2 for a in amps) / len(amps)
        total += v
        counted += 1
    return total / max(1, counted)


def _pearson(a: list[float], b: list[float]) -> float:
    n = min(len(a), len(b))
    if n < 3:
        return 0.0
    ma = sum(a[-n:]) / n
    mb = sum(b[-n:]) / n
    num = sum((a[-n + i] - ma) * (b[-n + i] - mb) for i in range(n))
    da = math.sqrt(sum((a[-n + i] - ma) ** 2 for i in range(n)))
    db = math.sqrt(sum((b[-n + i] - mb) ** 2 for i in range(n)))
    if da < 1e-9 or db < 1e-9:
        return 0.0
    return num / (da * db)


class PresenceDetector:
    def __init__(self) -> None:
        # Per-sensor rolling CSI samples (raw data arrays)
        self.csi_buf: dict[str, deque[list[int]]] = {}
        # Per-sensor activity score history
        self.activity_hist: dict[str, deque[float]] = {}
        self.state = PresenceState()

    def on_csi(self, sid: str, data: list[int]) -> None:
        buf = self.csi_buf.setdefault(sid, deque(maxlen=WINDOW_SAMPLES))
        buf.append(list(data))

    def update(self, sensors_by_id: dict[str, Any]) -> None:
        """Recompute activity, presence centroid, history. Call ~1/s."""
        now = time.time()
        activity: dict[str, float] = {}
        for sid, buf in self.csi_buf.items():
            activity[sid] = _variance(list(buf)) if len(buf) >= 5 else 0.0

        # Update per-sensor activity history (for correlation)
        for sid, a in activity.items():
            h = self.activity_hist.setdefault(sid, deque(maxlen=ACTIVITY_HISTORY_LEN))
            h.append(a)

        # Compute presence centroid as activity-weighted sensor positions
        active = [
            (sid, a - NOISE_FLOOR)
            for sid, a in activity.items()
            if a > NOISE_FLOOR and sid in sensors_by_id
        ]
        if active:
            w_total = sum(w for _, w in active)
            cx = sum(w * sensors_by_id[sid].position_x for sid, w in active) / w_total
            cz = sum(w * sensors_by_id[sid].position_z for sid, w in active) / w_total
            max_a = max(activity.values()) if activity else 0.0
            intensity = max(0.0, min(1.0, (max_a - NOISE_FLOOR) / MAX_ACTIVITY))
            self.state.position = (cx, cz)
            self.state.intensity = intensity
            self.state.history.append((now, cx, cz, intensity))
        else:
            self.state.position = None
            self.state.intensity = 0.0

        # Trim history older than HISTORY_TRAIL_SEC
        cutoff = now - HISTORY_TRAIL_SEC
        while self.state.history and self.state.history[0][0] < cutoff:
            self.state.history.popleft()

        # Cross-sensor correlation over their activity histories
        hists = [list(h) for h in self.activity_hist.values() if len(h) >= 5]
        if len(hists) >= 2:
            pairs = []
            for i in range(len(hists)):
                for j in range(i + 1, len(hists)):
                    pairs.append(_pearson(hists[i], hists[j]))
            self.state.correlation = sum(pairs) / len(pairs) if pairs else 0.0
        else:
            self.state.correlation = 0.0

        self.state.sensor_activity = activity
        self.state.last_update = now

        # --- Floor heatmap update: decay then gaussian-splat current presence ---
        grid = self.state.heatmap
        decay = 1.0 - HEATMAP_DECAY
        new_max = 0.0
        for row in grid:
            for k in range(len(row)):
                row[k] *= decay
                if row[k] > new_max:
                    new_max = row[k]
        if self.state.position and self.state.intensity > 0.05:
            x, z = self.state.position
            # World → grid index : center cell at origin
            cx = (x + HEATMAP_EXTENT_M) / (2.0 * HEATMAP_EXTENT_M) * HEATMAP_SIZE
            cz = (z + HEATMAP_EXTENT_M) / (2.0 * HEATMAP_EXTENT_M) * HEATMAP_SIZE
            ci = int(cx)
            cj = int(cz)
            sigma2 = 2.0 * HEATMAP_SPLAT_SIGMA * HEATMAP_SPLAT_SIGMA
            for di in range(-3, 4):
                for dj in range(-3, 4):
                    ii = ci + di
                    jj = cj + dj
                    if 0 <= ii < HEATMAP_SIZE and 0 <= jj < HEATMAP_SIZE:
                        fx = (ii + 0.5) - cx
                        fz = (jj + 0.5) - cz
                        w = math.exp(-(fx * fx + fz * fz) / sigma2)
                        grid[ii][jj] += self.state.intensity * w
                        if grid[ii][jj] > new_max:
                            new_max = grid[ii][jj]
        self.state.heatmap_max = new_max


presence_detector = PresenceDetector()
