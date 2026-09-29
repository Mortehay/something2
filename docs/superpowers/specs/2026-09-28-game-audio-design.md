# Game audio: music, ambience and SFX from the GPU box

**Date:** 2026-09-28 · **Status:** design approved in conversation, awaiting spec review

## Goal

Every world, biome, creature, attack and world point can carry any number of
sound clips. The game plays them at the right moments: quiet music per world,
ambience per biome, creatures that make noise when you are near, attacks that
sound on use and on hit. Clips are generated on the desktop GPU box
(192.168.0.217:8001) one at a time or in batches grouped so the box does not
keep switching models. The approved library is exported to git and seeded back
with `make` targets.

**Success looks like:** walk from a forest into a desert and hear the ambience
crossfade under the world's music; approach a slime and hear it; swing a sword
and hear the swing and the hit; open the Audio tab and see which sounds the
game wanted but did not have.

## Decisions already made

| Question | Decision |
|---|---|
| Slicing | Vertical first: slice 1 plays a sound in the browser end to end |
| What plays on a map | Two channels: music per world, ambience per biome falling back to the world |
| Attack sounds | Chain: item/skill override → attack-type default (`melee`/`ranged`/`magic`) → silence; every level may hold clips |
| Clips per slot | Unlimited; one is picked at random (by weight) per trigger. The box's 1-5 variants is a per-request limit only |
| Review of generated clips | None: a finished job binds its clips straight into the target slot, like the Art tab. The admin prunes afterwards (play / remove / regenerate) |
| Where sounds are assigned | A new Audio sidebar tab **and** a "Sounds" section in the entity-type and world editors, both built from one slot component |
| Backend shape | A separate audio pipeline modelled on art, not an extension of `art_jobs`/`catalog_art` (one-image-per-subject PK; no `sfx-pack`) |
| Stored format | OGG only, in MinIO and git. WAV is never stored |
| Missing sounds | Logged per trigger, persisted, shown in the Audio tab as a to-do list |

"Location" in the original request means **biome**: there is no locations
table, and a per-area zone system is out of scope.

## 1. Data model

All subject keys are **names**, never DB ids, so bindings survive a reseed
(same rule as `catalog_art`).

### `audio_clips` — the library, one row per OGG

`id` (uuid), `kind` (`music` | `ambience` | `sfx`), `label`, `storage_key`
(`audio/<kind>/<id>.ogg` in the `sprites` bucket), `bytes`, `duration_ms`,
`loopable` (bool), `loop_start_ms` / `loop_end_ms` (nullable; from the box's
ledger), `source` (`generated` | `uploaded` | `seeded`), `provider_id`
(nullable FK, `ON DELETE SET NULL`), `prompt`, `style_or_cue`, `engine`
(`realistic` | `retro` | null), `seed`, `created_at`.

A clip is independent of where it is used: one clip may be bound to many slots.
Unbound clips stay until deleted from the library view.

### `audio_bindings` — what plays

`id`, `subject_kind`, `subject_key`, `slot`, `clip_id` (FK, `ON DELETE
CASCADE`), `volume` (real 0-1, default 1), `weight` (real > 0, default 1),
`sort`, `created_at`. Unique on (`subject_kind`, `subject_key`, `slot`,
`clip_id`).

### Subject registry (code, not DB)

`backend/src/services/audioSubjects.js`, shaped like `catalogSubjects.js`. Each
kind declares how to list its subjects, its slots, and the clip kind each slot
accepts. Binding validation, the bindings endpoint and the admin UI all read it.

| subject_kind | key | slots (clip kind) |
|---|---|---|
| `world` | `worlds.name` | `music` (music), `ambience` (ambience) |
| `biome` | `biomes.name` | `ambience` (ambience) |
| `creature` | `entity_types.name` where `is_creature` | `nearby`, `attack`, `hurt`, `death` (sfx) |
| `attack_type` | `melee` / `ranged` / `magic` | `use`, `hit` (sfx) |
| `item` | `item_types.name` where `category = 'weapon'` | `use`, `hit` (sfx) |
| `skill` | skill `id` from `seeds/data/skills.js` | `use`, `hit` (sfx) |
| `world_point` | `entity_types.name` where `point_kind` is set | `nearby` (sfx, loopable allowed) |

Binding a clip whose kind does not match the slot is rejected (400).

### Lookup chains

- Attack `use`/`hit`: `item` or `skill` → `attack_type` → silence.
- Ambience: `biome` → `world.ambience` → silence.
- Everything else: the subject's own slot → silence.

An empty slot is silence, never an error.

### `audio_jobs` — the generation queue

`id`, `batch_id`, `subject_kind`, `subject_key`, `slot`, `clip_kind`, `prompt`,
`style`, `slots` (jsonb), `cue`, `entity`, `engine` (`realistic` | `retro`),
`variants`, `seed`, `duration_s`, `provider_id`, `drain_group` (see
Dispatcher), `state` (`queued` | `running` | `done` |
`failed` | `stopped`), `attempts`, `last_error`, `not_before`, `claimed_at`,
`created_at`, `updated_at`.

### `audio_misses` — sounds the game wanted and did not have

`subject_kind`, `subject_key`, `slot` (PK together), `world`, `count`,
`first_seen`, `last_seen`. Binding any clip to that exact slot deletes the row
in the same transaction.

## 2. Provider connection and generation

### Provider

- `ai_providers.modality` (`image` | `audio`, not null, default `image`):
  existing rows are unchanged.
- The single-active unique partial index becomes unique **per modality**, so an
  image provider and an audio provider can both be active.
- Settings UI: a modality select. For `audio` it hides the image template,
  response pointer and sheet fields, and keeps base URL, auth header name and
  the write-only token.
- Discovery for audio: styles from `GET /api/audio/styles`, cues from
  `GET /api/audio/styles?kind=sfx`, cached in `models_cache`.
- Image generation must ignore audio providers. Every image-provider lookup
  gains `modality = 'image'`, with a test proving an active audio provider is
  never picked for a tile job.

### Adapter: `backend/src/services/remoteAudioProvider.js`

Written for the box's API. It is not template-driven, because styles, cues and
packs do not reduce to `{{prompt}}` substitution. There is one function per
call:

| function | box call | used for |
|---|---|---|
| `propose` | `POST /api/audio/propose {context, kind}` | prefill the generate form; no GPU |
| `generateTrack` | `POST /api/audio {kind, name, style?, prompt?, context?, slots?, seed?, duration_s?}` | music, ambience |
| `generateSfx` | `POST /api/audio/sfx {cue, entity?, engine?, world?, variants, seed?}` | one cue, 1-5 variants (base64 OGG each) |
| `generateSfxPack` | `POST /api/audio/sfx-pack {items:[{cue, entity?, engine?}], engine?, world?, variants, seed?}` | many cues, one model load; per-cue failures reported individually |
| `fetchTrack` | `GET /api/audio/{kind}/{name}` (never `master`) | only if `generateTrack` returns a reference instead of bytes |

**Every file is checked before it is stored:**
- the first four bytes must be `OggS` (a WAV fails the job);
- duration must be greater than 0, measured from the last OGG page's granule
  position, with no audio library;
- size caps: music/ambience 8 MB, SFX 1 MB.

A clip that passes goes to MinIO, then an `audio_clips` row is written, then it
is bound to the job's slot, all in one DB transaction after the upload.

### Dispatcher: `backend/src/services/audioDispatcher.js`

- **One drain per process.** A second start returns 409 `ALREADY_RUNNING`
  (same as art).
- **Claiming:** `FOR UPDATE SKIP LOCKED` with retry backoff via `not_before`.
- **Grouped so the box switches model as rarely as possible.** `drain_group`
  is set at enqueue time, and groups drain in this fixed order:
  1. `music` (all music tracks)
  2. `ambience` (all ambience loops)
  3. `sfx_realistic` (packed)
  4. `sfx_retro` (packed; no model load)
- Ambience runs next to realistic SFX, so if the box serves both from one model
  (the gateway lists `audio:ace-step` and `audio:stable-audio`) it stays loaded
  across the boundary. Whichever model each group uses, the box switches at
  most three times per batch instead of once per clip.
- **Packing:** SFX groups are packed into `sfx-pack` calls of up to
  `AUDIO_SFX_PACK_SIZE` cues (default 12). Each cue's variants become that
  job's clips.
- **Every job sends an explicit seed, random unless the admin set one.** The
  box caches by request, so an omitted or repeated seed returns the old file.
- **The box's 409 on model switch, or "busy", is back off and retry.** It never
  calls `model-gateway/switch` with `force`.
- A circuit breaker stops the run after `AUDIO_BREAKER_TRIP` (default 3)
  provider failures in a row, as in art. A busy 409/503 is back-off-and-retry
  (above) and does not count toward this.
- **Timeout:** `AUDIO_GENERATE_TIMEOUT_MS`, default 10 min (music on the GPU
  can take minutes).

### Box contract, measured 2026-09-28

Measured with the `something2-audio` key against the live box. It already
holds a corpus of generated music, ambience and SFX.

**Styles** (`GET /api/audio/styles`, `$[*].value`; each carries `slots` with
enums and ranges):
- music: `medieval_fantasy` (default), `tavern`, `dungeon`, `battle`, `village`;
  slots `tempo_bpm`, `mood`, `featured`
- ambience: `forest` (default), `cave`, `village_day`, `night`, `rain`; slots
  `mood`, `featured`

**Cues** (`GET /api/audio/styles?kind=sfx`):
- `slash`, `hit`, `pickup`, `spell`, `footstep`, `ui_click`, `miss`,
  `chest_open`, `death`, `waypoint`
- each cue has `engines` (`realistic` and/or `retro`), a `default_engine`, a
  `duration_s` and an `entity_default`
- `retro` renders in about 0.1 s and needs no model load; `realistic` about
  16 s per cue

**Responses:**
- `POST /api/audio/propose` is synchronous: `{kind, style, slots, prompt,
  author, adjusted}`.
- `POST /api/audio/sfx` is synchronous: `{audio: [base64 OGG per variant],
  info: {name, cue, entity, engine, prompt, seed, sample_rate, variants: [{url,
  duration_s, onset_ms}], cached, served_from, generation_id}`.
  - **`cached: true` means the same request returns the same file, so
    Regenerate always sends a fresh random seed.**
- `POST /api/audio` (music/ambience) is **synchronous**: it returns
  `{audio: [base64 OGG], info: {kind, name, style, prompt, author, seed,
  duration_s, sample_rate, loop_start, loop_end, bars, seam_rms_jump_db,
  cached, served_from, generation_id, duration_ms}}` directly, no polling
  needed on the happy path.
  - Measured 2026-09-28: a 30 s `forest` ambience took ~117 s **cold** (model
    load) and ~31 s **warm**. A 126 s `medieval_fantasy` track took ~137 s and
    came back as 2,005,648 bytes of base64 OGG.
  - The ledger (`GET /api/audio?kind=&name=`) lists rows while they run, with
    `status`, `error`, `url` and `download_url`.
  - `GET /api/audio/{kind}/{name}` returns raw `audio/ogg`.
  - `generateTrack` still tolerates the queued/async shape as a fallback --
    no inline `audio` in the POST response falls through to polling the
    ledger by name until `status` is `done` or `failed`, then fetching -- in
    case a future box or a busy one answers that way instead.
- Ledger rows carry `loop_start` / `loop_end` (in samples), `sample_rate`,
  `bars` and `seam_rms_jump_db`. We store the loop points (see
  `audio_clips.loop_start_ms` / `loop_end_ms`) and pass them to the Web Audio
  source's `loopStart`/`loopEnd`.
- `?master=true` returns the WAV master (23.9 MB for a 124 s track). It is
  never used.

**Codec and size** (ffprobe on real files): OGG **Vorbis**, nominal
128 kbps, **stereo**, 44.1 or 48 kHz.

| clip | duration | bytes |
|---|---|---|
| music (village) | 124 s | 1.80 MB (WAV master 23.9 MB, 13×) |
| ambience (rain loop) | 30 s | 326 KB |
| SFX (realistic hit) | 0.54 s | 11 KB |
| SFX (retro hit) | 0.15-0.2 s | ~5 KB |

**Models:** the box's gateway lists `audio:ace-step` and `audio:stable-audio`
alongside the image models. Which kind runs on which model is not exposed per
request.

**SFX caching and packs (measured 2026-09-29):**
- `/api/audio/sfx` and `/api/audio/sfx-pack` cache by `(engine, cue, entity)`
  and IGNORE the seed: seeds 8 and 9 both returned the seed-1 file with
  `cached:true`.
- A different `entity` text generates fresh. Variation and regeneration
  therefore change the entity text (`"<phrase> (take N)"`).
- One unknown cue fails the WHOLE pack (`unknown cue '<x>'; see GET
  /api/audio/styles?kind=sfx`) with HTTP **422** (measured 2026-09-29 against
  the live box, retro engine -- earlier text here said 400; the adapter's
  `unknownCue` extraction matches on the message text, not the status, so
  this did not need a code change, only this correction).
- Pack response: `{items:[{cue, entity, engine, name, prompt, seed,
  sample_rate, variants:[{url, duration_s, onset_ms}], audio:[base64 OGG…],
  cached, served_from, generation_id}], count, failed}` -- confirmed live
  2026-09-29 (retro engine, cues `hit`/`death`) against real adapter code
  (`generateSfxPack`), not just the fake-box unit tests: the shape decodes
  and every returned clip passes `checkClipBuffer`.
- **Per-item failure shape: not observed.** Two attempts against the live box
  (retro engine) found none: (1) two ordinary items with fresh unique entity
  text both succeeded; (2) one item given a 5000-character entity string
  still succeeded (no per-item error, no truncation observed in the
  response). An unknown cue remains the only failure mode found, and it
  fails the WHOLE pack, not one item -- `generateSfxPack`'s per-item
  `{ok:false, cue, entity, error, providerFault}` branch (for a `row.error`
  or a bad clip buffer) is defensive code for a shape the live box has not
  yet been seen to produce.
- **Per-item seed is NOT the request seed verbatim:** a pack sent with a
  single `seed: 123` for both items came back with item 1 (`hit`) at
  `seed: 123` and item 2 (`death`) at `seed: 124` -- the box appears to
  increment the seed per item within a pack rather than reusing the same
  seed for every cue. `generateSfxPack` already reads each item's own
  `seed` off its response row rather than assuming the request seed, so
  this needed no code change either.
- Box-side request: include the seed in the SFX cache key.

**Box-side observation, not ours to fix:** `/audio/...` static URLs serve files
**without auth**, while `/api/audio/*` enforces it. We never rely on the static
path; the adapter always uses the authenticated `/api/audio/{kind}/{name}` or
the base64 in the response.

## 3. In-game playback

### `AudioEngine`

It lives in `frontend/src/games/something2/src/js/audio/` and uses plain Web
Audio, no library.

**Buses and settings:**
- Buses: `music`, `ambience` and `sfx`, each a GainNode feeding a `master`
  GainNode.
- Settings: four volume sliders plus mute in `GameSettings.jsx`, persisted to
  localStorage following the `hotbarStorage.js` pattern (try/catch, defaults on
  failure).
- The AudioContext is created or resumed on the Play click, satisfying the
  browser autoplay rule.

**Loading:**
- On world join: `GET /api/audio/bindings?world=<name>` returns every slot that
  can matter in that world, as `{subject_kind, subject_key, slot} → [{url,
  volume, weight, loopable, clip_kind}]`. That covers the world, its biomes,
  its creature types, its world points, all attack types, and all items and
  skills.
- Clips are fetched via `/api/assets/*`, decoded once and cached per URL.

### Triggers

**Music (world):**
- Plays a weighted-random clip from `world/<name>/music`. When it ends,
  another clip plays after 3-8 s of silence.
- The music bus defaults to 0.35.
- Crossfade of 2 s on world transition.

**Ambience (biome):**
- The client works out the biome under the player from the chunks it
  already streams. The chunk response (`GET /api/worlds/:id/chunk`) gains
  `biomes`: an 8×8 grid of biome names (or null) per chunk, one cell per 8×8
  tiles, computed server-side with `mapService.sampleBiomeRegion` (the same
  field terrain uses). That costs no extra request and no client copy of the
  noise code.
- (The preview grid was considered and rejected: it is a fixed 64×64 window
  around the origin, not the whole world.)
- It samples every 500 ms. A new biome must hold for 1.5 s before switching
  (hysteresis at borders), then the loop crossfades over 2 s.
- Lookup: biome → world ambience → silence.

**Creature `nearby`:**
- Applies to each creature in the snapshot within 8 tiles.
- Plays a random clip every 4-10 s, with a random offset per creature.
- Linear distance falloff, and stereo pan from screen x.
- At most 4 simultaneous creature voices; the nearest ones win.

**Creature `attack` / `hurt` / `death`:**
- `attack` comes from `attacks` records whose actor is `c:<id>`.
- `hurt` comes from `impacts` whose target is `c:<id>`.
- `death` fires when a creature leaves the snapshot because it died. It must
  be distinguished from leaving view or AOI; if the snapshot cannot tell the
  two apart, slice 3 adds the signal.

**Player / skill `use` and `hit`:** `use` comes from `attacks` records, `hit`
from `impacts` records, resolved through the attack chain.

**World point `nearby`:** the same as creature `nearby`. A `loopable` clip
loops while in range instead of repeating.

**Limits:**
- At most 12 SFX voices at once.
- The same clip at most 3 times within 100 ms.
- Priority when over the cap: the player's own actions, then the nearest.

### Wire change (slice 3) — an `sfx` event channel

Ruling, 2026-09-29: the original plan here was to add `k`/`s` fields to the VFX
`attacks` and `impacts` records. The code does not support that:

- player projectile and magic shots emit no attack record;
- projectile hits emit no impact record;
- skill casts and creature deaths emit nothing at all;
- the client drops `t` on impacts.

Tagging the VFX records would therefore leave most sounds silent.

Instead the authority emits a small `sfx` list per world frame (cap 64, key
omitted when empty):
`{ e: 'use'|'hit'|'hurt'|'death', k?: 'melee'|'ranged'|'magic', s?: '<item name>'|'skill:<id>', c?: '<creature type>', a?: 'p:<uid>'|'c:<id>', x, y }`.

It is built at the same sites. The server stays ignorant of audio, and VFX is
untouched. `attackKindOf(weapon)` (authority `sfxEvents.js`) is the one
weapon → `k` mapping, shared with the subject registry.

### Failure behaviour

A missing binding, fetch error or decode error is silence plus one
`console.warn` per clip URL per session. Audio code runs outside the render
path and never throws into the frame.

### Misses log

- When a trigger fires and its whole chain is empty, the client records
  `{subject_kind, subject_key, slot, world}` at the **most specific** level
  (the skill, not `attack_type/magic`). Each key is recorded once per session.
- Buffered misses are sent to `POST /api/audio/misses` (player-guarded, body
  capped at 200 entries) every 30 s and on world leave.
- The server upserts into `audio_misses`, incrementing `count` and updating
  `last_seen`.
- Only subject kinds and slots from the registry are accepted. Unknown keys
  are dropped, so a client cannot fill the table with junk.

## 4. Admin: Audio tab and editor sections

**Audio tab** (`/game/audio`, admin only, left sidebar):

- **Subject tree:** Worlds, Biomes, Creatures, Attack types, Items, Skills,
  World points, each with a filled/total slot count. Below it, **Missing
  sounds**, sorted by `count`, with multi-select → "Add to batch".
- **Slot panel** for the selected subject:
  - each clip row has play/stop, label, duration, size, volume, weight, remove,
    and **Regenerate** (same prompt/cue, new seed, replaces the clip in this
    slot);
  - each slot has **+ Generate** (prompt prefilled from `propose`, variants
    1-5), **+ Upload .ogg** (same checks as generated clips), and **+ From
    library**.
- **Batch mode:**
  - tick subjects × slots across the tree (e.g. all creatures → nearby, hurt,
    death), optionally edit a prompt template, then choose **Queue**;
  - a progress panel groups jobs as the dispatcher will run them (music group,
    then SFX group), shows queued/running/done/failed, and has Stop, Retry
    failed and Clear.
- **Library view:** every clip, filterable by kind and "unbound", with bulk
  delete of unbound clips.

**Editor sections:** the entity-type editor (creatures and world points) and
the world editor render the same slot component filtered to that subject.

**Batch prompts:**
- **Music and ambience:** context is built from the subject's data (world name
  and biome list; biome name and `art_style`) and sent to `propose`. The
  proposed style and prompt are used unless the batch template overrides them.
- **SFX:** slot → cue, from the box's real cue list. `entity` is the
  creature, item or skill name, or the listed phrase for attack-type defaults.
  The engine defaults to `realistic`, and a batch can choose `retro`.

| slot | cue | entity |
|---|---|---|
| `creature/*/hurt` | `hit` | the creature name |
| `creature/*/death` | `death` | the creature name |
| `attack_type/melee/use` | `slash` | "a steel sword" |
| `attack_type/melee/hit` | `hit` | "a blade on a creature" |
| `attack_type/ranged/hit` | `hit` | "an arrow" |
| `attack_type/magic/use` | `spell` | "a magic spell" |
| `attack_type/magic/hit` | `hit` | "a magic blast" |
| `item/*/use`, `item/*/hit` | as its attack type | the item name |
| `skill/*/use`, `skill/*/hit` | `spell` / `hit` for magic skills, else as its attack type | the skill name |
| `world_point/*/nearby` | `waypoint` | the point's name |
| `creature/*/nearby` | **none** | — |
| `creature/*/attack` | **none** | — |
| `attack_type/ranged/use` | **none** | — |

  **Three slots have no cue on the box today:** a creature's idle vocal, a
  creature's attack vocal, and a bow/throw release. `SfxRequest` takes no free
  prompt, so these slots can be filled only by **upload** until the box adds
  cues (suggested `idle`, `attack`, `shoot`).
  - The slot → cue map is data in the registry, so a new cue is a one-line
    change.
  - The Audio tab marks these slots "upload only (no cue on provider)"
    instead of offering Generate.
  - Slice 3 does not wait for the box: those triggers play whatever is bound
    and log misses otherwise.

## 5. Export / seed, size, testing, slices

### `make audio-export` / `make audio-seed`

These mirror `art-export`/`art-seed` (`KIND=music,ambience,sfx`,
`ONLY=<subject names>`, `FORCE=1`) and run `backend/scripts/export-audio.js` /
`seed-audio.js` in the backend container.

**Layout:**
- files: `backend/seeds/audio/{music,ambience,sfx}/<label-slug>-<clip-id first 8>.ogg`
- `backend/seeds/audio/clips.json`: file, kind, label, duration_ms, bytes,
  loopable, prompt, style_or_cue, seed
- `backend/seeds/audio/bindings.json`: subject_kind, subject_key, slot, clip
  file, volume, weight, sort

**Export:**
- Only **bound** clips are exported.
- It prints the bytes added to the working tree, so regeneration churn in git
  history is visible.

**Seed:**
- Uploads files to MinIO, then upserts clips (keyed by file name) and bindings
  (keyed by subject names).
- Without `FORCE`, it skips a clip this machine already has.
- A binding whose subject no longer exists is reported and skipped, never
  silently dropped.
- It works on a fresh DB and on the Orange Pi.

### Size

**Decision: store the box's OGG Vorbis exactly as delivered. Never store WAV.
Do no re-encoding on this side.**

**Measured:** a 124 s track is 1.80 MB as OGG against 23.9 MB as the WAV
master (13×), a 30 s ambience loop is 326 KB, and a realistic SFX is about
11 KB.

**Expected library:** 30 music tracks (≈54 MB) + 20 ambience loops (≈7 MB) +
500 SFX (≈6 MB) ≈ **65-70 MB**, the same order as the 100 MB of committed
textures. Music is about 80% of it.

**Why not Opus:** it would save about 40%, but it means re-encoding, and
Safari's `decodeAudioData` support for Ogg Opus is recent. Vorbis decodes in
every current browser.

**Cheapest future cut, box-side and out of scope:** encode SFX mono and music
at about 96 kbps. That takes about 30% off, almost all of it from music.

### Asset route

`GET /api/assets/*` sets `Content-Type: audio/ogg` for `.ogg`.

### Testing

Test first through public seams. DB tests run on a per-branch scratch DB with
`TEST_DATABASE_URL` **and** `DATABASE_URL` both set, and never touch the shared
dev DB.

**Backend:**
- adapter against a fake box: real small OGG fixtures, a WAV (rejected), an
  oversized file (rejected), a 409 (backoff), a pack with one failed cue;
- dispatcher grouping order (all music before any SFX, with SFX packed);
- binding kind validation and the lookup chains;
- image lookups ignore audio providers;
- miss upsert, registry filtering and auto-clear on bind;
- export → seed round trip on a fresh scratch DB.

**Client (pure functions, node vitest):**
- chain resolution
- weighted pick
- biome hysteresis
- voice caps and same-clip throttle
- distance falloff and pan
- miss dedupe

`AudioEngine` is tested against a fake AudioContext.

**Browser verification per slice:** in the running game, check that the
expected bus has an active source node and nonzero gain (the engine exposes a
dev-only `window.__s2audio` snapshot), and that crossing a biome border changes
the ambience source. A green suite is not proof the feature is alive.

### Slices

1. **World music + biome ambience, end to end:**
   - the first live `POST /api/audio` call records its response shape in section 2;
   - `modality` plus the adapter's `propose`/`generateTrack`;
   - `audio_clips` / `audio_bindings` plus the subject registry (world and
     biome only);
   - single generate and upload in the Audio tab;
   - the `.ogg` MIME type, the bindings endpoint and the per-chunk biome grid;
   - `AudioEngine` with music and ambience buses, volume settings, misses log;
   - browser verification.
2. **Batch + git:**
   - `audio_jobs` and the grouped dispatcher for music and ambience;
   - batch mode and the Missing-sounds → batch action;
   - "Sounds" sections in the world and biome editors;
   - library view;
   - `make audio-export` / `audio-seed`.
3. **Creature and combat SFX:**
   - the `k`/`s` wire fields;
   - creature, attack-type, item, skill and world-point subjects and slots;
   - creature nearby/attack/hurt/death and attack use/hit with the chain;
   - voice caps and throttle;
   - misses for these triggers;
   - the `sfx-pack` drain groups (`sfx_realistic`, `sfx_retro`) and the "Sounds" section in the entity-type editor;
   - browser verification in a fight.

   Moved from slice 2 on 2026-09-29: no SFX subject exists before slice 3.

## Out of scope

- Per-area sound zones drawn inside a map.
- Positional 3D audio beyond distance falloff and stereo pan.
- Footsteps, UI clicks, level-up stingers (easy later: new slots in the
  registry).
- A second audio provider or a template-driven audio adapter.
- Re-encoding or loudness normalisation on this side.
