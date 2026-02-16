import uuid
from fastapi import FastAPI, BackgroundTasks
from pydantic import BaseModel
from typing import Dict, Any

from backend.epm_core import run_epm

app = FastAPI(title="EPM Backend")

# ---------------- In-Memory Job Store ----------------

jobs: Dict[str, Dict[str, Any]] = {}


# ---------------- Request Model ----------------

class EPMRequest(BaseModel):
    aoi: dict
    start_date: str
    end_date: str


# ---------------- Background Worker ----------------

def process_job(job_id: str, aoi: dict, start_date: str, end_date: str):
    logs = []

    try:
        jobs[job_id]["status"] = "running"
        jobs[job_id]["logs"] = logs

        result = run_epm(aoi, start_date, end_date, logs)

        jobs[job_id]["status"] = "completed"
        jobs[job_id]["result"] = result

    except Exception as e:
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["error"] = str(e)


# ---------------- Start Endpoint ----------------

@app.post("/start")
def start_epm(request: EPMRequest, background_tasks: BackgroundTasks):

    job_id = str(uuid.uuid4())

    jobs[job_id] = {
        "status": "queued",
        "logs": [],
        "result": None,
        "error": None
    }

    background_tasks.add_task(
        process_job,
        job_id,
        request.aoi,
        request.start_date,
        request.end_date
    )

    return {
        "job_id": job_id,
        "status": "queued"
    }


# ---------------- Job Status Endpoint ----------------

@app.get("/status/{job_id}")
def get_status(job_id: str):

    if job_id not in jobs:
        return {"error": "Invalid job ID"}

    return jobs[job_id]


# ---------------- Root Endpoint ----------------

@app.get("/")
def root():
    return {"message": "EPM Backend is running"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000)

