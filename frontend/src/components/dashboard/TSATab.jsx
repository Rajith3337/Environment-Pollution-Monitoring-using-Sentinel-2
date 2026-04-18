import { useState, useEffect, useMemo, useCallback } from "react";
import { getTsaData } from "../../utils/api";
import { Icon } from "../Icons";

// ── Constants ────────────────────────────────────────────────────────────────
const ALL_INDICES = ["NDVI", "EVI", "SAVI", "NDRE", "NDMI", "NDWI", "MNDWI", "NBR", "NDTI", "NDBAI", "RAQI"];

const INDEX_META = {
  NDVI:  { label: "NDVI",  color: "#4ade80", desc: "Vegetation health (-1 to 1)" },
  EVI:   { label: "EVI",   color: "#34d399", desc: "Enhanced vegetation index" },
  SAVI:  { label: "SAVI",  color: "#a3e635", desc: "Soil-adjusted vegetation" },
  NDRE:  { label: "NDRE",  color: "#86efac", desc: "Red-edge (canopy health)" },
  NDMI:  { label: "NDMI",  color: "#38bdf8", desc: "Moisture index" },
  NDWI:  { label: "NDWI",  color: "#60a5fa", desc: "Water index" },
  MNDWI: { label: "MNDWI", color: "#818cf8", desc: "Modified water index" },
  NBR:   { label: "NBR",   color: "#fb923c", desc: "Burn ratio" },
  NDTI:  { label: "NDTI",  color: "#fbbf24", desc: "Turbidity index" },
  NDBAI: { label: "NDBAI", color: "#f87171", desc: "Bare area index" },
  RAQI:  { label: "RAQI",  color: "#c084fc", desc: "Pollution composite (0–1)" },
};

const CHANGE_THRESHOLD = 0.05;   // Δmean > 5% = flagged change
const ANOMALY_SIGMA    = 2.0;    // ±2σ = anomaly

// ── Helpers ──────────────────────────────────────────────────────────────────
function formatDate(d) {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[parseInt(m,10)-1]} ${parseInt(day,10)}, ${y}`;
}

function computeAnomalies(points) {
  if (!points || points.length < 3) return [];
  const means = points.map(p => p.mean).filter(v => v != null);
  if (!means.length) return [];
  const mu  = means.reduce((a,b) => a+b, 0) / means.length;
  const sig = Math.sqrt(means.reduce((a,v) => a + (v-mu)**2, 0) / means.length);
  return points.map(p => p.mean != null && Math.abs(p.mean - mu) > ANOMALY_SIGMA * sig);
}

function computeChanges(points) {
  return points.map((p, i) => {
    if (i === 0 || p.mean == null || points[i-1].mean == null) return null;
    return p.mean - points[i-1].mean;
  });
}

// ── SVG Line Chart ───────────────────────────────────────────────────────────
function TsaLineChart({ primary, secondary, primaryColor, secondaryColor, anomalies, changes, height = 210 }) {
  const [hoverIdx, setHoverIdx] = useState(null);

  const W = 600; // Wide 600px local coordinate space for normal aspect ratio
  const H = height;
  const PAD = { top: 18, right: 12, bottom: 36, left: 44 };
  const chartW = W;
  const chartH = H - PAD.top - PAD.bottom;

  // Collect all points from primary (and optionally secondary)
  const allPts = [
    ...(primary?.map(p => p.mean) ?? []),
    ...(primary?.map(p => p.mean != null && p.std != null ? p.mean + p.std : null).filter(Boolean) ?? []),
    ...(primary?.map(p => p.mean != null && p.std != null ? p.mean - p.std : null).filter(Boolean) ?? []),
    ...(secondary?.map(p => p.mean) ?? []),
  ].filter(v => v != null);

  const yMin = allPts.length ? Math.min(...allPts) : 0;
  const yMax = allPts.length ? Math.max(...allPts) : 1;
  const yRange = (yMax - yMin) || 1;
  const n = primary?.length ?? 0;

  const toX = i => PAD.left + (n <= 1 ? chartW / 2 : (i / (n - 1)) * (chartW - PAD.left - PAD.right));
  const toY = v => PAD.top + chartH - ((v - yMin) / yRange) * chartH;

  const linePath = (pts) => pts
    .map((p, i) => p.mean != null ? `${i === 0 || pts.slice(0,i).every(x=>x.mean==null) ? "M" : "L"}${toX(i).toFixed(2)} ${toY(p.mean).toFixed(2)}` : "")
    .join(" ");

  const bandPath = (pts) => {
    const upper = pts.filter(p => p.mean != null && p.std != null);
    const lower = [...upper].reverse();
    if (!upper.length) return "";
    const up = upper.map((p, i) => `${i===0?"M":"L"}${toX(pts.indexOf(p)).toFixed(2)} ${toY(p.mean + p.std).toFixed(2)}`).join(" ");
    const dn = lower.map(p => `L${toX(pts.indexOf(p)).toFixed(2)} ${toY(p.mean - p.std).toFixed(2)}`).join(" ");
    return `${up} ${dn} Z`;
  };

  // Y-axis ticks
  const yTicks = 4;
  const yTickVals = Array.from({length: yTicks+1}, (_,i) => yMin + (yRange * i / yTicks));

  return (
    <svg viewBox={`0 0 ${W + PAD.left + PAD.right} ${H}`} width="100%" height={H} style={{ display: "block", overflow: "visible" }}>
      {/* Grid lines */}
      {yTickVals.map((v, i) => (
        <g key={i}>
          <line
            x1={PAD.left} x2={W} y1={toY(v)} y2={toY(v)}
            stroke="rgba(255,255,255,0.04)" strokeWidth="1"
          />
          <text x={PAD.left - 4} y={toY(v) + 3.5} textAnchor="end"
            fontSize="7" fill="var(--muted)" fontFamily="var(--mono)">
            {v.toFixed(3)}
          </text>
        </g>
      ))}

      {/* X axis labels */}
      {primary?.map((p, i) => (
        (n <= 8 || i % Math.ceil(n/6) === 0) && (
          <text key={i} x={toX(i)} y={H - PAD.bottom + 14} textAnchor="middle"
            fontSize="7" fill="var(--muted)" fontFamily="var(--mono)"
            transform={`rotate(-30, ${toX(i)}, ${H - PAD.bottom + 14})`}>
            {p.date?.slice(5) ?? ""}
          </text>
        )
      ))}

      {/* Std deviation band — primary */}
      {primary && (
        <path d={bandPath(primary)} fill={primaryColor} opacity="0.10" />
      )}

      {/* Secondary line */}
      {secondary && (
        <path d={linePath(secondary)} fill="none" stroke={secondaryColor} strokeWidth="1.5"
          strokeDasharray="4 3" opacity="0.7" strokeLinejoin="round" strokeLinecap="round" />
      )}

      {/* Primary line */}
      {primary && (
        <path d={linePath(primary)} fill="none" stroke={primaryColor} strokeWidth="2"
          strokeLinejoin="round" strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 3px ${primaryColor}66)` }}
        />
      )}

      {/* Data points */}
      {primary?.map((p, i) => {
        if (p.mean == null) return null;
        const isAnomaly = anomalies?.[i];
        const delta = changes?.[i];
        const isBigChange = delta != null && Math.abs(delta) > CHANGE_THRESHOLD;
        return (
          <g key={i}>
            <circle
              cx={toX(i)} cy={toY(p.mean)}
              r={isAnomaly ? 5 : isBigChange ? 4.5 : 3.5}
              fill={isAnomaly ? "#f87171" : isBigChange ? (delta > 0 ? "#4ade80" : "#fb923c") : primaryColor}
              stroke="var(--surface)" strokeWidth="1.5"
              style={{ filter: isAnomaly ? "drop-shadow(0 0 4px #f87171)" : "none" }}
            />
            {/* Change arrow */}
            {isBigChange && (
              <text x={toX(i)} y={toY(p.mean) - 8} textAnchor="middle"
                fontSize="9" fill={delta > 0 ? "#4ade80" : "#fb923c"}>
                {delta > 0 ? "▲" : "▼"}
              </text>
            )}
            {/* Anomaly label */}
            {isAnomaly && (
              <text x={toX(i)} y={toY(p.mean) - 9} textAnchor="middle"
                fontSize="7.5" fill="#f87171" fontFamily="var(--mono)">
                anomaly
              </text>
            )}
          </g>
        );
      })}

      {/* Axis lines */}
      <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + chartH} stroke="var(--border2)" strokeWidth="1"/>
      <line x1={PAD.left} x2={W} y1={PAD.top + chartH} y2={PAD.top + chartH} stroke="var(--border2)" strokeWidth="1"/>

      {/* Interactive Overlay & Tooltip */}
      <rect x={PAD.left} y={PAD.top} width={chartW - PAD.left - PAD.right} height={chartH} fill="transparent" 
        onMouseLeave={() => setHoverIdx(null)}
        onMouseMove={e => {
          if (n <= 1) return;
          const rect = e.target.getBoundingClientRect();
          const svgX = (e.clientX - rect.left) * (W / rect.width);
          const wPerIdx = (chartW - PAD.left - PAD.right) / (n - 1);
          const idx = Math.max(0, Math.min(n - 1, Math.round((svgX - PAD.left) / wPerIdx)));
          setHoverIdx(idx);
        }}
        style={{ cursor: "crosshair" }}
      />
      {hoverIdx != null && primary?.[hoverIdx] && primary[hoverIdx].mean != null && (
        <g style={{ pointerEvents: "none" }}>
          <line x1={toX(hoverIdx)} x2={toX(hoverIdx)} y1={PAD.top} y2={PAD.top + chartH} stroke="var(--accent)" strokeWidth="0.5" strokeDasharray="3 3" opacity={0.6} />
          <circle cx={toX(hoverIdx)} cy={toY(primary[hoverIdx].mean)} r={4.5} fill={primaryColor} stroke="var(--surface)" strokeWidth="1.5" />
          <g transform={`translate(${toX(hoverIdx) > W/2 ? toX(hoverIdx) - 105 : toX(hoverIdx) + 10}, ${Math.max(PAD.top + 10, toY(primary[hoverIdx].mean) - 25)})`}>
            <rect width={95} height={38} rx={6} fill="var(--panel)" stroke="var(--border)" filter="drop-shadow(0 4px 10px rgba(0,0,0,0.5))" />
            <text x={8} y={14} fontSize="8" fill="var(--muted)" fontFamily="var(--mono)">{primary[hoverIdx].date}</text>
            <text x={8} y={28} fontSize="11" fontWeight="800" fill={primaryColor} fontFamily="var(--sans)">{primary[hoverIdx].mean.toFixed(4)}</text>
          </g>
        </g>
      )}
    </svg>
  );
}

// ── Summary Stats Table ──────────────────────────────────────────────────────
function StatsTable({ points, indexName, color, anomalies, changes }) {
  if (!points?.length) return null;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--mono)", fontSize: 10 }}>
        <thead>
          <tr>
            {["Date", "Mean", "Std Dev", "Min", "Max", "Δ Mean", "Flag"].map(h => (
              <th key={h} style={{
                padding: "5px 9px", textAlign: h === "Date" ? "left" : "right",
                color: "var(--muted)", fontWeight: 600, fontSize: 9,
                borderBottom: "1px solid var(--border)", background: "var(--surface)",
                letterSpacing: 0.4, whiteSpace: "nowrap",
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {points.map((p, i) => {
            const delta   = changes?.[i];
            const anomaly = anomalies?.[i];
            const bigDelta = delta != null && Math.abs(delta) > CHANGE_THRESHOLD;
            return (
              <tr key={p.date} style={{
                background: anomaly ? "rgba(248,113,113,0.05)" : i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)",
                transition: "background 0.15s",
              }}
                onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.04)"}
                onMouseLeave={e => e.currentTarget.style.background = anomaly ? "rgba(248,113,113,0.05)" : i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)"}
              >
                <td style={{ padding: "6px 9px", color: "var(--text2)", textAlign: "left", whiteSpace: "nowrap" }}>
                  {formatDate(p.date)}
                </td>
                <td style={{ padding: "6px 9px", color, textAlign: "right", fontWeight: 700 }}>
                  {p.mean?.toFixed(4) ?? "—"}
                </td>
                <td style={{ padding: "6px 9px", color: "var(--muted)", textAlign: "right" }}>
                  {p.std?.toFixed(4) ?? "—"}
                </td>
                <td style={{ padding: "6px 9px", color: "var(--muted)", textAlign: "right" }}>
                  {p.min?.toFixed(4) ?? "—"}
                </td>
                <td style={{ padding: "6px 9px", color: "var(--muted)", textAlign: "right" }}>
                  {p.max?.toFixed(4) ?? "—"}
                </td>
                <td style={{ padding: "6px 9px", textAlign: "right",
                  color: delta == null ? "var(--muted2)" : delta > 0 ? "#4ade80" : "#fb923c",
                  fontWeight: bigDelta ? 700 : 400,
                }}>
                  {delta == null ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(4)}`}
                </td>
                <td style={{ padding: "6px 9px", textAlign: "right" }}>
                  {anomaly ? (
                    <span style={{ color: "#f87171", fontSize: 9 }}>⚠ anomaly</span>
                  ) : bigDelta ? (
                    <span style={{ color: delta > 0 ? "#4ade80" : "#fb923c", fontSize: 9 }}>
                      {delta > 0 ? "▲ rise" : "▼ drop"}
                    </span>
                  ) : (
                    <span style={{ color: "var(--muted2)" }}>—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Export CSV ───────────────────────────────────────────────────────────────
function exportCsv(series, selectedIndices, jobId) {
  const allDates = [...new Set(
    selectedIndices.flatMap(idx => (series[idx] ?? []).map(p => p.date))
  )].sort();

  const headers = ["date", ...selectedIndices.flatMap(idx => [
    `${idx}_mean`, `${idx}_std`, `${idx}_min`, `${idx}_max`
  ])];

  const rows = allDates.map(date => {
    const row = [date];
    for (const idx of selectedIndices) {
      const pt = (series[idx] ?? []).find(p => p.date === date);
      row.push(pt?.mean?.toFixed(6) ?? "", pt?.std?.toFixed(6) ?? "", pt?.min?.toFixed(6) ?? "", pt?.max?.toFixed(6) ?? "");
    }
    return row;
  });

  const csv = [headers, ...rows].map(r => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `epm_tsa_${jobId}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Main TSA Tab ──────────────────────────────────────────────────────────────
export default function TSATab({ results, history }) {
  const [tsaData,       setTsaData]       = useState(null);
  const [loading,       setLoading]       = useState(false);
  const [error,         setError]         = useState(null);
  const [primaryIdx,    setPrimaryIdx]    = useState("NDVI");
  const [secondaryIdx,  setSecondaryIdx]  = useState("none");
  const [showTable,     setShowTable]     = useState(true);
  const [crossJob,      setCrossJob]      = useState(false);

  const jobId = results?.job_id;

  // Load TSA data from backend for the current job
  useEffect(() => {
    if (!jobId) return;
    setLoading(true);
    setError(null);
    getTsaData(jobId)
      .then(data => { setTsaData(data); setLoading(false); })
      .catch(err  => { setError(err.message); setLoading(false); });
  }, [jobId]);

  // Build cross-job series from history.histogramsByDate
  const crossJobSeries = useMemo(() => {
    if (!crossJob || history.length < 2) return null;
    const combined = {};
    for (const job of history) {
      for (const [date, hists] of Object.entries(job.histogramsByDate ?? {})) {
        for (const [idx, stats] of Object.entries(hists)) {
          if (!combined[idx]) combined[idx] = [];
          combined[idx].push({ date, mean: stats.mean, std: stats.std, min: stats.min, max: stats.max });
        }
      }
    }
    // Sort each index by date
    for (const idx of Object.keys(combined)) {
      combined[idx].sort((a, b) => a.date.localeCompare(b.date));
    }
    return combined;
  }, [crossJob, history]);

  const activeSeries  = crossJob ? crossJobSeries : tsaData?.series;
  const primaryPoints = activeSeries?.[primaryIdx] ?? [];
  const secondPoints  = secondaryIdx !== "none" ? (activeSeries?.[secondaryIdx] ?? []) : null;

  const anomalies = useMemo(() => computeAnomalies(primaryPoints), [primaryPoints]);
  const changes   = useMemo(() => computeChanges(primaryPoints), [primaryPoints]);

  const anomalyCount = anomalies.filter(Boolean).length;
  const changeCount  = changes.filter(d => d != null && Math.abs(d) > CHANGE_THRESHOLD).length;

  const availableIndices = useMemo(() =>
    ALL_INDICES.filter(idx => (activeSeries ?? {})[idx]?.length > 0),
    [activeSeries]
  );

  const primaryMeta    = INDEX_META[primaryIdx]   ?? { color: "#a0a0a0", desc: "" };
  const secondaryMeta  = secondaryIdx !== "none" ? (INDEX_META[secondaryIdx] ?? { color: "#a0a0a0" }) : null;

  const handleExportCsv = useCallback(() => {
    if (!activeSeries) return;
    const toExport = secondaryIdx !== "none" ? [primaryIdx, secondaryIdx] : [primaryIdx];
    exportCsv(activeSeries, toExport, jobId ?? "epm");
  }, [activeSeries, primaryIdx, secondaryIdx, jobId]);

  // ── Single-date fallback: use histogramsByDate directly ──────────────────
  const singleDateFallback = !crossJob && (primaryPoints.length === 0) && results?.histogramsByDate;
  const fallbackPoints = useMemo(() => {
    if (!singleDateFallback) return null;
    return Object.entries(results.histogramsByDate)
      .map(([date, h]) => ({ date, ...(h[primaryIdx] ?? {}) }))
      .filter(p => p.mean != null)
      .sort((a,b) => a.date.localeCompare(b.date));
  }, [singleDateFallback, primaryIdx, results?.histogramsByDate]);

  const displayPoints = fallbackPoints ?? primaryPoints;
  const displayAnomalies = fallbackPoints ? computeAnomalies(fallbackPoints) : anomalies;
  const displayChanges   = fallbackPoints ? computeChanges(fallbackPoints)   : changes;

  // ── Derived summary ──────────────────────────────────────────────────────
  const means = displayPoints.map(p => p.mean).filter(v => v != null);
  const overallMean    = means.length ? means.reduce((a,b)=>a+b,0)/means.length : null;
  const trendDelta     = means.length >= 2 ? means[means.length-1] - means[0] : null;
  const trendDirection = trendDelta == null ? null : Math.abs(trendDelta) < 0.01 ? "stable"
    : trendDelta > 0 ? "increasing" : "decreasing";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, animation: "fadeIn 0.35s ease" }}>

      {/* ── Header bar ─────────────────────────────────────────────────── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
        background: "var(--panel)", border: "1px solid var(--border)",
        borderRadius: 12, padding: "11px 15px",
      }}>
        {/* Title */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 160 }}>
          <div style={{ width: 3, height: 16, borderRadius: 2, background: "linear-gradient(180deg, #818cf8, #c084fc)", flexShrink: 0 }} />
          <span style={{ fontFamily: "var(--sans)", fontWeight: 800, fontSize: 14, color: "var(--text)" }}>
            Time Series Analysis
          </span>
          {displayPoints.length > 0 && (
            <span style={{
              fontFamily: "var(--mono)", fontSize: 9, color: "var(--accent)",
              padding: "2px 7px", background: "var(--accent-dim)",
              border: "1px solid rgba(0,240,168,0.2)", borderRadius: 10,
            }}>
              {displayPoints.length} scene{displayPoints.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        {/* Cross-job toggle */}
        {history.length > 1 && (
          <button onClick={() => setCrossJob(c => !c)} style={{
            padding: "4px 10px", borderRadius: 6, cursor: "pointer",
            border: "1px solid " + (crossJob ? "var(--accent2)" : "var(--border2)"),
            background: crossJob ? "var(--accent2-dim)" : "transparent",
            color: crossJob ? "var(--accent2)" : "var(--muted)",
            fontFamily: "var(--mono)", fontSize: 10, transition: "all 0.2s",
          }}>
            {crossJob ? "✓ " : ""} Multi-job ({history.length})
          </button>
        )}

        {/* Primary index picker */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", letterSpacing: 0.4 }}>INDEX</span>
          <select value={primaryIdx} onChange={e => setPrimaryIdx(e.target.value)} style={{
            background: "var(--surface)", border: "1px solid var(--border2)",
            borderRadius: 7, color: "var(--text)", fontFamily: "var(--mono)",
            fontSize: 11, padding: "4px 10px", cursor: "pointer", outline: "none",
          }}>
            {ALL_INDICES.map(idx => (
              <option key={idx} value={idx} disabled={availableIndices.length > 0 && !availableIndices.includes(idx)}>
                {idx}
              </option>
            ))}
          </select>
        </div>

        {/* Secondary overlay */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", letterSpacing: 0.4 }}>VS</span>
          <select value={secondaryIdx} onChange={e => setSecondaryIdx(e.target.value)} style={{
            background: "var(--surface)", border: "1px solid var(--border2)",
            borderRadius: 7, color: "var(--text)", fontFamily: "var(--mono)",
            fontSize: 11, padding: "4px 10px", cursor: "pointer", outline: "none",
          }}>
            <option value="none">None</option>
            {ALL_INDICES.filter(i => i !== primaryIdx).map(idx => (
              <option key={idx} value={idx}>{idx}</option>
            ))}
          </select>
        </div>

        {/* Table toggle */}
        <button onClick={() => setShowTable(t => !t)} style={{
          padding: "4px 10px", borderRadius: 6, cursor: "pointer",
          border: "1px solid var(--border2)", background: "transparent",
          color: "var(--muted)", fontFamily: "var(--mono)", fontSize: 10, transition: "all 0.2s",
        }}>
          {showTable ? "Hide Table" : "Show Table"}
        </button>

        {/* Export CSV */}
        <button onClick={handleExportCsv} disabled={!displayPoints.length} style={{
          display: "flex", alignItems: "center", gap: 5,
          padding: "5px 11px", borderRadius: 7, cursor: displayPoints.length ? "pointer" : "not-allowed",
          border: "1px solid var(--accent2)", background: "transparent",
          color: displayPoints.length ? "var(--accent2)" : "var(--muted)",
          fontFamily: "var(--mono)", fontSize: 10, transition: "all 0.2s",
        }}
          onMouseEnter={e => { if (displayPoints.length) e.currentTarget.style.background = "var(--accent2-dim)"; }}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"}
        >
          <Icon.Download /> Export CSV
        </button>
      </div>

      {/* ── Loading / Error ──────────────────────────────────────────────── */}
      {loading && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px",
          background: "var(--panel)", borderRadius: 10, border: "1px solid var(--border)" }}>
          <Icon.Loader /> <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)" }}>Loading time series data…</span>
        </div>
      )}

      {error && !displayPoints.length && (
        <div style={{ padding: "10px 14px", borderRadius: 8,
          background: "rgba(251,191,36,0.06)", border: "1px solid rgba(251,191,36,0.2)",
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--warn)" }}>
          ⚠ TSA data not available for this job ({error}). Showing histogram stats where available.
        </div>
      )}

      {/* ── Summary KPI cards ────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 11 }}>
        {[
          {
            label: "SCENES",
            value: displayPoints.length || "—",
            sub: crossJob ? "across jobs" : "in date range",
            color: "var(--accent)",
            isNum: false,
          },
          {
            label: "OVERALL MEAN",
            value: overallMean != null ? overallMean.toFixed(4) : "—",
            sub: `${primaryIdx} across all dates`,
            color: primaryMeta.color,
            isNum: false,
          },
          {
            label: "TREND",
            value: trendDirection
              ? { increasing: "▲ Rising", decreasing: "▼ Falling", stable: "→ Stable" }[trendDirection]
              : "—",
            sub: trendDelta != null ? `Δ${trendDelta > 0 ? "+" : ""}${trendDelta.toFixed(4)} total` : "need ≥2 dates",
            color: trendDirection === "increasing" ? "#4ade80" : trendDirection === "decreasing" ? "#fb923c" : "var(--muted)",
            isNum: false,
          },
          {
            label: "ALERTS",
            value: `${anomalyCount + changeCount}`,
            sub: `${anomalyCount} anomal${anomalyCount!==1?"ies":"y"} · ${changeCount} change${changeCount!==1?"s":""}`,
            color: anomalyCount > 0 ? "#f87171" : changeCount > 0 ? "#fbbf24" : "var(--accent)",
            isNum: false,
          },
        ].map(({ label, value, sub, color }) => (
          <div key={label} style={{
            background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12,
            padding: "14px 16px", display: "flex", flexDirection: "column", gap: 5,
            position: "relative", overflow: "hidden", animation: "fadeUp 0.4s ease both",
            transition: "border-color 0.2s, transform 0.2s", cursor: "default",
          }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = color; e.currentTarget.style.transform = "translateY(-2px)"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.transform = "none"; }}
          >
            <div style={{ position:"absolute", top:-24, right:-24, width:80, height:80, borderRadius:"50%", background:color, opacity:0.07, filter:"blur(20px)", pointerEvents:"none" }} />
            <span style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--muted)", letterSpacing:0.6 }}>{label}</span>
            <div style={{ fontFamily:"var(--sans)", fontWeight:800, fontSize:22, lineHeight:1, color }}>{value}</div>
            <div style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--muted)" }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* ── Chart panel ─────────────────────────────────────────────────── */}
      <div style={{
        background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12,
        padding: 16, animation: "slideInLeft 0.4s ease",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 3, height: 14, borderRadius: 2, background: `linear-gradient(180deg, ${primaryMeta.color}, ${primaryMeta.color}66)`, flexShrink: 0 }} />
            <span style={{ fontFamily: "var(--sans)", fontWeight: 700, fontSize: 13, color: "var(--text)" }}>
              {primaryIdx} Trend
              {secondaryIdx !== "none" && <span style={{ color: secondaryMeta?.color, marginLeft: 6 }}>vs {secondaryIdx}</span>}
            </span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)" }}>
              {primaryMeta.desc}
            </span>
          </div>

          {/* Legend */}
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            {[
              { color: primaryMeta.color, label: primaryIdx, dash: false },
              ...(secondaryMeta ? [{ color: secondaryMeta.color, label: secondaryIdx, dash: true }] : []),
              { color: "#f87171",  label: "Anomaly" },
              { color: "#4ade80",  label: "▲ Rise" },
              { color: "#fb923c",  label: "▼ Drop" },
            ].map(({ color, label, dash }) => (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{
                  width: 20, height: 2, background: color, borderRadius: 1,
                  borderTop: dash ? `2px dashed ${color}` : "none",
                }} />
                <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--muted)" }}>{label}</span>
              </div>
            ))}
          </div>
        </div>

        {displayPoints.length === 0 ? (
          <div style={{ height: 210, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 8 }}>
            <span style={{ fontFamily: "var(--sans)", fontSize: 28 }}>📈</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)" }}>
              {loading ? "Loading…" : `No data for ${primaryIdx} in this job`}
            </span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted2)" }}>
              Try a wider date range for multi-point time series
            </span>
          </div>
        ) : (
          <TsaLineChart
            primary={displayPoints}
            secondary={secondPoints}
            primaryColor={primaryMeta.color}
          secondaryColor={secondaryMeta?.color ?? "#a0a0a0"}
            anomalies={displayAnomalies}
            changes={displayChanges}
            height={220}
          />
        )}

        {/* ── Cloud coverage row ──────────────────────────────────────────── */}
        {tsaData?.cloud_pct && Object.keys(tsaData.cloud_pct).length > 0 && (
          <div style={{ marginTop: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--muted)", letterSpacing: 0.5 }}>CLOUD / NO-DATA %</span>
              <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
            </div>
            <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height: 40 }}>
              {Object.entries(tsaData.cloud_pct)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([date, pct]) => {
                  const val = pct ?? 0;
                  const bad = val > 50;
                  const warn = val > 30;
                  const barColor = bad ? "#f87171" : warn ? "#fbbf24" : "#38bdf8";
                  return (
                    <div key={date} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}
                      title={`${date}: ${val.toFixed(1)}% cloud/nodata`}>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 7, color: barColor }}>{val.toFixed(0)}%</span>
                      <div style={{
                        width: "100%", background: "var(--border)", borderRadius: 3, overflow: "hidden",
                        height: 20,
                      }}>
                        <div style={{
                          width: "100%", background: barColor, opacity: 0.7, borderRadius: 3,
                          height: `${Math.min(val, 100)}%`, transition: "height 0.6s ease",
                          boxShadow: `0 0 4px ${barColor}66`,
                        }} />
                      </div>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 6, color: "var(--muted2)" }}>
                        {date.slice(5)}
                      </span>
                    </div>
                  );
                })}
            </div>
          </div>
        )}
      </div>

      {/* ── Anomaly + Change Detection panel ────────────────────────────── */}
      {displayPoints.length > 0 && (anomalyCount > 0 || changeCount > 0) && (
        <div style={{
          display: "grid", gridTemplateColumns: "1fr 1fr", gap: 11,
          animation: "fadeUp 0.45s ease",
        }}>
          {/* Anomaly alerts */}
          {anomalyCount > 0 && (
            <div style={{ background: "var(--panel)", border: "1px solid rgba(248,113,113,0.3)", borderRadius: 12, padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
                <div style={{ width: 3, height: 13, borderRadius: 2, background: "linear-gradient(180deg, #f87171, #fb923c)" }} />
                <span style={{ fontFamily: "var(--sans)", fontWeight: 700, fontSize: 12, color: "var(--text)" }}>
                  Anomaly Dates
                </span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "#f87171", marginLeft: "auto" }}>
                  {anomalyCount} detected
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {displayPoints.map((p, i) => displayAnomalies?.[i] && (
                  <div key={p.date} style={{
                    padding: "6px 10px", borderRadius: 7,
                    background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)",
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                  }}>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text2)" }}>
                      {formatDate(p.date)}
                    </span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "#f87171", fontWeight: 700 }}>
                      {primaryIdx} = {p.mean?.toFixed(4)}
                    </span>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 9, fontFamily: "var(--mono)", fontSize: 8, color: "var(--muted2)" }}>
                ⓘ Anomaly = value beyond ±{ANOMALY_SIGMA}σ from series mean
              </div>
            </div>
          )}

          {/* Change detection */}
          {changeCount > 0 && (
            <div style={{ background: "var(--panel)", border: "1px solid rgba(251,191,36,0.3)", borderRadius: 12, padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
                <div style={{ width: 3, height: 13, borderRadius: 2, background: "linear-gradient(180deg, #fbbf24, #fb923c)" }} />
                <span style={{ fontFamily: "var(--sans)", fontWeight: 700, fontSize: 12, color: "var(--text)" }}>
                  Change Events
                </span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "#fbbf24", marginLeft: "auto" }}>
                  |Δ| &gt; {CHANGE_THRESHOLD}
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {displayPoints.map((p, i) => {
                  const d = displayChanges?.[i];
                  if (d == null || Math.abs(d) <= CHANGE_THRESHOLD) return null;
                  return (
                    <div key={p.date} style={{
                      padding: "6px 10px", borderRadius: 7,
                      background: d > 0 ? "rgba(74,222,128,0.07)" : "rgba(251,146,60,0.07)",
                      border: `1px solid ${d > 0 ? "rgba(74,222,128,0.2)" : "rgba(251,146,60,0.2)"}`,
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                    }}>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text2)" }}>
                        {formatDate(p.date)}
                      </span>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700,
                        color: d > 0 ? "#4ade80" : "#fb923c",
                      }}>
                        {d > 0 ? "▲+" : "▼"}{d.toFixed(4)}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div style={{ marginTop: 9, fontFamily: "var(--mono)", fontSize: 8, color: "var(--muted2)" }}>
                ⓘ Change = consecutive scene difference in mean {primaryIdx}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Summary stats table ──────────────────────────────────────────── */}
      {showTable && displayPoints.length > 0 && (
        <div style={{
          background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12,
          overflow: "hidden", animation: "fadeUp 0.5s ease",
        }}>
          <div style={{
            padding: "11px 15px", borderBottom: "1px solid var(--border)",
            display: "flex", alignItems: "center", gap: 8,
          }}>
            <div style={{ width: 3, height: 13, borderRadius: 2, background: `linear-gradient(180deg,${primaryMeta.color},#818cf8)` }} />
            <span style={{ fontFamily: "var(--sans)", fontWeight: 700, fontSize: 12, color: "var(--text)" }}>
              Per-Scene Statistics — {primaryIdx}
            </span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", marginLeft: "auto" }}>
              {displayPoints.length} row{displayPoints.length !== 1 ? "s" : ""}
            </span>
          </div>
          <StatsTable
            points={displayPoints}
            indexName={primaryIdx}
            color={primaryMeta.color}
            anomalies={displayAnomalies}
            changes={displayChanges}
          />
        </div>
      )}

      {/* ── Single-date notice ───────────────────────────────────────────── */}
      {displayPoints.length === 1 && (
        <div style={{
          padding: "10px 14px", borderRadius: 8,
          background: "rgba(56,189,248,0.06)", border: "1px solid rgba(56,189,248,0.2)",
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent2)",
        }}>
          ⓘ Only 1 scene available. Run more jobs over wider date ranges and enable <strong>Multi-job</strong> mode for a full trend chart.
        </div>
      )}
    </div>
  );
}
