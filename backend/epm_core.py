import os

# GDAL stability for cloud deployment
os.environ["AWS_NO_SIGN_REQUEST"] = "YES"
os.environ["GDAL_DISABLE_READDIR_ON_OPEN"] = "YES"
os.environ["CPL_VSIL_CURL_ALLOWED_EXTENSIONS"] = ".tif"
os.environ["GDAL_HTTP_UNSAFESSL"] = "YES"
os.environ["GDAL_CACHEMAX"] = "512"

import numpy as np
import geopandas as gpd
import shapely.geometry as geom
from pystac_client import Client
from odc.stac import stac_load
import rioxarray
import os
import rasterio
from rasterio.session import AWSSession
import boto3

# Create unsigned AWS session
aws_session = boto3.Session()
rio_env = rasterio.Env(
    AWSSession(aws_session, aws_unsigned=True)
)

rio_env.__enter__()

os.environ["AWS_NO_SIGN_REQUEST"] = "YES"


# ----------------------------------------
# Configuration
# ----------------------------------------

STAC_URL = "https://earth-search.aws.element84.com/v1"
COLLECTION = "sentinel-2-l2a"
S2_BANDS = ["blue", "green", "red", "nir", "scl"]



# ----------------------------------------
# Main Processing Function
# ----------------------------------------

def run_epm(aoi: dict, start_date: str, end_date: str, logs: list):

    # 1️⃣ Load AOI
    logs.append("Loading AOI geometry...")
    aoi_geom = geom.shape(aoi)

    # 2️⃣ Connect to STAC
    logs.append("Connecting to STAC API...")
    client = Client.open(STAC_URL)

    search = client.search(
        collections=[COLLECTION],
        intersects=aoi_geom.__geo_interface__,
        datetime=f"{start_date}/{end_date}",
        max_items=20
    )

    items = list(search.items())

    if len(items) == 0:
        raise Exception("No Sentinel-2 scenes found.")

    logs.append(f"{len(items)} scenes found.")

    # 3️⃣ Load Raster Data (no Dask chunks → stable)
    logs.append("Loading raster data...")

    ds = stac_load(
        items,
        bands=S2_BANDS,
        resolution=10,
        groupby="solar_day"
    )

    # Force full load into memory (avoids Dask hanging)
    ds = ds.load()

    # 4️⃣ Reproject AOI to Raster CRS
    logs.append("Clipping to AOI...")

    gdf = gpd.GeoDataFrame(
        geometry=[aoi_geom],
        crs="EPSG:4326"
    )

    gdf = gdf.to_crs(ds.rio.crs)
    ds = ds.rio.clip(gdf.geometry, gdf.crs, drop=True)

    if ds["B02"].size == 0:
        raise Exception("No raster data inside AOI after clipping.")

    # 5️⃣ Apply SCL Cloud Mask
    logs.append("Applying SCL cloud mask...")

    scl = ds["scl"]

    # Keep only vegetation (4) and bare soil (5)
    valid_mask = (scl == 4) | (scl == 5)

    ds_masked = ds.where(valid_mask)

    # 6️⃣ NDVI Calculation
    logs.append("Calculating NDVI...")

    red = ds_masked["B04"].astype("float32")
    nir = ds_masked["B08"].astype("float32")

    ndvi = (nir - red) / (nir + red)
    ndvi = ndvi.where((nir + red) != 0)
    ndvi = ndvi.where((ndvi >= -1) & (ndvi <= 1))

    # 7️⃣ Compute Statistics Per Date
    logs.append("Computing statistics...")

    summary = []

    for t in ndvi.time.values:

        ndvi_t = ndvi.sel(time=t)

        if ndvi_t.count().values == 0:
            continue

        mean_ndvi = float(ndvi_t.mean().values)
        min_ndvi = float(ndvi_t.min().values)
        max_ndvi = float(ndvi_t.max().values)

        summary.append({
            "date": str(np.datetime_as_string(t, unit="D")),
            "mean_ndvi": round(mean_ndvi, 4),
            "min_ndvi": round(min_ndvi, 4),
            "max_ndvi": round(max_ndvi, 4)
        })

    if len(summary) == 0:
        raise Exception("All pixels masked (cloud-covered AOI).")

    logs.append("EPM processing completed successfully.")

    return {
        "summary": summary,
        "dates_processed": len(summary),
        "total_scenes": len(items)
    }
