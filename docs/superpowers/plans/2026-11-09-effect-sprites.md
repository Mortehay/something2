# Effect Sprites (auras, bolts, impacts, beams) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The 21 batch-1 effects get box-generated pixel-art strips that the admin generates, previews, redraws and approves in an Effects section of the Sprite tab. Approved strips play in-game in place of the code-drawn shape, with the code shape kept as the fallback, and they travel with seed/export.

**Architecture:**
- A pure module (`effectSprites.js`) owns the batch-1 list, prompt defaults, the box request, atlas reading, the approve column mapping and the placeholder ETA.
- A new `effect_sprite_jobs` table with a small queue module and its own dispatcher. The dispatcher sends one job at a time to `POST /api/vfx` and reuses the existing box helpers for `/api/jobs/{id}`, `/sheet` and `/atlas`. It never touches `sprite_sets`.
- Approve copies the candidate sheet key and atlas facts into the subject row's `sprite_*` columns. The client already loads `vfx_effects` and `aura_effects` with `SELECT *`.
- The renderer gains looping/fps timing, a ground pass for sprite auras, a sprite on the projectile trail, and suppression of the duplicate code-drawn beam/lightning line.
- Seed-sync moves every `sprite_*` column of both tables into art-group slices with PNG assets.

**Tech Stack:** Node/Express (CommonJS, raw `pg`, node-pg-migrate), `node --test`; React + TanStack Query + vitest (node env); Canvas 2D; GPU box FastAPI at the active `sprite` provider's base URL.

**Spec:** `docs/superpowers/specs/2026-11-09-effect-sprites-design.md` (approved 2026-11-09). Reference plan for shape: `docs/superpowers/plans/2026-11-09-default-sprite-lane.md`.

## Global Constraints

- **Workspace:** work in your own git worktree (`superpowers:using-git-worktrees`). Never `checkout`/`stash`/`branch` in the shared checkout at the repo root; other sessions use it.
- **DB tests** run only on a private DB: `cd backend && DATABASE_URL=<private container url> node scripts/testdb.js run --keep -- tests/<file>`. Never use the shared dev DB. If `TEST_DATABASE_URL` is unset, tests hit the SHARED one. Never run destructive SQL against the shared dev DB. Tell every subagent this.
- **Never `pkill -f`.** Kill by a PID you have checked (`ss -ltnpH "sport = :PORT"` + `/proc/PID/cwd`).
- **No GPU traffic** (`POST /api/vfx`, `POST /api/jobs`, `/sdapi`, `/api/text`) except in Task 9. Tests use a fake `fetchImpl` or fake box. Read-only GETs (`/api/jobs`, `/api/model-gateway`) are fine.
- **Browser checks:** muted headless Chrome only (`--mute-audio`), on a free CDP port (check `ss` first).
- **Creature pipeline unchanged:** `sprite_sets`, `spriteJobQueue.js` and `spriteDispatcher.js` must not change behaviour. `effect_sprite_jobs` is a separate table and `effectDispatcher.js` a separate dispatcher.
- **Migrations:** the latest on origin/main today is `1714440877000_affix_triggers.js`, so the next free number is `1714440880000`. Run `git fetch && git ls-tree --name-only origin/main backend/migrations/ | sort | tail -3` before creating the migration, and again right before merge (recurring collision pattern). Don't edit a migration while a dev backend is up: it auto-applies on nodemon restart.
- **Box contract (spec §5.1 + box session plan, verbatim where possible):**
  - `POST /api/vfx {prompt, kind: projectile|burst|aura|beam, frames 1-64, size, loop, blend: additive|alpha, colors, seed}` → `202 {job_id}`.
  - It is a normal box `jobs` row (kind `vfx`), so `GET /api/jobs/{id}`, `/sheet` and `/atlas` work through the existing `getSheetJob`, `fetchSheet` and `fetchAtlas`.
  - It answers `422` at submit if frames > 64, strip width > 8192, height > 2048, or kind/blend is unknown.
  - The PNG ≤ 600 KB limit is enforced box-side.
  - Atlas: `{frames, fps_hint, loop, blend, pivot, cell, engine{model, steps, seed}}`. `pivot` is the centre, except for projectile/beam, where it is the TAIL end. Strips point RIGHT (+x).
- **Prompt rule:** callers send ONLY the subject (effect name + colour words). Never add "pixel art", "black background", "transparent" or "pointing right"; the box wraps the prompt per kind.
- **Blend rule:**
  - dark effects use `blend: 'alpha'`: `abyssor_void_rend`, `shade_veil`, `ossuary_dread`, `curse_blast`;
  - every other batch-1 effect uses `additive`;
  - approve writes `sprite_additive = (atlas.blend === 'additive')`.
- **One horizontal strip per sheet.** No multi-row sheets: `spriteSourceRect` and `_vfxSheet` assume one row. Sheets are stored under `vfx/<uuid>.png`, so `vfxSprite.js` limits apply (64 frames, 600 KB, 8192x2048).
- **No gameplay change:** staff bindings, `item_types.vfx`, `entity_types.vfx`/`auras`, radii and durations stay untouched.
- **Commit message attribution line:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **An admin saves an approved effect from the VFX or Aura tab:**
   - The form must not reset `sprite_loop` / `sprite_fps` / `sprite_stretch`. The VFX form today round-trips only image/frames/size/additive.
   - An aura PUT must not wipe the aura's sprite.
   - This is the "form snapshot reverts approved asset" trap. Test: Task 1.
2. **A seeded PC** holds `sprite_image` keys like `sprites/seedsync/<sha256>/textures_vfx_bolt_fire.png`. Today's `KEY` regex (`^vfx\/<uuid>\.png$`) would make every later VFX-tab save on that row a 400. Test: Task 7.
3. **Generate twice, or Redraw while a job for the same subject is queued/running:** this must not create two box jobs. The second request answers "skipped: already queued". Test: Task 3 (DB index) and Task 4 (route).
4. **The box goes down, answers 422, loses the job (404), or returns an oversize/malformed sheet mid-dispatch:**
   - The row ends `failed` with a readable error, or goes back to `queued` when the box is unreachable. It never stays `running`.
   - No `sprite_sets` row changes. Test: Task 3.
5. **The ETA is poisoned by box queue wait.** `sheet_seconds` must be first-seen-running → done, not submit → done. Failed rows never feed the measured per-kind seconds. A `/box-queue` with a vfx job ahead must not turn into NaN or 0. Test: Task 3 (timing) and Task 4 (box-queue).

---

### Task 1: Schema, sprite rules, and edits that keep approved sprites

**Files:**
- Create: `backend/migrations/1714440880000_effect_sprites.js`. Re-check the number per Global Constraints.
- Modify:
  - `backend/src/services/vfxSprite.js`: `spriteFieldsError` (lines 16-28), `spriteValues` (31-34), exports;
  - `backend/src/index.js`: `POST /api/vfx-effects` (2057-2083) and `PUT /api/vfx-effects/:id` (2085-2126). Both statements gain the three new columns as `$19..$21` (`$22` for the PUT id);
  - `backend/src/services/seedSync/coverage.js`: `EXCLUDED` (line 14+);
  - `frontend/src/games/something2/vfxForm.js` (lines 24, 44-47, 72-75).
- Test:
  - `backend/tests/vfx_sprite.test.js`;
  - `backend/tests/migration_effect_sprites_db.test.js` (new);
  - `backend/tests/aura_effects_api_db.test.js`;
  - `backend/tests/seed_sync_coverage_db.test.js` (existing, must stay green);
  - `frontend/src/games/something2/__tests__/vfxSpriteForm.test.js`.

**Interfaces:**
- Migration `up`:
  - `vfx_effects`:
    - `sprite_loop boolean NOT NULL DEFAULT false`;
    - `sprite_fps real NULL CHECK (sprite_fps IS NULL OR (sprite_fps > 0 AND sprite_fps <= 60))`;
    - `sprite_stretch boolean NOT NULL DEFAULT false`: the strip stretches from origin to reach, instead of travelling. This is needed because `chain_lightning` / `boss_chain_lightning` are shape `bolt`; see the spec rulings in the hand-off.
  - `aura_effects`:
    - `sprite_image text NULL`;
    - `sprite_frames integer NOT NULL DEFAULT 1 CHECK (sprite_frames BETWEEN 1 AND 64)`;
    - `sprite_additive boolean NOT NULL DEFAULT false`;
    - `sprite_fps real NULL`, with the same CHECK as on vfx.
  - `effect_sprite_jobs`:
    - `id serial PK`;
    - `subject_kind text NOT NULL CHECK IN ('vfx','aura')`;
    - `subject_name text NOT NULL`;
    - `prompt text NOT NULL CHECK (length(btrim(prompt)) BETWEEN 1 AND 1000)`;
    - `kind text NOT NULL CHECK IN ('projectile','burst','aura','beam')`;
    - `frames integer NOT NULL CHECK 1..64`;
    - `size integer NOT NULL CHECK 16..512`;
    - `loop boolean NOT NULL`;
    - `blend text NOT NULL CHECK IN ('additive','alpha')`;
    - `seed bigint NOT NULL`;
    - `status text NOT NULL DEFAULT 'queued' CHECK IN ('queued','running','done','failed','approved')`;
    - `box_job_id text`, `image_key text`, `atlas jsonb`;
    - `predicted_seconds integer CHECK (IS NULL OR > 0)`;
    - `sheet_seconds integer CHECK (IS NULL OR >= 0)`;
    - `running_since timestamptz`, `error text`, `created_at`, `updated_at`, `finished_at`.
  - Indexes: `(subject_kind, subject_name, created_at DESC)`, and a partial UNIQUE `(subject_kind, subject_name) WHERE status IN ('queued','running')`.
  - `down` drops the table and the columns.
- `vfxSprite.js`:
  - `spriteFieldsError(body)` also rejects:
    - `sprite_fps` that is not null/''/absent or in (0, 60] → `'sprite_fps must be empty or between 0 and 60'`;
    - `sprite_loop` / `sprite_stretch` that are not boolean or absent → `'<col> must be true or false'`.
  - `spriteValues(b) → [image, frames, size, additive, loop, fps|null, stretch]`, in column order. The INSERT/UPDATE append `sprite_loop, sprite_fps, sprite_stretch`.
  - Export `MAX_FPS = 60`.
- `EXCLUDED.effect_sprite_jobs = 'machine-local effect job queue; approved sheets travel in the vfx_effects/aura_effects sprite columns (art group)'`. This mirrors `sprite_sets`, and lands here because the migration adds the table and the coverage test would otherwise fail.
- `auraEffectsRoutes.js` stays unchanged: its `COLS` never names `sprite_*`, so PUT leaves them alone. The test pins that.
- `vfxForm.js`:
  - `fromEffect` carries `sprite_loop` (bool), `sprite_fps` (string, '' for null) and `sprite_stretch` (bool);
  - `toBody` sends them back, with `sprite_fps: '' → null`;
  - `emptyForm` defaults them to `false`, `''` and `false`.

- [ ] **Step 1: Write the failing tests**

```js
// backend/tests/vfx_sprite.test.js (add)
test('sprite_fps: empty or (0, 60]', () => {
  assert.equal(spriteFieldsError({ sprite_fps: null }), null);
  assert.equal(spriteFieldsError({ sprite_fps: 12 }), null);
  assert.match(spriteFieldsError({ sprite_fps: 0 }), /sprite_fps/);
  assert.match(spriteFieldsError({ sprite_fps: 61 }), /sprite_fps/);
});
test('sprite_loop / sprite_stretch must be booleans', () => {
  assert.match(spriteFieldsError({ sprite_loop: 'yes' }), /sprite_loop must be true or false/);
  assert.match(spriteFieldsError({ sprite_stretch: 1 }), /sprite_stretch must be true or false/);
});
test('spriteValues appends loop, fps, stretch in column order', () => {
  assert.deepEqual(spriteValues({ sprite_image: 'vfx/' + 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12) + '.png',
    sprite_frames: 4, sprite_loop: true, sprite_fps: 12, sprite_stretch: true }).slice(4), [true, 12, true]);
  assert.deepEqual(spriteValues({}).slice(4), [false, null, false]);
});
```
  - `migration_effect_sprites_db.test.js`:
    - `vfx_effects has sprite_loop default false and sprite_fps null`;
    - `aura_effects sprite_frames 65 violates the check`;
    - `two queued jobs for one subject violate the partial unique index; a queued + a done one do not`.
  - `aura_effects_api_db.test.js`: `PUT keeps an approved aura sprite`. Set `sprite_image/frames/additive/fps` by SQL, then PUT the row's form fields. Assert all four are unchanged.
  - `vfxSpriteForm.test.js`: `fromEffect → toBody round-trips sprite_loop, sprite_fps and sprite_stretch` (`{sprite_loop:true, sprite_fps:12, sprite_stretch:true}` in, the same out), and `empty fps becomes null`.
- [ ] **Step 2: Run them and see them fail.**
  - `cd backend && node --test tests/vfx_sprite.test.js`
  - `cd backend && DATABASE_URL=<private> node scripts/testdb.js run --keep -- tests/migration_effect_sprites_db.test.js tests/aura_effects_api_db.test.js`
  - `cd frontend && npx vitest run src/games/something2/__tests__/vfxSpriteForm.test.js`

  Expected: the new cases FAIL (no column / wrong values).
- [ ] **Step 3: Implement** the migration, then `vfxSprite.js`, the two `index.js` statements, `coverage.js` and `vfxForm.js`.
- [ ] **Step 4: Run them again,** plus `tests/vfx_admin_crud.test.js tests/vfx_effects_api.test.js tests/seed_sync_coverage_db.test.js tests/migration_vfx_effects.test.js` on the private DB. Expected: all PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(effects): sprite loop/fps/stretch on vfx, sprite columns on auras, effect_sprite_jobs table"`

---

### Task 2: Effect rules module + box client

**Files:**
- Create: `backend/src/services/effectSprites.js` (pure, no I/O).
- Modify: `backend/src/services/gpuBoxSprites.js`:
  - add `createVfxJob` after `createSheetJob` (373-383);
  - `listActiveJobs` (509-517) passes `kind: j.kind ?? null` through;
  - exports.
- Test: `backend/tests/effect_sprites.test.js` (new), `backend/tests/gpu_box_sprites.test.js` (uses its `fakeBox(routes)` at line 22).

**Interfaces:**
- `BATCH_1`: frozen array of `{ subject_kind, name, group, kind, frames, size, loop, blend }`, exactly spec §2. 21 entries:
  - **Auras** (`aura`, group `Auras`, `kind 'aura'`, frames 8, size 128, loop true): `abyssor_void_rend`, `cinder_brood`, `fire_sparks`, `glacius_permafrost`, `gorgon_static_field`, `ignis_inferno`, `ossuary_dread`, `pack_leader`, `shade_veil`.
  - **Bolts** (`vfx`, `Elemental bolts`, `projectile`, frames 4, size 96, loop true): `bolt_fire`, `bolt_ice`, `bolt_storm`, `bolt_arcane`.
  - **Impacts** (`vfx`, `Impacts`, `burst`, frames 6, size 128, loop false): `spark_hit`, `fireball_blast`, `blizzard_blast`, `ball_lightning`, `curse_blast`.
  - **Beams** (`vfx`, `Beam / chain`, `beam`, frames 4, size 96, loop true): `arcane_beam`, `chain_lightning`, `boss_chain_lightning`.
  - `blend` is `'alpha'` for `abyssor_void_rend`, `shade_veil`, `ossuary_dread` and `curse_blast`; every other entry is `'additive'`.
- `subjectOf(subject_kind, name) → entry | null`.
- `colorWords(hex) → string`: the nearest anchor by RGB distance. Anchors: red `#ff3b30`, orange `#ff7a1a`, gold `#d4a017`, yellow `#ffe66b`, green `#4ade80`, cyan `#67e8f9`, ice blue `#8fdcff`, blue `#3b82f6`, violet `#a855f7`, purple `#7c3aed`, magenta `#d31769`, white `#ffffff`, bone `#cfc8b0`.
- `defaultPrompt(name, hex) → string` = `` `${name.replace(/_/g, ' ')}, ${colorWords(hex)}` ``. It never contains box wording.
- `PALETTE_COLORS = 16`, sent as `colors`.
- `boxRequestFor(job) → { prompt, kind, frames, size, loop, blend, colors, seed }`, taken from an `effect_sprite_jobs` row.
- `readAtlas(atlas, { kind, frames }) → { frames, fpsHint|null, loop, blend, tailPivot: boolean }`:
  - `pivot` may be `[x, y]` or `{x, y}`, normalised (≤ 1) or in pixels of one `cell` (`[w, h]` or `"WxH"`);
  - `tailPivot` is `x ≤ 0.1` of the cell width;
  - a missing field falls back to the job's own value. `tailPivot` defaults to true when `pivot` is absent.
- `approveColumns({ subject_kind, kind, atlas, imageKey }) → { [col]: value }`:
  - **vfx:** `sprite_image`, `sprite_frames`, `sprite_additive`, `sprite_loop` (atlas loop), `sprite_fps` (null for `burst`, else `fpsHint` clamped to (0, 60], default 12), `sprite_stretch` (`kind === 'beam'`);
  - **aura:** `sprite_image`, `sprite_frames`, `sprite_additive`, `sprite_fps` (default 10).
- `EFFECT_ETA_PLACEHOLDER = { keyframeWarmSeconds: 54, keyframeColdSeconds: 110, animateSeconds: 15, placeholder: true }`, with the comment `// PLACEHOLDER: box estimate (54 s warm / 110 s cold keyframe + CPU animation) until the box reports measured per-kind s/effect (Task 9)`.
- `effectEstimate(kind, measuredSeconds|null) → { low, typical, high, placeholder }`:
  - measured: all three equal it, `placeholder:false`;
  - else low = typical = 54+15 and high = 110+15, `placeholder:true`.
- `gpuBoxSprites.createVfxJob(provider, body, { fetchImpl }) → { ok:true, boxJobId } | { ok:false, error, refused?:true, retryable?, unreachable? }`. It POSTs `/api/vfx` with a JSON body. A 422 gives `refused:true` and the box's `detail` text in `error`.

- [ ] **Step 1: Write the failing tests**

```js
// backend/tests/effect_sprites.test.js
const fx = require('../src/services/effectSprites.js');
test('batch 1 is exactly the spec table: 21 effects, 9 auras', () => {
  assert.equal(fx.BATCH_1.length, 21);
  assert.equal(fx.BATCH_1.filter((s) => s.subject_kind === 'aura').length, 9);
  assert.deepEqual(fx.BATCH_1.filter((s) => s.kind === 'beam').map((s) => s.name), ['arcane_beam', 'chain_lightning', 'boss_chain_lightning']);
});
test('dark effects blend alpha, the rest additive', () => {
  assert.deepEqual(fx.BATCH_1.filter((s) => s.blend === 'alpha').map((s) => s.name).sort(),
    ['abyssor_void_rend', 'curse_blast', 'ossuary_dread', 'shade_veil']);
});
test('default prompt is name + colour words, nothing else', () => {
  assert.equal(fx.defaultPrompt('pack_leader', '#d4a017'), 'pack leader, gold');
  assert.equal(fx.defaultPrompt('fire_sparks', '#d31769'), 'fire sparks, magenta');
  assert.equal(fx.defaultPrompt('bolt_ice', '#8fdcff'), 'bolt ice, ice blue');
  assert.doesNotMatch(fx.defaultPrompt('spark_hit', '#ffffff'), /pixel|background|transparent|right/i);
});
test('every strip fits the vfxSprite limits', () => {
  for (const s of fx.BATCH_1) assert.ok(s.frames <= 64 && s.frames * s.size <= 8192 && s.size <= 2048, s.name);
});
test('approve columns: beam stretches, burst keeps duration timing, alpha blend is not additive', () => {
  const beam = fx.approveColumns({ subject_kind: 'vfx', kind: 'beam', imageKey: 'vfx/k.png', atlas: { frames: 4, fps_hint: 14, loop: true, blend: 'additive', pivot: [0, 0.5] } });
  assert.deepEqual(beam, { sprite_image: 'vfx/k.png', sprite_frames: 4, sprite_additive: true, sprite_loop: true, sprite_fps: 14, sprite_stretch: true });
  const burst = fx.approveColumns({ subject_kind: 'vfx', kind: 'burst', imageKey: 'vfx/k.png', atlas: { frames: 6, fps_hint: 12, loop: false, blend: 'alpha' } });
  assert.equal(burst.sprite_fps, null); assert.equal(burst.sprite_additive, false);
  const aura = fx.approveColumns({ subject_kind: 'aura', kind: 'aura', imageKey: 'vfx/k.png', atlas: { frames: 8, blend: 'additive' } });
  assert.deepEqual(Object.keys(aura).sort(), ['sprite_additive', 'sprite_fps', 'sprite_frames', 'sprite_image']);
  assert.equal(aura.sprite_fps, 10);
});
test('readAtlas: tail pivot in pixels or normalised; centre pivot is not a tail', () => {
  assert.equal(fx.readAtlas({ pivot: [0, 48], cell: [96, 96] }, { kind: 'projectile', frames: 4 }).tailPivot, true);
  assert.equal(fx.readAtlas({ pivot: { x: 0.5, y: 0.5 } }, { kind: 'beam', frames: 4 }).tailPivot, false);
});
test('estimate is a placeholder until measured', () => {
  assert.deepEqual(fx.effectEstimate('aura', null), { low: 69, typical: 69, high: 125, placeholder: true });
  assert.deepEqual(fx.effectEstimate('aura', 80), { low: 80, typical: 80, high: 80, placeholder: false });
});
```
  - `gpu_box_sprites.test.js`:
    - `createVfxJob posts the body to /api/vfx and returns the job id`: capture method, path and parsed body; assert the body equals `boxRequestFor(row)`;
    - `createVfxJob maps a 422 to refused with the box detail`;
    - `listActiveJobs passes the job kind through`.
- [ ] **Step 2: Run them and see them fail.** `cd backend && node --test tests/effect_sprites.test.js tests/gpu_box_sprites.test.js`. Expected: FAIL, module not found / `createVfxJob` is not a function.
- [ ] **Step 3: Implement** `effectSprites.js` and the three `gpuBoxSprites.js` changes, using `callJson` the same way as `createSheetJob`.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(effects): batch-1 effect rules and the box /api/vfx client"`

---

### Task 3: Effect job queue + dispatcher

**Files:**
- Create: `backend/src/services/effectSpriteJobs.js` (DB), `backend/src/services/effectDispatcher.js`.
- Test: `backend/tests/effect_sprite_jobs_db.test.js`, `backend/tests/effect_dispatcher_db.test.js` (both new, private DB).

**Interfaces:**
- Consumes: Task 2's `subjectOf`, `boxRequestFor`, `readAtlas`, `approveColumns`, `effectEstimate` and `box.createVfxJob`; the existing `getSheetJob`, `fetchSheet`, `fetchAtlas`; `vfxSprite.inspectPng`; the `assetStore` shape `putObject(key, buf, type)`.
- `effectSpriteJobs.js`:
  - `enqueue(db, targets: Array<{subject_kind, name, prompt}>, { seed = randomSeed }) → { queued: row[], skipped: Array<{subject_kind, name, reason}> }`:
    - one INSERT per target, with frames/size/loop/blend/kind from `subjectOf`;
    - `predicted_seconds` = `effectEstimate(kind, await measuredSeconds(db, kind)).typical`;
    - a unique-index conflict (code 23505) is pushed to `skipped` with reason `'already queued'`.
  - `claimNext(db) → row|null`: the oldest `queued` row, using `FOR UPDATE SKIP LOCKED`, set to `running` with `running_since = NULL`.
  - `markSeenRunning(db, id)` sets `running_since = COALESCE(running_since, now())`.
  - `setBoxJob(db, id, boxJobId)`.
  - `markDone(db, id, { imageKey, atlas })`: status `done`, `finished_at = now()`, `sheet_seconds = EXTRACT(epoch FROM now() - running_since)` rounded, or NULL when `running_since` IS NULL.
  - `fail(db, id, message)`, `requeue(db, id)`: keeps `box_job_id`.
  - `latestBySubject(db) → Map<"kind|name", row>`.
  - `measuredSeconds(db, kind) → number|null`: the median `sheet_seconds` of the last 10 `done`/`approved` rows of `kind` with `sheet_seconds > 0`; null under 3 rows.
  - `approve(db, id) → { subject_kind, name, columns }`, in one transaction:
    - lock the job;
    - it must be `done` and have `image_key` (else throw `{status:409}`);
    - for projectile/beam it must have `readAtlas(...).tailPivot` (else 409 `'box atlas pivot is not the tail end; the renderer anchors strips at the tail'`);
    - UPDATE the subject row with `approveColumns(...)` (aura rows also get `updated_at = now()`); 404 if the subject row is gone;
    - set this job `approved` and any older `approved` job of the subject back to `done`.
- `createEffectDispatcher({ db, box, loadProvider, store, pollMs = 3000, timeoutMs = 15 * 60 * 1000, sleep }) → { kick(): Promise<void>, status(): { running, currentId } }`:
  - `kick` is a no-op while draining. It first re-attaches any `running` row with a `box_job_id` (process restart), then claims rows one at a time.
  - Per row:
    - `createVfxJob(provider, boxRequestFor(row))` → `setBoxJob`;
    - poll `getSheetJob` → `markSeenRunning` on `running`;
    - on `done`: `fetchSheet` + `fetchAtlas`, `inspectPng` (its error becomes the fail message), the frame count from `readAtlas` must divide the width, `putObject('vfx/<uuid>.png', buf, 'image/png')`, then `markDone`.
  - Outcomes:
    - unreachable (`unreachable:true`): `requeue`, then stop draining;
    - `refused`, box `failed`, `missing` or timeout: `fail` with the box text, or `'GPU box lost the job'` / `'timed out after 15 min'`;
    - no provider: rows stay queued and `kick` resolves.

- [ ] **Step 1: Write the failing tests** (private DB, fake box object, in-memory store `Map`):
  - `enqueue fills kind/frames/blend from the batch-1 list and a placeholder predicted_seconds of 69`;
  - `enqueue twice for one subject: the second is skipped 'already queued'`;
  - `measuredSeconds ignores failed rows and returns null under 3 samples`;
  - `sheet_seconds counts from first-seen running, not from submit`: the fake box answers `queued` for 3 polls, then `running`, then `done`. With a fake clock, assert `sheet_seconds` equals the running→done span;
  - `dispatcher happy path`: one queued `bolt_fire` row → the box saw exactly one `createVfxJob`, whose body has `kind:'projectile'` and `blend:'additive'`; the row is `done` with an `image_key` matching `/^vfx\/[0-9a-f-]{36}\.png$/`; the store holds the PNG bytes;
  - `dispatcher sends one job at a time`: 3 queued rows; the fake box records the max number of concurrent unfinished jobs = 1;
  - `box 422 → failed with the box detail`; `box job vanishes (404) → failed 'GPU box lost the job'`; `oversize PNG (700 KB) → failed with the 600 KB message`;
  - `box unreachable → row back to queued, draining stops, nothing failed`;
  - `the creature queue is untouched`: snapshot `SELECT id, status, box_job_id FROM sprite_sets` before and after a full drain → deep-equal;
  - `approve copies the atlas facts into vfx_effects and marks the job approved`: on a private `sx_fx_beam` vfx row with a beam job, assert `sprite_stretch` true, `sprite_loop` true and `sprite_fps` 14;
  - `approve refuses a projectile whose atlas pivot is the centre (409)`;
  - `approving a second job sets the first back to done`.
- [ ] **Step 2: Run them and see them fail.** `cd backend && DATABASE_URL=<private> node scripts/testdb.js run --keep -- tests/effect_sprite_jobs_db.test.js tests/effect_dispatcher_db.test.js`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run them again.** Expected: PASS. Also run `tests/sprite_dispatcher.test.js` (creature dispatcher), which must stay green.
- [ ] **Step 5: Commit.** `git commit -m "feat(effects): effect job queue and a one-at-a-time dispatcher for /api/vfx"`

---

### Task 4: Admin routes, estimate, box-queue awareness

**Files:**
- Create: `backend/src/api/effectSpriteRoutes.js`.
- Modify:
  - `backend/src/index.js`: create the effect dispatcher next to `spriteDispatcher` (~428), with the same `loadProvider` (`aiProviders.loadActiveProviderWithSecret(guardPool, 'sprite')`) and the same `assetStore`. Mount `app.use('/api/sprite-admin/effects', effectSpriteRoutes(guardPool, adminGuard, effectDispatcher))` on the line BEFORE the `/api/sprite-admin` mount (646).
  - `backend/src/api/spriteBatchRoutes.js`: `remainingSeconds` (~167-180). A job with `job.kind === 'vfx'`, or `spec.kind` in `projectile|burst|aura|beam`, uses `effectEstimate(spec.kind, null).typical`.
- Test: `backend/tests/effect_sprite_routes_db.test.js` (new, private DB), `backend/tests/sprite_batch_api.test.js`.

**Interfaces:**
- `effectSpriteRoutes(pool, adminGuard, dispatcher, { now } = {}) → express.Router`. Every route sits behind `adminGuard`.
  - `GET /` → `{ subjects, eta, dispatcher: dispatcher.status() }`:
    - `subjects` is one item per `BATCH_1` entry, in list order:

      ```
      { subject_kind, name, group, kind, blend, color, default_prompt,
        missing: boolean,  // subject row not in this DB
        sprite: { image, frames, additive, loop, fps, stretch } | null,
        job: { id, status, prompt, image_key, frames, error, predicted_seconds, sheet_seconds } | null }
      ```

      `color` comes from the subject row, `default_prompt` from `defaultPrompt(name, color)`, and `job` is the latest job.
    - `eta`: `{ [kind]: effectEstimate(kind, measuredSeconds) }` for the four kinds.
  - `POST /jobs` with body `{ targets: [{ subject_kind, name, prompt? }] }` → `202 { queued: [{id, subject_kind, name, predicted_seconds}], skipped }`, then `dispatcher.kick()` (not awaited). Errors:
    - 400 `'targets must be a non-empty list'`;
    - 400 `'<name> is not a batch-1 effect'`;
    - 400 `'prompt must be 1-1000 characters'` (omitted → `default_prompt`);
    - a subject whose row is missing in this DB → skipped `'no such effect in this database'`.

    Redraw is this same call: it is a new job with a new seed.
  - `POST /jobs/:id/approve` → `200 { subject_kind, name, sprite }`. Errors from `approve` map to their status. Non-integer id → 400.
  - `POST /dispatch` → `202 { running: true }` (kick). This is the "Resume queue" for rows left queued by an unreachable box.
- `/api/sprite-admin/box-queue` keeps its shape. The UI reuses it for the wait.

- [ ] **Step 1: Write the failing tests:**
  - `GET / lists the 21 batch-1 subjects with default prompts and placeholder eta`: assert the length is 21, `pack_leader.default_prompt === 'pack leader, gold'`, and `eta.aura.placeholder === true`;
  - `POST /jobs queues one row per target and kicks the dispatcher once` (fake dispatcher counts kicks);
  - `POST /jobs twice for one subject: the second answers skipped 'already queued' and no second row exists`;
  - `POST /jobs rejects a non-batch-1 name (400) and a 1001-char prompt (400)`;
  - `approve → GET / shows the sprite on the subject`;
  - `routes are admin-only` (a guard that rejects → 401/403);
  - `sprite_batch_api.test.js`: `box-queue counts a running vfx job ahead at its effect estimate`. A fake `listActiveJobs` returns `[{status:'running', kind:'vfx', progressPct:50, spec:{kind:'aura', frames:8}}]`; assert `ahead_seconds === Math.round(69 * 0.5)`.
- [ ] **Step 2: Run them and see them fail.** `cd backend && DATABASE_URL=<private> node scripts/testdb.js run --keep -- tests/effect_sprite_routes_db.test.js tests/sprite_batch_api.test.js`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement** the router, the wiring and the `remainingSeconds` branch.
- [ ] **Step 4: Run them again.** Expected: PASS, and `tests/sprite_batch_approve_api.test.js` stays green.
- [ ] **Step 5: Commit.** `git commit -m "feat(effects): Sprite tab effect routes with estimates; box-queue counts vfx jobs"`

---

### Task 5: Effects section of the Sprite tab

**Files:**
- Create:
  - `frontend/src/games/something2/effectSprites.js` (pure helpers);
  - `frontend/src/games/something2/EffectSpritesSection.jsx` (section + `EffectStripPreview`).
- Modify:
  - `frontend/src/games/something2/useSpriteConsole.js`: add hooks next to `useBoxQueue` (51);
  - `frontend/src/games/something2/SpriteConsoleAdmin.jsx`: render `<EffectSpritesSection boxQueue={boxQueue} />` below the creature table section, reusing the `boxQueue` from line 332.
- Test:
  - `frontend/src/games/something2/__tests__/effectSprites.test.js`;
  - `frontend/src/games/something2/__tests__/effectSpritesSection.render.test.js` (renderToString style, like `spriteConsoleTable.render.test.js`).

**Interfaces:**
- Consumes: Task 4's routes; Task 6's `spriteFrameAtTime` from `src/js/core/vfx.js`. If Task 6 hasn't landed, this task adds that function there with Task 6's exact signature, and Task 6 then only adds its tests. `etaLabel` and `durationLabel` come from `spriteEta.js`; `waitLabel` from `spriteSelection.js`; `assetUrl` from `useTileSprites.js`.
- Hooks:
  - `useEffectSprites() → { subjects, eta, dispatcher, ...query }` (key `['sprite-admin-effects']`). It refetches every 5 s while any `job.status` is `queued`/`running`.
  - `useQueueEffects` (POST `/effects/jobs`), `useApproveEffect` (POST `/effects/jobs/:id/approve`), `useResumeEffects` (POST `/effects/dispatch`). All use the existing `mutation(...)` helper and invalidate the effects key.
- `effectSprites.js`:
  - `previewAngles(kind) → number[]` (degrees): `[0]` for aura/burst; `[0, 60, 150, 270]` for projectile/beam.
  - `effectSelectionEta(subjects, selectedKeys, eta) → { low, typical, high, placeholder }`: sums `eta[kind]` over the selected rows.
  - `effectEtaLabel(est) → string`: `etaLabel(est)` plus `' (box estimate, not yet measured)'` when `placeholder`.
  - `effectStatusLabel(subject) → string`: `none`, `queued`, `drawing`, `ready to approve`, `failed: <error>`, or `approved`, the last when `sprite.image === job.image_key`.
  - `previewSprite(subject) → { image_key, frames, loop, fps } | null`: the candidate (`job.image_key` when `job.status === 'done'`), else the approved sprite.
- UI:
  - one table grouped by `group`; columns: checkbox, name, colour swatch, sprite thumbnail (first frame) or `none`, status, prompt `<textarea>` (default `default_prompt`, kept per row in component state), and per-row `Generate` (`Redraw` when the subject has a sprite or a done job) and `Approve` (enabled only for `done`);
  - the selection bar shows `Generate N selected` plus `effectEtaLabel(effectSelectionEta(...))` · `waitLabel(boxQueue)`, and `Resume queue` when rows are queued and `dispatcher.running` is false;
  - clicking a thumbnail opens `EffectStripPreview`: a canvas that loops the strip with `spriteFrameAtTime` (one-shots replay after a 400 ms gap), drawn once per angle in `previewAngles(kind)`, on a dark background, with `globalCompositeOperation = 'lighter'` when the blend is additive.

- [ ] **Step 1: Write the failing tests:**
  - `previewAngles: one angle for aura/burst, four for projectile/beam`;
  - `selection ETA sums per-kind estimates and says "not yet measured" while placeholder`, e.g. 2 auras → `"~2 min 18 s … (box estimate, not yet measured)"` (use the exact `etaLabel` output for 138/250);
  - `status label: approved only when the approved image is the job's image`;
  - render: `the section lists 21 rows in 4 groups with Generate buttons`; `a done job shows an enabled Approve and "ready to approve"`; `a failed job shows its error`.
- [ ] **Step 2: Run them and see them fail.** `cd frontend && npx vitest run src/games/something2/__tests__/effectSprites.test.js src/games/something2/__tests__/effectSpritesSection.render.test.js`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expected: PASS, and `npx vitest run src/games/something2` is fully green (`SpriteConsoleAdmin.smoke.test.js` included).
- [ ] **Step 5: Commit.** `git commit -m "feat(effects): Effects section in the Sprite tab with animated preview and ETA"`

---

### Task 6: Game rendering

**Files:**
- Modify:
  - `frontend/src/games/something2/src/js/core/vfx.js`: sprite helpers (277-330);
  - `frontend/src/games/something2/src/js/systems/RenderSystem.js`:
    - `_drawVfxSprite` (1919-1975);
    - `_drawProjectileTrail` (1795-1822);
    - `_drawAuraEffects` (4047-4076);
    - a new `_drawSpriteAuraGround`, called in `renderChunked` right after `this._drawTraps(traps)` (~554), before Pass B;
    - `drawSkillVisuals` (2119).
  - `frontend/src/games/something2/src/js/core/Game.js` (984-992): preload aura sheets like vfx sheets.
- Test:
  - `src/js/core/__tests__/vfxSprite.test.js`;
  - `src/js/systems/__tests__/auraRender.test.js`;
  - `src/js/systems/__tests__/projectileTrail.test.js`;
  - `src/js/systems/__tests__/vfxSpriteRender.test.js` (new).

**Interfaces:**
- `spriteFrameAtTime(def, elapsedMs, durationMs) → integer`:
  - `sprite_fps > 0`: `idx = floor(elapsedMs * fps / 1000)`; `sprite_loop` → `idx % frames`, else `min(idx, frames − 1)`;
  - `sprite_fps` null: loop → `spriteFrameAt(def, (elapsedMs % durationMs) / durationMs)`, else `spriteFrameAt(def, elapsedMs / durationMs)`, which is today's behaviour;
  - `spriteFrameAt` is unchanged.
- `spriteStretches(def) → boolean`: `def.shape === 'line' || def.shape === 'arc' || def.sprite_stretch === true`.
- `skillVisualSuppressed(vis, vfxDefs, hasSheet: (def) => boolean) → boolean`: true only for `vis.kind` `'arcane_beam'` or `'lightning'` whose `vfxDefs[vis.vfxName]` has a LOADED sheet. That property is set in `Game._spawnSkillFx`.
- `_drawVfxSprite`:
  - frame = `spriteFrameAtTime(def, now − fx.startedAt, dur)`;
  - "along" layout: stretch (origin → reach) when `spriteStretches(def)`, else travelling;
  - the travelling strip is anchored at its tail pivot: the strip's right edge (head) sits on the travelling point, `blit(-len, -thick/2, len, thick)` after translate/rotate. Today it is centred (`-len/2`).
- `_drawProjectileTrail`: after the vector streak, when `this._vfxSheet(def)` is loaded, draw the strip with its head at the projectile's screen point, rotated to the streak's angle. Length = `max(24, blastScreenRadiusX(spriteWorldSize(def, 0) / 2) * 2)`, frame = `spriteFrameAtTime(def, this.nowMs, dur)`. The vector streak stays underneath.
- `_drawSpriteAuraGround(creatures)`:
  - for each creature and each aura name with a loaded `_vfxSheet(auraDef)`, draw it centred on the feet (`worldToScreen(e.x + width/2, e.y + height/2)`);
  - `w = 2 * blastScreenRadiusX(def.radius)`, `h = w * sheet.aspect / 2`;
  - looping at `sprite_fps` (null → 10) with elapsed = `this.nowMs`; additive only when `sprite_additive`;
  - no arrays or closures are allocated per call.
- `_drawAuraEffects` skips names whose sheet is loaded, so a sprite aura is never also drawn inside the depth-sorted pass. Unloaded or no sprite draws today's ring.
- `drawSkillVisuals` skips a visual when `skillVisualSuppressed(...)` is true.

- [ ] **Step 1: Write the failing tests:**

```js
// core/__tests__/vfxSprite.test.js (add)
it('spriteFrameAtTime: fps + loop wraps, fps one-shot holds, null fps keeps duration timing', () => {
  expect(spriteFrameAtTime({ sprite_frames: 4, sprite_fps: 10, sprite_loop: true }, 450, 200)).toBe(0);
  expect(spriteFrameAtTime({ sprite_frames: 4, sprite_fps: 10, sprite_loop: false }, 950, 200)).toBe(3);
  expect(spriteFrameAtTime({ sprite_frames: 4 }, 100, 200)).toBe(spriteFrameAt({ sprite_frames: 4 }, 0.5));
  expect(spriteFrameAtTime({ sprite_frames: 4, sprite_loop: true }, 250, 200)).toBe(spriteFrameAt({ sprite_frames: 4 }, 0.25));
});
it('spriteStretches: line/arc always, bolt only when sprite_stretch', () => {
  expect(spriteStretches({ shape: 'bolt' })).toBe(false);
  expect(spriteStretches({ shape: 'bolt', sprite_stretch: true })).toBe(true);
});
```
  - `auraRender.test.js`:
    - `a sprite aura draws in the ground pass, before any entity drawImage, scaled to the gameplay radius`: record the call order of `_drawSpriteAuraGround([c])` + `drawEntity(c)`; the first `drawImage` has `dw === 2 * blastScreenRadiusX(260)`; `drawEntity` adds no aura ellipse;
    - `an alpha-blend (dark) aura sprite is not drawn with 'lighter'`;
    - `an aura whose sheet is not loaded still draws the ring`.
  - `projectileTrail.test.js`: `a trail with a loaded sheet draws the streak then the strip with its head at the projectile`. The `drawImage` destination right edge is 0 in the rotated frame, i.e. `dx + dw === 0`.
  - `vfxSpriteRender.test.js`:
    - `chain_lightning (shape bolt, sprite_stretch) stretches from the origin`: the `dx` of `drawImage` is 0;
    - `a travelling bolt is anchored at its head`: `dx === -dw`;
    - `an arcane_beam skill visual is not drawn when its vfx row's sheet is loaded, and IS drawn while the sheet is loading` (count `lineTo`/`stroke` calls from `drawSkillVisuals`);
    - `a 'projectile' skill visual is never suppressed`.
- [ ] **Step 2: Run them and see them fail.** `cd frontend && npx vitest run src/games/something2/src/js/core/__tests__/vfxSprite.test.js src/games/something2/src/js/systems/__tests__/auraRender.test.js src/games/something2/src/js/systems/__tests__/projectileTrail.test.js src/games/something2/src/js/systems/__tests__/vfxSpriteRender.test.js`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expected: PASS, and `npx vitest run src/games/something2` is fully green.
- [ ] **Step 5: Commit.** `git commit -m "feat(effects): play effect strips in game: loop/fps, aura ground pass, sprite trails, no duplicate beam line"`

---

### Task 7: Seed/export carries effect sprites and their PNGs

Owner requirement (2026-11-09): everything new must pass through seed/export so it reaches other PCs and staging. The seed-sync engine is `backend/src/services/seedSync/` (`registry.js`, `assets.js`, `exportGroup.js`, `applySeed.js`, `coverage.js`). The CLI is `backend/scripts/seed-sync.js`. The files are `backend/seeds/sync/<group>.json`, plus asset files under `backend/seeds/textures/...`.

**Files:**
- Modify:
  - `backend/src/services/seedSync/registry.js`:
    - `attack_effects` → `vfx_effects` spec (168-174): `omit` gains `sprite_image, sprite_frames, sprite_size, sprite_additive, sprite_loop, sprite_fps, sprite_stretch: ART`;
    - `aura_effects` spec (188-196): `omit` gains `sprite_image, sprite_frames, sprite_additive, sprite_fps: ART`;
    - `art` group: two slices appended after the `item_types` slice (~474-481).
  - `backend/src/services/vfxSprite.js`: accept seeded keys.
  - `backend/seeds/sync/attack_effects.json`, `backend/seeds/sync/aura_effects.json`, `backend/seeds/sync/art.json`: regenerated, not hand-edited.
- Test:
  - `backend/tests/seed_sync_art_audio_roundtrip_db.test.js`;
  - `backend/tests/seed_sync_coverage_db.test.js` (existing: `registered slices cover every art-omitted column exactly once`, `every public table is in a group, excluded with a reason, or pending a named plan`);
  - `backend/tests/seed_sync_registry_db.test.js` (order rules);
  - `backend/tests/vfx_sprite.test.js`.

**Interfaces:**
- The art slices:
  - `vfx_effects`:
    - `{ table: 'vfx_effects', slice: true, columns: ['sprite_image','sprite_frames','sprite_size','sprite_additive','sprite_loop','sprite_fps','sprite_stretch'], naturalKey: ['name'], omit: {}, secretColumns: [], refs: {} }`;
    - `assets: { sprite_image: { type: 'image', dir: 'textures/vfx', name: (r) => r.name } }`.
  - `aura_effects`:
    - `{ table: 'aura_effects', slice: true, columns: ['sprite_image','sprite_frames','sprite_additive','sprite_fps'], naturalKey: ['name'], omit: {}, secretColumns: [], refs: {} }`;
    - `assets: { sprite_image: { type: 'image', dir: 'textures/auras', name: (r) => r.name } }`.
  - Neither has `maxEdge`: strips are never resampled.
- `effect_sprite_jobs` stays in `coverage.js` `EXCLUDED` (Task 1). Generation history is per PC; approved sheets travel in the slices above.
- `vfxSprite.js`:
  - `SEEDED_KEY = /^[a-z0-9][a-z0-9.-]*\/seedsync\/[0-9a-f]{64}\/[A-Za-z0-9_.-]+\.png$/`, the shape `uploadGitAssets` writes (`${BUCKET()}/seedsync/<sha256>/<fileKeyName(file)>`);
  - `isSpriteKey(k) = KEY.test(k) || SEEDED_KEY.test(k)`, which `spriteFieldsError` uses;
  - the upload route still issues only `vfx/<uuid>.png`.
- Seed files (row_counts rule: a stale header gets the whole group refused):
  - `art.json` `header.row_counts` gains `"vfx_effects": 87` and `"aura_effects": 9` (the current row counts; use whatever the export writes);
  - `attack_effects.json` / `aura_effects.json` lose the moved columns from every row;
  - all three get the new `schema_version`.

- [ ] **Step 1: Write the failing tests:**

```js
// backend/tests/vfx_sprite.test.js (add)
test('a seed-synced key is a valid sprite_image; arbitrary paths are not', () => {
  assert.equal(spriteFieldsError({ sprite_image: `sprites/seedsync/${'a'.repeat(64)}/textures_vfx_bolt_fire.png` }), null);
  assert.match(spriteFieldsError({ sprite_image: 'https://evil/x.png' }), /sprite_image/);
  assert.match(spriteFieldsError({ sprite_image: '../vfx/x.png' }), /sprite_image/);
});
```
  - `seed_sync_art_audio_roundtrip_db.test.js`:
    - extend `makeOwners`/`seedFixture` with a `vfx_effects` row `sx_aa_fx` (shape `bolt`, `sprite_image 'sx/fx.png'`, frames 4, additive, loop, fps 12, stretch) and an `aura_effects` row `sx_aa_aura` (radius 100, `sprite_image 'sx/aura.png'`, frames 8, fps 10), with their PNG bytes in the fake store. The existing `art and audio round trip byte-identical` then covers them.
    - add `an approved effect sprite survives export → seed onto a fresh PC`:
      1. export `art` into the temp sync/assets roots;
      2. simulate the fresh PC: NULL the two rows' sprite columns, `DELETE FROM seed_asset_hashes WHERE object_key LIKE 'sx%'`, and drop the objects from the fake store;
      3. `previewSeed` + `applySeed` take-git;
      4. assert both rows' sprite columns deep-equal the originals (except the key, which now matches `SEEDED_KEY`), and that `sha256(store bytes at the new key) === sha256(original bytes)`;
      5. assert `spriteFieldsError(row)` is null for the seeded vfx row (the VFX tab can still save it).
- [ ] **Step 2: Run them and see them fail.**
  - `cd backend && node --test tests/vfx_sprite.test.js`
  - `cd backend && DATABASE_URL=<private> node scripts/testdb.js run --keep -- tests/seed_sync_art_audio_roundtrip_db.test.js tests/seed_sync_coverage_db.test.js`

  Expected: the new cases FAIL (columns not in any art slice; seeded key rejected).
- [ ] **Step 3: Implement** the registry and `vfxSprite.js` changes. Run `seed_sync_coverage_db` and `seed_sync_registry_db`: green.
- [ ] **Step 4: Regenerate the three seed files** on a private DB that `testdb.js reset` built from the checked-in files:

  ```
  cd backend && DATABASE_URL=<private> node scripts/seed-sync.js export --groups=attack_effects,aura_effects,art
  git diff --stat backend/seeds
  ```

  Expected:
  - only `attack_effects.json`, `aura_effects.json` and `art.json` change;
  - no PNG churn (no effect has a sprite yet);
  - `art.json`'s diff adds only the two tables plus header fields;
  - `node scripts/seed-sync.js status --groups=attack_effects,aura_effects,art` on that DB reports the groups in sync.

  If anything else changes, stop and report; don't hand-edit around it.
- [ ] **Step 5: Two-database check (manual, recorded in the commit message).**
  1. On private DB A, approve a fake sheet (an SQL UPDATE of `bolt_fire` / `pack_leader` sprite columns to a PNG put in the store), then `export --group=art`.
  2. On a fresh private DB B (`testdb.js reset` with another `TEST_DB_NAME`), run `seed --group=art --resolve=git`.
  3. On B, `GET /api/vfx-effects` and `/api/aura-effects` show the sprite columns, and `/api/assets/<key>` returns the identical bytes (`sha256sum`).
  4. Then `git checkout -- backend/seeds` to discard that test export.
- [ ] **Step 6: Run** `seed_sync_art_audio_roundtrip_db`, `seed_sync_groups_roundtrip_db`, `seed_sync_coverage_db`, `seed_sync_registry_db`, `seed_sync_diff_db` and `seed_sync_apply_db` on the private DB. Expected: PASS.
- [ ] **Step 7: Commit.** `git commit -m "feat(effects): effect sprite columns and PNGs travel with seed/export (art group slices)"`

---

### Task 8: Browser verification on an isolated stack with a stub box

**Files:** none committed. Scripts and screenshots go in the session scratchpad.

- [ ] **Step 1: Bring up an isolated stack** from the worktree, following the recipe in memory `dev-run-browser-verify.md`:
  - backend `PORT=13201`, `DATABASE_URL` = a private DB, `CORS_ORIGINS` set;
  - vite on `15273` with a throwaway config: own `cacheDir` and proxy to `13201`; delete it afterwards;
  - kill by checked PID, never `pkill -f`.
- [ ] **Step 2: Run a stub box** (scratchpad Node script, local port). It implements `POST /api/vfx` (202), `GET /api/jobs/{id}` (queued → running → done over ~6 s), `/sheet` (a strip from `encodeRGBA` in `backend/src/services/pngTrim.js`: a soft radial glow per frame, black → alpha), `/atlas` (tail pivot for projectile/beam), `GET /api/jobs` and `GET /api/model-gateway`. Point the private DB's active `sprite` provider at it.
- [ ] **Step 3: Admin flow** in muted headless Chrome (`--mute-audio`), at `/game/sprites` → Effects:
  - 21 rows; the ETA reads "not yet measured";
  - Generate `pack_leader`, `bolt_fire`, `fireball_blast` and `arcane_beam` → each reaches "ready to approve";
  - the preview plays, and the bolt/beam show 4 angles;
  - Approve each; Redraw one and see a new job;
  - press Generate twice on one row and see one job.

  Screenshot each step.
- [ ] **Step 4: Game check** at `/game`, next to a creature: each approved effect plays.
  - The aura is under the creature, and the creature is fully visible. Check that `drawImage` of the aura precedes the creature's via a CDP init-script wrapper.
  - Glow edges are soft.
  - The bolt points along its flight.
  - The beam draws once, with no vector line on top.

  Screenshot each.
- [ ] **Step 5: Measure aura cost.** Spawn or position 30 creatures on screen carrying `pack_leader`:
  - **A:** sheet not loaded (rings);
  - **B:** sheet loaded.

  Measure the median JS time of `renderSystem.renderChunked(...)` over 300 frames per case, with a `performance.now()` wrapper installed via init script, on the on-screen 1280x720 canvas, with no `getImageData`. rAF frame time is not measurable on this host (memory `canvas-perf-measurement-traps.md`); say so in the report. Acceptance: `median(B) − median(A) ≤ 1 ms`. Report both numbers.
- [ ] **Step 6: Tear down** the stub, backend and vite by PID. Drop the private DB.

---

### Task 9: Gated live run on the real box

Start only when the box session reports `POST /api/vfx` deployed. Before every box call, check that `GET /api/model-gateway` shows no hold and the owner confirms that no box spike is running.

**Files:** `backend/src/services/effectSprites.js` (`EFFECT_ETA_PLACEHOLDER` → measured per-kind constants; only in Step 5).

- [ ] **Step 1: Check the box is free** (read-only GETs).
- [ ] **Step 2: Run one effect per kind on a PRIVATE DB** with the private live-box-leg harness (memory `private-live-box-leg-harness.md`): real `effectDispatcher` + real `gpuBoxSprites`, private postgres, in-memory store, provider from `loadActiveProviderWithSecret(sharedPool, 'sprite')`. Enqueue `pack_leader` (aura), `bolt_fire` (projectile), `fireball_blast` (burst) and `arcane_beam` (beam).
- [ ] **Step 3: Check each row.**
  - It is `done`; the PNG passes `inspectPng`; `atlas.frames` matches the strip width.
  - The box Activity tab shows the job (GET `/api/jobs/{id}` exists and the gateway logged a `gpu_claim`).
  - Record `sheet_seconds` against `predicted_seconds` per kind.
- [ ] **Step 4: Look at the strips** (save them to the scratchpad):
  - soft glow edges, no black box, no checkerboard;
  - the bolt/beam point right with the tail at the left;
  - the dark-blend effect reads dark on light ground.

  If one looks wrong, report it to the box session; don't patch around it here.
- [ ] **Step 5: Replace the placeholder** with the box's reported per-kind s/effect, NOT tuned to this single run. Flip `placeholder: false`, update the Task 2 estimate test, run `node --test tests/effect_sprites.test.js` and commit: `git commit -m "feat(effects): measured box seconds per effect kind"`. Record the numbers and the run in the spec's §6 (one line).
