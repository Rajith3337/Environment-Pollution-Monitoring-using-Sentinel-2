# EPM Backend

FastAPI backend for the Environmental Pollution Monitor — runs the Sentinel-2 STAC pipeline,
serves XYZ map tiles, histograms, and COG downloads, and persists job history to Supabase.

---

## Local Development

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env             # fill in Supabase keys (optional)
uvicorn main:app --reload --port 8000
```

API docs: http://localhost:8000/docs

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | Optional | Supabase project URL — enables job history persistence |
| `SUPABASE_SERVICE_KEY` | Optional | Supabase service-role key (server-side only) |
| `ALLOWED_ORIGINS` | Optional | Comma-separated CORS origins. Default `*` (open). Set to your frontend URL in production. |

> Without `SUPABASE_*` vars the backend works fully — job history is just in-memory per process.

---

## Supabase Setup (one-time SQL)

Run this in your Supabase project → **SQL Editor**:

```sql
CREATE TABLE epm_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       text NOT NULL UNIQUE,
  created_at   timestamptz DEFAULT now(),
  start_date   text,
  end_date     text,
  dates        text[],
  aoi          jsonb,
  histograms   jsonb,
  status       text DEFAULT 'done'
);
ALTER TABLE epm_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon access" ON epm_jobs FOR ALL USING (true) WITH CHECK (true);
```

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/` | Health check |
| GET | `/health` | Health + DB connectivity status |
| POST | `/prepare-job` | Get provisional job ID for SSE pre-connection |
| POST | `/run-epm` | Run full pipeline (blocking) |
| GET | `/logs/{job_id}` | SSE live log stream |
| GET | `/job-dates/{job_id}` | List dates with real outputs |
| GET | `/histograms/{job_id}/{date}` | Histogram JSON |
| GET | `/bounds/{job_id}/{date}/{layer}` | WGS-84 bounding box |
| GET | `/tif/{job_id}/{date}/{layer}` | Download raw COG TIF |
| GET | `/tiles/{job_id}/{date}/{layer}/{z}/{x}/{y}.png` | XYZ tile server |
| GET | `/preview/{job_id}/{date}/{layer}` | Full-raster PNG preview |
| GET | `/jobs` | List all saved jobs (Supabase) |
| GET | `/jobs/{job_id}` | Get single saved job (Supabase) |

---

## Deploy to Render (Docker)

1. Push this folder to a GitHub repo
2. New → **Web Service** → connect repo
3. Runtime: **Docker**
4. Add environment variables in Render dashboard
5. (Optional) Add a **Disk** mount at `/app/output` for persistent TIF storage

Or use the included `render.yaml` for one-click deploy.

---

## Deploy to Railway

```bash
npm i -g @railway/cli
railway login
railway init
railway up
```

Set env vars via `railway variables set KEY=value`.

---

## Deploy to Fly.io

```bash
fly launch          # detects Dockerfile automatically
fly secrets set SUPABASE_URL=... SUPABASE_SERVICE_KEY=...
fly deploy
```

Add a volume for `/app/output` to persist TIF outputs across deploys.
