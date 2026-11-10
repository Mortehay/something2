# Effect tabs and full sprite coverage — design

Date: 2026-11-10. Status: owner answered the open question 2026-11-10 (arcs: b then a).
Project 1 of 5 from the 2026-11-10 effects brainstorm. Builds on `2026-11-09-effect-sprites-design.md` (batch 1, shipped) and `2026-11-09-sprite-tab-effects-and-prompt-regen-design.md` (effects as Sprite-table rows, shipped 0e25534c).

The later projects, in the owner's agreed order, are out of scope here:
2. Character buff auras: the 61 buff skills show an aura sprite on the caster.
3. New creature auras with real gameplay, for minibosses plus Apex/Champion creatures.
4. Skill pictures as sprites, with an explicit skill → visual link.
5. Status and world visuals as sprites: burn/chill/shock rings, boss glow, hazards, traps, waves.

## 1. Intent

The owner noticed that most attack effects never got a sprite.
- The Sprite generation tab only lists the 21 hard-coded batch-1 effects.
- The Aura Effects tab cannot show or set a sprite at all.
- Neither tab lets the owner compare the code-drawn effect with its sprite.

The goal is that every effect the game draws from `vfx_effects` or `aura_effects` can be generated, previewed and approved, and that both tabs show each effect **without sprite** (the game's code drawing) and **with sprite** (the code drawing of its area or hit shape with the sprite playing on top). The owner can then judge whether the art fits the area that actually hits.

## 2. Current state (measured 2026-11-10, dev DB)

- **`vfx_effects`:** 87 rows, of which 12 have a sprite (the batch-1 bolts, impacts and beams).
  - Of the 75 without a sprite: 13 arc, 8 bolt, 27 burst, 11 line, 16 ring.
  - **Used by data:** 39 names are referenced by `item_types.vfx`, `entity_types.vfx` or `creature_skills.vfx`.
  - **Used by code:** 43 are reached only through the player-skill resolver `resolveSkillVfx` (`frontend/.../core/skillsData.js:149`). 3 are server defaults (`generic_slash`, `generic_bolt`, `generic_whiff`; `backend/src/authority/vfx.js:22`).
  - **Unused:** `spark_fire`, `spark_ice`, `spark_lightning` are referenced nowhere.
- **`aura_effects`:** 9 rows, all with a sprite since the 2026-11-10 overnight run. Creatures reference 8 of them; none is missing.
- **Sprite tab:** effect rows come from `BATCH_1` in `backend/src/services/effectSprites.js`.
- **Attack Effects tab (`VfxEffectsAdmin.jsx`):** one preview per card. It shows the sprite when there is one, else the vector. Sprite upload exists.
- **Aura Effects tab (`AuraEffectsAdmin.jsx`):** the preview draws only the ring. There are no sprite fields and no upload, although the table has `sprite_image`, `sprite_frames`, `sprite_additive` and `sprite_fps`.
- **Box queue:** a creature batch of 378 sheets (~9 days) is running. The effect dispatcher sends one effect at a time, so each effect queued now waits behind a ~37 min sheet: 72 effects would take ~44 h instead of ~45 min.

## 3. Goals

1. **Every effect on the Sprite tab.**
   - Effect rows are built from the live `vfx_effects` and `aura_effects` tables, not from `BATCH_1`. An effect added later in the Attack or Aura tab appears without a code change.
   - Rows are grouped by what uses them: **Weapon attacks**, **Creature & boss skills**, **Player skills**, **Fallbacks** (the 3 server defaults), **Auras**, and **Not used in game**.
     - The membership rules are the same reference sources as in §2.
     - The player-skill set is the names `resolveSkillVfx` can return. They are exported from that module as a list, so the group can't drift from the resolver.
     - **Not used in game** holds the 3 `spark_*` rows. They are listed but excluded from select-all.
   - The batch-1 per-name settings (blend alpha for the dark ones, frames, size) stay as overrides on top of rules derived from the row.
2. **Shape → box kind** (the box only draws `projectile | burst | aura | beam`):

   | `vfx_effects.shape` | box kind | In-game layout (`spriteLayout`) | Default frames, loop |
   |---|---|---|---|
   | bolt | projectile | along the aim | 8, loop |
   | line | beam | along the aim, stretched | 8, loop |
   | burst | burst | billboard | 6, once |
   | ring | burst (top-down) | ground disc | 6, once |
   | arc | beam now; `slash` once the box has it (§9) | along the aim (swing) | 6, once |

   - The prompt default stays "name + colour". The existing **Regenerate prompt** option (box text model) is the recommended path for abstract names such as `boss_mind_rend`.
   - The blend default is additive. It is alpha when the row's colour is dark (luminance below a threshold), which keeps the batch-1 rule for dark effects.
3. **Effects jump ahead of creature sheets.**
   - While any effect job is queued, the creature dispatcher does not claim a new sheet. It finishes the sheet it is drawing, the effects run, then sheets resume.
   - The header's effects line (shipped 9ef6ee6c) says when sheets are paused for effects.
   - Without this, goal 1 is unusable while the 9-day batch runs.
4. **Attack Effects tab: two previews per card.**
   - **Code:** the game's vector drawing exactly as today (`drawVfxPreview` with no image), even when the row has a sprite.
   - **Sprite:**
     - the same vector drawing, faint, as the area/hit reference;
     - with the sprite on top, using the game's own sprite layout (ground, billboard or along);
     - or "no sprite" when there is none.
   - Both previews use one shared clock, so they play in step.
   - A filter for has sprite / no sprite.
5. **Aura Effects tab: sprite support and two previews.**
   - Sprite fields like the Attack tab:
     - upload a PNG strip (validated with the same `vfxSprite.js` limits; stored under the same `vfx/` key scheme);
     - frames, additive, fps; clear.
   - **Code** preview: the ring as today.
   - **Sprite** preview: the ring faint, with the sprite looping on top, scaled to the gameplay `radius` exactly as `_drawSpriteAuraGround` draws it in game.
   - A has sprite / no sprite filter.
6. **Seed/export.**
   - Approved and uploaded effect and aura sprites travel through seed/export with their PNG assets.
   - Verify the aura sprite columns and their assets are in the sync group, and extend the round-trip test to cover an aura sprite and a newly added (non-batch-1) vfx sprite.
   - `effect_sprite_jobs` stays machine-local.

## 4. Non-goals

- Projects 2–5 above.
- New effect rows, changing which effect a weapon, skill or creature uses, and gameplay changes.
- Changing the in-game sprite drawing (`_drawVfxSprite`, `_drawSpriteAuraGround`) beyond what the previews reuse.
- Deleting the 3 unused `spark_*` rows. That is the owner's call later.

## 5. Anti-goals

- **A preview that lies:** a preview with its own animation maths instead of the game's (`core/vfx.js`, `RenderSystem` layout rules).
- **The Sprite tab listing a different set** from what the Attack and Aura tabs show.
- **Effects starved behind creature sheets,** or the opposite: a sheet the box is drawing cancelled to make room.
- **Select-all queuing the unused rows.**
- **Uploading through the Aura tab bypassing the asset rules** used by the Attack tab: size limits, key scheme, upload on Save.

## 6. Verification

- **Unit:**
  - the group classification from the reference sources;
  - the shape → kind table, including the dark-colour blend;
  - creature claim paused while effect jobs are queued (and resumed after);
  - aura sprite form validation;
  - both previews call the shared game drawing helpers.
- **Browser (isolated stack):**
  - The Sprite tab shows all 87 + 9 rows in the right groups.
  - Each tab shows Code and Sprite previews side by side, for a row with a sprite and for one without.
  - An aura sprite upload saves and plays in the game.
- **Live:** queue 3 new effects (one arc, one ring, one line) while a creature sheet is running. They draw right after that sheet, and their times match the estimate.

## 7. Settled after the builder check (author's calls)

- **The box draws one job at a time.** This was measured on 2026-11-10: `ignis_inferno` timed out queued behind a sheet, and effects waited behind sheets. The pause works like this:
  - The creature dispatcher's claim checks `effect_sprite_jobs` for rows with status `queued` or `running` in the same DB. Every deployment runs both dispatchers against one DB.
  - A row still waiting for its prompt counts. A failed row does not.
  - The pause is bounded by the existing effect queue cap (`EFFECT_QUEUE_CAP_MS`, 4 h). After that, sheets claim again, so a stuck effect can't starve the batch.
- **Group membership:** classified in the backend.
  - The player-skill names come from the backend copy of the resolver (`backend/seeds/data/skills.js` ~2620), exported as a list. A test pins it equal to the frontend `resolveSkillVfx` set.
  - An effect in several groups is shown once, in the first matching group in this order: Weapon attacks, Creature & boss skills, Player skills, Fallbacks. (`generic_whiff` is both a weapon miss and a fallback, so it shows under Weapon attacks.)
- **Layout:** the in-game layout stays derived from `vfx_effects.shape` (`spriteLayout`). No new column.
- **Ring prompts:** the template adds "seen from above".
- **Aura upload:** the Attack tab's upload path is the reference implementation: pick, validate, data-URL preview, upload on Save, clear.
- **Batch-1 regression:** the 21 batch-1 effects must produce exactly today's job (kind, frames, size, loop, blend). A regression test pins that.
- **Seed/export:** if the aura sprite columns or their assets are missing from the sync group, add them. The owner's standing rule is that everything new travels through seed/export.

## 8. Left to the builder

- The exact dark-colour threshold.
- Card layout of the two previews.
- How the "sheets paused for effects" note is worded.

## 9. Open, and calls made by the spec author

- **Owner decision 2026-11-10, arcs (13 melee swings): "b then a".**
  - **Now:** arcs are generated as box kind `beam`, a right-pointing strip, one-shot, 6 frames. In game they keep the existing "along" layout, so a swing sprite is drawn along the aim. This works today; it reads more like a thrust.
  - **Later:** when the box ships a `slash` kind (a one-shot sweeping crescent, pointing right), arcs switch to it. Only the shape → kind table changes, and the owner redraws the swings.
  - The box session is asked for the `slash` kind as a follow-up; it is not part of this project's build.
- **Author's calls:**
  - Rings are drawn as top-down bursts.
  - The "Not used in game" group is listed but excluded from select-all.
  - Effects pause new creature sheets but never cancel the running one.
