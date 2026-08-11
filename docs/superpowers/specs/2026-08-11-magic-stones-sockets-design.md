# D — Magic Stones and Sockets

**Plane item:** SOMET-245 (In Progress)
**Umbrella:** SOMET-240 "Progression, dungeons & loot" — `docs/superpowers/specs/2026-08-03-progression-dungeons-loot-design.md`. Build order A1 → A2 → C → B → D; A1, A2, C, and B (chests, SOMET-244) are all Done. This is the last sub-project.
**Depends on:** A2 (SOMET-242, Done) — `player_progression`, `derivePlayerStats`, the six base stats. B (SOMET-244, Done, merged) — established the `item_types.category` widening pattern this spec reuses for `'stone'`, and the migration-timestamp-reservation discipline. The player-characters epic (SOMET-256/257/259/260, Done, merged) — `player_items`/`player_progression` are character-keyed (`character_id`, not `user_id`); this spec is written against that current schema.

---

## Goal

Convert today's baked-in weapon magic (`item_types.element` + `mana_cost`, fixed per weapon type) into a socket system: a **stone** is its own item that can be inserted into a **socket** on a weapon or armor piece, removed, and moved between items. Existing magic weapons are converted so their spell becomes a pre-slotted stone rather than staying built into the weapon type.

This is the highest-risk sub-project in the epic — its migration rewrites `player_items` rows real players already own — so the schema and the conversion migration are both modeled directly on `1714440092000_characters.js`, the one existing migration in this codebase that has already done exactly this (reversible, backfills real owned data, `down()` proven to not silently destroy player state).

---

## Data model

Reserved migration timestamp range: **check `ls backend/migrations | sort | tail -5` against current `main` immediately before Task 1 starts** and pick a range starting after the highest existing timestamp — this repo has hit real timestamp collisions across concurrent branches twice already (once for this exact epic's chests sub-project), so no range is pre-committed here the way earlier specs did it.

### `item_types` — widen for the `'stone'` category

```sql
-- Same drop-and-recreate-constraint pattern 1714440152000_loot_map_item.js
-- used to add 'consumable'.
ALTER TABLE item_types DROP CONSTRAINT item_types_category_check;
ALTER TABLE item_types ADD CONSTRAINT item_types_category_check
  CHECK (category IN ('weapon','armor','ammo','currency','consumable','stone'));

ALTER TABLE item_types ADD COLUMN stat_bonus_stat text;    -- one of the 6 base stats, or NULL
ALTER TABLE item_types ADD COLUMN stat_bonus_amount integer;  -- NULL unless stat_bonus_stat is set

ALTER TABLE item_types ADD CONSTRAINT item_types_stone_kind_check CHECK (
  category <> 'stone' OR (
    -- exactly one of: spell stone (element+mana_cost already exist) XOR buff stone
    (element IS NOT NULL AND stat_bonus_stat IS NULL)
    OR (element IS NULL AND stat_bonus_stat IS NOT NULL AND stat_bonus_amount IS NOT NULL)
  )
);
ALTER TABLE item_types ADD CONSTRAINT item_types_stat_bonus_stat_check CHECK (
  stat_bonus_stat IS NULL OR stat_bonus_stat IN
    ('strength','dexterity','constitution','intelligence','wisdom','charisma')
);
```

Stones are seeded `stackable = false` — each instance carries independent XP/level, so two stones can never merge into one stack the way a currency or ammo item does.

### `stone_instances` — per-instance stone state

```sql
CREATE TABLE stone_instances (
  player_item_id uuid PRIMARY KEY REFERENCES player_items(id) ON DELETE CASCADE,
  xp bigint NOT NULL DEFAULT 0,
  level integer NOT NULL DEFAULT 1,
  socketed_into_id uuid REFERENCES player_items(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX stone_instances_socketed_into_unique
  ON stone_instances (socketed_into_id) WHERE socketed_into_id IS NOT NULL;
ALTER TABLE stone_instances ADD CONSTRAINT stone_instances_xp_check CHECK (xp >= 0);
ALTER TABLE stone_instances ADD CONSTRAINT stone_instances_level_check CHECK (level >= 1);
```

`player_item_id` is the stone's **own** `player_items` row (a stone is a real, independently-owned item — see "Stone identity" below). `socketed_into_id` points at the **host** item's `player_items` row; `NULL` means the stone sits loose in inventory. The partial unique index enforces "at most one stone per host" at the database level, not just in application code — the same posture `world_chests`' CHECK constraints and `characters`' slot-cap constraint already take in this codebase.

**Corrected during implementation (Task 4b's review, independently verified twice against live Postgres):** an earlier draft of this spec claimed `ON DELETE SET NULL` would not fire when a host item is deleted, and asked for an explicit ejection step to compensate. That claim was backwards — standard PostgreSQL FK semantics fire a column's `ON DELETE` action on deletion of whatever row that column's value points to, and `socketed_into_id`'s value *is* the host's `player_items.id`. Deleting a host row already, automatically, nulls out `socketed_into_id` via the FK alone; no application code is required for correctness. Task 4b still added an explicit `ejectSocketedStone` call in `dropItem`/`sellItem` as tested, harmless, redundant invariant-enforcement (a safety net if the FK is ever altered), not as a bug fix — the "gap" this section originally described does not exist.

---

## Compatibility

- **Spell stones** (element-carrying) socket into **weapons only** — there is no attack on an armor piece for a spell to replace.
- **Buff stones** (stat-bonus-carrying) socket into **weapon or armor**.
- Enforced at socket time by checking the stone's `item_types.category`/kind against the host's `item_types.category` (`'weapon'` vs `'armor'`) — not a database constraint, since the compatible-categories rule depends on which specific host is being targeted, known only at the moment of the socket request, the same way chests' guard-type compatibility was an application check rather than a DB one.

---

## Combat integration — replace semantics

Today, `world.js`'s attack path reads `w.element`/`w.mana_cost` directly off the equipped weapon's `item_types` row (`w` is the resolved item type for whatever is in the weapon equipment slot). This changes to:

1. Resolve the equipped weapon's `player_items` row (not just its `item_types` row, which is all that's resolved today).
2. Look up `stone_instances` where `socketed_into_id` = that `player_items.id`.
3. If a **spell stone** is socketed: use *its* `element`/`mana_cost`/damage-relevant fields for the attack, not the weapon's own `item_types` columns.
4. If no stone is socketed (or a buff stone is socketed — buff stones don't touch the attack): the weapon attacks as plain `'physical'`, `mana_cost = 0`. This is a real behavior change from today (a magic weapon with nothing socketed is not "whatever `item_types.element` still says" — the weapon's own `element`/`mana_cost` columns become vestigial data once this ships, present for the conversion migration to read from, not for combat to read from any more).

**Buff stones** apply their `stat_bonus_stat`/`stat_bonus_amount` to the relevant `player_progression` stat *before* `derivePlayerStats` runs, reusing A2's existing derived-stat pipeline (`maxHp`, `maxMana`, `meleeMult`, `spellMult`, `cooldownMult`, `manaRegen`) entirely — no new stat system, no new derived-stat formula. A socketed buff stone effectively adds to the player's base stat for the purpose of that one derivation call; it does not write to `player_progression` itself (the player's own persisted stats are unaffected — this is a runtime overlay, not a permanent stat change).

---

## Stone XP

A stone gains XP only when a hit actually lands using **that stone's own spell** — i.e., at the `world.js` weapon-hit call sites, when the attack that just connected was sourced from a socketed spell stone (buff stones never gain XP this way, since they never define an attack). This is a new, narrow `awardStoneXp(pool, stonePlayerItemId, amount)` seam, independent of A2's `awardXp` (which is player-scoped, not stone-scoped) — it does not touch `player_progression` at all, only the stone's own `stone_instances.xp`/`level` columns.

---

## Socket / unsocket

**Socket.** Validates: both the stone and the host `player_items` rows are owned by the requesting character; the host has no existing occupant (the partial unique index is the backstop, but the request should also check first for a clean error message rather than relying on the constraint violation); the stone's category is compatible with the host's category (weapon-only for spell stones). Single transaction: update `stone_instances.socketed_into_id`.

**Unsocket.** Requires an explicit confirm flag in the request — mirrors `dropItem`'s unequip-before-drop guard and the general posture this codebase already takes toward irreversible player actions (never let a destructive result fire from a single ambiguous request). On unsocket:
- **10% flat chance (a named constant, not a formula — tunable later without a schema change): the stone is destroyed.** Both its `player_items` row and its `stone_instances` row are deleted (the `CASCADE` on `stone_instances.player_item_id` handles the second half automatically once the first is deleted).
- **90%: success.** `socketed_into_id` is set to `NULL`; the stone returns to plain, loose inventory with its accumulated `xp`/`level` intact.

---

## Conversion migration — existing magic weapons

Modeled directly on `backend/migrations/1714440092000_characters.js`'s proven shape: a real, reversible rewrite of data players already own, not a speculative one-off.

**Up:**
1. For every `item_types` row where `category = 'weapon' AND element IS NOT NULL AND element <> 'physical'`: create one corresponding stone `item_types` row (`category = 'stone'`, copying `element`/`mana_cost`/whatever damage-relevant fields the spell needs — enumerate exactly which columns at implementation time by reading the current weapon-attack code path in full, not by assumption).
2. For every `player_items` row whose `item_type_id` is one of those magic weapons: insert a new stone `player_items` row (owned by the same `character_id`) and a `stone_instances` row for it, pre-socketed (`socketed_into_id` = the weapon's `player_items.id`).
3. The weapon's own `item_types.element`/`mana_cost` columns are **left in place**, not dropped or nulled — they become unused by combat once this ships (per "replace semantics" above), but leaving them intact means `down()` needs no data reconstruction on the weapon-type side, only removal of the stones this migration created.

**Down:** delete every `stone_instances` row and `player_items` row this migration's `up()` created (identifiable via the stone `item_types` rows created in the same migration), then remove those stone `item_types` rows and revert the `item_types` category/constraint widening. Verified rollback, not just written — before this migration ships, run `up()` then `down()` against a real (test-scoped) database and confirm the weapon-owning players' state is byte-identical to before `up()` ran, the same verification bar `1714440092000_characters.js`'s own header comments hold themselves to.

---

## Testing

- **Pure logic** — stone-vs-buff kind resolution, compatibility checking, destroy-chance roll (deterministic under an injected `rng`, same posture as `rollDrops`/`rollGold` in `loot.js`).
- **Migrations** — no-DB `fakePgm` mock tests for the schema migration (established pattern). The conversion migration itself needs a **DB-backed** test (following the `zz`-prefix + cascade-cleanup pattern used throughout chests) proving: `up()` correctly converts a real magic-weapon-owning test player, and `up()` → `down()` round-trips to identical pre-migration state.
- **Integration** — socket/unsocket transactions (ownership checks, compatibility checks, the partial-unique-index collision path), the host-deletion-ejects-stone path (explicitly, since this is the one place the schema alone doesn't guarantee correctness), combat reading the socketed stone instead of the weapon's own columns, buff-stone stat overlay flowing through `derivePlayerStats` correctly, stone XP awarded only on a landed hit with that stone's spell.
- **Stress** — socketing into an already-occupied host (constraint violation surfaces as a clean error, not a 500), unsocketing without the confirm flag (rejected), destroy-roll on a stone with accumulated XP (XP is genuinely gone, not silently preserved), socketing a spell stone into armor (rejected), concurrent socket requests for the same host (the unique index is the actual correctness backstop here, the same role `world_chests`' CAS plays for chest opens).

---

## Explicitly out of scope this slice

- Any specific new stone content beyond the conversion migration's output (new stone types dropped by creatures, sold by merchants, etc.) — this spec adds the *capability*; new stone catalog entries are a follow-up content decision, the same posture B took toward vault-chest content authoring.
- A frontend UI for socketing/unsocketing — B (chests) shipped fully backend-only with no frontend consumer either; this follows the same precedent. The socket/unsocket transactions are real and independently exercisable at the API/CLI level regardless.
- Trading or selling stones — `player_items`' existing sell/drop paths apply to a stone like any other item once it's unsocketed (loose in inventory); no new trade mechanic is introduced.
