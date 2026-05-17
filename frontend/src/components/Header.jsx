import { Icon } from "./Icons";

const STATUS = {
  idle:    { color: "var(--muted)",   label: "IDLE",       pulse: false },
  running: { color: "var(--warn)",    label: "PROCESSING", pulse: true  },
  done:    { color: "var(--accent)",  label: "COMPLETE",   pulse: false },
  error:   { color: "var(--danger)",  label: "ERROR",      pulse: false },
};

export default function Header({ status, jobCount = 0, mapType, setMapType }) {
  const cfg = STATUS[status] ?? STATUS.idle;

  return (
    <header style={{
      height: 54, background: "var(--surface)", borderBottom: "1px solid var(--border)",
      display: "flex", alignItems: "center", padding: "0 20px", gap: 14, flexShrink: 0,
      position: "relative", overflow: "hidden",
    }}>
      {/* Animated top accent line */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 1,
        background: "linear-gradient(90deg, transparent 0%, var(--accent) 35%, var(--accent2) 65%, transparent 100%)",
        backgroundSize: "200% 100%",
        animation: "border-flow 5s linear infinite",
        opacity: 0.55,
      }} />

      {/* Radar logo */}
      <div style={{ position: "relative", width: 32, height: 32, flexShrink: 0 }}>
        <svg width="32" height="32" viewBox="0 0 32 32" style={{ display: "block" }}>
          {/* Concentric radar rings */}
          <circle cx="16" cy="16" r="14" fill="none" stroke="rgba(0,240,168,0.12)" strokeWidth="1" />
          <circle cx="16" cy="16" r="9"  fill="none" stroke="rgba(0,240,168,0.18)" strokeWidth="1" />
          <circle cx="16" cy="16" r="4"  fill="none" stroke="rgba(0,240,168,0.3)"  strokeWidth="1" />
          {/* Cross hairs */}
          <line x1="16" y1="2"  x2="16" y2="30" stroke="rgba(0,240,168,0.10)" strokeWidth="0.5" />
          <line x1="2"  y1="16" x2="30" y2="16" stroke="rgba(0,240,168,0.10)" strokeWidth="0.5" />
          {/* Radar sweep — conic gradient wedge as rotating group */}
          <g style={{ transformOrigin: "16px 16px", animation: "radar-sweep 3s linear infinite" }}>
            <path d="M16,16 L16,2 A14,14 0 0,1 25.9,21.5 Z"
              fill="url(#radarGrad)" opacity="0.55" />
          </g>
          {/* Centre dot */}
          <circle cx="16" cy="16" r="2.2" fill="var(--accent)" style={{ filter: "drop-shadow(0 0 4px rgba(0,240,168,0.9))" }} />
          {/* Blip */}
          <circle cx="22" cy="10" r="1.5" fill="var(--accent)" opacity="0.9">
            <animate attributeName="opacity" values="0.9;0.2;0.9" dur="2.1s" repeatCount="indefinite" />
          </circle>
          <defs>
            <radialGradient id="radarGrad" cx="50%" cy="50%" r="50%">
              <stop offset="0%"   stopColor="#00f0a8" stopOpacity="0.5" />
              <stop offset="100%" stopColor="#00f0a8" stopOpacity="0" />
            </radialGradient>
          </defs>
        </svg>
        {/* Outer ping ring */}
        <div style={{
          position: "absolute", inset: -3, borderRadius: "50%",
          border: "1px solid rgba(0,240,168,0.2)",
          animation: "sat-ping 3s ease-out infinite",
        }} />
      </div>

      <div>
        <div style={{ fontFamily: "var(--sans)", fontWeight: 800, fontSize: 14, color: "var(--text)", letterSpacing: 0.3, lineHeight: 1 }}>
          Environmental Pollution Monitor
        </div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", letterSpacing: 1, marginTop: 2 }}>
          SENTINEL-2 L2A · EPM v1.0
        </div>
      </div>

      <div style={{ width: 1, height: 28, background: "var(--border)", flexShrink: 0 }} />

      {/* Info chips */}
      {[
        { icon: <Icon.Satellite />, text: "Sentinel-2", delay: "0s" },
        { icon: <Icon.Layers />,   text: "10 Bands",   delay: "0.7s" },
        { icon: <Icon.Grid />,     text: "10m · 60m",  delay: "1.4s" },
      ].map(({ icon, text, delay }) => (
        <div key={text} style={{
          display: "flex", alignItems: "center", gap: 5,
          padding: "3px 10px", borderRadius: 20,
          background: "var(--panel)", border: "1px solid var(--border)",
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)",
          animation: `data-float 4s ${delay} ease-in-out infinite`,
        }}>
          {icon} {text}
        </div>
      ))}

      {/* Job count badge */}
      {jobCount > 0 && (
        <div style={{
          display: "flex", alignItems: "center", gap: 5,
          padding: "3px 10px", borderRadius: 20,
          background: "var(--accent-dim)", border: "1px solid rgba(0,240,168,0.2)",
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent)",
          animation: "fadeIn 0.3s ease",
        }}>
          <Icon.Check /> {jobCount} job{jobCount !== 1 ? "s" : ""} complete
        </div>
      )}

      {/* Map Switch Button */}
      {setMapType && (
        <div style={{
          display: "flex", background: "var(--panel)", borderRadius: 20, 
          border: "1px solid var(--border)", overflow: "hidden", marginLeft: "auto"
        }}>
          <button 
            onClick={() => setMapType("satellite")}
            style={{ 
              padding: "4px 10px", background: mapType === "satellite" ? "var(--surface)" : "transparent",
              border: "none", color: mapType === "satellite" ? "var(--text)" : "var(--muted)",
              fontFamily: "var(--mono)", fontSize: 10, cursor: "pointer", transition: "all 0.2s",
              display: "flex", alignItems: "center", gap: 4
            }}
          >🛰️ Sat</button>
          <button 
            onClick={() => setMapType("political")}
            style={{ 
              padding: "4px 10px", background: mapType === "political" ? "var(--surface)" : "transparent",
              border: "none", color: mapType === "political" ? "var(--text)" : "var(--muted)",
              fontFamily: "var(--mono)", fontSize: 10, cursor: "pointer", transition: "all 0.2s",
              display: "flex", alignItems: "center", gap: 4
            }}
          >🗺️ Pol</button>
        </div>
      )}

      {/* Status */}
      <div style={{ marginLeft: setMapType ? 0 : "auto", display: "flex", alignItems: "center", gap: 7 }}>
        <div style={{
          width: 7, height: 7, borderRadius: "50%",
          background: cfg.color,
          boxShadow: cfg.pulse ? `0 0 10px ${cfg.color}` : "none",
          animation: cfg.pulse ? "pulse-dot 0.8s ease infinite" : "none",
        }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: cfg.color, letterSpacing: 1 }}>
          {cfg.label}
        </span>
      </div>
    </header>
  );
}
