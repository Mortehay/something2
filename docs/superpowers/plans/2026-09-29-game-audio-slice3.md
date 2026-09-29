# Game Audio — Slice 3 (creature + combat SFX) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a fight you hear weapons and spells on use and on hit. Creatures make noise when you're near them, when they attack, when they're hurt, and when they die. Waypoints and portals hum.

All of it is assignable per creature / weapon / skill / attack type / world point. It can be generated singly or in batches on the GPU box (grouped `sfx-pack` calls), or uploaded where the box has no suitable cue.

**Architecture:**
- **Events:** the authority emits a small, capped `sfx` event list in each world frame (`{e, k, s, c, a, x, y}`). It labels *what happened* and knows nothing about audio. The existing `attacks`/`impacts` VFX records are untouched.
- **Backend:** the subject registry grows five kinds with a slot → box-cue map. The queue gains the `sfx_realistic` / `sfx_retro` drain groups, which pack up to N jobs into one `sfx-pack` call.
- **Client:** the AudioEngine gains a polyphonic, positional sfx bus with voice caps, plus a "nearby" scheduler for creatures and world points.

**Tech Stack:** as slices 1–2.

**Spec:** [docs/superpowers/specs/2026-09-28-game-audio-design.md](../specs/2026-09-28-game-audio-design.md) — §1 subject table, §3 triggers/limits/misses, §4 SFX cue map, "Box contract", Slices item 3.

**Deviation from the spec, recorded as a ruling in Task 0:**
- **The spec:** asks for `k`/`s` fields on every VFX attack and impact record.
- **The code today:**
  - player projectile/magic shots emit NO attack record;
  - projectile hits emit NO impact record;
  - skill casts and creature deaths emit nothing at all;
  - the client drops `t` on impacts.
- **Consequence:** tagging the VFX records would leave most sounds silent.
- **Ruling:** a dedicated `sfx` event channel, built at the same sites. The spec's intent ("the server labels what happened, VFX is untouched") is preserved.

## Box facts this slice relies on (measured 2026-09-29, live box)

- **Cues:** `slash, hit, pickup, spell, footstep, ui_click, miss, chest_open, death, waypoint`, each with `engines` `realistic`/`retro` (footstep realistic only). There is NO `idle`, `attack` or `shoot` cue.
- **`POST /api/audio/sfx-pack` request:** `{items:[{cue, entity?, engine?}], engine?, world?, variants, seed?}`.
- **`POST /api/audio/sfx-pack` response:** `{items:[{cue, entity, engine, name, prompt, seed, sample_rate, variants:[{url, duration_s, onset_ms}], audio:[base64 OGG…], cached, served_from, generation_id}], count, failed}`. A per-item failure appears in `items` with an error; the implementer records the exact failure shape from a live call in Task 3.
- **Unknown cue:** a single unknown cue makes the WHOLE pack fail with HTTP 400 `{"detail":"unknown cue '<x>'; see GET /api/audio/styles?kind=sfx"}`.
- **Caching:**
  - `/sfx` and `/sfx-pack` cache by `(engine, cue, entity)` and IGNORE the seed: seeds 8 and 9 both returned the seed-1 file, `cached:true`.
  - A different `entity` text generates fresh.
  - So variation and regeneration MUST change the `entity` text.
- **Speed:** `retro` renders in ~0.1 s with no model load; `realistic` takes ~16 s per cue.

## Global Constraints

- **Format:** OGG only, stored as delivered; never WAV, never `?master=true`, never re-encode.
- **Subjects:** subjects keyed by NAME. New kinds:
  - `creature` = `entity_types.name` where `is_creature`
  - `world_point` = `entity_types.name` where `point_kind` is set
  - `item` = `item_types.name` where `category='weapon'`
  - `skill` = skill `id` from `backend/seeds/data/skills.js`
  - `attack_type` ∈ `melee|ranged|magic`
- **Slots:**
  - creature: `nearby, attack, hurt, death`
  - attack_type / item / skill: `use, hit`
  - world_point: `nearby`
  - All are clip kind `sfx`.
- **Lookup chains (spec §1):** attack `use`/`hit` = `item` or `skill` → `attack_type` → silence. Everything else is the subject's own slot → silence. A miss is recorded at the most specific key.
- **Client limits (spec §3):**
  - at most 12 sfx voices;
  - at most 3 plays of the same clip within 100 ms;
  - at most 4 creature `nearby` voices, nearest win;
  - creature `nearby` only within 8 tiles, every 4–10 s with a random offset;
  - linear distance falloff and stereo pan;
  - priority: the player's own actions, then the nearest.
- **Authority:** the `sfx` frame list is capped (64, like attacks) and omitted when empty. The authority never reads audio tables.
- **Generation:**
  - every generation sends an explicit integer seed;
  - SFX variation changes the `entity` text (the box ignores the seed for SFX caching);
  - unknown cues are never sent (the provider's `models_cache` `cue:*` list is the allow-list);
  - upload-only slots (no cue) are never queued.
- **Carried over from slices 1–2:** the rules on DB tests, advisory locks, cleanup, commits, worktree and the green baseline are unchanged. Key points:
  - `AUDIO_JOBS_LOCK_KEY` / `AUDIO_CLIPS_LOCK_KEY`;
  - baseline = main's 7 failing backend files; known flakes are the art-job family;
  - frontend baseline = progressionExtras.
- **Migration:** none is expected. The `clip_kind`/`drain_group` CHECKs already allow `sfx`, `sfx_realistic` and `sfx_retro`. If one becomes necessary, use timestamp `1714440580000`.

## Review Focus

1. **A pack fight** (8 slimes + 2 players, everyone swinging). There are no more than 12 simultaneous sfx voices, no burst of the same clip, the player's own swing is always audible, and frame size stays bounded (sfx list capped at 64). Pinned in Task 5 (authority cap) and Task 6 (engine limits).
2. **A creature dies vs. walks out of view.** Only a real death plays `death`; leaving AOI plays nothing. Pinned in Task 5 (explicit death event) and Task 6.
3. **The box has no cue for a slot** (creature nearby/attack, ranged use). Generate and batch never send it: the UI shows "upload only", and the queue rejects it. A mixed pack with one unknown cue must not fail the other cues. Pinned in Task 2 (registry cue map) and Task 4 (drain filters by allow-list).
4. **Regenerate an SFX slot twice.** Each run yields a different file (the entity text varies); the box cache is never hit for a regeneration. Pinned in Task 3.
5. **A skill cast by another player.** Nearby players hear it (a server event), not only the caster. Pinned in Task 5.

---

## File map

**Backend:**
- `backend/src/services/audioSubjects.js`: five new kinds, `cueFor(kind, slot)`, `entityPhrase(kind, key, db)`
- `backend/src/services/remoteAudioProvider.js`: `generateSfx`, `generateSfxPack`
- `backend/src/services/audioGeneration.js`: the sfx path in `generateForSlot`; `sfxEntityText(phrase, take)`
- `backend/src/services/audioJobQueue.js`: `DRAIN_ORDER` + sfx groups, `drainGroupFor(clipKind, engine)`, an `engine` column in enqueue (already in the table), `claimBatch(db, group, n)`
- `backend/src/services/audioDispatcher.js`: the pack path for sfx groups
- `backend/src/services/audioLibrary.js`: `worldAudioBundle` includes the sfx subjects
- `backend/src/api/audioRoutes.js`: sfx generate, cue allow-list, upload-only rejection
- `backend/src/authority/sfxEvents.js` (new): `attackKindOf(weapon)`, `skillAttackKind(skill)`, event builders
- `world.js`, `creatures.js`, `projectiles.js`, `server.js`: emit events; frame key `sfx`
- tests: `audio_subjects_sfx_db`, `remote_audio_provider` (extend), `audio_sfx_generation_db`, `audio_dispatcher_db` (extend), `sfx_events.test.js`, `authority_sfx_frame.test.js`

**Frontend:**
- `src/js/audio/sfxLimits.js` (new, pure): voice-cap / throttle / priority decisions
- `src/js/audio/sfxResolve.js` (new, pure): event → chain keys + miss key
- `src/js/audio/nearbyScheduler.js` (new, pure): who may make noise now
- `AudioEngine.js`: the sfx bus, `playSfx`, positional voices, `tickNearby`
- `Game.js`: pass `frame.sfx` and the positions of creatures and world points
- `WorldAuthorityClient.js`: pass `sfx` through, if needed
- `GameSettings.jsx`: SFX slider
- `SettingsAdmin.jsx`: audio card hides Model and shows styles/cues read-only
- `AudioSlotCard.jsx` / `AudioBatchControls.jsx`: "upload only" marker, engine choice
- `EntityTypesAdmin.jsx`: `SubjectSounds` for creatures and world points

---

### Task 0: Setup + spec ruling

- [ ] **Step 1:** Create the worktree `../something2-audio3` on branch `feat/game-audio-slice3` from main (`9f3a90c` or later), with node_modules symlinks and a check-ignore check.
- [ ] **Step 2:** Create the scratch DB `game_audio_s3`, fully seeded:
  - migrate
  - `seed-catalogs`
  - `FORCE=1 seed-passive-tree`
  - `SPEC=p5-descent seed-map`, then `SPEC=vale-region seed-map` (LAST)
  - write `db.env` (mode 600).
- [ ] **Step 3:** Create a Plane child item "Game audio slice 3 — creature + combat SFX" under SOMET-589, state In Progress.
- [ ] **Step 4:** Spec edits (commit `docs: audio slice 3 wire + box-cache rulings (SOMET-NNN)`):
  - §3 "Wire change": replace it with the `sfx` event channel (shape in Task 5) and the reason, in 4 lines.
  - "Box contract": add the measured SFX facts from this plan's "Box facts" section:
    - the cache ignores the seed, so vary the entity text;
    - an unknown cue fails the whole pack;
    - the pack response shape.

---

### Task 1: AI Providers — no "Model" select on audio providers

**Files:** `frontend/src/games/something2/SettingsAdmin.jsx`, `providerForm.js`

**Why:** the audio card shows a "Model" select filled with styles and cues (`cue:slash`, `forest`, …). The box switches its audio models itself (`audio:ace-step`, `audio:stable-audio`), and no request can choose one, so the select is meaningless. The user flagged it on 2026-09-29.

- [ ] **Step 1:** Failing test. `providerFormToPayload` for `modality:'audio'` must not send `model`. Add a pure `audioCatalogSummary(models_cache)` → `{styles:[…], cues:[…]}` (splitting on the `cue:` prefix), with a unit test.
- [ ] **Step 2:** Implement:
  - When `isAudio`, do not render the Model select. Render a read-only "Styles" and "Cues" list from `models_cache` via `audioCatalogSummary`, with the fetched-at note.
  - Keep "Refresh models", relabelled "Refresh styles & cues".
  - Test connection unchanged.
- [ ] **Step 3:** `npx vitest run` + eslint; commit `fix(admin): audio providers show styles and cues, not a model picker (SOMET-NNN)`.

---

### Task 2: Subject registry for SFX subjects + bundle

**Files:** `audioSubjects.js`, `audioLibrary.js` (`worldAudioBundle`), `audioGeneration.js` (`contextFor` fallthrough), tests `audio_subjects_sfx_db.test.js`

**Interfaces:**
- `SUBJECT_KINDS` gains the entries below. Each entry has `{label, slots, list(db), exists(db, keys)}` and a new per-slot `cues: {slot: cue|null}`.

| kind | list/exists source | slots → cue |
|---|---|---|
| `creature` | `SELECT name FROM entity_types WHERE is_creature` | `nearby: null`, `attack: null`, `hurt: 'hit'`, `death: 'death'` |
| `world_point` | `SELECT name FROM entity_types WHERE point_kind IS NOT NULL` | `nearby: 'waypoint'` |
| `attack_type` | fixed `['melee','ranged','magic']` | melee: `use:'slash'`, `hit:'hit'`; ranged: `use:null`, `hit:'hit'`; magic: `use:'spell'`, `hit:'hit'` |
| `item` | `SELECT name FROM item_types WHERE category='weapon'` | `use` / `hit` → the cue of the item's attack type (derive the kind with `attackKindOf` from Task 5's shared helper) |
| `skill` | `SKILLS` from `seeds/data/skills.js` (ids) | `use: type==='melee' ? 'slash' : 'spell'`, `hit: 'hit'` |

- `cueFor(db, kind, key, slot) -> Promise<string|null>`: null means upload-only.
- `entityPhrase(db, kind, key) -> string`. The text sent as `entity`:
  - creature → its name, lower-cased;
  - item → the item name;
  - skill → the English skill name (`nameEn`);
  - attack_type → `melee` "a steel sword", ranged "an arrow", magic "a magic blast";
  - world_point → the type name.
- `worldAudioBundle` also returns every binding of the `creature`, `world_point`, `attack_type`, `item` and `skill` kinds (global, not per world). That is bounded by catalog size.
  - **Ruling:** global rather than "creature types in this world". A creature can wander in, and the per-world filter needs spawn-table joins; the cost is a few KB.
- Put `attackKindOf` in `backend/src/authority/sfxEvents.js` now, as a pure function with no authority imports, so the registry and the authority share ONE definition. It is written in full in Task 5; this task creates the file with just this function and its test:

```js
// Which attack sound family a weapon belongs to (spec §1 attack_type).
// melee weapons → melee; projectile weapons that use ammo (bows, crossbows,
// thrown) → ranged; projectile weapons without ammo (wands, staves, scepters)
// or anything carrying a spell stone → magic.
function attackKindOf(w) {
  if (!w) return 'melee';
  if (w.stoneItemId || w.augment || w.stone_mode) return 'magic';
  if (w.kind === 'melee') return 'melee';
  return w.ammo_type_id != null ? 'ranged' : 'magic';
}
```

- [ ] **Step 1:** Failing tests (scratch DB, `AUDIO_CLIPS_LOCK_KEY` where clips are created):
  - `attackKindOf` over every seeded weapon row: expect the gear-ladder families (blade/sword/axe/mace/spear/dagger/quarterstaff → melee, bow/crossbow → ranged, wand/staff/scepter → magic), asserted against a hand-written table, not the helper;
  - `cueFor` for each kind/slot, including upload-only nulls;
  - `exists`/`list` for the new kinds;
  - binding an sfx clip to `creature/<real>/hurt` works; to `creature/<real>/music` is a 400;
  - `recordMisses` accepts the new kinds and drops unknown keys;
  - `worldAudioBundle` includes a creature binding and an attack_type binding.
- [ ] **Step 2:** Implement; commit `feat(audio): creature, world point, attack type, item and skill sound subjects (SOMET-NNN)`.

---

### Task 3: Adapter + single SFX generate

**Files:** `remoteAudioProvider.js`, `audioGeneration.js`, `audioRoutes.js`, tests (extend `remote_audio_provider.test.js`, new `audio_sfx_generation_db.test.js`)

**Interfaces:**
- `generateSfx(provider, {cue, entity, engine, variants, seed}) -> {ok, clips:[{buffer, durationMs, sampleRate}], prompt, seed, cached} | {ok:false, error, retryable, status, providerFault}`
  - Calls `POST /api/audio/sfx`.
  - Every clip passes `checkClipBuffer(buf,'sfx')`.
  - `cached:true` is passed through.
- `generateSfxPack(provider, {items:[{cue, entity, engine}], variants, seed}) -> {ok, items:[{ok, cue, entity, clips, prompt, seed, cached} | {ok:false, cue, entity, error, providerFault}]} | {ok:false, error, retryable, status, providerFault}`
  - A whole-pack 400 whose body names an unknown cue → `{ok:false, error, retryable:false, providerFault:false, unknownCue:'<x>'}`.
  - Record the real per-item failure shape from a live call (retro, with an entity the box rejects if one exists; otherwise document "no per-item failure observed").
- `sfxEntityText(phrase, take)`: `take` 0 → `phrase`; `take` ≥ 1 → `` `${phrase} (take ${take})` ``. This is the ONLY way SFX variation is produced.
- `generateForSlot` with `clipKind==='sfx'`:
  1. `cue = await cueFor(...)`; null → `{ok:false, error:'upload only: the provider has no cue for this slot', retryable:false}`.
  2. The cue must be in `provider.models_cache` as `cue:<name>`, else the same kind of error, naming the cue.
  3. `entity = sfxEntityText(await entityPhrase(...), take)`, where `take` = the number of existing clips already bound to that slot (so a regenerate differs).
  4. `generateSfx` with `variants` (default 3) and `engine` (default the cue's `default_engine`, or `'realistic'`).
  5. Store and bind each variant in ONE transaction per variant (`storeAndBindClip`); `style_or_cue = cue`, `engine` set.
  6. If the result is `cached:true`, bump `take` once and retry once, then accept.
- `POST /admin/generate` for sfx slots:
  - replaces the "sfx arrives in slice 2" 400;
  - body adds optional `engine` and `variants` (1–5);
  - returns 201 `{clips:[…], bindings:[…]}` for sfx;
  - music/ambience keep `{clip, binding}`.

- [ ] **Step 1:** Failing tests.
  - Adapter tests use a fake box:
    - `/sfx` success with 2 variants;
    - a WAV variant is rejected;
    - a pack with one item failing;
    - a pack 400 with an unknown cue → `unknownCue`;
    - the token is never in an error.
  - `generateForSlot` DB tests:
    - an upload-only slot is refused with no box call;
    - a cue missing from `models_cache` is refused;
    - with 1 clip already bound, the entity sent is `"<phrase> (take 1)"`;
    - `cached:true` triggers exactly one retry with take+1;
    - variants store and bind N clips.
  - Route test: a player gets 403; an sfx generate returns 201 with N clips.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** One live call to the real box: a retro pack with 2 known cues + 1 item, recording the per-item shape into the spec "Box contract" (the key is in the scratchpad `audio.key`; never commit it).
- [ ] **Step 4:** Commit `feat(audio): sfx generation — single cue and packs, entity-text variation (SOMET-NNN)`.

---

### Task 4: Queue + drain for SFX packs

**Files:** `audioJobQueue.js`, `audioDispatcher.js`, `audioRoutes.js` (jobs enqueue), tests (extend `audio_job_queue_db`, `audio_dispatcher_db`, `audio_jobs_routes_db`)

**Interfaces:**
- `DRAIN_ORDER = ['music', 'ambience', 'sfx_realistic', 'sfx_retro']`.
- `drainGroupFor(clipKind, engine='realistic')`: `sfx` → `engine==='retro' ? 'sfx_retro' : 'sfx_realistic'`. `enqueue` items accept `engine`, which is stored in `audio_jobs.engine`. Check the column exists: slice-2 migration 1714440570000 has `drain_group` but NOT `engine`; `style` holds nothing for sfx.
  - **If `engine` is missing:** add migration `1714440580000_audio_jobs_engine.js` with `engine text CHECK (engine IN ('realistic','retro'))`.
- `claimBatch(db, n) -> jobs[]`: claims up to `n` claimable jobs of the SAME drain group as the first claimable job in DRAIN_ORDER, with `FOR UPDATE SKIP LOCKED`. Music/ambience keep `n = 1`.
- Dispatcher: when the claimed group is sfx, it
  1. filters jobs whose cue is null or not in the provider's allow-list → `fail(..., 'upload only' | 'cue not offered', {retryable:false})`, not counted;
  2. builds one `generateSfxPack` with `items: jobs.map(j => ({cue, entity, engine}))`, where the entity uses the same take rule as Task 3 per job;
  3. maps each result item back to its job: ok → store/bind variants → `complete(job, firstClipId)`; failed item → `fail(job, err, {retryable: item.providerFault})`;
  4. treats a whole-pack failure as a single provider outcome (busy → pause + refund ALL jobs; provider fault → counted once; `unknownCue` → fail only the offending jobs and re-queue the rest with attempts refunded).
- `AUDIO_SFX_PACK_SIZE` env (default 12, `envInt`).
- `POST /admin/jobs` accepts sfx slots:
  - it rejects upload-only slots into `rejected` with `'upload only: no cue on the provider'`;
  - the per-item `engine` is optional;
  - the slice-2 `'sfx batches arrive in slice 3'` rejection is removed.

- [ ] **Step 1:** Failing tests, under `AUDIO_JOBS_LOCK_KEY` with fake deps:
  - drain order puts music → ambience → sfx_realistic → sfx_retro;
  - 14 sfx jobs → 2 pack calls (12 + 2), each call with one group only;
  - one failed item fails only its job;
  - a busy pack refunds all its jobs;
  - an upload-only job never reaches the box;
  - an unknown-cue 400 fails only that cue's jobs;
  - the enqueue route rejects upload-only.
- [ ] **Step 2:** Implement; commit `feat(audio): sfx drain groups packed into sfx-pack calls (SOMET-NNN)`.

---

### Task 5: Authority `sfx` events

**Files:** `backend/src/authority/sfxEvents.js` (extend), `world.js`, `creatures.js`, `projectiles.js`, `server.js`; tests `sfx_events.test.js` (pure), `authority_sfx_frame.test.js`

**Event shape (one list per world, per frame key `sfx`, cap 64, omitted when empty):**

```
{ e: 'use'|'hit'|'hurt'|'death',
  k?: 'melee'|'ranged'|'magic',       // attack family (use/hit)
  s?: '<item name>' | 'skill:<id>',   // specific source (use/hit), absent for creatures/unarmed
  c?: '<creature type name>',         // creature events (use by creature, hurt, death)
  a?: 'p:<uid>'|'c:<id>',             // actor (use) — lets the client prioritise its own actions
  x, y }                              // world px where it happened
```

**Where each event is pushed:**
- **Player melee swing** (world.js `attack()`, where the attack record is built): `{e:'use', k: attackKindOf(w), s: w.name, a:'p:uid', x, y}`.
- **Player melee hit** (each impact): `{e:'hit', k, s, x, y}` at the target. For a creature target, ALSO `{e:'hurt', c: creature.type, x, y}`.
- **Player projectile/magic fire** (the world.js projectile branch that returns `attacks: []`): `{e:'use', k: attackKindOf(w), s: w.name, a:'p:uid', x, y}`.
- **Projectile hit** (projectiles.js, where damage is applied to a creature or player):
  - use the projectile's weapon name: store `weaponName` and `k` on the projectile object at spawn;
  - emit `{e:'hit', k, s, x, y}`, plus `hurt` for a creature target;
  - for creature-owned projectiles, `{e:'hit', c: ownerType, x, y}`.
- **Detonation:** `{e:'hit', k:'magic', s: weaponName, x, y}` once per detonation, not per victim.
- **Creature melee attack** (`stampCreatureAttack`): `{e:'use', c: c.type, a:'c:id', x, y}` (plays creature `attack`), plus a `hit` at the target with `c`.
- **Creature ranged/cast spawn** (creatures.js ~1986): `{e:'use', c: c.type, a:'c:id', x, y}`.
- **Creature death** (server.js `onCreatureDeath`, before/after `commitCreatureDeath`, with the creature's last position and type): `{e:'death', c: type, x, y}`. The id must no longer be in the sim at the time, so read the position/type from the kill record; if absent, capture them where the kill is detected and carry them on the kill.
- **Skill cast** (server.js `castSkill` success): `{e:'use', k: skillAttackKind(skill), s:'skill:'+skill.id, a:'p:uid', x, y}`, where `skillAttackKind` = melee for `type==='melee'`, else magic.
- **The frame:** server.js stashes events per world like `pushAttacks` (`pushSfx`, cap 64, overflow drops newest) and drains them into `frame.sfx`. It does the same for events created inside `world.tick` (creatures).

- [ ] **Step 1:** Failing tests.
  - Pure (`sfx_events.test.js`):
    - `attackKindOf` table (the Task 2 test lives here);
    - `skillAttackKind`;
    - every builder returns exactly the documented keys, with no `undefined` values.
  - Authority frame test: drive a world (follow an existing authority test harness — grep `tests/authority_*.test.js` for how they build a world and tick it) through:
    - a player melee swing that hits a creature → frame has `use` (k melee, s = weapon name, a = p:uid) + `hit` + `hurt` (c = creature type);
    - a projectile weapon fire → `use` k ranged or magic per `attackKindOf`;
    - a creature killed → a `death` event with its type and position;
    - 100 events in one tick → frame `sfx` length 64.
- [ ] **Step 2:** Implement at each site. Keep VFX records and their tests unchanged (run the existing vfx/authority tests: `grep -l "attacks\|impacts" backend/tests/*.test.js`).
- [ ] **Step 3:** Commit `feat(authority): sfx event channel — use, hit, hurt, death, skill casts (SOMET-NNN)`.

---

### Task 6: Client — sfx bus, resolution, limits

**Files:** `src/js/audio/sfxResolve.js`, `src/js/audio/sfxLimits.js`, `AudioEngine.js`, `Game.js`, `WorldAuthorityClient.js` (if `sfx` needs passing), `audioSettings.js` (`sfx` volume is already in the defaults), tests `__tests__/sfxResolve.test.js`, `sfxLimits.test.js`, `AudioEngine.test.js` (extend)

**Interfaces:**
- `sfxChains(ev) -> [{ keys: string[], missKey }]`. One event can produce two sounds, e.g. `hit` on a creature plays the attack hit and the creature hurt comes as a separate `hurt` event:
  - `use` with `s:'skill:<id>'` → `['skill/<id>/use', 'attack_type/<k>/use']`;
  - `use` with an item `s` → `['item/<s>/use', 'attack_type/<k>/use']`;
  - `use` with `c` only → `['creature/<c>/attack']`;
  - `hit` with `s` → `['item/<s>/hit' | 'skill/<id>/hit', 'attack_type/<k>/hit']`;
  - `hit` from a creature (`c` set, no `s`) → `['attack_type/melee/hit']` (the creature's own `attack` sound already played on its `use`);
  - `hurt` → `['creature/<c>/hurt']`;
  - `death` → `['creature/<c>/death']`;
  - `missKey` = the first key.
- `SfxLimiter` (pure, `now` injected):
  - `admit({clipKey, priority, distance}) -> {ok, evict?: voiceId}`;
  - enforces max 12 voices, same clip ≤3 per 100 ms, and priority `own` > nearest;
  - `release(voiceId)`.
- **AudioEngine:**
  - an `sfx` bus under master;
  - `playSfxEvents(events, { listener:{x,y}, ownActor:'p:<uid>' })` resolves the chains via `resolveChain(bindings, keys)`, picks the clip weighted, and records a miss at the most specific key when the chain is empty;
  - it spawns a one-shot source through `StereoPannerNode` (pan = clamp(dx / 600, -1, 1)) and a gain with linear falloff (1 at 0 px, 0 at 1600 px), governed by `SfxLimiter`;
  - `snapshot().sfx = {voices, playedTotal, droppedTotal}`.
- **Game.js:** in `_onWorldState`, after the VFX handling, call `this.audio.playSfxEvents(frame.sfx || [], {...})` with the player centre and own `p:<uid>`.

- [ ] **Step 1:** Failing pure tests:
  - the chains per event shape;
  - the miss key;
  - limiter: a 13th voice is refused or evicts the farthest non-own voice; the 4th same-clip play within 100 ms is refused; an own action evicts a far one.
  - Engine test with the fake AudioContext (extend its fake with `createStereoPanner`):
    - a `use` event with a bound item clip starts one source on the sfx bus with pan and gain set;
    - an unbound event records one miss;
    - 20 events → at most 12 started.
- [ ] **Step 2:** Implement; commit `feat(client-audio): positional sfx bus with voice caps (SOMET-NNN)`.

---

### Task 7: Client — creature and world-point "nearby"

**Files:** `src/js/audio/nearbyScheduler.js` (pure), `AudioEngine.js`, `Game.js`; tests `nearbyScheduler.test.js`, `AudioEngine.test.js` (extend)

**Interfaces:**
- `NearbyScheduler({ radiusPx = 8 * MAP_TILE_SIZE, maxVoices = 4, minGapMs = 4000, maxGapMs = 10000, rand, now })`.
- `tick(emitters: [{id, key, x, y}], listener) -> [{id, key, x, y, distance}]` returns emitters due to sound now:
  - within the radius;
  - their personal next-time reached (first time = now + random offset in [0, maxGap]);
  - at most `maxVoices` concurrently "sounding" (the caller reports ends via `ended(id)`);
  - the nearest win.
  - Each due emitter's next time = now + random(minGap, maxGap).
- **Engine:** `tickNearby(creatures, points, listener)`, called every frame from Game.update and internally throttled to 250 ms.
  - Creatures: `key = creature/<type>/nearby`, plays a weighted-random clip through the sfx path (priority "nearby", lowest).
  - World points: `key = world_point/<art>/nearby`. For a `loopable` clip, one looping source per point while within the radius; fade out on leaving. For a non-loopable clip, the scheduler's cadence.
  - Misses are recorded once per key.
- **Game.js:**
  - creatures from `this.creatures.creatures` (`{id, type, x, y}`);
  - points from `this.landmarks` (`art`, x, y) plus `this.worldChests` / posts, where `art` is set.

- [ ] **Step 1:** Failing pure tests:
  - nothing outside the radius;
  - at most 4 concurrent, nearest first;
  - per-emitter cadence within [4, 10] s with an injected rand;
  - an ended voice frees a slot.
  - Engine: two creatures of a bound type within range start at most one source each on cadence; a loopable world-point clip loops and stops when out of range.
- [ ] **Step 2:** Implement; commit `feat(client-audio): creature and world-point nearby sounds (SOMET-NNN)`.

---

### Task 8: Settings + admin UI for SFX

**Files:** `GameSettings.jsx` (SFX slider), `AudioSlotCard.jsx`, `AudioBatchControls.jsx`, `audioBatch.js`, `useAudioAdmin.js`, `EntityTypesAdmin.jsx`, `AudioAdmin.jsx` (subject groups come from the registry automatically); tests extend `audioBatch.test.js`, `volumeModel.test.js`

**Changes:**
- **Sound tab:** add the SFX slider (`sfx` is already in `DEFAULT_VOLUMES` / `applyVolumeChange`).
- **`GET /admin/subjects`** (Task 2 registry) also returns `cues: {slot: cue|null}` per group. Make the route include it if Task 2 did not.
  - `AudioSlotCard`: when `cues[slot] === null`, it shows "Upload only — the provider has no cue for this slot" and hides Suggest/Generate.
  - SFX slots get an engine select (Realistic / Retro) and a Variants (1–5) input next to Generate.
- **Batch:**
  - `buildBatchItems` now includes SFX slots EXCEPT upload-only ones, which are shown struck-through with the reason;
  - the batch has an engine choice for SFX (default realistic);
  - the slice-2 "SFX batches arrive in slice 3" disabled-tooltip path is removed;
  - Missing-sounds rows for SFX slots become batchable (except upload-only).
- **EntityTypesAdmin:** each creature card and each world-point card renders `<SubjectSounds kind="creature"|"world_point" subjectKey={entity.name} compact />` next to `SpritePanel` (~line 1250). Nothing for other entity types.

- [ ] **Step 1:** Failing pure tests:
  - `buildBatchItems` keeps sfx slots, drops upload-only ones, and records them in a returned `skipped` list;
  - the volume model already covers `sfx` (add the assertion if missing).
- [ ] **Step 2:** Implement; `npx vitest run` + eslint; commit `feat(admin): sfx slots — upload-only marker, engine and variants, entity editor sounds (SOMET-NNN)`.

---

### Task 9: Verification — suites, live box, a real fight, docs

- [ ] **Step 1: Full backend suite on a fresh fully-seeded DB.** Green = main's 7-file baseline. Extra failures: rerun them alone twice, plus a second full run, before calling them intermittent.
- [ ] **Step 2: Frontend** `npx vitest run`: only progressionExtras may fail.
- [ ] **Step 3: Live GPU box.** The key is in the scratchpad `audio.key`; the dev stack already has provider `gpu-box-audio`. Check `GET /api/model-gateway` shows nothing pending first.
  1. On an isolated stack (`backend :13201` against the slice-3 scratch DB + vite `:15273` with `watch: null`), register an audio provider with the key.
  2. **Slice-2 carry-over (never verified live):** queue 1 music + 1 ambience + 4 SFX (2 realistic, 2 retro) with `start:true`. Record:
     - the order;
     - how many `/sfx-pack` calls were made (backend log or box ledger);
     - the box's `model-gateway` active model before, between and after the groups;
     - the total wall time.
  3. Regenerate one SFX slot twice: 3 distinct files (compare the bytes' sha1).
- [ ] **Step 4: A real fight in the browser** (isolated stack, player).
  1. Bind SFX, via upload or generate:
     - `attack_type/melee` use and hit;
     - the entry world's most common creature type: hurt and death;
     - one waypoint nearby.
  2. Walk to a creature and fight (memory: combat isn't script-friendly — pick a creature the level-1 character can kill; if the entry pen blocks movement, spawn/teleport per existing dev tools or pick a world whose spawn is outside a pen).
  3. Assert via `window.__s2audio().sfx`: `playedTotal` rises on swings/hits; a death event plays exactly once per kill; voices never exceed 12.
  4. Walk near the waypoint: its nearby sound starts; walk away: it stops.
  5. Record everything, and say plainly anything not verified.
- [ ] **Step 5: Docs.** `docs/ai-providers.md` audio section:
  - SFX subjects and slots, and the cue map with its upload-only slots;
  - variation = entity text (the box ignores the seed for SFX);
  - engines, packs, and the sfx drain groups;
  - the fight-side behaviour (limits, nearby).
  - Commit `docs: audio slice 3 — sfx subjects, packs, in-game behaviour (SOMET-NNN)`.
- [ ] **Step 6:** Finish with `superpowers:finishing-a-development-branch`.
