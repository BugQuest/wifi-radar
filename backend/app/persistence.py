"""DuckDB persistence with rolling parquet partitions for long-term history."""
from __future__ import annotations
import asyncio
import json
import logging
import time
from pathlib import Path
import duckdb

from .event_bus import bus

log = logging.getLogger(__name__)


SCHEMA = """
CREATE TABLE IF NOT EXISTS sniff_events (
    ts          DOUBLE,
    kind        VARCHAR,
    src_mac     VARCHAR,
    dst_mac     VARCHAR,
    rssi        INTEGER,
    channel     INTEGER,
    length      INTEGER
);
CREATE TABLE IF NOT EXISTS csi_events (
    ts          DOUBLE,
    src_mac     VARCHAR,
    rssi        INTEGER,
    channel     INTEGER,
    csi_data    BLOB
);
-- Periodic scene snapshots for the history / replay UI.  payload is a JSON
-- doc containing devices[], sensors[], presence{} — anything Scene3D needs
-- to redraw the scene at an arbitrary past timestamp.  Cheap to query, easy
-- to evolve (just bump a schema_version inside the payload).
CREATE TABLE IF NOT EXISTS scene_snapshots (
    ts          DOUBLE PRIMARY KEY,
    payload     JSON
);
-- Presence state transitions only (active <-> inactive, or significant
-- centroid moves).  Used to populate the history list view without
-- decoding every snapshot.
CREATE TABLE IF NOT EXISTS presence_events (
    ts          DOUBLE,
    active      BOOLEAN,
    x           DOUBLE,
    z           DOUBLE,
    confidence  DOUBLE,
    sources     INTEGER,
    kind        VARCHAR    -- "enter" / "leave" / "move"
);
CREATE INDEX IF NOT EXISTS idx_sniff_ts ON sniff_events (ts);
CREATE INDEX IF NOT EXISTS idx_sniff_mac ON sniff_events (src_mac);
CREATE INDEX IF NOT EXISTS idx_csi_ts ON csi_events (ts);
CREATE INDEX IF NOT EXISTS idx_scene_ts ON scene_snapshots (ts);
CREATE INDEX IF NOT EXISTS idx_presence_ts ON presence_events (ts);
"""


class Persistence:
    """Buffers events and flushes periodically. Rolls to parquet hourly."""

    FLUSH_INTERVAL_SEC = 5.0
    PARQUET_ROLL_INTERVAL_SEC = 3600.0

    def __init__(self, db_path: Path, parquet_dir: Path) -> None:
        self.db_path = db_path
        self.parquet_dir = parquet_dir
        self.parquet_dir.mkdir(parents=True, exist_ok=True)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = duckdb.connect(str(db_path))
        self.conn.execute(SCHEMA)
        self._sniff_buf: list[tuple] = []
        self._csi_buf: list[tuple] = []
        # scene_snapshots and presence_events are smaller / less frequent, so we
        # buffer them in a single list each and flush with the rest.
        self._scene_buf: list[tuple] = []
        self._presence_buf: list[tuple] = []
        self._last_roll = time.time()
        self._lock = asyncio.Lock()

    def _on_sniff(self, ev: dict) -> None:
        self._sniff_buf.append((
            ev["ts"], ev.get("k", ""), ev.get("src", ""), ev.get("dst", ""),
            int(ev.get("rssi", 0)), int(ev.get("ch", 0)), int(ev.get("len", 0)),
        ))

    def _on_csi(self, ev: dict) -> None:
        data = ev.get("data", [])
        # Pack int8 list to bytes for compact storage.
        blob = bytes(b & 0xFF for b in data) if data else b""
        self._csi_buf.append((
            ev["ts"], ev.get("src", ""), int(ev.get("rssi", 0)),
            int(ev.get("ch", 0)), blob,
        ))

    def record_scene_snapshot(self, ts: float, payload: dict) -> None:
        """Queue a scene snapshot.  Called from state's maintenance loop."""
        self._scene_buf.append((ts, json.dumps(payload, separators=(",", ":"))))

    def record_presence_event(
        self, ts: float, active: bool, x: float, z: float,
        confidence: float, sources: int, kind: str,
    ) -> None:
        self._presence_buf.append((ts, active, x, z, confidence, sources, kind))

    async def _flush(self) -> None:
        async with self._lock:
            sb, cb = self._sniff_buf, self._csi_buf
            scb, pb = self._scene_buf, self._presence_buf
            self._sniff_buf, self._csi_buf = [], []
            self._scene_buf, self._presence_buf = [], []
        if sb:
            await asyncio.to_thread(
                self.conn.executemany,
                "INSERT INTO sniff_events VALUES (?,?,?,?,?,?,?)",
                sb,
            )
        if cb:
            await asyncio.to_thread(
                self.conn.executemany,
                "INSERT INTO csi_events VALUES (?,?,?,?,?)",
                cb,
            )
        if scb:
            # ON CONFLICT(ts) means a snapshot at the same timestamp updates
            # rather than erroring — harmless given the float ts uniqueness.
            await asyncio.to_thread(
                self.conn.executemany,
                "INSERT OR REPLACE INTO scene_snapshots VALUES (?, ?)",
                scb,
            )
        if pb:
            await asyncio.to_thread(
                self.conn.executemany,
                "INSERT INTO presence_events VALUES (?,?,?,?,?,?,?)",
                pb,
            )

    async def _maybe_roll(self) -> None:
        now = time.time()
        if now - self._last_roll < self.PARQUET_ROLL_INTERVAL_SEC:
            return
        cutoff = now - self.PARQUET_ROLL_INTERVAL_SEC
        ts_label = time.strftime("%Y%m%dT%H", time.gmtime(self._last_roll))
        try:
            sniff_file = self.parquet_dir / f"sniff_{ts_label}.parquet"
            csi_file = self.parquet_dir / f"csi_{ts_label}.parquet"
            await asyncio.to_thread(self.conn.execute,
                f"COPY (SELECT * FROM sniff_events WHERE ts < {cutoff}) TO '{sniff_file}' (FORMAT PARQUET, COMPRESSION ZSTD)")
            await asyncio.to_thread(self.conn.execute,
                f"COPY (SELECT * FROM csi_events WHERE ts < {cutoff}) TO '{csi_file}' (FORMAT PARQUET, COMPRESSION ZSTD)")
            await asyncio.to_thread(self.conn.execute, f"DELETE FROM sniff_events WHERE ts < {cutoff}")
            await asyncio.to_thread(self.conn.execute, f"DELETE FROM csi_events WHERE ts < {cutoff}")
            log.info("rolled parquet: %s, %s", sniff_file.name, csi_file.name)
        except Exception as e:
            log.warning("parquet roll failed: %s", e)
        self._last_roll = now

    async def consume(self) -> None:
        async for ev in bus.subscribe(replay_recent=False):
            t = ev.get("t")
            if t == "sniff":
                self._on_sniff(ev)
            elif t == "csi":
                self._on_csi(ev)

    async def flush_loop(self) -> None:
        while True:
            await asyncio.sleep(self.FLUSH_INTERVAL_SEC)
            try:
                await self._flush()
                await self._maybe_roll()
            except Exception as e:
                log.exception("flush failed: %s", e)

    def query(self, sql: str) -> list[dict]:
        return self.conn.execute(sql).fetchdf().to_dict(orient="records")


persistence: Persistence | None = None
