# ===================================================
# FASTAPI SERVER
# ===================================================

import os
import time
import json
import numpy as np

import asyncio
import uuid
import queue
import shutil
import io
from collections import defaultdict
from typing import Optional
from datetime import datetime

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse, Response
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from db import (
    init_db, upsert_job, get_job_from_db, get_all_jobs,
    delete_job as db_delete_job, upsert_scene, get_scenes_for_job,
    get_histograms_from_db,
)

# Import the core processing pipeline
import epm_core
from epm_core import (
    run_epm, 
    OUTPUT_DIR, 
    _STAGE_STYLE, 
    _DEFAULT_STYLE, 
    _USE_COLOR, 
    _BOLD, 
    _RESET, 
    _DIM
)

# ── App setup ─────────────────────────────────────────────────────────────────
import logging as _logging
# Suppress Uvicorn's verbose access logs
_logging.getLogger("uvicorn.access").setLevel(_logging.WARNING)

from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    # Aggressively terminate process on shutdown so GDAL C-threads don't become zombies
    import os
    os._exit(0)

app = FastAPI(title="EPM Backend", version="1.0.0", lifespan=lifespan)

_allowed_origins = os.environ.get("ALLOWED_ORIGINS", "*").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── In-memory job state ───────────────────────────────────────────────────────
# job_id → {"status": str, "error": str|None, "result": dict|None}
_job_state: dict[str, dict] = {}
# job_id → queue.Queue of log strings (for SSE)
_log_queues: dict[str, queue.Queue] = defaultdict(queue.Queue)
# job_id → cancel flag
_cancel_flags: dict[str, bool] = {}

# ── Pydantic models ───────────────────────────────────────────────────────────
class RunEpmRequest(BaseModel):
    aoi: dict
    aoi_name: Optional[str] = None
    start_date: str
    end_date: str
    max_cloud: int = 30
    provisional_job_id: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────────────
def _job_folder(job_id: str) -> str:
    return os.path.join(OUTPUT_DIR, job_id)


def _mosaic_folder(job_id: str, date: str) -> str:
    return os.path.join(_job_folder(job_id), str(date), "mosaic")


def _tif_path(job_id: str, date: str, layer: str) -> str:
    path = os.path.join(_mosaic_folder(job_id, date), f"{layer}.tif")
    if layer == "RPRI" and not os.path.isfile(path):
        legacy_path = os.path.join(_mosaic_folder(job_id, date), "RAQI.tif")
        if os.path.isfile(legacy_path):
            return legacy_path
    return path


def _get_job_dates_from_disk(job_id: str) -> list[str]:
    """Scan output folder for dates that have a histograms.json."""
    base = _job_folder(job_id)
    if not os.path.isdir(base):
        return []
    dates = []
    for entry in sorted(os.scandir(base), key=lambda e: e.name, reverse=True):
        if entry.is_dir():
            hfile = os.path.join(entry.path, "mosaic", "histograms.json")
            if os.path.isfile(hfile):
                dates.append(entry.name)
    return dates


def _route_log(job_id: str):
    """Return a log() replacement that also pushes to the SSE queue."""
    q = _log_queues[job_id]
    def _log(message, stage="INFO"):
        now   = time.strftime("%H:%M:%S")
        color, label = _STAGE_STYLE.get(stage.upper(), _DEFAULT_STYLE)
        if _USE_COLOR:
            badge     = f"{color}{_BOLD} {label} {_RESET}"
            timestamp = f"{_DIM}{now}{_RESET}"
            line      = f"{timestamp}  {badge}  {message}"
        else:
            line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] [{stage}] {message}"
        print(line, flush=True)
        # SSE consumers always receive the plain-text form (no ANSI)
        plain = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] [{stage}] {message}"
        q.put(plain)
    return _log


def _run_pipeline_sync(job_id: str, req: RunEpmRequest):
    """Blocking pipeline run — called in a thread-pool worker."""
    orig_log = epm_core.log
    routed   = _route_log(job_id)

    # Patch the module-level log in epm_core so pipeline functions emit to SSE queue
    epm_core.log = routed

    try:
        upsert_job(job_id, "running",
                   aoi_name=req.aoi_name, aoi=req.aoi,
                   start_date=req.start_date, end_date=req.end_date,
                   max_cloud=req.max_cloud)
        _job_state[job_id]["status"] = "running"

        result_id = run_epm(
            aoi_geojson=req.aoi,
            start_date=req.start_date,
            end_date=req.end_date,
            max_cloud=req.max_cloud,
            provisional_job_id=job_id,
            cancelled_fn=lambda: _cancel_flags.get(job_id, False),
        )

        if _cancel_flags.get(job_id):
            _job_state[job_id]["status"] = "cancelled"
            upsert_job(job_id, "cancelled")
            _log_queues[job_id].put("__done__")
            return

        if result_id is None:
            _job_state[job_id].update({"status": "aoi_error", "error": "No usable scenes found"})
            upsert_job(job_id, "aoi_error", error="No usable scenes found")
            _log_queues[job_id].put("__done__")
            return

        # Persist scenes to DB
        dates = _get_job_dates_from_disk(job_id)
        for d in dates:
            hpath = os.path.join(_mosaic_folder(job_id, d), "histograms.json")
            if os.path.isfile(hpath):
                with open(hpath) as f:
                    hdata = json.load(f)
                upsert_scene(job_id, d, 1, hdata, _mosaic_folder(job_id, d))

        upsert_job(job_id, "done")
        _job_state[job_id].update({"status": "done", "result": {"job_id": job_id}})

    except Exception as exc:
        err = str(exc)
        _job_state[job_id].update({"status": "error", "error": err})
        upsert_job(job_id, "error", error=err)
        routed(f"Pipeline error: {err}", "ERROR")
    finally:
        epm_core.log = orig_log
        _log_queues[job_id].put("__done__")
        _cancel_flags.pop(job_id, None)


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/")
def health():
    return {"status": "ok", "service": "EPM Backend"}


@app.get("/health")
def health_detail():
    return {"status": "ok", "db": "sqlite"}


@app.post("/prepare-job")
def prepare_job():
    job_id = "job_" + datetime.now().strftime("%Y%m%d%H%M%S") + "_" + uuid.uuid4().hex[:6]
    _job_state[job_id] = {"status": "pending", "error": None, "result": None}
    _log_queues[job_id]  # init queue
    return {"job_id": job_id}


@app.post("/run-epm")
async def run_epm_endpoint(req: RunEpmRequest, background_tasks: BackgroundTasks):
    job_id = req.provisional_job_id
    if not job_id:
        job_id = "job_" + datetime.now().strftime("%Y%m%d%H%M%S") + "_" + uuid.uuid4().hex[:6]

    _job_state[job_id] = {"status": "running", "error": None, "result": None}

    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _run_pipeline_sync, job_id, req)

    return {"job_id": job_id, "status": "started"}


@app.get("/job-status/{job_id}")
def job_status(job_id: str):
    state = _job_state.get(job_id)
    if state:
        return state
    # Fall back to DB
    row = get_job_from_db(job_id)
    if row:
        return {"status": row["status"], "error": row.get("error"), "result": {"job_id": job_id}}
    raise HTTPException(404, "Job not found")


@app.get("/logs/{job_id}")
async def stream_logs(job_id: str):
    q = _log_queues[job_id]

    async def generator():
        loop = asyncio.get_event_loop()
        while True:
            try:
                line = await loop.run_in_executor(None, lambda: q.get(timeout=30))
                if line == "__done__":
                    yield {"data": "__done__"}
                    return
                yield {"data": line}
            except queue.Empty:
                # Send a keepalive ping if no logs are produced within the timeout
                yield {"event": "ping", "data": "keepalive"}
            except Exception:
                yield {"data": "__done__"}
                return

    return EventSourceResponse(generator())


@app.get("/job-dates/{job_id}")
def job_dates(job_id: str):
    disk_dates = set(_get_job_dates_from_disk(job_id))
    # Try DB first
    scenes = get_scenes_for_job(job_id)
    if scenes:
        dates = [s["scene_date"] for s in scenes if s["scene_date"] in disk_dates]
        if dates:
            return {"job_id": job_id, "dates": dates}
    # Fallback: scan disk
    dates = sorted(list(disk_dates))
    if not dates:
        raise HTTPException(404, "No output dates found for job")
    return {"job_id": job_id, "dates": dates}


@app.get("/histograms/{job_id}/{date}")
def histograms(job_id: str, date: str):
    # Try DB first
    h = get_histograms_from_db(job_id, date)
    if h:
        return h
    # Fallback: read file
    hpath = os.path.join(_mosaic_folder(job_id, date), "histograms.json")
    if not os.path.isfile(hpath):
        raise HTTPException(404, "Histograms not found")
    with open(hpath) as f:
        return json.load(f)


@app.get("/bounds/{job_id}/{date}/{layer}")
def bounds(job_id: str, date: str, layer: str):
    tif = _tif_path(job_id, date, layer)
    if not os.path.isfile(tif):
        raise HTTPException(404, "TIF not found")
    import rasterio
    from rasterio.warp import transform_bounds
    with rasterio.open(tif) as src:
        b = transform_bounds(src.crs, "EPSG:4326", *src.bounds)
    return {"xmin": b[0], "ymin": b[1], "xmax": b[2], "ymax": b[3]}


@app.get("/tif/{job_id}/{date}/{layer}")
def download_tif(job_id: str, date: str, layer: str):
    tif = _tif_path(job_id, date, layer)
    if not os.path.isfile(tif):
        raise HTTPException(404, "TIF not found")
    return FileResponse(tif, media_type="image/tiff",
                        headers={"Content-Disposition": f"attachment; filename={layer}_{date}.tif"})


def _get_visualization_params(layer: str, valid_arr: np.ndarray) -> tuple[float, float, str]:
    """Return (vmin, vmax, cmap_name) tailored to the specific scientific index."""
    import numpy as np
    l = layer.upper()
    
    if "CLUSTER" in l:
        from matplotlib.colors import ListedColormap
        return 0.0, 4.0, ListedColormap(["#22c55e", "#84cc16", "#eab308", "#f97316", "#ef4444"])

    # RPRI is already normalized to [0, 1] with fixed empirical bounds.
    # Using a fixed colormap range ensures consistent appearance across
    # scenes and tiles — a 0.3 RPRI always looks the same color.
    if "RPRI" in l:
        return 0.0, 1.0, "plasma"

    vmin = float(np.nanpercentile(valid_arr, 2))
    vmax = float(np.nanpercentile(valid_arr, 98))
    if vmax == vmin:
        vmax = vmin + 1e-6
        
    if "NDVI" in l or "NDRE" in l or "SAVI" in l:
        cmap = "YlGn"
    elif "EVI" in l:
        cmap = "viridis"
    elif "NDMI" in l:
        cmap = "Blues"
    elif "NDWI" in l:
        cmap = "GnBu"
    elif "MNDWI" in l:
        cmap = "PuBu"
    elif "NBR" in l:
        cmap = "RdYlGn" # Burned is red (low), healthy is green (high)
    elif "NDTI" in l:
        cmap = "YlOrBr" # Turbid is brown (high)
    elif "NDBAI" in l:
        cmap = "OrRd" # Built-up is red (high)
    else:
        cmap = "RdYlBu_r"
        
    return vmin, vmax, cmap


@app.get("/tiles/{job_id}/{date}/{layer}/{z}/{x}/{y}.png")
def tile(job_id: str, date: str, layer: str, z: int, x: int, y: int):
    import math
    import warnings
    import rasterio
    from rasterio.warp import reproject, Resampling
    from rasterio.crs import CRS
    from rasterio.transform import from_bounds as _from_bounds
    from PIL import Image
    import matplotlib.cm as cm
    import matplotlib.colors as mcolors

    tif = _tif_path(job_id, date, layer)
    if not os.path.isfile(tif):
        raise HTTPException(404, "TIF not found")

    # Tile bounds in WGS-84
    def _tile_bounds(z, x, y):
        n = 2 ** z
        west  = x / n * 360 - 180
        east  = (x + 1) / n * 360 - 180
        north = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
        south = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
        return west, south, east, north

    TILE_SIZE = 256
    west, south, east, north = _tile_bounds(z, x, y)

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        with rasterio.open(tif) as src:
            dst_crs  = CRS.from_epsg(4326)
            dst_tf   = _from_bounds(west, south, east, north, TILE_SIZE, TILE_SIZE)
            dst_arr  = np.full((TILE_SIZE, TILE_SIZE), np.nan, dtype=np.float32)
            reproject(
                source=rasterio.band(src, 1),
                destination=dst_arr,
                dst_transform=dst_tf,
                dst_crs=dst_crs,
                resampling=Resampling.nearest,
                dst_nodata=np.nan,
            )

    valid = dst_arr[np.isfinite(dst_arr)]
    if valid.size == 0:
        # Return transparent tile
        img = Image.new("RGBA", (TILE_SIZE, TILE_SIZE), (0, 0, 0, 0))
    else:
        vmin, vmax, cmap_obj = _get_visualization_params(layer, valid)
        cmap = cmap_obj if not isinstance(cmap_obj, str) else cm.get_cmap(cmap_obj)
        norm_arr = np.clip((dst_arr - vmin) / (vmax - vmin), 0, 1)
        rgba     = cmap(norm_arr)  # H×W×4 float [0,1]
        alpha    = np.where(np.isfinite(dst_arr), 200, 0).astype(np.uint8)
        rgba_u8  = (rgba[:, :, :3] * 255).astype(np.uint8)
        arr_rgba = np.dstack([rgba_u8, alpha])
        img      = Image.fromarray(arr_rgba, "RGBA")

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return Response(content=buf.read(), media_type="image/png",
                    headers={"Cache-Control": "public, max-age=3600"})


@app.get("/preview/{job_id}/{date}/{layer}")
def preview(job_id: str, date: str, layer: str):
    """Full-raster PNG preview (downsampled)."""
    import warnings
    import rasterio
    from rasterio.warp import Resampling
    from PIL import Image
    import matplotlib.cm as cm

    tif = _tif_path(job_id, date, layer)
    if not os.path.isfile(tif):
        raise HTTPException(404, "TIF not found")

    MAX_DIM = 1024
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        with rasterio.open(tif) as src:
            h, w = src.height, src.width
            scale = min(1.0, MAX_DIM / max(h, w))
            outh, outw = max(1, int(h * scale)), max(1, int(w * scale))
            arr = src.read(1, out=np.empty((outh, outw), dtype=np.float32),
                           resampling=Resampling.nearest)

    valid = arr[np.isfinite(arr)]
    if valid.size == 0:
        img = Image.new("RGBA", (outw, outh), (0, 0, 0, 0))
    else:
        vmin, vmax, cmap_obj = _get_visualization_params(layer, valid)
        cmap  = cmap_obj if not isinstance(cmap_obj, str) else cm.get_cmap(cmap_obj)
        normd = np.clip((arr - vmin) / (vmax - vmin), 0, 1)
        rgba  = cmap(normd)
        alpha = np.where(np.isfinite(arr), 220, 0).astype(np.uint8)
        rgb8  = (rgba[:, :, :3] * 255).astype(np.uint8)
        img   = Image.fromarray(np.dstack([rgb8, alpha]), "RGBA")

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return Response(content=buf.read(), media_type="image/png")


@app.get("/tsa/{job_id}")
def tsa(job_id: str):
    """Time-series analysis: per-date mean of each index + cloud coverage."""
    scenes = get_scenes_for_job(job_id)
    if not scenes:
        raise HTTPException(404, "No scenes for job")
    
    disk_dates = set(_get_job_dates_from_disk(job_id))
    series = {}
    cloud_pct = {}
    valid_pct = {}
    for sc in scenes:
        d = sc["scene_date"]
        if d not in disk_dates:
            continue
        h = sc.get("histograms") or {}
        # Extract scene metadata (cloud coverage, valid coverage)
        meta = h.get("_meta") or {}
        if meta.get("cloud_pct") is not None:
            cloud_pct[d] = meta["cloud_pct"]
        if meta.get("valid_pct") is not None:
            valid_pct[d] = meta["valid_pct"]
        for idx, hdata in h.items():
            if idx.startswith("_"):
                continue
            series.setdefault(idx, []).append({
                "date": d,
                "mean": hdata.get("mean"),
                "std": hdata.get("std"),
                "min": hdata.get("min"),
                "max": hdata.get("max")
            })
    # Sort each series by date ascending
    for idx in series:
        series[idx].sort(key=lambda r: r["date"])
    return {
        "job_id": job_id,
        "series": series,
        "cloud_pct": cloud_pct,
        "valid_pct": valid_pct,
    }


@app.get("/jobs")
def list_jobs():
    rows = get_all_jobs()
    valid_rows = []
    for r in rows:
        # Keep active jobs, or completed jobs that still have physical outputs
        if r["status"] in ("running", "pending"):
            valid_rows.append(r)
        elif os.path.isdir(_job_folder(r["id"])):
            valid_rows.append(r)
    return {"jobs": valid_rows}


@app.get("/jobs/{job_id}")
def get_job(job_id: str):
    row = get_job_from_db(job_id)
    if not row:
        raise HTTPException(404, "Job not found")
    return row


@app.post("/cancel-job/{job_id}")
def cancel_job(job_id: str):
    if job_id not in _job_state:
        raise HTTPException(404, "Job not found or not running")
    _cancel_flags[job_id] = True
    return {"job_id": job_id, "cancelled": True}


@app.delete("/job/{job_id}")
def delete_job_endpoint(job_id: str):
    import shutil
    db_delete_job(job_id)
    _job_state.pop(job_id, None)
    _cancel_flags.pop(job_id, None)
    # Remove output folder
    folder = _job_folder(job_id)
    if os.path.isdir(folder):
        shutil.rmtree(folder, ignore_errors=True)
    return {"job_id": job_id, "deleted": True}