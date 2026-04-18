import { useEffect, useState } from "react";
import InfoTooltip from "../InfoTooltip";
import CogLeafletMap   from "../CogLeafletMap";
import { Icon }        from "../Icons";
import { CLUSTER_LABELS } from "../../data/mockData";
import { getTifUrl }   from "../../utils/api";

// Fixed absolute thresholds — kept only as fallback display reference
const CLASS_MIDPOINTS = [0.215, 0.445, 0.475, 0.510, 0.765];

function deriveCentroids(histograms) {
  // Prefer real KMeans centroids saved by the backend
  const saved = histograms?._meta?.kmeans_centroids;
  if (Array.isArray(saved) && saved.length === 5) return saved;

  // Fallback: derive weighted mean within each fixed-threshold band from RAQI histogram
  const freq = histograms?.RAQI?.frequency ?? [];
  const bins = histograms?.RAQI?.bins ?? [];
  if (!freq.length || bins.length < 2) return CLASS_MIDPOINTS;
  const bands = [
    [-Infinity, 0.43], [0.43, 0.46], [0.46, 0.49], [0.49, 0.53], [0.53, Infinity]
  ];
  return bands.map(([lo, hi], k) => {
    let wSum = 0, fSum = 0;
    for (let i = 0; i < freq.length; i++) {
      const mid = (bins[i] + bins[i + 1]) / 2;
      if (mid >= lo && mid < hi) { wSum += mid * freq[i]; fSum += freq[i]; }
    }
    return fSum > 0 ? wSum / fSum : CLASS_MIDPOINTS[k];
  });
}

function deriveClusterPct(histograms) {
  // If the backend saved per-cluster pixel counts (KMeans run), use them directly
  const meta = histograms?._meta;
  if (meta?.kmeans_cluster_counts && Array.isArray(meta.kmeans_cluster_counts) && meta.kmeans_cluster_counts.length === 5) {
    const total = meta.kmeans_cluster_counts.reduce((a, b) => a + b, 0);
    if (total > 0) return meta.kmeans_cluster_counts.map(c => Math.max(1, Math.round((c / total) * 100)));
  }

  // Fallback: derive from RAQI histogram using legacy fixed-band boundaries
  const freq = histograms?.RAQI?.frequency ?? null;
  const bins = histograms?.RAQI?.bins ?? null;
  if (!freq || !bins || bins.length < 2) return [28, 24, 21, 16, 11];
  const total = freq.reduce((a, b) => a + b, 0);
  if (total === 0) return [28, 24, 21, 16, 11];
  const bands = [
    [-Infinity, 0.43], [0.43, 0.46], [0.46, 0.49], [0.49, 0.53], [0.53, Infinity]
  ];
  return bands.map(([lo, hi]) => {
    const sum = freq.reduce((acc, v, i) => {
      const mid = (bins[i] + bins[i + 1]) / 2;
      return (mid >= lo && mid < hi) ? acc + v : acc;
    }, 0);
    return Math.max(1, Math.round((sum / total) * 100));
  });
}

function AnimatedBar({ color, pct, delay }) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setW(pct), delay + 80);
    return () => clearTimeout(t);
  }, [pct, delay]);
  return (
    <div style={{ height: 6, background: "var(--border)", borderRadius: 3, overflow: "hidden" }}>
      <div style={{
        height: "100%", background: `linear-gradient(90deg, ${color}, ${color}bb)`,
        borderRadius: 3, boxShadow: `0 0 8px ${color}66`,
        width: `${Math.min(w * 1.5, 100)}%`,
        transition: `width 1.1s ${delay}ms cubic-bezier(0.34,1.56,0.64,1)`,
      }} />
    </div>
  );
}

function StackedBar({ clusterPct }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => { const t = setTimeout(() => setVisible(true), 80); return () => clearTimeout(t); }, []);
  return (
    <div style={{ display: "flex", height: 14, borderRadius: 6, overflow: "hidden", gap: 1 }}>
      {CLUSTER_LABELS.map((c, i) => (
        <div key={c.label} style={{
          flex: visible ? clusterPct[i] : 0,
          background: c.color,
          transition: `flex 1.2s ${i * 0.08}s cubic-bezier(0.34,1.56,0.64,1)`,
          boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.2)",
        }} title={`${c.label}: ${clusterPct[i]}%`} />
      ))}
    </div>
  );
}

export default function ClustersTab({ results }) {
  const jobId      = results?.job_id;
  const date       = results?.date;
  const aoiGeoJSON = results?.aoi ?? null;
  const aoiName    = results?.aoiName ?? null;
  const tifUrl     = jobId && date ? getTifUrl(jobId, date, "pollution_clusters") : null;
  const clusterPct = deriveClusterPct(results?.histograms);
  const centroids  = deriveCentroids(results?.histograms);
  const highCritPct = clusterPct[3] + clusterPct[4];
  const cleanLowPct = clusterPct[0] + clusterPct[1];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, animation: "fadeIn 0.35s ease" }}>

      {/* Coverage stacked bar */}
      <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12, padding: "13px 16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <div style={{ width: 3, height: 14, borderRadius: 2, background: "linear-gradient(180deg, var(--accent), var(--warn))" }} />
          <span style={{ fontFamily: "var(--sans)", fontWeight: 700, fontSize: 12, color: "var(--text)" }}>Area Coverage by Risk Class</span>
          <InfoTooltip
            title="Area Coverage"
            position="right"
            width={260}
            body="The stacked bar shows what fraction of the total mapped area each risk class covers. Dominated by green = predominantly clean landscape. Any visible red/orange segments indicate pollution hot-spots requiring investigation."
          />
          <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", marginLeft: 4 }}>KMeans · 5 classes</span>
          {date && (
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, padding: "2px 8px", background: "var(--accent-dim)", border: "1px solid rgba(0,240,168,0.2)", borderRadius: 10 }}>
              <div style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent)", animation: "pulse-dot 1.5s ease infinite" }} />
              <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--accent)" }}>{date}</span>
            </div>
          )}
        </div>
        <StackedBar clusterPct={clusterPct} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px", marginTop: 9 }}>
          {CLUSTER_LABELS.map((c, i) => (
            <div key={c.label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: c.color }} />
              <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text2)" }}>{c.label}</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: c.color, fontWeight: 700 }}>({clusterPct[i]}%)</span>
            </div>
          ))}
        </div>
      </div>

      {/* Full-width COG map */}
      <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12, padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 3, height: 14, borderRadius: 2, background: "linear-gradient(180deg, var(--accent), var(--accent3))" }} />
            <span style={{ fontFamily: "var(--sans)", fontWeight: 700, fontSize: 13, color: "var(--text)" }}>Pollution Cluster Map</span>
            <InfoTooltip
              title="Pollution Cluster Map"
              position="right"
              width={300}
              body="Each pixel is classified into one of 5 pollution risk classes using KMeans clustering on the RAQI values for that scene. Cluster boundaries are learned from the data, so they reflect natural breaks in the pollution distribution rather than fixed constants."
              legend={[
                { color:"#34d399", label:"Very Low Risk",  desc:"RAQI < 0.43 — Clean, high vegetation health" },
                { color:"#a3e635", label:"Low Risk",       desc:"RAQI 0.43–0.46 — Minor stress, manageable" },
                { color:"#fbbf24", label:"Moderate Risk",  desc:"RAQI 0.46–0.49 — Monitoring recommended" },
                { color:"#fb923c", label:"High Risk",      desc:"RAQI 0.49–0.53 — Industrial / degraded zone" },
                { color:"#f87171", label:"Critical Risk",  desc:"RAQI ≥ 0.53 — Urgent intervention needed" },
              ]}
            />
            {jobId && date && (
              <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 7px", background: "var(--accent-dim)", border: "1px solid rgba(0,240,168,0.2)", borderRadius: 10 }}>
                <div style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent)", animation: "pulse-dot 1.5s ease infinite" }} />
                <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--accent)" }}>REAL DATA</span>
              </div>
            )}
          </div>
          {tifUrl && (
            <a href={tifUrl} target="_blank" rel="noreferrer" style={{
              display: "flex", alignItems: "center", gap: 5,
              fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent2)",
              textDecoration: "none", padding: "4px 10px",
              border: "1px solid var(--border2)", borderRadius: 6, transition: "all 0.2s",
            }}
              onMouseEnter={e => e.currentTarget.style.background = "var(--accent2-dim)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            >
              <Icon.Download /> clusters.tif
            </a>
          )}
        </div>

        <CogLeafletMap jobId={jobId} date={date} layer="pollution_clusters" height={440} label="KMeans · 5 classes" aoiGeoJSON={aoiGeoJSON} aoiName={aoiName} />

        <div style={{ display: "flex", gap: 16, marginTop: 12, flexWrap: "wrap", justifyContent: "center" }}>
          {CLUSTER_LABELS.map((c) => (
            <div key={c.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ width: 13, height: 13, borderRadius: 3, background: c.color, flexShrink: 0, boxShadow: `0 0 6px ${c.color}88` }} />
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text2)" }}>{c.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Centroid cards — 5 columns */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
        {CLUSTER_LABELS.map((c, i) => (
          <div key={c.label} style={{
            background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12,
            padding: "13px 14px", animation: `fadeUp 0.4s ${i * 0.07}s ease both`,
            transition: "border-color 0.2s, transform 0.2s",
          }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = c.color; e.currentTarget.style.transform = "translateY(-2px)"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.transform = "translateY(0)"; }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
              <div style={{ width: 10, height: 10, borderRadius: 3, background: c.color, flexShrink: 0, boxShadow: `0 0 8px ${c.color}` }} />
              <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: c.color, fontWeight: 700 }}>{c.label}</span>
            </div>
            <div style={{ fontFamily: "var(--sans)", fontWeight: 800, fontSize: 22, color: c.color, marginBottom: 2 }}>
              {centroids[i].toFixed(3)}
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--muted)", marginBottom: 10 }}>KMeans centroid</div>
            <AnimatedBar color={c.color} pct={clusterPct[i]} delay={i * 100} />
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", marginTop: 5, textAlign: "right" }}>
              {clusterPct[i]}% of area
            </div>
          </div>
        ))}
      </div>

      {/* Summary row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        {[
          { label: "High + Critical Risk", value: `${highCritPct}%`, color: "var(--danger)", sub: "Requires immediate attention" },
          { label: "Moderate Risk",        value: `${clusterPct[2]}%`, color: "var(--warn)",   sub: "Monitoring recommended" },
          { label: "Clean + Low Risk",     value: `${cleanLowPct}%`, color: "var(--accent)",  sub: "Within acceptable range" },
        ].map(s => (
          <div key={s.label} style={{
            background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12,
            padding: "14px 16px", textAlign: "center",
          }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", marginBottom: 5 }}>{s.label}</div>
            <div style={{ fontFamily: "var(--sans)", fontWeight: 800, fontSize: 28, color: s.color }}>{s.value}</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted2)", marginTop: 4 }}>{s.sub}</div>
          </div>
        ))}
      </div>

    </div>
  );
}
