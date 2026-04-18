import { useState, useRef, useCallback, useEffect } from "react";
import { prepareJob, startJob, pollJobStatus, getJobDates, getHistograms, streamJobLogs, getAllJobs, cancelJob, deleteJob } from "../utils/api";
import { PIPELINE_STEPS } from "../data/mockData";
import { isPlaceholderAoiName, resolveAoiName } from "../utils/aoiNaming";

const STEP_IDS = PIPELINE_STEPS.map(s => s.id);
const PER_DATE_STEPS = ["download", "mosaic", "indices", "raqi", "cluster", "cog"];

// ─────────────────────────────────────────────────────────────────────────────
// STEP_KEYWORDS  — must be SPECIFIC strings that only appear in one step's logs.
// Never use single words like "done", "date", "complete" — they match everything.
// ─────────────────────────────────────────────────────────────────────────────
const STEP_KEYWORDS = {
  stac:     ["[stac]", "querying stac catalog", "stac done", "unique dates:", "scenes="],
  download: ["[tile]", "[tiles]", "parallel tile download", "↓ red", "↓ nir",
             "↓ green", "↓ blue", "↓ swir", "↓ scl", "↓ rededge",
             "cloud fraction:", "[cloud]", "tiles done"],
  mosaic:   ["[mosaic]", "building max-ndvi mosaic", "mosaic done",
             "no-coverage pixels:", "grid:"],
  indices:  ["[indices]", "computing spectral indices", "index tifs written",
             "ndvi:", "ndre:", "savi:", "evi:", "ndmi:", "ndwi:", "mndwi:",
             "nbr:", "ndti:", "ndbai:"],
  raqi:     ["[raqi]", "computing raqi", "raqi done", "raqi written"],
  cluster:  ["[cluster]", "5-class kmeans", "kmeans fit done", "clustering done",
             "running fixed absolute thresholds", "cluster 0:", "cluster 1:",
             "cluster tif written"],
  cog:      ["[cog]", "[write]", "[hist]", "cog conversion", "cog done", "writing output rasters",
             "completed write", "histograms.json saved", "successfully converted and replaced"],
};

// DONE_KEYWORDS — specific completion lines only, one per step
const DONE_KEYWORDS = {
  stac:     ["stac done", "unique dates:"],
  download: ["tiles done"],
  mosaic:   ["mosaic done"],
  indices:  ["index tifs written"],
  raqi:     ["raqi written", "raqi done"],
  cluster:  ["cluster tif written", "clustering done"],
  cog:      ["cog done", "histograms.json saved"],
};

function inferStep(line) {
  const l = line.toLowerCase();
  for (const [id, kws] of Object.entries(STEP_KEYWORDS)) {
    if (kws.some(k => l.includes(k))) return id;
  }
  return null;
}

function lineType(line) {
  const l = line.toLowerCase();
  if (l.includes("error") || l.includes("exception") || l.includes("failed") ||
      l.includes("traceback")) return "error";
  if (l.includes("too cloudy") || l.includes("skipping") || l.includes("warn")) return "warn";
  if (l.includes("done") || l.includes("written") || l.includes("saved") ||
      l.includes("complete") || l.includes("success") || l.includes("✓")) return "success";
  return "info";
}

function cleanLine(raw) {
  return raw.replace(/^\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\]\s*/, "").trim();
}

function extractStage(line) {
  const m = line.match(/^\[([^\]]+)\]\s*/);
  return m?.[1] ?? null;
}

function stripStage(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
export function usePipeline() {
  const [status,       setStatus]       = useState("idle");
  const [steps,        setSteps]        = useState({});
  const [logs,         setLogs]         = useState([]);
  const [results,      setResults]      = useState(null);
  const [history,      setHistory]      = useState([]);
  const [jobId,        setJobId]        = useState(null);
  const [liveStep,     setLiveStep]     = useState(null);
  const [dateProgress, setDateProgress] = useState(null);
  const [cancelling,   setCancelling]   = useState(false);

  const runningRef  = useRef(false);
  const sseCloseRef = useRef(null);

  const addLog = useCallback((msg, type = "info", stage = null) => {
    const time = new Date().toLocaleTimeString("en-US", {
      hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    setLogs(prev => [...prev, { time, msg, type, stage }]);
  }, []);

  const reset = useCallback(() => {
    sseCloseRef.current?.();
    runningRef.current = false;
    setStatus("idle");
    setSteps({});
    setLogs([]);
    setLiveStep(null);
    setDateProgress(null);
    setJobId(null);
    setCancelling(false);
  }, []);

  // ── Shared hydration helper — build a result object from a DB job row ───────
  const hydrateJob = useCallback(async (j) => {
    const dr = await getJobDates(j.id);
    const dates = dr.dates || [];
    if (!dates.length) return null;

    // Fetch ALL dates in parallel so histogramsByDate is fully populated
    const histogramsByDate = {};
    await Promise.all(
      dates.map(async (d) => {
        try { histogramsByDate[d] = await getHistograms(j.id, d); } catch { /* skip */ }
      })
    );

    const latestDate = dates[0];
    // Derive date range from actual scene dates when DB fields are null
    // (auto-registered disk jobs have no start_date / end_date in the DB)
    const sortedDates = [...dates].sort();
    const derivedStart = j.start_date || sortedDates[0] || null;
    const derivedEnd   = j.end_date   || sortedDates[sortedDates.length - 1] || null;
    return {
      mock: false,
      job_id: j.id,
      aoiName: j.aoi_name ?? null,
      dates,
      date: latestDate,
      histograms: histogramsByDate[latestDate] ?? null,
      histogramsByDate,
      aoi: typeof j.aoi === "string" ? JSON.parse(j.aoi) : j.aoi,
      startDate: derivedStart,
      endDate: derivedEnd,
    };
  }, []);

  // ── Refresh history from backend (callable any time) ─────────────────────
  const refreshHistory = useCallback(async () => {
    try {
      const { jobs } = await getAllJobs();
      if (!jobs || jobs.length === 0) return;

      const hydrated = (
        await Promise.all(
          jobs
            .filter(j => j.status === "done")
            .map(j => hydrateJob(j).catch(e => {
              console.warn("Failed to hydrate job", j.id, e);
              return null;
            }))
        )
      ).filter(Boolean);

      if (hydrated.length > 0) {
        setHistory(hydrated);
        // Only set results if we don't already have a live result
        setResults(prev => prev ?? hydrated[0]);
      }
    } catch (err) {
      console.error("Failed to load jobs from backend:", err);
    }
  }, [hydrateJob]);

  // Hydrate on mount
  useEffect(() => {
    refreshHistory();
    return () => { sseCloseRef.current?.(); };
  }, [refreshHistory]);

  // ── handleLogLine — called for every raw SSE line ──────────────────────────
  const handleLogLine = useCallback((rawLine) => {
    if (!rawLine?.trim()) return;
    const clean = cleanLine(rawLine);
    if (!clean) return;

    // DATE_PROGRESS internal tag — "[DATE_PROGRESS] 2/3"
    const dateMatch = clean.match(/\[DATE_PROGRESS\]\s*(\d+)\/(\d+)/i);
    if (dateMatch) {
      const cur   = parseInt(dateMatch[1], 10);
      const total = parseInt(dateMatch[2], 10);
      setDateProgress({ current: cur, total });
      // stac ran once before the date loop — keep it done.
      // Clear all per-date steps so ticks disappear for the new date.
      setSteps({ stac: "done" });
      setLiveStep(null);
      if (cur > 1) addLog(`── Date ${cur}/${total}: step tracker reset ──`, "info");
      else         addLog(`── Date ${cur}/${total} ──`, "info");
      return;
    }

    // Display line — strip bracket-tag prefix for cleaner terminal output
    const stage = extractStage(clean);
    const display = stripStage(clean);
    const lType   = lineType(clean);

    if (display.toLowerCase().includes("skipping date") ||
        (display.toLowerCase().includes("all tiles") && display.toLowerCase().includes("cloudy"))) {
      addLog("⚠ Scene too cloudy — date skipped by cloud mask", "warn");
    } else {
      addLog(display || clean, lType, stage);
    }

    // ── Advance step tracker ─────────────────────────────────────────────────
    // infer which step this log line belongs to
    const inferred = inferStep(clean);

    if (inferred) {
      // Mark THIS step as running — NEVER auto-advance prior steps from here.
      // Prior steps are only marked done by DONE_KEYWORDS.
      setSteps(prev => {
        if (prev[inferred] === "done") return prev; // never regress a done step
        return { ...prev, [inferred]: "running" };
      });
      setLiveStep(inferred);
    }

    // Mark a step DONE when we see its specific completion line
    const l = clean.toLowerCase();
    for (const [id, kws] of Object.entries(DONE_KEYWORDS)) {
      if (kws.some(k => l.includes(k))) {
        setSteps(prev => {
          if (prev[id] === "done") return prev;
          return { ...prev, [id]: "done" };
        });
        // If that step was the live step, clear it
        setLiveStep(prev => prev === id ? null : prev);
        break;
      }
    }
  }, [addLog]);

  // ─────────────────────────────────────────────────────────────────────────
  const runPipeline = useCallback(async ({ aoi, aoiName, startDate, endDate }) => {
    let resolvedAoiName = aoiName ?? null;
    if (aoi && isPlaceholderAoiName(resolvedAoiName)) {
      addLog("Resolving AOI location name...", "info");
      resolvedAoiName = await resolveAoiName(aoi);
      addLog(`AOI resolved: ${resolvedAoiName}`, "success");
    }

    addLog(`EPM job — ${startDate} → ${endDate}`, "info");

    // Step 1: get provisional ID so SSE can open before blocking POST
    let provisionalId;
    try {
      const r = await prepareJob();
      provisionalId = r.job_id;
    } catch {
      addLog("Note: live step tracking requires updated backend", "warn");
      provisionalId = null;
    }

    if (provisionalId) {
      setJobId(provisionalId);
      setSteps({ stac: "running" });
      setLiveStep("stac");
      const close = streamJobLogs(provisionalId, handleLogLine, (isError) => {
        if (isError) {
          addLog("⚠ SSE connection dropped (backend may have restarted)", "warn");
        } else {
          addLog("Log stream closed.", "info");
        }
      });
      sseCloseRef.current = close;
    }

    // Step 2: POST /run-epm — now returns immediately {job_id, status:"started"}
    addLog("Submitting job…", "info");
    let submittedId;
    try {
      const res = await startJob({
        aoi,
        aoiName: resolvedAoiName,
        startDate,
        endDate,
        provisionalJobId: provisionalId,
      });
      submittedId = res.job_id;
    } catch (err) {
      sseCloseRef.current?.();
      addLog(`Job failed: ${err.message}`, "error");
      setStatus("error");
      runningRef.current = false;
      return;
    }

    addLog("Job queued. Waiting for pipeline to complete…", "info");

    // Step 3: Poll /job-status/{job_id} every 3 seconds until done or error
    let finalId = submittedId;
    const POLL_MS = 3000;
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 5;   // ~15 s of unreachable backend = fatal
    while (runningRef.current) {
      await new Promise(r => setTimeout(r, POLL_MS));
      if (!runningRef.current) break;
      let statusRes;
      try {
        statusRes = await pollJobStatus(submittedId);
        consecutiveFailures = 0;   // reset on any successful response
      } catch (err) {
        consecutiveFailures++;
        const is404 = err?.message?.includes("404");
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          sseCloseRef.current?.();
          if (is404) {
            addLog("Backend restarted — job record lost. Please start a new job.", "error");
          } else {
            addLog(`Backend unreachable after ${MAX_CONSECUTIVE_FAILURES} retries: ${err.message}`, "error");
          }
          setStatus("error");
          runningRef.current = false;
          return;
        }
        // Transient hiccup — keep trying
        addLog(`⚠ Polling hiccup (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err.message}`, "warn");
        continue;
      }

      if (statusRes.status === "done") {
        finalId = statusRes.result?.job_id ?? submittedId;
        break;
      }
      if (statusRes.status === "cancelled") {
        // Backend already cleaned up folder + DB — cancel() fn handles UI reset
        sseCloseRef.current?.();
        runningRef.current = false;
        return;
      }
      if (statusRes.status === "error" || statusRes.status === "aoi_error") {
        // If cancel is already in progress, let cancel() handle the UI reset
        if (!runningRef.current) return;
        sseCloseRef.current?.();
        const errMsg = statusRes.error ?? "Unknown pipeline error";
        const isAoiError = statusRes.status === "aoi_error" ||
          errMsg.toLowerCase().includes("no usable scenes");
        addLog(`Job failed: ${errMsg}`, "error");
        if (isAoiError) {
          addLog("", "info");
          addLog("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "warn");
          addLog("⚠  No usable scenes for this AOI", "warn");
          addLog("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "warn");
          addLog("  · All scenes too cloudy (raise cloud limit)", "warn");
          addLog("  · AOI over open water — try a land area", "warn");
          addLog("  · Widen the date range", "warn");
          setStatus("aoi_error");
        } else {
          setStatus("error");
        }
        runningRef.current = false;
        return;
      }
      // status === "running" — keep polling
    }

    // Pipeline finished — mark everything done
    setJobId(finalId);
    const allDone = Object.fromEntries(PIPELINE_STEPS.map(s => [s.id, "done"]));
    setSteps(allDone);
    setLiveStep(null);
    setDateProgress(null);
    addLog(`Pipeline complete — ${finalId}`, "success");

    // Fetch dates
    let dates = [];
    try {
      const dr = await getJobDates(finalId);
      dates = dr.dates ?? [];
      addLog(`${dates.length} date(s): ${dates.join(", ")}`, "info");
    } catch (err) {
      addLog(`Could not fetch dates: ${err.message}`, "warn");
    }

    // Fetch histograms for each valid date
    const histogramsByDate = {};
    const validDates = [];
    for (const d of dates) {
      try {
        const h = await getHistograms(finalId, d);
        histogramsByDate[d] = h;
        validDates.push(d);
        addLog(`[${d}] ${Object.keys(h).length} indices loaded`, "success");
      } catch {
        addLog(`[${d}] No outputs (skipped/cloudy)`, "warn");
      }
    }

    if (!validDates.length) {
      addLog("", "info");
      addLog("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "warn");
      addLog("⚠  No usable scenes for this AOI", "warn");
      addLog("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "warn");
      addLog("  · All scenes too cloudy (raise cloud limit)", "warn");
      addLog("  · AOI over open water — try a land area", "warn");
      addLog("  · Widen the date range", "warn");
      setStatus("aoi_error");
      runningRef.current = false;
      return;
    }

    const latestDate = validDates[0];
    const result = {
      mock: false, job_id: finalId,
      aoiName: resolvedAoiName ?? null,
      dates: validDates, date: latestDate,
      histograms: histogramsByDate[latestDate] ?? null,
      histogramsByDate, aoi, startDate, endDate,
    };

    setResults(result);
    setHistory(prev => [result, ...prev]);
    setStatus("done");
    addLog("Results ready — click View Results.", "success");
    runningRef.current = false;
  }, [addLog, handleLogLine]);


  const cancel = useCallback(async () => {
    const id = jobId;
    if (!id || status !== "running" || cancelling) return;
    setCancelling(true);
    addLog("Stopping job now...", "warn");
    try {
      await cancelJob(id);
    } catch (err) {
      addLog(`Cancel request failed: ${err.message}`, "error");
      setCancelling(false);
      return;
    }
    runningRef.current = false;
    sseCloseRef.current?.();
    setLogs([]);
    setSteps({});
    setLiveStep(null);
    setDateProgress(null);
    setJobId(null);
    setStatus("idle");
    setCancelling(false);
  }, [jobId, status, cancelling, addLog]);

  const start = useCallback(async ({ aoi, aoiName, startDate, endDate, hasPolygon }) => {
    if (!hasPolygon || !aoi)    { addLog("Draw a polygon or upload KML first", "warn"); return; }
    if (!startDate || !endDate) { addLog("Select a date range", "warn"); return; }
    if (status === "running")   return;

    setStatus("running");
    runningRef.current = true;
    setSteps({});
    setLogs([]);
    setLiveStep(null);
    setDateProgress(null);

    await runPipeline({ aoi, aoiName, startDate, endDate });
  }, [status, addLog, runPipeline]);

  const changeDate = useCallback(async (newDate, overrideJobId) => {
    const id = overrideJobId ?? jobId;
    if (!id || !newDate) return;
    // If we already have this date cached in histogramsByDate, use it instantly
    setResults(prev => {
      if (!prev) return prev;
      const cached = prev.histogramsByDate?.[newDate];
      if (cached) return { ...prev, date: newDate, histograms: cached };
      return prev; // will update after fetch below
    });
    // Always fetch fresh to ensure up-to-date data
    try {
      const h = await getHistograms(id, newDate);
      setResults(prev => ({
        ...prev,
        date: newDate,
        histograms: h,
        histogramsByDate: { ...(prev?.histogramsByDate ?? {}), [newDate]: h },
      }));
      // Also sync the same date into history so cross-job TSA stays fresh
      setHistory(prev => prev.map(job =>
        job.job_id === id
          ? { ...job, histogramsByDate: { ...job.histogramsByDate, [newDate]: h } }
          : job
      ));
    } catch (err) {
      addLog(`Failed to load ${newDate}: ${err.message}`, "error");
    }
  }, [jobId, addLog]);

  return {
    status, steps, logs, results, history, jobId,
    liveStep, dateProgress, cancelling,
    start, reset, addLog, changeDate, cancel, refreshHistory,
  };
}
