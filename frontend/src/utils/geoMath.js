/**
 * Shared spatial mathematics utilities for EPM frontend.
 */

export function computeAoiMeta(aoi) {
  if (!aoi) return null;
  
  let polygon, props = {};
  if (aoi.type === "FeatureCollection") {
    polygon = aoi.features?.[0]?.geometry;
    props = aoi.features?.[0]?.properties || {};
  } else if (aoi.type === "Feature") {
    polygon = aoi.geometry;
    props = aoi.properties || {};
  } else if (aoi.type === "Polygon") {
    polygon = aoi;
  }
  
  if (!polygon || polygon.type !== "Polygon") return null;
  
  const ring = polygon.coordinates?.[0] ?? [];
  if (ring.length < 3) return null;

  const R = 6371;
  const toRad = d => d * Math.PI / 180;

  const lons = ring.map(p => p[0]);
  const lats = ring.map(p => p[1]);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);

  // True centroid via polygon centroid formula
  let cx = 0, cy = 0, signedArea = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
    const cross = x0 * y1 - x1 * y0;
    signedArea += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  signedArea /= 2;
  const cLon = signedArea === 0 ? (minLon + maxLon) / 2 : cx / (6 * signedArea);
  const cLat = signedArea === 0 ? (minLat + maxLat) / 2 : cy / (6 * signedArea);

  // Polygon area via Shoelace + Haversine scaling (km²)
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
    area += toRad(x1 - x0) * (2 + Math.sin(toRad(y0)) + Math.sin(toRad(y1)));
  }
  const areaKm2 = Math.abs(area * R * R / 2);

  // Perimeter
  let perimKm = 0;
  let maxEdgeKm = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon0, lat0] = ring[i], [lon1, lat1] = ring[i + 1];
    const dlat = toRad(lat1 - lat0), dlon = toRad(lon1 - lon0);
    const a = Math.sin(dlat/2)**2 + Math.cos(toRad(lat0)) * Math.cos(toRad(lat1)) * Math.sin(dlon/2)**2;
    const d = 2 * R * Math.asin(Math.sqrt(a));
    perimKm += d;
    if (d > maxEdgeKm) maxEdgeKm = d;
  }

  const widthKm = R * toRad(maxLon - minLon) * Math.cos(toRad(cLat));
  const heightKm = R * toRad(maxLat - minLat);

  const fmtArea = areaKm2 >= 1000 
    ? `${(areaKm2 / 1000).toFixed(2)} M km2` 
    : areaKm2 >= 1 ? `${areaKm2.toFixed(2)} km2` 
    : `${(areaKm2 * 1e6).toFixed(0)} m2`;

  const latLabel = cLat >= 0 ? `${cLat.toFixed(4)}N` : `${Math.abs(cLat).toFixed(4)}S`;
  const lonLabel = cLon >= 0 ? `${cLon.toFixed(4)}E` : `${Math.abs(cLon).toFixed(4)}W`;

  return {
    minLon, maxLon, minLat, maxLat,
    cLon, cLat, latLabel, lonLabel,
    areaKm2, fmtArea, widthKm, heightKm,
    perimKm, maxEdgeKm,
    vertices: ring.length - 1,
    name: props.name || ""
  };
}
