# Character buff auras — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every active character buff (55 skills) loops as a ground or body aura on that character for every nearby client, with the strongest buff clearest. Each aura is generated on the Sprite tab, edited on a new Buff Auras admin screen, and carried by seed/export.

**Architecture:**
- A new `buff_visuals` table, keyed by skill id, is read through a small service that left-joins the skills catalog.
- The project 1 effect pipeline gains a third subject kind, `buff`, behind one kind registry instead of scattered `'aura' ? … : …` ternaries.
- The client reads the buffs that already travel in the `players` snapshot, plus two new fields. Pure helpers choose the main buff and its opacity, and RenderSystem draws ground auras in the ground pass and body auras after entities, like `_drawWeaponGlows`.

**Tech stack:** Node/Express (CommonJS, raw `pg`, node-pg-migrate, `node --test`), React + styled-components (vitest, node env), Canvas 2D.

**Spec:** `docs/superpowers/specs/2026-11-10-character-buff-auras-design.md`

## Global Constraints

**Which buffs, and where they draw**
- Visual buffs = skills with `type === 'buff'`, minus forms and traps. On 2026-11-10 that is 55. The forms are `dru_bear_form`, `dru_hawk_form`, `dru_wolf_form`; the traps are `arc_bear_trap`, `arc_explosive_trap`, `arc_tar_trap`. Decide by the effect data (`fx.form`, `fx.trap` in `backend/src/authority/skillBalance.js`), not by retyped ids.
- Ground default: `mag_immolation_aura`, `dru_thorns_aura`, `arc_tailwind_aura`, `cul_martyrdom_aura`, `mnk_fast_mana_aura`, `dru_tranquility`, `war_banner_of_victory`. All other visual buffs default to `body`.
- Ground radius:
  - when the snapshot entry has `auraRadius` (from `fx.aura.radius`; Immolation = 150), use it;
  - otherwise use `buff_visuals.radius`, default 64 world units.
  - Draw it with `blastScreenRadiusX`, like creature sprite auras.
- Body size: `scale` × drawn character height, default 1.3.

**Several buffs at once**
- Exactly one active visual buff draws at opacity 1.
- With two or more, the main buff draws at `buff_visual_main_opacity` (default 0.85) and each other at `buff_visual_other_opacity` (default 0.45). Both are `game_settings` keys, valid range 0–1.
- Main buff, in order:
  1. highest `priority` (NULL counts as below any number);
  2. highest skill `tier`;
  3. highest `reqLvl`;
  4. most recent `castAt`.

**Fallback**
- A visual buff without a sprite draws a thin ring (ground) or a soft radial glow (body) in its `color`.
- `color` defaults to the skill's `iconColor`, else `#ffffff`.
- Unknown ids, forms and traps draw nothing.

**Generation**
- Sprite tab group `Buff auras`, `subject_kind: 'buff'`, `name` = skill id, box kind `aura`, 8 frames, loop, size 128.
- Default prompt: `defaultPrompt(skill nameEn, color)` plus `, shell around a figure` for body or `, seen from above` for ground.

**Saving and data flow**
- Omit-key save rule: a buff visual PUT without a `sprite_image` key writes no sprite columns. Same as project 1's vfx and aura rule.
- Protocol: only two additive fields on each `players[].buffs[]` entry: `castAt` (= the buff's `startedAt`) and `auraRadius` (only when `fx.aura.radius`). Nothing else changes on the wire.

**Process rules**
- Migration numbered above `1714440882000`. Re-check the highest number at merge time.
- Never mutate the shared dev DB from tests (private `TEST_DATABASE_URL`). No `pkill -f` or `pgrep -f`. Chrome only with `--mute-audio`.
- The main checkout's `backend/` is watched by nodemon on a live dev stack with a sprite batch running. Work only in the worktree.

## Review Focus

1. **A stale admin form overwrites a box-approved buff sprite on save.** Expected: no `sprite_image` key means no sprite write. Pinned in Task 1 (API) and Task 6 (form payload).
2. **A buff that expires, or a remote player who leaves view, keeps drawing an aura.** Expected: the aura is gone on the next snapshot. Pinned in Task 4 (remote buffs replaced, not merged, each snapshot).
3. **Two clients pick different main buffs for the same player.** Expected: the choice depends only on snapshot data plus the shared catalog, so it is deterministic. Pinned in Task 4 (same input in a different array order gives the same main).
4. **The Immolation field drifts from its real reach after a balance change.** Expected: the field reads `auraRadius` from the server, never the table. Pinned in Task 3 and Task 5.
5. **Frame cost with many buffed players.** Expected: no per-frame allocation per buff, and frame time within 1 ms of none at 20 buffed players. Pinned in Task 5 (perf measurement step).

---

### Task 1: `buff_visuals` table, service and API

**Files:**
- Create: `backend/migrations/1714440883000_buff_visuals.js`, `backend/src/services/buffVisuals.js`, `backend/src/api/buffVisualsRoutes.js`
- Modify: `backend/src/index.js` (mount routes), `backend/src/services/gameSettings.js` (`DEFAULTS` + validation for the two keys)
- Test: `backend/tests/buff_visuals.test.js` (pure), `backend/tests/buff_visuals_api_db.test.js`, `backend/tests/migration_buff_visuals_db.test.js`

**Interfaces:**
- Produces from `buffVisuals.js`:
  - `VISUAL_BUFF_IDS: string[]`, from SKILLS + skillBalance (excluding forms and traps);
  - `GROUND_DEFAULT: Set<string>`;
  - `defaultVisual(skill) -> { skill_id, placement, radius: 64, scale: 1.3, priority: null, color }`;
  - `async listBuffVisuals(db) -> Row[]`, one per visual buff, the stored row merged over the default, with `name_en`, `tier`, `req_lvl`;
  - `async saveBuffVisual(db, skillId, body) -> Row`, an upsert that follows the omit-key rule. It throws `{ status: 404 }` for a non-visual id and `{ status: 400, message }` on validation.
- HTTP:
  - `GET /api/buff-visuals` (public) → `{ visuals: Row[], settings: { main_opacity, other_opacity } }`.
  - `PUT /api/buff-visuals/:skillId` (admin) → `Row`. Fields: `placement`, `radius` (>0, ≤2000), `scale` (>0, ≤4), `priority` (integer or null), `color` (#rrggbb), and the sprite fields validated with `vfxSprite.spriteFieldsError` restricted to `sprite_image`, `sprite_frames`, `sprite_additive`, `sprite_fps`.
- Table `buff_visuals`:
  - `skill_id text PRIMARY KEY`;
  - `placement text NOT NULL CHECK (placement IN ('ground','body'))`;
  - `radius real NOT NULL DEFAULT 64`, `scale real NOT NULL DEFAULT 1.3`, `priority integer NULL`;
  - `color text NOT NULL`;
  - `sprite_image text NULL`, `sprite_frames integer NOT NULL DEFAULT 1`, `sprite_additive boolean NOT NULL DEFAULT true`, `sprite_fps real NULL`;
  - `sync_uuid uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE`, `updated_at timestamptz NOT NULL DEFAULT now()`.
- The migration seeds the 55 rows, with placement from `GROUND_DEFAULT` and colour from `iconColor`. It **also** widens `effect_sprite_jobs.subject_kind` CHECK to `('vfx','aura','buff')` for Task 2.

- [ ] **Step 1: Failing pure tests:**
  - `VISUAL_BUFF_IDS.length === 55`, contains `mag_immolation_aura`, and excludes the 3 forms and 3 traps;
  - `defaultVisual` gives ground for each `GROUND_DEFAULT` id and body for `war_shield_wall`;
  - the colour falls back to `#ffffff` when `iconColor` is missing.
- [ ] **Step 2: Failing DB tests:**
  - the migration seeds 55 rows;
  - `GET` returns 55 visuals with defaults plus `settings` `{ main_opacity: 0.85, other_opacity: 0.45 }`;
  - a PUT with sprite fields stores them;
  - **Review Focus 1:** a row with a sprite, PUT without the `sprite_image` key (radius changed, stale `sprite_frames: 3`), keeps all four sprite columns;
  - `sprite_image: ''` clears (image NULL, frames 1, fps NULL, additive true);
  - a PUT for `dru_bear_form` gives 404;
  - `priority: 1.5` gives 400;
  - the `game_settings` keys reject 1.2.
- [ ] **Step 3: Implement**, run (`node --test` on the three files, private DB, `--test-concurrency=1`). Expected: PASS.
- [ ] **Step 4: Commit** `feat(buffs): buff_visuals table, service and API`.

### Task 2: Effect pipeline learns the `buff` kind

**Files:**
- Create: `backend/src/services/effectKinds.js`
- Modify: `backend/src/services/effectCatalog.js`, `effectSpriteJobs.js`, `effectSprites.js` (`approveColumns`), `spritePrompts.js` (`PROMPT_KINDS`, `EFFECT_KINDS`, describer subjects), `backend/src/api/effectSpriteRoutes.js`
- Test: `backend/tests/effect_kinds.test.js`, and extend `effect_catalog_db.test.js`, `effect_sprite_jobs_db.test.js`, `effect_sprite_routes_db.test.js`

**Interfaces:**
- Consumes Task 1: `listBuffVisuals`, table `buff_visuals`, and the widened CHECK.
- Produces from `effectKinds.js`:
  - `EFFECT_KINDS = { vfx: { table: 'vfx_effects', keyCol: 'name', spriteCols: [...] }, aura: { table: 'aura_effects', keyCol: 'name', spriteCols: [...] }, buff: { table: 'buff_visuals', keyCol: 'skill_id', spriteCols: ['sprite_image','sprite_frames','sprite_additive','sprite_fps'] } }`;
  - `kindOf(subject_kind) -> entry | null`.
- Every `subject_kind === 'aura' ? … : …` table or column choice in the files above goes through it.
- Buff subjects from `loadEffectCatalog`: `{ subject_kind: 'buff', name: skill_id, group: 'Buff auras', kind: 'aura', frames: 8, size: 128, loop: true, blend: 'additive' (alpha if isDarkColor), color, placement, retired: false }`.
- The prompt suffix comes from placement (Global Constraints).
- `approveColumns` for `buff` returns the aura column set. It also **upserts** the row when it doesn't exist yet (spec §7).

- [ ] **Step 1: Failing tests:**
  - `kindOf('buff').table === 'buff_visuals'`, and `kindOf('nope') === null`;
  - the catalog lists the 55 buffs in group `Buff auras`, after `Auras` and before `Not used yet`;
  - the default prompt for `war_shield_wall` ends with `, shell around a figure`, and for `mag_immolation_aura` with `, seen from above`;
  - enqueue + approve of a buff job writes `buff_visuals` sprite columns;
  - project 1's batch-1 regression test and all existing effect tests stay green, unchanged.
- [ ] **Step 2: Implement**, run the effect test files (private DB, `--test-concurrency=1`). Expected: PASS.
- [ ] **Step 3: Commit** `feat(effects): buff auras are an effect kind`.

### Task 3: Snapshot carries `castAt` and `auraRadius`

**Files:**
- Modify: `backend/src/authority/world.js` (~2333, the `out.buffs` map)
- Test: an existing world snapshot test file. Find the one asserting `out.buffs`, else create `backend/tests/world_buff_snapshot.test.js`.

**Interfaces:**
- Produces `players[].buffs[]` entries gaining `castAt: number` (the buff's `startedAt`) and, only when `bf.fx.aura.radius`, `auraRadius: number`.

- [ ] **Step 1: Failing test.**
  - A player with Immolation and Shield Wall gives two entries.
  - Immolation has `auraRadius: 150`, Shield Wall has no `auraRadius` key, and both have `castAt === startedAt`.
  - **Review Focus 4:** change `fx.aura.radius` to 200 on the player's buff and the snapshot says 200.
- [ ] **Step 2: Implement**, run. Expected: PASS.
- [ ] **Step 3: Commit** `feat(buffs): snapshot buffs carry castAt and auraRadius`.

### Task 4: Client buff state and main-buff rules

**Files:**
- Create: `frontend/src/games/something2/src/js/core/buffAuras.js`
- Modify: `frontend/src/games/something2/src/js/core/Game.js`:
  - load `GET /api/buff-visuals` at init next to aura effects; store `this.buffVisuals` (by skill id) and `this.buffVisualSettings`;
  - each snapshot sets `remotePlayer.buffs` and `player.buffs` to the entry arrays, **replacing** the old ones.
- Test: `frontend/src/games/something2/src/js/core/__tests__/buffAuras.test.js`

**Interfaces:**
- Produces from `buffAuras.js`:
  - `visibleBuffs(buffs, visuals) -> entries[]`: keeps ids present in `visuals`, so forms, traps and unknown ids drop out.
  - `mainBuffId(entries, visuals, skillsById) -> string|null`, using the order in Global Constraints.
  - `buffOpacity(count, isMain, settings) -> number`.
  - `groundRadius(entry, visual) -> number`, which prefers `entry.auraRadius`.
  - `bodyScale(visual) -> number`.

- [ ] **Step 1: Failing tests:**
  - `buffOpacity(1, true, s) === 1`, `buffOpacity(3, true, s) === 0.85`, `buffOpacity(3, false, s) === 0.45`;
  - `mainBuffId` order: a priority 5 buff beats a higher tier; then tier, then reqLvl, then later `castAt`;
  - **Review Focus 3:** the same entries reversed give the same id;
  - `visibleBuffs` drops `dru_bear_form` and an unknown id;
  - `groundRadius({ auraRadius: 150 }, { radius: 64 }) === 150`, and `groundRadius({}, { radius: 64 }) === 64`;
  - **Review Focus 2:** a snapshot without `buffs` for a remote player leaves `remotePlayer.buffs` empty. Test whatever pure helper Game uses to map the snapshot.
- [ ] **Step 2: Implement**, run `npx vitest run src/games/something2/src/js/core/__tests__/buffAuras.test.js`. Expected: PASS.
- [ ] **Step 3: Commit** `feat(buffs): client buff state and main-buff rules`.

### Task 5: Draw buff auras in the world

**Files:**
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js`:
  - `_drawBuffGround(player, remotePlayers, ctx)`, called right after `_drawSpriteAuraGround(creatures)` (~559);
  - `_drawBuffBodies(player, remotePlayers, ctx)`, called next to `_drawWeaponGlows` (~655);
  - pass `buffVisuals`, `buffVisualSettings` and `skillsById` through the render params like `auraDefs`.
- Test: `frontend/src/games/something2/src/js/systems/__tests__/renderBuffAuras.test.js` (recording fake ctx)

**Interfaces:**
- Consumes Task 4 helpers and the existing `_vfxSheet(def)`, `_blitSprite`, `blastScreenRadiusX`, `worldToScreen`, `RenderSystem.entityDrawSize`.
- Ground layout: width `2 × blastScreenRadiusX(groundRadius)`, height `width × aspect / 2`, centred on the feet point as in `_drawSpriteAuraGround`.
- Body layout: height `bodyScale × drawn height`, width from the sheet aspect, centred on the body centre. Frame `floor(t × fps / 1000) % frames`, fps default 10. Additive draws use `'lighter'`.

- [ ] **Step 1: Failing tests (fake ctx):**
  - one ground buff with a loaded sheet: `drawImage` width equals `2 × blastScreenRadiusX(150)` for Immolation, at `globalAlpha` 1;
  - three buffs: one draw at 0.85 and two at 0.45;
  - a buff without a sheet: an arc stroke (ground) or a radial gradient fill (body) in its colour, and no `drawImage`;
  - `dru_bear_form` draws nothing;
  - the composite op and alpha are restored after drawing.
- [ ] **Step 2: Implement.** Keep scratch objects module-level and reused; allocate nothing per buff per frame.
- [ ] **Step 3: Run** the test file. Expected: PASS.
- [ ] **Step 4: Perf (Review Focus 5).** In a vitest bench or a scripted loop over the fake ctx, 20 players × 3 buffs adds under 1 ms per frame on this machine. Record the number in the report. The real-browser number comes in the controller's browser check.
- [ ] **Step 5: Commit** `feat(buffs): draw buff auras on characters`.

### Task 6: Buff Auras admin screen and Sprite tab group

**Files:**
- Create: `frontend/src/games/something2/BuffAurasAdmin.jsx`, `frontend/src/games/something2/buffVisualForm.js`, `frontend/src/games/something2/buffAuraPreview.js`, `frontend/src/games/something2/useBuffVisuals.js`
- Modify:
  - `frontend/src/App.jsx` (route `buffs` beside `auras`);
  - the sidebar nav (where Aura Effects is listed in `GameShell.jsx`);
  - `frontend/src/games/something2/effectSprites.js` (`effectRows` handles `subject_kind: 'buff'`).
- Test: `__tests__/buffVisualForm.test.js`, `__tests__/buffAuraPreview.test.js`, `__tests__/BuffAurasAdmin.smoke.test.js`

**Interfaces:**
- Consumes Task 1 HTTP, and project 1's exported `useSpriteImage`, `PreviewPair`, `PreviewCol`, `PreviewLabel`, `spriteCaption`, `vfxSpriteFilter`, `validateSpriteFile`, `uploadVfxSprite`.
- `buffVisualForm.js`:
  - `buffToForm(row)`, `buffFormToPayload(form)`. The payload omits every `sprite_*` key unless `sprite_touched`, and sends `''` (never null) to clear.
  - `validateBuffForm(form) -> string|null`.
- `drawBuffAuraPreview(ctx, w, h, visual, elapsedMs, image = null, { reference = false } = {})`.
  - **Code** draws the fallback ring or glow.
  - **Sprite** draws the fallback at alpha × 0.35 under the sprite, laid out as in Task 5: ground flattened to the radius, body upright to the scale, with a 48 px figure box for reference.
- The screen:
  - one card per visual buff: name, class, placement select, radius or scale, priority, colour;
  - the sprite block (pick, validate, preview, upload on Save, remove, frames, fps, additive);
  - Code and Sprite canvases on one clock;
  - search, a class filter, the with/without sprite filter;
  - an "Opacity" bar at the top with the two `game_settings` values, saved through the existing settings endpoint;
  - no create or delete.

- [ ] **Step 1: Failing tests:**
  - an untouched form's payload has no `sprite_*` keys; after pick, clear or a frames edit it has them; clear sends `''` (Review Focus 1, client);
  - `validateBuffForm` rejects scale 0 and radius 0, and accepts priority `''` as null;
  - the preview with an image and `reference: true` records a ground `drawImage` of width `2r`, or a body `drawImage` of height `scale × 48 × previewScale`, plus the fallback at 0.35;
  - `effectRows` maps a `buff` subject with `group: 'Buff auras'`.
- [ ] **Step 2: Implement**, run the three test files plus the existing sprite tab tests. Expected: PASS.
- [ ] **Step 3: Commit** `feat(buff-admin): Buff Auras screen, previews, Sprite tab group`.

### Task 7: Seed/export carries buff visuals

**Files:**
- Modify: `backend/src/services/seedSync/registry.js`:
  - a group `buff_visuals` (label "Buff Auras"), natural key `skill_id`, sprite columns as ART;
  - an art entry with assets `{ sprite_image: { type: 'image', dir: 'textures/buffs', name: (r) => r.skill_id } }`, like aura_effects ~525–530;
  - also `boardSeedGroups.js` and `frontend/.../seedExportModel.js` labels where aura_effects is listed.
- Test: `backend/tests/seed_sync_art_audio_roundtrip_db.test.js` (add a case); the seed coverage test must stay green.

- [ ] **Step 1: Failing test.** Export a buff visual with an uploaded sprite and a non-default placement and priority, wipe it, and apply it to an empty store. The row fields and PNG bytes come back.
- [ ] **Step 2: Implement**, run (private DB, `--test-concurrency=1`). Expected: PASS.
- [ ] **Step 3: Commit** `feat(seed): buff visuals travel with seed/export`.

### Task 8: Live check (gated on the owner's go-ahead)

- [ ] After merge, on the dev stack:
  1. generate `mag_immolation_aura` (ground), `war_shield_wall` and `mnk_tiger_stance` (body) from the Sprite tab;
  2. compare `sheet_seconds` with `predicted_seconds`;
  3. approve them on the owner's say-so.
- [ ] In game, with two muted headless clients:
  - client A casts the three buffs; client B sees them with Shield Wall or Tiger Stance as main (by tier/level) and the others faded;
  - each vanishes on expiry;
  - screenshot each step.
