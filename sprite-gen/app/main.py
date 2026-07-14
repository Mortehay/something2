from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from .config import settings
from . import backends
from .jobs import JobManager
from .orchestrator import generate_creature

app = FastAPI(title="something2 sprite-gen")
job_manager = JobManager()

class GenerateRequest(BaseModel):
    creature: str
    base_prompt: str
    backend: Optional[str] = None
    seed: int = 0
    frames: Optional[int] = None
    size: Optional[List[int]] = None
    steps: int = 20

@app.get("/health")
def health():
    return {"status": "ok", "device": settings.device, "default_backend": settings.default_backend}

@app.get("/backends")
def list_backends():
    return backends.available()

@app.post("/generate", status_code=202)
def generate(req: GenerateRequest):
    backend_name = req.backend or settings.default_backend
    if backend_name not in backends.available():
        raise HTTPException(status_code=400, detail=f"unknown backend '{backend_name}'")
    frames = req.frames or settings.n_frames
    size = tuple(req.size) if req.size else (128, 160)

    def work(progress):
        out = generate_creature(
            creature=req.creature, base_prompt=req.base_prompt, backend_name=backend_name,
            seed=req.seed, n_frames=frames, size=size, steps=req.steps, progress=progress,
        )
        # Persist to MinIO only when a real store is reachable; failures surface
        # in the job error. In tests the store call is skipped (STORE disabled).
        if _STORE_ENABLED:
            from .storage import default_store
            return default_store().put_creature(req.creature, out)
        return {"frames": len(out["frames"]), "manifest": out["manifest"]}

    return {"job_id": job_manager.submit(work)}

@app.get("/jobs/{job_id}")
def get_job(job_id: str):
    job = job_manager.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return job

# Storage is opt-in via env so unit tests (no MinIO) don't try to upload.
import os
_STORE_ENABLED = os.getenv("SPRITE_STORE_ENABLED", "false").lower() == "true"
