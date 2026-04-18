import { useState } from "react";
import InfoTooltip from "../InfoTooltip";
import CogLeafletMap from "../CogLeafletMap";
import MiniHistogram from "../MiniHistogram";
import { Icon }      from "../Icons";
import { INDEX_META } from "../../data/mockData";
import { getTifUrl } from "../../utils/api";

const GROUPS = {
  all:        { label: "All",        keys: null },
  vegetation: { label: "Vegetation", keys: ["NDVI", "EVI", "SAVI", "NDRE"] },
  water:      { label: "Water",      keys: ["NDWI", "MNDWI", "NDMI"] },
  other:      { label: "Other",      keys: ["NBR", "NDTI", "NDBAI"] },
};

function IndexMapCard({ name, data, meta, jobId, date, aoiGeoJSON, aoiName, delay = 0 }) {
  const tifUrl = jobId && date ? getTifUrl(jobId, date, name) : null;
  return (
    <div
      style={{
        background: "var(--panel)", border: "1px solid var(--border)",
        borderRadius: 12, overflow: "hidden",
        animation: `fadeUp 0.4s ${delay}s ease both`,
        transition: "border-color 0.2s, box-shadow 0.2s",
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = meta.color; e.currentTarget.style.boxShadow = `0 0 18px ${meta.color}22`; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.boxShadow = "none"; }}
    >
      {/* Header */}
      <div style={{ padding: "11px 13px", display: "flex", alignItems: "center", gap: 9 }}>
        <div style={{ width: 3, height: 14, borderRadius: 2, background: meta.color, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            <div style={{ fontFamily: "var(--sans)", fontWeight: 700, fontSize: 13, color: meta.color }}>{meta.label}</div>
            {meta.info && <InfoTooltip title={meta.label} body={meta.info} position="right" width={260} />}
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{meta.desc}</div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--text)", fontWeight: 700 }}>
            {data ? (data.mean ?? 0).toFixed(3) : "—"}
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)" }}>μ</div>
        </div>
      </div>

      {/* COG Leaflet map */}
      <div style={{ position: "relative", margin: "0 13px 10px" }}>
        <CogLeafletMap jobId={jobId} date={date} layer={name} height={200} aoiGeoJSON={aoiGeoJSON} aoiName={aoiName} />
        {tifUrl && (
          <a href={tifUrl} target="_blank" rel="noreferrer"
            style={{
              position: "absolute", bottom: 6, right: 6, zIndex: 1000,
              display: "flex", alignItems: "center", gap: 4,
              padding: "3px 7px", borderRadius: 4,
              background: "rgba(6,8,11,0.85)", border: "1px solid var(--border2)",
              fontFamily: "var(--mono)", fontSize: 9, color: "var(--accent2)",
              textDecoration: "none", backdropFilter: "blur(6px)",
            }}
          >
            <Icon.Download /> .tif
          </a>
        )}
      </div>

      {/* Histogram */}
      {data && (
        <div style={{ padding: "0 13px 8px" }}>
          <div style={{ background: "var(--surface)", borderRadius: 6, padding: "5px 4px 2px" }}>
            <MiniHistogram data={data} color={meta.color} height={50} />
          </div>
        </div>
      )}

      {/* Stats */}
      {data && (
        <div style={{ padding: "8px 13px 12px", display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border)" }}>
          {[["min", data.min], ["σ", data.std], ["max", data.max]].map(([l, v]) => (
            <div key={l} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--muted)" }}>{l}</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text2)", fontWeight: 700 }}>{(v ?? 0).toFixed(3)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function IndicesTab({ results }) {
  const rawHistograms = results?.histograms;
  const jobId         = results?.job_id;
  const date          = results?.date;
  const aoiGeoJSON    = results?.aoi ?? null;
  const aoiName       = results?.aoiName ?? null;
  const [filter, setFilter] = useState("all");

  const hasData = rawHistograms && Object.keys(rawHistograms).length > 0;

  if (!hasData) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 20px", gap: 14, opacity: 0.5 }}>
        <div style={{ width: 48, height: 48, borderRadius: "50%", border: "2px solid var(--border2)", borderTopColor: "var(--accent2)", animation: "spin 1.5s linear infinite" }} />
        <div style={{ fontFamily: "var(--sans)", fontWeight: 700, fontSize: 14, color: "var(--muted)" }}>No index data</div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted2)" }}>Run the pipeline to compute spectral indices</div>
      </div>
    );
  }

  const allEntries = Object.entries(rawHistograms).filter(([k, v]) => {
    if (k === "RAQI") return false;
    if (k.startsWith("_")) return false;
    return v && typeof v === "object";
  });
  const filtered   = filter === "all" ? allEntries
    : allEntries.filter(([k]) => GROUPS[filter]?.keys?.includes(k));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, animation: "fadeIn 0.35s ease" }}>

      {/* Overview bar */}
      <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12, padding: "11px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <div style={{ width: 3, height: 13, borderRadius: 2, background: "linear-gradient(180deg, var(--accent2), var(--accent3))" }} />
          <span style={{ fontFamily: "var(--sans)", fontWeight: 700, fontSize: 11, color: "var(--text2)", letterSpacing: 1, textTransform: "uppercase" }}>
            {allEntries.length} Spectral Indices
          </span>
          <InfoTooltip
            title="Spectral Indices"
            position="right"
            width={310}
            body="Spectral indices are mathematical combinations of Sentinel-2 bands that highlight specific environmental properties. Each index is computed per-pixel from the cloud-masked mosaic. The histogram below each map shows the value distribution across the scene."
            legend={[
              { color:"#34d399", label:"Vegetation (NDVI, EVI, SAVI, NDRE)", desc:"Higher = healthier, denser green cover" },
              { color:"#38bdf8", label:"Water (NDWI, MNDWI, NDMI)",          desc:"Higher = more surface water or moisture" },
              { color:"#fb923c", label:"Stress / Other (NBR, NDTI, NDBAI)",  desc:"Context-dependent — see each card" },
            ]}
          />
          {date && (
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, padding: "2px 8px", background: "var(--accent-dim)", border: "1px solid rgba(0,240,168,0.2)", borderRadius: 10 }}>
              <div style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent)", animation: "pulse-dot 1.5s ease infinite" }} />
              <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--accent)" }}>{date}</span>
            </div>
          )}
        </div>
        {/* Summary chips */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {allEntries.map(([name, data]) => {
            const m = INDEX_META[name] ?? { label: name, color: "var(--muted)" };
            return (
              <div key={name} style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 20, background: "var(--surface)", border: "1px solid var(--border)" }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: m.color }} />
                <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text2)" }}>{m.label}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: m.color, fontWeight: 700 }}>
                  {data ? (data.mean ?? 0).toFixed(2) : "—"}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Group filter */}
      <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)" }}>GROUP</span>
        {Object.entries(GROUPS).map(([key, g]) => (
          <button key={key} onClick={() => setFilter(key)} style={{
            padding: "5px 13px", borderRadius: 20, cursor: "pointer",
            border: `1px solid ${filter === key ? "var(--accent2)" : "var(--border)"}`,
            background: filter === key ? "var(--accent2-dim)" : "transparent",
            color: filter === key ? "var(--accent2)" : "var(--muted)",
            fontFamily: "var(--mono)", fontSize: 10, transition: "all 0.18s",
          }}>
            {g.label}{filter === key && g.keys ? ` (${filtered.length})` : ""}
          </button>
        ))}
      </div>

      {/* Index cards grid — COG map + histogram + stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14 }}>
        {filtered.map(([name, data], i) => {
          const meta = INDEX_META[name] ?? { label: name, color: "var(--accent)", desc: "Spectral Index" };
          return <IndexMapCard key={name} name={name} data={data} meta={meta} jobId={jobId} date={date} aoiGeoJSON={aoiGeoJSON} aoiName={aoiName} delay={i * 0.04} />;
        })}
      </div>
    </div>
  );
}
