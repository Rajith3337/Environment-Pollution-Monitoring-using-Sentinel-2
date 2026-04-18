const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8000";
export { BASE };

// ── Simple in-flight deduplication — prevents duplicate concurrent requests ──
const _inflight = new Map();

async function _dedupe(key, fn) {
  if (_inflight.has(key)) return _inflight.get(key);
  const p = fn().finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}

// ── Short-lived response cache for histogram + TSA data (immutable outputs) ─
const _cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

function _cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { _cache.delete(key); return null; }
  return entry.value;
}
function _cacheSet(key, value) {
  _cache.set(key, { value, ts: Date.now() });
  return value;
}

// ── Generic fetch helper ────────────────────────────────────────────────────
async function _get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Prepare job ─────────────────────────────────────────────────────────────
export async function prepareJob() {
  const res = await fetch(`${BASE}/prepare-job`, { method: "POST" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Job submission ──────────────────────────────────────────────────────────
export async function startJob({ aoi, aoiName, startDate, endDate, provisionalJobId }) {
  const res = await fetch(`${BASE}/run-epm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      aoi,
      aoi_name:           aoiName ?? null,
      start_date:         startDate,
      end_date:           endDate,
      provisional_job_id: provisionalJobId ?? null,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Poll job status — deduplicated ─────────────────────────────────────────
export async function pollJobStatus(jobId) {
  return _dedupe(`status:${jobId}`, () => _get(`${BASE}/job-status/${jobId}`));
}

// ── Output queries ──────────────────────────────────────────────────────────
export async function getAllJobs() {
  return _get(`${BASE}/jobs`);
}

export async function getJobDates(jobId) {
  const key = `dates:${jobId}`;
  return _cacheGet(key) ?? _cacheSet(key, await _dedupe(key, () => _get(`${BASE}/job-dates/${jobId}`)));
}

// Cached + deduplicated: histogram data for a job+date never changes
export async function getHistograms(jobId, date) {
  const key = `hist:${jobId}:${date}`;
  return _cacheGet(key) ?? _cacheSet(key, await _dedupe(key, () => _get(`${BASE}/histograms/${jobId}/${date}`)));
}

// Fetch all histograms for a job in parallel — much faster than sequential
export async function getAllHistograms(jobId, dates) {
  return Promise.all(dates.map(d => getHistograms(jobId, d)));
}

// ── TSA (time series analysis) — cached ────────────────────────────────────
export async function getTsaData(jobId) {
  const key = `tsa:${jobId}`;
  return _cacheGet(key) ?? _cacheSet(key, await _dedupe(key, () => _get(`${BASE}/tsa/${jobId}`)));
}

// ── File URLs ───────────────────────────────────────────────────────────────
export function getTifUrl(jobId, date, layer) {
  return `${BASE}/tif/${jobId}/${date}/${layer}`;
}

export function getTileUrl(jobId, date, layer) {
  return `${BASE}/tiles/${jobId}/${date}/${layer}/{z}/{x}/{y}.png?v=2`;
}

// ── Cancel a running job ────────────────────────────────────────────────────
export async function cancelJob(jobId) {
  const res = await fetch(`${BASE}/cancel-job/${jobId}`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Delete a job ────────────────────────────────────────────────────────────
export async function deleteJob(jobId) {
  const res = await fetch(`${BASE}/job/${jobId}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail ?? `HTTP ${res.status}`);
  }
  // Bust cache for this job
  for (const k of _cache.keys()) {
    if (k.includes(jobId)) _cache.delete(k);
  }
  return res.json();
}

// ── Backend log streaming (SSE) ─────────────────────────────────────────────
export function streamJobLogs(jobId, onLine, onDone) {
  let closed = false;
  let es;
  try {
    es = new EventSource(`${BASE}/logs/${jobId}`);
    es.onmessage = (e) => {
      if (closed) return;
      if (e.data === "__done__") { close(); onDone?.(false); return; }
      if (e.data?.trim()) onLine(e.data);
    };
    es.onerror = () => { close(); onDone?.(true); };  // true = connection error
  } catch {
    onDone?.(true);
    return () => {};
  }
  function close() { if (!closed) { closed = true; es?.close(); } }
  return close;
}
