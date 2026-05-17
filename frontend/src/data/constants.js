// ── Index display metadata ─────────────────────────────────────────────────
export const INDEX_META = {
  NDVI:  { label: "NDVI",  color: "#34d399", gradient: ["#ffffe5", "#41ab5d", "#006837"], desc: "Normalized Difference Vegetation Index",  info: "Ranges from -1 to +1. Values above 0.5 indicate dense healthy vegetation. Near 0 = bare soil or sparse cover. Negative = water or clouds. A high NDVI mean signals good vegetation health in the AOI." },
  NDWI:  { label: "NDWI",  color: "#38bdf8", gradient: ["#f0f9e8", "#7bccc4", "#0868ac"], desc: "Normalized Difference Water Index",        info: "Values above 0.3 strongly indicate open surface water (rivers, lakes, ponds). Values below 0 indicate dry land. Used to map flooding extent and monitor reservoir levels." },
  EVI:   { label: "EVI",   color: "#4ade80", gradient: ["#440154", "#21918c", "#fde725"], desc: "Enhanced Vegetation Index",                info: "Like NDVI but corrected for atmospheric and soil background effects. More reliable in dense canopy and urban areas. Values above 0.4 indicate vigorous vegetation growth." },
  SAVI:  { label: "SAVI",  color: "#86efac", gradient: ["#ffffe5", "#41ab5d", "#006837"], desc: "Soil Adjusted Vegetation Index",           info: "NDVI variant that reduces soil brightness interference. Preferred in arid/semi-arid regions with sparse cover. The L correction factor (0.5) is baked in. Interpret similarly to NDVI." },
  NDMI:  { label: "NDMI",  color: "#67e8f9", gradient: ["#f7fbff", "#6baed6", "#08306b"], desc: "Normalized Difference Moisture Index",     info: "Measures vegetation water content using NIR and SWIR. Positive values = moist vegetation. Near zero or negative = dry or stressed vegetation. Good drought indicator." },
  NBR:   { label: "NBR",   color: "#fbbf24", gradient: ["#d73027", "#ffffbf", "#1a9850"], desc: "Normalized Burn Ratio",                   info: "High values = healthy unburned vegetation. Very low or negative = burned / bare. Used to detect fire scars and track post-fire ecosystem recovery over time." },
  MNDWI: { label: "MNDWI", color: "#22d3ee", gradient: ["#fff7fb", "#74a9cf", "#023858"], desc: "Modified NDWI",                            info: "Better than NDWI at distinguishing open water from built-up land. High values reliably indicate water bodies even in dense urban environments." },
  NDRE:  { label: "NDRE",  color: "#a3e635", gradient: ["#ffffe5", "#41ab5d", "#006837"], desc: "Red-Edge Normalized Difference",           info: "More sensitive than NDVI to chlorophyll content and early vegetation stress. Values near 1.0 indicate highly active, healthy plant cells. Useful for early drought or disease detection." },
  NDTI:  { label: "NDTI",  color: "#fb923c", gradient: ["#ffffe5", "#fe9929", "#662506"], desc: "Normalized Difference Turbidity Index",    info: "Estimates suspended sediment and turbidity in water bodies. Higher values = murkier water, potentially from industrial discharge, runoff, or erosion events." },
  NDBAI: { label: "NDBAI", color: "#e879f9", gradient: ["#fff7ec", "#fc8d59", "#7f0000"], desc: "Normalized Difference Built-up & Bare",   info: "Highlights bare soil, impervious surfaces, and built-up land. High values indicate urbanisation, deforestation, or mining activity. Useful for land degradation and urban sprawl mapping." },
  RPRI:  { label: "RPRI",  color: "#f87171", gradient: ["#0d0887", "#cc4778", "#f0f921"], desc: "Remote Pollution Risk Index" },
};

export const CLUSTER_LABELS = [
  { label: "Very Low Risk",  color: "#22c55e" },
  { label: "Low Risk",       color: "#84cc16" },
  { label: "Moderate Risk",  color: "#eab308" },
  { label: "High Risk",      color: "#f97316" },
  { label: "Critical Risk",  color: "#ef4444" },
];

export const PIPELINE_STEPS = [
  { id: "stac",     label: "STAC Scene Search",         duration: 5000  },
  { id: "download", label: "Band Download & Mask",       duration: 50000 },
  { id: "mosaic",   label: "Mosaic & Reproject",         duration: 3000  },
  { id: "indices",  label: "Spectral Index Computation", duration: 3000  },
  { id: "rpri",     label: "RPRI Composite",             duration: 2000  },
  { id: "cluster",  label: "Risk Classification",         duration: 6000  },
  { id: "cog",      label: "COG Export & Stats",         duration: 5000  },
];
