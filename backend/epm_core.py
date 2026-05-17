import multiprocessing
import os
import time
import json
import warnings
import gc
import numpy as np
import threading
import rasterio
from rasterio.errors import NotGeoreferencedWarning
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from functools import partial
from rasterio.warp import reproject, Resampling, transform_geom
from pystac_client import Client
from shapely.geometry import shape, mapping
from shapely.wkt import dumps, loads
from scipy.ndimage import binary_dilation
from scipy.stats import spearmanr
from rasterio.crs import CRS
from rasterio.transform import from_bounds


STAC_URL    = "https://earth-search.aws.element84.com/v1"
COLLECTION  = "sentinel-2-c1-l2a"
OUTPUT_DIR  = "output"

os.makedirs(OUTPUT_DIR, exist_ok=True)

BANDS      = ["red", "nir", "green", "blue", "rededge1", "swir16", "swir22", "scl"]
REFL_BANDS = {"red", "nir", "green", "blue", "rededge1", "swir16", "swir22"}

BAD_SCL_CLASSES    = {0, 1, 2, 3, 8, 9, 10, 11}
BAD_SCL_ARRAY      = np.array(sorted(BAD_SCL_CLASSES), dtype=np.int16)
NODATA_FLOAT       = float("nan")

# Minimum fraction of AOI pixels that must be valid for a date to be written
MIN_VALID_FRACTION = 0.1
INDEX_CHUNK_ROWS   = 128   # row-chunk size for chunked index computation

# ── HTTP CONCURRENCY ───────────────────────────────
# One slot per band download.  The semaphore prevents GDAL's internal
# connection pool from being overwhelmed; 12 gives every band a slot
# with headroom for retries without deadlocking when all 8 bands retry
# simultaneously.  Each acquire/release wraps only the GDAL open+read,
# not the Python retry sleep, so slots are never held while waiting.
MAX_TOTAL_HTTP  = 32
HTTP_SEMAPHORE  = threading.Semaphore(MAX_TOTAL_HTTP)

# ── ALGORITHM SETTINGS ─────────────────────────────
GMM_N_COMPONENTS = 5
GMM_N_INIT      = 1
GMM_MAX_ITER    = 80

# Retry delays (seconds) for Python-level retry loop.
# GDAL handles transient per-range-request drops internally (MAX_RETRY above).
# These delays are for complete session failures where we reconnect from scratch.
RETRY_DELAYS = [10, 25, 60]
# ===================================================
# LOGGING
# ===================================================

import logging as _logging
_epm_logger = _logging.getLogger("epm_core")

_USE_COLOR = hasattr(__import__("sys"), "stdout") and __import__("sys").stdout.isatty()

_RESET  = "\033[0m"   if _USE_COLOR else ""
_BOLD   = "\033[1m"   if _USE_COLOR else ""
_DIM    = "\033[2m"   if _USE_COLOR else ""

_STAGE_STYLE: dict = {
    "INFO":    ("\033[38;5;75m",  "INFO  "),
    "STAC":    ("\033[38;5;147m", "STAC  "),
    "MASK":    ("\033[38;5;180m", "MASK  "),
    "DATE":    ("\033[38;5;220m", "DATE  "),
    "TILES":   ("\033[38;5;114m", "TILES "),
    "TILE":    ("\033[38;5;150m", "TILE  "),
    "CLOUD":   ("\033[38;5;117m", "CLOUD "),
    "MOSAIC":  ("\033[38;5;183m", "MOSAIC"),
    "INDICES": ("\033[38;5;159m", "INDEX "),
    "RPRI":    ("\033[38;5;222m", "RPRI  "),
    "CLUSTER": ("\033[38;5;210m", "CLUST "),
    "WRITE":   ("\033[38;5;189m", "WRITE "),
    "HIST":    ("\033[38;5;152m", "HIST  "),
    "CANCEL":  ("\033[38;5;214m", "CANCEL"),
    "WARN":    ("\033[38;5;214m", "WARN  "),
    "WARNING": ("\033[38;5;214m", "WARN  "),
    "ERROR":   ("\033[38;5;203m", "ERROR "),
    "ERR":     ("\033[38;5;203m", "ERROR "),
    "DEBUG":   ("\033[38;5;240m", "DEBUG "),
}
_DEFAULT_STYLE = ("\033[38;5;75m" if _USE_COLOR else "", "INFO  ")

def log(message, stage="INFO"):
    now   = time.strftime("%H:%M:%S")
    color, label = _STAGE_STYLE.get(stage.upper(), _DEFAULT_STYLE)

    if _USE_COLOR:
        badge     = f"{color}{_BOLD} {label} {_RESET}"
        timestamp = f"{_DIM}{now}{_RESET}"
        line      = f"{timestamp}  {badge}  {message}"
    else:
        line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] [{stage}] {message}"

    print(line, flush=True)

    level = _logging.WARNING if stage in ("WARN", "WARNING") else \
            _logging.ERROR   if stage in ("ERROR", "ERR")    else \
            _logging.INFO
    _epm_logger.log(level, "[%s] %s", stage, message)

def elapsed(t):
    return round(time.time() - t, 2)

def nanmedian_chunked(arrays, chunk_size=512):
    if not arrays:
        return None
    H, W = arrays[0].shape
    out = np.full((H, W), np.nan, dtype=np.float32)
    for i in range(0, H, chunk_size):
        for j in range(0, W, chunk_size):
            chunk_stack = np.stack([a[i:i+chunk_size, j:j+chunk_size] for a in arrays], axis=0)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", category=RuntimeWarning)
                out[i:i+chunk_size, j:j+chunk_size] = np.nanmedian(chunk_stack, axis=0)
    return out


def choose_parallelism(total_pixels: int, scene_count: int) -> tuple[int, int]:
    if total_pixels >= 20_000_000:
        date_workers = min(scene_count, 2)
    elif total_pixels >= 12_000_000:
        date_workers = min(scene_count, 3)
    else:
        date_workers = min(multiprocessing.cpu_count(), scene_count)
    band_workers = len(BANDS)
    return max(1, date_workers), max(1, band_workers)


# ===================================================
# GDAL VSI CACHE CLEAR
# ===================================================

import ctypes as _ctypes

def _load_gdal_lib():
    """
    Locate rasterio's bundled GDAL shared library via its .libs directory,
    pre-load all bundled .so files (so symbol dependencies resolve), then
    return the GDAL handle.  Falls back to system libgdal if the bundled
    directory is absent (e.g. conda environments).
    """
    try:
        import rasterio as _rio
        # rasterio stores bundled .so files in a directory called
        # "<package_dir>.libs" (Linux wheel convention).
        libs_dir = os.path.join(os.path.dirname(_rio.__file__) + ".libs")
        if os.path.isdir(libs_dir):
            # First pass: load all .so files to satisfy cross-library deps
            for fname in sorted(os.listdir(libs_dir)):
                fpath = os.path.join(libs_dir, fname)
                if fname.endswith(".so") or ".so." in fname:
                    try:
                        _ctypes.CDLL(fpath, mode=_ctypes.RTLD_GLOBAL)
                    except OSError:
                        pass
            # Second pass: return the GDAL handle specifically
            for fname in sorted(os.listdir(libs_dir)):
                if "gdal" in fname.lower() and (".so" in fname):
                    try:
                        return _ctypes.CDLL(os.path.join(libs_dir, fname))
                    except OSError:
                        pass
    except Exception:
        pass

    # Fallback: system libgdal (conda, apt-installed, etc.)
    for name in ["libgdal.so", "libgdal.so.36", "libgdal.so.34",
                 "libgdal.so.32", "libgdal.so.30"]:
        try:
            return _ctypes.CDLL(name)
        except OSError:
            pass
    return None

_GDAL_LIB = _load_gdal_lib()
_gdal_partial_clear = None
_gdal_full_clear    = None

if _GDAL_LIB is not None:
    try:
        _gdal_partial_clear = _GDAL_LIB.VSICurlPartialClearCache
        _gdal_partial_clear.restype  = None
        _gdal_partial_clear.argtypes = [_ctypes.c_char_p]
    except AttributeError:
        _gdal_partial_clear = None
    try:
        _gdal_full_clear = _GDAL_LIB.VSICurlClearCache
        _gdal_full_clear.restype  = None
        _gdal_full_clear.argtypes = []
    except AttributeError:
        _gdal_full_clear = None
else:
    log("⚠ GDAL shared library not found — VSI cache clearing disabled", "WARN")


def _clear_vsi_cache(url: str):
    """
    Clear the GDAL VSI curl cache for one URL (or globally as fallback).
    Called before each retry to evict any poisoned partial cache entries
    that would cause the next attempt to return corrupt/empty data.
    """
    try:
        if _gdal_partial_clear is not None:
            _gdal_partial_clear(url.encode("utf-8"))
        elif _gdal_full_clear is not None:
            _gdal_full_clear()
    except Exception:
        pass


# ===================================================
# AOI NORMALIZATION
# ===================================================

def normalize_aoi(aoi_geojson):
    if aoi_geojson["type"] == "FeatureCollection":
        geom = shape(aoi_geojson["features"][0]["geometry"])
    elif aoi_geojson["type"] == "Feature":
        geom = shape(aoi_geojson["geometry"])
    else:
        geom = shape(aoi_geojson)
    return dumps(geom)

# ===================================================
# TARGET GRID
# ===================================================

def build_target_profile(aoi_wkt, target_res_m=10):
    from pyproj import Transformer
    geom_wgs84 = loads(aoi_wkt)
    minx, miny, maxx, maxy = geom_wgs84.bounds

    lon_c = (minx + maxx) / 2
    lat_c = (miny + maxy) / 2
    zone  = int((lon_c + 180) / 6) + 1
    hemi  = "north" if lat_c >= 0 else "south"
    utm_crs = CRS.from_dict({"proj": "utm", "zone": zone, hemi: True, "ellps": "WGS84"})

    tr = Transformer.from_crs("EPSG:4326", utm_crs, always_xy=True)
    ux_min, uy_min = tr.transform(minx, miny)
    ux_max, uy_max = tr.transform(maxx, maxy)

    ux_min = (ux_min // target_res_m) * target_res_m
    uy_max = ((uy_max // target_res_m) + 1) * target_res_m
    ux_max = ((ux_max // target_res_m) + 1) * target_res_m
    uy_min = (uy_min // target_res_m) * target_res_m

    width  = int(round((ux_max - ux_min) / target_res_m))
    height = int(round((uy_max - uy_min) / target_res_m))
    transform = from_bounds(ux_min, uy_min, ux_max, uy_max, width, height)

    return {
        "driver":    "GTiff",
        "dtype":     "float32",
        "nodata":    float("nan"),
        "width":     width,
        "height":    height,
        "count":     1,
        "crs":       utm_crs,
        "transform": transform,
    }


# ===================================================
# AOI POLYGON MASK — thread-safe cache
# ===================================================

_aoi_mask_cache: dict = {}
_aoi_mask_lock = threading.Lock()

def build_aoi_polygon_mask(aoi_wkt, ref_profile):
    from rasterio.features import geometry_mask
    from rasterio.warp import transform_geom as _tg

    tf = ref_profile["transform"]
    cache_key = (aoi_wkt, ref_profile["height"], ref_profile["width"],
                 tuple(round(x, 6) for x in (tf.a, tf.b, tf.c, tf.d, tf.e, tf.f)))

    with _aoi_mask_lock:
        if cache_key in _aoi_mask_cache:
            return _aoi_mask_cache[cache_key]

    geom_wgs84 = loads(aoi_wkt)
    raster_crs = ref_profile["crs"]

    try:
        if hasattr(raster_crs, "to_epsg") and raster_crs.to_epsg():
            dst_crs = f"EPSG:{raster_crs.to_epsg()}"
        elif hasattr(raster_crs, "to_wkt"):
            dst_crs = raster_crs.to_wkt()
        else:
            dst_crs = str(raster_crs)
    except Exception:
        dst_crs = str(raster_crs)

    geom_proj = shape(_tg("EPSG:4326", dst_crs, mapping(geom_wgs84)))
    H = ref_profile["height"]
    W = ref_profile["width"]

    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=NotGeoreferencedWarning)
        outside = geometry_mask(
            [geom_proj],
            out_shape=(H, W),
            transform=ref_profile["transform"],
            invert=False,
            all_touched=False,
        )
    result = ~outside

    with _aoi_mask_lock:
        _aoi_mask_cache[cache_key] = result
    return result


def apply_aoi_mask(arr, aoi_wkt, ref_profile):
    try:
        inside = build_aoi_polygon_mask(aoi_wkt, ref_profile)
        masked = arr.copy()
        masked[~inside] = np.nan
        clipped_px = int((~inside).sum())
        log(f"  AOI polygon mask: {clipped_px:,} px clipped outside polygon", "MASK")
        return masked
    except Exception as e:
        log(f"  AOI polygon mask failed ({e}) — using unmasked array", "MASK")
        return arr


# ===================================================
# GDAL ENVIRONMENT
# ===================================================
# Key differences from the broken version:
#
#  1. GDAL_HTTP_MAX_RETRY = 0   — disables GDAL's own internal retry loop.
#     Without this, GDAL silently retries inside rasterio.open() *and* our
#     Python loop also retries, producing confusing double-retry logs and
#     consuming far more time than intended before a failure surfaces.
#
#  2. VSI_CACHE_SIZE = 80_000_000 (80 MB) — the old 20 MB was split across
#     8 simultaneous band fetches (~2.5 MB each).  A single Sentinel-2 COG
#     tile for a small AOI can exceed that, causing cache thrashing and
#     TIFFReadEncodedTile errors that look like network failures.
#
#  3. GDAL_HTTP_TIMEOUT / CONNECTTIMEOUT left generous — retries handle
#     actual hangs; we don't want spurious timeouts on slow connections.
#
_GDAL_ENV = dict(
    GDAL_DISABLE_READDIR_ON_OPEN       = "EMPTY_DIR",
    CPL_VSIL_CURL_ALLOWED_EXTENSIONS   = ".tif,.tiff",
    CPL_VSIL_CURL_USE_HEAD             = "NO",      # Save a roundtrip per file
    GDAL_HTTP_MERGE_CONSECUTIVE_RANGES = "YES",     # Fewer, larger range requests
    VSI_CACHE                          = True,
    VSI_CACHE_SIZE                     = 80_000_000,
    AWS_NO_SIGN_REQUEST                = "YES",
    GDAL_HTTP_TIMEOUT                  = 600,       # 10m bands on slow connections need massive headroom
    GDAL_HTTP_CONNECTTIMEOUT           = 60,
    GDAL_HTTP_MAX_RETRY                = 5,         # Aggressively resume dropped chunks
    GDAL_HTTP_RETRY_DELAY              = 5,
    GDAL_HTTP_VERSION                  = "2",
    GDAL_HTTP_MULTIPLEX                = "YES",
    GDAL_INGESTED_BYTES_AT_OPEN        = "32768",
)


# ===================================================
# FETCH BAND — with NotGeoreferencedWarning suppression
# ===================================================

def quick_scl_check(href, aoi_wkt):
    from rasterio.enums import Resampling
    from rasterio.windows import from_bounds as window_from_bounds
    geom = loads(aoi_wkt)
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=NotGeoreferencedWarning)
        with rasterio.Env(**_GDAL_ENV):
            with rasterio.open(href) as src:
                geom_proj = shape(transform_geom("EPSG:4326", src.crs, mapping(geom)))
                window = window_from_bounds(*geom_proj.bounds, transform=src.transform)
                window = window.round_lengths().round_offsets()
                out = src.read(
                    1,
                    window=window,
                    out_shape=(256, 256),
                    resampling=Resampling.nearest,
                    boundless=True, fill_value=-1
                )
                scl_safe = out.astype(np.int16)
                cloud_frac = np.isin(scl_safe, BAD_SCL_ARRAY).sum() / out.size
                return cloud_frac

def clip_band(asset_href, aoi_wkt, target_profile=None):
    """
    Read one band from a remote COG into the target grid.

    Uses WarpedVRT so GDAL fetches only the source tiles that contribute
    to the target extent + CRS in a single read() call.
    """
    from rasterio.windows import from_bounds as _wfb
    from rasterio.warp import reproject, Resampling
    from shapely.geometry import box

    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=NotGeoreferencedWarning)
        with rasterio.Env(**_GDAL_ENV), rasterio.open(asset_href) as src:

            if target_profile is None:
                geom     = loads(aoi_wkt)
                geom_proj = shape(transform_geom("EPSG:4326", src.crs, mapping(geom)))
                window   = _wfb(*geom_proj.bounds, transform=src.transform)
                window   = window.round_lengths().round_offsets()
                clipped  = src.read(1, window=window, boundless=True, fill_value=0)
                tf       = src.window_transform(window)
                prof     = src.profile.copy()
                prof.update(height=clipped.shape[0], width=clipped.shape[1], transform=tf)
                band = clipped.astype(np.float32)
                if np.ma.is_masked(band):
                    band = np.where(np.ma.getmaskarray(band), np.nan, band.data)
                return band, prof

            # FAST IN-MEMORY REPROJECTION INSTEAD OF WARPEDVRT
            H, W = target_profile["height"], target_profile["width"]
            target_bounds = rasterio.transform.array_bounds(H, W, target_profile["transform"])
            
            geom_proj = shape(transform_geom(target_profile["crs"], src.crs, mapping(box(*target_bounds))))
            from rasterio.windows import from_bounds as _wfb, Window
            window = _wfb(*geom_proj.bounds, transform=src.transform)
            window = window.round_lengths().round_offsets()
            # Pad by 2 pixels to prevent edge artifacts during bilinear resampling
            window = Window(window.col_off - 2, window.row_off - 2, window.width + 4, window.height + 4) 
            
            raw_data = src.read(1, window=window, boundless=True, fill_value=0)
            raw_tf = src.window_transform(window)

            dst_data = np.full((H, W), np.nan, dtype=np.float32)
            reproject(
                source=raw_data,
                destination=dst_data,
                src_transform=raw_tf,
                src_crs=src.crs,
                dst_transform=target_profile["transform"],
                dst_crs=target_profile["crs"],
                resampling=Resampling.bilinear,
                src_nodata=0,
                dst_nodata=np.nan,
            )

    return dst_data, target_profile


# ===================================================
# CLOUD MASK
# ===================================================

def apply_cloud_mask(band_data):
    if "scl" not in band_data:
        return band_data
    scl = band_data["scl"]
    if not isinstance(scl, np.ndarray):
        log("SCL band malformed, skipping cloud mask", "CLOUD")
        return band_data

    scl_safe = np.where(np.isfinite(scl), scl, -1).astype(np.int16)
    mask_bad  = np.isin(scl_safe, BAD_SCL_ARRAY)
    mask_bad  = binary_dilation(mask_bad, iterations=2)
    masked_px = int(mask_bad.sum())
    total_px  = mask_bad.size
    log(f"Cloud mask  {masked_px:,} / {total_px:,} px  ({100*masked_px/total_px:.1f}%)", "CLOUD")

    for band in band_data:
        band_data[band][mask_bad] = np.nan
    return band_data


# ===================================================
# TILE PROCESSING
# ===================================================

class TileSkipped(Exception):
    pass

# Shared GDAL environment for all band fetches.
# GDAL_HTTP_MAX_RETRY=3: GDAL silently retries individual HTTP range requests
# that drop mid-download (critical for large 10m Sentinel-2 bands which can
# take 60-120s on a slow connection). Python retry loop is the outer fallback
# for complete session failures.
# (Removed duplicate _GDAL_ENV definition)

def _probe_gdal_env():
    """
    Quick sanity-check: open a tiny public S3 COG to verify that the GDAL
    environment (auth, VSI curl, network) is actually working before we
    submit any band fetches.  Logs WARN on failure but does not abort —
    it's diagnostic only so the operator can see the real exception message.
    """
    _PROBE_URL = (
        "https://sentinel-cogs.s3.us-west-2.amazonaws.com/"
        "sentinel-s2-l2a-cogs/44/P/LV/2023/3/"
        "S2A_T44PLV_20230312T050711_L2A/B02.tif"
    )
    try:
        with rasterio.Env(**_GDAL_ENV):
            with rasterio.open(_PROBE_URL) as src:
                _ = src.profile          # metadata only, no pixel fetch
        log("GDAL env probe  ✓  S3/VSI curl reachable", "INFO")
    except Exception as exc:
        log(
            f"GDAL env probe  ✗  [{type(exc).__name__}] {str(exc)[:200]}  "
            f"— band downloads will likely fail too", "WARN"
        )


def _fetch_band_with_retry(band: str, href: str, aoi_wkt: str, target_profile: dict) -> tuple:
    """
    Download one band with retry + VSI cache clearing on failure.

    Critical design points:
    - Each attempt opens its own rasterio.Env — NEVER nested inside another
      Env.  On Windows, nested Env contexts do not stack correctly and
      thread workers lose GDAL config keys (AWS_NO_SIGN_REQUEST etc.).
    - The HTTP_SEMAPHORE is acquired only around the actual GDAL read, NOT
      around the retry sleep, to prevent deadlock when all bands fail and
      retry simultaneously.
    - _clear_vsi_cache(href) is called before each retry to evict poisoned
      partial cache entries left by the failed attempt.
    - GDAL_HTTP_MAX_RETRY=0 in _GDAL_ENV means GDAL surfaces failures
      immediately; this loop is the sole retry mechanism.
    """
    t_start    = time.time()
    last_exc   = None
    n_attempts = len(RETRY_DELAYS) + 1

    log(f"  ↓ {band}", "TILE")

    for attempt in range(n_attempts):
        try:
            with HTTP_SEMAPHORE:
                with rasterio.Env(**_GDAL_ENV):
                    arr, _ = clip_band(href, aoi_wkt, target_profile)
            return band, arr.astype(np.float32), elapsed(t_start)
        except Exception as exc:
            last_exc = exc
            if attempt >= n_attempts - 1:
                break
            wait = RETRY_DELAYS[attempt]
            # Always log the full exception type + message for diagnosability
            log(
                f"  ↻ {band}  attempt {attempt + 1}/{n_attempts - 1}  "
                f"[{type(exc).__name__}] {str(exc)[:120]}  retrying in {wait}s",
                "TILE",
            )
            _clear_vsi_cache(href)
            time.sleep(wait)
            _clear_vsi_cache(href)

    raise last_exc


def process_tile(item_dict, *, aoi_wkt, target_profile, n_tiles=1, band_workers=None):
    """
    Download all bands for one Sentinel-2 tile.

    All bands are submitted simultaneously.  SCL is awaited first for the
    early cloud check; other bands continue downloading in parallel.
    """
    tile_start = time.time()
    tile_id    = item_dict["id"]
    log(f"Tile  {tile_id}", "TILE")

    H = target_profile["height"]
    W = target_profile["width"]

    ordered_bands = ["scl"] + [b for b in BANDS if b != "scl"]

    _alias_rev = {}
    assets = item_dict.get("assets", {})
    for asset_key, asset_val in assets.items():
        href = asset_val.get("href") if isinstance(asset_val, dict) else None
        if not href:
            continue
        common = asset_key
        if common in BANDS and common not in _alias_rev:
            _alias_rev[common] = href

    all_hrefs = {
        b: _alias_rev[b]
        for b in ordered_bands if b in _alias_rev
    }

    missing = [b for b in BANDS if b not in _alias_rev]
    if len(_alias_rev) < 5:
        log(f"Assets: {list(assets.keys())}", "DEBUG")
        raise Exception("Too many missing bands")
    elif missing:
        log(f"  ⚠ missing bands: {missing}", "TILE")
    else:
        log(f"  ✓ bands resolved", "TILE")

    # Respect the band_workers argument passed from main.py to prevent AWS throttling
    _tile_workers = min(band_workers or 8, len(all_hrefs))

    band_data: dict = {}

    # ── No outer rasterio.Env here ────────────────────────────────────────
    # Each call to quick_scl_check and _fetch_band_with_retry opens its own
    # rasterio.Env(**_GDAL_ENV).  On Windows, nested Env contexts do NOT
    # stack — the inner env overrides the outer one, and thread workers
    # spawned inside the outer context do not reliably inherit its config.
    # Keeping each Env self-contained is the only safe pattern on Windows.

    scl_href = all_hrefs.get("scl")
    if scl_href:
        try:
            t_check = time.time()
            log(f"  ☁ SCL cloud pre-check...", "TILE")
            cloud_frac = quick_scl_check(scl_href, aoi_wkt)
            log(f"  ☁ cloud pre-check  {100 * cloud_frac:.1f}%  ({elapsed(t_check)}s)", "TILE")
            if cloud_frac > 0.7:
                log(f"  ✗ {tile_id}  {100 * cloud_frac:.1f}% cloudy  —  skipping", "TILE")
                raise TileSkipped(f"{tile_id}: {100 * cloud_frac:.1f}% cloud cover")
        except TileSkipped:
            raise
        except Exception as exc:
            log(f"  ⚠ cloud pre-check failed ({exc})  —  proceeding", "TILE")

    t_bands = time.time()
    band_ex = ThreadPoolExecutor(max_workers=_tile_workers)
    try:
        futures = {
            band_ex.submit(_fetch_band_with_retry, b, h, aoi_wkt, target_profile): b
            for b, h in all_hrefs.items()
        }

        for f in as_completed(futures):
            b = futures[f]
            try:
                _, arr, t = f.result()
                band_data[b] = arr
                log(f"  ✓ {b:<12} {t}s", "TILE")
            except Exception as exc:
                log(f"  ✗ {b}  failed ({type(exc).__name__}: {exc})  —  NaN fill", "TILE")
                band_data[b] = np.full((H, W), np.nan, dtype=np.float32)

        log(f"  ✓ all bands  ({elapsed(t_bands)}s)", "TILE")

    finally:
        band_ex.shutdown(wait=False, cancel_futures=True)

    # ── Diagnose all-NaN result before cloud-masking ──────────────────────
    # If every band is NaN, the most likely cause is a persistent network or
    # GDAL environment issue rather than cloud cover.  Emit a clear warning
    # so the operator can distinguish "real clouds" from "download failure".
    sample_band = next((v for v in band_data.values() if isinstance(v, np.ndarray)), None)
    if sample_band is not None and not np.any(np.isfinite(sample_band)):
        log(
            f"  ⚠ ALL bands are NaN after download — this is likely a network/GDAL "
            f"issue, not cloud cover.  Check connectivity and GDAL env.", "WARN"
        )

    band_data = apply_cloud_mask(band_data)
    log(f"  tile done  ({elapsed(tile_start)}s)", "TILE")
    return {"bands": band_data, "profile": target_profile}


# ===================================================
# INDEX ENGINE
# ===================================================

def compute_indices(refl_bands):
    log("Spectral indices...", "INDICES")
    t_all = time.time()

    def _band(name):
        arr = refl_bands.get(name)
        if arr is None:
            log(f"  ⚠ band '{name}' missing  —  NaN fill", "INDICES")
            ref = next(iter(refl_bands.values()))
            return np.full(ref.shape, np.nan, dtype=np.float32)
        return arr

    red     = _band("red")
    nir     = _band("nir")
    green   = _band("green")
    blue    = _band("blue")
    swir1   = _band("swir16")
    swir2   = _band("swir22")
    rededge = _band("rededge1")

    H, W = red.shape

    def _row_chunks():
        for row0 in range(0, H, INDEX_CHUNK_ROWS):
            yield row0, min(H, row0 + INDEX_CHUNK_ROWS)

    def _norm_diff(A, B, name):
        t = time.time()
        log(f"  {name}...", "INDICES")
        out = np.full((H, W), np.nan, dtype=np.float32)
        valid_count = 0
        for row0, row1 in _row_chunks():
            a = A[row0:row1]
            b = B[row0:row1]
            den = a + b
            mask = np.isfinite(a) & np.isfinite(b) & np.isfinite(den) & (den != 0)
            num = a - b
            out[row0:row1].fill(np.nan)
            np.divide(num, den, out=out[row0:row1], where=mask)
            valid_count += int(mask.sum())
        log(f"  {name:<6} valid={valid_count:,}  ({elapsed(t)}s)", "INDICES")
        return out

    NDVI  = _norm_diff(nir,   red,     "NDVI")
    NDRE  = _norm_diff(nir,   rededge, "NDRE")
    NDMI  = _norm_diff(nir,   swir1,   "NDMI")
    NDWI  = _norm_diff(green, nir,     "NDWI")
    MNDWI = _norm_diff(green, swir1,   "MNDWI")
    NBR   = _norm_diff(nir,   swir2,   "NBR")
    NDTI  = _norm_diff(swir1, swir2,   "NDTI")
    NDBAI = _norm_diff(swir2, nir,     "NDBAI")
    NDBI  = _norm_diff(swir1, nir,     "NDBI")

    t = time.time()
    log("  SAVI...", "INDICES")
    SAVI = np.full((H, W), np.nan, dtype=np.float32)
    savi_valid = 0
    for row0, row1 in _row_chunks():
        nir_c = nir[row0:row1]
        red_c = red[row0:row1]
        den = nir_c + red_c + 0.5
        mask = np.isfinite(nir_c) & np.isfinite(red_c) & np.isfinite(den) & (den != 0)
        num = (nir_c - red_c) * 1.5
        SAVI[row0:row1].fill(np.nan)
        np.divide(num, den, out=SAVI[row0:row1], where=mask)
        savi_valid += int(mask.sum())
    log(f"  SAVI   valid={savi_valid:,}  ({elapsed(t)}s)", "INDICES")

    t = time.time()
    log("  EVI...", "INDICES")
    EVI = np.full((H, W), np.nan, dtype=np.float32)
    evi_valid = 0
    for row0, row1 in _row_chunks():
        nir_c = nir[row0:row1]
        red_c = red[row0:row1]
        blue_c = blue[row0:row1]
        den = nir_c + 6.0 * red_c - 7.5 * blue_c + 1.0
        mask = np.isfinite(nir_c) & np.isfinite(red_c) & np.isfinite(blue_c) & np.isfinite(den) & (np.abs(den) > 1e-4)
        num = (nir_c - red_c) * 2.5
        EVI[row0:row1].fill(np.nan)
        np.divide(num, den, out=EVI[row0:row1], where=mask)
        evi_valid += int(mask.sum())
    log(f"  EVI    valid={evi_valid:,}  ({elapsed(t)}s)", "INDICES")

    indices = {
        "NDVI": NDVI, "NDRE": NDRE, "SAVI": SAVI, "EVI": EVI,
        "NDMI": NDMI, "NDWI": NDWI, "MNDWI": MNDWI,
        "NBR":  NBR,  "NDTI": NDTI, "NDBAI": NDBAI, "NDBI": NDBI,
    }
    log(f"Indices done  ({elapsed(t_all)}s)", "INDICES")
    return indices


# ===================================================
# RPRI — PCA over environmental stress indices
# ===================================================

# Polarity map: which direction indicates MORE pollution?
#   +1 = index goes UP when pollution increases
#   -1 = index goes DOWN when pollution increases
_RPRI_INVERT_MAP = {
    "NDTI":  +1,   # turbidity ↑  → sediment/effluent in water
    "NDBAI": +1,   # bare/built-up ↑ → industrial surface
    "NDBI":  +1,   # built-up ↑ → impervious/industrial surface
    "NDWI":  +1,   # water presence ↑ → expanded effluent/flood footprint
    "NBR":   -1,   # burn ratio ↓ (disturbed land) → more stressed
    "NDVI":  -1,   # vegetation health ↓ → degraded cover
    "NDMI":  -1,   # canopy moisture ↓ → desiccation/stress
    "MNDWI": -1,   # MNDWI ↓ → turbid/polluted water (SWIR reflectance ↑)
    "SAVI":  -1,   # soil-adjusted vegetation ↓ → sparse/dead cover
    "EVI":   -1,   # enhanced vegetation ↓ → degraded canopy
    "NDRE":  -1,   # red-edge chlorophyll ↓ → early stress
}


# NDBI is excluded from RPRI groups because NDBI = −NDMI (mathematically
# identical up to sign).  Including both would make PCA absorb a redundant
# pair instead of genuine environmental variance.  NDBI is still computed
# as a standalone index for display on the Indices tab.
_GROUPS = {
    'eco': ['NDVI', 'EVI', 'SAVI', 'NDRE', 'NDMI', 'NBR'],
    'ind': ['NDBAI'],
    'wat': ['NDTI', 'MNDWI', 'NDWI']
}

# Fixed empirical bounds for Sentinel-2 L2A surface reflectance indices.
# These replace per-scene percentile scaling so RPRI is an absolute,
# cross-date and cross-AOI comparable metric.
_EMPIRICAL_BOUNDS = {
    'NDVI':  (-0.2, 0.8),   'EVI':   (-0.2, 0.8),   'SAVI':  (-0.2, 0.8),
    'NDRE':  (-0.2, 0.8),   'NDMI':  (-0.5, 0.6),   'NBR':   (-0.5, 0.8),
    'NDBAI': (-0.4, 0.4),   'NDBI':  (-0.4, 0.4),   'NDTI':  (-0.2, 0.4),
    'MNDWI': (-0.5, 0.6),   'NDWI':  (-0.5, 0.5),
}

def compute_rpri(indices):
    """
    Remote Pollution Risk Index (RPRI) — PCA-based composite.

    Uses fixed empirical bounds (not per-scene percentiles) so the output
    is an absolute, cross-date and cross-AOI comparable metric.

    Steps:
      1. Scale each spectral index to [0, 1] using literature-derived
         empirical bounds (_EMPIRICAL_BOUNDS), with polarity inversion
         so that 1 always means "more polluted".
      2. Average indices within three thematic groups (eco, ind, wat).
      3. PCA on the 3-group scores → PC1 captures the dominant axis
         of environmental stress variance.
      4. Min-max normalise the raw PC1 to [0, 1] using the theoretical
         range of the group scores (0 to 1) rather than scene percentiles.
    """
    t = time.time()
    log("RPRI  (v3: fixed empirical bounds + PCA)...", "RPRI")

    H, W = next(iter(indices.values())).shape

    # 1. Scale indices using fixed empirical bounds
    scaled = {}
    for k, arr in indices.items():
        pol = _RPRI_INVERT_MAP.get(k)
        if pol is None:
            continue   # skip indices not in the RPRI model

        lo, hi = _EMPIRICAL_BOUNDS.get(k, (-1.0, 1.0))
        valid_mask = np.isfinite(arr)

        if not valid_mask.any():
            scaled[k] = np.zeros_like(arr)
            continue

        score = np.clip((arr - lo) / (hi - lo), 0.0, 1.0)

        # Invert so 1 = more polluted
        if pol == -1:
            score = 1.0 - score

        scaled[k] = score

    # 2. Compute group averages
    def get_group(group_name):
        keys = [k for k in _GROUPS[group_name] if k in scaled]
        if not keys:
            return np.zeros((H, W), dtype=np.float32)
        stack = np.stack([scaled[k] for k in keys], axis=0)
        return np.nanmean(stack, axis=0)

    eco = get_group('eco')
    ind = get_group('ind')
    wat = get_group('wat')

    from sklearn.decomposition import PCA

    # 3. PCA — extract primary axis of environmental stress
    stack = np.stack([eco, ind, wat], axis=-1)
    valid_mask = np.all(np.isfinite(stack), axis=-1)

    RPRI = np.full((H, W), np.nan, dtype=np.float32)
    pca_meta = {}   # will be returned alongside the raster
    if valid_mask.any():
        X = stack[valid_mask]
        pca = PCA(n_components=1)
        pc1 = pca.fit_transform(X)[:, 0]

        # Ensure correct polarity: higher PC1 → higher general stress
        if np.corrcoef(pc1, X.sum(axis=1))[0, 1] < 0:
            pc1 = -pc1

        # 4. Normalise PC1 to [0, 1] using global min/max of this projection
        pc_min = float(pc1.min())
        pc_max = float(pc1.max())
        if pc_max > pc_min:
            pc1 = (pc1 - pc_min) / (pc_max - pc_min)
        else:
            pc1 = np.zeros_like(pc1)

        RPRI[valid_mask] = pc1.astype(np.float32)

        # PCA diagnostics — persisted into histograms.json for the frontend
        ev = float(pca.explained_variance_ratio_[0])
        loadings = pca.components_[0].tolist()
        pca_meta = {
            "explained_variance": round(ev, 4),
            "loadings": {
                "eco": round(loadings[0], 4),
                "ind": round(loadings[1], 4),
                "wat": round(loadings[2], 4),
            },
            "groups": {k: v for k, v in _GROUPS.items()},
        }
        log(f"  PCA  explained_var={ev:.3f}  loadings=[eco={loadings[0]:.3f}, ind={loadings[1]:.3f}, wat={loadings[2]:.3f}]", "RPRI")

    # Mask pixels that had no valid spectral data
    base_mask = np.isfinite(next(iter(indices.values())))
    RPRI[~base_mask] = np.nan

    v_count = int(base_mask.sum())
    if v_count > 0:
        mn_v = float(np.nanmin(RPRI))
        mx_v = float(np.nanmax(RPRI))
        mean_v = float(np.nanmean(RPRI))
        log(f"  RPRI  valid={v_count:,}  mean={mean_v:.4f}  min={mn_v:.4f}  max={mx_v:.4f}  ({elapsed(t)}s)", "RPRI")
    else:
        log("  RPRI  valid=0 pixels", "RPRI")

    return RPRI, pca_meta



# ===================================================
# HISTOGRAM — single-pass stats
# ===================================================

def generate_histogram(arr, bins=50):
    valid = arr[np.isfinite(arr)]
    if valid.size == 0:
        return {}
    hist, bin_edges = np.histogram(valid, bins=bins)
    vmin  = float(valid.min())
    vmax  = float(valid.max())
    vmean = float(valid.mean())
    vstd  = float(valid.std())
    return {
        "bins":      bin_edges.tolist(),
        "frequency": hist.tolist(),
        "mean":      vmean,
        "std":       vstd,
        "min":       vmin,
        "max":       vmax,
    }


# ===================================================
# CLUSTERING — GMM on RPRI values
# ===================================================

def compute_clusters(indices):
    from sklearn.mixture import GaussianMixture

    log(f"GMM clustering (5D feature space, k={GMM_N_COMPONENTS})...", "CLUSTER")
    t = time.time()

    features = ["NDVI", "NDMI", "NDBI", "NDWI", "NDTI"]
    available = [f for f in features if f in indices]
    
    if not available:
        shape = next(iter(indices.values())).shape
        return np.full(shape, np.nan, dtype=np.float32), []

    stack = np.stack([indices[f] for f in available], axis=-1)
    valid_mask = np.all(np.isfinite(stack), axis=-1)
    n_valid = int(valid_mask.sum())
    
    shape = stack.shape[:2]

    if n_valid == 0:
        log("No valid pixels  —  skipping clustering", "CLUSTER")
        return np.full(shape, np.nan, dtype=np.float32), []

    valid_vals = stack[valid_mask].astype(np.float64)
    GMM_MAX_SAMPLES = 20_000
    if n_valid > GMM_MAX_SAMPLES:
        rng = np.random.default_rng(seed=42)
        idx = rng.choice(n_valid, size=GMM_MAX_SAMPLES, replace=False)
        fit_vals = valid_vals[idx]
        log(f"  Subsampled {GMM_MAX_SAMPLES:,} / {n_valid:,} px for 5D GMM fit", "CLUSTER")
    else:
        fit_vals = valid_vals

    gmm = GaussianMixture(
        n_components=GMM_N_COMPONENTS,
        covariance_type='full',
        n_init=GMM_N_INIT,
        max_iter=GMM_MAX_ITER,
        random_state=42,
    )
    gmm.fit(fit_vals)

    raw_centroids = gmm.means_
    # Map 5D centroids to a 1D severity rank (0=Green, 4=Red)
    if "NDBI" in available and "NDVI" in available:
        ndbi_idx = available.index("NDBI")
        ndvi_idx = available.index("NDVI")
        severity_score = raw_centroids[:, ndbi_idx] - raw_centroids[:, ndvi_idx]
    else:
        severity_score = raw_centroids.sum(axis=1)
        
    order = np.argsort(severity_score)
    rank = np.empty_like(order)
    rank[order] = np.arange(GMM_N_COMPONENTS)
    
    centroids_sorted = severity_score[order].tolist()
    log(f"  Centroid Severity Scores  {[f'{c:.4f}' for c in centroids_sorted]}", "CLUSTER")

    raw_labels = gmm.predict(valid_vals)
    new_labels = rank[raw_labels].astype(np.float32)

    cluster_map = np.full(shape, np.nan, dtype=np.float32)
    cluster_map[valid_mask] = new_labels

    for i in range(GMM_N_COMPONENTS):
        count = int((new_labels == i).sum())
        log(f"  Class {i}  severity={centroids_sorted[i]:.4f}  {count:,} px  ({100*count/n_valid:.1f}%)", "CLUSTER")

    log(f"Clustering done  ({elapsed(t)}s)", "CLUSTER")
    return cluster_map, centroids_sorted


# ===================================================
# WRITE COG-READY FLOAT32
# ===================================================

_COG_OVERVIEWS = [2, 4, 8, 16]


def choose_overviews(profile):
    longest_edge = max(int(profile["width"]), int(profile["height"]))
    if longest_edge >= 4500:
        return [2, 4, 8]
    return _COG_OVERVIEWS

def write_cog_float32(path, arr, profile):
    p = profile.copy()
    p.update(
        dtype="float32", count=1, nodata=NODATA_FLOAT,
        driver="GTiff",
        compress="DEFLATE", predictor=2,
        tiled=True, blockxsize=256, blockysize=256,
        BIGTIFF="IF_SAFER",
        NUM_THREADS="ALL_CPUS",
        ZLEVEL=1,
    )
    t = time.time()
    overviews = choose_overviews(profile)
    with rasterio.open(path, "w", **p) as dst:
        dst.write(arr.astype(np.float32, copy=False), 1)
        dst.build_overviews(overviews, rasterio.enums.Resampling.average)
        dst.update_tags(ns="rio_overview", resampling="average")
    kb = os.path.getsize(path) / 1024
    log(f"  {os.path.basename(path)}  {kb:.0f} KB  ({elapsed(t)}s)", "WRITE")


def _write_index(args):
    name, arr, mosaic_folder, target_profile = args
    if name != "RPRI" and name != "pollution_clusters":
        mn, mx = INDEX_RANGES.get(name, (-1.0, 1.0))
        arr = np.clip(arr, mn, mx)
    write_cog_float32(os.path.join(mosaic_folder, f"{name}.tif"), arr, target_profile)
    return name, generate_histogram(arr)


# ===================================================
# SAFE NORMALIZATION
# ===================================================

INDEX_RANGES = {
    "SAVI":  (-1.5, 1.5),
    "EVI":   (-1.0, 1.0),
}

def normalize_index(arr, name=None):
    mn, mx = INDEX_RANGES.get(name, (-1.0, 1.0))
    if not np.any(np.isfinite(arr)):
        return np.full_like(arr, np.nan)
    clipped = np.clip(arr, mn, mx)
    return (clipped - mn) / (mx - mn)


# ===================================================
# MAIN PIPELINE
# ===================================================

def run_epm(aoi_geojson, start_date, end_date, max_cloud=30, provisional_job_id=None, cancelled_fn=None):
    pipeline_start = time.time()

    job_id     = provisional_job_id or datetime.now().strftime("job_%Y%m%d%H%M%S")
    job_folder = os.path.join(OUTPUT_DIR, job_id)
    os.makedirs(job_folder, exist_ok=True)

    cpu_count = multiprocessing.cpu_count()

    log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    log("EPM PIPELINE  STARTED")
    log(f"  Job ID    │ {job_id}")
    log(f"  Dates     │ {start_date}  →  {end_date}")
    log(f"  Max Cloud │ {max_cloud}%")
    log(f"  CPUs      │ {cpu_count}")
    log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

    log("Querying STAC catalog...", "STAC")
    stac_start = time.time()
    catalog = Client.open(STAC_URL)
    search  = catalog.search(
        collections=[COLLECTION],
        intersects=aoi_geojson,
        datetime=f"{start_date}/{end_date}",
        query={"eo:cloud_cover": {"lte": max_cloud}},
    )
    items = list(search.items())
    log(f"Found {len(items)} scene(s)  ({elapsed(stac_start)}s)", "STAC")

    if not items:
        log("No scenes found. Job terminated.", "ERROR")
        return None

    grouped = {}
    for item in items:
        d = item.datetime.date()
        grouped.setdefault(d, []).append(item)
    dates_sorted = sorted(grouped.keys())
    log(f"Unique dates: {len(grouped)}  →  {[str(d) for d in dates_sorted]}")

    aoi_wkt        = normalize_aoi(aoi_geojson)
    target_profile = build_target_profile(aoi_wkt, target_res_m=10)
    H = target_profile["height"]
    W = target_profile["width"]
    log(f"Target grid  {W} × {H} px  ({W*H:,} px total)  CRS=EPSG:{target_profile['crs'].to_epsg()}")

    try:
        aoi_inside  = build_aoi_polygon_mask(aoi_wkt, target_profile)
        aoi_outside = ~aoi_inside
        log(f"AOI mask  {int(aoi_inside.sum()):,} px valid  /  {int(aoi_outside.sum()):,} px outside polygon", "MASK")
    except Exception as e:
        log(f"AOI mask failed ({e})  →  falling back to bbox", "MASK")
        aoi_inside  = np.ones((H, W), dtype=bool)
        aoi_outside = np.zeros((H, W), dtype=bool)

    dates_written = 0

    # ── Process each date: download → mosaic → indices → RPRI → write ────

    for date_idx, date in enumerate(dates_sorted, 1):
        scenes     = grouped[date]
        date_start = time.time()

        log(f"──────────────────────────────────────────────")
        log(f"Date {date_idx}/{len(grouped)}  ·  {date}  ({len(scenes)} scene{'s' if len(scenes) != 1 else ''})", "DATE")
        log(f"[DATE_PROGRESS] {date_idx}/{len(grouped)}", "DATE")
        log(f"──────────────────────────────────────────────")

        if cancelled_fn and cancelled_fn():
            log("Job cancelled by user  —  pipeline stopped.", "CANCEL")
            return None

        n_workers, band_workers = choose_parallelism(W * H, len(scenes))
        log(f"Downloading tiles  (tile workers={n_workers}  band workers={band_workers})", "TILES")
        tiles_t    = time.time()
        item_dicts = [item.to_dict() for item in scenes]
        _proc      = partial(process_tile, aoi_wkt=aoi_wkt, target_profile=target_profile,
                             n_tiles=len(item_dicts), band_workers=band_workers)

        results = []
        with ThreadPoolExecutor(max_workers=n_workers) as ex:
            futures = {ex.submit(_proc, d): d["id"] for d in item_dicts}
            for future in as_completed(futures):
                tid = futures[future]
                try:
                    results.append(future.result())
                except TileSkipped as e:
                    log(f"Skipped (too cloudy): {e}", "TILES")
                except Exception as e:
                    log(f"Failed  {tid}: {e}", "TILES")

        log(f"Tiles done  {len(results)}/{len(scenes)} usable  ({elapsed(tiles_t)}s)", "TILES")

        if not results:
            log(f"All tiles cloudy for {date}  →  skipping", "DATE")
            continue

        log(f"Grid  {W} × {H} px  ({W*H:,} total)", "TILES")

        # ── CHUNKED MEDIAN COMPOSITE ──────────────────────────────
        log("Building median composite mosaic...", "MOSAIC")
        mosaic_t = time.time()

        tile_bands = [r["bands"] for r in results]

        mosaic_bands = {}
        for band in REFL_BANDS:
            arrays = [tb[band] for tb in tile_bands if band in tb]
            if arrays:
                mosaic_bands[band] = nanmedian_chunked(arrays, chunk_size=INDEX_CHUNK_ROWS)
            else:
                mosaic_bands[band] = np.full((H, W), np.nan, dtype=np.float32)

        ref_band = list(REFL_BANDS)[0]
        all_nan = np.isnan(mosaic_bands[ref_band])

        aoi_total_px       = int(aoi_inside.sum())
        no_coverage_inside = int((all_nan & aoi_inside).sum())
        valid_mosaic       = aoi_total_px - no_coverage_inside
        cloud_pct_scene    = round(100.0 * no_coverage_inside / max(1, aoi_total_px), 2)
        valid_pct_scene    = round(100.0 * valid_mosaic / max(1, aoi_total_px), 2)

        log(
            f"Coverage  valid={valid_mosaic:,} px  ({valid_pct_scene:.1f}%)   "
            f"cloud/nodata={cloud_pct_scene:.1f}%",
            "MOSAIC",
        )

        if valid_mosaic < int(aoi_total_px * MIN_VALID_FRACTION):
            log(f"Too few valid pixels for {date}  {valid_mosaic:,} px ({valid_pct_scene:.1f}%)  →  skipping", "DATE")
            del all_nan
            continue

        date_folder   = os.path.join(job_folder, str(date))
        mosaic_folder = os.path.join(date_folder, "mosaic")
        os.makedirs(mosaic_folder, exist_ok=True)

        try:
            b_meta = scenes[0].assets["red"].extra_fields.get("raster:bands", [{}])[0]
            scale = float(b_meta.get("scale", 1e-4))
            offset = float(b_meta.get("offset", 0.0))
        except:
            scale = 1e-4
            offset = 0.0

        for band in REFL_BANDS:
            mosaic_bands[band][all_nan] = np.nan
            mosaic_bands[band] = mosaic_bands[band] * scale + offset
            mosaic_bands[band][(mosaic_bands[band] < 0) | (mosaic_bands[band] > 1.5)] = np.nan
            mosaic_bands[band][aoi_outside] = np.nan

        gc.collect()

        log(f"Mosaic ready  ({elapsed(mosaic_t)}s)", "MOSAIC")

        # ── INDICES ──────────────────────────────────────
        indices = compute_indices(mosaic_bands)
        del mosaic_bands

        for name, arr in indices.items():
            arr[aoi_outside] = np.nan

        # ── RPRI (fixed empirical bounds, cross-date comparable) ──────────
        RPRI, pca_meta = compute_rpri(indices)
        RPRI[aoi_outside] = np.nan

        cluster_map, gmm_centroids = compute_clusters(indices)
        cluster_map[aoi_outside] = np.nan

        # ── CORRELATION MATRIX ──────────────────────────────────────────
        corr_keys = list(indices.keys()) + ["RPRI"]
        corr_arrays = [indices[k] for k in indices.keys()] + [RPRI]
        
        c_mask = np.ones_like(RPRI, dtype=bool)
        for arr in corr_arrays:
            c_mask &= np.isfinite(arr)
            
        corr_matrix = {}
        if c_mask.any():
            # Sample up to 100k pixels for speed
            valid_idx = np.where(c_mask.ravel())[0]
            if len(valid_idx) > 100000:
                valid_idx = np.random.choice(valid_idx, 100000, replace=False)
            
            stack = np.stack([a.ravel()[valid_idx] for a in corr_arrays], axis=0) # (M, N)
            # Spearman correlation = Pearson correlation of ranks
            ranks = np.argsort(np.argsort(stack, axis=1), axis=1)
            rho = np.corrcoef(ranks)
            
            for i, k1 in enumerate(corr_keys):
                corr_matrix[k1] = {}
                for j, k2 in enumerate(corr_keys):
                    corr_matrix[k1][k2] = round(float(rho[i, j]), 3)

        # ── WRITE ─────────────────────────────────────────
        tiles_used  = len(results)
        tile_bands.clear()
        results.clear()

        write_tasks = [(name, arr, mosaic_folder, target_profile) for name, arr in indices.items()]
        write_tasks.append(("RPRI",              RPRI,        mosaic_folder, target_profile))
        write_tasks.append(("pollution_clusters", cluster_map, mosaic_folder, target_profile))

        t_write    = time.time()
        histograms = {}
        log(f"Writing {len(write_tasks)} output rasters", "WRITE")

        completed = 0
        for task in write_tasks:
            name, hist = _write_index(task)
            histograms[name] = hist
            completed += 1
            log(f"  [{completed}/{len(write_tasks)}] {name}", "WRITE")

        log(f"Rasters written  ({elapsed(t_write)}s)", "WRITE")

        # ── HISTOGRAMS JSON ───────────────────────────────
        scene_meta = {
            "valid_px":    valid_mosaic,
            "total_px":    aoi_total_px,
            "valid_pct":   valid_pct_scene,
            "cloud_pct":   cloud_pct_scene,
            "tiles_used":  tiles_used,
            "tiles_total": len(scenes),
            "gmm_centroids": gmm_centroids,
            "gmm_cluster_counts": [
                int((cluster_map == i).sum())
                for i in range(5)
            ],
            "pca": pca_meta,
            "correlation": corr_matrix,
        }
        histograms["_meta"] = scene_meta
        with open(os.path.join(mosaic_folder, "histograms.json"), "w") as f:
            json.dump(histograms, f, indent=4)
        log(f"histograms.json  ({len(histograms)} bands)", "HIST")

        log(f"Date {date} complete  ({elapsed(date_start)}s)", "DATE")
        dates_written += 1

        # Free memory once written
        del indices, RPRI, cluster_map
        gc.collect()

    log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    log(f"EPM PIPELINE  DONE  ({elapsed(pipeline_start):.1f}s total)")
    log(f"  Dates written │ {dates_written} / {len(grouped)}")
    log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

    if dates_written == 0:
        log("No valid dates produced output  —  job returned nothing", "ERROR")
        return None

    return job_id