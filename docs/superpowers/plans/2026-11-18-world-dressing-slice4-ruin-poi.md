# World Dressing — Slice 4: Ruin Points of Interest Implementation Plan

> **For agentic workers:** superpowers:executing-plans (owner chose native). `- [ ]` steps.

**Goal:** About a quarter of ruins hold a field chest guarded by a pack of the biome's own creatures; the whole pack comes back when the chest respawns.

**Architecture:** Whether a ruin is a POI is DERIVED, not stored: `isPoiRuin(seed, stamp, styles)` = explicit `stamp.poi` if boolean (Slice 5 spec ruins), else `hash2(seed ^ POI_XOR, minRow, minCol) < style.poiChance`. So the 1137 already-stored ruins get chests without being moved or re-rolled. `ensureRuinChests(db, worldId)` reconciles chests with stamps: one `world_chests` row (`kind 'field'`, `structure_key = "<minRow>,<minCol>"`, `guard_count = N`) per POI ruin, guards anchored (`home_x/home_y` set, so `populateWorld` spares them) on walkable cells in and around the ruin; chests whose ruin is gone are deleted with their guards. `ensureStructures` calls it after writing stamps, so seed-map, seed-structures, regenerate and invalidateWorld all reconcile. `respawnDueFieldChests` recreates `guard_count` guards, not one.

**Spec:** `docs/superpowers/specs/2026-11-17-world-dressing-design.md` (Slice 4 + "Decisions settled after builder check": whole pack respawns; level rolled in level_min..level_max; guard type = world allowlist ∩ biome creature_types, empty ⇒ not a POI; chest tile reachable).

## Global Constraints
- Migration `1714440894774_ruin_chests.js`: `world_chests.guard_count int NOT NULL DEFAULT 1 CHECK (guard_count >= 1)`, `world_chests.structure_key text NULL`, unique `(world_id, structure_key)` where not null.
- `poiChance` per style 0.2–0.3; pack size 3–5 (seeded per site).
- Chest at the interior cell `(minRow+1, minCol+1)` centre; guards on interior + cells within 2 tiles of the footprint that are walkable on the STAMPED grid, never a wall.
- Existing loot-map / vault / boss chests untouched (they have `structure_key NULL`).

## Review Focus
1. Re-seed idempotency: second ensureRuinChests creates/deletes nothing.
2. populateWorld never deletes pack guards (anchored).
3. A dropped/re-rolled ruin takes its chest and live guards with it.
4. Respawn makes `guard_count` guards on walkable cells; unlock still needs all dead.
5. Empty allowlist ∩ biome ⇒ no chest (and the stamp stays scenery).

### Task 1: POI rule + migration
- [ ] Test (pure): `isPoiRuin` deterministic; ~poiChance of a style's sites over many stamps; `poiChance: 0` never; explicit `poi` wins.
- [ ] Migration + `structureTypes.js` `poiChance` + `isPoiRuin` in structureSites.js.

### Task 2: `ensureRuinChests`
- [ ] DB tests: creates one chest + N anchored guards per POI ruin; idempotent; deletes chest + guards when the ruin's stamp goes; no chest when allowlist ∩ biome is empty; guards stand on walkable stamped cells.
- [ ] `backend/src/services/ruinChests.js`; called from `ensureStructures` after the write.

### Task 3: Pack respawn
- [ ] DB test: an opened ruin chest past respawn_at comes back locked with `guard_count` guards.
- [ ] `respawnDueFieldChests` loops `guard_count`.

### Task 4: Rollout + verification
- [ ] Dev: migrate, seed-structures (re-rolls nothing; chests appear on existing ruins), browser: chest + pack in a ruin, kill-open-respawn check via test.
- [ ] Review, land, Plane Done.
