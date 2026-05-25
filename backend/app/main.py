"""FastAPI app entrypoint."""
from __future__ import annotations
import asyncio
import glob
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import persistence as p_mod
from .persistence import Persistence
from .serial_reader import run_serial
from .state import state
from . import oui
from . import config as config_mod
from .api import router as api_router
from .ws import router as ws_router

log = logging.getLogger("radar")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

# RADAR_SERIAL can be a comma-separated list of devices, or a glob like /dev/ttyUSB*.
# Default: auto-discover everything matching /dev/ttyUSB*.
SERIAL_DEVICE = os.environ.get("RADAR_SERIAL", "")
SERIAL_BAUD = int(os.environ.get("RADAR_BAUD", "921600"))
DATA_DIR = Path(os.environ.get("RADAR_DATA", str(Path.home() / "wifi-radar-data")))
STATIC_DIR = Path(os.environ.get("RADAR_STATIC", str(Path(__file__).resolve().parent.parent / "static")))


def discover_serial_devices() -> list[str]:
    if SERIAL_DEVICE:
        # Explicit list or glob pattern
        parts = [p.strip() for p in SERIAL_DEVICE.split(",") if p.strip()]
        resolved: list[str] = []
        for p in parts:
            if any(c in p for c in "*?["):
                resolved.extend(sorted(glob.glob(p)))
            else:
                resolved.append(p)
        return resolved
    found = sorted(glob.glob("/dev/ttyUSB*"))
    return found or ["/dev/ttyUSB0"]  # fall back to default, even if absent (will retry)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await oui.warm_up()
    p_mod.persistence = Persistence(DATA_DIR / "radar.duckdb", DATA_DIR / "parquet")
    config_mod.init(DATA_DIR)

    devices = discover_serial_devices()
    log.info("serial devices discovered: %s", devices)

    tasks = [
        asyncio.create_task(state.consume(), name="state-consume"),
        asyncio.create_task(state.maintenance_loop(), name="state-maint"),
        asyncio.create_task(p_mod.persistence.consume(), name="persist-consume"),
        asyncio.create_task(p_mod.persistence.flush_loop(), name="persist-flush"),
    ]
    for dev in devices:
        tasks.append(asyncio.create_task(run_serial(dev, SERIAL_BAUD), name=f"serial-{dev}"))

    log.info("started %d background tasks (%d serial readers)", len(tasks), len(devices))
    try:
        yield
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(title="WiFi Radar", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(api_router, prefix="/api")
app.include_router(ws_router)

if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
else:
    log.warning("static dir %s does not exist — frontend not served", STATIC_DIR)
