/**
 * Shared data utilities for EPM frontend.
 */

export function deriveClusterPct(histograms) {
  const meta = histograms?._meta;
  if (meta?.gmm_cluster_counts) {
    const counts = meta.gmm_cluster_counts;
    const total = counts.reduce((s, c) => s + c, 0);
    if (total > 0) return counts.map(c => Math.max(1, Math.round((c / total) * 100)));
  }

  // Fallback if GMM cluster counts aren't available (e.g. older jobs)
  const rpriData = histograms?.RPRI ?? histograms?.RAQI ?? {};
  const freq = rpriData.frequency ?? rpriData.freq ?? [];
  const bins = rpriData.bins ?? [];
  if (!freq.length || bins.length < 2) return [30, 25, 20, 15, 10];
  const total = freq.reduce((s, f) => s + f, 0);
  if (!total) return [30, 25, 20, 15, 10];
  
  const thresholds = [0.2, 0.4, 0.6, 0.8];
  const counts = [0, 0, 0, 0, 0];
  freq.forEach((f, i) => {
    const binMid = bins[i] != null && bins[i + 1] != null ? (bins[i] + bins[i + 1]) / 2 : (i + 0.5) / freq.length;
    const cls = thresholds.findIndex(t => binMid < t);
    counts[cls === -1 ? 4 : cls] += f;
  });
  return counts.map(c => Math.max(1, Math.round((c / total) * 100)));
}
