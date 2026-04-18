// ── Index display metadata ─────────────────────────────────────────────────
export const INDEX_META = {
  NDVI:  { label: "NDVI",  color: "#34d399", desc: "Normalized Difference Vegetation Index",  info: "Ranges from -1 to +1. Values above 0.5 indicate dense healthy vegetation. Near 0 = bare soil or sparse cover. Negative = water or clouds. A high NDVI mean signals good vegetation health in the AOI." },
  NDWI:  { label: "NDWI",  color: "#38bdf8", desc: "Normalized Difference Water Index",        info: "Values above 0.3 strongly indicate open surface water (rivers, lakes, ponds). Values below 0 indicate dry land. Used to map flooding extent and monitor reservoir levels." },
  EVI:   { label: "EVI",   color: "#4ade80", desc: "Enhanced Vegetation Index",                info: "Like NDVI but corrected for atmospheric and soil background effects. More reliable in dense canopy and urban areas. Values above 0.4 indicate vigorous vegetation growth." },
  SAVI:  { label: "SAVI",  color: "#86efac", desc: "Soil Adjusted Vegetation Index",           info: "NDVI variant that reduces soil brightness interference. Preferred in arid/semi-arid regions with sparse cover. The L correction factor (0.5) is baked in. Interpret similarly to NDVI." },
  NDMI:  { label: "NDMI",  color: "#67e8f9", desc: "Normalized Difference Moisture Index",     info: "Measures vegetation water content using NIR and SWIR. Positive values = moist vegetation. Near zero or negative = dry or stressed vegetation. Good drought indicator." },
  NBR:   { label: "NBR",   color: "#fbbf24", desc: "Normalized Burn Ratio",                   info: "High values = healthy unburned vegetation. Very low or negative = burned / bare. Used to detect fire scars and track post-fire ecosystem recovery over time." },
  MNDWI: { label: "MNDWI", color: "#22d3ee", desc: "Modified NDWI",                            info: "Better than NDWI at distinguishing open water from built-up land. High values reliably indicate water bodies even in dense urban environments." },
  NDRE:  { label: "NDRE",  color: "#a3e635", desc: "Red-Edge Normalized Difference",           info: "More sensitive than NDVI to chlorophyll content and early vegetation stress. Values near 1.0 indicate highly active, healthy plant cells. Useful for early drought or disease detection." },
  NDTI:  { label: "NDTI",  color: "#fb923c", desc: "Normalized Difference Turbidity Index",    info: "Estimates suspended sediment and turbidity in water bodies. Higher values = murkier water, potentially from industrial discharge, runoff, or erosion events." },
  NDBAI: { label: "NDBAI", color: "#e879f9", desc: "Normalized Difference Built-up & Bare",   info: "Highlights bare soil, impervious surfaces, and built-up land. High values indicate urbanisation, deforestation, or mining activity. Useful for land degradation and urban sprawl mapping." },
  RAQI:  { label: "RAQI",  color: "#f87171", desc: "Remote Air Quality Index" },
};

export const CLUSTER_LABELS = [
  { label: "Very Low Risk",  color: "#34d399" },
  { label: "Low Risk",       color: "#a3e635" },
  { label: "Moderate Risk",  color: "#fbbf24" },
  { label: "High Risk",      color: "#fb923c" },
  { label: "Critical Risk",  color: "#f87171" },
];

export const PIPELINE_STEPS = [
  { id: "stac",     label: "STAC Scene Search",         duration: 5000  },
  { id: "download", label: "Band Download & Mask",       duration: 50000 },
  { id: "mosaic",   label: "Mosaic & Reproject",         duration: 3000  },
  { id: "indices",  label: "Spectral Index Computation", duration: 3000  },
  { id: "raqi",     label: "RAQI Composite",             duration: 2000  },
  { id: "cluster",  label: "Risk Classification",         duration: 6000  },
  { id: "cog",      label: "COG Export & Stats",         duration: 5000  },
];
