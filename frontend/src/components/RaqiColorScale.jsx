/**
 * RaqiColorScale
 * ──────────────
 * Matches the `plasma` matplotlib colormap used by the tile server.
 * Labels reflect the fixed absolute thresholds used by the backend:
 *   < 0.43  Very Low  · 0.43–0.46 Low · 0.46–0.49 Moderate
 *   0.49–0.53 High    · ≥ 0.53 Critical
 */
const STOPS = [
  { pct: 0,   color: "#0d0887", label: "0.0",  desc: "Clean"    },
  { pct: 43,  color: "#7e03a8", label: "0.43", desc: "Low"      },
  { pct: 49,  color: "#cc4778", label: "0.49", desc: "Moderate" },
  { pct: 53,  color: "#f89441", label: "0.53", desc: "High"     },
  { pct: 100, color: "#f0f921", label: "1.0",  desc: "Critical" },
];

export const PLASMA_STOPS = STOPS;   // re-exported so other components can import

export default function RaqiColorScale({ showLabels = true }) {
  const gradient = `linear-gradient(to right, ${STOPS.map(s => `${s.color} ${s.pct}%`).join(", ")})`;
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ height: 10, borderRadius: 5, background: gradient, boxShadow: "0 0 12px rgba(0,0,0,0.3)" }} />
      {showLabels && (
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5 }}>
          {STOPS.map(s => (
            <div key={s.label} style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: s.color }}>{s.label}</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--muted)" }}>{s.desc}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
