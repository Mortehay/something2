# Sprite generation tab: directions, custom actions, new creatures, force regenerate

Date: 2026-11-02. Requested by the user in the something2 session. Builds on the GPU-box sprite sheet pipeline (spec 2026-10-21-gpu-box-sprite-sheets-design.md, SOMET-650..657, SOMET-659, SOMET-669) and concept reuse (2026-10-23-sprite-concept-reuse-and-delete-design.md).

## Intent

The admin wants the Sprite generation tab (`SpriteConsoleAdmin`) to control *what* gets drawn, not just *which* creatures:

1. Choose which **directions** to draw per batch, and have the game draw those rows for real instead of mirroring.
2. Choose **actions**, including **new** ones that aren't in the GPU box's built-in catalog.
3. **Add a new creature** that isn't in the subject list yet, without leaving the tab.
4. **Force regenerate**: redraw a creature from scratch with a new concept and a new sheet, even if it has sprites or a job running.

Success means an admin can pick, say, "Ember Swarm", tick `s, se, e, ne, n, nw, w, sw` and `idle, walk, sleep (new)`, press Force regenerate, and later see the creature walk in-game using the real western rows.

## Current state (verified 2026-11-02)

- **Actions:** the box's `GET /api/action-catalog` is the only source (7 actions: attack, cast, damage, idle, sway, use, walk; max_frames 6). It is cached 60 s in `spriteBatchRoutes.js`. Per-batch checkboxes already exist. `POST /api/sprite-admin/jobs` rejects ids that aren't in the catalog. There's no DB table.
- **Directions:** hardcoded `SPRITE_DIRECTIONS = ['s','e','n']` (props `['s']`) in `backend/src/services/spriteBatchOptions.js`. They are stored per row in `sprite_sets.directions` and sent to the box as JobSpec `directions`. The frontend hardcodes 3 facings (`spriteSelection.js` `FACINGS`, UI copy). The box catalog returns all 8, but nothing uses them.
- **Game:** `frontend/src/games/something2/src/js/systems/sheetActions.js` `pickRow` mirrors w/nw/sw from the eastern rows (SOMET-659), *unless* the manifest's `unmirrored[action]` lists that direction. That mechanism already exists for the 3D turnaround (`spriteTurnaround.js`). `LOOPED` is a hardcoded set (idle, walk, sway).
- **Regenerate:** enqueueing a subject whose latest set is done, approved or failed inserts a new row (an implicit regenerate). A running subject is skipped. The kept concept (`sprite_concepts`) is reused. "New concept" (`/concepts/clear`) and "Delete generated" are separate buttons.
- **New creature:** `POST /api/entity-types` (adminGuard) creates an entity type and requires `name` and `color`. The sprite tab has no way to reach it.

## Goals

- **Directions:** per-batch checkboxes for all 8 (`s, se, e, ne, n, nw, w, sw`), default `s, e, n`; props stay `s` only. At least one is required. The chosen set is stored on the row (already a column) and sent to the box. A western direction the admin chose explicitly is written into the sheet manifest's `unmirrored[action]`, so the game draws the real row. Directions not chosen keep today's fallback (mirror or side view).
- **Custom actions:** an admin-managed list of extra actions (id, label, pose description, max frames, loop yes/no) that the tab offers next to the box's catalog. A custom action is sent to the box in whatever shape the box session agrees to (see Box dependency). The game treats `loop` from the manifest/catalog instead of the hardcoded set, so a looping custom action animates correctly in the preview and in-game.
- **New creature:** a small "New creature" form in the tab (name, prompt, creature or prop) that calls `POST /api/entity-types` with sensible defaults (color, `is_creature`), refreshes the subject list, and selects the new subject.
- **Force regenerate:** a "Force regenerate N selected" button. For each selected subject it cancels and deletes a queued or running set (and cancels its box job), drops the kept concept, and enqueues a fresh set with the chosen actions, directions and frames. It applies to subjects in any status.

## Non-goals

- No gameplay triggers for custom actions. A new "sleep" row exists in the sheet and plays in the preview, but nothing in the game decides when a creature sleeps. That's future game-logic work.
- No directions beyond the 8 compass points (the box draws only those).
- No change to the box's built-in catalog through our UI; custom actions live on our side.
- No bulk entity editing; the new-creature form only covers what sprite generation needs. Stats are tuned on the Entities tab as today.

## Anti-goals (failure even if it "works")

- Silently sending an action or direction the box ignores. The tab must say when the box doesn't support custom actions yet, rather than queue jobs that come back without the row.
- Force regenerate deleting **approved** art that's live in the game before the replacement exists. Approved sets stay until the new set is approved (today's approve flow already swaps them).
- Breaking existing sheets: manifests without `unmirrored` or custom loop info must render exactly as today.

## Constraints

- Western rows from the box's 2D path were measured as unreliable (SOMET-659: humanoid "w" is a near copy of "e"). Explicitly chosen western rows are therefore the admin's call. The tab shows a one-line warning when w/nw/sw are ticked.
- The cell estimate (`spriteSelection.js` `FACINGS`), the UI copy, `SPRITE_DIRECTIONS` and the `WESTERN` redraw block must all read the chosen set. Today all four hardcode 3.
- The redraw API refuses western rows (`WESTERN` in spriteBatchRoutes). If a sheet's western rows were chosen explicitly (in `unmirrored`), redraw must allow them.
- Every enqueue path must validate directions against the 8 known ids, and actions against the box catalog plus the custom list.
- Migrations: one new table for custom actions. Watch the migration-timestamp collision pattern (use a fresh timestamp after the latest on origin/main).

## Box dependency (open)

Asked the box session on 2026-11-02:

- (a) Does JobSpec `directions` accept any subset of the 8, and do QA and redraw treat w/nw/sw as real rows?
- (b) What would custom actions take? Suggested shape: `actions: [{id, label, pose, frames, loop}]`, mixed with plain catalog ids.
- (c) Any per-action frame rule.

Until the box answers (b), custom actions are built behind a capability check: the tab offers them only if the box catalog advertises custom-action support (a field the box session will name). Otherwise the custom action list is editable but marked "box does not support custom actions yet", and queueing them is refused with that reason.

## Decided by the user

- Directions: any of the 8, and the game uses the real rows.
- Add new: actions, creatures, and directions. "Directions" is read as the 8 compass directions beyond today's 3; arbitrary angles aren't possible.
- Force regenerate = new concept + new sheet.

## Left to the builder (my calls, flagged)

- Custom actions table: `sprite_custom_actions(id text pk, label, pose, max_frames int, loop bool, created_at)`. The id is a lowercase slug and must not collide with a box catalog id.
- Default color for a new creature: a fixed neutral grey. Defaults otherwise match the Entities tab's "new" form.
- Force regenerate on a running set: cancel the box job (normal `DELETE /api/jobs/{id}`), then replace the row in one transaction, so the "one live set per entity/variant" index holds.
- Delivery in slices, each shippable alone. **User's order (2026-11-02): directions first.** (C) directions + presets + game `unmirrored`; then (A) force regenerate; (B) new creature form; (D) custom actions, after the box answers (b). The box catalog already advertises all 8 directions, and the 2026-10-21 spec says JobSpec takes any `directions[]`. Slice C goes ahead without waiting for answer (a); the first live run is the check.
- **Direction presets (user's decision):** buttons 2-way = `s, e`; 4-way = `s, e, n, w`; 8-way = all eight. Plus the individual checkboxes, so any set can be customised. Today's `s, e, n` stays the default and shows as "custom (3)". A preset only sets the checkboxes.

## Builder-check answers (2026-11-02)

- **Heroes included (user's decision).** Direction choice and force regenerate cover every subject in the tab, playable-class appearance variants included (`optionsForAppearance` stops hardcoding `SPRITE_DIRECTIONS`). The player renderer also draws chosen western and diagonal rows for real, through the same `unmirrored` rule as creatures. If the player path doesn't go through `sheetActions.pickRow`, it gets the equivalent change.
- **Box answer and directions (my call).** Slice C waits for the box's answer to (a). If the box needs a particular row (e.g. `e` to anchor the side view), validation requires it and the tab says so. If 8 directions × N actions exceeds a box sheet limit (c), the tab caps the selection with that reason.
- **Force during the concept stage (my call).** If the subject's live set is still drawing its concept (box task issued, no sheet job yet), force refuses that subject with "concept is still being drawn, try again in a minute". The box can't cancel concept tasks, and a late concept must not land on the new row. Sets in the sheet stage are cancelled through `DELETE /api/jobs/{id}`, and the row is replaced in one transaction.
- **Manifest ownership (my call).** Our backend stamps the manifest when it takes in a sheet, as `spriteTurnaround.js` already does. `unmirrored[action]` comes from the row's chosen western directions, and a custom action's `loop` goes into a manifest field the renderer reads before its hardcoded `LOOPED` set. The box isn't required to emit either.
- **Done-but-unapproved sets on force (my call).** They're deleted with their redraw children and stored files, since they come from the old concept and aren't live. Approved sets stay live until the new set is approved.
- **Showing a sheet's directions (my call).** The subject table gains a "Directions" column from `sprite_sets.directions` (already stored), with western ones marked as real when listed in `unmirrored`. There are no per-row manifest reads.
