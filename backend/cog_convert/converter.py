import os
import rasterio
from rasterio.shutil import copy as rio_copy
from rasterio.enums import Resampling
from concurrent.futures import ThreadPoolExecutor

# These are the index/derived outputs the tile server actually reads.
# Raw band names (red, nir, green, …) are intentionally excluded.
INDEX_TIFS = {
    "NDVI", "NDRE", "NDMI", "NDWI", "MNDWI", "NBR",
    "NDTI", "NDBAI", "SAVI", "EVI", "RAQI", "pollution_clusters",
}


def _convert_one(file_path):
    """Convert a single TIFF to COG in-place. Returns (filename, ok, error)."""
    filename = os.path.basename(file_path)
    temp_cog_path = file_path.replace(".tif", "_tmp.tif")
    try:
        with rasterio.open(file_path) as src:
            profile = src.profile.copy()
            profile.update(
                driver="GTiff",
                tiled=True,
                blockxsize=256,
                blockysize=256,
                compress="DEFLATE",
                predictor=2,
                BIGTIFF="IF_SAFER",
            )
            rio_copy(src, temp_cog_path, **profile)

        with rasterio.open(temp_cog_path, "r+") as dst:
            dst.build_overviews([2, 4, 8, 16], Resampling.average)
            dst.update_tags(ns="rio_overview", resampling="average")

        os.replace(temp_cog_path, file_path)   # atomic rename
        return filename, True, None
    except Exception as e:
        if os.path.exists(temp_cog_path):
            try:
                os.remove(temp_cog_path)
            except Exception:
                pass
        return filename, False, str(e)


def convert_folder_to_cog(folder_path, max_workers=6, index_only=False):
    """
    Convert TIFFs in folder_path to COGs in parallel.

    index_only=True  — only convert index/RAQI/cluster TIFs (the ones
                       actually served as map tiles). Raw band TIFs are
                       skipped, saving ~350 s per date for a large AOI.
    max_workers      — parallel converter threads (default 6; tune to CPU).
    """
    print("Starting optimized COG conversion...")

    tif_files = []
    for f in os.listdir(folder_path):
        if not f.lower().endswith(".tif") or "_tmp" in f:
            continue
        if index_only:
            stem = os.path.splitext(f)[0]
            if stem not in INDEX_TIFS:
                continue
        tif_files.append(os.path.join(folder_path, f))

    if not tif_files:
        print("No TIF files to convert.")
        return

    with ThreadPoolExecutor(max_workers=min(max_workers, len(tif_files))) as ex:
        for filename, ok, err in ex.map(_convert_one, tif_files):
            if ok:
                print(f"{filename} successfully converted and replaced.")
            else:
                print(f"ERROR converting {filename}: {err}")

    print("COG conversion complete. Folder cleaned.")
