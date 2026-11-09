# Effect sprites (auras, bolts, impacts, beams) — design

Date: 2026-11-09. Status: draft for the owner's approval.
This is project 2 of the 2026-11-09 sprite brainstorm. Project 1 is the default creature lane (`2026-11-09-default-sprite-lane-design.md`, shipped).

## 1. Intent

The owner says the game's effects are not wrong but **dull and too simple**: they are all drawn in code as rings, dots and lines. Painted sprite art would make them beautiful. The goal is generated pixel-art sprite animations for effects, made on the GPU box and approved in the admin UI, using the same "draw on the box, approve, the game plays it" loop that creatures already have.

Today's state (measured 2026-11-09, dev DB):
- `vfx_effects`: **87 rows, 0 with a sprite**.
  - Shapes are bolt / burst / ring / line / arc.
  - The row already has sprite columns (`sprite_image`, `sprite_frames`, `sprite_size`, `sprite_additive`; migration 1714440873000) and the game already draws them (`RenderSystem._drawVfxSprite`).
  - The only way to fill them is a manual upload.
- `aura_effects`: **9 rows**, all shape `ring` except `fire_sparks` (`particles`).
  - There are no sprite columns.
  - Drawn as a pulsing ellipse (`RenderSystem._drawAuraEffects`).
- Projectile bodies are a dot plus a vector trail (`_drawProjectileTrail`).
- Chain lightning and beams are code-drawn (`drawSkillVisuals`).

## 2. Goals: batch 1, approved by the owner

| Group | Rows | Animation | Directions |
|---|---|---|---|
| Auras (all 9) | abyssor_void_rend, cinder_brood, fire_sparks, glacius_permafrost, gorgon_static_field, ignis_inferno, ossuary_dread, pack_leader, shade_veil | looping ground effect under the creature, ~8 frames | 1 |
| Elemental bolts | bolt_fire, bolt_ice, bolt_storm, bolt_arcane (`vfx_effects` rows; staffs bind them as both `attack` and `trail`) | short strip, drawn with the existing "along" layout (rotated to the aim) | 1 (rotation is done by the renderer) |
| Impacts | spark_hit (what every staff hit shows today) plus the four existing elemental skill bursts fireball_blast, blizzard_blast, ball_lightning, curse_blast | one-shot burst, ~6 frames | 1 |
| Beam / chain | arcane_beam (shape line), chain_lightning (shape bolt), boss_chain_lightning (one event per hop leg) | strip drawn "along" the line, stretched by `reach` (existing layout) | 1 |

That is about 21 effects. Staff bindings and other gameplay data are NOT changed (no rebinding of staff impacts to new rows).

**Look** (owner accepted the default): pixel art in the creatures' palette. Bright parts glow over the scene (additive blend, alpha from brightness), so effects read as light rather than pasted stickers. Each aura keeps its current colour as the prompt's colour.

1. The admin can generate, preview (animated), redraw and approve a sprite for each batch-1 effect, from an **Effects** section of the Sprite tab.
2. Approved sprites play in-game in place of the code-drawn shape. The code-drawn shape stays as the fallback while the image loads and for effects without a sprite.
3. Every effect job shows a **time estimate before queuing**, like creatures. Box estimate: ~1–3 min per effect, so the whole batch is roughly an hour of box time. Every job is visible in the box Activity tab, under the box's GPU-claim rule.

## 3. Non-goals (later batches)

- The remaining ~70 attack effects.
- Skill-cast flourishes on the caster.
- Buff/debuff markers: they have no data model yet.
- Passive or skill icons: already handled by the static icon pipeline.
- Any game-server or gameplay change: effects stay visual-only.
- Generating effects through the creature sheet builder (`/api/jobs`). The box measured that it invents a body for pose-less subjects, and its BiRefNet cutout snaps alpha to 0/255, which destroys glows.

## 4. Anti-goals: a failure even if it "works"

- **Glow is lost:** hard-edged alpha or a black box around the effect, from cutout or a non-black background.
- **The effect hides the creature** it belongs to. Auras sit under the creature, not over it.
- **Frame-rate cost:** dozens of auras and bolts on screen must not regress frame time. Reuse the existing sheet cache (`_vfxSheet`), and allocate nothing per frame per effect.
- **A sprite looks wrong for its shape:** a bolt that doesn't point where it flies, or a beam stretched into mush.

## 5. How it gets made

### 5.1 Box: new effect generator

The box proposed the following; it is built in the box session and needs the owner's approval there.

1. Draw 1–3 keyframes with txt2img on a **pure black background**. Never ask for "transparent": that paints a checkerboard.
2. Set **alpha = luminance**, palette-quantise to N colours, with no BiRefNet cutout.
3. Animate procedurally by kind:
   - aura: rotate, pulse and flicker loop;
   - burst: radial expand plus fade, one-shot;
   - projectile: a right-pointing flicker loop;
   - beam: a right-pointing segment, flickering per frame.
   Loops are seamless by construction.
4. API:
   - `POST /api/vfx {prompt, kind: projectile|burst|aura|beam, frames, size, loop, blend: additive|alpha, colors, seed}` → `202 {job_id}` (one horizontal strip; projectiles and beams are drawn pointing RIGHT, +x, because the game rotates them to the aim).
   - `GET /api/jobs/{id}` → `sheet.png` + atlas `{frames, fps_hint, loop, blend, pivot}`.
   - Runs under `gpu_claim` / the gateway, so it appears in Activity.
5. The keyframe model is the box's call, with a measured time. The owner rejected SDXL output for creatures earlier, so prefer the Qwen lane unless the box shows SDXL pixel-LoRA effects look right. The box must report s/effect so the ETA is measured, not guessed.

### 5.2 something2: data

- `vfx_effects`: reuse `sprite_image` / `sprite_frames` / `sprite_size` / `sprite_additive` (one horizontal strip, as today — `spriteSourceRect`/`_vfxSheet` assume a single row, so NO multi-row sheets). Add:
  - `sprite_loop boolean NOT NULL DEFAULT false`;
  - `sprite_fps real NULL`: NULL means today's timing (frames spread over `duration_ms`).
- `aura_effects`: add `sprite_image`, `sprite_frames`, `sprite_additive`, `sprite_fps` (auras always loop). No `sprite_size`: an aura's sprite is drawn to its gameplay `radius` (see 5.4), so the art always matches the area that actually affects players.
- **Effect generation rows:** a new table `effect_sprite_jobs`. It is not `sprite_sets`, which is hard-wired to `entity_type_id` / creatures. Columns:
  - `subject_kind` ('vfx' | 'aura'), `subject_name`;
  - `prompt`, `kind`, `frames`, `seed`;
  - `status` (queued / running / done / failed / approved);
  - `box_job_id`, `image_key` (store key of the candidate sheet), `predicted_seconds`, `sheet_seconds`;
  - `error`, timestamps.
  - Approve copies `image_key` and the atlas facts into the subject row's `sprite_*` columns.
- Sheets are stored under the existing `vfx/<uuid>.png` key scheme, so `vfxSprite.js`'s key rule and size limits keep applying. Its limits (64 frames, 600 KB, 8192x2048) fit every batch-1 strip.

### 5.3 something2: admin (Effects section of the Sprite tab)

- **List:** batch-1 effects with name, group, current colour, a sprite thumbnail (or "none"), and status.
- **Per row:**
  - an editable prompt, defaulted from the effect's name and colour;
  - Generate / Redraw;
  - an animated preview (play the strip, loop or one-shot; projectiles and beams previewed rotated at a few angles);
  - Approve.
- **Queue estimate:** per effect and for the selection, from the box's measured s/effect, plus the wait already on the box (reuse `/api/sprite-admin/box-queue`).
- **Dispatch:** a small effect dispatcher, separate from the creature dispatcher. It submits to `POST /api/vfx`, polls, stores the sheet + atlas, and marks the row done. One job at a time, never touching creature rows.

### 5.4 something2: game rendering

| What | Draw path | Behaviour |
|---|---|---|
| Auras | `_drawAuraEffects` | Today auras draw per creature inside the depth-sorted creature pass. Sprite auras move to a **ground pass drawn before all entities**, so a 400-unit aura never paints over a neighbour. The sprite is centred on the creature's feet and scaled so its footprint matches the gameplay `radius` (the same `blastScreenRadiusX` the ring uses), looping at `sprite_fps`, additive when `sprite_additive`. |
| Bolts | `_drawVfxSprite` (existing "along" layout) for the attack event, and the projectile trail path for the `trail` moment | The same strip serves both: rotated to the aim by the renderer; the vector trail line stays under it. |
| Bursts | `_drawVfxSprite` | Already plays a strip once (ground/billboard layouts, additive via `lighter`); it gains `sprite_loop` / `sprite_fps`. |
| Beams / chain | `_drawVfxSprite` "along" layout (rotated, stretched by `reach`) | Already supported. When `arcane_beam` / `chain_lightning` has an approved sprite, the code-drawn `skillVisuals` line for the same cast (`kind 'arcane_beam'` / `'lightning'`) is NOT drawn, so the beam never draws twice. `boss_chain_lightning` already sends one event per hop leg, so each hop gets its own sprite. |

The fallback stays everywhere: no sprite, or not yet loaded, draws exactly today's shape.

## 6. Verification

- **Unit tests:** the new columns' validation; approve copying the right fields; the dispatcher against a fake box; sprite_loop/sprite_fps frame timing; the duplicate beam line suppressed when the vfx row has a sprite; sprite auras drawn in the ground pass before entities, scaled to the gameplay radius.
- **Live:** one effect of each kind generated on the real box via a private DB, the same harness as the creature lane's Task 6. Measured s/effect vs the estimate, and the box Activity row present.
- **Browser:** on an isolated stack, play each batch-1 effect next to a creature, with a screenshot of each. Check that glow edges are soft and the creature is still visible.
- **Performance:** frame time with 30 sprite auras on screen is within 1 ms of the code-drawn rings (measure, don't estimate).

## 7. Decisions left to the builder

- Exact frame counts per kind (the ~ numbers above are starting points).
- The prompt templates per kind.
- The admin layout within the Sprite tab's existing patterns.
- How each bolt's impact effect name maps (read it from the data).

## 8. Calls made by the spec author (not confirmed by the owner)

- **A separate `effect_sprite_jobs` table**, not extending `sprite_sets`. Effects have no entity, directions or actions, so reusing the creature table would fight every creature assumption.
- **No 8-direction sheets:** the renderer's existing "along" layout rotates one right-pointing strip to the aim (the reviewer found multi-row sheets would break `spriteSourceRect`/`_vfxSheet`).
- **Impacts:** spark_hit + four existing elemental skill bursts; no staff data rebinding.
- **Beams:** the vfx row gets the sprite and suppresses the duplicate code-drawn skill line; boss_chain_lightning added because it is the only real multi-hop chain.
- **Aura sprites follow the gameplay radius** and draw in a ground pass before entities.
- **Skill projectiles drawn by `skillVisuals` (`kind 'projectile'`)** are not "bolts" for batch 1; they stay code-drawn.
- **Art travels with seed/export:** approved effect PNGs are included in the existing art export/seed path the same way entity and catalog art are (today the `vfx_effects`/`aura_effects` sync carries `sprite_image` as a bare key without the asset), so effects reach other databases and staging.
- **The keyframe model** is the box's call, Qwen preferred, given the earlier SDXL rejection.
- **Auras draw under the creature.**
- **Buff/debuff markers** stay out of batch 1: they need a data model first.
