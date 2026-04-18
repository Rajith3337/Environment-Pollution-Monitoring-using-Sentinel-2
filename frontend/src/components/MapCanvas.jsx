import { useEffect, useRef } from "react";
import { Icon } from "./Icons";

const LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
const LEAFLET_JS  = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
const DRAW_CSS    = "https://cdnjs.cloudflare.com/ajax/libs/leaflet.draw/1.0.4/leaflet.draw.css";
const DRAW_JS     = "https://cdnjs.cloudflare.com/ajax/libs/leaflet.draw/1.0.4/leaflet.draw.js";

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.getAttribute("data-loaded")) { resolve(); return; }
      existing.addEventListener("load", resolve);
      existing.addEventListener("error", reject);
      return;
    }
    const s = document.createElement("script");
    s.src = src; s.async = true;
    s.onload = () => { s.setAttribute("data-loaded", "true"); resolve(); };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}
function loadLink(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = href;
  document.head.appendChild(l);
}

export default function MapCanvas({ hasPolygon, aoiGeojson, onDraw, mapType }) {
  const containerRef = useRef(null);
  const mapRef       = useRef(null);
  const drawnRef     = useRef(null);
  const readyRef     = useRef(false);
  const pendingRef   = useRef(undefined);

  function renderAoi(L, map, drawn, geojson) {
    drawn.clearLayers();
    if (!geojson) return;
    const layer = L.geoJSON(geojson, {
      style: { color: "#00f0a8", weight: 2, fillColor: "#00f0a8", fillOpacity: 0.12, dashArray: "4,4" },
    });
    layer.eachLayer(l => drawn.addLayer(l));
    const bounds = drawn.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [60, 60], maxZoom: 14 });
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      loadLink(LEAFLET_CSS);
      loadLink(DRAW_CSS);
      await loadScript(LEAFLET_JS);
      await loadScript(DRAW_JS);
      if (cancelled || !containerRef.current || mapRef.current) return;

      const L = window.L;
      const map = L.map(containerRef.current, { center: [20, 0], zoom: 2, zoomControl: false });

      // 1. Satellite Base layer
      const googleSat = L.tileLayer(
        "https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
        { attribution: "© Google Maps", subdomains: "0123", maxZoom: 20, maxNativeZoom: 20, tileSize: 256 }
      );

      const cartoLabels = L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png",
        { attribution: "© CARTO", opacity: 0.85, maxZoom: 19, subdomains: "abcd" }
      );
      
      const satelliteBase = L.layerGroup([googleSat, cartoLabels]);

      // 2. Political/Geographic Boundary map (Fast, clean aesthetic mapping)
      const cartoPolitical = L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
        { attribution: "© CARTO", maxZoom: 19, subdomains: "abcd" }
      );

      // Add default base to map
      satelliteBase.addTo(map);

      // Add Map Switch Control (Removed from map UI, now handled by App.jsx Header)

      L.control.zoom({ position: "topright" }).addTo(map);

      // Store references to the basemaps so we can toggle them later in useEffect
      mapRef.current = map;
      window.__satelliteBase = satelliteBase;
      window.__cartoPolitical = cartoPolitical;

      const drawn = new L.FeatureGroup().addTo(map);
      drawnRef.current = drawn;

      new L.Control.Draw({
        position: "topright",
        draw: {
          polygon: {
            shapeOptions: { color: "#00f0a8", fillColor: "#00f0a8", fillOpacity: 0.12, weight: 2, dashArray: "4,4" },
            allowIntersection: false,
          },
          polyline: false, rectangle: false, circle: false,
          marker: false, circlemarker: false,
        },
        edit: { featureGroup: drawn },
      }).addTo(map);

      map.on(L.Draw.Event.CREATED, (e) => {
        drawn.clearLayers();
        drawn.addLayer(e.layer);
        if (onDraw) onDraw(e.layer.toGeoJSON().geometry);
      });

      readyRef.current = true;

      if (pendingRef.current !== undefined) {
        renderAoi(L, map, drawn, pendingRef.current);
        pendingRef.current = undefined;
      }
    })();

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        drawnRef.current = null;
        readyRef.current = false;
      }
    };
  }, []); // eslint-disable-line

  useEffect(() => {
    if (!readyRef.current || !mapRef.current || !drawnRef.current) {
      pendingRef.current = aoiGeojson ?? null;
      return;
    }
    renderAoi(window.L, mapRef.current, drawnRef.current, aoiGeojson ?? null);
  }, [aoiGeojson]); // eslint-disable-line

  useEffect(() => {
    if (hasPolygon) return;
    if (!readyRef.current || !mapRef.current || !drawnRef.current) return;
    drawnRef.current.clearLayers();
    mapRef.current.setView([20, 0], 2);
  }, [hasPolygon]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    if (mapType === "satellite") {
      map.removeLayer(window.__cartoPolitical);
      map.addLayer(window.__satelliteBase);
    } else {
      map.removeLayer(window.__satelliteBase);
      map.addLayer(window.__cartoPolitical);
    }
  }, [mapType]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

      {/* Satellite badge */}
      <div style={{
        position: "absolute", top: 12, left: 12, zIndex: 1000,
        background: "rgba(6,8,11,0.85)", border: "1px solid var(--border2)",
        borderRadius: 8, padding: "8px 12px", backdropFilter: "blur(12px)",
        pointerEvents: "none",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Icon.Satellite />
          <div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text2)" }}>SENTINEL-2 L2A</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)" }}>ESA Copernicus Program</div>
          </div>
        </div>
      </div>

      {/* Draw hint */}
      {!hasPolygon && (
        <div style={{
          position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)",
          zIndex: 1000, whiteSpace: "nowrap", pointerEvents: "none",
          background: "rgba(6,8,11,0.88)", border: "1px solid var(--border2)",
          borderRadius: 8, padding: "10px 16px", backdropFilter: "blur(12px)",
          fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)",
          display: "flex", alignItems: "center", gap: 8,
          animation: "fadeUp 0.5s ease",
        }}>
          <Icon.Polygon />
          Click <kbd style={{ background: "var(--border2)", padding: "2px 7px", borderRadius: 4, color: "var(--text)", margin: "0 2px" }}>⬡</kbd> to draw an AOI · or upload KML
        </div>
      )}

      {/* AOI defined badge */}
      {hasPolygon && (
        <div style={{
          position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)",
          zIndex: 1000, pointerEvents: "none",
          background: "rgba(0,240,168,0.08)", border: "1px solid rgba(0,240,168,0.25)",
          borderRadius: 8, padding: "8px 16px", backdropFilter: "blur(12px)",
          fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)",
          display: "flex", alignItems: "center", gap: 7,
          animation: "fadeUp 0.3s ease",
        }}>
          <div style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent)", boxShadow: "0 0 6px var(--accent)" }} />
          AOI Selected
        </div>
      )}
    </div>
  );
}
