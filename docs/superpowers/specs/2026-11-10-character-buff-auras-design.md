# Character buff auras — design

Date: 2026-11-10. Status: draft for the owner's approval. Owner decisions so far: all buffs drawn at once; with several, the strongest stays clearest; strongest = tier, then required level.
Project 2 of 5 from the 2026-11-10 effects brainstorm. Builds on project 1, `2026-11-10-effect-tabs-full-coverage-design.md`, shipped a37012f5: effect rows on the Sprite tab, the creature batch waiting for effects, Code/Sprite previews, and the omit-key sprite save rule.

## 1. Intent

Character buffs are invisible in the world today. A player with Shield Wall, Immolation Aura or Tiger Stance up looks exactly like one without. Only the caster's own HUD lists the buff icons.

The owner wants every active buff drawn on the character as a generated pixel-art aura, looping for as long as the buff lasts and visible to everyone nearby. It should be made the same way as the creature auras: generated on the GPU box from the Sprite tab, approved, and carried through seed/export.

## 2. Current state (measured 2026-11-10)

- There are **61 buff-type skills** (`backend/seeds/data/skills.js`, `type: 'buff'`). Their effect data lives in `backend/src/authority/skillBalance.js`:
  - **54** are timed buffs on the caster only: armours, shields, stances, focus, blessings, and heal-over-time buffs. None has an area.
  - **1** is a real area aura: `mag_immolation_aura`, `aura: { dps: 8, radius: 150, element: 'fire' }`.
  - **3** are traps (`arc_bear_trap`, `arc_explosive_trap`, `arc_tar_trap`). These are world objects drawn by `_drawTraps`, and belong to project 5.
  - **3** are druid forms (`dru_bear_form`, `dru_hawk_form`, `dru_wolf_form`). These change the character's look and are out of scope.
- **The server already sends every player's active buffs** in the shared `players` snapshot (`backend/src/authority/world.js` ~2333: `out.buffs = [{ id, nameUk, nameEn, icon, iconColor, expiresAt, remainingSec }]`).
  - The client reads them only for its own player (`Game.js` ~2202, `_syncBuffsFromServer(mine.buffs)`), and draws them only as HUD icons (`RenderSystem._drawActiveBuffs`).
  - So drawing other players' buffs needs no new message, only two additive fields (§7).
- Skills carry `tier` and `reqLvl`.
- `game_settings` exists for global tunables.

## 3. Goals

1. **55 buff visuals:** the 54 timed buffs plus Immolation Aura.
   - Each one loops on the character while the buff is active, for every client that sees that player, including the caster.
   - It disappears when the buff expires or is removed.
2. **Two placements:**
   - **Ground:** a field under the feet, drawn in the ground pass before entities, like the creature sprite auras.
     - Defaults to ground: `mag_immolation_aura`, `dru_thorns_aura`, `arc_tailwind_aura`, `cul_martyrdom_aura`, `mnk_fast_mana_aura`, `dru_tranquility`, `war_banner_of_victory`.
     - Immolation's ground field is drawn at its real gameplay radius (150, scaled like the creature auras' `blastScreenRadiusX`). The others use a default radius tunable per buff.
   - **Body:** a glow or shell around the character, drawn over the character's sprite and centred on the body.
     - Default size is about 1.3× the drawn character height, tunable per buff with a scale factor.
     - Every buff not listed under Ground defaults to Body.
   - The admin can change any buff's placement.
3. **Several buffs at once:**
   - All active buffs are drawn.
   - With exactly one buff, it plays at full opacity.
   - With two or more, the **main** buff plays at `buff_visual_main_opacity` (default 0.85) and every other at `buff_visual_other_opacity` (default 0.45). Both live in `game_settings` and can be tuned in the admin.
   - **Main** = the strongest active buff:
     - the highest `priority` when the admin set one;
     - otherwise the highest skill `tier`, then the highest `reqLvl`;
     - ties go to the buff cast most recently.
4. **Data:** a new table `buff_visuals`, one row per buff skill, keyed by skill id.
   - Columns: `skill_id text PK`, `placement 'ground'|'body'`, `radius` (ground) or `scale` (body), `priority int NULL`, `color` (prompt colour, defaulted from the skill's `iconColor`), and `sprite_image`, `sprite_frames`, `sprite_additive`, `sprite_fps`, `sync_uuid`.
   - It is seeded with the 55 rows and their default placements.
   - It is a seed/export group with the PNG assets, like `aura_effects`.
5. **Sprite generation tab:**
   - A **Buff auras** group with the 55 rows (`subject_kind: 'buff'`), generated with box kind `aura`, looping, 8 frames by default.
   - The prompt is subject-only, like other effects:
     - the default is "skill name + colour", plus "shell around a figure" for body placement or "seen from above" for ground;
     - Regenerate prompt (the box text model) is available as for other effects.
   - Approval writes the `buff_visuals` sprite columns.
   - The rows go through the same effect dispatcher and effect queue, so they get project 1's effects-first wait.
6. **Admin "Buff Auras" screen** (next to Aura Effects), one card per buff:
   - placement, radius or scale, priority, colour;
   - sprite upload, frames, fps, additive;
   - **Code** and **Sprite** previews;
   - the with/without sprite filter;
   - the two opacity settings.
   - It uses project 1's omit-key save rule: a save that doesn't touch the sprite never writes sprite columns.
   - The **Code** preview shows the fallback drawn when a buff has no sprite: a thin ring (ground) or a soft glow (body) in the buff's colour.
7. **Fallback in game:** a buff with no approved sprite draws that same thin ring or soft glow in its colour, so active buffs are visible from day one.

## 4. Non-goals

- Traps and druid forms (project 5 and later).
- Debuffs on enemies, and the poison and status markers (project 5).
- Any change to what buffs do, to buff durations, or to the protocol.
- Party-wide buffs: buffs affect only the caster today.

## 5. Anti-goals

- **A character you can't read** under stacked buffs. That is why the opacity tiers exist, and why body glows sit behind detail rather than over the face (left to the builder).
- **A ground field that lies about reach:** Immolation's field must match its 150 radius.
- **A per-frame cost** that drops frame time with 20 buffed players on screen. Reuse the sprite sheet cache and allocate nothing per frame per buff.
- **Buffs drawn for a player the client can't see**, or left behind after the buff ends.
- **Sprite saves overwriting approved art** (project 1's rule).

## 6. Verification

- **Unit:**
  - main-buff choice: priority, then tier, then reqLvl, then most recent;
  - opacity per buff count;
  - placement defaults;
  - the fallback drawn when there is no sprite;
  - the omit-key save rule;
  - seed round-trip of a buff visual with its PNG.
- **Browser (isolated stack):**
  - one player with 1, 2 and 4 buffs: screenshots show the opacity tiers;
  - a second client sees the first player's buffs, and they vanish on expiry;
  - Immolation's field matches its 150 radius.
- **Performance:** frame time with 20 buffed players is within 1 ms of none (measured).
- **Live, gated on the owner:** generate 3 buffs on the box (one ground, two body) and approve them.

## 7. Settled after the builder check (author's calls)

- **Two small additive fields on each `buffs` snapshot entry** (`world.js` ~2333). Old clients ignore them, and nothing else in the protocol changes. This replaces §2's "no protocol change".
  - `castAt`, the server time the buff was applied or refreshed, used for the "most recent" tie-break.
  - `auraRadius`, present only when the buff's effect data has `aura.radius`. It is resolved on the server from `skillBalance`, the same way the passive `aura` ring radius is, so Immolation's field always matches its real reach, even after balance changes. `buff_visuals.radius` is used only for buffs without one.
- **Tier and reqLvl** come from the client's existing skills catalog (`SKILLS_BY_ID` in `core/skillsData.js`). No server change is needed for them.
- **Client data:** a public `GET /api/buff-visuals` returns every buff visual row plus the two opacity settings. It is loaded at game start alongside `GET /api/aura-effects`, which already goes into `Game.initChunked`, and indexed by skill id. The admin writes use an admin-guarded route.
- **Effect rows:** `subject_kind: 'buff'`, `name` = skill id, table `buff_visuals` keyed by `skill_id`.
  - The project 1 catalog, job store, approve and route table maps gain this third kind.
  - Effect names can't collide across kinds, because every job is keyed by kind and name.
- **Which buffs get a visual:** every `type: 'buff'` skill except forms and traps, taken from the skills catalog at read time and left-joined to `buff_visuals`.
  - A buff skill added later with no row shows with defaults (body placement, `iconColor`, else `#ffffff`). Its row is created on first save or approve.
  - The migration seeds the 55 rows with the §3.2 placements.
- **What gets drawn:** the client draws only buff ids in that list. Forms, traps and any id it doesn't know are skipped, with no fallback ring.
- **Visibility:** the existing player-snapshot area of interest decides which players are drawn. There is no extra filter. A player who leaves the area takes their buffs with them.
- **Admin:** edit only. No create or delete, since rows follow the skills catalog.

## 8. Left to the builder

- Exact body draw order relative to weapon and armour layers.
- The fallback ring and glow styling.
- The admin card layout.
- Prompt wording within the subject-only rule.

## 9. Calls made by the spec author (not confirmed by the owner)

- The ground default list in §3.2. Everything else defaults to body.
- The default opacities 0.85 / 0.45, tunable.
- Tie-break by most recent cast.
- Body default scale 1.3× character height.
- The default ground radius for non-area buffs: 64 world units, tunable.
- A code-drawn fallback, so buffs are visible before their sprites exist.
- Buff rows reuse the effect dispatcher and queue (box kind `aura`), not a new lane.
