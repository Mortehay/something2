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

---

## Texturing the whole tile catalog

Doing this through the admin UI is fifty modals. Three make targets do it for
the catalog, and only the first needs a GPU.

```
make tiles-generate PROVIDER="desktop gpu"    # pin, pick biomes, draw what's missing
make tiles-export                             # MinIO -> backend/seeds/textures/tiles/
make tiles-seamless                           # make each texture tile against itself
make tiles-seed                               # committed PNGs -> MinIO, on any machine
```

`tiles-export` and `tiles-seed` are aliases for `make art-export KIND=tile` and
`make art-seed KIND=tile`; the same pair also moves entity, skill, passive-label
and item art. See [art-export-seed.md](../art-export-seed.md).

`tiles-generate` does what the UI does, in the same order: it pins every tile to
the provider (**Generation service**), gives each tile a biome art context if it
has none, then draws on that provider (**Generate with**) and points the catalog
row at the result — the Approve step. It is idempotent; an already-textured tile
is skipped.

| Variable | Effect |
|---|---|
| `PROVIDER=` | Provider name or id. Omit to use whichever is active |
| `FORCE=1` | Redraw tiles that already have a texture |
| `ONLY=grass,sand` | Limit to named tiles |
| `DRY=1` | Print what would happen, change nothing |
| `NOPIN=1` | Generate without changing each tile's saved provider |

**Biome choice** is deterministic: the lowest-id biome whose `terrain_tiles`
lists the tile. A tile no biome claims — roads, gates, `wooden_wall` — keeps no
context rather than borrowing an unrelated palette. `cave_wall` is the exception
that looks like a mistake and is not: it is banded into the deep biomes on
purpose, so it does take one.

### Moving textures to a machine with no GPU

`tiles-export` writes one PNG per textured tile to `backend/seeds/textures/tiles/`
with a manifest recording the prompt and biome each was drawn from. Commit those,
and on the other machine `make seed-catalogs && make tiles-seed` reproduces the
art with no provider configured at all.

Seeded textures get a stable key — `<bucket>/tiles/<name>/seeded/static.png` —
deliberately *not* the original job-scoped key, so one machine's job ids never
reappear on another. `tiles-seed` leaves a locally-generated texture alone unless
`FORCE=1`.

The catalog is roughly 15–20 MB of PNG at 512px. That is the price of not needing
a GPU to see the game as intended.

### Seamless tiling

A raw generated texture has arbitrary edges, so a field of one tile reads as a
grid of stamps. Three things are worth knowing.

**The provider cannot do it.** A1111 generates seamless textures with circular
padding in the conv layers; this service's `txt2img` exposes no `tiling`
parameter, so that route is closed. And asking in words makes things worse —
see the table below.

**Diamonds need ordinary wrap-seamlessness, not something special.** The square
is stretched into the iso diamond and a tile's neighbour is drawn at exactly a
half-tile offset, so the pixel across a shared diamond edge is the same texture
sampled at `(x - W/2, y - H/2)`. Continuity under wraparound gives continuity
across every diamond edge.

**So it is done afterwards**, by `make tiles-seamless`: wrap the image by half
its size, which moves the four edges into the middle as a cross and leaves two
formerly-adjacent columns as the new border; heal that cross by blending the
un-offset image back over a feathered band; then weld the borders so opposite
edges are pixel-identical rather than merely close.

```
make tiles-seamless CHECK=1              # measure only; 0 is a perfect seam
make tiles-seamless PREVIEW=grass        # 2x2 tiling written to /tmp
make tiles-seamless REPEAT=3             # shrink features further (default 2)
```

**Feature scale is fixed in the same pass.** A tile diamond is 128x64 and the
texture is 512x512, so the renderer squashes it 4x across and 8x down. A
generator draws a handful of large elements per image, which lands as three or
four boulders filling one tile — scenery, not ground. `REPEAT=N` tiles an
N-times-downscaled copy, dividing apparent feature size by N and multiplying
the count by N². It is free because the texture is already seamless, so the
internal repeat seams are continuous too. N=2 is the default; N=3 starts to
read as a pattern.

**Running it twice on one export is refused**, and that guard matters:
`tiles-seed` writes the PROCESSED textures back to the object store, so the
next `tiles-export` pulls those down and a second pass heals, welds and
shrinks an already-processed image — progressively blurrier and more
repetitive, with the file shrinking each time. The manifest carries a
`seamless` marker that export clears and this pass sets. To redo the
processing, regenerate and export again; the pass needs raw pixels.

Measured over the 50-tile catalog: mean seam score **21.1 → 3.7**. Two things
that sound better and are not — a second offset-heal pass (measured *worse*,
7.7 → 12.0, it blurs twice) and a whole-image cross-fade with a mirrored copy
(matching edges, but it ghosts the whole texture and imposes kaleidoscope
symmetry).

### Writing a tile prompt

Measured against SDXL, and counter-intuitive enough to be worth stating: **the
words that sound right are the ones that break it.**

| Don't say | Because it draws |
|---|---|
| `tile`, `seamless`, `repeating pattern` | stripes, or a sheet of separate assets |
| `isometric`, `ground tile` | an entire village scene |
| `road`, `track`, `ruts`, `rippling` | an aerial street grid, or venetian blinds |
| `void`, `chasm`, `blighted` and other moods | generic stone, or nothing coherent |
| `<x> floor` | a bordered dungeon-tileset panel |

Name the **material** and the **camera angle** instead — "dry tan earth with fine
gravel and dust". The styling suffix is applied by
`backend/seeds/data/tileTypes.js`, so a tile's own prompt stays a plain subject.
`sprite-gen`'s local `build_tile_prompt` uses the opposite vocabulary because
sd-turbo responds to it differently; the two are not interchangeable.

---

## Entity art (props and creatures)

Same four steps as tiles with one swap -- tiles are ground and get made
seamless, entities are silhouettes and get their backdrop cut out:

```
make entities-generate PROVIDER="desktop gpu (objects)" CORE=1 OBJECTS=1
make entities-export
make entities-cutout
make entities-seed
```

(`entities-export` / `entities-seed` are `make art-export KIND=entity` /
`make art-seed KIND=entity` -- see [art-export-seed.md](../art-export-seed.md).)

### CORE=1 is not optional on this provider

`/sdapi/v1/txt2img` cannot draw an isolated object. Asked for one tree it
returns a tileset of trees, a framed gallery card, or the tree on a checkered
backdrop. Four prompt revisions and four cutout strategies were measured
against that and none of them worked, because a textured backdrop has no key
colour to remove.

`/api/generate_core` on the **same box with the same model** returns one
object, centred, on a **flat** backdrop, in about ten seconds. Flat is the
whole game: one colour can be keyed out. That endpoint is step one of the
service's own two-step pipeline, and the error that looks like a dead end --
`no concept_image; prompt-to-concept is not wired yet` from `POST /api/jobs` --
only means step two will not call step one for you.

### Keep the prompt short

Writing exclusions into the prompt makes it worse, measured: "no pot, no
planter" produced potted plants, "no person" produced a person, and the longer
prompt started returning several objects instead of one. Diffusion attends to
the nouns, not the negation in front of them. What keeps the subject isolated
is the endpoint, not the adjectives.

### Transparency is enforced, not hoped for

`entities-cutout` escalates its key tolerance (40 up to 160) until the outer
ring of the image is genuinely transparent while the subject survives, and
**exits non-zero** naming any file that still carries a background. A fixed
tolerance cannot serve every image: a flat backdrop keys at 40, a dithered one
needs 100+, and using the high value everywhere eats subjects that share a tone
with their backdrop.

It also quantizes to a small palette (`--colors`, default 32) and hardens alpha
to a threshold. That is what makes the output actually pixel art rather than a
smooth render in a pixel-art style -- and the sprite service agrees: it
measured an unquantized sprite at 24,268 colours and marked it
`usable: false` as a style reference, then accepted the quantized one at 24.

### Reference images as style templates

Reachable, and worth knowing how the pieces fit:

```
POST /api/references            multipart: kind, file, label -> measured, usable true/false
POST /api/style-profiles/derive {name, reference_ids}        -> palette + cell + outline rules
POST /api/jobs                  {concept_image, style_profile, directions, frames, cell, colors}
```

Only `usable` references contribute, which is why the quantization above
matters twice over: it is what makes our own sprites acceptable as references.
Derive from **your own** reference ids -- the box carries other sessions'
uploads, and deriving from everything produced a palette of their greys.

`/api/jobs` needs a `concept_image` (a filename under the service's images/,
which `generate_core` produces) and takes about 393 s per cell against
`generate_core`'s 10 s -- style-constrained sheets at forty times the cost.

**It will not take a prop.** A boulder concept was rejected with `concept does
not look like an isolated character: not taller than wide (aspect 1.09)
(coverage 2%)`. The sheet builder validates that its input is a character
silhouette -- taller than wide, filling a reasonable share of the frame -- and
a rock is neither. So the reference/style-profile route is for CREATURES, and
props are served by `generate_core` plus `entities-cutout`, which is both the
cheaper path and the only one that accepts them.

---

## Audio providers (modality: audio)

Same `ai_providers` table, a second `modality` column (`'image'` default |
`'audio'`). The single-active index is now `ai_providers_single_active_per_modality`
-- **one active provider per modality** -- so activating an audio profile
leaves the active image provider active too. Image generation (tile/entity
jobs, the art console, the world-spec service) filters to `modality = 'image'`
and can never pick an audio provider by accident -- a pin or batch id that
names the audio profile resolves as "no such provider". A provider's modality
is fixed at creation (PATCH refuses to change it).

### Creating one

Settings → **AI Providers** → modality **Audio**. Base URL is the GPU box's
audio service, e.g. `http://192.168.0.217:8001`; token is a key created on the
box itself (Settings → Create key on the box, not here). Image-only fields
(request template, sprite-sheet layout) are hidden for this modality. The
token is write-only exactly like an image provider's -- never returned by any
endpoint, "stored" shown in its place.

**Refresh** lists what the box currently offers, stored in `models_cache`:
- music styles: `medieval_fantasy`, `tavern`, `dungeon`, `battle`, `village`
- ambience styles: `forest`, `cave`, `village_day`, `night`, `rain`
- cues, prefixed `cue:` so they sort apart from styles: `cue:slash`,
  `cue:hit`, `cue:pickup`, `cue:spell`, `cue:footstep`, `cue:ui_click`,
  `cue:miss`, `cue:chest_open`, `cue:death`, `cue:waypoint`

**Test** calls the box's authenticated `GET /api/audio/styles` (not the
unauthenticated root that a generic connection test would hit) -- it fails on
a bad token or a wrong base URL the same way a real job would, instead of only
proving the box is reachable.

### The adapter

`backend/src/services/remoteAudioProvider.js` calls `POST /api/audio/propose`
(prompt suggestion), then `POST /api/audio` for music/ambience generation --
never `?master=true` (that returns the uncompressed WAV master, ~13x the size
of the OGG we store). Every clip that comes back, generated or fetched off the
ledger, is checked by `backend/src/services/oggInfo.js` before it is trusted:
`OggS` magic, a Vorbis identification header for the sample rate, duration
computed from the last page's granule position, and a size cap -- 8 MB for
music/ambience, 1 MB for sfx. A clip that fails any check is never stored.
Checked clips are written to MinIO as OGG Vorbis at
`audio/<kind>/<clip-id>.ogg`, then bound to a subject slot through
`audio_clips` / `audio_bindings` -- subjects (a world, a biome, ...) are keyed
by **name**, not id, so a reseed that renumbers ids doesn't orphan a binding.

**Every generation sends an explicit seed** (random unless the admin sets
one) -- the box caches identical requests, so a same-seed retry would return
the same file instead of a new take.

### Assigning sounds

The **Audio** sidebar tab (`/game/audio`) is where bindings are made: worlds
(music, ambience), biomes (ambience), and -- for sound effects -- creatures,
world points, attack types, weapons and skills (see **Sound effects** below). Its **Missing sounds**
list is fed by the game client itself, `POST /api/audio/misses` -- a slot a
player actually hit with nothing bound, not a guess from the catalog.

### Batch generation

The single-slot **Generate** button (below) is still synchronous -- fine for
one clip, but a tunnel with a short edge timeout (the ~100 s Cloudflare quick
tunnel on the Orange Pi) can time out a long track before a cold generation
finishes, even though the server still stores and binds the clip -- refresh
the tab to see it. For more than a few clips, or anything going through a
tunnel, use **Batch mode** in the Audio tab instead: it queues jobs on the
backend and drains them one at a time, so no single HTTP request has to
survive the whole run.

**Queuing.** In Batch mode, tick subjects in the left column and choose which
slots per kind to include (music, ambience, and every sfx slot that has a
cue -- upload-only slots are listed as skipped and never queued), or tick items in **Missing sounds** and press **Add to batch** --
Missing sounds is fed by the game client's own `POST /api/audio/misses`, so
it lists slots a player actually hit with nothing bound, not a guess from the
registry. **Queue N jobs** enqueues everything selected. A slot that already
has a queued or running job for it reports back as `already_live` instead of
being queued twice -- re-queueing it is a no-op, not an error.

**The drain.** Jobs are claimed group by group in the order `music` →
`ambience` → `sfx_realistic` → `sfx_retro`, so the GPU box switches model at
most once per group instead of once per clip (music runs on
`audio:ace-step`, ambience and realistic SFX on `audio:stable-audio`, retro
SFX need no model at all). Music and ambience jobs run one at a time; SFX
jobs of one engine are claimed up to `AUDIO_SFX_PACK_SIZE` at a time and sent
as ONE `POST /api/audio/sfx-pack` request, each returned clip matched back to
its job by cue + entity text. A pack entry the box rejects (an unknown cue
fails the whole pack with 422) fails only the jobs it names. A busy box
(HTTP 409/503, "not now") re-queues the job with a backoff pause before the
next claim -- it does not spend one of the job's attempts and does not count
toward the breaker below. A **circuit breaker** stops the drain after
`AUDIO_BREAKER_TRIP` (default 3) consecutive *provider faults* in a row --
other 5xx responses, an unusable response (bad JSON, a returned file that
fails the OGG check), a box-reported generation failure (the box's own
ledger, e.g. a CUDA OOM), or a transport/timeout error. A run of unrelated
bad subjects (a pinned-but-disabled provider, a subject that no longer
exists) does not trip it or reset its count -- only a genuine success does
that.

**Restart recovery.** A job stuck `running` when the process dies (nodemon
restarts the backend on *any* backend file edit, killing a running drain
mid-job) is re-queued automatically the next time a drain starts, with its
spent attempt refunded -- a crash never loses a job. But the drain itself
does not resume on its own: after a restart, press **Start** again.

**The progress panel** appears in the Audio tab whenever there is batch
activity, running or not (so a full queue with nothing draining it stays
visible). It shows overall progress and which group is currently draining,
per-group counts (done/queued/running/failed), the subject/slot currently
generating, how many jobs are waiting out a busy-box backoff, and the last
few failures with their error text. **Retry failed** re-queues every failed
job (resetting its attempt count); **Clear finished** removes done and failed
jobs and keeps anything still queued; **Discard queued** removes the queued
jobs (the confirm dialog says how many) so they are never generated. Clear
and Discard are refused (409) while a drain is running -- press Stop first. A
group's rows left `running` with no drain running (a backend restart
mid-job) show as **interrupted — press Start**; Start re-queues and runs them.
If a drain ends for any reason other than running out of work or Stop (the
breaker, no provider, a database error), the panel says why.

A queued job whose world or biome no longer exists by the time it is claimed
fails with `subject no longer exists` without calling the box (and without
counting toward the breaker). A clip is stored and bound in one database
transaction, so **Delete all unbound** running at the same moment can never
remove a clip that is about to be bound.

**Env vars:**
- `AUDIO_JOB_MAX_ATTEMPTS` (default 3) -- retries per job before it lands in
  `failed` (a busy-box requeue does not count against this).
- `AUDIO_JOB_RETRY_BASE_MS` (default 30000) -- base backoff before a retry;
  doubles per attempt with jitter.
- `AUDIO_BREAKER_TRIP` (default 3) -- consecutive provider faults before the
  drain stops itself.
- `AUDIO_SFX_PACK_SIZE` (default 12) -- most sfx jobs sent in one
  `sfx-pack` request.
- `AUDIO_DRAIN_MAX_WAIT_MS` (default 60000) -- longest the drain sleeps
  between checks while every queued job is sitting out a backoff.

The single-slot **Generate** button still blocks on the HTTP response --
roughly 30 s for a warm 30 s ambience clip, up to ~2 min for a 2-minute track
including a cold model load. Like the batch path, when both **style** and
**prompt** are left blank it proposes one first (the same call **Suggest**
makes) rather than sending an empty request.

### Sound effects

**Subjects and slots.** Five global kinds (bindings are not scoped to a world
or biome -- every world plays them):

| Kind | Key | Slots → box cue |
|---|---|---|
| `creature` | entity type name (`Slime`) | `nearby` → —, `attack` → —, `hurt` → `hit`, `death` → `death` |
| `world_point` | entity type name (`portal`, `merchant_post`, ...) | `nearby` → `waypoint` |
| `attack_type` | `melee` / `ranged` / `magic` | melee `use` → `slash`, ranged `use` → —, magic `use` → `spell`; `hit` → `hit` for all three |
| `item` | weapon name | as its weapon's attack type |
| `skill` | skill id | `use` → `slash` for a melee skill, `spell` otherwise; `hit` → `hit` |

A slot marked — has no cue on the box today (there is no idle, creature-attack
or bow-release cue), so it is **upload-only**: the slot card says so, the
Generate button is hidden, and batch selection skips it. Upload an OGG for it
by hand or bind one from the library. A weapon's attack type is decided from
the catalog row: a socketed stone or augment → magic, `kind = 'melee'` →
melee, an `ammo_type_id` or a bow-category name → ranged, anything else →
magic.

**Generating.** SFX slots have an **engine** choice (`realistic` =
stable-audio, `retro` = procedural, near-instant) and a **variants** count
(1-5; each variant is one more clip bound to the slot, and the client makes a
weighted random pick per play). The box caches SFX by (engine, cue, entity text) and
**ignores the seed**, so variety comes from the entity text instead: the
first take sends the subject's phrase (`slime`, `a steel sword`, the skill's
name), later takes send `<phrase> (take N)` where N counts the clips already
bound to the slot. The take number is kept in the clip's label, so deleting a
clip and regenerating still asks the box for a new take. If some variants
fail and others succeed, the successful ones are stored and bound and the
admin sees a "partial" toast naming what failed.

**In the game.** The authority adds an `sfx` list (at most 64 events,
omitted when empty) to each world frame: `use` (a swing, cast or shot),
`hit` (it landed), `hurt` and `death` (a creature was damaged / killed --
one `death` per kill). Each event carries its attack kind and item or
`skill:<id>`, or the creature type, and a world position. The client
resolves each event to a lookup chain, most specific first:

- player `use`/`hit`: `skill/<id>/<slot>` or `item/<name>/<slot>`, then
  `attack_type/<kind>/<slot>`;
- creature `use`: `creature/<type>/attack`; creature `hit`:
  `attack_type/melee/hit`;
- `hurt`/`death`: `creature/<type>/hurt|death`.

The first bound slot plays; if none is bound, the first key is reported to
**Missing sounds**. Playback is positional (pan + distance falloff; events
beyond 1600 px are not played) and capped: at most 12 SFX voices, the same
clip at most 3 times per 100 ms, and when full your own actions win over the
nearest combat, which wins over ambient `nearby` sounds. Creature `nearby`
sounds play every 4-10 s while you are within 8 tiles (at most 4 at once);
a world point's `nearby` clip loops while you are in range and fades when
you leave. The Settings **SFX** slider scales all of it.

**Editors.** The entity-type editor shows a **Sounds** section for creatures
and world points (same slot cards as the Audio tab).

### Library

The **Library** tab (`/game/audio` → Library) lists every stored clip,
independent of any subject -- filterable by kind and by **Unbound only**.
Deleting a clip here removes the stored object from MinIO as well as its
`audio_clips` row, cascading to every binding that pointed at it (the
confirm dialog says how many). **Delete all unbound** removes every
currently-unbound clip matching the kind filter, not just the current page.
Each slot card also has a **+ From library** picker to bind an existing clip
to another subject/slot without generating or uploading a new one.

### World and biome editors

The world editor (Maps admin, per-world card) and the biome editor (Biomes
admin, per-biome card, once the biome has been saved) each embed a **Sounds**
section -- the same slot cards as the Audio tab's Subjects view, scoped to
that one world or biome -- so bindings can be made right where the subject is
already being edited instead of navigating to the Audio tab. It shares the
same registry and bindings queries as the Audio tab and renders even with no
audio provider configured (Upload still works).

### Export and seed

Same problem as the image side (SOMET-572/573): a generated clip lives in two
places git cannot see -- MinIO holds the bytes, `audio_clips` holds a
job-scoped `storage_key` pointing at them, and `audio_bindings` points a
subject at a clip id. `make audio-export` / `make audio-seed` move both into
the repo and back:

```
make audio-export                        every kind -> backend/seeds/audio/
make audio-export KIND=music,ambience     some kinds
make audio-export ONLY=Vale,Forest        some subjects' bound clips
make audio-seed                           committed clips -> MinIO + bindings
make audio-seed KIND=sfx FORCE=1          overwrite clips this machine already has
```

`KIND` is any of `music`, `ambience`, `sfx`; `ONLY` is a comma-separated list
of subject names (world/biome names, not slots). Only clips with at least one
binding are exported -- an unbound clip stays library-only.

Export writes `backend/seeds/audio/{music,ambience,sfx}/<label>-<id8>.ogg`
plus `clips.json` and `bindings.json` at `backend/seeds/audio/`. A `KIND`- or
`ONLY`-scoped export merges into the existing manifests rather than
truncating them -- it has only seen the kinds/subjects it queried, so
entries outside that scope are left as they were.

Clip ids are preserved across an export/seed round trip, so re-seeding an
already-present clip is a no-op (`FORCE=1` re-uploads it and overwrites the
row). A binding whose world or biome no longer exists in this database is
reported and skipped rather than failing the whole seed. The exported files
are ordinary git content under `backend/seeds/audio/` -- nothing commits them
automatically; that's a normal `git add`.

Seeding **adds** bindings next to any that already exist on the same slot; it
does not replace them. On a machine whose slot already has a different clip
bound, music rotation and the ambience weighted pick then include both the
existing clip and the seeded one -- unbind whichever you don't want. On the
machine that did the export, the ids match, so nothing is doubled there.

The size export prints for each kind is the bytes written by that run (every file it
wrote, changed or not) -- not a diff against what git already has.

### Limitations

- **Renaming a world, biome, creature, world point or weapon orphans its
  sounds** (skills are keyed by id and are not affected). Bindings, missing-sound
  rows and queued jobs are keyed by the subject's NAME, so after a rename they
  stay on the old name: the renamed subject plays nothing, and its queued jobs
  fail with `subject no longer exists`. Re-bind (or re-queue) under the new
  name after a rename; carrying them across automatically is a planned
  follow-up.
