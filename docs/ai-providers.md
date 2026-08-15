# Remote AI image providers

Generate tile textures and entity sprites on **another machine**.

**The division of labour, which is the thing to remember:**

> This side prepares the request, sends it, waits, receives the response, and
> stores the result locally so it can be used for the entity or tile.
> **Creating the image or sprite happens on the other machine.**

This side never draws anything and never stitches anything. For a multi-frame
sprite it receives a **ready-made sprite sheet** and only works out how to cut
it. That is why no image library is needed here.

Admin UI: **AI Providers** in the sidebar (`/game/settings`). Admin only.

---

## The full round trip

What happens when an admin clicks *Generate texture* or *Generate animation*:

```
 admin clicks Generate
        │
        ▼
 1. POST /api/tile-jobs        (or /api/entity-jobs, /api/sprite-jobs)
    body: { tile_type, base_prompt, frames, biome?, ai_provider_id? }
        │
        ▼
 2. backend resolves WHICH service draws it
    request override → the type's pin → the active provider → local sprite-gen
        │
        ▼
 3. backend builds the outbound body from the provider's saved JSON template,
    substituting {{prompt}} {{model}} {{seed}} {{width}} {{height}} {{frames}}
        │
        ▼
 4. POST <provider.base_url>            ← THE OTHER MACHINE DRAWS IT
    with the optional auth header
        │
        ▼  (up to AI_PROVIDER_GENERATE_TIMEOUT_MS, default 5 min)
 5. response arrives; the image is pulled out at response_image_pointer
        │
        ▼
 6. stored in MinIO under the same key layout sprite-gen uses
        │
        ▼
 7. job flips to done; the admin UI (already polling) shows the preview
        │
        ▼
 8. admin clicks Approve → the key is written onto the tile/entity row
```

Steps 1, 7 and 8 are the pre-existing pipeline, untouched. Only 2–6 are new.

### 1. The job request (browser → this backend)

```http
POST /api/tile-jobs
Authorization: Bearer <admin token>
Content-Type: application/json

{ "tile_type": "grass", "base_prompt": "lush green grass texture", "frames": 1 }
```

Optional keys: `biome` (composes the biome's palette/style into the prompt),
`ai_provider_id` (use this provider for this job only), `ai_provider_local: true`
(force local sprite-gen for this job only).

Response — note the `rmt_` prefix, which is how job polling knows where the job
is running:

```json
{ "job_id": "rmt_0611a3824777a3b6bcd084f1",
  "creature": "grass", "backend": "remote:desktop-gpu",
  "frames": 1, "status": "queued", "provider": "desktop-gpu" }
```

### 2. The generation request (this backend → the other machine)

The saved template with placeholders substituted. **This is the exact body that
goes out** — verified on the wire:

```json
{ "prompt": "lush green grass texture",
  "steps": 20,
  "width": 128,
  "height": 128,
  "seed": 0,
  "override_settings": { "sd_model_checkpoint": "sd_xl_base_1.0" } }
```

`width`/`height` are **numbers, not strings** — a placeholder that is the whole
value keeps its type, because most services reject `"width": "512"` with an
opaque 4xx.

### 3. The expected response (the other machine → this backend)

Either JSON with base64, and `response_image_pointer` says where:

```json
{ "images": ["iVBORw0KGgoAAAANSUhEUgAA…"] }      ← pointer: images[0]
```

…or the raw image as the body (`Content-Type: image/png`), in which case the
pointer is ignored. A `data:image/png;base64,…` prefix is stripped
automatically.

### 4. Polling

```http
GET /api/tile-jobs/rmt_0611a3824777a3b6bcd084f1
```

```json
{ "id": "rmt_…", "status": "done", "progress": {"done":1,"total":1},
  "result": { "image_key": "sprites/tiles/grass/rmt_…/static.png", "frames": 1 },
  "error": null }
```

Identical in shape to a local sprite-gen job, so the admin UI needs no special
case. `status` is `queued` | `running` | `done` | `error`.

### 5. Where it is stored

Same layout `sprite-gen` writes, so `GET /api/assets/<key>` serves it unchanged:

```
sprites/tiles/<name>/<job_id>/static.png     static tile
sprites/objects/<name>/<job_id>/static.png   static object/entity
sprites/tiles/<name>/<job_id>/atlas.png      sprite sheet (animated)
sprites/tiles/<name>/<job_id>/atlas.json     its frame manifest
```

Keys are job-id scoped, so a regeneration can never overwrite a previous,
possibly already-approved, asset.

---

## Configuring a provider

| Field | Meaning |
|---|---|
| `Base URL` | The full URL that generates an image, e.g. `http://192.168.1.20:7860/sdapi/v1/txt2img` |
| `Auth header` / token | Optional, sent only when both are set. The token is **never returned** by the API — the form shows "stored" instead |
| `Request template` | The POST body, verbatim, with placeholders |
| `Models path` | Appended to the base URL's origin for discovery, e.g. `/sdapi/v1/sd-models` |
| `Models pointer` | Where the names are in that response, e.g. `$[*].model_name` |
| `Image pointer` | Where the image is in the generate response, e.g. `images[0]`; blank if the body *is* the image |
| `Sprite sheet` | Layout + grid for multi-frame results — see below |

### Placeholders

`{{prompt}}` `{{model}}` `{{seed}}` `{{width}}` `{{height}}` `{{frames}}`

Only `{{prompt}}` comes from the entity or tile. An unrecognised placeholder is
left **as written** rather than blanked, so a typo shows up in the request
instead of silently generating from an empty prompt.

### Pointer syntax

A small path evaluator (keys and array indices only — not JSONPath):

```
$[*].model_name        root is an array of objects     (Automatic1111)
models[*].name         a named array of objects        (Ollama)
data[*].id             OpenAI-compatible
images[0]              the first image
output.images[0].url   nested single value
```

---

## Animated sprites (sprite sheets)

The other machine returns **one image containing all the frames** in a grid.
This side stores it as the atlas and computes the manifest from the grid you
declare. Nothing is stitched here.

| Setting | Meaning |
|---|---|
| `Sprite sheet` | `flat` → frame keys `"0","1",…` (tiles, objects) · `directional` → `DIR/idx`, one row per facing (creatures) |
| `columns` | Frames per row. Blank = the requested frame count |
| `rows` | Blank = 1, or one per direction when directional |
| `directions` | Row order, default `S,SW,W,NW,N,NE,E,SE` |

Use `{{frames}}` in the template so the remote knows how many to draw.

**Example — a 4-frame walk cycle in 8 directions at 128×160 per cell:**

```
Sprite sheet   directional
columns        4
rows           8
directions     S,SW,W,NW,N,NE,E,SE
```

The remote must return a **512 × 1280** PNG. This side derives:

```json
{ "cell": [128, 160],
  "frames": { "S/0": [0,0,128,160], "S/1": [128,0,128,160],
              "SW/0": [0,160,128,160], "…": [] } }
```

**The image must divide evenly into the grid.** If it does not, the job fails
with the actual pixel size in the message — rather than cropping every frame
slightly wrong, which looks like a bad generation and is miserable to diagnose.

Sheets must be **PNG** (the dimensions are read from the PNG header).

---

## Worked examples

### Automatic1111 — static tile

```
Base URL       http://192.168.1.20:7860/sdapi/v1/txt2img
Models path    /sdapi/v1/sd-models
Models pointer $[*].model_name
Image pointer  images[0]
Sprite sheet   Single image
```

```json
{ "prompt": "{{prompt}}", "steps": 20, "cfg_scale": 7,
  "width": "{{width}}", "height": "{{height}}", "seed": "{{seed}}",
  "override_settings": { "sd_model_checkpoint": "{{model}}" } }
```

### An OpenAI-compatible image endpoint

```
Base URL       https://api.example.com/v1/images/generations
Auth header    Authorization      token: Bearer sk-…
Models path    /v1/models
Models pointer data[*].id
Image pointer  data[0].b64_json
```

```json
{ "model": "{{model}}", "prompt": "{{prompt}}",
  "size": "1024x1024", "response_format": "b64_json" }
```

---

## Which service draws what

Precedence, highest first:

1. the request body (the **Generate with** selector, for that job only)
2. the type's stored pin (`ai_provider_mode` / `ai_provider_id` — schema exists,
   **no UI to set it yet**, SOMET-342)
3. the active provider
4. local `sprite-gen`

With no active provider and no pin, generation behaves exactly as it did before
this feature existed.

---

## Limitations

- **Sync services only.** ComfyUI's submit/poll/fetch queue is not supported
  yet (SOMET-334).
- **In-memory job registry.** A backend restart loses in-flight remote jobs;
  polling one afterwards says so. Entries are evicted after
  `AI_PROVIDER_JOB_TTL_MS` (1h) and capped at `AI_PROVIDER_MAX_JOBS` (500).
- **Sheets must be PNG** and must divide evenly into the declared grid.

## Security

**An admin who can register a provider can make the backend issue HTTP requests
to any host the backend can reach.** That is inherent — the target is a machine
on your network — so *admin is a trusted role here*.

Guarded:

- `http`/`https` only, enforced at save time **and** at call time (the column
  can be edited in psql).
- URLs with embedded credentials refused.
- Redirects followed at most 3 times, each hop re-validated, and the auth header
  **dropped on a cross-origin hop** so a 302 cannot carry the token elsewhere.
- Response bodies **streamed with a hard cap** — `AI_PROVIDER_MAX_IMAGE_BYTES`
  (32 MB) and `AI_PROVIDER_MAX_DISCOVERY_BYTES` (2 MB) — abandoned part-way
  rather than buffered and then measured.
- Bounded timeouts: `AI_PROVIDER_DISCOVERY_TIMEOUT_MS` (10s),
  `AI_PROVIDER_GENERATE_TIMEOUT_MS` (5 min).
- The auth token is never returned by any endpoint, and URLs in error messages
  are redacted of credentials and query strings.

The token is stored in plaintext. Encrypting it would protect it from nobody who
cannot already read `DATABASE_URL` out of compose.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `no image found at response_image_pointer` | The pointer does not match the response shape. Check what the service actually returns |
| `models_pointer selected objects rather than names` | Pointing at the objects, not a field inside them — `$[*].model_name`, not `$[*]` |
| `sheet is 500x128px, which does not divide evenly` | The grid does not match what the service returned |
| `this provider returns a single image` | Pre-SOMET-346 message; configure a sprite-sheet layout |
| Job never finishes after a restart | In-memory registry; the job is gone. Regenerate |
| `refusing to call …: scheme file: is not allowed` | `base_url` is not http(s) |
