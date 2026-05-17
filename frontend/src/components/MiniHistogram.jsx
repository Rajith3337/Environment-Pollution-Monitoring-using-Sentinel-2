export default function MiniHistogram({ data, color = "#00f0a8", gradient = null, height = 80 }) {
  const freq = data?.frequency ?? data?.freq ?? [];
  if (!freq.length) return (
    <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted2)" }}>no histogram data</span>
    </div>
  );

  const maxF = Math.max(...freq, 1);
  const w    = 100 / freq.length;
  
  const gradId = gradient ? "grad-" + gradient.map(c => c.replace("#","")).join("") : null;

  return (
    <svg viewBox={`0 0 100 ${height}`} width="100%" height={height}
      preserveAspectRatio="none" style={{ display: "block" }}>
      {gradient && (
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="100" y2="0" gradientUnits="userSpaceOnUse">
            {gradient.map((c, i) => (
              <stop key={i} offset={`${(i / (gradient.length - 1)) * 100}%`} stopColor={c} />
            ))}
          </linearGradient>
        </defs>
      )}
      {[0.25, 0.5, 0.75].map(v => (
        <line key={v} x1={0} y1={height*(1-v)} x2={100} y2={height*(1-v)}
          stroke="rgba(255,255,255,0.04)" strokeWidth={0.5} />
      ))}
      {freq.map((f, i) => {
        const barH  = (f / maxF) * (height - 2);
        // High base opacity so the beautiful gradient hues are fully visible
        const alpha = 0.85;
        return (
          <rect key={i}
            x={i * w + 0.2} y={height - barH}
            width={Math.max(w - 0.6, 0.4)} height={barH}
            fill={gradient ? `url(#${gradId})` : color} opacity={alpha} rx={0.4} />
        );
      })}
      <line x1={0} y1={height} x2={100} y2={height}
        stroke="rgba(255,255,255,0.07)" strokeWidth={0.5} />
    </svg>
  );
}
