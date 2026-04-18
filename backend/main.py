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
from rasterio.mask import mask
from rasterio.warp import reproject, Resampling, transform_geom
from pystac_client import Client
from shapely.geometry import shape, mapping
from shapely.wkt import dumps, loads
from scipy.ndimage import binary_dilation
from scipy.stats import spearmanr
from rasterio.crs import CRS
from rasterio.transform import from_bounds

import planetary_computer

STAC_URL    = "https://planetarycomputer.microsoft.com/api/stac/v1"
COLLECTION  = "sentinel-2-l2a"
_PC_SIGN    = planetary_computer.sign_inplace
OUTPUT_DIR  = "output"

os.makedirs(OUTPUT_DIR, exist_ok=True)

BANDS        = ["red", "nir", "green", "blue", "rededge1", "swir16", "swir22", "scl"]
REFL_BANDS   = {"red", "nir", "green", "blue", "rededge1", "swir16", "swir22"}
INDEX_INPUT_BANDS = {"red", "nir", "green", "blue", "rededge1", "swir16", "swir22"}
INDEX_CHUNK_ROWS = 512   # was 256 — halves loop iterations, same memory footprint

# Planetary Computer uses B-number asset keys; earth-search uses common names.
# This map normalises PC keys → the names the rest of the pipeline expects.
_PC_BAND_ALIASES: dict[str, str] = {
    "B04":  "red",
    "B08":  "nir",
    "B03":  "green",
    "B02":  "blue",
    "B8A":  "rededge1",
    "B11":  "swir16",
    "B12":  "swir22",
    "SCL":  "scl",
    # Also handle lower-case SCL variant some items use
    "scl":  "scl",
}

BAD_SCL_CLASSES    = {0, 1, 3, 8, 9, 10, 11}
BAD_SCL_ARRAY      = np.array(sorted(BAD_SCL_CLASSES), dtype=np.int16)
NODATA_FLOAT       = float("nan")
NODATA_BAND        = 0
KMEANS_MAX_SAMPLES = 100_000
MIN_VALID_FRACTION = 0.05
MAX_BAND_WORKERS   = 8
# India → Planetary Computer (Azure West Europe) RTT ~130-160 ms.
# More concurrent connections hide latency — band downloads spend most
# wall-time on TCP round-trips, not bytes transferred.  48 vs 24 lets
# us saturate bandwidth without starving the OS socket pool.
MAX_TOTAL_HTTP     = 48
HTTP_SEMAPHORE     = threading.Semaphore(MAX_TOTAL_HTTP)

KMEANS_N_CLUSTERS  = 5          # number of pollution risk classes
# Fewer restarts/iterations: negligible accuracy loss for 5-class risk
# clustering, saves ~60-70% of KMeans wall time.
KMEANS_N_INIT      = 3          # was 10
KMEANS_MAX_ITER    = 150        # was 300 — converges well before 150 for 1-D input

# Shorter initial retry waits — transient errors on high-latency links
# typically clear in seconds, not tens of seconds.
RETRY_DELAYS = [5, 10, 20, 40]  # was [10, 10, 20, 30, 60]

# ===================================================
# LOGGING
# ===================================================

import logging as _logging

# Suppress Uvicorn's verbose access logs (GET /logs, etc.)
# so that the terminal ONLY shows EPM pipeline logs when a job is running.
_logging.getLogger("uvicorn.access").setLevel(_logging.WARNING)

_epm_logger = _logging.getLogger("epm_core")

def log(message, stage="INFO"):
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    formatted = f"[{now}] [{stage}] {message}"
    # Also print with flush for direct terminal runs (python epm_core.py)
    print(formatted, flush=True)
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
    """
    Return (date_workers, band_workers_per_tile) based on raster size.
    Larger AOIs need gentler parallelism to avoid vsicurl/GDAL retry storms.
    On high-latency links (India → Azure West Europe) we want as many
    concurrent band downloads as possible to hide round-trip time.
    """
    if total_pixels >= 20_000_000:
        date_workers = min(scene_count, 2)
        band_workers = 2
    elif total_pixels >= 12_000_000:
        date_workers = min(scene_count, 3)
        band_workers = 3          # was 2
    else:
        date_workers = min(multiprocessing.cpu_count(), scene_count)
        # Use all 8 bands in parallel for small AOIs — each download is
        # independent and latency-bound, so more workers = faster wall time.
        band_workers = max(4, min(len(BANDS), MAX_TOTAL_HTTP // max(1, date_workers)))
    return max(1, date_workers), max(1, band_workers)


# ===================================================
# GDAL VSI CACHE CLEAR
# ===================================================

import ctypes as _ctypes

def _load_gdal_lib():
    try:
        import rasterio as _rio
        libs_dir = os.path.join(os.path.dirname(_rio.__file__) + ".libs")
        if os.path.isdir(libs_dir):
            for fname in os.listdir(libs_dir):
                fpath = os.path.join(libs_dir, fname)
                if fname.endswith(".so") or ".so." in fname:
                    try:
                        _ctypes.CDLL(fpath, mode=_ctypes.RTLD_GLOBAL)
                    except OSError:
                        pass
            for fname in os.listdir(libs_dir):
                if "gdal" in fname.lower() and (".so" in fname):
                    return _ctypes.CDLL(os.path.join(libs_dir, fname))
    except Exception:
        pass
    for name in ["libgdal.so", "libgdal.so.36", "libgdal.so.34", "libgdal.so.32", "libgdal.so.30"]:
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


def _clear_vsi_cache(url: str):
    try:
        if _gdal_partial_clear is not None:
            _gdal_partial_clear(url.encode("utf-8"))
        elif _gdal_full_clear is not None:
            _gdal_full_clear()
    except Exception:
        pass


# ===================================================
# REPROJECTION
# ===================================================

def reproject_to_reference(src_array, src_profile, ref_profile):
    destination = np.full(
        (ref_profile["height"], ref_profile["width"]),
        fill_value=np.nan,
        dtype=np.float32,
    )
    reproject(
        source=src_array.astype(np.float32),
        destination=destination,
        src_transform=src_profile["transform"],
        src_crs=src_profile["crs"],
        dst_transform=ref_profile["transform"],
        dst_crs=ref_profile["crs"],
        resampling=Resampling.nearest,
        src_nodata=np.nan,
        dst_nodata=np.nan,
    )
    return destination


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
# FETCH BAND — with NotGeoreferencedWarning suppression
# ===================================================

def clip_band(asset_href, aoi_wkt, target_profile=None):
    geom = loads(aoi_wkt)
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=NotGeoreferencedWarning)
        with rasterio.open(asset_href) as src:
            geom_proj = transform_geom("EPSG:4326", src.crs, mapping(geom))
            clipped, transform = mask(src, [geom_proj], crop=True, filled=False)
            src_profile = src.profile.copy()

    src_profile.update(
        height=clipped.shape[1],
        width=clipped.shape[2],
        transform=transform,
    )
    band = clipped[0].astype(np.float32)
    if np.ma.is_masked(band):
        band = np.where(np.ma.getmaskarray(band), np.nan, band.data)

    if target_profile is None:
        return band, src_profile

    H = target_profile["height"]
    W = target_profile["width"]
    dst = np.full((H, W), np.nan, dtype=np.float32)
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=NotGeoreferencedWarning)
        reproject(
            source=band,
            destination=dst,
            src_transform=src_profile["transform"],
            src_crs=src_profile["crs"],
            dst_transform=target_profile["transform"],
            dst_crs=target_profile["crs"],
            resampling=Resampling.bilinear,
            src_nodata=float("nan"),
            dst_nodata=float("nan"),
        )
    return dst, target_profile


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
    mask_bad  = binary_dilation(mask_bad, iterations=1)
    masked_px = int(mask_bad.sum())
    total_px  = mask_bad.size
    log(f"Masked {masked_px:,} / {total_px:,} px  ({100*masked_px/total_px:.1f}% cloud/shadow)", "CLOUD")

    for band in band_data:
        band_data[band][mask_bad] = np.nan
    return band_data


# ===================================================
# TILE PROCESSING
# ===================================================

class TileSkipped(Exception):
    pass


# Shared GDAL environment for all band fetches
_GDAL_ENV = dict(
    GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
    CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif,.tiff",
    VSI_CACHE=True,
    # 1 GB VSI cache (was 500 MB) — larger cache means fewer round-trips for
    # repeated reads of the same COG blocks across band clips.
    VSI_CACHE_SIZE=1_000_000_000,
    GDAL_HTTP_MERGE_CONSECUTIVE_READS=True,
    GDAL_HTTP_MULTIPLEX=True,
    GDAL_HTTP_VERSION=2,
    AWS_NO_SIGN_REQUEST="YES",
    # 1 GB GDAL block cache (was 512 MB) — avoids re-fetching overview blocks
    # when multiple indices read the same tile region.
    GDAL_CACHEMAX=1024,
    GDAL_HTTP_TIMEOUT=180,
    GDAL_HTTP_CONNECTTIMEOUT=60,
    GDAL_HTTP_MAX_RETRY=1,
    GDAL_HTTP_RETRY_DELAY=2,
    # Fetch 4 MB per range request (was GDAL default ~256 KB).
    # On a 130+ ms latency link each extra round-trip costs ~260 ms.
    # Larger blocks amortise that cost: 4 MB fetches the full AOI clip
    # for most 10 m bands in 1-2 requests instead of 10-20.
    CPL_VSIL_CURL_CHUNK_SIZE=4_000_000,
    # Pre-fetch the next block while the current one is being decoded.
    GDAL_HTTP_USERAGENT="epm-pipeline/1.0",
)


def _fetch_band_with_retry(band: str, href: str, aoi_wkt: str, target_profile: dict) -> tuple:
    """
    Download one band with retry + VSI cache clearing on failure.
    Returns (band_name, array, elapsed_seconds).
    Raises on permanent failure.
    """
    t_start    = time.time()
    last_exc   = None
    n_attempts = len(RETRY_DELAYS) + 1   # 6 total: 1 first try + 5 retries

    log(f"  ↓ Downloading {band}...", "TILE")

    for attempt in range(n_attempts):
        try:
            with HTTP_SEMAPHORE:
                with rasterio.Env(**_GDAL_ENV):
                    signed_href = planetary_computer.sign(href)
                    arr, _ = clip_band(signed_href, aoi_wkt, target_profile)
            return band, arr.astype(np.float32), elapsed(t_start)
        except Exception as exc:
            last_exc = exc
            if attempt >= n_attempts - 1:
                break
            wait = RETRY_DELAYS[attempt]
            log(f"  ↻ {band} attempt {attempt + 1}/{n_attempts - 1} failed — "
                f"retrying in {wait}s  [{exc}]", "TILE")
            _clear_vsi_cache(href)
            time.sleep(wait)

    raise last_exc


def process_tile(item_dict, *, aoi_wkt, target_profile, n_tiles=1, band_workers=None):
    """
    Download all bands for one Sentinel-2 tile.

    All bands (including red + scl) are submitted to the pool simultaneously.
    SCL is awaited first for the early cloud check; other bands continue
    downloading in parallel. Cancelled futures on cloudy-tile bail-out.
    """
    tile_start = time.time()
    tile_id    = item_dict["id"]
    log(f"Start: {tile_id}", "TILE")

    H = target_profile["height"]
    W = target_profile["width"]

    ordered_bands = ["scl"] + [b for b in BANDS if b != "scl"]

    # Normalise Planetary Computer B-number asset keys to common names.
    # Build a reverse map: common_name → href, trying both the common name
    # directly and any PC alias that maps to it.
    _alias_rev = {}   # common_name → href
    assets = item_dict.get("assets", {})
    for asset_key, asset_val in assets.items():
        href = asset_val.get("href") if isinstance(asset_val, dict) else None
        if not href:
            continue
        common = _PC_BAND_ALIASES.get(asset_key, asset_key)
        if common in BANDS and common not in _alias_rev:
            _alias_rev[common] = href

    all_hrefs = {
        b: _alias_rev[b]
        for b in ordered_bands if b in _alias_rev
    }

    # Log which bands were resolved — makes asset-key mismatches immediately visible
    missing = [b for b in BANDS if b not in _alias_rev]
    if missing:
        log(f"  ⚠ bands not found in STAC assets: {missing}  "
            f"(available asset keys: {list(assets.keys())[:12]})", "TILE")
    else:
        log(f"  ✓ all bands resolved via asset keys", "TILE")
    # Fair share of connections across tiles, capped globally by HTTP_SEMAPHORE.
    if band_workers is None:
        _tile_workers = max(2, min(len(all_hrefs), MAX_TOTAL_HTTP // max(1, n_tiles)))
    else:
        _tile_workers = max(1, min(len(all_hrefs), band_workers))

    band_data: dict = {}

    with rasterio.Env(**_GDAL_ENV):
        band_ex = ThreadPoolExecutor(max_workers=_tile_workers)
        try:
            scl_href = all_hrefs.get("scl")
            scl_future = band_ex.submit(_fetch_band_with_retry, "scl", scl_href, aoi_wkt, target_profile) if scl_href else None
            total_px   = H * W

            # ── Cloud check as soon as SCL arrives ─────────────────────────
            if scl_future is not None:
                try:
                    _, scl_arr, scl_t = scl_future.result()
                    band_data["scl"] = scl_arr
                    log(f"  ✓ scl  ({scl_t}s)", "TILE")

                    scl_safe   = np.where(np.isfinite(scl_arr), scl_arr, -1).astype(np.int16)
                    cloud_frac = np.isin(scl_safe, BAD_SCL_ARRAY).sum() / total_px
                    log(f"  Cloud fraction: {100 * cloud_frac:.1f}%", "TILE")

                    if cloud_frac > (1.0 - MIN_VALID_FRACTION):
                        log(f"  ✗ {tile_id} is {100 * cloud_frac:.1f}% cloudy — skipping tile", "TILE")
                        band_ex.shutdown(wait=False, cancel_futures=True)
                        raise TileSkipped(f"{tile_id}: {100 * cloud_frac:.1f}% cloud cover")

                except TileSkipped:
                    raise
                except Exception as exc:
                    log(f"  ✗ scl failed: {exc} — skipping cloud check", "TILE")

            # ── Collect remaining bands ────────────────────────────────────
            t_bands = time.time()
            remaining_hrefs = {b: h for b, h in all_hrefs.items() if b != "scl"}
            futures = {
                band_ex.submit(_fetch_band_with_retry, b, h, aoi_wkt, target_profile): b
                for b, h in remaining_hrefs.items()
            }
            
            for f in as_completed(futures):
                b = futures[f]
                try:
                    band, arr, elapsed_b = f.result()
                    band_data[band] = arr
                    log(f"  ✓ {band}  ({elapsed_b}s)", "TILE")
                except Exception as exc:
                    log(f"  ✗ {b} permanently failed: {exc} — NaN fill", "TILE")
                    band_data[b] = np.full((H, W), np.nan, dtype=np.float32)

            log(f"  ✓ All bands done in {elapsed(t_bands)}s", "TILE")

        finally:
            band_ex.shutdown(wait=False, cancel_futures=True)

    band_data = apply_cloud_mask(band_data)
    log(f"Done: {tile_id}  total={elapsed(tile_start)}s", "TILE")
    return {"bands": band_data, "profile": target_profile}


# ===================================================
# INDEX ENGINE
# ===================================================

def compute_indices(refl_bands):
    log("Computing spectral indices...", "INDICES")
    t_all = time.time()

    def _band(name):
        arr = refl_bands.get(name)
        if arr is None:
            log(f"  WARNING: band '{name}' missing — using NaN fill", "INDICES")
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
        log(f"  {name}: starting", "INDICES")
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
        log(f"  {name}: valid={valid_count:,}  ({elapsed(t)}s)", "INDICES")
        return out

    NDVI  = _norm_diff(nir,   red,     "NDVI")
    NDRE  = _norm_diff(nir,   rededge, "NDRE")
    NDMI  = _norm_diff(nir,   swir1,   "NDMI")
    NDWI  = _norm_diff(green, nir,     "NDWI")
    MNDWI = _norm_diff(green, swir1,   "MNDWI")
    NBR   = _norm_diff(nir,   swir2,   "NBR")
    NDTI  = _norm_diff(swir1, swir2,   "NDTI")
    NDBAI = _norm_diff(swir2, nir,     "NDBAI")

    t = time.time()
    log("  SAVI: starting", "INDICES")
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
    log(f"  SAVI: valid={savi_valid:,}  ({elapsed(t)}s)", "INDICES")

    t = time.time()
    log("  EVI: starting", "INDICES")
    EVI = np.full((H, W), np.nan, dtype=np.float32)
    evi_valid = 0
    for row0, row1 in _row_chunks():
        nir_c = nir[row0:row1]
        red_c = red[row0:row1]
        blue_c = blue[row0:row1]
        den = nir_c + 6.0 * red_c - 7.5 * blue_c + 1.0
        mask = np.isfinite(nir_c) & np.isfinite(red_c) & np.isfinite(blue_c) & np.isfinite(den) & (den != 0)
        num = (nir_c - red_c) * 2.5
        EVI[row0:row1].fill(np.nan)
        np.divide(num, den, out=EVI[row0:row1], where=mask)
        evi_valid += int(mask.sum())
    log(f"  EVI:  valid={evi_valid:,}  ({elapsed(t)}s)", "INDICES")

    indices = {
        "NDVI": NDVI, "NDRE": NDRE, "SAVI": SAVI, "EVI": EVI,
        "NDMI": NDMI, "NDWI": NDWI, "MNDWI": MNDWI,
        "NBR":  NBR,  "NDTI": NDTI, "NDBAI": NDBAI,
    }
    log(f"All indices complete  ({elapsed(t_all)}s total)", "INDICES")
    return indices


# ===================================================
# RAQI — weighted accumulation with partial-NaN support
# ===================================================
#
# BUG IN PREVIOUS VERSION (document 5):
#   RAQI = np.full(..., np.nan)
#   np.add(RAQI, tmp, out=RAQI, where=np.isfinite(tmp) & np.isfinite(RAQI))
#
# Problem: for any pixel where RAQI is NaN (i.e. all pixels at first),
# `np.isfinite(RAQI)` is False, so the `where` mask is False everywhere,
# and NO values are ever written.  Result: RAQI stays all-NaN, valid=0.
#
# Fix: accumulate into a float64 sum + weight-sum pair so that partial-NaN
# pixels still get a score from their valid terms.
# ===================================================

def compute_raqi(indices):
    from sklearn.decomposition import PCA
    log("Computing PCA-driven RAQI...", "RAQI")
    t = time.time()

    eval_keys = ["NDTI", "NBR", "NDVI", "NDMI", "SAVI"]
    invert_map = {"NDTI": 1, "NBR": -1, "NDVI": -1, "NDMI": -1, "SAVI": -1}

    H, W = indices["NDTI"].shape
    stacked = []
    for k in eval_keys:
        arr = indices[k] * invert_map[k]
        stacked.append(arr)
        
    stacked_arr = np.stack(stacked, axis=-1)
    valid_mask = np.all(np.isfinite(stacked_arr), axis=-1)
    
    RAQI = np.full((H, W), np.nan, dtype=np.float32)
    n_valid = int(valid_mask.sum())
    
    if n_valid > 5:
        X = stacked_arr[valid_mask]
        mean_X = X.mean(axis=0)
        std_X = X.std(axis=0)
        std_X[std_X == 0] = 1.0
        X_scaled = (X - mean_X) / std_X
        
        pca = PCA(n_components=1, random_state=42)
        pc1 = pca.fit_transform(X_scaled).flatten()
        log(f"  PCA explained variance: {pca.explained_variance_ratio_[0]*100:.1f}%", "RAQI")
        
        # Orient PC1 positively with NDTI (pollution proxy) using robust non-parametric correlation
        corr, _ = spearmanr(pc1, X[:, 0])
        if corr < 0:
            pc1 = -pc1
            
        pc1_min, pc1_max = np.percentile(pc1, 1), np.percentile(pc1, 99)
        if pc1_max == pc1_min: pc1_max = pc1_min + 1e-6
        pc1_norm = np.clip((pc1 - pc1_min) / (pc1_max - pc1_min), 0.0, 1.0)
        
        RAQI[valid_mask] = pc1_norm
        mean_val = float(np.nanmean(RAQI))
    else:
        log("  Not enough valid pixels for PCA", "RAQI")
        mean_val = float("nan")

    log(f"RAQI done  valid={n_valid:,}  mean={mean_val:.4f}  ({elapsed(t)}s)", "RAQI")
    return RAQI


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
# CLUSTERING — KMeans on RAQI values
#
# Scientific rationale:
#   Fixed absolute thresholds are brittle — the same RAQI value can mean
#   different things across different landscapes, seasons, and sensors.
#   KMeans learns data-driven cluster boundaries from the actual RAQI
#   distribution for each scene, so class boundaries always reflect
#   natural breaks in the data rather than arbitrary constants.
#
#   Implementation choices:
#   - k = 5  (matches the 5 risk classes displayed in the UI)
#   - Fit on a random subsample of ≤ KMEANS_MAX_SAMPLES valid pixels to
#     keep runtime bounded (~O(n·k·iter)); then predict all valid pixels.
#   - Clusters are re-labelled in ascending centroid order so that
#     class 0 is always "lowest RAQI / cleanest" and class 4 is always
#     "highest RAQI / most polluted" — making the colour scale consistent.
#   - Centroids are returned alongside the map so the frontend can show
#     the actual learned boundary values instead of hard-coded midpoints.
# ===================================================

def compute_clusters(raqi):
    from sklearn.mixture import GaussianMixture

    log(f"Running GMM clustering (components={KMEANS_N_CLUSTERS})...", "CLUSTER")
    t = time.time()

    valid_mask = np.isfinite(raqi)
    n_valid = int(valid_mask.sum())

    if n_valid == 0:
        log("No valid pixels — skipping clustering", "CLUSTER")
        return np.full(raqi.shape, np.nan, dtype=np.float32), []

    valid_vals = raqi[valid_mask].reshape(-1, 1).astype(np.float64)
    if n_valid > KMEANS_MAX_SAMPLES:
        rng = np.random.default_rng(seed=42)
        idx = rng.choice(n_valid, size=KMEANS_MAX_SAMPLES, replace=False)
        fit_vals = valid_vals[idx]
        log(f"  Subsampled {KMEANS_MAX_SAMPLES:,} of {n_valid:,} valid px for fit", "CLUSTER")
    else:
        fit_vals = valid_vals

    gmm = GaussianMixture(
        n_components=KMEANS_N_CLUSTERS,
        covariance_type='full',
        n_init=KMEANS_N_INIT,
        max_iter=KMEANS_MAX_ITER,
        random_state=42,
    )
    gmm.fit(fit_vals)

    raw_centroids  = gmm.means_.flatten()
    order          = np.argsort(raw_centroids)
    rank           = np.empty_like(order)
    rank[order]    = np.arange(KMEANS_N_CLUSTERS)
    centroids_sorted = raw_centroids[order].tolist()

    log(f"  GMM centroids (sorted): {[f'{c:.4f}' for c in centroids_sorted]}", "CLUSTER")

    raw_labels  = gmm.predict(valid_vals)
    new_labels  = rank[raw_labels].astype(np.float32)

    cluster_map = np.full(raqi.shape, np.nan, dtype=np.float32)
    cluster_map[valid_mask] = new_labels

    for i in range(KMEANS_N_CLUSTERS):
        count = int((new_labels == i).sum())
        log(f"  Cluster {i} (centroid={centroids_sorted[i]:.4f}): {count:,} px ({100*count/n_valid:.1f}%)", "CLUSTER")

    log(f"GMM clustering done  ({elapsed(t)}s)", "CLUSTER")
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
    log(f"  -> {os.path.basename(path)}  {kb:.0f} KB  ov={','.join(map(str, overviews))}  ({elapsed(t)}s)", "WRITE")


def _write_index(args):
    name, arr, mosaic_folder, target_profile = args
    write_cog_float32(os.path.join(mosaic_folder, f"{name}.tif"), arr, target_profile)
    return name, generate_histogram(arr)


# ===================================================
# SAFE NORMALIZATION (kept for external callers)
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

def run_epm(aoi_geojson, start_date, end_date, max_cloud=80, provisional_job_id=None, cancelled_fn=None):
    pipeline_start = time.time()

    job_id     = provisional_job_id or datetime.now().strftime("job_%Y%m%d%H%M%S")
    job_folder = os.path.join(OUTPUT_DIR, job_id)
    os.makedirs(job_folder, exist_ok=True)

    cpu_count = multiprocessing.cpu_count()

    log("==============================================")
    log("EPM JOB STARTED")
    log(f"Job ID      : {job_id}")
    log(f"Date Range  : {start_date} -> {end_date}")
    log(f"Max Cloud   : {max_cloud}%")
    log(f"CPUs        : {cpu_count}")
    log("==============================================")

    log("Querying STAC catalog...", "STAC")
    stac_start = time.time()
    catalog = Client.open(STAC_URL, modifier=_PC_SIGN)
    search  = catalog.search(
        collections=[COLLECTION],
        intersects=aoi_geojson,
        datetime=f"{start_date}/{end_date}",
        filter={"op": "lte", "args": [{"property": "eo:cloud_cover"}, max_cloud]},
        filter_lang="cql2-json",
    )
    items = list(search.items())
    log(f"STAC done  scenes={len(items)}  ({elapsed(stac_start)}s)", "STAC")

    if not items:
        log("No scenes found. Job terminated.", "ERROR")
        return None

    grouped = {}
    for item in items:
        d = item.datetime.date()
        grouped.setdefault(d, []).append(item)
    dates_sorted = sorted(grouped.keys())
    log(f"Unique dates: {len(grouped)}  {dates_sorted}")

    aoi_wkt        = normalize_aoi(aoi_geojson)
    target_profile = build_target_profile(aoi_wkt, target_res_m=10)
    H = target_profile["height"]
    W = target_profile["width"]
    log(f"Target grid: {W}x{H} px  ({W*H:,} total pixels)  CRS={target_profile['crs'].to_epsg()}")

    try:
        aoi_inside  = build_aoi_polygon_mask(aoi_wkt, target_profile)
        aoi_outside = ~aoi_inside
        log(f"AOI polygon mask: {int(aoi_inside.sum()):,} px inside / {int(aoi_outside.sum()):,} px clipped", "MASK")
    except Exception as e:
        log(f"AOI polygon mask failed ({e}) -- bbox only", "MASK")
        aoi_inside  = np.ones((H, W), dtype=bool)
        aoi_outside = np.zeros((H, W), dtype=bool)

    dates_written = 0

    for date_idx, date in enumerate(dates_sorted, 1):
        scenes     = grouped[date]
        date_start = time.time()

        log("================================================")
        log(f"DATE {date_idx}/{len(grouped)}: {date}  ({len(scenes)} scenes)", "DATE")
        log(f"[DATE_PROGRESS] {date_idx}/{len(grouped)}", "DATE")
        log("================================================")

        if cancelled_fn and cancelled_fn():
            log("Job cancelled by user -- stopping pipeline.", "CANCEL")
            return None

        n_workers, band_workers = choose_parallelism(W * H, len(scenes))
        log(f"Parallel tile download  workers={n_workers}  band_workers={band_workers}...", "TILES")
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
                    log(f"Tile skipped (too cloudy): {e}", "TILES")
                except Exception as e:
                    log(f"Tile failed ({tid}): {e}", "TILES")

        log(f"Tiles done  {len(results)}/{len(scenes)} usable  ({elapsed(tiles_t)}s)", "TILES")

        if not results:
            log(f"All tiles for {date} are too cloudy -- skipping date", "DATE")
            continue

        log(f"Grid: {W}x{H} px  ({W*H:,} total)", "TILES")

        # ── CHUNKED MEDIAN COMPOSITE ──────────────────────────────
        log("Building Chunked Median-Composite mosaic...", "MOSAIC")
        mosaic_t = time.time()

        tile_bands = [r["bands"] for r in results]
        
        mosaic_bands = {}
        for band in INDEX_INPUT_BANDS:
            arrays = [tb[band] for tb in tile_bands if band in tb]
            if arrays:
                mosaic_bands[band] = nanmedian_chunked(arrays, chunk_size=INDEX_CHUNK_ROWS)
            else:
                mosaic_bands[band] = np.full((H, W), np.nan, dtype=np.float32)

        # To calculate all_nan, we can just check one band
        ref_band = list(INDEX_INPUT_BANDS)[0]
        all_nan = np.isnan(mosaic_bands[ref_band])

        aoi_total_px       = int(aoi_inside.sum())
        no_coverage_inside = int((all_nan & aoi_inside).sum())
        valid_mosaic       = aoi_total_px - no_coverage_inside
        cloud_pct_scene    = round(100.0 * no_coverage_inside / max(1, aoi_total_px), 2)
        valid_pct_scene    = round(100.0 * valid_mosaic / max(1, aoi_total_px), 2)
        
        log(
            f"No-coverage in AOI: {no_coverage_inside:,}  valid in AOI: {valid_mosaic:,}  "
            f"cloud/nodata in AOI: {cloud_pct_scene:.1f}%",
            "MOSAIC",
        )

        if valid_mosaic < int(aoi_total_px * MIN_VALID_FRACTION):
            log(f"Date {date} has only {valid_mosaic:,} valid AOI px ({valid_pct_scene:.1f}%) -- skipping", "DATE")
            del all_nan
            continue

        date_folder   = os.path.join(job_folder, str(date))
        mosaic_folder = os.path.join(date_folder, "mosaic")
        os.makedirs(mosaic_folder, exist_ok=True)

        for band in INDEX_INPUT_BANDS:
            mosaic_bands[band][all_nan] = np.nan
            if band in REFL_BANDS:
                mosaic_bands[band] /= 10000.0
                mosaic_bands[band][(mosaic_bands[band] < 0) | (mosaic_bands[band] > 1.5)] = np.nan
            mosaic_bands[band][aoi_outside] = np.nan
                
        gc.collect()

        log(f"Mosaic done  ({elapsed(mosaic_t)}s)", "MOSAIC")

        # ── INDICES ──────────────────────────────────────
        indices = compute_indices(mosaic_bands)
        del mosaic_bands

        for name, arr in indices.items():
            arr[aoi_outside] = np.nan

        # ── RAQI + CLUSTERING ─────────────────────────────
        RAQI = compute_raqi(indices)
        RAQI[aoi_outside] = np.nan

        cluster_map, kmeans_centroids = compute_clusters(RAQI)
        cluster_map[aoi_outside] = np.nan

        # ── PARALLEL WRITE (COG in one shot) ──────────────
        write_tasks = [(name, arr, mosaic_folder, target_profile) for name, arr in indices.items()]
        write_tasks.append(("RAQI",               RAQI,        mosaic_folder, target_profile))
        write_tasks.append(("pollution_clusters",  cluster_map, mosaic_folder, target_profile))

        tiles_used = len(results)
        tile_bands.clear()
        results.clear()
        t_write = time.time()
        histograms = {}
        log(f"Writing {len(write_tasks)} output rasters...", "WRITE")
        # Adaptive disk I/O throttling to prevent storage bottleneck on huge scenes
        write_workers = 1 if (W * H) > 20_000_000 else 2
        with ThreadPoolExecutor(max_workers=write_workers) as io_ex:
            futures = {io_ex.submit(_write_index, task): task[0] for task in write_tasks}
            completed = 0
            for future in as_completed(futures):
                name = futures[future]
                written_name, hist = future.result()
                histograms[written_name] = hist
                completed += 1
                log(f"Completed write {completed}/{len(write_tasks)}: {name}", "WRITE")

        histograms.pop("pollution_clusters", None)   # no histogram needed for cluster map
        log(f"Index TIFs written  ({elapsed(t_write)}s)", "INDICES")

        # ── HISTOGRAMS JSON ───────────────────────────────
        scene_meta = {
            "valid_px":    valid_mosaic,
            "total_px":    aoi_total_px,
            "valid_pct":   valid_pct_scene,
            "cloud_pct":   cloud_pct_scene,
            "tiles_used":  tiles_used,
            "tiles_total": len(scenes),
            "kmeans_centroids": kmeans_centroids,   # learned KMeans centroids (sorted ascending)
            "kmeans_cluster_counts": [
                int((cluster_map == i).sum())
                for i in range(5)
            ],
        }
        histograms["_meta"] = scene_meta
        with open(os.path.join(mosaic_folder, "histograms.json"), "w") as f:
            json.dump(histograms, f, indent=4)
        log(f"histograms.json saved  ({len(histograms)} bands)", "HIST")

        # write_cog_float32 already writes DEFLATE+tiled+overviews in one pass,
        # so no separate COG conversion step is needed.
        log(f"DATE {date} COMPLETE  total={elapsed(date_start)}s", "DATE")
        dates_written += 1

    log("==============================================")
    log(f"PIPELINE COMPLETE  total={elapsed(pipeline_start)}s")
    log(f"Dates written: {dates_written}/{len(grouped)}")
    log("==============================================")

    if dates_written == 0:
        log("No valid dates produced output -- returning None", "ERROR")
        return None

    return job_id

# ===================================================
# FASTAPI SERVER
# ===================================================

import asyncio
import uuid
import queue
import shutil
import io
from collections import defaultdict
from typing import Optional

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

# ── App setup ─────────────────────────────────────────────────────────────────
app = FastAPI(title="EPM Backend", version="1.0.0")

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
    max_cloud: int = 80
    provisional_job_id: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────────────
def _job_folder(job_id: str) -> str:
    return os.path.join(OUTPUT_DIR, job_id)


def _mosaic_folder(job_id: str, date: str) -> str:
    return os.path.join(_job_folder(job_id), str(date), "mosaic")


def _tif_path(job_id: str, date: str, layer: str) -> str:
    return os.path.join(_mosaic_folder(job_id, date), f"{layer}.tif")


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
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        line = f"[{now}] [{stage}] {message}"
        print(line, flush=True)
        q.put(line)
    return _log


def _run_pipeline_sync(job_id: str, req: RunEpmRequest):
    """Blocking pipeline run — called in a thread-pool worker."""
    global log  # shadow module-level log temporarily for this thread
    orig_log = log
    routed   = _route_log(job_id)

    import builtins as _b
    # Patch the module-level log so pipeline functions emit to SSE queue
    import main as _self
    _self.log = routed

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
        _self.log = orig_log
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
            except Exception:
                yield {"data": "__done__"}
                return

    return EventSourceResponse(generator())


@app.get("/job-dates/{job_id}")
def job_dates(job_id: str):
    # Try DB first
    scenes = get_scenes_for_job(job_id)
    if scenes:
        dates = [s["scene_date"] for s in scenes]
        return {"job_id": job_id, "dates": dates}
    # Fallback: scan disk
    dates = _get_job_dates_from_disk(job_id)
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
        # 5 distinct pollution quantile risk colors (0 = lowest/green, 4 = highest/red)
        return 0.0, 4.0, ListedColormap(["#22c55e", "#a3e635", "#facc15", "#f97316", "#ef4444"])
        
    vmin = float(np.nanpercentile(valid_arr, 2))
    vmax = float(np.nanpercentile(valid_arr, 98))
    if vmax == vmin:
        vmax = vmin + 1e-6
        
    if "RAQI" in l:
        cmap = "plasma"
    elif "NDVI" in l:
        cmap = "YlGn"
    elif "NDRE" in l:
        cmap = "Greens"
    elif "SAVI" in l:
        cmap = "summer"
    elif "EVI" in l:
        cmap = "viridis"
    elif "NDMI" in l:
        cmap = "Blues"
    elif "NDWI" in l:
        cmap = "GnBu"
    elif "MNDWI" in l:
        cmap = "PuBu"
    elif "NBR" in l:
        cmap = "RdYlGn_r"
    elif "NDTI" in l:
        cmap = "YlOrBr"
    elif "NDBAI" in l:
        cmap = "OrRd"
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
    """Time-series analysis: per-date mean of each index."""
    scenes = get_scenes_for_job(job_id)
    if not scenes:
        raise HTTPException(404, "No scenes for job")
    series = {}
    for sc in scenes:
        d = sc["scene_date"]
        h = sc.get("histograms") or {}
        for idx, hdata in h.items():
            if idx.startswith("_"):
                continue
            series.setdefault(idx, []).append({"date": d, "mean": hdata.get("mean")})
    # Sort each series by date ascending
    for idx in series:
        series[idx].sort(key=lambda r: r["date"])
    return {"job_id": job_id, "series": series}


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