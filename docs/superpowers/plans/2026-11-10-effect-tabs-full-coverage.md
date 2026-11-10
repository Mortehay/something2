# Effect tabs and full sprite coverage — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every `vfx_effects` and `aura_effects` row can be generated on the Sprite tab, effects draw ahead of creature sheets, and the Attack and Aura tabs preview each effect as code and as sprite side by side, with aura sprite upload.

**Architecture:**
- **Effect list:** a new backend module `effectCatalog.js` builds the Sprite-tab effect list from the live tables. Each row is grouped by who uses it, and its box job settings come from its shape, with the batch-1 settings as per-name overrides. The four places that read `BATCH_1` today switch to it.
- **Effects first:** the creature dispatcher waits, instead of ending, while effect jobs are pending.
- **Admin tabs:** reuse the existing preview helpers (`vfxPreview.js`, `auraPreview.js`) and the existing vfx sprite upload route.

**Tech stack:** Node/Express (CommonJS, raw `pg`, `node --test`), React + styled-components (vitest), Canvas 2D.

**Spec:** `docs/superpowers/specs/2026-11-10-effect-tabs-full-coverage-design.md`. Arcs: beam now, `slash` later (spec §9).

## Global Constraints

**Box contract and job settings**
- The box kinds are only `projectile | burst | aura | beam`.
- Shape → kind: `bolt→projectile`, `line→beam`, `burst→burst`, `ring→burst`, `arc→beam`. Auras are always `aura`.
- Default frames and loop: bolt 8/loop, line 8/loop, burst 6/once, ring 6/once, arc 6/once (beam with loop false), aura 8/loop.
- Default size (px): projectile 96, beam 96, burst 128, aura 128.
- Prompt stays "subject only": `defaultPrompt(name, hex)`. Rings append `, seen from above`. No other style or background words.
- Blend: `alpha` when the colour is dark, else `additive`. The 4 batch-1 alpha names stay `alpha` whatever their colour.
- The 21 batch-1 effects produce exactly today's jobs: kind, frames, size, loop, blend and prompt.

**Groups**
- Group order: `Weapon attacks`, `Creature & boss skills`, `Player skills`, `Fallbacks`, `Auras`, `Not used yet`.
  - An effect in several groups goes to the first that matches.
  - Every aura row is in `Auras`.
- **Player skills** = `new Set(SKILLS.map(resolveSkillVfx))` from `backend/seeds/data/skills.js` (26 names on 2026-11-10).
- **Fallbacks** = `generic_slash`, `generic_bolt`, `generic_whiff`: the server `KIND_DEFAULTS` values, read from `backend/src/authority/vfx.js`, not retyped.
- **Weapon attacks** = names in `item_types.vfx` or `entity_types.vfx` (any moment). **Creature & boss skills** = names in `creature_skills.vfx`.
- **Not used yet** = the rest: 27 rows on 2026-11-10.
  - `spark_fire`, `spark_ice`, `spark_lightning` are `retired: true`. Select-all skips them; they can still be ticked one by one.

**Effects first**
- While any `effect_sprite_jobs` row is `queued` or `running` and was created within `EFFECT_QUEUE_CAP_MS` (4 h), the creature batch claims no new sheet.
- It never cancels the sheet the box is drawing, and the batch does not end while it waits.

**Process rules**
- Never mutate the shared dev DB from tests. DB tests use a private `TEST_DATABASE_URL`.
- No `pkill -f` / `pgrep -f`. Headless Chrome only with `--mute-audio`.
- Migrations: none are expected. If one becomes necessary, number it above the highest in `backend/migrations` at merge time.

## Review Focus

1. **The aura tab silently overwrites a sprite** (box-approved or uploaded elsewhere) when the admin saves an unrelated field. Expected: a PUT without a `sprite_image` key leaves all four sprite columns untouched. Pinned in Task 5.
2. **A stuck or orphaned effect row stalls the 9-day creature batch.** Expected: rows older than the 4 h cap don't block, failed rows don't block, and the batch resumes on its own when the last effect finishes. Pinned in Task 2.
3. **An effect renamed or deleted in the Attack tab while it has a queued job.** Expected: the GET list still returns, and the job's row shows with `missing: true` instead of a 500. Pinned in Task 1.
4. **The Sprite preview for an effect whose sprite image fails to load** (a 404 asset). Expected: the Sprite canvas says "sprite not loaded" and the Code canvas still plays. Pinned in Task 4.
5. **Batch-1 regression:** the same 21 targets queued before and after this change produce identical rows. Pinned in Task 1.

---

### Task 1: Effect catalog from the live tables

**Files:**
- Create: `backend/src/services/effectCatalog.js`
- Modify:
  - `backend/src/services/effectSprites.js`: keep `BATCH_1` as the override table; `defaultPrompt` gains the ring suffix;
  - `backend/src/api/effectSpriteRoutes.js` (GET `/` and POST `/jobs`);
  - `backend/src/services/effectSpriteJobs.js` (`resolvePrompts`, `enqueue`);
  - `backend/src/services/spritePrompts.js` (`describerSubjects`, `describerSubject`).
- Test: `backend/tests/effect_catalog.test.js` (pure), `backend/tests/effect_catalog_db.test.js`, and update `effect_sprite_routes_db.test.js` / `effect_sprite_jobs_db.test.js`.

**Interfaces:**
- Produces, from `effectCatalog.js`:
  - `kindForShape(shape: string) -> 'projectile'|'beam'|'burst'`;
  - `isDarkColor(hex: string|null) -> boolean`;
  - `subjectDefaults({ subject_kind, name, shape, color }) -> { kind, frames, size, loop, blend, topDown: boolean }`;
  - `groupOf(name: string, refs: { weapon: Set, creatureSkill: Set, playerSkill: Set, fallback: Set }) -> string`;
  - `async loadEffectCatalog(db) -> Subject[]`, ordered by group order then name;
  - `async findEffectSubject(db, subject_kind, name) -> Subject|null`;
  - `PLAYER_SKILL_EFFECTS: Set<string>`, `RETIRED_EFFECTS: Set<string>`, `GROUP_ORDER: string[]`.
- `Subject = { subject_kind: 'vfx'|'aura', name, group, kind, frames, size, loop, blend, topDown, color, shape, retired }`.
  - It replaces the batch-1 entry everywhere `subjectOf` was used. The field names are the same, so `effectMaxFrames`, `effectJobShape` and `effectTargetError` take it unchanged.
- The GET `/api/sprite-admin/effects` item gains `retired: boolean`, and `group` takes the new values. Everything else keeps its shape.

- [ ] **Step 1: Write the failing pure tests** in `effect_catalog.test.js`:

```js
test('shape → kind', () => {
  assert.deepEqual(['bolt','line','burst','ring','arc'].map(kindForShape), ['projectile','beam','burst','burst','beam']);
});
test('dark colours blend alpha, bright additive', () => {
  assert.equal(isDarkColor('#2a1840'), true);
  assert.equal(isDarkColor('#ff7a1a'), false);
  assert.equal(isDarkColor(null), false);
});
test('the 21 batch-1 effects keep their exact settings', () => {
  for (const b of BATCH_1) {
    const d = subjectDefaults({ subject_kind: b.subject_kind, name: b.name, shape: SHAPE_OF[b.name], color: '#ffffff' });
    assert.deepEqual({ kind: d.kind, frames: d.frames, size: d.size, loop: d.loop, blend: d.blend },
      { kind: b.kind, frames: b.frames, size: b.size, loop: b.loop, blend: b.blend }, b.name);
  }
});
test('arc → beam one-shot 6 frames 96; ring → burst top-down 6 frames 128', () => {
  assert.deepEqual(pick(subjectDefaults({ subject_kind: 'vfx', name: 'cleave', shape: 'arc', color: '#ffffff' })),
    { kind: 'beam', frames: 6, size: 96, loop: false, topDown: false });
  assert.deepEqual(pick(subjectDefaults({ subject_kind: 'vfx', name: 'frost_nova', shape: 'ring', color: '#8fdcff' })),
    { kind: 'burst', frames: 6, size: 128, loop: false, topDown: true });
});
test('groupOf takes the first matching group', () => {
  const refs = { weapon: new Set(['generic_whiff']), creatureSkill: new Set(['x']), playerSkill: new Set(['x','y']), fallback: new Set(['generic_whiff']) };
  assert.equal(groupOf('generic_whiff', refs), 'Weapon attacks');
  assert.equal(groupOf('x', refs), 'Creature & boss skills');
  assert.equal(groupOf('y', refs), 'Player skills');
  assert.equal(groupOf('zzz', refs), 'Not used yet');
});
test('player-skill set equals the frontend resolver over the frontend catalog', async () => {
  const fe = await import('../../frontend/src/games/something2/src/js/core/skillsData.js');
  assert.deepEqual([...PLAYER_SKILL_EFFECTS].sort(), [...new Set(fe.SKILLS.map(fe.resolveSkillVfx))].sort());
});
test('ring prompt says seen from above', () => {
  assert.equal(defaultPrompt('frost_nova', '#8fdcff', { topDown: true }), 'frost nova, ice blue, seen from above');
});
```

`SHAPE_OF` is each batch-1 name's live shape, written into the test as a literal map; read it from the dev DB once with a SELECT. `pick` keeps the five compared keys.

- [ ] **Step 2: Run, verify it fails.** Run `cd backend && node --test tests/effect_catalog.test.js`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement the pure functions** in `effectCatalog.js` and the `defaultPrompt(name, hex, { topDown = false } = {})` suffix in `effectSprites.js`.
  - `isDarkColor` uses relative luminance (sRGB, 0..1). The builder picks the threshold so both literals above hold.
  - Batch-1 entries override the derived defaults field by field, including `blend`.

- [ ] **Step 4: Write the failing DB test** `effect_catalog_db.test.js`, on a private DB seeded with these rows:
  - `vfx_effects`: `a_weapon` (arc), `a_skill` (line), `whirlwind` (ring), `generic_whiff` (arc), `spark_fire` (burst), `orphan` (burst);
  - `aura_effects`: one aura;
  - `item_types.vfx` `{attack:'a_weapon', miss:'generic_whiff'}`;
  - `creature_skills.vfx` `{cast:'a_skill'}`.

  Assert:
  - `loadEffectCatalog` returns every row exactly once;
  - groups: `a_weapon` and `generic_whiff` are Weapon attacks; `a_skill` is Creature & boss skills; `whirlwind` is Player skills (it is in `PLAYER_SKILL_EFFECTS`); `orphan` and `spark_fire` are Not used yet; the aura is Auras;
  - `spark_fire.retired === true` and `orphan.retired === false`;
  - order follows `GROUP_ORDER`;
  - `findEffectSubject(db,'vfx','nope') === null`.

- [ ] **Step 5: Implement `loadEffectCatalog` / `findEffectSubject`.**
  - Read the refs with the jsonb queries from the spec §2: `jsonb_each_text`, and only object-typed `creature_skills.vfx`.
  - Read the fallbacks from `authority/vfx.js` (export `KIND_DEFAULTS` there if it isn't exported).
  - `PLAYER_SKILL_EFFECTS` is computed once at module load.

- [ ] **Step 6: Switch the consumers.**
  - `effectSpriteRoutes` GET builds `subjects` from `loadEffectCatalog`, passing `topDown` into `defaultPrompt`.
  - POST `/jobs`, `effectSpriteJobs.resolvePrompts`/`enqueue` and `spritePrompts.describerSubjects`/`describerSubject` use `findEffectSubject` or the loaded list. Query once per request, not per target.
  - The 400 text changes from "is not a batch-1 effect" to "is not an effect".
  - **Review Focus 3:** a job whose subject row no longer exists still lists, with `missing: true`. Add that case to `effect_sprite_routes_db.test.js`.

- [ ] **Step 7: Batch-1 regression (Review Focus 5).** In `effect_sprite_jobs_db.test.js`, enqueue all 21 batch-1 targets with `seed: 7` on a DB seeded with their real shape and colour. Assert each row's `(kind, frames, size, loop, blend, prompt)` equals a literal expected table. Capture that table from `main` before Step 6, so it's checked against today's behaviour.

- [ ] **Step 8: Run** `cd backend && node --test tests/effect_catalog*.test.js tests/effect_sprite*.test.js tests/effect_dispatcher_db.test.js tests/sprite_prompt*.test.js`. Expected: all PASS.

- [ ] **Step 9: Commit** `feat(effects): Sprite tab lists every effect from the live tables`.

### Task 2: Creature batch waits while effects draw

**Files:**
- Modify: `backend/src/services/spriteJobQueue.js` (new `effectsPending`), `backend/src/services/spriteDispatcher.js` (`drain`, `status`).
- Test: `backend/tests/sprite_job_queue_db.test.js`, `backend/tests/sprite_dispatcher.test.js` (the existing fake-queue tests; add cases).

**Interfaces:**
- Consumes: `EFFECT_QUEUE_CAP_MS` from `effectDispatcher.js`. Export it if it isn't exported.
- Produces:
  - `queue.effectsPending(db) -> Promise<number>`: the count of `effect_sprite_jobs` rows with status in (`queued`, `running`) and `created_at > now() - cap`;
  - the run status gains `pausedForEffects: number`, 0 when not waiting.

- [ ] **Step 1: Failing queue test.** Seed effect rows in four states: queued now, running now, failed now, and queued 5 h ago. Assert `effectsPending === 2`.

- [ ] **Step 2: Failing dispatcher tests (fake queue, injected `sleep`):**
  - Effects pending 2, then 0, with one creature row queued: the drain does not claim while pending. `status().pausedForEffects === 2` during the wait. After pending drops to 0, the row is claimed and drawn. The batch did not end in between (`run.running` stayed true).
  - Effects pending, with no creature rows queued: the batch ends as today. Waiting only makes sense with sheets left to draw.
  - Stop during the wait: the drain exits promptly.

- [ ] **Step 3: Implement.**
  - In `drain`, before `queue.claim`:
    - if `await queue.effectsPending(db) > 0` and creature rows are queued, set `current.pausedForEffects`;
    - set `current.current = { phase: 'waiting', message: 'effects drawing first', ... }`;
    - `await sleep(EFFECT_WAIT_POLL_MS)` (10 000) and `continue`.
  - Otherwise clear `pausedForEffects` and claim as today.
  - The prompt phase still runs first in each loop turn.

- [ ] **Step 4: Run** the two test files. Expected: PASS.

- [ ] **Step 5: Commit** `feat(sprites): creature batch waits while effects draw`.

### Task 3: Sprite tab shows the new groups, retired rows and the wait

**Files:**
- Modify: `frontend/src/games/something2/spriteSelection.js` (`selectAllSpriteSubjects`), `frontend/src/games/something2/effectSprites.js` (`effectRows` passes `retired`), `frontend/src/games/something2/SpriteConsoleAdmin.jsx` (header line).
- Test: `frontend/src/games/something2/__tests__/spriteSelection.test.js`, `effectSprites.test.js`.

**Interfaces:**
- Consumes: the GET `/effects` `retired` field (Task 1) and `run.pausedForEffects` (Task 2).
- Produces: `creatureWaitLine(run) -> string|null`, which is `'Creature sheets wait while effects draw (N left)'` when `run?.pausedForEffects > 0`, else `null`.

- [ ] **Step 1: Failing tests:**
  - `selectAllSpriteSubjects` skips an effect row with `retired: true`, while `isSelectableSubject` still returns true for it.
  - `effectRows` carries `retired`.
  - `creatureWaitLine({ pausedForEffects: 3 })` returns `'Creature sheets wait while effects draw (3 left)'`, and `creatureWaitLine(null)` returns `null`.

- [ ] **Step 2: Implement.**
  - Render `creatureWaitLine(run)` as a `<Hint role="status">` under the effects line in the header.
  - Group headers already follow row order, which the backend now sorts.

- [ ] **Step 3: Run** `cd frontend && npx vitest run src/games/something2/__tests__/spriteSelection.test.js src/games/something2/__tests__/effectSprites.test.js`. Expected: PASS.

- [ ] **Step 4: Commit** `feat(sprites): new effect groups, retired rows skip select-all, wait note`.

### Task 4: Attack Effects tab — Code and Sprite previews, sprite filter

**Files:**
- Modify: `frontend/src/games/something2/vfxPreview.js`, `frontend/src/games/something2/VfxEffectsAdmin.jsx`.
- Test: `frontend/src/games/something2/__tests__/vfxPreview.test.js` (create if absent; use a recording fake ctx, the pattern the existing preview tests use), `VfxEffectsAdmin` filter helper test.

**Interfaces:**
- Produces:
  - `drawVfxPreview(ctx, w, h, def, elapsedMs, image = null, { reference = false } = {})`. With `reference: true` it draws the vector shape at `globalAlpha × 0.35` **and** the sprite on top, the sprite drawn as today. With `reference: false` and `image === null` it is today's code drawing.
  - `vfxSpriteFilter(effects, mode: 'all'|'with'|'without') -> effects`.

- [ ] **Step 1: Failing tests.**
  - With a fake image, `reference: true` records vector stroke calls **and** `drawImage` calls.
  - With no image, `reference: false` records only vector calls, exactly as today (snapshot of the call names).
  - `vfxSpriteFilter` with `'with'` keeps only rows with `sprite_image`.

- [ ] **Step 2: Implement.**
  - Each card shows two canvases side by side, labelled **Code** and **Sprite**, driven by one `requestAnimationFrame` clock:
    - **Code:** `drawVfxPreview(..., null)`;
    - **Sprite:** `drawVfxPreview(..., image, { reference: true })` when the image has loaded. Otherwise a centred caption on the canvas: "no sprite" when the row has none, "sprite not loaded" when loading failed (Review Focus 4: the `<img>` error handler sets the state).
  - Add a Sprite filter select (All / With sprite / Without sprite) next to the shape filter.

- [ ] **Step 3: Run** the tests. Expected: PASS.

- [ ] **Step 4: Commit** `feat(vfx-admin): code and sprite previews side by side, sprite filter`.

### Task 5: Aura sprite fields in the API

**Files:**
- Modify: `backend/src/services/auraEffects.js` (validator), `backend/src/api/auraEffectsRoutes.js` (POST/PUT), `backend/src/services/vfxSprite.js` (export an aura-subset validator if needed).
- Test: `backend/tests/aura_effects_api_db.test.js`, `backend/tests/aura_effects_service.test.js`.

**Interfaces:**
- Produces: POST/PUT `/api/aura-effects` accept `sprite_image` (a key from `POST /api/vfx-effects/sprite`, `''` = clear), `sprite_frames` (1–64), `sprite_additive` (bool) and `sprite_fps` (>0, ≤ `MAX_FPS`).
- **Rule:** when the body has no `sprite_image` key, the PUT leaves all four sprite columns as they are.

- [ ] **Step 1: Failing tests:**
  - A PUT with valid sprite fields stores them.
  - `sprite_image: ''` clears all four: image NULL, frames NULL, additive false, fps NULL.
  - A bad key gives 400 `sprite_image must be a key returned by the sprite upload`.
  - `sprite_frames: 0` gives 400.
  - **Review Focus 1:** a row with a sprite, PUT with only `radius` changed (no `sprite_image` key), keeps the sprite exactly.

- [ ] **Step 2: Implement.**
  - Validate with `vfxSprite.spriteFieldsError`, restricted to the aura columns. Auras have no `sprite_size`, `sprite_loop` or `sprite_stretch`.
  - Write the sprite columns only when the key is present.

- [ ] **Step 3: Run** the two test files. Expected: PASS.

- [ ] **Step 4: Commit** `feat(auras): sprite fields in the aura API`.

### Task 6: Aura Effects tab — sprite upload, Code and Sprite previews, filter

**Files:**
- Modify: `frontend/src/games/something2/auraForm.js`, `frontend/src/games/something2/auraPreview.js`, `frontend/src/games/something2/AuraEffectsAdmin.jsx`.
- Test: `frontend/src/games/something2/__tests__/auraForm.test.js`, `__tests__/auraPreview.test.js` (create if absent).

**Interfaces:**
- Consumes: Task 5's API and `uploadVfxSprite(file)` from `useVfxEffects.js`.
- Produces:
  - `drawAuraPreview(ctx, w, h, def, elapsedMs, image = null, { reference = false } = {})`. With `reference: true` and an image, it draws the ring at alpha × 0.35 and the sprite on top.
    - The sprite is centred.
    - Its width is `2 × r`, where `r` is the preview-scaled radius before pulse.
    - Its height is `width × aspect / 2`, the same flattening as `_drawSpriteAuraGround`.
    - The frame is `floor(elapsed × fps / 1000) % frames` (fps default 10).
  - `auraToForm`/`auraFormToPayload` carry `sprite_image`, `sprite_frames`, `sprite_additive` and `sprite_fps`.
    - The payload **omits** `sprite_image` when the form never touched the sprite (Review Focus 1, client side).

- [ ] **Step 1: Failing tests:**
  - The preview with an image and `reference: true` records the ring arc **and** a `drawImage` whose destination width equals `2 × r`.
  - The payload of an untouched form has no `sprite_image` key; after `pickSprite` or `clearSprite` it has one.

- [ ] **Step 2: Implement.**
  - The sprite field block copies the Attack tab's pick → validate (`validateSpriteFile`) → data-URL preview → upload on Save → clear flow. It reuses `uploadVfxSprite`, so the key scheme is the same.
  - Fields: frames, additive, fps. The aura form has no size field.
  - Code and Sprite canvases as in Task 4, plus the With/Without sprite filter.

- [ ] **Step 3: Run** the tests. Expected: PASS.

- [ ] **Step 4: Commit** `feat(aura-admin): sprite upload, code and sprite previews, sprite filter`.

### Task 7: Seed/export carries the new sprites

**Files:**
- Test: `backend/tests/seed_sync_art_audio_roundtrip_db.test.js`. Registry change only if the test fails.

- [ ] **Step 1: Extend the round-trip.** Export, wipe and apply on a private DB:
  - an aura with an uploaded sprite;
  - a `vfx_effects` row outside batch 1 (shape arc) with a sprite.

  Assert the sprite columns and the PNG bytes come back. The registry already lists `textures/auras` and `textures/vfx` assets (registry.js ~514–530).
- [ ] **Step 2: Run.** If it fails, fix the registry or art-seed path so it passes. Then commit `test(seed): aura and non-batch-1 effect sprites round-trip`.

### Task 8: Live check (gated on the owner's go-ahead)

- [ ] On the dev stack, after merge, with the creature batch running:
  1. queue `cleave` (arc), `frost_nova` (ring) and `fire_wall` (line) from the Sprite tab;
  2. confirm the header shows "Creature sheets wait while effects draw" after the current sheet;
  3. confirm the three draw back to back;
  4. confirm the sheets resume by themselves.
- [ ] Record per-effect `sheet_seconds` against `predicted_seconds`. Screenshot both tabs' Code and Sprite previews for one effect with a sprite and one without. Nothing is auto-approved.
