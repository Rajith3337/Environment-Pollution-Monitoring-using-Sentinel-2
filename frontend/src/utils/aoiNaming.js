function polygonCentroid(geo) {
  const ring = geo?.coordinates?.[0] ?? [];
  if (ring.length < 3) return null;

  let cx = 0;
  let cy = 0;
  let signedArea = 0;

  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const cross = x0 * y1 - x1 * y0;
    signedArea += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }

  if (Math.abs(signedArea) < 1e-9) {
    const lons = ring.map(([lon]) => lon);
    const lats = ring.map(([, lat]) => lat);
    return {
      lon: (Math.min(...lons) + Math.max(...lons)) / 2,
      lat: (Math.min(...lats) + Math.max(...lats)) / 2,
    };
  }

  signedArea /= 2;
  return {
    lon: cx / (6 * signedArea),
    lat: cy / (6 * signedArea),
  };
}

function uniquePush(values, value) {
  if (!value) return;
  const trimmed = String(value).trim();
  if (!trimmed) return;
  if (!values.some((item) => item.toLowerCase() === trimmed.toLowerCase())) {
    values.push(trimmed);
  }
}

function formatAddressName(address = {}) {
  const primary = [];
  const secondary = [];

  uniquePush(primary, address.neighbourhood);
  uniquePush(primary, address.suburb);
  uniquePush(primary, address.hamlet);
  uniquePush(primary, address.village);
  uniquePush(primary, address.town);
  uniquePush(primary, address.city);
  uniquePush(primary, address.municipality);

  uniquePush(secondary, address.city_district);
  uniquePush(secondary, address.state_district);
  uniquePush(secondary, address.county);
  uniquePush(secondary, address.state);
  uniquePush(secondary, address.country);

  const parts = [];
  if (primary[0]) parts.push(primary[0]);
  if (secondary[0] && secondary[0].toLowerCase() !== (primary[0] || "").toLowerCase()) {
    parts.push(secondary[0]);
  }
  if (!parts.length && secondary[0]) parts.push(secondary[0]);

  return parts.length ? parts.join(", ") : null;
}

const reverseGeocodeCache = new Map();
const PLACEHOLDER_NAMES = new Set(["aoi", "custom aoi", "uploaded aoi", "drawn aoi"]);

export function getAoiCentroid(geo) {
  return polygonCentroid(geo);
}

export function getAoiFallbackName(geo) {
  const c = polygonCentroid(geo);
  if (!c) return "AOI";
  const lat = c.lat >= 0 ? `${c.lat.toFixed(2)}N` : `${Math.abs(c.lat).toFixed(2)}S`;
  const lon = c.lon >= 0 ? `${c.lon.toFixed(2)}E` : `${Math.abs(c.lon).toFixed(2)}W`;
  return `AOI ${lat}, ${lon}`;
}

export function isPlaceholderAoiName(name) {
  if (typeof name !== "string") return true;
  const normalized = name.trim().toLowerCase();
  return !normalized || PLACEHOLDER_NAMES.has(normalized);
}

export async function resolveAoiName(geo) {
  const centroid = polygonCentroid(geo);
  if (!centroid) return "AOI";

  const cacheKey = `${centroid.lat.toFixed(4)},${centroid.lon.toFixed(4)}`;
  if (reverseGeocodeCache.has(cacheKey)) {
    return reverseGeocodeCache.get(cacheKey);
  }

  const fallback = "Custom AOI";

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${centroid.lat}&lon=${centroid.lon}&zoom=12&addressdetails=1`,
      {
        headers: {
          "Accept-Language": "en",
        },
      },
    );

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const name =
      formatAddressName(data?.address) ||
      data?.name ||
      data?.display_name?.split(",").slice(0, 2).join(", ").trim() ||
      fallback;

    reverseGeocodeCache.set(cacheKey, name);
    return name;
  } catch {
    reverseGeocodeCache.set(cacheKey, fallback);
    return fallback;
  }
}
