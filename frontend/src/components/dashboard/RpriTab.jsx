import { useEffect, useRef, useState } from "react";
import InfoTooltip from "../InfoTooltip";
import CogLeafletMap  from "../CogLeafletMap";
import RpriColorScale from "../RpriColorScale";
import MiniHistogram  from "../MiniHistogram";
import { Icon }       from "../Icons";
import { getTifUrl }  from "../../utils/api";
import { INDEX_META } from "../../data/constants";
import { deriveClusterPct } from "../../utils/dataUtils";

// ── Animated counter ──────────────────────────────────────────────────────
function AnimatedNum({ value, decimals = 3, color, suffix = "" }) {
  const [display, setDisplay] = useState(0);
  const rafRef = useRef(null);
  useEffect(() => {
    if (value == null) return;
    const start = Date.now();
    const to    = parseFloat(value);
    const tick  = () => {
      const t = Math.min((Date.now() - start) / 900, 1);
      const e = 1 - Math.pow(1 - t, 3);
      setDisplay(to * e);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value]);
  if (value == null) return <span style={{ color: "var(--muted)" }}>—</span>;
  return <span style={{ color }}>{display.toFixed(decimals)}{suffix}</span>;
}

function StatCard({ label, value, sub, color, delay = 0, decimals = 3, suffix = "" }) {
  return (
    <div style={{
      background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12,
      padding: "15px 17px", display: "flex", flexDirection: "column", gap: 5,
      position: "relative", overflow: "hidden",
      animation: `fadeUp 0.45s ${delay}s ease both`,
      transition: "border-color 0.2s, transform 0.2s", cursor: "default",
    }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = color; e.currentTarget.style.transform = "translateY(-2px)"; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.transform = "translateY(0)"; }}
    >
      <div style={{ position:"absolute", top:-28, right:-28, width:90, height:90, borderRadius:"50%", background:color, opacity:0.07, filter:"blur(22px)", pointerEvents:"none" }} />
      <div style={{ position:"absolute", left:0, right:0, height:1, background:`linear-gradient(90deg,transparent,${color}44,transparent)`, animation:"scanline 3s linear infinite", pointerEvents:"none" }} />
      <span style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--muted)", letterSpacing:0.6 }}>{label}</span>
      <div style={{ fontFamily:"var(--sans)", fontWeight:800, fontSize:26, lineHeight:1 }}>
        <AnimatedNum value={value} color={color} decimals={decimals} suffix={suffix} />
      </div>
      <div style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--muted)" }}>{sub}</div>
    </div>
  );
}

function RiskBar({ label, color, pct, delay = 0 }) {
  const [on, setOn] = useState(false);
  useEffect(() => { const t = setTimeout(() => setOn(true), delay + 80); return () => clearTimeout(t); }, [delay]);
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:3 }}>
        <div style={{ width:7, height:7, borderRadius:2, background:color, flexShrink:0, boxShadow:`0 0 5px ${color}` }} />
        <span style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--text2)", flex:1 }}>{label}</span>
        <span style={{ fontFamily:"var(--mono)", fontSize:9, color, fontWeight:700 }}>{pct}%</span>
      </div>
      <div style={{ height:4, background:"var(--border)", borderRadius:3, overflow:"hidden" }}>
        <div style={{
          height:"100%", borderRadius:3,
          background:`linear-gradient(90deg,${color},${color}aa)`,
          width: on ? `${Math.min(pct * 2, 100)}%` : "0%",
          boxShadow:`0 0 7px ${color}66`,
          transition:`width 1s ${delay}ms cubic-bezier(0.34,1.56,0.64,1)`,
        }} />
      </div>
    </div>
  );
}


// Plasma colormap stops — matches tile server render_tile() RPRI colormap
const PLASMA_RISK_LABELS = [
  { label: "Very Low Risk",  color: "#0d0887" },  // plasma 0.00 — deep purple
  { label: "Low Risk",       color: "#7e03a8" },  // plasma 0.25 — violet
  { label: "Moderate Risk",  color: "#cc4778" },  // plasma 0.50 — pink-red
  { label: "High Risk",      color: "#f89441" },  // plasma 0.75 — orange
  { label: "Critical Risk",  color: "#f0f921" },  // plasma 1.00 — bright yellow
];

function getRiskClass(rpri) {
  if (rpri == null) return null;
  // Adaptive scaling maps the scene to [0, 1].
  // Thresholds are widened to represent relative quintiles.
  if (rpri < 0.2) return PLASMA_RISK_LABELS[0];
  if (rpri < 0.4) return PLASMA_RISK_LABELS[1];
  if (rpri < 0.6) return PLASMA_RISK_LABELS[2];
  if (rpri < 0.8) return PLASMA_RISK_LABELS[3];
  return PLASMA_RISK_LABELS[4];
}


export default function RpriTab({ results }) {
  const rawRpri    = results?.histograms?.RPRI ?? results?.histograms?.RAQI;
  const jobId      = results?.job_id;
  const date       = results?.date;
  const aoiGeoJSON = results?.aoi ?? null;
  const aoiName    = results?.aoiName ?? null;
  const tifUrl     = jobId && date ? getTifUrl(jobId, date, "RPRI") : null;
  const hasData    = !!rawRpri;
  const clusterPct = deriveClusterPct(results?.histograms);

  // Coverage warning from _meta
  const meta       = results?.histograms?._meta;
  const validPct   = meta?.valid_pct ?? null;
  const cloudPct   = meta?.cloud_pct ?? null;
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const showCoverageWarn = !bannerDismissed && validPct != null && validPct < 70;

  const riskClass = getRiskClass(rawRpri?.mean);
  const highRiskPct = clusterPct ? ((clusterPct[3] || 0) + (clusterPct[4] || 0)) : null;

  const cards = [
    { label:"RPRI MEAN", value:rawRpri?.mean, sub: riskClass ? riskClass.label : "Area-weighted pollution score",  color: riskClass ? riskClass.color : "#fbbf24", delay:0.00 },
    { label:"STD DEV",   value:rawRpri?.std,  sub:"Spatial variability", color:"var(--accent2)", delay:0.07 },
    { label:"HIGH RISK", value:highRiskPct,   sub:"High & Critical risk area", color:"var(--danger)", delay:0.14, decimals:1, suffix:"%" },
    { label:"COVERAGE",  value:validPct,      sub:"Valid cloud-free pixels", color:"var(--accent)", delay:0.21, decimals:1, suffix:"%" },
  ];

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16, animation:"fadeIn 0.3s ease" }}>
      {/* Coverage quality warning */}
      {showCoverageWarn && (
        <div style={{
          padding: "10px 14px", borderRadius: 9,
          background: "rgba(251,191,36,0.07)", border: "1px solid rgba(251,191,36,0.3)",
          display: "flex", alignItems: "center", gap: 10,
          animation: "fadeIn 0.3s ease",
        }}>
          <span style={{ fontSize: 16, flexShrink: 0 }}>⚠️</span>
          <div style={{ flex: 1 }}>
            <span style={{ fontFamily:"var(--sans)", fontWeight:700, fontSize:11, color:"var(--warn)" }}>
              Low coverage — {validPct.toFixed(1)}% valid pixels
            </span>
            <span style={{ fontFamily:"var(--mono)", fontSize:10, color:"var(--muted)", marginLeft: 8 }}>
              ({cloudPct != null ? `${cloudPct.toFixed(1)}% cloud/nodata` : "cloud data unavailable"})
              — results may be incomplete or affected by cloud cover.
            </span>
          </div>
          <button onClick={() => setBannerDismissed(true)} style={{
            background: "transparent", border: "none", color: "var(--muted)",
            cursor: "pointer", fontSize: 14, flexShrink: 0, lineHeight: 1,
          }}>✕</button>
        </div>
      )}

      {!hasData && (
        <div style={{ padding:"9px 13px", borderRadius:8, background:"rgba(251,191,36,0.06)", border:"1px solid rgba(251,191,36,0.2)", fontFamily:"var(--mono)", fontSize:10, color:"var(--warn)", display:"flex", alignItems:"center", gap:7 }}>
          <Icon.Info /> No RPRI histogram found for this job / date
        </div>
      )}

      {/* Stat cards row */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:11 }}>
        {cards.map(c => <StatCard key={c.label} {...c} />)}
      </div>

      {/* Map + stats */}
      <div style={{ display:"flex", flexDirection:"column", gap:14 }}>

        {/* RPRI COG map */}
        <div style={{ background:"var(--panel)", border:"1px solid var(--border)", borderRadius:12, padding:15, animation:"slideInLeft 0.4s ease" }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:11 }}>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <div style={{ width:3, height:13, borderRadius:2, background:"linear-gradient(180deg,#f87171,#fbbf24)" }} />
              <span style={{ fontFamily:"var(--sans)", fontWeight:700, fontSize:13, color:"var(--text)" }}>RPRI Heatmap</span>
              <InfoTooltip
                title="RPRI Heatmap"
                position="right"
                width={300}
                body="RPRI (Remote Pollution Risk Index) is a composite 0–1 score derived from PCA on Sentinel-2 spectral indices using fixed empirical bounds. It combines vegetation health, water quality, moisture content, and bare area indicators. Higher values = greater environmental pollution signature. Scores are cross-date comparable."
                legend={[
                  { color:"#0d0887", label:"0.0 – 0.2 Very Low",   desc:"Deep purple — healthy vegetation, clean water, minimal industrial footprint" },
                  { color:"#7e03a8", label:"0.2 – 0.4 Low",        desc:"Violet — minor stress, agricultural or peri-urban zones" },
                  { color:"#cc4778", label:"0.4 – 0.6 Moderate",   desc:"Pink-red — visible degradation, monitoring recommended" },
                  { color:"#f89441", label:"0.6 – 0.8 High",       desc:"Orange — significant pollution, likely industrial zone" },
                  { color:"#f0f921", label:"≥ 0.8 Critical",       desc:"Bright yellow — severe degradation, urgent action required" },
                ]}
              />
              {hasData && (
                <div style={{ display:"flex", alignItems:"center", gap:4, padding:"2px 7px", background:"var(--accent-dim)", border:"1px solid rgba(0,240,168,0.2)", borderRadius:10 }}>
                  <div style={{ width:5, height:5, borderRadius:"50%", background:"var(--accent)", animation:"pulse-dot 1.5s ease infinite" }} />
                  <span style={{ fontFamily:"var(--mono)", fontSize:8, color:"var(--accent)" }}>REAL DATA</span>
                </div>
              )}
            </div>
            {tifUrl && (
              <a href={tifUrl} target="_blank" rel="noreferrer" style={{ display:"flex", alignItems:"center", gap:5, fontFamily:"var(--mono)", fontSize:9, color:"var(--accent2)", textDecoration:"none", padding:"3px 9px", border:"1px solid var(--border2)", borderRadius:5, transition:"all 0.2s" }}
                onMouseEnter={e=>e.currentTarget.style.background="var(--accent2-dim)"}
                onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                <Icon.Download /> RPRI.tif
              </a>
            )}
          </div>
          <CogLeafletMap jobId={jobId} date={date} layer="RPRI" height={420} label="RPRI · pollution intensity" aoiGeoJSON={aoiGeoJSON} aoiName={aoiName} />
          <div style={{ marginTop:10 }}>
            <RpriColorScale />
          </div>
        </div>

        {/* Stats row */}
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(280px, 1fr))", gap:11, animation:"slideInRight 0.4s ease" }}>

          {/* Histogram */}
          <div style={{ background:"var(--panel)", border:"1px solid var(--border)", borderRadius:12, padding:14 }}>
            <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:10 }}>
              <div style={{ width:3, height:13, borderRadius:2, background:"linear-gradient(180deg,var(--accent2),var(--accent3))" }} />
              <span style={{ fontFamily:"var(--sans)", fontWeight:700, fontSize:12, color:"var(--text)" }}>Distribution</span>
            <InfoTooltip
              title="RPRI Distribution"
              position="left"
              width={260}
              body="The histogram shows how RPRI values are distributed across all valid pixels in the scene. A narrow peak near 0 = predominantly clean area. A spread toward 1 = heterogeneous or degraded landscape. Mean (μ), standard deviation (σ), min and max are shown below the histogram."
            />
            </div>
            <div style={{ background:"var(--surface)", borderRadius:7, padding:"7px 5px 3px" }}>
              {hasData
                ? <MiniHistogram data={rawRpri} gradient={INDEX_META.RPRI.gradient} height={85} />
                : <div style={{ height:85, display:"flex", alignItems:"center", justifyContent:"center" }}>
                    <span style={{ fontFamily:"var(--mono)", fontSize:10, color:"var(--muted2)" }}>no data</span>
                  </div>
              }
            </div>
            {hasData && (
              <div style={{ marginTop:9, display:"flex", flexDirection:"column", gap:5 }}>
                {[["Mean",rawRpri.mean],["Std",rawRpri.std],["Min",rawRpri.min],["Max",rawRpri.max]].map(([l,v],i) => (
                  <div key={l} style={{ display:"flex", justifyContent:"space-between", animation:`fadeIn 0.2s ${i*0.05}s ease both` }}>
                    <span style={{ fontFamily:"var(--mono)", fontSize:10, color:"var(--muted)" }}>{l}</span>
                    <span style={{ fontFamily:"var(--mono)", fontSize:10, color:"var(--text)", fontWeight:700 }}>{(v??0).toFixed(4)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Risk breakdown */}
          <div style={{ background:"var(--panel)", border:"1px solid var(--border)", borderRadius:12, padding:13 }}>
            <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:9 }}>
              <div style={{ width:3, height:13, borderRadius:2, background:"linear-gradient(180deg,var(--warn),var(--danger))" }} />
              <span style={{ fontFamily:"var(--sans)", fontWeight:700, fontSize:12, color:"var(--text)" }}>Risk Breakdown</span>
            <InfoTooltip
              title="Risk Breakdown"
              position="left"
              width={260}
              body="Percentage of the total mapped area falling into each pollution risk class, derived from the RPRI histogram using fixed absolute thresholds. For exact per-class pixel counts, see the Clusters tab."
            />
            </div>
            {PLASMA_RISK_LABELS.map((c,i) => (
              <RiskBar key={c.label} label={c.label} color={c.color} pct={clusterPct[i]} delay={i*110} />
            ))}
          </div>


        </div>
      </div>
    </div>
  );
}
