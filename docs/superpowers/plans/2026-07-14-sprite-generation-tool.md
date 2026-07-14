# Sprite Generation Tool (Sub-project D) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **STATUS: PLAN ONLY — awaiting user review before execution.** Do not start implementing until the user approves. Executing the real-model tasks (7 real backends) will download multi-GB weights and run slow CPU inference; keep the default backend `stub` so nothing heavy runs unless explicitly selected.

**Goal:** A separate Python container that generates isometric, directional, animated creature sprites (8 facings × N walk frames) via a **pluggable, runtime-selectable** Stable Diffusion backend, driven by an admin flow, with results stored in MinIO and metadata in Postgres.

**Architecture:** A FastAPI service (`sprite-gen/`) exposes a job API. Generation goes through a `Backend` abstraction with four implementations selectable per-job: `stub` (instant placeholder frames, no ML deps — the default and the test vehicle), `sd15` (SD 1.5 + ControlNet), `sd-turbo` (SD-Turbo/LCM, few-step), `sdxl` (SDXL + ControlNet). Frame-to-frame consistency comes from a fixed per-creature seed plus a bundled set of ControlNet pose skeletons (8 directions × N frames). Post-processing (background removal, crop, atlas packing) is backend-independent. The Node/Express backend gains admin endpoints that enqueue jobs to the Python service and record approved sprite sets; the existing `EntityTypesAdmin.jsx` gets a sprite panel. Heavy ML libraries are imported lazily so the whole system runs and is fully unit-tested with zero model weights.

**Tech Stack:** Python 3.11, FastAPI, uvicorn, Pillow, NumPy (core, always installed); torch, diffusers, controlnet-aux, rembg, minio (ML/runtime, installed in the image, imported lazily); pytest (dev). Node/Express 4 (CommonJS) for the admin bridge. React 19 for the admin UI. Docker Compose for wiring.

## Global Constraints

- The sprite tool is a **separate Python service** (`sprite-gen/`). Do **not** add Python or ML code to the Node backend, and do not add generation to any player-facing request path — it is admin/background only.
- **Single device switch:** all torch device selection reads one config value `DEVICE` (`cpu` | `cuda`), default `cpu`. No hardcoded `.to("cpu")`/`.to("cuda")` at call sites.
- **Pluggable backends, runtime-selectable:** exactly four registered names — `stub`, `sd15`, `sd-turbo`, `sdxl`. The active backend is chosen per-job (API `backend` field), defaulting to env `SPRITE_BACKEND` (default `stub`). Unknown names → HTTP 400.
- **Heavy imports are lazy:** `torch`/`diffusers`/`controlnet_aux`/`rembg` are imported *inside* the backend/post-proc functions that use them, never at module top level. Core service, `stub` backend, API, job manager, orchestrator, storage, and poses must import and run with only `fastapi pillow numpy minio pytest` installed.
- **Sprite output contract (matches sub-project E's renderer):** transparent PNG, feet-anchored, cropped to content; frames of one creature share dimensions; atlas is a single sheet + JSON of frame rects keyed `<dir>/<frame>`. Directions are the 8 names `N,NE,E,SE,S,SW,W,NW`. Default `N_FRAMES = 4`.
- **Storage:** MinIO bucket `sprites`, keys `sprites/<creature>/<dir>/<frame>.png`, `sprites/<creature>/atlas.png`, `sprites/<creature>/atlas.json`. Never commit weights or generated art to git.
- **Node backend** stays CommonJS, raw `pg`, existing error shape (per `.ai/styleguides/backend.md`). **Frontend** stays ES modules. New backend env: `SPRITE_GEN_URL` (default `http://sprite-gen:8100`).
- **Determinism:** given the same `(creature, backend, seed, frames)`, the `stub` backend and the orchestration produce identical output (so tests are stable). Real backends are deterministic given a fixed seed on a fixed device.
- Python tests run with `cd sprite-gen && pytest`; real-model smoke tests are marked `@pytest.mark.slow` and skipped by default.
- Commit after every task.

## Directory layout (created across the tasks)

```
sprite-gen/
  pyproject.toml            # or requirements.txt + requirements-dev.txt
  Dockerfile
  app/
    __init__.py
    config.py               # env-driven config incl. DEVICE, SPRITE_BACKEND
    main.py                 # FastAPI app, routes
    jobs.py                 # in-process job manager (single worker)
    orchestrator.py         # generate a full creature (8 x N)
    poses.py                # pose-skeleton provider (8 dirs x N frames)
    prompts.py              # prompt builder per direction/frame
    postproc.py             # bg removal, crop, atlas packing
    storage.py              # MinIO adapter
    backends/
      __init__.py           # registry / get_backend(name)
      base.py               # Backend protocol
      stub.py               # instant placeholder frames (default)
      sd15.py               # SD 1.5 + ControlNet
      sd_turbo.py           # SD-Turbo / LCM
      sdxl.py               # SDXL + ControlNet
  poses/                    # bundled skeleton PNGs (generated by a script)
  tests/
    ...
```

---

### Task 1: Python service scaffold + config + health

**Files:**
- Create: `sprite-gen/requirements.txt`, `sprite-gen/requirements-dev.txt`
- Create: `sprite-gen/app/__init__.py`, `sprite-gen/app/config.py`, `sprite-gen/app/main.py`
- Create: `sprite-gen/tests/test_health.py`
- Create: `sprite-gen/pytest.ini`

**Interfaces:**
- Produces: `app.config.Settings` (reads `DEVICE`, `SPRITE_BACKEND`, `N_FRAMES`, MinIO env); FastAPI `app` with `GET /health` → `{"status":"ok","device":<device>,"default_backend":<name>}`.

- [ ] **Step 1: Write the failing test**

`sprite-gen/tests/test_health.py`:
```python
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

def test_health_ok():
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["device"] in ("cpu", "cuda")
    assert body["default_backend"] == "stub"  # safe default
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sprite-gen && pip install -r requirements-dev.txt && pytest tests/test_health.py -v`
Expected: FAIL (no `app` module).

- [ ] **Step 3: Write requirements + config + app**

`sprite-gen/requirements-dev.txt`:
```
fastapi==0.115.*
uvicorn==0.30.*
pillow==10.*
numpy==1.26.*
minio==7.*
pytest==8.*
httpx==0.27.*
```
`sprite-gen/requirements.txt` (image install = dev + heavy libs):
```
-r requirements-dev.txt
torch==2.3.*
diffusers==0.29.*
transformers==4.42.*
controlnet-aux==0.0.9
accelerate==0.31.*
rembg==2.0.*
```
`sprite-gen/app/config.py`:
```python
import os
from dataclasses import dataclass

@dataclass(frozen=True)
class Settings:
    device: str = os.getenv("DEVICE", "cpu")
    default_backend: str = os.getenv("SPRITE_BACKEND", "stub")
    n_frames: int = int(os.getenv("N_FRAMES", "4"))
    minio_endpoint: str = os.getenv("MINIO_ENDPOINT", "minio:9000")
    minio_access_key: str = os.getenv("MINIO_ACCESS_KEY", "minioadmin")
    minio_secret_key: str = os.getenv("MINIO_SECRET_KEY", "minioadmin")
    minio_bucket: str = os.getenv("MINIO_BUCKET", "sprites")
    minio_secure: bool = os.getenv("MINIO_SECURE", "false").lower() == "true"

settings = Settings()
DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
```
`sprite-gen/app/__init__.py`: empty.
`sprite-gen/app/main.py`:
```python
from fastapi import FastAPI
from .config import settings

app = FastAPI(title="something2 sprite-gen")

@app.get("/health")
def health():
    return {
        "status": "ok",
        "device": settings.device,
        "default_backend": settings.default_backend,
    }
```
`sprite-gen/pytest.ini`:
```ini
[pytest]
markers =
    slow: real-model tests that download weights and run inference (skipped by default)
addopts = -m "not slow"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sprite-gen && pytest tests/test_health.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sprite-gen/
git commit -m "feat(sprite-gen): FastAPI scaffold with config and health"
```

---

### Task 2: Backend abstraction + registry + stub backend

**Files:**
- Create: `sprite-gen/app/backends/__init__.py`, `base.py`, `stub.py`
- Create: `sprite-gen/tests/test_backends.py`

**Interfaces:**
- Produces:
  - `app.backends.base.Backend` protocol: `generate(prompt: str, pose: PIL.Image.Image | None, seed: int, steps: int, size: tuple[int,int]) -> PIL.Image.Image` (returns an RGBA image of `size`).
  - `app.backends.get_backend(name: str) -> Backend` (raises `KeyError` for unknown names). `app.backends.available() -> list[str]` == `["stub","sd15","sd-turbo","sdxl"]`.
  - `app.backends.stub.StubBackend` — deterministic solid-ish frame from a hash of `(prompt, seed)`, ignores pose, no ML imports.

- [ ] **Step 1: Write the failing test**

`sprite-gen/tests/test_backends.py`:
```python
import pytest
from app import backends

def test_registry_lists_all_four():
    assert backends.available() == ["stub", "sd15", "sd-turbo", "sdxl"]

def test_unknown_backend_raises():
    with pytest.raises(KeyError):
        backends.get_backend("nope")

def test_stub_is_deterministic_and_sized():
    b = backends.get_backend("stub")
    img1 = b.generate(prompt="goblin facing S", pose=None, seed=42, steps=1, size=(128, 160))
    img2 = b.generate(prompt="goblin facing S", pose=None, seed=42, steps=1, size=(128, 160))
    assert img1.size == (128, 160)
    assert img1.mode == "RGBA"
    assert list(img1.getdata()) == list(img2.getdata())  # deterministic

def test_stub_varies_by_seed():
    b = backends.get_backend("stub")
    a = b.generate(prompt="goblin", pose=None, seed=1, steps=1, size=(64, 64))
    c = b.generate(prompt="goblin", pose=None, seed=2, steps=1, size=(64, 64))
    assert list(a.getdata()) != list(c.getdata())
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sprite-gen && pytest tests/test_backends.py -v`
Expected: FAIL (no `app.backends`).

- [ ] **Step 3: Write base + stub + registry**

`sprite-gen/app/backends/base.py`:
```python
from typing import Protocol, Optional, Tuple
from PIL import Image

class Backend(Protocol):
    name: str
    def generate(
        self,
        prompt: str,
        pose: Optional[Image.Image],
        seed: int,
        steps: int,
        size: Tuple[int, int],
    ) -> Image.Image:
        """Return an RGBA image of exactly `size`."""
        ...
```
`sprite-gen/app/backends/stub.py`:
```python
import hashlib
from typing import Optional, Tuple
from PIL import Image

class StubBackend:
    name = "stub"

    def generate(self, prompt: str, pose: Optional[Image.Image], seed: int,
                 steps: int, size: Tuple[int, int]) -> Image.Image:
        # Deterministic placeholder: color from hash(prompt, seed); a filled
        # disc on transparent bg so downstream crop/atlas has real alpha.
        h = hashlib.sha256(f"{prompt}|{seed}".encode()).digest()
        color = (h[0], h[1], h[2], 255)
        w, hgt = size
        img = Image.new("RGBA", size, (0, 0, 0, 0))
        from PIL import ImageDraw
        d = ImageDraw.Draw(img)
        r = min(w, hgt) // 3
        cx, cy = w // 2, hgt // 2
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
        return img
```
`sprite-gen/app/backends/__init__.py`:
```python
from .stub import StubBackend

# Lazy factories so heavy backends don't import torch/diffusers at import time.
def _stub():
    return StubBackend()

def _sd15():
    from .sd15 import SD15Backend
    return SD15Backend()

def _sd_turbo():
    from .sd_turbo import SDTurboBackend
    return SDTurboBackend()

def _sdxl():
    from .sdxl import SDXLBackend
    return SDXLBackend()

_REGISTRY = {
    "stub": _stub,
    "sd15": _sd15,
    "sd-turbo": _sd_turbo,
    "sdxl": _sdxl,
}

def available():
    return list(_REGISTRY.keys())

def get_backend(name: str):
    if name not in _REGISTRY:
        raise KeyError(name)
    return _REGISTRY[name]()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sprite-gen && pytest tests/test_backends.py -v`
Expected: PASS (4 tests). (`sd15.py`/`sd_turbo.py`/`sdxl.py` don't exist yet but are only imported lazily, so `stub`/registry tests pass.)

- [ ] **Step 5: Commit**

```bash
git add sprite-gen/app/backends sprite-gen/tests/test_backends.py
git commit -m "feat(sprite-gen): pluggable backend registry + stub backend"
```

---

### Task 3: Pose skeletons + prompt builder

**Files:**
- Create: `sprite-gen/app/poses.py`, `sprite-gen/app/prompts.py`
- Create: `sprite-gen/tests/test_poses_prompts.py`

**Interfaces:**
- Consumes: `DIRECTIONS`, `settings.n_frames` from config.
- Produces:
  - `app.poses.pose_for(direction: str, frame: int, size: tuple[int,int]) -> PIL.Image.Image` — a deterministic openpose-style stick-figure skeleton (RGB on black) for that direction/frame; used as ControlNet conditioning. Pure PIL, no ML.
  - `app.prompts.build_prompt(base: str, direction: str, frame: int) -> str` — appends isometric/direction phrasing.

- [ ] **Step 1: Write the failing test**

`sprite-gen/tests/test_poses_prompts.py`:
```python
from app.poses import pose_for
from app.prompts import build_prompt

def test_pose_is_image_of_size_and_deterministic():
    a = pose_for("S", 0, (128, 160))
    b = pose_for("S", 0, (128, 160))
    assert a.size == (128, 160)
    assert list(a.getdata()) == list(b.getdata())

def test_pose_varies_by_frame_and_direction():
    assert list(pose_for("S", 0, (64, 80)).getdata()) != list(pose_for("S", 1, (64, 80)).getdata())
    assert list(pose_for("S", 0, (64, 80)).getdata()) != list(pose_for("N", 0, (64, 80)).getdata())

def test_prompt_includes_direction_and_iso():
    p = build_prompt("a fierce goblin warrior", "SE", 2)
    assert "goblin" in p
    assert "isometric" in p.lower()
    assert "south-east" in p.lower() or "se" in p.lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sprite-gen && pytest tests/test_poses_prompts.py -v`
Expected: FAIL (no modules).

- [ ] **Step 3: Implement poses + prompts**

`sprite-gen/app/prompts.py`:
```python
_DIR_WORDS = {
    "N": "facing north (away)", "NE": "facing north-east",
    "E": "facing east (right)", "SE": "facing south-east",
    "S": "facing south (toward camera)", "SW": "facing south-west",
    "W": "facing west (left)", "NW": "facing north-west",
}

def build_prompt(base: str, direction: str, frame: int) -> str:
    dirword = _DIR_WORDS.get(direction, "facing south")
    return (
        f"{base}, {dirword}, isometric video game sprite, 3/4 top-down view, "
        f"walk cycle frame {frame}, full body, centered, plain background, "
        f"crisp pixel-art style, high detail"
    )
```
`sprite-gen/app/poses.py`:
```python
import math
from typing import Tuple
from PIL import Image, ImageDraw

# 8 iso facings -> a screen-space heading angle (radians), for limb orientation.
_DIR_ANGLE = {
    "S": math.pi / 2, "SE": math.pi / 4, "E": 0.0, "NE": -math.pi / 4,
    "N": -math.pi / 2, "NW": -3 * math.pi / 4, "W": math.pi, "SW": 3 * math.pi / 4,
}

def pose_for(direction: str, frame: int, size: Tuple[int, int]) -> Image.Image:
    """A simple deterministic openpose-like skeleton. Not anatomically perfect —
    enough to give ControlNet a consistent pose per (direction, frame) so all
    frames of a creature read as the same character walking."""
    w, h = size
    img = Image.new("RGB", size, (0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = w // 2
    top = int(h * 0.18)
    hip = int(h * 0.55)
    ang = _DIR_ANGLE.get(direction, math.pi / 2)

    # Spine + head
    d.ellipse([cx - w // 12, top - h // 12, cx + w // 12, top + h // 12], outline=(255, 255, 0), width=2)
    d.line([cx, top + h // 12, cx, hip], fill=(0, 255, 0), width=3)

    # Legs swing by frame (walk cycle): phase alternates.
    swing = math.sin(frame / max(1, 4) * 2 * math.pi) * (w * 0.12)
    foot_y = int(h * 0.92)
    d.line([cx, hip, cx - int(swing), foot_y], fill=(0, 128, 255), width=3)
    d.line([cx, hip, cx + int(swing), foot_y], fill=(255, 0, 255), width=3)

    # Arms rotate slightly with heading so direction visibly differs.
    arm_y = int(h * 0.4)
    ax = int(math.cos(ang) * w * 0.18)
    d.line([cx, arm_y, cx - ax, arm_y + int(swing)], fill=(255, 128, 0), width=2)
    d.line([cx, arm_y, cx + ax, arm_y - int(swing)], fill=(128, 255, 0), width=2)
    return img
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sprite-gen && pytest tests/test_poses_prompts.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add sprite-gen/app/poses.py sprite-gen/app/prompts.py sprite-gen/tests/test_poses_prompts.py
git commit -m "feat(sprite-gen): deterministic pose skeletons + prompt builder"
```

---

### Task 4: Post-processing (background removal, crop, atlas)

**Files:**
- Create: `sprite-gen/app/postproc.py`
- Create: `sprite-gen/tests/test_postproc.py`

**Interfaces:**
- Produces:
  - `app.postproc.to_transparent(img: Image.Image) -> Image.Image` — ensures RGBA; if `rembg` is available uses it, else a luminance-threshold fallback (keeps this importable without rembg installed).
  - `app.postproc.crop_to_content(img: Image.Image) -> Image.Image` — crop to the alpha bounding box (no-op if fully transparent).
  - `app.postproc.pack_atlas(frames: dict[str, Image.Image]) -> tuple[Image.Image, dict]` — frames keyed `"<dir>/<frame>"`; returns a single sheet image (grid, all cells sized to the max frame w/h) and a manifest `{"cell": [w,h], "frames": {"S/0": [x,y,w,h], ...}}`.

- [ ] **Step 1: Write the failing test**

`sprite-gen/tests/test_postproc.py`:
```python
from PIL import Image
from app.postproc import to_transparent, crop_to_content, pack_atlas

def _solid(w, h, color=(255, 0, 0, 255)):
    return Image.new("RGBA", (w, h), color)

def test_to_transparent_returns_rgba():
    out = to_transparent(Image.new("RGB", (10, 10), (255, 255, 255)))
    assert out.mode == "RGBA"

def test_crop_to_content_trims_transparent_border():
    img = Image.new("RGBA", (20, 20), (0, 0, 0, 0))
    for x in range(5, 15):
        for y in range(5, 15):
            img.putpixel((x, y), (0, 255, 0, 255))
    out = crop_to_content(img)
    assert out.size == (10, 10)

def test_pack_atlas_manifest_matches_placement():
    frames = {"S/0": _solid(16, 24), "S/1": _solid(16, 24),
              "N/0": _solid(16, 24), "N/1": _solid(16, 24)}
    sheet, manifest = pack_atlas(frames)
    assert manifest["cell"] == [16, 24]
    assert set(manifest["frames"].keys()) == set(frames.keys())
    for key, (x, y, w, h) in manifest["frames"].items():
        assert w == 16 and h == 24
        assert 0 <= x <= sheet.width - w
        assert 0 <= y <= sheet.height - h
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sprite-gen && pytest tests/test_postproc.py -v`
Expected: FAIL.

- [ ] **Step 3: Implement postproc**

`sprite-gen/app/postproc.py`:
```python
import math
from typing import Dict, Tuple
from PIL import Image

def to_transparent(img: Image.Image) -> Image.Image:
    img = img.convert("RGBA")
    try:
        import rembg  # heavy, optional
        import io
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        out = rembg.remove(buf.getvalue())
        return Image.open(io.BytesIO(out)).convert("RGBA")
    except Exception:
        # Fallback: make near-white pixels transparent (good enough for the
        # stub/plain-background prompts; real backends use rembg when installed).
        px = img.load()
        w, h = img.size
        for y in range(h):
            for x in range(w):
                r, g, b, a = px[x, y]
                if r > 240 and g > 240 and b > 240:
                    px[x, y] = (r, g, b, 0)
        return img

def crop_to_content(img: Image.Image) -> Image.Image:
    img = img.convert("RGBA")
    bbox = img.split()[3].getbbox()  # alpha channel bbox
    return img.crop(bbox) if bbox else img

def pack_atlas(frames: Dict[str, Image.Image]) -> Tuple[Image.Image, dict]:
    if not frames:
        return Image.new("RGBA", (1, 1), (0, 0, 0, 0)), {"cell": [0, 0], "frames": {}}
    cell_w = max(f.width for f in frames.values())
    cell_h = max(f.height for f in frames.values())
    keys = sorted(frames.keys())
    cols = math.ceil(math.sqrt(len(keys)))
    rows = math.ceil(len(keys) / cols)
    sheet = Image.new("RGBA", (cols * cell_w, rows * cell_h), (0, 0, 0, 0))
    manifest = {"cell": [cell_w, cell_h], "frames": {}}
    for i, key in enumerate(keys):
        cx = (i % cols) * cell_w
        cy = (i // cols) * cell_h
        sheet.paste(frames[key], (cx, cy))
        manifest["frames"][key] = [cx, cy, frames[key].width, frames[key].height]
    return sheet, manifest
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sprite-gen && pytest tests/test_postproc.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add sprite-gen/app/postproc.py sprite-gen/tests/test_postproc.py
git commit -m "feat(sprite-gen): background removal, content crop, atlas packing"
```

---

### Task 5: Orchestrator (generate a full creature)

**Files:**
- Create: `sprite-gen/app/orchestrator.py`
- Create: `sprite-gen/tests/test_orchestrator.py`

**Interfaces:**
- Consumes: `get_backend`, `pose_for`, `build_prompt`, `to_transparent`, `crop_to_content`, `pack_atlas`, `DIRECTIONS`, `settings`.
- Produces: `app.orchestrator.generate_creature(creature: str, base_prompt: str, backend_name: str, seed: int, n_frames: int, size=(128,160), steps=20, progress=None) -> dict` returning `{"frames": {"<dir>/<frame>": PIL.Image}, "atlas": PIL.Image, "manifest": dict}`. Calls `progress(done, total)` if provided.

- [ ] **Step 1: Write the failing test**

`sprite-gen/tests/test_orchestrator.py`:
```python
from app.orchestrator import generate_creature
from app.config import DIRECTIONS

def test_generates_all_directions_and_frames_with_stub():
    calls = []
    out = generate_creature(
        creature="goblin", base_prompt="a goblin", backend_name="stub",
        seed=7, n_frames=3, size=(64, 80), steps=1,
        progress=lambda d, t: calls.append((d, t)),
    )
    assert set(k.split("/")[0] for k in out["frames"]) == set(DIRECTIONS)
    assert len(out["frames"]) == len(DIRECTIONS) * 3
    assert out["atlas"].mode == "RGBA"
    assert set(out["manifest"]["frames"].keys()) == set(out["frames"].keys())
    assert calls[-1] == (len(DIRECTIONS) * 3, len(DIRECTIONS) * 3)  # progress completed

def test_deterministic_with_stub():
    a = generate_creature("g", "a goblin", "stub", 7, 2, (32, 40), 1)
    b = generate_creature("g", "a goblin", "stub", 7, 2, (32, 40), 1)
    assert list(a["atlas"].getdata()) == list(b["atlas"].getdata())
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sprite-gen && pytest tests/test_orchestrator.py -v`
Expected: FAIL.

- [ ] **Step 3: Implement orchestrator**

`sprite-gen/app/orchestrator.py`:
```python
from typing import Callable, Optional
from .backends import get_backend
from .config import DIRECTIONS
from .poses import pose_for
from .prompts import build_prompt
from .postproc import to_transparent, crop_to_content, pack_atlas

def generate_creature(creature: str, base_prompt: str, backend_name: str,
                      seed: int, n_frames: int, size=(128, 160), steps: int = 20,
                      progress: Optional[Callable[[int, int], None]] = None) -> dict:
    backend = get_backend(backend_name)
    total = len(DIRECTIONS) * n_frames
    done = 0
    raw = {}
    for di, direction in enumerate(DIRECTIONS):
        for frame in range(n_frames):
            pose = pose_for(direction, frame, size)
            prompt = build_prompt(base_prompt, direction, frame)
            # Per-frame seed derived from the creature seed so frames are stable
            # but distinct; direction/frame fold in deterministically.
            frame_seed = seed * 1000 + di * 10 + frame
            img = backend.generate(prompt=prompt, pose=pose, seed=frame_seed,
                                   steps=steps, size=size)
            img = crop_to_content(to_transparent(img))
            raw[f"{direction}/{frame}"] = img
            done += 1
            if progress:
                progress(done, total)
    atlas, manifest = pack_atlas(raw)
    return {"frames": raw, "atlas": atlas, "manifest": manifest}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sprite-gen && pytest tests/test_orchestrator.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add sprite-gen/app/orchestrator.py sprite-gen/tests/test_orchestrator.py
git commit -m "feat(sprite-gen): creature orchestrator (8 dirs x N frames)"
```

---

### Task 6: MinIO storage adapter

**Files:**
- Create: `sprite-gen/app/storage.py`
- Create: `sprite-gen/tests/test_storage.py`

**Interfaces:**
- Produces: `app.storage.SpriteStore` with `put_creature(creature: str, result: dict) -> dict` (uploads each frame PNG, the atlas PNG, and `atlas.json`; returns `{"atlas_key":..., "manifest_key":..., "frame_keys":[...]}`) and `ensure_bucket()`. The MinIO client is injected in the constructor (`SpriteStore(client, bucket)`) so tests use a fake — no real MinIO needed.

- [ ] **Step 1: Write the failing test**

`sprite-gen/tests/test_storage.py`:
```python
import io, json
from PIL import Image
from app.storage import SpriteStore

class FakeMinio:
    def __init__(self): self.objects = {}; self.buckets = set()
    def bucket_exists(self, b): return b in self.buckets
    def make_bucket(self, b): self.buckets.add(b)
    def put_object(self, bucket, key, data, length, content_type=None):
        self.objects[key] = data.read()

def _result():
    frames = {"S/0": Image.new("RGBA", (8, 8), (255, 0, 0, 255))}
    atlas = Image.new("RGBA", (8, 8), (255, 0, 0, 255))
    return {"frames": frames, "atlas": atlas, "manifest": {"cell": [8, 8], "frames": {"S/0": [0, 0, 8, 8]}}}

def test_put_creature_uploads_frames_atlas_and_manifest():
    fake = FakeMinio()
    store = SpriteStore(fake, "sprites")
    out = store.put_creature("goblin", _result())
    assert out["atlas_key"] == "sprites/goblin/atlas.png"
    assert out["manifest_key"] == "sprites/goblin/atlas.json"
    assert "sprites/goblin/S/0.png" in out["frame_keys"]
    assert "sprites/goblin/atlas.png" in fake.objects
    assert "sprites/goblin/S/0.png" in fake.objects
    manifest = json.loads(fake.objects["sprites/goblin/atlas.json"])
    assert manifest["frames"]["S/0"] == [0, 0, 8, 8]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sprite-gen && pytest tests/test_storage.py -v`
Expected: FAIL.

- [ ] **Step 3: Implement storage**

`sprite-gen/app/storage.py`:
```python
import io, json

def _png_bytes(img):
    buf = io.BytesIO()
    img.convert("RGBA").save(buf, format="PNG")
    buf.seek(0)
    return buf, buf.getbuffer().nbytes

class SpriteStore:
    def __init__(self, client, bucket: str):
        self.client = client
        self.bucket = bucket

    def ensure_bucket(self):
        if not self.client.bucket_exists(self.bucket):
            self.client.make_bucket(self.bucket)

    def put_creature(self, creature: str, result: dict) -> dict:
        self.ensure_bucket()
        frame_keys = []
        for name, img in result["frames"].items():
            key = f"{self.bucket}/{creature}/{name}.png"
            data, length = _png_bytes(img)
            self.client.put_object(self.bucket, key, data, length, content_type="image/png")
            frame_keys.append(key)
        atlas_key = f"{self.bucket}/{creature}/atlas.png"
        data, length = _png_bytes(result["atlas"])
        self.client.put_object(self.bucket, atlas_key, data, length, content_type="image/png")
        manifest_key = f"{self.bucket}/{creature}/atlas.json"
        mbytes = json.dumps(result["manifest"]).encode()
        self.client.put_object(self.bucket, manifest_key, io.BytesIO(mbytes), len(mbytes),
                               content_type="application/json")
        return {"atlas_key": atlas_key, "manifest_key": manifest_key, "frame_keys": frame_keys}

def default_store():
    from minio import Minio
    from .config import settings
    client = Minio(settings.minio_endpoint, access_key=settings.minio_access_key,
                   secret_key=settings.minio_secret_key, secure=settings.minio_secure)
    return SpriteStore(client, settings.minio_bucket)
```
Note: the test's `FakeMinio.put_object` reads `data`; the real Minio client signature is `put_object(bucket, key, data, length, content_type=...)` — matches.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sprite-gen && pytest tests/test_storage.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sprite-gen/app/storage.py sprite-gen/tests/test_storage.py
git commit -m "feat(sprite-gen): MinIO sprite storage adapter"
```

---

### Task 7: Job manager + generate/status API

**Files:**
- Create: `sprite-gen/app/jobs.py`
- Modify: `sprite-gen/app/main.py`
- Create: `sprite-gen/tests/test_api.py`

**Interfaces:**
- Produces:
  - `app.jobs.JobManager` — `submit(fn) -> job_id`; `get(job_id) -> dict` (`{"id","status","progress":{"done","total"},"result","error"}`); statuses `queued|running|done|error`. Single worker thread (serialize CPU work). Injected store optional.
  - API: `POST /generate` body `{creature, base_prompt, backend?, seed?, frames?, size?, steps?}` → `202 {"job_id"}`. Unknown `backend` → `400`. `GET /jobs/{id}` → job dict. `GET /backends` → `available()`.

- [ ] **Step 1: Write the failing test**

`sprite-gen/tests/test_api.py`:
```python
import time
from fastapi.testclient import TestClient
from app.main import app, job_manager

client = TestClient(app)

def _wait(job_id, timeout=10):
    for _ in range(int(timeout * 20)):
        r = client.get(f"/jobs/{job_id}").json()
        if r["status"] in ("done", "error"):
            return r
        time.sleep(0.05)
    raise AssertionError("job did not finish")

def test_backends_endpoint_lists_all():
    assert client.get("/backends").json() == ["stub", "sd15", "sd-turbo", "sdxl"]

def test_generate_with_stub_completes():
    r = client.post("/generate", json={"creature": "goblin", "base_prompt": "a goblin",
                                        "backend": "stub", "seed": 5, "frames": 2,
                                        "size": [32, 40], "steps": 1})
    assert r.status_code == 202
    job_id = r.json()["job_id"]
    done = _wait(job_id)
    assert done["status"] == "done"
    assert done["progress"]["done"] == done["progress"]["total"] == 16  # 8 dirs x 2

def test_unknown_backend_is_400():
    r = client.post("/generate", json={"creature": "x", "base_prompt": "y", "backend": "nope"})
    assert r.status_code == 400
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sprite-gen && pytest tests/test_api.py -v`
Expected: FAIL.

- [ ] **Step 3: Implement jobs + API**

`sprite-gen/app/jobs.py`:
```python
import threading, queue, uuid

class JobManager:
    def __init__(self):
        self._jobs = {}
        self._q = queue.Queue()
        self._lock = threading.Lock()
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()

    def submit(self, fn) -> str:
        job_id = uuid.uuid4().hex
        with self._lock:
            self._jobs[job_id] = {"id": job_id, "status": "queued",
                                  "progress": {"done": 0, "total": 0},
                                  "result": None, "error": None}
        self._q.put((job_id, fn))
        return job_id

    def _set(self, job_id, **kw):
        with self._lock:
            self._jobs[job_id].update(kw)

    def _progress(self, job_id):
        def cb(done, total):
            with self._lock:
                self._jobs[job_id]["progress"] = {"done": done, "total": total}
        return cb

    def _run(self):
        while True:
            job_id, fn = self._q.get()
            self._set(job_id, status="running")
            try:
                result = fn(self._progress(job_id))
                self._set(job_id, status="done", result=result)
            except Exception as e:  # noqa: BLE001 - report any failure to the client
                self._set(job_id, status="error", error=str(e))
            finally:
                self._q.task_done()

    def get(self, job_id):
        with self._lock:
            return dict(self._jobs.get(job_id)) if job_id in self._jobs else None
```
`sprite-gen/app/main.py` (replace file):
```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sprite-gen && pytest tests/test_api.py -v`
Expected: PASS (3 tests). Full suite: `pytest` → all green (`-m "not slow"` default).

- [ ] **Step 5: Commit**

```bash
git add sprite-gen/app/jobs.py sprite-gen/app/main.py sprite-gen/tests/test_api.py
git commit -m "feat(sprite-gen): background job manager + generate/status API"
```

---

### Task 8: Real backends — SD 1.5 + ControlNet, SD-Turbo, SDXL

**Files:**
- Create: `sprite-gen/app/backends/sd15.py`, `sd_turbo.py`, `sdxl.py`
- Create: `sprite-gen/tests/test_real_backends.py`

**Interfaces:**
- Produces three `Backend` implementations. Each imports torch/diffusers **inside** `__init__`/`generate` (lazy). Each exposes a `_build_pipeline()` seam so tests can monkeypatch it and assert wiring (prompt, control image, seed, steps, device) without downloading weights.

**Design note (frame consistency & selection):** `sd15` and `sdxl` pass the pose skeleton to a ControlNet (openpose) and use a fixed generator seed. `sd-turbo` runs 1–4 steps for speed; ControlNet support is weaker, so it uses img2img on the pose as a soft guide and documents reduced directional fidelity. All three honor `DEVICE`.

- [ ] **Step 1: Write the failing test (wiring via monkeypatch, no downloads)**

`sprite-gen/tests/test_real_backends.py`:
```python
import pytest
from PIL import Image
from app.backends.sd15 import SD15Backend

class FakePipe:
    def __init__(self): self.calls = []
    def __call__(self, prompt=None, image=None, num_inference_steps=None,
                 generator=None, **kw):
        self.calls.append({"prompt": prompt, "steps": num_inference_steps,
                           "has_control": image is not None})
        class R: images = [Image.new("RGB", (64, 80), (10, 20, 30))]
        return R()

def test_sd15_wires_prompt_control_and_steps(monkeypatch):
    fake = FakePipe()
    b = SD15Backend()
    monkeypatch.setattr(b, "_build_pipeline", lambda: fake)
    pose = Image.new("RGB", (64, 80), (0, 0, 0))
    out = b.generate(prompt="goblin facing S", pose=pose, seed=3, steps=8, size=(64, 80))
    assert out.size == (64, 80)
    assert fake.calls[0]["prompt"] == "goblin facing S"
    assert fake.calls[0]["steps"] == 8
    assert fake.calls[0]["has_control"] is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sprite-gen && pytest tests/test_real_backends.py -v`
Expected: FAIL (no `sd15` module).

- [ ] **Step 3: Implement the three backends**

`sprite-gen/app/backends/sd15.py`:
```python
from typing import Optional, Tuple
from PIL import Image
from ..config import settings

class SD15Backend:
    name = "sd15"

    def __init__(self):
        self._pipe = None

    def _build_pipeline(self):
        # Imported lazily; downloads weights on first real use.
        import torch
        from diffusers import StableDiffusionControlNetPipeline, ControlNetModel
        controlnet = ControlNetModel.from_pretrained("lllyasviel/sd-controlnet-openpose")
        pipe = StableDiffusionControlNetPipeline.from_pretrained(
            "runwayml/stable-diffusion-v1-5", controlnet=controlnet, safety_checker=None,
        )
        pipe = pipe.to(settings.device)
        return pipe

    def _pipeline(self):
        if self._pipe is None:
            self._pipe = self._build_pipeline()
        return self._pipe

    def generate(self, prompt: str, pose: Optional[Image.Image], seed: int,
                 steps: int, size: Tuple[int, int]) -> Image.Image:
        import torch
        pipe = self._pipeline()
        gen = torch.Generator(device=settings.device).manual_seed(seed)
        control = (pose or Image.new("RGB", size, (0, 0, 0))).resize(size)
        result = pipe(prompt=prompt, image=control, num_inference_steps=steps, generator=gen)
        return result.images[0].convert("RGBA").resize(size)
```
`sprite-gen/app/backends/sd_turbo.py`:
```python
from typing import Optional, Tuple
from PIL import Image
from ..config import settings

class SDTurboBackend:
    name = "sd-turbo"

    def __init__(self):
        self._pipe = None

    def _build_pipeline(self):
        import torch
        from diffusers import AutoPipelineForImage2Image
        pipe = AutoPipelineForImage2Image.from_pretrained("stabilityai/sd-turbo",
                                                          safety_checker=None)
        return pipe.to(settings.device)

    def _pipeline(self):
        if self._pipe is None:
            self._pipe = self._build_pipeline()
        return self._pipe

    def generate(self, prompt: str, pose: Optional[Image.Image], seed: int,
                 steps: int, size: Tuple[int, int]) -> Image.Image:
        import torch
        pipe = self._pipeline()
        gen = torch.Generator(device=settings.device).manual_seed(seed)
        # sd-turbo has weak ControlNet support; use the pose as a soft img2img
        # init so direction still influences the result. 1-4 steps.
        init = (pose or Image.new("RGB", size, (127, 127, 127))).resize(size)
        n = max(1, min(steps, 4))
        result = pipe(prompt=prompt, image=init, num_inference_steps=n,
                      strength=0.7, guidance_scale=0.0, generator=gen)
        return result.images[0].convert("RGBA").resize(size)
```
`sprite-gen/app/backends/sdxl.py`:
```python
from typing import Optional, Tuple
from PIL import Image
from ..config import settings

class SDXLBackend:
    name = "sdxl"

    def __init__(self):
        self._pipe = None

    def _build_pipeline(self):
        import torch
        from diffusers import StableDiffusionXLControlNetPipeline, ControlNetModel
        controlnet = ControlNetModel.from_pretrained("thibaud/controlnet-openpose-sdxl-1.0")
        pipe = StableDiffusionXLControlNetPipeline.from_pretrained(
            "stabilityai/stable-diffusion-xl-base-1.0", controlnet=controlnet,
        )
        return pipe.to(settings.device)

    def _pipeline(self):
        if self._pipe is None:
            self._pipe = self._build_pipeline()
        return self._pipe

    def generate(self, prompt: str, pose: Optional[Image.Image], seed: int,
                 steps: int, size: Tuple[int, int]) -> Image.Image:
        import torch
        pipe = self._pipeline()
        gen = torch.Generator(device=settings.device).manual_seed(seed)
        control = (pose or Image.new("RGB", size, (0, 0, 0))).resize(size)
        result = pipe(prompt=prompt, image=control, num_inference_steps=steps, generator=gen)
        return result.images[0].convert("RGBA").resize(size)
```

- [ ] **Step 4: Run the wiring test to verify it passes**

Run: `cd sprite-gen && pytest tests/test_real_backends.py -v`
Expected: PASS (1 test, no downloads — pipeline monkeypatched).

- [ ] **Step 5: Add an opt-in real smoke test (skipped by default)**

Append to `sprite-gen/tests/test_real_backends.py`:
```python
@pytest.mark.slow
def test_sd_turbo_real_generation():
    # Only runs with `pytest -m slow`; downloads sd-turbo (~2.5GB) and runs on CPU.
    from app.backends.sd_turbo import SDTurboBackend
    b = SDTurboBackend()
    img = b.generate(prompt="a goblin, isometric sprite", pose=None, seed=1,
                     steps=2, size=(128, 160))
    assert img.size == (128, 160) and img.mode == "RGBA"
```

- [ ] **Step 6: Run full default suite (slow skipped)**

Run: `cd sprite-gen && pytest -v`
Expected: all non-slow tests pass; the `slow` test is deselected.

- [ ] **Step 7: Commit**

```bash
git add sprite-gen/app/backends/sd15.py sprite-gen/app/backends/sd_turbo.py sprite-gen/app/backends/sdxl.py sprite-gen/tests/test_real_backends.py
git commit -m "feat(sprite-gen): SD1.5+ControlNet, SD-Turbo, SDXL backends (lazy, device-aware)"
```

---

### Task 9: Dockerfile + compose wiring

**Files:**
- Create: `sprite-gen/Dockerfile`
- Modify: `compose/docker-compose.yml`

**Interfaces:**
- Produces: a `sprite-gen` compose service (host `18100`→`8100`), `DEVICE=cpu`, `SPRITE_BACKEND=stub`, `SPRITE_STORE_ENABLED=true`, MinIO env, a named volume `sprite-models:/root/.cache/huggingface` for weight cache, `depends_on: [minio]`. Backend service gains `SPRITE_GEN_URL=http://sprite-gen:8100`.

- [ ] **Step 1: Write the Dockerfile**

`sprite-gen/Dockerfile`:
```dockerfile
FROM python:3.11-slim

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY sprite-gen/requirements.txt sprite-gen/requirements-dev.txt ./
# CPU-only torch wheels by default; swap the index for CUDA when a GPU lands.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.3.* \
    && pip install --no-cache-dir -r requirements.txt

COPY sprite-gen/ .

EXPOSE 8100
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
```

- [ ] **Step 2: Add the compose service**

In `compose/docker-compose.yml`, add under `services:` (match existing indentation/style):
```yaml
  sprite-gen:
    build:
      context: .
      dockerfile: sprite-gen/Dockerfile
    ports:
      - "18100:8100"
    environment:
      - DEVICE=cpu
      - SPRITE_BACKEND=stub
      - SPRITE_STORE_ENABLED=true
      - N_FRAMES=4
      - MINIO_ENDPOINT=minio:9000
      - MINIO_ACCESS_KEY=minioadmin
      - MINIO_SECRET_KEY=minioadmin
      - MINIO_BUCKET=sprites
    volumes:
      - sprite-models:/root/.cache/huggingface
    depends_on:
      - minio
```
Add `SPRITE_GEN_URL=http://sprite-gen:8100` to the `backend` service `environment:` list, and add `sprite-models:` under the top-level `volumes:` block.

- [ ] **Step 3: Validate compose parses**

Run: `docker compose --project-directory . --env-file .env -f compose/docker-compose.yml config >/dev/null && echo OK`
Expected: `OK` (no build; just config validation).

- [ ] **Step 4: Commit**

```bash
git add sprite-gen/Dockerfile compose/docker-compose.yml
git commit -m "feat(sprite-gen): Dockerfile + docker-compose service (CPU default, model cache volume)"
```

---

### Task 10: Postgres migration + Node backend admin bridge

**Files:**
- Create: `backend/migrations/1714440009000_create_sprite_sets.js`
- Modify: `backend/src/index.js` (add sprite routes + minio-free HTTP bridge to sprite-gen)
- Create: `backend/src/services/spriteGen.js`
- Modify: `backend/package.json` (no new deps — uses global `fetch` in Node 18+; confirm Node version)
- Create: `backend/tests/sprite.test.js` (+ add a `test` script and `supertest`/`node:test` — see step)

**Interfaces:**
- Produces (Express, CommonJS, existing error shape):
  - `POST /api/sprite-jobs` `{entity_type, base_prompt, backend, frames, seed}` → calls sprite-gen `POST /generate`, inserts a `sprite_sets` row (status `queued`), returns `201 {id, job_id}`.
  - `GET /api/sprite-jobs/:jobId` → proxies sprite-gen `GET /jobs/:jobId`.
  - `POST /api/entity-types/:id/sprite` `{atlas_key, manifest_key, backend, seed}` → marks a `sprite_sets` row `approved` and links it to the entity type; returns the row.
  - `backend/src/services/spriteGen.js`: `postGenerate(body)` / `getJob(jobId)` wrapping `fetch(`${SPRITE_GEN_URL}...`)`.

- [ ] **Step 1: Write the migration**

`backend/migrations/1714440009000_create_sprite_sets.js`:
```js
exports.up = (pgm) => {
  pgm.createTable("sprite_sets", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    creature: { type: "text", notNull: true },
    entity_type_id: { type: "uuid", references: "entity_types", onDelete: "SET NULL" },
    backend: { type: "text", notNull: true },
    seed: { type: "integer", notNull: true, default: 0 },
    frames: { type: "integer", notNull: true, default: 4 },
    job_id: { type: "text" },
    atlas_key: { type: "text" },
    manifest_key: { type: "text" },
    status: { type: "text", notNull: true, default: "queued" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
};

exports.down = (pgm) => pgm.dropTable("sprite_sets");
```
(If `entity_types` PK is not `uuid`, match its type — verify with `\d entity_types` first and adjust the `entity_type_id` type accordingly.)

- [ ] **Step 2: Write the failing test**

Add a test runner. In `backend/package.json` add `"test": "node --test"` and devDependency `supertest`. Then `backend/tests/sprite.test.js`:
```js
const test = require("node:test");
const assert = require("node:assert");
const request = require("supertest");

// The app must be exported from index.js for testing (see Step 4).
process.env.SPRITE_GEN_URL = "http://sprite-gen.test";
const { app, __setSpriteGen } = require("../src/index.js");

test("POST /api/sprite-jobs proxies to sprite-gen and records a row", async () => {
  __setSpriteGen({
    postGenerate: async () => ({ job_id: "job-123" }),
    getJob: async () => ({ id: "job-123", status: "running" }),
  });
  const res = await request(app)
    .post("/api/sprite-jobs")
    .send({ entity_type: "goblin", base_prompt: "a goblin", backend: "stub", frames: 4, seed: 1 });
  assert.equal(res.status, 201);
  assert.ok(res.body.job_id === "job-123");
});

test("GET /api/sprite-jobs/:id proxies status", async () => {
  __setSpriteGen({ postGenerate: async () => ({}), getJob: async () => ({ status: "done" }) });
  const res = await request(app).get("/api/sprite-jobs/job-123");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "done");
});
```
(These tests require a test DB or a mockable `pool`. If wiring a test DB is out of scope, gate the DB insert behind an injectable `__setPool` seam mirroring `__setSpriteGen`, and assert only the proxy behavior — keep the DB path covered by a manual check in Step 5.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && npm install -D supertest && npm test`
Expected: FAIL (routes/exports not present).

- [ ] **Step 4: Implement the service + routes + test seams**

`backend/src/services/spriteGen.js`:
```js
const BASE = () => process.env.SPRITE_GEN_URL || "http://sprite-gen:8100";

async function postGenerate(body) {
  const res = await fetch(`${BASE()}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sprite-gen /generate ${res.status}`);
  return res.json();
}

async function getJob(jobId) {
  const res = await fetch(`${BASE()}/jobs/${jobId}`);
  if (!res.ok) throw new Error(`sprite-gen /jobs ${res.status}`);
  return res.json();
}

module.exports = { postGenerate, getJob };
```
In `backend/src/index.js`: require the service into a mutable holder, add the three routes following the existing try/catch error shape, export `app` and the `__setSpriteGen` seam. Sketch:
```js
let spriteGen = require("./services/spriteGen");
const __setSpriteGen = (impl) => { spriteGen = impl; };

app.post("/api/sprite-jobs", async (req, res) => {
  try {
    const { entity_type, base_prompt, backend = "stub", frames = 4, seed = 0 } = req.body;
    const gen = await spriteGen.postGenerate({ creature: entity_type, base_prompt, backend, frames, seed });
    const row = await pool.query(
      `INSERT INTO sprite_sets (creature, backend, seed, frames, job_id, status)
       VALUES ($1,$2,$3,$4,$5,'queued') RETURNING *`,
      [entity_type, backend, seed, frames, gen.job_id],
    );
    res.status(201).json({ ...row.rows[0], job_id: gen.job_id });
  } catch (err) { console.error(err); res.status(500).json({ error: "failed to start sprite job" }); }
});

app.get("/api/sprite-jobs/:jobId", async (req, res) => {
  try { res.json(await spriteGen.getJob(req.params.jobId)); }
  catch (err) { console.error(err); res.status(500).json({ error: "failed to fetch job" }); }
});

app.post("/api/entity-types/:id/sprite", async (req, res) => {
  try {
    const { atlas_key, manifest_key, backend, seed } = req.body;
    const row = await pool.query(
      `UPDATE sprite_sets SET atlas_key=$1, manifest_key=$2, status='approved', entity_type_id=$3
       WHERE job_id=$4 RETURNING *`,
      [atlas_key, manifest_key, req.params.id, req.body.job_id],
    );
    if (!row.rows[0]) return res.status(404).json({ error: "sprite set not found" });
    res.json(row.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: "failed to save sprite" }); }
});

module.exports = { app, __setSpriteGen };
```
Ensure `app.listen(...)` only runs when `require.main === module` (so tests can import without starting the server).

- [ ] **Step 5: Run tests + a manual DB check**

Run: `cd backend && npm test` → proxy tests pass. Manual: with the stack up (`make up` + backend started), `curl -XPOST localhost:13101/api/sprite-jobs -H 'Content-Type: application/json' -d '{"entity_type":"goblin","base_prompt":"a goblin","backend":"stub","frames":2}'` returns 201 with a `job_id`; poll `GET /api/sprite-jobs/<job_id>` to `done`.

- [ ] **Step 6: Commit**

```bash
git add backend/migrations/1714440009000_create_sprite_sets.js backend/src/index.js backend/src/services/spriteGen.js backend/package.json backend/package-lock.json backend/tests
git commit -m "feat(backend): sprite-gen admin bridge + sprite_sets migration"
```

---

### Task 11: Admin UI — sprite panel in EntityTypesAdmin

**Files:**
- Modify: `frontend/src/games/something2/EntityTypesAdmin.jsx`
- Create: `frontend/src/games/something2/useSprites.js` (TanStack Query hooks, per the frontend styleguide)

**Interfaces:**
- Consumes: backend routes from Task 10; `import.meta.env.VITE_API_URL`.
- Produces:
  - `useSprites.js`: `useGenerateSprite()` (mutation → `POST /api/sprite-jobs`), `useSpriteJob(jobId)` (polling query → `GET /api/sprite-jobs/:jobId`, `refetchInterval` while not done), `useApproveSprite()` (mutation → `POST /api/entity-types/:id/sprite`).
  - In `EntityTypesAdmin.jsx`: a "Sprites" panel per entity type with a **backend `<select>` (stub / sd15 / sd-turbo / sdxl)**, frames input, prompt textarea, Generate button, a progress readout (done/total), a preview grid (atlas via a backend/MinIO URL), and an Approve button.

- [ ] **Step 1: Write the data hooks**

Create `frontend/src/games/something2/useSprites.js` following the pattern in `useMaps.js` (named exports, `import.meta.env.VITE_API_URL` base, `toast` on success/error, `invalidateQueries`). Include:
```js
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";

const API = import.meta.env.VITE_API_URL || "http://localhost:13101";

export function useGenerateSprite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body) => {
      const res = await fetch(`${API}/api/sprite-jobs`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("failed to start sprite job");
      return res.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["sprite-jobs"] }); toast.success("Sprite job started"); },
    onError: (e) => toast.error(`Sprite job failed: ${e.message}`),
  });
}

export function useSpriteJob(jobId) {
  return useQuery({
    queryKey: ["sprite-jobs", jobId],
    enabled: !!jobId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "done" || s === "error" ? false : 1000;
    },
    queryFn: async () => {
      const res = await fetch(`${API}/api/sprite-jobs/${jobId}`);
      if (!res.ok) throw new Error("failed to fetch sprite job");
      return res.json();
    },
  });
}

export function useApproveSprite() {
  return useMutation({
    mutationFn: async ({ entityTypeId, ...body }) => {
      const res = await fetch(`${API}/api/entity-types/${entityTypeId}/sprite`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("failed to approve sprite");
      return res.json();
    },
    onSuccess: () => toast.success("Sprite approved"),
    onError: (e) => toast.error(e.message),
  });
}
```

- [ ] **Step 2: Add the sprite panel to EntityTypesAdmin.jsx**

Add a collapsible "Sprites" section per entity type using the hooks. The backend selector:
```jsx
<select value={backend} onChange={(e) => setBackend(e.target.value)}>
  <option value="stub">stub (instant placeholder)</option>
  <option value="sd15">SD 1.5 + ControlNet</option>
  <option value="sd-turbo">SD-Turbo (fast)</option>
  <option value="sdxl">SDXL + ControlNet</option>
</select>
```
Wire Generate → `useGenerateSprite().mutate({ entity_type, base_prompt, backend, frames, seed })`, store the returned `job_id`, feed it to `useSpriteJob(jobId)`, show `progress.done/progress.total`, and on `status==="done"` show the atlas preview + an Approve button calling `useApproveSprite()`. Match the in-game dark palette already used in this file (hardcoded hex is intentional here per the frontend styleguide).

- [ ] **Step 3: Lint + build**

Run: `cd frontend && npm run lint && npm run build`
Expected: no new lint errors; build succeeds.

- [ ] **Step 4: Manual verification**

With the full stack up (Task 9 service running, backend started), open the Entity Admin tab, pick an entity type, choose `stub`, set frames=2, prompt "a goblin", Generate → watch progress reach done → preview renders → Approve → toast + `sprite_sets` row `approved`. (Real backends only if the user later opts into downloads.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/EntityTypesAdmin.jsx frontend/src/games/something2/useSprites.js
git commit -m "feat(frontend): sprite generation admin panel with backend selector"
```

---

## Self-Review

**Spec coverage (sub-project D from the design spec):**
- Separate Python container, local SD, CPU-first with `DEVICE` switch → Tasks 1, 8, 9. ✓
- **All three backends, runtime-selectable** (+ stub default) → Tasks 2, 7, 8, 11 (selector in API and UI). ✓ (user decision)
- 8 facings × N frames, seed + ControlNet pose consistency → Tasks 3, 5, 8. ✓
- Post-processing (bg removal, crop, atlas) → Task 4. ✓
- HTTP API `POST /generate`, `GET /jobs/:id`, background jobs → Task 7. ✓
- MinIO storage `sprites/<creature>/...` + atlas + Postgres metadata → Tasks 6, 10. ✓
- Backend admin endpoint + job tracking → Task 10. ✓
- Admin UI in EntityTypesAdmin.jsx → Task 11. ✓
- docker-compose service → Task 9. ✓
- Admin-only, never player-facing, background jobs → enforced by design (Task 7 job manager; UI is admin). ✓

**Placeholder scan:** none — every code step has concrete content; the only deferred item is opt-in real model weights, which is intentional and flagged.

**Type/name consistency:** `Backend.generate(prompt, pose, seed, steps, size)` defined in Task 2, used identically in orchestrator (Task 5) and all real backends (Task 8). `get_backend`/`available()` (Task 2) used in Tasks 7. `generate_creature(...)` (Task 5) called in Task 7. `SpriteStore.put_creature` (Task 6) called in Task 7's `work`. `SPRITE_GEN_URL`/`postGenerate`/`getJob` (Task 10) consumed by Task 11 hooks. Backend names `stub|sd15|sd-turbo|sdxl` consistent across registry, API validation, and the UI `<select>`.

**Testability without GPU:** every logic task is tested via `stub` + injected fakes/monkeypatch; heavy libs lazy-imported; real-model test is `@pytest.mark.slow` (skipped by default). The whole plan is executable and green without downloading any weights.

**Open items to confirm at execution time (not blockers):**
- `entity_types` PK type for the FK in Task 10's migration (verify with `\d entity_types`).
- Node version ≥18 for global `fetch` in the backend (Task 10); if older, add `node-fetch`.
- Preview image URL strategy in Task 11 (backend proxy vs MinIO presigned URL) — pick the backend-proxy route if MinIO isn't reachable from the browser; add a `GET /api/sprites/:creature/atlas.png` proxy if needed.
