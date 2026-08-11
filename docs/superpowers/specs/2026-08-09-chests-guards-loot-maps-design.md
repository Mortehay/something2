# B — Chests, Guards and Loot Maps

**Plane item:** SOMET-244 (In Progress)
**Umbrella:** SOMET-240 "Progression, dungeons & loot" — `docs/superpowers/specs/2026-08-03-progression-dungeons-loot-design.md`. Build order A1 → A2 → C → B → D; A1 (creature levels), A2 (player progression/XP), and C (dungeons/catacombs) are all Done. This is sub-project B. D (magic stones) stays deferred.
**Depends on:** A1 (SOMET-241, Done) — per-instance `world_creatures.level`, per-world level bands. A2 (SOMET-242, Done) — `player_progression`, `awardXp(db, userId, amount, source)` with `'chest'` already a recognized (but currently unused) XP source. C (SOMET-243, Done) — dungeon guard precedent (`guardCreature`, `blocks_portal_id`).

---

## Goal

Persistent, guarded chests that award loot scaled to their guard's level, plus loot-map items
that spawn a fresh guarded chest in the finder's current world. Two flavors sharing one
lifecycle:

- **Vault chests** — hand-authored in a world's map spec (like P5's `guardCreature`), a
  one-time reward. Never respawn once looted.
- **Field chests** — spawned only by using a loot-map item. Respawn after a cooldown so a
  world doesn't permanently run dry.

No second difficulty mechanism: a chest's loot tier comes directly from its guard's A1 level
band, the same number that already scales that guard's HP/damage.

---

## Data model

Three new migrations, reserved timestamp range `1714440091000`–`1714440093000` (last migration
on main today is `1714440090000_ranged_staff_defense_floor.js`).

### `1714440091000_world_chests.js`

```js
world_chests: {
  id: uuid primary key default gen_random_uuid(),
  world_id: uuid NOT NULL references worlds(id) ON DELETE CASCADE,
  x: real NOT NULL,
  y: real NOT NULL,
  kind: text NOT NULL,               -- CHECK (kind IN ('vault','field'))
  guard_entity_type_id: integer NOT NULL references entity_types(id) ON DELETE CASCADE,
  guard_level: integer NOT NULL,     -- snapshot at spawn; guard rows die and vanish,
                                      -- this is what chest_loot rolls against
  guard_creature_ids: jsonb NOT NULL DEFAULT '[]',  -- world_creatures.id[] gating this chest
  state: text NOT NULL DEFAULT 'locked',  -- CHECK (state IN ('locked','unlocked','opened'))
  opened_at: timestamptz,
  respawn_at: timestamptz,           -- field chests only; NULL for vault
  created_at: timestamptz NOT NULL DEFAULT now(),
}
```

`state` transitions: `locked` → `unlocked` (all `guard_creature_ids` confirmed dead) →
`opened` (loot granted). A field chest past `respawn_at` resets to `locked`, gets a **new**
`guard_creature_ids` (a fresh `world_creatures` row spawned at the same `x`/`y`), and clears
`opened_at`/`respawn_at` — same row, not a new one, so a loot map's in-progress reference (if
ever surfaced client-side) never dangles.

Index: `(world_id, state)` — the respawn sweep and the world's chest-marker query both filter
on this pair.

### `1714440092000_chest_loot.js`

```js
chest_loot: {
  id: serial primary key,
  level_min: integer NOT NULL,
  level_max: integer NOT NULL,       -- CHECK (level_max >= level_min)
  item_type_id: integer NOT NULL references item_types(id) ON DELETE CASCADE,
  chance: numeric NOT NULL,          -- CHECK (chance > 0 AND chance <= 1), same as creature_drops
  min_qty: integer NOT NULL DEFAULT 1,
  max_qty: integer NOT NULL DEFAULT 1,  -- CHECK (min_qty >= 1 AND max_qty >= min_qty)
}
```

Rolling a chest queries `WHERE level_min <= $guard_level AND level_max >= $guard_level` and
feeds the rows straight into `loot.js`'s existing `rollDrops()` — no new rolling logic, only a
new row source. Seed data is out of scope for this migration (a follow-up seeding task, mirrored
on how P4 seeded `creature_drops` separately from the schema migration).

### `1714440093000_loot_map_item.js`

Widen `item_types_category_check` from `('weapon','armor','ammo','currency')` to add
`'consumable'` (same drop-and-recreate-constraint pattern as `1714440031000_gold_economy.js`
adding `'currency'`). Seed one row: `('loot_map', 'consumable', ...)`. `down()` reverses both.

---

## Lifecycle

**Vault.** Authored per-world in the map spec, structurally identical to P5's dungeon guard
(`guardCreature`) but stamped as a `world_chests` row (`kind='vault'`) instead of a portal
guard. Seeded at world-creation time by `seed-map.js`, alongside the world's other structures.
Guard dies (normal `commitCreatureDeath` path in `loot.js`) → next check finds
`guard_creature_ids` empty of live rows → `state='unlocked'`. Never respawns: `respawn_at`
stays `NULL` forever once `state='opened'`.

**Field.** Never authored in a map spec. The *only* way one exists is a player using a loot-map
item: the use-item handler picks a valid, navigable tile in the player's **current** world
(reusing the same tile-legality check `placeMapCreatures` already applies), reads that world's
existing level band (the same per-world band A1 already derives creature levels from — no new
band concept), spawns a guard `world_creatures` row at that level, and inserts the
`world_chests` row (`kind='field'`) referencing it. Guard-death → unlock → open follows the
same path as vault. On open, `respawn_at = now() + FIELD_CHEST_RESPAWN_MS` — a named constant
(default 2 hours, alongside the other tunables in `authority/loot.js`, e.g. `DROP_GRACE_MS`),
not hardcoded inline at each call site. A respawn sweep — riding the same tick/interval that
already drives world upkeep, not a new scheduler — resets any `world_chests` row past its
`respawn_at` back to `locked` with a freshly spawned guard.

**Guard-gating.** Guards must die before opening (per your decision) — the open endpoint
verifies zero live rows among `guard_creature_ids` before honoring `state='unlocked'`; a
request against a still-guarded chest is rejected, not silently ignored, so the client gets a
real error to show.

---

## XP integration

Opening a chest calls `awardXp(client, userId, amount, 'chest')` — A2's already-defined,
currently-unused seam — inside the **same transaction** as the loot roll and grant, mirroring
`commitCreatureDeath`'s one-transaction pattern in `loot.js` (DELETE-or-fail licenses the drop
roll and XP award together; here, the `state` CAS from `unlocked`→`opened` plays that role: only
the request that wins the CAS grants loot and XP). `amount` reuses `xpForKill(guard_level,
playerLevel)` from `playerStats.js` unchanged — a chest's guard already has a level on the same
scale a kill's creature does, so this is the existing formula applied to the guard's level
rather than a new one.

---

## API surface

Corrected during planning: item/world actions in this codebase are **WebSocket message
handlers in `authority/server.js`** (`pickup`/`drop`/`interact`/`buy`/`sell`), keyed off the
live in-memory `entry = worlds.get(ws.worldId)` populated once per world by `loadWorld` — not
REST routes. This spec's original draft proposed REST endpoints; the plan uses the real
pattern instead.

- **`openchest` message** — proximity-based like `interact` (no id from the client): finds the
  nearest chest in `entry.chests` within `INTERACT_RADIUS`, validates `state='unlocked'` (CAS to
  `'opened'` inside `openChest()`, so two concurrent opens can't double-grant, same shape as
  `commitCreatureDeath`'s `rowCount === 1` gate), rolls `chest_loot` by `guard_level`, inserts
  `player_items` rows, awards XP, sends a `chestOpened` frame. An `error` frame if no chest is in
  range, still guarded, or already opened.
- **`use` message** — generic use-item entry point (`{itemId}`, resolved via `player_items`
  ownership like `drop`). Dispatches on `item_types.category`; loot map is its first and only
  consumer this slice. Sends an `error` frame for items with no defined use behavior.
- `entry.chests` is loaded alongside `entry.villages` at world-load time and kept in sync
  in-memory on every write (opening, field-spawn, respawn) — the same pattern
  `entry.world.groundItems` already follows for ground loot.
- Chest markers surface on the minimap/world view the same way `world_creatures`/villages
  already do — no new client push mechanism, just a new entity kind in the existing AOI/overview
  payload.

---

## Testing

- **Pure logic** — `chest_loot` row → rolled items, same style as `rollDrops` (deterministic
  under injected `rng`). Level-band filtering edge cases (guard level exactly at a boundary).
- **Migrations** — no-DB `fakePgm` mock tests for all three migrations (the established
  `migration_vfx_effects.test.js` / `migration_biomes_down.test.js` pattern), asserting the
  `state`/`kind` CHECK constraints, the category-widen round-trips cleanly in `down()`, and FK
  references match the real schema.
- **Integration** — guard-alive blocks open; guard-death unlocks; concurrent open requests only
  grant once (CAS test, mirrors `commitCreatureDeath`'s "two damage sources, one finalize"
  test); field-chest respawn only fires after `respawn_at`; using a loot map on a world with no
  legal navigable tile fails cleanly rather than crashing.
- **Browser verification** — since this has a UI surface (opening a chest, using a loot map,
  seeing a chest marker): drive the actual flow — kill a vault guard, open the chest, confirm
  granted items and XP; use a loot map, confirm a field chest appears and is initially guarded.

---

## Explicitly out of scope this slice

- Per-chest cosmetic/sprite variety — reuses whatever generic "chest" visual exists or a single
  placeholder, same posture as SOMET-236-era placeholder color-boxes for un-sprited content.
- Seeding actual `chest_loot` rows (item tiers/weights) — schema only; content is a follow-up.
- Vault chest authoring for any specific world — this spec adds the *capability*; which existing
  or future worlds get a vault chest is a separate content decision, likely riding on P5's
  dungeons the way P5 itself rode on P4's bestiary.
- Sub-project D (magic stones) — explicitly deferred, unaffected by this design.
