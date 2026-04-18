import { Icon } from "./Icons";

function DateInput({ label, value, onChange }) {
  return (
    <div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", marginBottom: 4, letterSpacing: 0.5 }}>
        {label.toUpperCase()}
      </div>
      <input
        type="date" value={value} onChange={e => onChange(e.target.value)}
        style={{
          width: "100%", padding: "8px 8px",
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: 8, color: "var(--text)",
          fontFamily: "var(--mono)", fontSize: 10.5,
          outline: "none", cursor: "pointer",
          colorScheme: "dark", transition: "border-color 0.2s",
        }}
        onFocus={e => e.target.style.borderColor = "var(--accent)"}
        onBlur={e => e.target.style.borderColor = "var(--border)"}
      />
    </div>
  );
}

export default function AOIPanel({
  startDate, setStartDate, endDate, setEndDate,
  kmlFile, onKmlUpload, fileInputRef,
  hasPolygon, aoiName, status, onStart, onClear,
}) {

  return (
    <div style={{
      background: "var(--panel)",
      border: "1px solid var(--border)",
      borderRadius: 12, padding: 14,
      display: "flex", flexDirection: "column", gap: 16,
    }}>
      {/* Section header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 3, height: 16, borderRadius: 2, background: "linear-gradient(180deg, var(--accent), var(--accent2))" }} />
        <span style={{ fontFamily: "var(--sans)", fontWeight: 700, fontSize: 12, color: "var(--text2)", letterSpacing: 1, textTransform: "uppercase" }}>
          AOI Selection
        </span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, padding: "2px 7px", background: "rgba(0,240,168,0.07)", border: "1px solid rgba(0,240,168,0.18)", borderRadius: 6 }}>
          <div style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent)" }} />
          <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--accent)" }}>SCL CLOUD MASK</span>
        </div>
      </div>

      {/* Date Range */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 10 }}>
          <Icon.Calendar />
          <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", letterSpacing: 0.5 }}>DATE RANGE</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <DateInput label="Start" value={startDate} onChange={setStartDate} />
          <DateInput label="End"   value={endDate}   onChange={setEndDate}   />
        </div>
      </div>

      {/* KML Upload */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 8 }}>
          <Icon.Map />
          <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", letterSpacing: 0.5 }}>AREA OF INTEREST</span>
        </div>

        <input
          ref={fileInputRef}
          type="file" accept=".kml,.geojson,.json"
          onChange={onKmlUpload} style={{ display: "none" }}
        />

        <button
          onClick={() => fileInputRef?.current?.click()}
          style={{
            width: "100%", padding: "11px 12px", borderRadius: 8, cursor: "pointer",
            border: "1px dashed " + (kmlFile ? "var(--accent)" : "var(--border2)"),
            background: kmlFile ? "var(--accent-dim)" : "rgba(255,255,255,0.02)",
            color: kmlFile ? "var(--accent)" : "var(--muted)",
            fontFamily: "var(--mono)", fontSize: 11,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            transition: "all 0.2s",
          }}
        >
          <span style={{ display:"flex", animation: kmlFile ? "none" : "drift 3.5s ease infinite" }}>
            <Icon.Upload />
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {kmlFile ? kmlFile.name : "Upload KML / GeoJSON"}
          </span>
        </button>

        {hasPolygon && (
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "8px 10px", marginTop: 8,
            background: "var(--accent-dim)",
            border: "1px solid rgba(0,240,168,0.2)",
            borderRadius: 8,
          }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", flexShrink: 0, boxShadow: "0 0 6px var(--accent)" }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {aoiName || "AOI defined on map"}
              </div>
              {aoiName && (
                <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--muted)", marginTop: 1 }}>
                  AOI location resolved
                </div>
              )}
            </div>
            <div style={{ marginLeft: "auto", flexShrink: 0 }}>
              <Icon.Check />
            </div>
          </div>
        )}

        {!hasPolygon && (
          <div style={{
            display: "flex", alignItems: "center", gap: 6, marginTop: 8,
            fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)",
          }}>
            <Icon.Polygon />
            Or draw a polygon on the map
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
        <button
          onClick={onStart} disabled={status === "running"}
          style={{
            padding: "10px 0", borderRadius: 8,
            cursor: status === "running" ? "not-allowed" : "pointer",
            border: "none",
            background: status === "running"
              ? "rgba(0,240,168,0.2)"
              : "linear-gradient(135deg, var(--accent), #00c88a)",
            color: status === "running" ? "var(--accent)" : "#000",
            fontFamily: "var(--mono)", fontSize: 12, fontWeight: 700,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
            boxShadow: status === "running" ? "none" : "0 0 16px rgba(0,240,168,0.25)",
            transition: "all 0.2s",
            letterSpacing: 0.3,
          }}
        >
          {status === "running" ? <><Icon.Loader /> Running…</> : <><Icon.Play /> Run Pipeline</>}
        </button>

        <button
          onClick={onClear}
          title="Clear"
          style={{
            padding: "10px 14px", borderRadius: 8, cursor: "pointer",
            border: "1px solid var(--border2)", background: "transparent",
            color: "var(--muted)", display: "flex", alignItems: "center",
            justifyContent: "center", transition: "all 0.2s",
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--danger)"; e.currentTarget.style.color = "var(--danger)"; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border2)"; e.currentTarget.style.color = "var(--muted)"; }}
        >
          <Icon.Trash />
        </button>
      </div>
    </div>
  );
}
