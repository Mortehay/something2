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
`loopable` (bool), `source` (`generated` | `uploaded` | `seeded`),
`provider_id` (nullable FK, `ON DELETE SET NULL`), `prompt`, `style_or_cue`,
`seed`, `created_at`.

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
`style`, `cue`, `entity`, `variants`, `seed`, `duration_s`, `provider_id`,
`engine_group` (`music` | `sfx`), `state` (`queued` | `running` | `done` |
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
| `generateSfx` | `POST /api/audio/sfx {cue, entity?, world?, variants, seed?}` | one cue, 1-5 variants (base64 OGG each) |
| `generateSfxPack` | `POST /api/audio/sfx-pack {items:[{cue, entity?}], world?, variants, seed?}` | many cues, one model load; per-cue failures reported individually |
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
- **Grouped by engine so the box switches model at most once per group.** It
  drains every queued `music` group job first, then every `sfx` job. SFX jobs
  are packed into `sfx-pack` calls of up to `AUDIO_SFX_PACK_SIZE` cues
  (default 12). Each cue's variants become that job's clips.
- **The box's 409 on model switch, or "busy", is back off and retry.** It never
  calls `model-gateway/switch` with `force`.
- A circuit breaker stops the run after `AUDIO_MAX_CONSECUTIVE_FAILURES`
  (default 3) provider failures in a row, as in art.
- **Timeout:** `AUDIO_GENERATE_TIMEOUT_MS`, default 10 min (music on the GPU
  can take minutes).

### Open items: facts to record from the live box before slice 1 Task 1

The box enforces auth and its OpenAPI leaves response bodies untyped. With a
`something2-audio` key, one read-only pass plus one small test generation must
record, in this spec:

1. **`POST /api/audio`:** is it synchronous, or does it return a job to poll?
   Which field holds the audio (base64 in JSON, or a name to `fetchTrack`)?
2. **Cue list:** the real list from `GET /api/audio/styles?kind=sfx`, and the
   final slot → cue map (section 4) written against it.
3. **Codec** of the delivered OGG (Vorbis or Opus), its bitrate, and sample
   sizes for one music track and one SFX.

The adapter isolates all three, so the answers change one function each.

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
- The client works out the biome under the player from the world's biome
  preview grid (`GET /api/worlds/:id/preview`, already cached server-side),
  fetched once per join.
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

### Wire change (slice 3)

Today `attacks` and `impacts` records carry an actor or target id and a VFX
name only, so the client cannot tell a sword from a fireball. The authority
adds two fields to every attack and impact record it builds (`world.js`,
`creatures.js`, `projectiles.js`):

- `k`: `melee` | `ranged` | `magic`
- `s`: item type name or skill id (omitted for creatures, which use `a`/`t` to
  find their type)

The server stays ignorant of audio: it labels what happened and VFX is
untouched. The mapping from weapon/skill to `k` lives in one authority helper
and is unit-tested against every `item_types.kind` and skill `type`.

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
- **SFX:** slot → cue, with `entity` set to the creature, item or skill name
  where one exists. The map is written against the box's real cue list (open
  item 2). Its intended shape: `creature/*/hurt` → `hurt`; `creature/*/death` →
  `death`; `creature/*/nearby` → `idle`; `attack_type/melee/use` → a swing cue;
  `attack_type/magic/hit` → a magic-impact cue.

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

WAV (16-bit, 44.1 kHz, stereo) is about 10.5 MB/min; OGG is 10-20× smaller.

**Targets:**
- music: ~96 kbps stereo (≈0.7 MB/min)
- ambience: ~64 kbps stereo
- SFX: mono, ~48-64 kbps, typically 10-40 KB per clip

**Expected library:** about 30 tracks of about 2 min plus about 500 SFX comes
to about 45-60 MB, the same order as the 100 MB of committed textures.

**Codec:** Vorbis vs Opus is decided from open item 3. Opus is about 35%
smaller at equal quality and is chosen only if it decodes via
`decodeAudioData` in every target browser. Otherwise keep Vorbis. No
re-encoding happens on this side.

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
   - open items resolved;
   - `modality` plus the adapter's `propose`/`generateTrack`;
   - `audio_clips` / `audio_bindings` plus the subject registry (world and
     biome only);
   - single generate and upload in the Audio tab;
   - the `.ogg` MIME type and the bindings endpoint;
   - `AudioEngine` with music and ambience buses, volume settings, misses log;
   - browser verification.
2. **Batch + git:**
   - `audio_jobs` and the grouped dispatcher with `sfx-pack`;
   - batch mode and the Missing-sounds → batch action;
   - editor "Sounds" sections;
   - library view;
   - `make audio-export` / `audio-seed`.
3. **Creature and combat SFX:**
   - the `k`/`s` wire fields;
   - creature, attack-type, item, skill and world-point subjects and slots;
   - creature nearby/attack/hurt/death and attack use/hit with the chain;
   - voice caps and throttle;
   - misses for these triggers;
   - browser verification in a fight.

## Out of scope

- Per-area sound zones drawn inside a map.
- Positional 3D audio beyond distance falloff and stereo pan.
- Footsteps, UI clicks, level-up stingers (easy later: new slots in the
  registry).
- A second audio provider or a template-driven audio adapter.
- Re-encoding or loudness normalisation on this side.
