---
name: local-ai-dev
description: Use when working on the local AI sprite-generation tooling — Stable Diffusion in a Python container, CPU-first with a CUDA switch. (Tool built in a later sub-project; this captures the ground rules.)
---

# Local AI dev (something2)

The sprite generator is a **separate Python container** (`sprite-gen/`, built in sub-project D), not part of the Node backend. It runs Stable Diffusion locally via `diffusers`.

Ground rules:
- **CPU-first.** A single image is 30s–several minutes on CPU. Never put generation in a request path a user waits on synchronously in the game — it is an **admin, background-job** tool only.
- **Device switch:** all model/device selection goes through a single `DEVICE` env var (`cpu` | `cuda`). Default `cpu`. When a GPU arrives, flipping `DEVICE=cuda` is the only change. Do not hardcode `.to("cpu")` / `.to("cuda")` at call sites.
- **Determinism:** fix the RNG seed per creature so re-runs and multi-frame sets are reproducible. Frame-to-frame consistency uses a fixed seed + ControlNet pose conditioning (see [[sprite-pipeline]]).
- **Isometric target:** output must match the renderer's sprite spec — 8 facings × N walk frames, transparent background, cropped to the iso footprint. See [[sprite-pipeline]] and [[iso-rendering]].
- **Storage:** generated frames go to MinIO (asset storage already in the stack), not committed to git.

This skill is about the *workflow and constraints*; the concrete container and API are specified in sub-project D's plan.
