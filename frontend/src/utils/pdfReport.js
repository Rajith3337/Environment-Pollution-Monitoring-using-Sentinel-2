/**
 * pdfReport.js  —  EPM v1.0
 * ──────────────────────────
 * Complete PDF report via window.print() on a new window.
 * No external dependencies — works in every browser.
 *
 * Pages: Cover | RAQI | Clusters | AOI & Scene Metadata | Indices | Methodology
 *
 * Features:
 *  - Actual polygon SVG rendered from real GeoJSON coordinates (with vertex numbers)
 *  - histograms._meta scene stats (valid px, cloud%, tiles) on Cover + AOI page
 *  - Graceful AOI notice when geometry unavailable (auto-registered disk jobs)
 *  - _meta filtered from indices section so it never renders as an index card
 */

const PLASMA_CSS = "linear-gradient(to right, #0d0887 0%, #7e03a8 25%, #cc4778 50%, #f89441 75%, #f0f921 100%)";

const CLUSTER = [
  { label: "Very Low Risk",  color: "#34d399", desc: "RAQI < 0.43 — Clean, healthy vegetation" },
  { label: "Low Risk",       color: "#a3e635", desc: "RAQI 0.43–0.46 — Minor stress, agricultural zones" },
  { label: "Moderate Risk",  color: "#fbbf24", desc: "RAQI 0.46–0.49 — Visible degradation, monitoring needed" },
  { label: "High Risk",      color: "#fb923c", desc: "RAQI 0.49–0.53 — Significant pollution, industrial zone" },
  { label: "Critical Risk",  color: "#f87171", desc: "RAQI >= 0.53 — Severe degradation, urgent action required" },
];

const INDEX_INFO = {
  NDVI:  { full: "Normalized Difference Vegetation Index",     color: "#34d399", interp: "Ranges -1 to +1. Values above 0.5 indicate dense healthy vegetation. Near 0 = bare soil. Negative = water or clouds." },
  NDWI:  { full: "Normalized Difference Water Index",          color: "#38bdf8", interp: "Values above 0.3 indicate surface water. Below 0 = dry land. Maps flooding and reservoir levels." },
  EVI:   { full: "Enhanced Vegetation Index",                  color: "#4ade80", interp: "Like NDVI with atmospheric correction. More reliable in dense canopy and urban or hazy conditions." },
  SAVI:  { full: "Soil Adjusted Vegetation Index",             color: "#86efac", interp: "NDVI variant reducing soil brightness interference. Preferred in arid or sparsely vegetated regions." },
  NDMI:  { full: "Normalized Difference Moisture Index",       color: "#67e8f9", interp: "Positive = moist vegetation. Near 0 or negative = drought stress or bare ground." },
  MNDWI: { full: "Modified Normalized Difference Water Index", color: "#22d3ee", interp: "Better than NDWI at separating water from built-up land in urban environments." },
  NDRE:  { full: "Red-Edge Normalized Difference",             color: "#a3e635", interp: "Sensitive to chlorophyll content. Values near 1.0 = highly active healthy plant cells." },
  NBR:   { full: "Normalized Burn Ratio",                      color: "#fbbf24", interp: "High = healthy vegetation. Low/negative = burned areas or bare rock." },
  NDTI:  { full: "Normalized Difference Turbidity Index",      color: "#fb923c", interp: "Higher = murkier water from runoff, erosion, or industrial discharge." },
  NDBAI: { full: "Normalized Diff. Built-up & Bare Area",      color: "#e879f9", interp: "High = urbanised/degraded land, deforestation, or mining activity." },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function v(val, dp = 3) { return val != null ? Number(val).toFixed(dp) : "—"; }

function getRaqiInterp(mean) {
  if (mean == null) return "No RAQI data available for this scene.";
  if (mean < 0.43) return `RAQI mean of ${v(mean)} — predominantly clean environment. Strong vegetation health and minimal pollution-related spectral signatures.`;
  if (mean < 0.46) return `RAQI mean of ${v(mean)} — low environmental stress. Some early signs of land degradation or agricultural pressure, but overall quality is acceptable.`;
  if (mean < 0.49) return `RAQI mean of ${v(mean)} — moderate pollution risk. Reduced vegetation health and possible turbidity increase. Monitoring is recommended.`;
  if (mean < 0.53) return `RAQI mean of ${v(mean)} — high pollution risk. Significant environmental degradation detected. Investigation recommended.`;
  return `RAQI mean of ${v(mean)} — critical pollution risk. Severe environmental degradation. Immediate investigation and intervention required.`;
}

function deriveClusterPct(histograms) {
  const freq = histograms?.RAQI?.frequency ?? histograms?.RAQI?.freq ?? [];
  const bins = histograms?.RAQI?.bins ?? [];
  if (!freq.length || bins.length < 2) return [30, 25, 20, 15, 10];
  const total = freq.reduce((s, f) => s + f, 0);
  if (!total) return [30, 25, 20, 15, 10];
  const thresholds = [0.43, 0.46, 0.49, 0.53];
  const counts = [0, 0, 0, 0, 0];
  freq.forEach((f, i) => {
    const binMid = bins[i] != null && bins[i + 1] != null ? (bins[i] + bins[i + 1]) / 2 : (i + 0.5) / freq.length;
    const cls = thresholds.findIndex(t => binMid < t);
    counts[cls === -1 ? 4 : cls] += f;
  });
  return counts.map(c => Math.max(1, Math.round((c / total) * 100)));
}

function svgHistogram(freq, color, width = 300, height = 60) {
  if (!freq || !freq.length) return "";
  const maxF = Math.max(...freq, 1);
  const bw = width / freq.length;
  const bars = freq.map((f, i) => {
    const bh = (f / maxF) * height;
    const alpha = (0.5 + 0.5 * (f / maxF)).toFixed(2);
    return `<rect x="${(i * bw).toFixed(1)}" y="${(height - bh).toFixed(1)}" width="${(bw - 0.5).toFixed(1)}" height="${bh.toFixed(1)}" fill="${color}" opacity="${alpha}"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none">${bars}<line x1="0" y1="${height}" x2="${width}" y2="${height}" stroke="#1e3a5a" stroke-width="1"/></svg>`;
}

// ── Actual polygon shape SVG from real GeoJSON ────────────────────────────────

function polygonSvg(aoi) {
  if (!aoi) return "";
  let polygon = null;
  if (aoi.type === "FeatureCollection") polygon = aoi.features?.[0]?.geometry;
  else if (aoi.type === "Feature")      polygon = aoi.geometry;
  else if (aoi.type === "Polygon")      polygon = aoi;
  if (!polygon || polygon.type !== "Polygon") return "";
  const ring = polygon.coordinates?.[0] ?? [];
  if (ring.length < 3) return "";

  const lons = ring.map(p => p[0]), lats = ring.map(p => p[1]);
  const lonMin = Math.min(...lons), lonMax = Math.max(...lons);
  const latMin = Math.min(...lats), latMax = Math.max(...lats);
  const PAD = 16, VW = 460, VH = 140;
  const toX = lon => PAD + ((lon - lonMin) / (lonMax - lonMin || 1)) * (VW - PAD * 2);
  const toY = lat => (VH - PAD) - ((lat - latMin) / (latMax - latMin || 1)) * (VH - PAD * 2);

  const pts = ring.slice(0, -1).map(p => `${toX(p[0]).toFixed(1)},${toY(p[1]).toFixed(1)}`).join(" ");

  const grid = [0.25, 0.5, 0.75].flatMap(fx =>
    [0.25, 0.5, 0.75].map(fy =>
      `<circle cx="${(PAD + fx * (VW - PAD * 2)).toFixed(1)}" cy="${(PAD + fy * (VH - PAD * 2)).toFixed(1)}" r="1.2" fill="#1e2d3d"/>`
    )
  ).join("");

  const verts = ring.slice(0, -1).map((p, i) => {
    const cx = toX(p[0]).toFixed(1), cy = toY(p[1]).toFixed(1);
    const lx = (toX(p[0]) + 5).toFixed(1), ly = (toY(p[1]) - 5).toFixed(1);
    return `<circle cx="${cx}" cy="${cy}" r="3.5" fill="#00e5a0" opacity="0.9"/>
            <text x="${lx}" y="${ly}" font-size="8" fill="#64748b" font-family="monospace">${i + 1}</text>`;
  }).join("");

  return `
  <div class="sub-label" style="margin-top:14px">ACTUAL POLYGON SHAPE</div>
  <div style="background:#0e1318;border:1px solid #1e2d3d;border-radius:8px;overflow:hidden;position:relative;margin-bottom:12px">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${VH}" width="100%" height="${VH}" style="display:block">
      ${grid}
      <polygon points="${pts}" fill="rgba(0,229,160,0.07)" stroke="none"/>
      <polygon points="${pts}" fill="none" stroke="#00e5a0" stroke-width="1.8" stroke-linejoin="round"/>
      ${verts}
    </svg>
    <div style="position:absolute;bottom:3px;left:5px;font-size:7px;color:#475569;font-family:monospace">${lonMin.toFixed(4)}</div>
    <div style="position:absolute;bottom:3px;right:5px;font-size:7px;color:#475569;font-family:monospace">${lonMax.toFixed(4)}</div>
    <div style="position:absolute;top:3px;left:50%;transform:translateX(-50%);font-size:7px;color:#475569;font-family:monospace">${latMax.toFixed(4)}N</div>
    <div style="position:absolute;bottom:3px;left:50%;transform:translateX(-50%);font-size:7px;color:#475569;font-family:monospace">${latMin.toFixed(4)}S</div>
  </div>`;
}

// ── Cover ─────────────────────────────────────────────────────────────────────

function coverSection(results, raqi, locationName) {
  const jobId  = results?.job_id ?? "N/A";
  const date   = results?.date   ?? "N/A";
  const interp = getRaqiInterp(raqi?.mean);
  const m      = results?.histograms?._meta ?? {};

  const metaRows = m.valid_px != null ? `
    <div class="meta-row"><span class="meta-key">VALID PIXELS</span><span class="meta-val">${Number(m.valid_px).toLocaleString()} / ${Number(m.total_px).toLocaleString()} (${v(m.valid_pct, 1)}%)</span></div>
    <div class="meta-row"><span class="meta-key">CLOUD / NODATA</span><span class="meta-val" style="color:${m.cloud_pct > 50 ? "#f87171" : m.cloud_pct > 20 ? "#fbbf24" : "#34d399"}">${v(m.cloud_pct, 1)}%</span></div>
    <div class="meta-row"><span class="meta-key">TILES USED</span><span class="meta-val">${m.tiles_used ?? "—"} / ${m.tiles_total ?? "—"} scenes composited</span></div>` : "";

  return `
  <div class="page cover-page">
    <div class="cover-header">
      <div class="orb"></div>
      <div>
        <div class="cover-title">Environmental Pollution Monitor</div>
        <div class="cover-subtitle">Satellite Analysis Report — EPM v1.0</div>
        <div class="cover-meta-line">Sentinel-2 L2A · STAC Pipeline · Planetary Computer · Fixed-Threshold Classification</div>
      </div>
    </div>
    <div class="meta-box">
      <div class="meta-row"><span class="meta-key">LOCATION</span><span class="meta-val" style="color:#0ea5e9;font-weight:700">${locationName}</span></div>
      <div class="meta-row"><span class="meta-key">JOB ID</span><span class="meta-val">${jobId}</span></div>
      <div class="meta-row"><span class="meta-key">SCENE DATE</span><span class="meta-val">${date}</span></div>
      <div class="meta-row"><span class="meta-key">GENERATED</span><span class="meta-val">${new Date().toLocaleString()}</span></div>
      <div class="meta-row"><span class="meta-key">PIPELINE</span><span class="meta-val">Sentinel-2 L2A -> STAC -> Cloud Mask -> Max-NDVI Mosaic -> Indices -> RAQI -> Classification -> COG</span></div>
      ${metaRows}
    </div>
    <div class="section-label" style="margin-top:20px">RAQI SUMMARY</div>
    <div class="stat-cards">
      <div class="stat-card"><div class="stat-label">RAQI MEAN</div><div class="stat-val" style="color:#fbbf24">${v(raqi?.mean)}</div></div>
      <div class="stat-card"><div class="stat-label">STD DEV</div><div class="stat-val" style="color:#0ea5e9">${v(raqi?.std)}</div></div>
      <div class="stat-card"><div class="stat-label">CLEANEST</div><div class="stat-val" style="color:#34d399">${v(raqi?.min)}</div></div>
      <div class="stat-card"><div class="stat-label">WORST</div><div class="stat-val" style="color:#f87171">${v(raqi?.max)}</div></div>
    </div>
    <p class="interp-text">${interp}</p>
    <div class="section-label">RAQI COLOUR SCALE — Plasma Colormap</div>
    <div class="plasma-bar"></div>
    <div class="plasma-labels">
      <span style="color:#0d0887">0.0<br><small>Clean</small></span>
      <span style="color:#7e03a8">0.43<br><small>Low</small></span>
      <span style="color:#cc4778">0.49<br><small>Moderate</small></span>
      <span style="color:#f89441">0.53<br><small>High</small></span>
      <span style="color:#f0f921">1.0<br><small>Critical</small></span>
    </div>
    <div class="section-label" style="margin-top:20px">CONTENTS</div>
    <ul class="toc">
      <li>Page 1 — Cover &amp; RAQI Summary Statistics</li>
      <li>Page 2 — RAQI Distribution Histogram &amp; Score Interpretation</li>
      <li>Page 3 — Pollution Cluster Breakdown</li>
      <li>Page 4 — Area of Interest &amp; Scene Metadata</li>
      <li>Page 5 — Spectral Indices Grid &amp; Histograms</li>
      <li>Last — Methodology &amp; Data Sources</li>
    </ul>
  </div>`;
}

// ── RAQI ──────────────────────────────────────────────────────────────────────

function raqiSection(raqi) {
  const freq = raqi?.frequency ?? raqi?.freq ?? [];
  const ranges = [
    { range: "0.00-0.43", label: "Very Low",  color: "#0d0887", desc: "Deep purple. Clean, healthy vegetation, minimal pollution signatures." },
    { range: "0.43-0.46", label: "Low",       color: "#7e03a8", desc: "Violet. Minor stress, likely agricultural or peri-urban land." },
    { range: "0.46-0.49", label: "Moderate",  color: "#cc4778", desc: "Pink-red. Noticeable degradation. Industrial activity or water quality decline." },
    { range: "0.49-0.53", label: "High",      color: "#f89441", desc: "Orange. Significant pollution, likely industrial or urbanised zone." },
    { range: ">= 0.53",   label: "Critical",  color: "#f0f921", desc: "Bright yellow. Severe degradation. Urgent action required." },
  ];
  return `
  <div class="page">
    <div class="section-header green">RAQI — Remote Sensing Air Quality Index</div>
    <p class="body-text">RAQI is a composite spectral index combining vegetation health (NDVI, EVI, SAVI), red-edge chlorophyll (NDRE), moisture (NDMI), water quality (NDWI, NDTI), burn ratio (NBR), and bare area (NDBAI) into a single 0-1 pollution score. Higher RAQI = greater environmental degradation.</p>
    <div class="sub-label">Plasma Colour Scale</div>
    <div class="plasma-bar" style="height:14px;margin-bottom:4px"></div>
    <div class="plasma-labels">
      <span style="color:#0d0887">0.0<br><small>Clean</small></span>
      <span style="color:#7e03a8">0.43<br><small>Low</small></span>
      <span style="color:#cc4778">0.49<br><small>Moderate</small></span>
      <span style="color:#f89441">0.53<br><small>High</small></span>
      <span style="color:#f0f921">1.0<br><small>Critical</small></span>
    </div>
    <div class="sub-label" style="margin-top:14px">Score Ranges</div>
    ${ranges.map(r => `
    <div class="range-row" style="border-left:4px solid ${r.color}">
      <span class="range-badge" style="color:${r.color}">${r.range} &nbsp; ${r.label}</span>
      <span class="range-desc">${r.desc}</span>
    </div>`).join("")}
    <div class="sub-label" style="margin-top:16px">RAQI Value Distribution</div>
    ${freq.length
      ? `<div class="histogram-wrap">${svgHistogram(freq, "#cc4778", 500, 80)}</div>
         <div class="hist-axis"><span>Min: ${v(raqi?.min)}</span><span>Mean: ${v(raqi?.mean)}</span><span>Max: ${v(raqi?.max)}</span></div>`
      : `<p class="body-text muted">No histogram data available.</p>`}
    <div class="stat-cards" style="margin-top:14px">
      <div class="stat-card"><div class="stat-label">MEAN</div><div class="stat-val" style="color:#fbbf24">${v(raqi?.mean, 4)}</div></div>
      <div class="stat-card"><div class="stat-label">STD DEV</div><div class="stat-val" style="color:#0ea5e9">${v(raqi?.std, 4)}</div></div>
      <div class="stat-card"><div class="stat-label">MIN</div><div class="stat-val" style="color:#34d399">${v(raqi?.min, 4)}</div></div>
      <div class="stat-card"><div class="stat-label">MAX</div><div class="stat-val" style="color:#f87171">${v(raqi?.max, 4)}</div></div>
    </div>
  </div>`;
}

// ── Clusters ──────────────────────────────────────────────────────────────────

function clustersSection(histograms) {
  const pct = deriveClusterPct(histograms);
  const thresholds = [
    { lo: null, hi: 0.43 }, { lo: 0.43, hi: 0.46 }, { lo: 0.46, hi: 0.49 },
    { lo: 0.49, hi: 0.53 }, { lo: 0.53, hi: null  },
  ];
  return `
  <div class="page">
    <div class="section-header blue">Fixed-Threshold Pollution Cluster Map</div>
    <p class="body-text">The study area is divided into 5 pollution risk classes using deterministic fixed RAQI thresholds. Each pixel is assigned based on its absolute RAQI value — classes mean the same physical condition across all dates and jobs.</p>
    <div class="sub-label">Risk Class Distribution</div>
    ${CLUSTER.map((c, i) => `
    <div class="cluster-row">
      <div class="cluster-swatch" style="background:${c.color}"></div>
      <div class="cluster-label" style="color:${c.color}">${c.label}</div>
      <div class="cluster-desc">${c.desc}</div>
      <div class="cluster-pct" style="color:${c.color}">${pct[i]}%</div>
      <div class="cluster-bar-bg"><div class="cluster-bar-fill" style="background:${c.color};width:${Math.min(pct[i] * 2, 100)}%"></div></div>
    </div>`).join("")}
    <div class="sub-label" style="margin-top:18px">Class Thresholds</div>
    <table class="centroid-table">
      <thead><tr><th>Risk Class</th><th>RAQI Range</th><th>Coverage</th><th>Interpretation</th></tr></thead>
      <tbody>${CLUSTER.map((c, i) => {
        const t = thresholds[i];
        const range = t.lo == null ? `< ${t.hi}` : t.hi == null ? `>= ${t.lo}` : `${t.lo}-${t.hi}`;
        return `<tr>
          <td style="color:${c.color};font-weight:700">${c.label}</td>
          <td>${range}</td><td>${pct[i]}%</td>
          <td class="muted">${["Clean","Minor stress","Visible degradation","Industrial/degraded","Critical"][i]}</td>
        </tr>`;
      }).join("")}</tbody>
    </table>
    <div class="sub-label" style="margin-top:18px">Pollution Area Proportions</div>
    <div class="stacked-bar">${CLUSTER.map((c, i) => `<div style="background:${c.color};flex:${pct[i]}"></div>`).join("")}</div>
    <div class="stacked-legend">${CLUSTER.map((c, i) => `<span><span class="dot" style="background:${c.color}"></span><span style="color:${c.color}">${c.label} ${pct[i]}%</span></span>`).join("")}</div>
  </div>`;
}

// ── AOI & Scene Metadata ──────────────────────────────────────────────────────

function computeAoiMeta(aoi) {
  if (!aoi) return null;
  let polygon, props = {};
  if (aoi.type === "FeatureCollection") { polygon = aoi.features?.[0]?.geometry; props = aoi.features?.[0]?.properties || {}; }
  else if (aoi.type === "Feature")      { polygon = aoi.geometry; props = aoi.properties || {}; }
  else if (aoi.type === "Polygon")      { polygon = aoi; }
  if (!polygon || polygon.type !== "Polygon") return null;
  const ring = polygon.coordinates?.[0] ?? [];
  if (ring.length < 3) return null;
  const lons = ring.map(p => p[0]), lats = ring.map(p => p[1]);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const cLon = (minLon + maxLon) / 2, cLat = (minLat + maxLat) / 2;
  const R = 6371, toRad = d => d * Math.PI / 180;
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
    area += toRad(x1 - x0) * (2 + Math.sin(toRad(y0)) + Math.sin(toRad(y1)));
  }
  const areaKm2  = Math.abs(area * R * R / 2);
  const widthKm  = R * toRad(maxLon - minLon) * Math.cos(toRad(cLat));
  const heightKm = R * toRad(maxLat - minLat);
  const fmtArea  = areaKm2 >= 1000 ? `${(areaKm2/1000).toFixed(2)} M km2` : areaKm2 >= 1 ? `${areaKm2.toFixed(2)} km2` : `${(areaKm2*1e6).toFixed(0)} m2`;
  const latLabel = cLat >= 0 ? `${cLat.toFixed(4)}N` : `${Math.abs(cLat).toFixed(4)}S`;
  const lonLabel = cLon >= 0 ? `${cLon.toFixed(4)}E` : `${Math.abs(cLon).toFixed(4)}W`;
  return { minLon, maxLon, minLat, maxLat, cLon, cLat, areaKm2, fmtArea, widthKm, heightKm, latLabel, lonLabel, vertices: ring.length - 1, name: props.name || "" };
}

function aoiSection(results, meta, locationName) {
  const sd = results?.startDate ?? results?.start_date ?? "?";
  const ed = results?.endDate   ?? results?.end_date   ?? "?";
  const sm = results?.histograms?._meta ?? {};

  const geoBlock = meta ? `
    <div class="aoi-highlight-row">
      <div class="aoi-big-card accent-green"><div class="aoi-big-label">TOTAL AREA</div><div class="aoi-big-val">${meta.fmtArea}</div></div>
      <div class="aoi-big-card accent-blue"><div class="aoi-big-label">CENTROID</div><div class="aoi-big-val" style="font-size:14px">${meta.latLabel}<br>${meta.lonLabel}</div></div>
      <div class="aoi-big-card"><div class="aoi-big-label">DIMENSIONS</div><div class="aoi-big-val" style="font-size:13px">~${meta.widthKm.toFixed(1)} km W<br>~${meta.heightKm.toFixed(1)} km H</div></div>
      <div class="aoi-big-card"><div class="aoi-big-label">VERTICES</div><div class="aoi-big-val">${meta.vertices}</div></div>
    </div>
    ${polygonSvg(results?.aoi)}
    <div class="sub-label">BOUNDING BOX</div>
    <div class="bbox-diagram">
      <div class="bbox-label bbox-n">N ${meta.maxLat.toFixed(4)}</div>
      <div class="bbox-label bbox-s">S ${meta.minLat.toFixed(4)}</div>
      <div class="bbox-label bbox-w">W ${meta.minLon.toFixed(4)}</div>
      <div class="bbox-label bbox-e">E ${meta.maxLon.toFixed(4)}</div>
      <div class="bbox-box"></div>
      <div class="bbox-centroid">X centroid</div>
    </div>
    <table class="aoi-table">
      <tr><th>Property</th><th>Value</th></tr>
      <tr><td>Location</td><td style="color:#0ea5e9">${locationName}</td></tr>
      <tr><td>AOI Type</td><td>Polygon (exact mask applied)</td></tr>
      <tr><td>CRS</td><td>WGS-84 (EPSG:4326)</td></tr>
      <tr><td>Total Area</td><td>${meta.fmtArea}</td></tr>
      <tr><td>Width (EW)</td><td>~${meta.widthKm.toFixed(3)} km</td></tr>
      <tr><td>Height (NS)</td><td>~${meta.heightKm.toFixed(3)} km</td></tr>
      <tr><td>Centroid Lat</td><td>${meta.latLabel}</td></tr>
      <tr><td>Centroid Lon</td><td>${meta.lonLabel}</td></tr>
      <tr><td>BBox West</td><td>${meta.minLon.toFixed(6)}</td></tr>
      <tr><td>BBox East</td><td>${meta.maxLon.toFixed(6)}</td></tr>
      <tr><td>BBox South</td><td>${meta.minLat.toFixed(6)}</td></tr>
      <tr><td>BBox North</td><td>${meta.maxLat.toFixed(6)}</td></tr>
      <tr><td>Vertex Count</td><td>${meta.vertices}</td></tr>
      <tr><td>Analysis Start</td><td>${sd}</td></tr>
      <tr><td>Analysis End</td><td>${ed}</td></tr>
    </table>
  ` : `
    <div class="aoi-notice">
      <div class="aoi-notice-icon">!</div>
      <div>
        <div class="aoi-notice-title">AOI Geometry Not Recorded</div>
        <p class="aoi-notice-body">The polygon geometry for this job was not saved to the database — this happens when a job folder from a previous session is auto-registered from disk. The original AOI GeoJSON is no longer available. Spatial stats below are derived from the pipeline pixel grid instead.</p>
        <table class="aoi-table" style="margin-top:10px">
          <tr><th>Property</th><th>Value</th></tr>
          <tr><td>Location</td><td style="color:#0ea5e9">${locationName}</td></tr>
          <tr><td>Analysis Start</td><td>${sd}</td></tr>
          <tr><td>Analysis End</td><td>${ed}</td></tr>
          <tr><td>AOI Geometry</td><td class="muted">Not available for this job</td></tr>
        </table>
      </div>
    </div>
  `;

  const hasM = sm.valid_px != null;
  const vPct = sm.valid_pct ?? 0, cPct = sm.cloud_pct ?? 0;
  const coverCol = vPct >= 80 ? "#34d399" : vPct >= 40 ? "#fbbf24" : "#f87171";
  const cloudCol = cPct  > 50 ? "#f87171" : cPct  > 20 ? "#fbbf24" : "#34d399";

  const sceneBlock = hasM ? `
    <div class="sub-label" style="margin-top:20px">SCENE ACQUISITION — Pixel Coverage</div>
    <p class="body-text">Computed by the pipeline from the max-NDVI mosaic after cloud masking. Source: histograms.json _meta.</p>
    <div class="aoi-highlight-row">
      <div class="aoi-big-card accent-green"><div class="aoi-big-label">VALID PIXELS</div><div class="aoi-big-val" style="color:${coverCol}">${v(vPct, 1)}%</div></div>
      <div class="aoi-big-card"><div class="aoi-big-label">CLOUD / NO-DATA</div><div class="aoi-big-val" style="color:${cloudCol}">${v(cPct, 1)}%</div></div>
      <div class="aoi-big-card accent-blue"><div class="aoi-big-label">TILES COMPOSITED</div><div class="aoi-big-val">${sm.tiles_used ?? "?"} / ${sm.tiles_total ?? "?"}</div></div>
      <div class="aoi-big-card"><div class="aoi-big-label">GRID SIZE</div><div class="aoi-big-val" style="font-size:13px">${Number(sm.total_px).toLocaleString()}<br><span style="font-size:10px;color:#64748b">px</span></div></div>
    </div>
    <div class="stacked-bar" style="height:18px;margin-bottom:6px">
      <div style="background:#34d399;flex:${Math.round(vPct)}"></div>
      <div style="background:#475569;flex:${Math.round(cPct)}"></div>
    </div>
    <div class="stacked-legend" style="margin-bottom:10px">
      <span><span class="dot" style="background:#34d399"></span><span style="color:#34d399">Valid ${v(vPct,1)}%</span></span>
      <span><span class="dot" style="background:#475569"></span><span style="color:#94a3b8">Cloud/No-data ${v(cPct,1)}%</span></span>
    </div>
    <table class="aoi-table">
      <tr><th>Metric</th><th>Value</th></tr>
      <tr><td>Valid Pixels</td><td style="color:#34d399">${Number(sm.valid_px).toLocaleString()}</td></tr>
      <tr><td>Total Grid Pixels</td><td>${Number(sm.total_px).toLocaleString()}</td></tr>
      <tr><td>Valid Coverage</td><td style="color:${coverCol}">${v(vPct, 2)}%</td></tr>
      <tr><td>Cloud / No-Data</td><td style="color:${cloudCol}">${v(cPct, 2)}%</td></tr>
      <tr><td>Tiles Used</td><td>${sm.tiles_used ?? "?"} of ${sm.tiles_total ?? "?"}</td></tr>
      <tr><td>Mosaic Method</td><td>Maximum-NDVI per-pixel composite</td></tr>
      <tr><td>Resolution</td><td>10 m (UTM grid)</td></tr>
      <tr><td>Cloud Mask</td><td>Sentinel-2 SCL</td></tr>
    </table>
  ` : `<p class="body-text muted" style="margin-top:16px">Scene pixel statistics not available — histograms._meta missing.</p>`;

  return `
  <div class="page">
    <div class="section-header green">Area of Interest &amp; Scene Metadata</div>
    <p class="body-text">Spatial and acquisition metadata. The AOI polygon defines the exact study boundary; scene stats reflect actual pixel coverage after cloud masking and compositing.</p>
    ${geoBlock}
    ${sceneBlock}
  </div>`;
}

// ── Spectral Indices ──────────────────────────────────────────────────────────

function indicesSection(histograms) {
  // Exclude RAQI and internal _meta key
  const entries = Object.entries(histograms).filter(([k]) => k !== "RAQI" && k !== "_meta");
  if (!entries.length) return `<div class="page"><div class="section-header blue">Spectral Indices</div><p class="body-text muted">No index data available.</p></div>`;

  const cards = entries.map(([name, data]) => {
    const info = INDEX_INFO[name] ?? { full: name, color: "#64748b", interp: "" };
    const freq = data?.frequency ?? data?.freq ?? [];
    return `
    <div class="index-card">
      <div class="index-card-header" style="border-left:3px solid ${info.color}">
        <div><div class="index-name" style="color:${info.color}">${name}</div><div class="index-full">${info.full}</div></div>
        <div class="index-mean">${v(data?.mean)}</div>
      </div>
      <div class="index-hist">${svgHistogram(freq, info.color, 240, 48)}</div>
      <div class="index-stats">
        <span><small>min</small><br>${v(data?.min, 2)}</span>
        <span><small>mean</small><br>${v(data?.mean)}</span>
        <span><small>std</small><br>${v(data?.std)}</span>
        <span><small>max</small><br>${v(data?.max, 2)}</span>
      </div>
    </div>`;
  }).join("");

  const interps = entries.map(([name, data]) => {
    const info = INDEX_INFO[name]; if (!info) return "";
    return `<div class="interp-row">
      <span class="interp-name" style="color:${info.color}">${name}</span>
      <span class="interp-body">${info.interp}${data?.mean != null ? ` Scene mean: ${v(data.mean)}.` : ""}</span>
    </div>`;
  }).join("");

  return `
  <div class="page">
    <div class="section-header blue">Spectral Indices</div>
    <p class="body-text">Ten indices computed from Sentinel-2 bands measuring vegetation health, water presence, moisture, turbidity, burn severity, and bare land cover.</p>
    <div class="index-grid">${cards}</div>
    <div class="sub-label" style="margin-top:16px">Interpretations</div>
    ${interps}
  </div>`;
}

// ── Methodology ───────────────────────────────────────────────────────────────

function methodologySection() {
  const steps = [
    ["1. STAC Query",         "Sentinel-2 L2A scenes queried from Microsoft Planetary Computer via pystac-client. Filtered by AOI polygon, date range, and cloud cover (default <=80%)."],
    ["2. Band Download",      "Bands B02-B8A, B11, B12, SCL downloaded per scene. Clouds, shadows, and saturated pixels masked via SCL. Workers throttled per tile (MAX_TOTAL_HTTP=24). Retries use exponential backoff (5 attempts, 10-160s) with 180s per-request timeout."],
    ["3. Max-NDVI Mosaic",    "Multiple scenes composited using maximum-NDVI selection — for each pixel the scene with highest NDVI is used, minimising cloud contamination."],
    ["4. Index Computation",  "All 10 indices computed per pixel. RAQI = 0.30*(1-NDVI) + 0.20*NDWI_inv + 0.20*NDTI + 0.15*NDBAI + 0.10*(1-NDMI) + 0.05*(1-NBR), normalised to [0,1]."],
    ["5. Risk Classification","RAQI classified into 5 fixed bands: <0.43 Very Low, 0.43-0.46 Low, 0.46-0.49 Moderate, 0.49-0.53 High, >=0.53 Critical. Thresholds are absolute and identical across all runs."],
    ["6. COG Export",         "Index, RAQI, and cluster TIFs converted to Cloud Optimized GeoTIFF (DEFLATE, predictor=2) with internal overviews. Raw band TIFs are not written to disk."],
    ["7. Histograms",         "64-bin histograms per index. Statistics (mean, std, min, max, frequency) and scene metadata (valid_px, cloud_pct, tiles_used) stored in histograms.json per date."],
  ];
  return `
  <div class="page">
    <div class="section-header yellow">Methodology</div>
    ${steps.map(([t, d]) => `<div class="method-row"><div class="method-title">${t}</div><div class="method-desc">${d}</div></div>`).join("")}
    <div class="sub-label" style="margin-top:18px">Data Sources</div>
    <ul class="sources">
      <li>Sentinel-2 MSI Level-2A — ESA Copernicus Programme (10 m / 20 m resolution)</li>
      <li>STAC API — Microsoft Planetary Computer (planetarycomputer.microsoft.com)</li>
      <li>Basemap tiles — Esri World Imagery</li>
      <li>Risk classification — fixed absolute RAQI thresholds</li>
      <li>Cloud Optimized GeoTIFF — GDAL / rasterio 1.3.x</li>
    </ul>
  </div>`;
}

// ── CSS ───────────────────────────────────────────────────────────────────────

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@700;800&display=swap');
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:#090c10; color:#e2e8f0; font-family:'Space Mono',monospace; font-size:11px; }
  .page { padding:28px 32px; min-height:100vh; border-bottom:2px solid #1e2d3d; page-break-after:always; }
  .page:last-child { border-bottom:none; page-break-after:auto; }
  .cover-page { background:linear-gradient(180deg,#090c10 0%,#0e1318 100%); }
  .cover-header { display:flex;align-items:center;gap:16px;padding:20px 0 16px;border-bottom:2px solid;border-image:${PLASMA_CSS} 1;margin-bottom:18px; }
  .orb { width:28px;height:28px;border-radius:50%;background:#00e5a0;box-shadow:0 0 20px rgba(0,229,160,0.6);flex-shrink:0; }
  .cover-title { font-family:'Syne',sans-serif;font-size:22px;font-weight:800;color:#00e5a0;line-height:1.2; }
  .cover-subtitle { font-size:13px;color:#0ea5e9;margin-top:4px; }
  .cover-meta-line { font-size:9px;color:#64748b;margin-top:6px; }
  .meta-box { background:#0e1318;border:1px solid #1e2d3d;border-radius:8px;padding:14px 16px;margin-bottom:16px; }
  .meta-row { display:flex;gap:12px;margin-bottom:6px;align-items:baseline; }
  .meta-key { font-size:8px;color:#475569;letter-spacing:1px;text-transform:uppercase;min-width:90px;flex-shrink:0; }
  .meta-val { font-size:10px;color:#94a3b8; }
  .section-label { font-size:8px;color:#475569;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;margin-top:2px; }
  .stat-cards { display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px; }
  .stat-card { background:#131920;border:1px solid #1e2d3d;border-radius:8px;padding:10px 12px; }
  .stat-label { font-size:8px;color:#64748b;margin-bottom:4px; }
  .stat-val { font-family:'Syne',sans-serif;font-size:20px;font-weight:800; }
  .plasma-bar { height:12px;border-radius:4px;background:${PLASMA_CSS};border:1px solid #1e2d3d;margin-bottom:6px; }
  .plasma-labels { display:flex;justify-content:space-between;font-size:9px;margin-bottom:4px;text-align:center; }
  .plasma-labels small { color:#64748b;font-size:8px; }
  .interp-text { font-size:10px;color:#94a3b8;line-height:1.7;margin-bottom:14px; }
  .toc { padding-left:20px;color:#64748b;font-size:10px;line-height:2; }
  .section-header { font-family:'Syne',sans-serif;font-size:16px;font-weight:800;margin-bottom:12px;padding-left:10px; }
  .section-header.green  { color:#00e5a0;border-left:4px solid #00e5a0; }
  .section-header.blue   { color:#0ea5e9;border-left:4px solid #0ea5e9; }
  .section-header.yellow { color:#f59e0b;border-left:4px solid #f59e0b; }
  .sub-label { font-size:8px;color:#475569;letter-spacing:2px;text-transform:uppercase;margin:12px 0 6px; }
  .body-text { font-size:10px;color:#94a3b8;line-height:1.7;margin-bottom:10px; }
  .body-text.muted { color:#475569; }
  .range-row { display:flex;align-items:baseline;gap:10px;padding:6px 10px;border-radius:6px;background:#0e1318;margin-bottom:4px; }
  .range-badge { font-weight:700;font-size:10px;min-width:140px;flex-shrink:0; }
  .range-desc { font-size:9px;color:#64748b; }
  .histogram-wrap { background:#0e1318;border-radius:6px;padding:8px 4px 4px;margin-bottom:4px; }
  .hist-axis { display:flex;justify-content:space-between;font-size:9px;color:#475569;margin-bottom:8px; }
  .cluster-row { display:grid;grid-template-columns:10px 130px 1fr 36px;gap:8px;align-items:center;padding:7px 10px;background:#0e1318;border-radius:6px;margin-bottom:4px; }
  .cluster-swatch { width:10px;height:10px;border-radius:2px;flex-shrink:0; }
  .cluster-label { font-weight:700;font-size:10px; }
  .cluster-desc { font-size:9px;color:#64748b; }
  .cluster-pct { font-weight:700;font-size:11px;text-align:right; }
  .cluster-bar-bg { grid-column:1/-1;height:3px;background:#1e2d3d;border-radius:2px;overflow:hidden; }
  .cluster-bar-fill { height:100%;border-radius:2px; }
  .centroid-table,.aoi-table { width:100%;border-collapse:collapse;font-size:10px; }
  .centroid-table th,.aoi-table th { background:#0e1318;color:#475569;font-size:8px;letter-spacing:1px;text-transform:uppercase;padding:6px 8px;text-align:left;border-bottom:1px solid #1e2d3d; }
  .centroid-table td { padding:5px 8px;border-bottom:1px solid #131920; }
  .aoi-table td { padding:4px 8px;border-bottom:1px solid #131920;color:#94a3b8; }
  .aoi-table td:first-child { color:#64748b;font-weight:700;width:40%; }
  .centroid-table tr:nth-child(even) td,.aoi-table tr:nth-child(even) td { background:#0e1318; }
  .muted { color:#64748b; }
  .stacked-bar { display:flex;height:14px;border-radius:4px;overflow:hidden;margin-bottom:6px;border:1px solid #1e2d3d; }
  .stacked-bar div { min-width:2px; }
  .stacked-legend { display:flex;flex-wrap:wrap;gap:8px;font-size:9px; }
  .stacked-legend .dot { width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:4px;vertical-align:middle; }
  .index-grid { display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:8px; }
  .index-card { background:#0e1318;border:1px solid #1e2d3d;border-radius:8px;overflow:hidden; }
  .index-card-header { display:flex;justify-content:space-between;align-items:flex-start;padding:8px 10px;border-bottom:1px solid #131920; }
  .index-name { font-family:'Syne',sans-serif;font-weight:800;font-size:13px; }
  .index-full { font-size:8px;color:#64748b;margin-top:2px; }
  .index-mean { font-family:'Syne',sans-serif;font-weight:700;font-size:14px;color:#e2e8f0; }
  .index-hist { padding:6px 6px 2px; }
  .index-stats { display:flex;justify-content:space-around;padding:6px 8px 8px;border-top:1px solid #131920;text-align:center; }
  .index-stats small { font-size:8px;color:#64748b;display:block; }
  .index-stats span { font-size:10px;color:#94a3b8;font-weight:700; }
  .interp-row { display:flex;gap:10px;align-items:baseline;padding:5px 0;border-bottom:1px solid #131920; }
  .interp-name { font-weight:700;font-size:10px;min-width:60px;flex-shrink:0; }
  .interp-body { font-size:9px;color:#64748b;line-height:1.6; }
  .method-row { margin-bottom:12px; }
  .method-title { font-weight:700;font-size:10px;color:#f59e0b;margin-bottom:3px; }
  .method-desc { font-size:9.5px;color:#64748b;line-height:1.7;padding-left:10px; }
  .sources { padding-left:20px;color:#64748b;font-size:9.5px;line-height:2; }
  .aoi-highlight-row { display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px; }
  .aoi-big-card { background:#0e1318;border:1px solid #1e2d3d;border-radius:8px;padding:10px 12px; }
  .aoi-big-card.accent-green { border-color:rgba(0,229,160,0.3); }
  .aoi-big-card.accent-blue  { border-color:rgba(14,165,233,0.3); }
  .aoi-big-label { font-size:7px;color:#475569;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px; }
  .aoi-big-val { font-family:'Syne',sans-serif;font-weight:800;font-size:16px;color:#e2e8f0;line-height:1.25; }
  .aoi-big-card.accent-green .aoi-big-val { color:#00e5a0; }
  .aoi-big-card.accent-blue  .aoi-big-val { color:#0ea5e9; }
  .bbox-diagram { position:relative;height:80px;background:#0e1318;border:1px solid #1e2d3d;border-radius:6px;margin-bottom:12px; }
  .bbox-box { position:absolute;inset:16px 40px;border:1.5px dashed #0ea5e9;border-radius:3px;background:rgba(14,165,233,0.05); }
  .bbox-label { position:absolute;font-size:8px;color:#0ea5e9; }
  .bbox-n { top:4px;left:50%;transform:translateX(-50%); }
  .bbox-s { bottom:4px;left:50%;transform:translateX(-50%); }
  .bbox-w { top:50%;left:6px;transform:translateY(-50%); }
  .bbox-e { top:50%;right:6px;transform:translateY(-50%); }
  .bbox-centroid { position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:8px;color:#475569; }
  .aoi-notice { display:flex;gap:16px;background:#0e1318;border:1px solid rgba(245,158,11,0.3);border-left:4px solid #f59e0b;border-radius:8px;padding:14px 16px;margin-bottom:16px; }
  .aoi-notice-icon { font-size:22px;color:#f59e0b;flex-shrink:0;line-height:1;font-weight:700; }
  .aoi-notice-title { font-family:'Syne',sans-serif;font-weight:800;font-size:13px;color:#f59e0b;margin-bottom:6px; }
  .aoi-notice-body { font-size:9.5px;color:#64748b;line-height:1.7; }
  @media print {
    body { -webkit-print-color-adjust:exact;print-color-adjust:exact; }
    .page { page-break-after:always;border-bottom:none; }
    .page:last-child { page-break-after:auto; }
  }
`;

// ── Main export ───────────────────────────────────────────────────────────────

export async function downloadPdfReport(results) {
  const histograms = results?.histograms ?? {};
  const raqi       = histograms?.RAQI    ?? {};
  const jobId      = results?.job_id     ?? "N/A";
  const date       = results?.date       ?? "N/A";

  const meta = computeAoiMeta(results?.aoi);
  let locationName = meta?.name || "Custom Region";

  if (meta && !meta.name) {
    try {
      const res  = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${meta.cLat}&lon=${meta.cLon}&zoom=10`);
      if (res.ok) { const d = await res.json(); if (d?.display_name) locationName = d.display_name; }
    } catch (e) { console.warn("Reverse geocode failed", e); }
  }

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<title>EPM Report -- ${jobId} -- ${date}</title>
<style>${CSS}</style></head><body>
  ${coverSection(results, raqi, locationName)}
  ${raqiSection(raqi)}
  ${clustersSection(histograms)}
  ${aoiSection(results, meta, locationName)}
  ${indicesSection(histograms)}
  ${methodologySection()}
</body></html>`;

  const win = window.open("", "_blank", "width=900,height=700");
  if (!win) { alert("Pop-up blocked! Please allow pop-ups for this site and try again."); return; }
  win.document.write(html);
  win.document.close();
  win.onload = () => setTimeout(() => { win.focus(); win.print(); }, 800);
}