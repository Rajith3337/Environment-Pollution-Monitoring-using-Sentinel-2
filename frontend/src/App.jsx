import { useState, useCallback, useRef, useEffect, Suspense, lazy } from "react";
import "./styles/globals.css";

import Header          from "./components/Header";
import AOIPanel        from "./components/AOIPanel";
import ProcessingPanel from "./components/ProcessingPanel";
const MapCanvas = lazy(() => import("./components/MapCanvas"));
const Dashboard = lazy(() => import("./components/dashboard/Dashboard"));
import { Icon }        from "./components/Icons";
import { usePipeline } from "./hooks/usePipeline";
import { getAoiFallbackName, resolveAoiName } from "./utils/aoiNaming";

function parseKml(text) {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.querySelector("parsererror")) throw new Error("Invalid KML/XML");
  const coordNodes = Array.from(doc.querySelectorAll("coordinates"));
  if (!coordNodes.length) throw new Error("No <coordinates> found in KML");
  const raw = coordNodes.map(n => n.textContent.trim()).sort((a, b) => b.length - a.length)[0];
  const pts = raw.split(/\s+/).map(s => s.trim()).filter(Boolean)
    .map(s => { const [lng, lat] = s.split(",").map(Number); return isNaN(lng)||isNaN(lat)?null:[lng,lat]; })
    .filter(Boolean);
  if (pts.length < 3) throw new Error("Need ≥ 3 coordinate points");
  const ring = (pts[0][0]===pts.at(-1)[0] && pts[0][1]===pts.at(-1)[1]) ? pts : [...pts, pts[0]];
  return { type: "Polygon", coordinates: [ring] };
}

function parseGeoJson(text) {
  const j = JSON.parse(text);
  if (j.type === "Polygon") return j;
  if (j.type === "Feature" && j.geometry?.type === "Polygon") return j.geometry;
  if (j.type === "FeatureCollection") {
    const f = j.features?.find(x => x.geometry?.type === "Polygon");
    if (f) return f.geometry;
  }
  throw new Error("No Polygon geometry found in GeoJSON");
}

function extractKmlName(text) {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  const pick = (sel) => {
    const n = doc.querySelector(sel);
    return n?.textContent?.trim() || null;
  };
  return pick("Placemark > name") || pick("Document > name") || pick("name");
}

function extractGeoJsonName(text) {
  const j = JSON.parse(text);
  if (typeof j?.name === "string" && j.name.trim()) return j.name.trim();
  if (j?.type === "Feature" && j?.properties) {
    const p = j.properties;
    return p.name || p.NAME || p.title || p.label || null;
  }
  if (j?.type === "FeatureCollection") {
    for (const f of (j.features || [])) {
      const p = f?.properties || {};
      const n = p.name || p.NAME || p.title || p.label;
      if (n) return n;
    }
  }
  return null;
}

export default function App() {
  const [startDate,  setStartDate]  = useState("");
  const [endDate,    setEndDate]    = useState("");
  const [kmlFile,    setKmlFile]    = useState(null);
  const [aoi,        setAoi]        = useState(null);
  const [aoiName,    setAoiName]    = useState(null);
  const [hasPolygon, setHasPolygon] = useState(false);
  const [dashboard,  setDashboard]  = useState(false);
  const [justDone,   setJustDone]   = useState(false);
  const [mapType,    setMapType]    = useState("satellite");

  const fileInputRef     = useRef(null);
  const sidebarRef       = useRef(null);   // scrollable sidebar
  const processPanelRef  = useRef(null);   // ProcessingPanel wrapper — scroll target 1
  const ctaRef           = useRef(null);   // View Results CTA — scroll target 3

  const { status, steps, liveStep, logs, results, history, jobId, dateProgress, cancelling, start, reset, addLog, changeDate, cancel, refreshHistory } = usePipeline();

  // Scroll 1 — Start clicked: show pipeline panel + live output from top
  // Scroll 1: Start clicked → snap so pipeline panel top aligns with sidebar top
  // Uses getBoundingClientRect for accuracy (offsetTop breaks with flex gaps)
  const scrollToProcessLog = useCallback(() => {
    setTimeout(() => {
      const sb = sidebarRef.current;
      const pp = processPanelRef.current;
      if (!sb || !pp) return;
      const sbRect = sb.getBoundingClientRect();
      const ppRect = pp.getBoundingClientRect();
      const newTop = sb.scrollTop + (ppRect.top - sbRect.top) - 8;
      sb.scrollTo({ top: Math.max(0, newTop), behavior: "smooth" });
    }, 120);
  }, []);

  // Scroll 2: new date starts during multi-date run → scroll log terminal into view
  // (handled via auto-scroll inside LogTerminal — nothing needed here)

  // Scroll 3: results ready / error → scroll to show View Results / error at bottom
  const scrollToCta = useCallback(() => {
    setTimeout(() => {
      const sb  = sidebarRef.current;
      const cta = ctaRef.current;
      if (!sb || !cta) return;
      const sbRect  = sb.getBoundingClientRect();
      const ctaRect = cta.getBoundingClientRect();
      // Scroll so the CTA bottom is visible (aligned near bottom of sidebar)
      const newTop = sb.scrollTop + (ctaRect.bottom - sbRect.bottom) + 16;
      sb.scrollTo({ top: Math.max(0, newTop), behavior: "smooth" });
    }, 200);
  }, []);

  // When pipeline finishes → pulse View Results + scroll to it
  useEffect(() => {
    if (status === "done") {
      setJustDone(true);
      scrollToCta();          // Scroll 3
    } else if (status === "aoi_error" || status === "error") {
      setJustDone(false);
      scrollToCta();          // Scroll to error message
    } else {
      setJustDone(false);
    }
  }, [status, scrollToCta]);

  const handleKmlUpload = useCallback((e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    e.target.value = "";
    setKmlFile(f);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const text   = ev.target.result;
        const isJson = f.name.endsWith(".json") || f.name.endsWith(".geojson");
        const geo    = isJson ? parseGeoJson(text) : parseKml(text);

        const fallback = getAoiFallbackName(geo);
        setAoi(geo);
        setAoiName(fallback);
        setHasPolygon(true);
        addLog(`AOI loaded (${geo.coordinates[0].length - 1} vertices) — resolving location…`, "success");

        // Always prioritize geographically resolving the name from coords, completely ignoring arbitrary KML filenames
        resolveAoiName(geo).then((name) => {
          setAoiName(name);
          addLog(`AOI location resolved: "${name}"`, "info");
        }).catch(() => {
          addLog("Location resolution skipped — using fallback geometry label", "warn");
        });
      } catch (err) {
        addLog(`Parse error: ${err.message}`, "error");
        setKmlFile(null);
      }
    };
    reader.onerror = () => addLog("Failed to read file", "error");
    reader.readAsText(f);
  }, [addLog]);

  const handlePolygonDrawn = useCallback((geo) => {
    setAoi(geo);
    const fallback = getAoiFallbackName(geo);
    setAoiName(fallback);
    setHasPolygon(true);
    addLog(`AOI polygon drawn (${(geo.coordinates?.[0]?.length ?? 1) - 1} vertices) — resolving location…`, "success");
    resolveAoiName(geo).then((name) => {
      setAoiName(name);
      addLog(`AOI location resolved: "${name}"`, "info");
    });
  }, [addLog]);

  const handleClear = useCallback(() => {
    if (fileInputRef.current) fileInputRef.current.value = "";
    setKmlFile(null);
    setAoi(null);
    setAoiName(null);
    setHasPolygon(false);
    reset();
  }, [reset]);

  const handleStart = useCallback(() => {
    scrollToProcessLog();
    start({ aoi, aoiName, startDate, endDate, hasPolygon });
  }, [start, scrollToProcessLog, aoi, aoiName, startDate, endDate, hasPolygon]);

  if (dashboard) {
    return (
      <Suspense fallback={<div style={{ height: "100vh", width: "100vw", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)", color: "var(--accent)", fontFamily: "var(--sans)", fontSize: 14 }}>Loading Dashboard...</div>}>
        <Dashboard
          results={results}
          history={history}
          jobId={jobId}
          onExit={() => setDashboard(false)}
          onChangeDate={changeDate}
        />
      </Suspense>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", width: "100vw", background: "var(--bg)" }}>
      <Header status={status} jobCount={history.length} mapType={mapType} setMapType={setMapType} />

      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "330px 1fr", overflow: "hidden" }}>
        {/* ── Sidebar ────────────────────────────────────────────────────── */}
        <div ref={sidebarRef} style={{
          background: "var(--surface)", borderRight: "1px solid var(--border)",
          overflowY: "auto", padding: 14,
          display: "flex", flexDirection: "column", gap: 12,
        }}>
          <AOIPanel
            startDate={startDate}   setStartDate={setStartDate}
            endDate={endDate}       setEndDate={setEndDate}
            kmlFile={kmlFile}       onKmlUpload={handleKmlUpload}
            fileInputRef={fileInputRef}
            hasPolygon={hasPolygon}
            aoiName={aoiName}
            status={status}
            onStart={handleStart}
            onClear={handleClear}
          />

          {/* AOI Metadata panel — shown when polygon is defined */}
          {hasPolygon && aoi && (
            <AoiMetaPanel aoi={aoi} startDate={startDate} endDate={endDate} />
          )}

          {/* ProcessingPanel wrapper — we scroll to this on start */}
          <div ref={processPanelRef}>
            <ProcessingPanel steps={steps} liveStep={liveStep} logs={logs} status={status} dateProgress={dateProgress} onCancel={cancel} cancelling={cancelling} />
          </div>

          {/* Dashboard CTA — always visible */}
          <div ref={ctaRef}>
            <DashboardCTA
              hasResults={history.length > 0}
              history={history}
              justDone={justDone}
              status={status}
              onClick={() => { refreshHistory(); setDashboard(true); setJustDone(false); }}
            />
          </div>

          {(status === "error" || status === "aoi_error") && (
            <div style={{
              borderRadius: 10, overflow: "hidden",
              border: `1px solid ${status === "aoi_error" ? "rgba(251,191,36,0.35)" : "rgba(248,113,113,0.3)"}`,
              animation: "fadeUp 0.3s ease",
            }}>
              {/* Header bar */}
              <div style={{
                padding: "9px 12px",
                background: status === "aoi_error" ? "rgba(251,191,36,0.12)" : "rgba(248,113,113,0.12)",
                display: "flex", alignItems: "center", gap: 8,
                borderBottom: `1px solid ${status === "aoi_error" ? "rgba(251,191,36,0.25)" : "rgba(248,113,113,0.2)"}`,
              }}>
                <Icon.Alert />
                <span style={{
                  fontFamily: "var(--sans)", fontWeight: 700, fontSize: 11,
                  color: status === "aoi_error" ? "var(--warn)" : "var(--danger)",
                }}>
                  {status === "aoi_error" ? "No Usable Scenes Found" : "Pipeline Error"}
                </span>
              </div>
              {/* Body */}
              <div style={{ padding: "10px 12px", background: "var(--panel)" }}>
                {status === "aoi_error" ? (
                  <>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", marginBottom: 8, lineHeight: 1.7 }}>
                      All Sentinel-2 scenes for this AOI were rejected.
                      Check the live output above for details.
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      {[
                        { icon: "☁", text: "All pixels exceeded the cloud cover threshold", fix: "Try a wider date range or raise cloud limit" },
                        { icon: "🌊", text: "AOI is over open water or has no vegetation", fix: "Select a land-based area" },
                        { icon: "📅", text: "Date range too narrow — no Sentinel-2 passes", fix: "Use at least a 2-week window" },
                        { icon: "📐", text: "AOI polygon may be too small (< 1 km²)", fix: "Draw a larger area" },
                      ].map(({ icon, text, fix }) => (
                        <div key={text} style={{
                          padding: "5px 8px", borderRadius: 6,
                          background: "rgba(251,191,36,0.05)", border: "1px solid rgba(251,191,36,0.1)",
                        }}>
                          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--warn)", marginBottom: 2 }}>
                            {icon} {text}
                          </div>
                          <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--muted)", paddingLeft: 14 }}>
                            → {fix}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", lineHeight: 1.7 }}>
                    An unexpected error occurred. Check the live output log above for the full traceback.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Map ──────────────────────────────────────────────────────── */}
        <div style={{ position: "relative", overflow: "hidden" }}>
          <Suspense fallback={<div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--surface)", color: "var(--muted)", fontFamily: "var(--mono)", fontSize: 11 }}>Initializing Map System...</div>}>
            <MapCanvas hasPolygon={hasPolygon} aoiGeojson={aoi} onDraw={handlePolygonDrawn} mapType={mapType} />
          </Suspense>
        </div>
      </div>

      <footer style={{
        height: 26, background: "var(--surface)", borderTop: "1px solid var(--border)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", letterSpacing: 0.5,
      }}>
        Environmental Pollution Monitor · Sentinel-2 STAC Pipeline · Final Year Project
      </footer>
    </div>
  );
}


// ── AOI Metadata Panel ────────────────────────────────────────────────────────
function computeAoiMeta(aoi) {
  if (!aoi || aoi.type !== "Polygon") return null;
  const ring = aoi.coordinates?.[0] ?? [];
  if (ring.length < 3) return null;

  const R = 6371;
  const toRad = d => d * Math.PI / 180;

  // Bounding box (for reference only — NOT used for Width/Height display)
  const lons = ring.map(p => p[0]);
  const lats = ring.map(p => p[1]);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);

  // True centroid via polygon centroid formula (not bbox midpoint)
  let cx = 0, cy = 0, signedArea = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
    const cross = x0 * y1 - x1 * y0;
    signedArea += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  signedArea /= 2;
  cx = cx / (6 * signedArea);
  cy = cy / (6 * signedArea);
  const cLon = cx, cLat = cy;

  // Polygon area via Shoelace + Haversine scaling (km²)
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
    area += toRad(x1 - x0) * (2 + Math.sin(toRad(y0)) + Math.sin(toRad(y1)));
  }
  const areaKm2 = Math.abs(area * R * R / 2);

  // Perimeter — sum of geodesic edge lengths
  let perimKm = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon0, lat0] = ring[i], [lon1, lat1] = ring[i + 1];
    const dlat = toRad(lat1 - lat0), dlon = toRad(lon1 - lon0);
    const a = Math.sin(dlat/2)**2 + Math.cos(toRad(lat0)) * Math.cos(toRad(lat1)) * Math.sin(dlon/2)**2;
    perimKm += 2 * R * Math.asin(Math.sqrt(a));
  }

  // Longest edge (max side length)
  let maxEdgeKm = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon0, lat0] = ring[i], [lon1, lat1] = ring[i + 1];
    const dlat = toRad(lat1 - lat0), dlon = toRad(lon1 - lon0);
    const a = Math.sin(dlat/2)**2 + Math.cos(toRad(lat0)) * Math.cos(toRad(lat1)) * Math.sin(dlon/2)**2;
    const d = 2 * R * Math.asin(Math.sqrt(a));
    if (d > maxEdgeKm) maxEdgeKm = d;
  }

  const latLabel = cLat >= 0 ? `${cLat.toFixed(4)}°N` : `${Math.abs(cLat).toFixed(4)}°S`;
  const lonLabel = cLon >= 0 ? `${cLon.toFixed(4)}°E` : `${Math.abs(cLon).toFixed(4)}°W`;

  return {
    minLon, maxLon, minLat, maxLat,
    cLon, cLat, latLabel, lonLabel,
    areaKm2, perimKm, maxEdgeKm,
    vertices: ring.length - 1,
  };
}

function AoiMetaPanel({ aoi, startDate, endDate }) {
  const meta = computeAoiMeta(aoi);
  if (!meta) return null;

  const fmt = n => n >= 1000
    ? `${(n / 1000).toFixed(2)} M km²`
    : n >= 1 ? `${n.toFixed(2)} km²`
    : `${(n * 1e6).toFixed(0)} m²`;

  // ── Build normalized SVG polygon from actual coordinates ─────────────────
  const ring = aoi.coordinates?.[0] ?? [];
  const lons = ring.map(p => p[0]);
  const lats = ring.map(p => p[1]);
  const lonMin = Math.min(...lons), lonMax = Math.max(...lons);
  const latMin = Math.min(...lats), latMax = Math.max(...lats);
  const PAD = 8, VW = 180, VH = 70;
  const toSvgX = lon => PAD + ((lon - lonMin) / (lonMax - lonMin || 1)) * (VW - PAD*2);
  const toSvgY = lat => (VH - PAD) - ((lat - latMin) / (latMax - latMin || 1)) * (VH - PAD*2);
  const pts = ring.slice(0, -1).map(p => `${toSvgX(p[0]).toFixed(1)},${toSvgY(p[1]).toFixed(1)}`).join(" ");

  return (
    <div style={{
      background: "var(--panel)", border: "1px solid var(--border)",
      borderRadius: 12, padding: "12px 14px", animation: "fadeUp 0.3s ease",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <div style={{ width: 3, height: 12, borderRadius: 2, background: "linear-gradient(180deg,var(--accent),var(--accent2))", flexShrink: 0 }} />
        <span style={{ fontFamily: "var(--sans)", fontWeight: 700, fontSize: 11, color: "var(--text2)", letterSpacing: 1, textTransform: "uppercase" }}>
          AOI Metadata
        </span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", marginLeft: "auto" }}>
          {meta.vertices} vertices
        </span>
      </div>

      {/* Area highlight */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "7px 10px", borderRadius: 8, marginBottom: 8,
        background: "rgba(0,240,168,0.07)", border: "1px solid rgba(0,240,168,0.15)",
      }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)" }}>TOTAL AREA</span>
        <span style={{ fontFamily: "var(--sans)", fontWeight: 800, fontSize: 14, color: "var(--accent)" }}>
          {fmt(meta.areaKm2)}
        </span>
      </div>

      {/* Centroid */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "6px 10px", borderRadius: 8, marginBottom: 8,
        background: "rgba(14,165,233,0.07)", border: "1px solid rgba(14,165,233,0.15)",
      }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)" }}>CENTROID</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--accent2)" }}>
          {meta.latLabel} · {meta.lonLabel}
        </span>
      </div>

      {/* Actual polygon shape SVG */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--muted)", marginBottom: 4, letterSpacing: 0.5 }}>
          POLYGON SHAPE
        </div>
        <div style={{
          background: "var(--surface)", borderRadius: 8,
          border: "1px solid var(--border)", overflow: "hidden",
          position: "relative",
        }}>
          <svg viewBox={`0 0 ${VW} ${VH}`} width="100%" height={VH} style={{ display: "block" }}>
            {/* Grid dots */}
            {[0.25,0.5,0.75].map(fx => [0.25,0.5,0.75].map(fy => (
              <circle key={`${fx}-${fy}`}
                cx={PAD + fx*(VW-PAD*2)} cy={PAD + fy*(VH-PAD*2)}
                r="0.8" fill="var(--border)" />
            )))}
            {/* Polygon fill + animated stroke-draw */}
            <polygon points={pts} fill="rgba(0,240,168,0.10)" stroke="none" />
            <polygon points={pts} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round"
              strokeDasharray="500" style={{ animation: "stroke-in 1.2s ease both" }} />
            {/* Vertices */}
            {ring.slice(0,-1).map((p,i) => (
              <circle key={i} cx={toSvgX(p[0]).toFixed(1)} cy={toSvgY(p[1]).toFixed(1)}
                r="2.5" fill="var(--accent)" opacity="0.9" />
            ))}
          </svg>
          {/* Corner coord labels */}
          <div style={{ position:"absolute", bottom:2, left:4,  fontFamily:"var(--mono)", fontSize:7, color:"var(--muted2)" }}>
            {meta.minLon.toFixed(2)}°
          </div>
          <div style={{ position:"absolute", bottom:2, right:4, fontFamily:"var(--mono)", fontSize:7, color:"var(--muted2)" }}>
            {meta.maxLon.toFixed(2)}°
          </div>
          <div style={{ position:"absolute", top:2, left:"50%", transform:"translateX(-50%)", fontFamily:"var(--mono)", fontSize:7, color:"var(--muted2)" }}>
            {meta.maxLat.toFixed(2)}°N
          </div>
        </div>
      </div>

      {/* Stats grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, marginBottom: 8 }}>
        {[
          { label: "Perimeter", val: `~${meta.perimKm.toFixed(1)} km` },
          { label: "Max Edge",  val: `~${meta.maxEdgeKm.toFixed(1)} km` },
          { label: "Vertices",  val: meta.vertices },
          { label: "CRS",       val: "WGS-84" },
        ].map(({ label, val }) => (
          <div key={label} style={{
            padding: "5px 8px", borderRadius: 7,
            background: "var(--surface)", border: "1px solid var(--border)",
          }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--muted)", marginBottom: 1 }}>{label}</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text2)", fontWeight: 700 }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Date range */}
      {(startDate || endDate) && (
        <div style={{
          padding: "5px 10px", borderRadius: 7,
          background: "var(--surface)", border: "1px solid var(--border)",
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--muted)" }}>DATE RANGE</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text2)" }}>
            {startDate || "?"} → {endDate || "?"}
          </span>
        </div>
      )}
    </div>
  );
}


// ── Always-visible dashboard CTA button ──────────────────────────────────────
function DashboardCTA({ hasResults, history, justDone, status, onClick }) {
  if (!hasResults && status !== "running" && status !== "aoi_error") {
    return (
      <div style={{
        padding: "13px 16px", borderRadius: 12, border: "1px solid var(--border)",
        background: "var(--panel)", display: "flex", alignItems: "center", gap: 10,
        opacity: 0.4, cursor: "not-allowed",
      }}>
        <div style={{ width: 32, height: 32, borderRadius: "50%", border: "1.5px solid var(--border2)", display:"flex", alignItems:"center", justifyContent:"center", flexShrink: 0 }}>
          <Icon.Chart />
        </div>
        <div>
          <div style={{ fontFamily: "var(--sans)", fontWeight: 700, fontSize: 12, color: "var(--muted)" }}>Dashboard</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted2)", marginTop: 2 }}>Run a job to unlock</div>
        </div>
      </div>
    );
  }

  if (justDone) {
    return (
      <button onClick={onClick} style={{
        padding: "13px 16px", borderRadius: 12, cursor: "pointer", width: "100%",
        border: "1px solid rgba(0,240,168,0.4)",
        background: "linear-gradient(135deg, rgba(0,240,168,0.10), rgba(56,189,248,0.07))",
        display: "flex", alignItems: "center", gap: 10,
        boxShadow: "0 2px 16px rgba(0,240,168,0.12)",
        animation: "fadeUp 0.4s ease",
        transition: "all 0.2s",
      }}
        onMouseEnter={e => { e.currentTarget.style.background="linear-gradient(135deg,rgba(0,240,168,0.16),rgba(56,189,248,0.1))"; e.currentTarget.style.boxShadow="0 4px 20px rgba(0,240,168,0.2)"; }}
        onMouseLeave={e => { e.currentTarget.style.background="linear-gradient(135deg,rgba(0,240,168,0.10),rgba(56,189,248,0.07))"; e.currentTarget.style.boxShadow="0 2px 16px rgba(0,240,168,0.12)"; }}
      >
        {/* Icon with single gentle ring */}
        <div style={{ position: "relative", width: 34, height: 34, flexShrink: 0 }}>
          <div style={{ width:34, height:34, borderRadius:"50%", background:"rgba(0,240,168,0.15)", border:"1.5px solid var(--accent)", display:"flex", alignItems:"center", justifyContent:"center", color:"var(--accent)" }}>
            <Icon.Chart />
          </div>
          {/* Single slow pulse ring — not aggressive */}
          <div style={{ position:"absolute", inset:-4, borderRadius:"50%", border:"1px solid rgba(0,240,168,0.25)", animation:"pulse-ring 3s ease-out infinite" }} />
        </div>
        <div style={{ textAlign: "left", flex: 1 }}>
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            <div style={{ width:6, height:6, borderRadius:"50%", background:"var(--accent)", animation:"blink 2s ease infinite" }} />
            <span style={{ fontFamily: "var(--sans)", fontWeight: 800, fontSize: 13, color: "var(--accent)" }}>
              Results Ready
            </span>
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", marginTop: 2 }}>
            Click to open dashboard →
          </div>
        </div>
        <div style={{ fontFamily:"var(--mono)", fontSize:10, color:"var(--accent)", opacity:0.6 }}>›</div>
      </button>
    );
  }

  return (
    <button onClick={onClick} style={{
      padding: "13px 16px", borderRadius: 12, cursor: "pointer",
      border: "1px solid var(--accent)",
      background: "linear-gradient(135deg, rgba(0,240,168,0.11), rgba(56,189,248,0.07))",
      display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left",
      transition: "all 0.2s", animation: "fadeUp 0.4s ease",
    }}
      onMouseEnter={e => { e.currentTarget.style.background="linear-gradient(135deg,rgba(0,240,168,0.2),rgba(56,189,248,0.14))"; e.currentTarget.style.boxShadow="0 0 20px rgba(0,240,168,0.15)"; }}
      onMouseLeave={e => { e.currentTarget.style.background="linear-gradient(135deg,rgba(0,240,168,0.11),rgba(56,189,248,0.07))"; e.currentTarget.style.boxShadow="none"; }}
    >
      <div style={{ position: "relative", width: 32, height: 32, flexShrink: 0 }}>
        <div style={{ width:32, height:32, borderRadius:"50%", background:"linear-gradient(135deg,var(--accent),var(--accent2))", display:"flex", alignItems:"center", justifyContent:"center", color:"#000", boxShadow:"0 0 12px rgba(0,240,168,0.3)" }}>
          <Icon.Chart />
        </div>
        <div style={{ position:"absolute", top:-2, right:-2, width:14, height:14, borderRadius:"50%", background:"var(--accent2)", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"var(--mono)", fontSize:7, color:"#000", fontWeight:700, border:"1.5px solid var(--surface)" }}>
          {history.length}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily:"var(--sans)", fontWeight:700, fontSize:13, color:"var(--accent)" }}>View Dashboard</div>
        <div style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--muted)", marginTop:2 }}>
          {history.length} job{history.length!==1?"s":""} · tap to explore results
        </div>
      </div>
    </button>
  );
}
