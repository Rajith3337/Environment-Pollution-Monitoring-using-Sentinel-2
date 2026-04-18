"""
db.py — Local SQLite persistence for EPM jobs and scenes.

Optimizations vs original:
  - WAL journal mode: concurrent reads + writes without blocking
  - Connection pool via threading.local (one conn per thread, reused)
  - PRAGMA cache_size / synchronous tuned for write-heavy pipeline workloads
  - Indices on frequently queried columns
"""

import json
import os
import sqlite3
import threading
from datetime import datetime, timezone

DB_PATH = "jobs.db"

# ── Per-thread connection pool ────────────────────────────────────────────────
_local = threading.local()

def get_db_connection() -> sqlite3.Connection:
    """Return a thread-local SQLite connection, creating it if needed."""
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
        conn.row_factory = sqlite3.Row
        # WAL mode: readers don't block writers and vice versa
        conn.execute("PRAGMA journal_mode=WAL")
        # Normal sync is safe with WAL and much faster than FULL
        conn.execute("PRAGMA synchronous=NORMAL")
        # 16 MB page cache per connection
        conn.execute("PRAGMA cache_size=-16000")
        conn.execute("PRAGMA foreign_keys=ON")
        _local.conn = conn
    return conn


def init_db():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute('''
        CREATE TABLE IF NOT EXISTS epm_jobs (
            id           TEXT PRIMARY KEY,
            status       TEXT NOT NULL DEFAULT 'running',
            aoi_name     TEXT,
            aoi          TEXT,
            start_date   TEXT,
            end_date     TEXT,
            max_cloud    INTEGER,
            error        TEXT,
            created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
            completed_at TEXT,
            updated_at   TEXT DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    # Lightweight schema migration for older DB files.
    cols = {r["name"] for r in c.execute("PRAGMA table_info(epm_jobs)").fetchall()}
    if "aoi_name" not in cols:
        c.execute("ALTER TABLE epm_jobs ADD COLUMN aoi_name TEXT")
    c.execute('''
        CREATE TABLE IF NOT EXISTS epm_scenes (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id         TEXT,
            scene_date     TEXT NOT NULL,
            scene_count    INTEGER DEFAULT 1,
            histograms     TEXT,
            mosaic_folder  TEXT,
            updated_at     TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(job_id, scene_date),
            FOREIGN KEY (job_id) REFERENCES epm_jobs(id) ON DELETE CASCADE
        )
    ''')
    # Indices for common query patterns
    c.execute("CREATE INDEX IF NOT EXISTS idx_jobs_status     ON epm_jobs(status)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_jobs_created    ON epm_jobs(created_at DESC)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_scenes_job_date ON epm_scenes(job_id, scene_date)")
    conn.commit()
    print(f"[DB] SQLite initialised at {DB_PATH}", flush=True)

init_db()

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Job CRUD ──────────────────────────────────────────────────────────────────

def upsert_job(
    job_id: str,
    status: str,
    aoi_name: str | None = None,
    aoi: dict | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    max_cloud: int | None = None,
    error: str | None = None,
    completed_at: str | None = None,
):
    try:
        conn = get_db_connection()
        c = conn.cursor()
        updated_at = _now_iso()
        # INSERT OR IGNORE creates the row if absent, then UPDATE always patches
        # the fields we have.  This is atomic and avoids the SELECT→INSERT TOCTOU
        # race that caused "UNIQUE constraint failed" when two threads called
        # upsert_job with the same job_id at startup.
        c.execute('''
            INSERT OR IGNORE INTO epm_jobs (id, status, updated_at)
            VALUES (?, ?, ?)
        ''', (job_id, status, updated_at))
        updates = ["status = ?", "updated_at = ?"]
        params  = [status, updated_at]
        if aoi_name     is not None: updates.append("aoi_name = ?");     params.append(aoi_name)
        if aoi          is not None: updates.append("aoi = ?");          params.append(json.dumps(aoi))
        if start_date   is not None: updates.append("start_date = ?");   params.append(start_date)
        if end_date     is not None: updates.append("end_date = ?");     params.append(end_date)
        if max_cloud    is not None: updates.append("max_cloud = ?");    params.append(max_cloud)
        if error        is not None: updates.append("error = ?");        params.append(error)
        if completed_at is not None: updates.append("completed_at = ?"); params.append(completed_at)
        params.append(job_id)
        c.execute(f"UPDATE epm_jobs SET {', '.join(updates)} WHERE id = ?", params)
        conn.commit()
    except Exception as e:
        print(f"[DB] upsert_job error: {e}", flush=True)


def get_job_from_db(job_id: str) -> dict | None:
    try:
        conn = get_db_connection()
        row = conn.execute("SELECT * FROM epm_jobs WHERE id = ?", (job_id,)).fetchone()
        if row:
            d = dict(row)
            if d.get("aoi"):
                d["aoi"] = json.loads(d["aoi"])
            return d
        return None
    except Exception as e:
        print(f"[DB] get_job error: {e}", flush=True)
        return None


def delete_job(job_id: str) -> bool:
    try:
        conn = get_db_connection()
        conn.execute("DELETE FROM epm_scenes WHERE job_id = ?", (job_id,))
        conn.execute("DELETE FROM epm_jobs WHERE id = ?", (job_id,))
        conn.commit()
        return True
    except Exception as e:
        print(f"[DB] delete_job error: {e}", flush=True)
        return False


def get_all_jobs() -> list[dict]:
    try:
        conn = get_db_connection()
        rows = conn.execute("SELECT * FROM epm_jobs ORDER BY created_at DESC").fetchall()
        res = []
        for row in rows:
            d = dict(row)
            if d.get("aoi"):
                d["aoi"] = json.loads(d["aoi"])
            res.append(d)
        return res
    except Exception as e:
        print(f"[DB] get_all_jobs error: {e}", flush=True)
        return []


# ── Scene CRUD ────────────────────────────────────────────────────────────────

def upsert_scene(job_id: str, scene_date: str, scene_count: int,
                 histograms: dict, mosaic_folder: str = ""):
    try:
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("SELECT id FROM epm_scenes WHERE job_id = ? AND scene_date = ?", (job_id, scene_date))
        exists = c.fetchone() is not None
        updated_at = _now_iso()
        hj = json.dumps(histograms)
        if not exists:
            c.execute('''
                INSERT INTO epm_scenes (job_id, scene_date, scene_count, histograms, mosaic_folder, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (job_id, scene_date, scene_count, hj, mosaic_folder, updated_at))
        else:
            c.execute('''
                UPDATE epm_scenes
                SET scene_count = ?, histograms = ?, mosaic_folder = ?, updated_at = ?
                WHERE job_id = ? AND scene_date = ?
            ''', (scene_count, hj, mosaic_folder, updated_at, job_id, scene_date))
        conn.commit()
    except Exception as e:
        print(f"[DB] upsert_scene error: {e}", flush=True)


def get_scenes_for_job(job_id: str) -> list[dict]:
    try:
        conn = get_db_connection()
        rows = conn.execute('''
            SELECT scene_date, scene_count, histograms, mosaic_folder
            FROM epm_scenes WHERE job_id = ? ORDER BY scene_date DESC
        ''', (job_id,)).fetchall()
        res = []
        for row in rows:
            d = dict(row)
            if d.get("histograms"):
                d["histograms"] = json.loads(d["histograms"])
            res.append(d)
        return res
    except Exception as e:
        print(f"[DB] get_scenes error: {e}", flush=True)
        return []


def get_histograms_from_db(job_id: str, date: str) -> dict | None:
    try:
        conn = get_db_connection()
        row = conn.execute('''
            SELECT histograms FROM epm_scenes
            WHERE job_id = ? AND scene_date = ? LIMIT 1
        ''', (job_id, date)).fetchone()
        if row and row["histograms"]:
            return json.loads(row["histograms"])
        return None
    except Exception as e:
        print(f"[DB] get_histograms error: {e}", flush=True)
        return None

def delete_job_db(job_id: str):
    import shutil
    import os
    try:
        conn = get_db_connection()
        conn.execute('DELETE FROM epm_jobs WHERE job_id = ?', (job_id,))
        conn.execute('DELETE FROM epm_scenes WHERE job_id = ?', (job_id,))
        conn.commit()
        
        job_folder = os.path.join("output", job_id)
        if os.path.isdir(job_folder):
            shutil.rmtree(job_folder, ignore_errors=True)
    except Exception as e:
        print(f"[DB] delete_job error: {e}", flush=True)
