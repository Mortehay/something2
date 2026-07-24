from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from .config import settings
from . import backends
from .jobs import JobManager
from .orchestrator import generate_creature, generate_tile, generate_object
from .recipe import recipe_for

app = FastAPI(title="something2 sprite-gen")
job_manager = JobManager()

class GenerateRequest(BaseModel):
    creature: str
    base_prompt: str
    kind: str = "creature"  # "creature" | "tile" | "object"
    backend: Optional[str] = None
    seed: int = 0
    frames: Optional[int] = None
    size: Optional[List[int]] = None
    steps: Optional[int] = None
    tier: Optional[str] = None  # override the detected hardware tier

@app.get("/health")
def health():
    return {
        "status": "ok",
        "device": settings.device,
        "default_backend": settings.default_backend,
        "capability": settings.capability(),
    }

@app.get("/capability")
def capability():
    return settings.capability()

@app.get("/backends")
def list_backends():
    return backends.available()

@app.post("/generate", status_code=202)
def generate(req: GenerateRequest):
    # Resolve the recipe from the detected (or overridden) hardware tier, then
    # let any explicit request field win over the recipe default.
    tier = req.tier or settings.capability()["tier"]
    recipe = recipe_for(tier)
    # SPRITE_BACKEND is an explicit override so the "stub now / real SD later"
    # switch is config, not code: set it (e.g. `stub`) to force a backend; unset
    # it to let the hardware-tier recipe choose. An explicit request backend
    # still wins over both.
    backend_name = req.backend or os.getenv("SPRITE_BACKEND") or recipe.backend
    if backend_name not in backends.available():
        raise HTTPException(status_code=400, detail=f"unknown backend '{backend_name}'")
    frames = req.frames or recipe.n_frames
    steps = req.steps if req.steps is not None else recipe.steps
    size = tuple(req.size) if req.size else ((128, 128) if req.kind == "tile" else (128, 160))

    def work(progress):
        if req.kind == "tile":
            out = generate_tile(
                tile=req.creature, base_prompt=req.base_prompt, backend_name=backend_name,
                seed=req.seed, n_frames=frames, size=size, steps=steps, progress=progress,
            )
            if _STORE_ENABLED:
                from .storage import default_store
                return default_store().put_tile(req.creature, out)
            return {"frames": len(out["frames"]), "manifest": out["manifest"]}
        if req.kind == "object":
            out = generate_object(
                obj=req.creature, base_prompt=req.base_prompt, backend_name=backend_name,
                seed=req.seed, n_frames=frames, size=size, steps=steps, progress=progress,
            )
            if _STORE_ENABLED:
                from .storage import default_store
                return default_store().put_object(req.creature, out)
            return {"frames": len(out["frames"]), "manifest": out["manifest"]}
        out = generate_creature(
            creature=req.creature, base_prompt=req.base_prompt, backend_name=backend_name,
            seed=req.seed, n_frames=frames, size=size, steps=steps, progress=progress,
        )
        # Persist to MinIO only when a real store is reachable; failures surface
        # in the job error. In tests the store call is skipped (STORE disabled).
        if _STORE_ENABLED:
            from .storage import default_store
            return default_store().put_creature(req.creature, out)
        return {"frames": len(out["frames"]), "manifest": out["manifest"]}

    return {
        "job_id": job_manager.submit(work),
        "recipe": {
            "tier": recipe.tier,
            "backend": backend_name,
            "steps": steps,
            "frames": frames,
            "controlnet": recipe.controlnet,
        },
    }

@app.get("/jobs/{job_id}")
def get_job(job_id: str):
    job = job_manager.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return job

# Storage is opt-in via env so unit tests (no MinIO) don't try to upload.
import os
_STORE_ENABLED = os.getenv("SPRITE_STORE_ENABLED", "false").lower() == "true"
