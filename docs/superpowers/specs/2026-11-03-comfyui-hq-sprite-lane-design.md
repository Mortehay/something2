# High-quality sprite lane: ComfyUI + less-quantized Qwen-Image-Edit — design

Date: 2026-11-03. Owner: user. Builders: the GPU-box session (box side) and the something2 session (game side).

## Intent

Warrior appearance 2 has taken a week of sprite work and still shows melted faces, an extra leg, and poses that ignore the text. The GPU box draws every frame with Qwen-Image-Edit-2511 at **Q2_K** (2-bit GGUF) through diffusers, at 512 px, with the 4-step Lightning LoRA. The user wants a **second, high-quality lane**: a different engine (ComfyUI) running a bigger, less-quantized version of the same Qwen edit model. Quality matters far more than speed; hours per sheet are acceptable.

The user explicitly does **not** want more tuning of the current lane. The current lane stays exactly as it is.

## Goals

1. A ComfyUI-based drawing engine on the GPU box, running Qwen-Image-Edit-2511 at clearly higher precision than Q2_K, with the overflow offloaded to system RAM.
2. The box's existing sheet pipeline (concept → 8-direction turnaround with the Multiple-Angles LoRA → per-frame pose edits → cutout → QA → pixelate/atlas) uses ComfyUI for the drawing steps when a job asks for the HQ engine. Everything else in the box pipeline is unchanged and shared.
3. something2 gets it as **its own connector** (a second `ai_providers` row, modality `sprite`) next to today's GPU box connector. In the Sprite tab the user picks which connector draws a sheet.
4. First real use: redraw Warrior 2 with the HQ connector and compare it side by side with today's sheet.

## Non-goals

- Changing or tuning the current Q2_K lane (default model, steps, Lightning, prompts).
- Another image model (FLUX, Qwen-Image-2.1, …), a cloud service, or a 3D-proxy pipeline. These are possible later; not this project.
- something2 talking to ComfyUI directly or re-implementing the sheet pipeline on the game side.
- New QA checks (anatomy, VLM). The box's existing checks apply unchanged.

## Anti-goals (would make this a failure even if it "works")

- The HQ lane silently falls back to Q2_K (or to diffusers) and the user believes they are looking at HQ output. Every HQ sheet must prove which engine and model drew it.
- ComfyUI takes the card outside the box's `model_gateway`, colliding with other jobs (this happened today with a `docker exec` run: 36 MiB free).
- Mixing standard-lane and HQ-lane cells in one sheet without the user choosing it.
- Breaking the current lane, its connector, or existing sheets.

## Constraints (measured on the box, 2026-11-03)

- GPU RTX 3060 12 GB (sm_86), CUDA 13.0, torch 2.14; 41 GiB RAM in WSL (~35 free); Ryzen 5 5500. Disk: C: 91 GB free (models today), D: 155 GB free (use for the new model set).
- The card is shared and arbitrated by the box's `model_gateway` (one active model, Celery `--pool=solo`). The brain (llama-server, ~8.3 GB) must never share the card with a transformer. **ComfyUI must be registered in `model_gateway.GATED`** and only hold the card while gated.
- The Multiple-Angles LoRA is trained for Qwen-Image-Edit-2511 and is what pins the camera per direction; the HQ lane must keep it (it loads on any precision — both LoRAs are bf16 adapters, confirmed on Q3_K_S and Q6_K).
- Known data points: Q6_K with diffusers group offload ran a full sheet at 68.8 s/cell (6 h 51 for 210 cells). Pydantic on the box silently drops unknown JobSpec fields (the `real_western` trap) — any new spec field must be declared and echoed back.

## Decided

- **Engine:** ComfyUI on the box, as a gated service, driven by the box pipeline through ComfyUI's HTTP/WebSocket workflow API.
- **Model:** Qwen-Image-Edit-2511 at higher precision than Q2_K — FP8 (e4m3fn) or Q8_0 GGUF, with ComfyUI's offload; plus the existing Multiple-Angles LoRA.
- **Integration point:** swap only the drawing engine inside the box's sheet pipeline (user's choice, over driving ComfyUI from something2).
- **something2 surface:** a separate connector; the current connector stays the default and unchanged.

## Design — box side (built by the box session)

1. **Install** ComfyUI (pinned version) + ComfyUI-GGUF on the box, model files on D:. Run it as a service the box pipeline calls; it loads the model only while the gateway has granted the card, and frees VRAM when released.
2. **JobSpec field `engine`**: `"diffusers"` (default; today's behaviour, byte-for-byte) or `"comfyui-hq"`. Declared in the Pydantic model (never dropped silently). An unknown value → 4xx.
3. **Stage swap:** turnaround (8 directions) and action-frame stages call ComfyUI workflows when `engine = "comfyui-hq"`; cutout (BiRefNet), QA, redraw rounds, pixelate and atlas are shared code. Frame redraw (`/redraw`) of an HQ job uses the HQ engine too.
4. **Provenance:** the atlas and the job status echo `engine`, the exact model file, precision, steps, CFG and LoRAs used. If ComfyUI is unavailable the job fails with a clear message — never falls back.
5. **Gateway:** `comfyui-hq` registered in `model_gateway.GATED`; a busy card gives the same 503 + `Retry-After` / `x-error-kind: vram_busy` as today.
6. **Before declaring it ready:** one single-direction smoke render, then one full Warrior 2 idle sheet; report s/cell, peak VRAM and RAM, and whether the Angles LoRA holds the camera.

## Design — something2 side (built by the something2 session)

1. **Connector:** admins create a second `ai_providers` row, modality `sprite`, same box `base_url`/token, with `request_template.engine = "comfyui-hq"` (validated against `["diffusers","comfyui-hq"]`; absent = diffusers). Shown in AI Providers like any connector.
2. **Choosing per batch:** today one sprite connector is active at a time. Add a **Connector** select to the Sprite tab listing enabled sprite connectors (default: the active one). Queue stores the choice on the row (`sprite_sets.provider_id`, already a column; set at enqueue instead of only at attach). The dispatcher draws each row with its own connector (fallback: the active one for rows queued before this change). A change of connector on a queued row is an options change (detaches the box job), like cell size.
3. **Spec:** `sheetSpec` sends `engine` from the row's connector. Intake checks the box echoed the same `engine` (like `assertCellMatches`); a mismatch fails the row ("the GPU box drew this with X, the row asked for Y").
4. **Reuse:** a base sheet is reused only when it was drawn by the same engine (stored in its manifest) — standard and HQ cells never mix automatically. Keep-and-add, Redraw selected actions and frame redraw otherwise work unchanged within one engine.
5. **Visibility:** the Sprite tab row shows which connector drew a sheet (Backend column: "gpu-box · HQ"), and the time estimate uses that connector's own measured seconds per cell.

## Calls made after the builder check (author's calls, not the user's — flagged for review)

1. **Same concept on both lanes.** The concept image comes from the Entity tab's own model roster, not from the sheet engine, so it is shared. The kept-concept check in `submit` (today: same `provider_id` and same box origin) is relaxed to **same box origin**, so the HQ connector reuses Warrior 2's kept concept and the comparison is the same character drawn by two engines. The manifest records the concept's source unchanged; "HQ" describes the turnaround and frame stages only.
2. **`engine` is a second key** in a sprite connector's `request_template`, next to `sheet_method`. `comfyui-hq` is valid only with `sheet_method` `2d` (absent counts as 2d); `comfyui-hq` + `turnaround3d` is rejected at connector save. Props (one txt2img image) ignore `engine` and keep using the standard path.
3. **Per-row connector.** Enqueue stores the chosen connector in `sprite_sets.provider_id`. If that connector is disabled or deleted before the row runs, the row **fails** with "the connector chosen for this row is no longer enabled" — no fallback to the active connector (anti-goal: silent engine swap). Rows queued before this change (provider_id NULL) use the active connector, as today. Redraw children, frame redraws and "Redraw selected actions" always use the row's own connector. A connector change on a queued row is an options change (detaches the box job), exactly like cell size.
4. **Reuse across engines.** `findBase` accepts only a base whose manifest `engine` equals the row's engine (a manifest without `engine` = `diffusers`). With no same-engine base the sheet is drawn whole; nothing is carried from the other lane.
5. **Long jobs.** The something2 poll deadline already scales with cells × per-cell time; the per-cell estimate becomes **per connector** (median `sheet_seconds / cells` of that connector's done rows; with none yet, 70 s/cell for `comfyui-hq`). The box session owns making 7-hour jobs safe on its side (Redis `visibility_timeout` re-runs jobs over 1 h today).
6. **Box contract** (the box session may rename, then something2 follows): JobSpec `engine`; the atlas and `GET /job` echo `engine: { name, model_file, precision, steps, cfg, loras: [...] }`; an unknown or unavailable engine answers **422** with `x-error-kind: engine_unavailable` (not retryable), distinct from `vram_busy` 503.
7. **No seed or migration for the connector row:** the admin creates it in AI Providers (same box URL and token, Engine = HQ). The Sprite tab hides the Connector select when only one sprite connector is enabled.

## Left to the builders

- FP8 vs Q8_0 (and steps/CFG/negative prompt/resolution for the HQ workflow): the box session picks by a short smoke comparison and records why. The user's direction: maximum quality the card can do in reasonable hours; Lightning is not required on this lane.
- ComfyUI process model (always-running vs started per job), as long as it is gated.
- Exact UI wording and placement.

## Success

- An HQ Warrior 2 sheet exists whose manifest names the HQ engine and model, drawn without any card collision.
- The user, comparing it with today's sheet, judges faces and limbs clearly better.
- The current lane, its sheets and its connector behave exactly as before.
