# EPM Frontend

React + Vite frontend for the Environmental Pollution Monitor pipeline.

## Quick Start

```bash
npm install
cp .env.example .env   # set VITE_API_URL
npm run dev
```

## Key behaviours

- **Dashboard button is always visible** in the sidebar — dimmed until results exist, clickable once any job completes.
- **Auto-opens** the dashboard ~1.2 s after a pipeline run finishes (with a pulsing animation).
- **Full job history** — every completed run is stored in state; the dashboard History panel lets you switch between past jobs.
- **No mock data** — all data comes from the real FastAPI backend.

## Structure

```
src/
├── components/
│   ├── dashboard/
│   │   ├── Dashboard.jsx     # Shell: history sidebar, tab bar, date picker
│   │   ├── RaqiTab.jsx       # Animated stat cards, live heatmap, risk bars
│   │   ├── RaqiLiveMap.jsx   # requestAnimationFrame canvas, scanline, hover glow
│   │   ├── ClustersTab.jsx   # Animated cluster map + stacked coverage bar
│   │   └── IndicesTab.jsx    # Index cards with group filter
│   ├── AOIPanel.jsx
│   ├── Header.jsx            # Orbiting dot, animated accent line, job counter
│   ├── Icons.jsx
│   ├── IndexCard.jsx
│   ├── MapCanvas.jsx
│   ├── MiniHistogram.jsx
│   ├── ProcessingPanel.jsx
│   └── RaqiColorScale.jsx
├── data/mockData.js          # INDEX_META, CLUSTER_LABELS, PIPELINE_STEPS (no mock histograms)
├── hooks/usePipeline.js      # Accumulates history[], fetches all dates' histograms
├── styles/globals.css        # Dark theme, 15+ animations
└── utils/api.js
```

## Backend API

| Endpoint | Returns |
|---|---|
| `POST /run-epm` | `{ job_id }` |
| `GET /job-dates/{job_id}` | `{ dates: [...] }` |
| `GET /histograms/{job_id}/{date}` | histogram JSON |
| `GET /tif/{job_id}/{date}/{layer}` | TIF file |
