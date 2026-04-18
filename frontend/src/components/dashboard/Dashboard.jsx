import { useState, useEffect, useCallback } from "react";
import { downloadPdfReport } from "../../utils/pdfReport";
import { Icon } from "../Icons";
import RaqiTab     from "./RaqiTab";
import ClustersTab from "./ClustersTab";
import IndicesTab  from "./IndicesTab";
import TSATab      from "./TSATab";
import { getAoiFallbackName, isPlaceholderAoiName, resolveAoiName } from "../../utils/aoiNaming";


const TABS = [
  { id: "raqi",     label: "RAQI",        icon: null },
  { id: "clusters", label: "Clusters",    icon: null },
  { id: "indices",  label: "Indices",     icon: null },
  { id: "tsa",      label: "Time Series", icon: null },
];

function getAoiName(job) {
  const raw = job?.aoiName;
  if (!isPlaceholderAoiName(raw)) return raw.trim();
  // If we have geometry, show lat/lon hint; otherwise show abbreviated job_id
  if (job?.aoi) return getAoiFallbackName(job.aoi);
  if (job?.job_id) return job.job_id.replace(/^job_/, "").replace(/_/g, " ");
  return "AOI";
}

function JobHistoryPanel({ history, activeJobId, onSelect }) {
  return (
    <div style={{
      width: 220, flexShrink: 0,
      background: "var(--surface)", borderRight: "1px solid var(--border)",
      display: "flex", flexDirection: "column",
      animation: "slideInLeft 0.3s ease",
    }}>
      <div style={{
        padding: "14px 16px 10px",
        borderBottom: "1px solid var(--border)",
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <div style={{ width: 3, height: 14, borderRadius: 2, background: "linear-gradient(180deg, var(--accent), var(--accent2))", flexShrink: 0 }} />
        <span style={{ fontFamily: "var(--sans)", fontWeight: 700, fontSize: 11, color: "var(--text2)", letterSpacing: 1, textTransform: "uppercase" }}>
          Job History
        </span>
        <span style={{
          marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 9,
          padding: "2px 6px", background: "var(--accent-dim)", border: "1px solid rgba(0,240,168,0.2)",
          borderRadius: 10, color: "var(--accent)",
        }}>
          {history.length}
        </span>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
        {history.map((job, i) => {
          const isActive = job.job_id === activeJobId;
          const raqiMean = job.histograms?.RAQI?.mean;
          const raqiColor = raqiMean == null ? "var(--muted)"
            : raqiMean < 0.25 ? "#34d399"
            : raqiMean < 0.5  ? "#fbbf24"
            : raqiMean < 0.75 ? "#fb923c"
            : "#f87171";

          return (
            <button key={job.job_id} onClick={() => onSelect(job)}
              style={{
                padding: "10px 12px", borderRadius: 8, cursor: "pointer", textAlign: "left",
                border: isActive ? "1px solid var(--accent)" : "1px solid var(--border)",
                background: isActive ? "var(--accent-dim)" : "transparent",
                transition: "all 0.15s",
                animation: `fadeIn ${0.1 + i * 0.05}s ease`,
              }}
              onMouseEnter={e => { if (!isActive) { e.currentTarget.style.background = "var(--panel2)"; e.currentTarget.style.borderColor = "var(--border2)"; }}}
              onMouseLeave={e => { if (!isActive) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "var(--border)"; }}}
            >
              {i === 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 5 }}>
                  <div style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent)", boxShadow: "0 0 5px var(--accent)", animation: "pulse-dot 1.5s ease infinite" }} />
                  <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--accent)", letterSpacing: 0.5 }}>LATEST</span>
                </div>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
                <span style={{ fontSize: 9, flexShrink: 0 }}>📍</span>
                <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: isActive ? "var(--accent)" : "var(--text2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>
                  {getAoiName(job)}
                </div>
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--muted2)", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {job.job_id}
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", marginBottom: 4 }}>
                {job.startDate} → {job.endDate}
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)" }}>
                  {job.dates?.length ?? 0} scene{job.dates?.length !== 1 ? "s" : ""}
                </span>
                {raqiMean != null && (
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: raqiColor, boxShadow: `0 0 5px ${raqiColor}` }} />
                    <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: raqiColor }}>{raqiMean.toFixed(3)}</span>
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function Dashboard({ results, history, jobId, onExit, onChangeDate }) {
  const [activeTab,     setActiveTab]     = useState("raqi");
  const [activeJob,     setActiveJob]     = useState(null);
  const [loadingDate,   setLoadingDate]   = useState(false);
  const [showHistory,   setShowHistory]   = useState(history.length > 1);
  const [pdfLoading,    setPdfLoading]    = useState(false);
  const [resolvedNames, setResolvedNames] = useState({});

  // On mount or when new results arrive, show the latest job
  useEffect(() => {
    if (results) setActiveJob(results);
  }, [results]);

  useEffect(() => {
    let cancelled = false;

    // Jobs with no aoiName yet — split into geocodable (have aoi) and not
    const needsName = history.filter(
      (job) => isPlaceholderAoiName(job?.aoiName) && !resolvedNames[job.job_id]
    );
    if (!needsName.length) return undefined;

    const withGeo    = needsName.filter((job) => job?.aoi);
    const withoutGeo = needsName.filter((job) => !job?.aoi);

    // For jobs with no geometry, immediately assign a readable name from job_id
    if (withoutGeo.length) {
      setResolvedNames((prev) => {
        const next = { ...prev };
        for (const job of withoutGeo) {
          next[job.job_id] = job.job_id.replace(/^job_/, "").replace(/_/g, " ");
        }
        return next;
      });
    }

    // For jobs with geometry, reverse-geocode asynchronously
    if (!withGeo.length) return undefined;
    Promise.all(
      withGeo.map(async (job) => [job.job_id, await resolveAoiName(job.aoi)]),
    ).then((entries) => {
      if (cancelled) return;
      setResolvedNames((prev) => {
        const next = { ...prev };
        for (const [jobKey, name] of entries) next[jobKey] = name;
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [history, resolvedNames]);

  // displayJob must be declared BEFORE any callback that references it
  const displayJob  = activeJob ?? results;

  const handleDownloadPdf = useCallback(async () => {
    if (!displayJob) return;
    setPdfLoading(true);
    try {
      await downloadPdfReport(displayJob);
    } catch (e) {
      console.error("PDF error:", e);
    } finally {
      setPdfLoading(false);
    }
  }, [displayJob]);
  const dates       = displayJob?.dates ?? [];
  const activeDate  = displayJob?.date  ?? null;
  const activeJobId = displayJob?.job_id ?? null;
  const activeAoiName = displayJob
    ? (!isPlaceholderAoiName(displayJob.aoiName)
        ? displayJob.aoiName
        : (resolvedNames[displayJob.job_id] || getAoiName(displayJob)))
    : "AOI";

  const handleDateChange = async (newDate) => {
    if (!displayJob || !newDate) return;
    setLoadingDate(true);
    // If already cached locally, switch instantly without a network call
    const cached = displayJob.histogramsByDate?.[newDate];
    if (cached) {
      setActiveJob(prev => ({
        ...(prev ?? displayJob),
        date: newDate,
        histograms: cached,
      }));
      setLoadingDate(false);
      return;
    }
    // Fetch from backend; onChangeDate updates history in the hook
    await onChangeDate?.(newDate, displayJob.job_id);
    // Mirror the updated entry back into activeJob
    setActiveJob(prev => {
      if (!prev) return prev;
      const updated = history.find(j => j.job_id === prev.job_id) ??
                      (results?.job_id === prev.job_id ? results : prev);
      return { ...updated, date: newDate };
    });
    setLoadingDate(false);
  };

  const handleSelectJob = (job) => {
    setActiveJob({ ...job });
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "var(--bg)", zIndex: 100,
      display: "flex", flexDirection: "column",
      animation: "gradIn 0.3s ease",
    }}>
      {/* Top bar */}
      <div style={{
        height: 54, background: "var(--surface)", borderBottom: "1px solid var(--border)",
        display: "flex", alignItems: "center", padding: "0 18px", gap: 12, flexShrink: 0,
        position: "relative", overflow: "hidden",
      }}>
        {/* Animated accent line */}
        <div style={{
          position: "absolute", top: 0, left: 0, right: 0, height: 1,
          background: "linear-gradient(90deg, transparent 0%, var(--accent) 30%, var(--accent2) 70%, transparent 100%)",
          backgroundSize: "200% 100%",
          animation: "border-flow 4s linear infinite",
          opacity: 0.7,
        }} />

        {/* Logo + title */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <AnimatedOrb />
          <span style={{ fontFamily: "var(--sans)", fontWeight: 800, fontSize: 14, color: "var(--text)" }}>
            EPM Analysis Dashboard
          </span>
        </div>

        {/* History toggle */}
        {history.length > 0 && (
          <button onClick={() => setShowHistory(h => !h)} style={{
            padding: "4px 10px", borderRadius: 6,
            border: "1px solid " + (showHistory ? "var(--accent)" : "var(--border2)"),
            background: showHistory ? "var(--accent-dim)" : "transparent",
            color: showHistory ? "var(--accent)" : "var(--muted)",
            fontFamily: "var(--mono)", fontSize: 10, cursor: "pointer",
            display: "flex", alignItems: "center", gap: 5, transition: "all 0.2s",
          }}>
            <Icon.Layers /> History ({history.length})
          </button>
        )}

        {/* Active AOI badge (job id secondary) */}
        {activeJobId && (
          <div style={{
            padding: "3px 10px", background: "var(--panel)", border: "1px solid var(--border)",
            borderRadius: 6, fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)",
            maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {activeAoiName}
            <span style={{ color: "var(--muted2)" }}> · {activeJobId}</span>
          </div>
        )}

        {/* Date selector */}
        {dates.length > 1 && (
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", letterSpacing: 0.5 }}>DATE</span>
            <select value={activeDate ?? ""} onChange={e => handleDateChange(e.target.value)} disabled={loadingDate}
              style={{
                background: "var(--panel)", border: "1px solid var(--border2)",
                borderRadius: 7, color: "var(--text)", fontFamily: "var(--mono)",
                fontSize: 11, padding: "4px 10px", cursor: "pointer", outline: "none",
              }}>
              {dates.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
            {loadingDate && <Icon.Loader />}
          </div>
        )}
        {dates.length === 1 && activeDate && (
          <div style={{
            padding: "3px 10px", background: "var(--accent-dim)",
            border: "1px solid rgba(0,240,168,0.2)", borderRadius: 6,
            fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent)",
          }}>
            {activeDate}
          </div>
        )}

        {/* Tabs */}
        <div style={{ marginLeft: "auto", display: "flex", gap: 3 }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
              fontFamily: "var(--mono)", fontSize: 11, padding: "5px 14px", borderRadius: 6,
              border: "1px solid " + (activeTab === t.id ? "var(--accent)" : "var(--border)"),
              background: activeTab === t.id ? "var(--accent-dim)" : "transparent",
              color: activeTab === t.id ? "var(--accent)" : "var(--muted)",
              cursor: "pointer", transition: "all 0.2s", textTransform: "uppercase", letterSpacing: "0.05em",
            }}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Body row */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* History sidebar */}
        {showHistory && history.length > 0 && (
          <JobHistoryPanel
            history={history.map((job) => ({
              ...job,
              aoiName: !isPlaceholderAoiName(job.aoiName)
                ? job.aoiName
                : (resolvedNames[job.job_id] || null),
            }))}
            activeJobId={activeJobId}
            onSelect={handleSelectJob}
          />
        )}

        {/* Tab content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "18px 20px" }}>
          {!displayJob ? (
            <EmptyDashboard />
          ) : (
            <>
              {activeTab === "raqi"     && <RaqiTab     results={displayJob} key={displayJob.job_id + activeTab} />}
              {activeTab === "clusters" && <ClustersTab results={displayJob} key={displayJob.job_id + activeTab} />}
              {activeTab === "indices"  && <IndicesTab  results={displayJob} key={displayJob.job_id + activeTab} />}
              {activeTab === "tsa"      && <TSATab      results={displayJob} history={history} key={displayJob.job_id + activeTab} />}
            </>
          )}
        </div>
      </div>

      {/* Footer */}
      <div style={{
        height: 50, background: "var(--surface)", borderTop: "1px solid var(--border)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 18px", flexShrink: 0,
      }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)" }}>
          {history.length} job{history.length !== 1 ? "s" : ""} · {activeDate ? `scene: ${activeDate}` : "no date selected"}
          {dates.length > 1 && ` · ${dates.length} scenes`}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {/* Download PDF report */}
          {displayJob && (
            <button onClick={handleDownloadPdf} disabled={pdfLoading} style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "7px 14px", borderRadius: 7, cursor: pdfLoading ? "wait" : "pointer",
              border: "1px solid var(--accent2)", background: "transparent",
              color: pdfLoading ? "var(--muted)" : "var(--accent2)",
              fontFamily: "var(--mono)", fontSize: 11, transition: "all 0.2s",
            }}
              onMouseEnter={e => { if (!pdfLoading) e.currentTarget.style.background = "var(--accent2-dim)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
            >
              {pdfLoading
                ? <><Icon.Loader /> Generating PDF…</>
                : <><Icon.Download /> Download Report</>
              }
            </button>
          )}

          <button onClick={onExit} style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "7px 14px", borderRadius: 7, cursor: "pointer",
            border: "1px solid var(--border2)", background: "transparent",
            color: "var(--text2)", fontFamily: "var(--mono)", fontSize: 11,
            transition: "all 0.2s",
          }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--danger)"; e.currentTarget.style.color = "var(--danger)"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border2)"; e.currentTarget.style.color = "var(--text2)"; }}
          >
            <Icon.Exit /> Exit Dashboard
          </button>
        </div>
      </div>
    </div>
  );
}

function AnimatedOrb() {
  return (
    <div style={{ position: "relative", width: 24, height: 24, flexShrink: 0 }}>
      <div style={{
        width: 10, height: 10, borderRadius: "50%", background: "var(--accent)",
        boxShadow: "0 0 12px rgba(0,240,168,0.7), 0 0 24px rgba(0,240,168,0.3)",
        position: "absolute", top: 7, left: 7, zIndex: 2,
        animation: "pulse-dot 2s ease infinite",
      }} />
      <div style={{
        width: 24, height: 24, borderRadius: "50%",
        border: "1.5px solid rgba(0,240,168,0.4)",
        position: "absolute", top: 0, left: 0,
        animation: "pulse-ring 2.5s ease-out infinite",
      }} />
      {/* Orbiting dot */}
      <div style={{
        position: "absolute", top: "50%", left: "50%",
        width: 4, height: 4, borderRadius: "50%",
        background: "var(--accent2)", marginTop: -2, marginLeft: -2,
        "--r": "10px",
        animation: "orbit 3s linear infinite",
        boxShadow: "0 0 4px var(--accent2)",
      }} />
    </div>
  );
}

function EmptyDashboard() {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      height: "100%", gap: 16, opacity: 0.5,
      animation: "fadeIn 0.5s ease",
    }}>
      <div style={{ position: "relative", width: 80, height: 80 }}>
        <div style={{
          width: 60, height: 60, borderRadius: "50%",
          border: "2px solid var(--border2)",
          position: "absolute", top: 10, left: 10,
          animation: "spin-slow 8s linear infinite",
          borderTopColor: "var(--accent)",
        }} />
        <div style={{
          position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
          color: "var(--muted)",
        }}>
          <Icon.Chart />
        </div>
      </div>
      <div style={{ fontFamily: "var(--sans)", fontWeight: 700, fontSize: 14, color: "var(--muted)" }}>
        No results yet
      </div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted2)", textAlign: "center" }}>
        Run a pipeline to generate<br />RAQI heatmaps and indices
      </div>
    </div>
  );
}
