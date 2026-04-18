import { useEffect, useRef } from "react";
import { BASE } from "../utils/api";

const LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
const LEAFLET_JS  = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src; s.async = true;
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}
function loadLink(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = href;
  document.head.appendChild(l);
}

/**
 * CogLeafletMap
 *
 * Renders a Leaflet map loading a COG layer from the backend tile server.
 * The tile URL pattern used: /tiles/{jobId}/{date}/{layer}/{z}/{x}/{y}.png
 *
 * Props:
 *   jobId       – job folder name
 *   date        – scene date string
 *   layer       – layer name: "RAQI", "pollution_clusters", "NDVI", etc.
 *   height      – pixel height of the map (default 260)
 *   label       – badge label shown top-left
 *   aoiGeoJSON  – GeoJSON Polygon geometry to overlay on the map
 *   aoiName     – human-readable name shown as a tooltip on the AOI polygon
 */
export default function CogLeafletMap({ jobId, date, layer, height = 260, label, aoiGeoJSON, aoiName }) {
  const containerRef = useRef(null);
  const mapRef       = useRef(null);
  const tileRef      = useRef(null);
  const aoiLayerRef  = useRef(null);
  const keyRef       = useRef(`${jobId}/${date}/${layer}`);

  useEffect(() => {
    if (!jobId || !date || !layer) return;
    const newKey = `${jobId}/${date}/${layer}`;

    let cancelled = false;

    // Helper: add/replace the AOI polygon layer
    const addAoiLayer = (L, map, geo, name) => {
      if (aoiLayerRef.current) {
        map.removeLayer(aoiLayerRef.current);
        aoiLayerRef.current = null;
      }
      if (!geo) return;
      const layer = L.geoJSON(geo, {
        style: {
          color: "#00f0a8",
          weight: 2,
          opacity: 0.9,
          fillColor: "#00f0a8",
          fillOpacity: 0.07,
          dashArray: "6 4",
        },
      }).addTo(map);
      // Name tooltip removed to prevent occluding the underlying pixels
      aoiLayerRef.current = layer;
    };

    const init = async () => {
      loadLink(LEAFLET_CSS);
      await loadScript(LEAFLET_JS);
      if (cancelled || !containerRef.current) return;

      const L = window.L;

      // Re-use existing map instance but swap out the tile layer
      if (mapRef.current && keyRef.current === newKey) return;

      // If same map but different layer/date, just replace tile layer
      if (mapRef.current && tileRef.current) {
        mapRef.current.removeLayer(tileRef.current);
        const tileUrl = `${BASE}/tiles/${jobId}/${date}/${layer}/{z}/{x}/{y}.png`;
        tileRef.current = L.tileLayer(tileUrl, { opacity: 0.85, maxZoom: 20 }).addTo(mapRef.current);
        addAoiLayer(L, mapRef.current, aoiGeoJSON, aoiName);
        keyRef.current = newKey;
        return;
      }

      // First mount — create the map
      const map = L.map(containerRef.current, {
        center: [20, 0], zoom: 3,
        zoomControl: true, attributionControl: false,
      });
      L.control.attribution({ position: "bottomright", prefix: false }).addTo(map);

      // Dark basemap
      L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { attribution: "© Esri", maxZoom: 18 }
      ).addTo(map);

      // COG layer
      const tileUrl = `${BASE}/tiles/${jobId}/${date}/${layer}/{z}/{x}/{y}.png`;
      const cogLayer = L.tileLayer(tileUrl, {
        opacity: 0.85, maxZoom: 20,
        errorTileUrl: "", // silently skip missing tiles
      }).addTo(map);

      // Try to get bounds from the backend and fit map
      try {
        const res = await fetch(`${BASE}/bounds/${jobId}/${date}/${layer}`);
        if (res.ok) {
          const b = await res.json(); // { xmin, ymin, xmax, ymax }
          if (!cancelled) {
            map.fitBounds([[b.ymin, b.xmin], [b.ymax, b.xmax]], { padding: [16, 16] });
          }
        }
      } catch { /* bounds endpoint optional */ }

      // Add AOI polygon overlay
      addAoiLayer(L, map, aoiGeoJSON, aoiName);

      mapRef.current  = map;
      tileRef.current = cogLayer;
      keyRef.current  = newKey;
    };

    init();

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current  = null;
        tileRef.current = null;
        aoiLayerRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, date, layer]);

  // Update AOI overlay when aoiGeoJSON/aoiName change without remounting the map
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) return;
    const L = window.L;
    if (aoiLayerRef.current) {
      map.removeLayer(aoiLayerRef.current);
      aoiLayerRef.current = null;
    }
    if (!aoiGeoJSON) return;
    const aLayer = L.geoJSON(aoiGeoJSON, {
      style: {
        color: "#00f0a8",
        weight: 2,
        opacity: 0.9,
        fillColor: "#00f0a8",
        fillOpacity: 0.07,
        dashArray: "6 4",
      },
    }).addTo(map);
    // Name tooltip removed to prevent occluding the underlying pixels
    aoiLayerRef.current = aLayer;
  }, [aoiGeoJSON, aoiName]);

  return (
    <div style={{ position: "relative", width: "100%", height, borderRadius: 8, overflow: "hidden" }}>
      {/* Inject AOI label tooltip styles */}
      <style>{`
        .aoi-name-label {
          background: rgba(6,8,11,0.82) !important;
          border: 1px solid rgba(0,240,168,0.5) !important;
          border-radius: 5px !important;
          color: #00f0a8 !important;
          font-family: var(--mono, monospace) !important;
          font-size: 11px !important;
          font-weight: 600 !important;
          padding: 3px 8px !important;
          white-space: nowrap !important;
          backdrop-filter: blur(6px) !important;
          box-shadow: 0 0 10px rgba(0,240,168,0.2) !important;
          pointer-events: none !important;
        }
        .aoi-name-label::before { display: none !important; }
      `}</style>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

      {/* Layer badge */}
      {label && (
        <div style={{
          position: "absolute", top: 8, left: 8, zIndex: 1000,
          background: "rgba(6,8,11,0.82)", border: "1px solid var(--border)",
          borderRadius: 6, padding: "4px 9px", backdropFilter: "blur(8px)",
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--text2)",
          pointerEvents: "none",
        }}>
          {label}
        </div>
      )}

      {/* "No tile server" notice when jobId/date missing */}
      {(!jobId || !date) && (
        <div style={{
          position: "absolute", inset: 0, display: "flex", alignItems: "center",
          justifyContent: "center", background: "var(--surface)", borderRadius: 8,
          flexDirection: "column", gap: 8, opacity: 0.6,
        }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)" }}>
            No job data available
          </div>
        </div>
      )}
    </div>
  );
}
