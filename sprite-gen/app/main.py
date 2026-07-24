import hmac

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field, field_validator
from typing import Literal, Optional, List
from .config import settings
from . import backends
from .jobs import JobManager
from .orchestrator import generate_creature, generate_tile, generate_object
from .recipe import recipe_for

app = FastAPI(title="something2 sprite-gen")
job_manager = JobManager()

# Bounds for POST /generate (F-033/SOMET-213). Sized from the real call
# sites, not guesses:
#   - frames: the entity-editor's "Frames" input caps at 16
#     (frontend/src/games/something2/EntityTypesAdmin.jsx); the highest
#     recipe (gpu tier) only ever asks for 4 (recipe.py). 32 gives 2x
#     headroom over the UI ceiling.
#   - steps: no caller ever sends this explicitly — it's always filled from
#     a recipe, and the gpu recipe's 30 is the highest any recipe uses. 50
#     gives comfortable headroom without leaving it open-ended.
#   - size: creature/object generation defaults to 128x160, tiles to
#     128x128, and nothing in this codebase requests bigger. 512 gives 3x+
#     headroom per dimension; 8 is a sane floor so a degenerate 0/negative
#     size can't reach the backend.
# Unbounded, the failure this closes was frames=500 -> 8 directions x 500
# frames = 4000 sequential ~66s CPU generations on the single JobManager
# worker (tens of hours), queued ahead of every legitimate request with no
# cancel path.
MAX_FRAMES = 32
MAX_STEPS = 50
MIN_SIZE_DIM = 8
MAX_SIZE_DIM = 512

class GenerateRequest(BaseModel):
    creature: str
    base_prompt: str
    # F-034/SOMET-214: constrained so an unrecognized value is rejected with
    # 422 at the boundary instead of silently falling through to the
    # creature branch (8x the work, and a differently-shaped result).
    kind: Literal["creature", "tile", "object"] = "creature"
    backend: Optional[str] = None
    seed: int = 0
    frames: Optional[int] = Field(default=None, ge=1, le=MAX_FRAMES)
    size: Optional[List[int]] = None
    steps: Optional[int] = Field(default=None, ge=1, le=MAX_STEPS)
    tier: Optional[str] = None  # override the detected hardware tier

    @field_validator("size")
    @classmethod
    def _size_within_bounds(cls, v):
        if v is None:
            return v
        if len(v) != 2:
            raise ValueError("size must be a [width, height] pair")
        for dim in v:
            if not (MIN_SIZE_DIM <= dim <= MAX_SIZE_DIM):
                raise ValueError(
                    f"size dimensions must be between {MIN_SIZE_DIM} and {MAX_SIZE_DIM} (got {dim})"
                )
        return v


def require_shared_secret(x_sprite_gen_secret: Optional[str] = Header(default=None)):
    """Gate POST /generate behind the shared secret the backend sends
    (F-033/SOMET-213). The backend is the only legitimate caller.

    Fails CLOSED, not open: an unconfigured secret raises 500 for every
    caller, including a legitimate one — it must never look like protection
    while actually granting access. docker-compose requires
    SPRITE_GEN_SHARED_SECRET via the same `${VAR:?msg}` convention as
    JWT_SECRET, so a compose-managed deploy never starts unconfigured; this
    check is defense in depth for anything that runs the app outside compose.
    """
    configured = settings.sprite_gen_shared_secret
    if not configured:
        raise HTTPException(status_code=500, detail="SPRITE_GEN_SHARED_SECRET is not configured")
    if not x_sprite_gen_secret or not hmac.compare_digest(x_sprite_gen_secret, configured):
        raise HTTPException(status_code=401, detail="missing or invalid shared secret")

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

@app.post("/generate", status_code=202, dependencies=[Depends(require_shared_secret)])
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

    # F-037/SOMET-217: report what the resolved backend actually does, not
    # what the tier's recipe assumed -- backend_name can diverge from
    # recipe.backend (e.g. via the SPRITE_BACKEND override), and a stale
    # recipe.controlnet/steps in the response would misrepresent the job
    # that is actually about to run.
    caps = backends.capabilities_for(backend_name)
    reported_steps = steps if caps["max_steps"] is None else min(steps, caps["max_steps"])

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
            "steps": reported_steps,
            "frames": frames,
            "controlnet": caps["controlnet"],
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
