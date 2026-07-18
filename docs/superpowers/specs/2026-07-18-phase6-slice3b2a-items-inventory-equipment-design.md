# Phase 6 — Slice 3b-2a: Items, Inventory, Equipment & Damage Types

**Date:** 2026-07-18
**Epic:** SOMET-53 connected-chunked-world, Phase 6 (authoritative simulation)
**Status:** Design approved, ready for implementation plan
**Builds on:** Slice 3b-1 (combat engine: `weapon_types` catalog, melee arc + projectiles, mouse aim, PvP, mana). Spec `2026-07-18-phase6-slice3b1-combat-engine-design.md`.

## Context

Slice 3b-1 delivered the combat engine but weapons are acquired by a **stand-in**: every player implicitly has the whole catalog and switches with number keys 1–4 (`equip{weaponId}`), with no ownership, no inventory, and no persistence. Armor does not exist — `entity_types` has D&D stats and hp/mana but no defense/resistance, and nothing in the combat resolvers mitigates damage.

This slice makes items real: a generalized item catalog (weapons **and** armor), account-wide item **instances**, a paper-doll equipment model, and a **damage-type pipeline** (elements + resistances) so armor mechanically matters. It retires the number-key stand-in.

This is sub-slice **3b-2a** of the decomposed inventory foundation:
- **3b-2a (this doc):** item types, instances, equipment, damage types, editor, starting loadout.
- **3b-2b (next):** loot — creature drop tables, ground items (`world_items`) + AOI broadcast, server-authoritative pickup.

## Goals

- Generalize `weapon_types` → **`item_types`** with `category` ('weapon' | 'armor'), category-conditional CHECK constraints, and a constrained `element` set.
- **Account-wide item instances** (`player_items`) — one row per owned item, keyed by user, not world.
- **Paper-doll equipment** (`player_equipment`): `main_hand, off_hand, head, chest, hands, feet, ring1, ring2`, with a **two-handed** rule.
- **Damage types**: every attack carries an element; equipped armor contributes flat `defense` + per-element `resistances`; mitigation is applied in **one shared helper** used by both the melee and projectile resolvers.
- Equipment (not a number key) determines the active weapon; server validates **ownership**, slot compatibility, and the two-handed rule.
- **Single active authority session per account** (a new join kicks the older session).
- In-game **inventory + paper-doll UI**, and an **`ItemTypesAdmin`** editor mirroring the existing type editors.
- A **starting loadout** granted idempotently to a player with no items.

## Locked decisions (from brainstorming)

1. Inventory is **account-wide** (keyed `user_id`), not per-world — weapons travel between worlds.
2. Items are **instances** (`player_items` rows), not type-ownership counts — durability/enchants slot in later without a rewrite.
3. Equipment is a **full paper-doll including armor slots**, with a two-handed rule.
4. Armor is **mechanically real, with element resistances** (defense + per-element resistance), not scaffolding.
5. Acquisition this slice = **starting loadout + admin grant**; world pickups/drops are **3b-2b**.
6. Migration approach = **rename + extend `weapon_types` → `item_types`** (single coordinated change; the authority loader updates in the same slice).
7. Concurrency = **single active session per account**, implemented as **newest-wins**: a new join terminates the account's existing authority socket. (Refusing the new join would lock a user out for up to a full heartbeat cycle after a crash, since the dead-socket reaper needs up to ~60 s to notice.)
8. Scope is **weapons + armor**; consumables and other item categories come later.

## Tuning constants (placeholders, single-sourced)

- `MIN_DAMAGE = 1` — damage floor after mitigation (nothing is ever fully negated).
- `RESIST_CAP = 0.8` — maximum total resistance fraction (nothing is immune).
- `ELEMENTS = ['physical', 'arcane', 'fire', 'ice', 'lightning']` — the constrained element set (CHECK on `item_types.element`; also the valid key set for `resistances`).
- Starting loadout: one `dagger` + one basic chest armor (seeded item type, e.g. `leather-vest`).
- Equipment slots: `main_hand, off_hand, head, chest, hands, feet, ring1, ring2`.

## Architecture

The authority gains an **account-scoped** layer alongside its per-world layer. On connection/join, the server loads the user's inventory + equipment by `user_id`, resolves the equipped main-hand item to an `item_types` row, and drives the existing combat engine with it. Damage resolution gains an element and a mitigation step, centralized so the melee and projectile paths cannot diverge. A session registry at the `attachAuthority` level enforces one live socket per account.

## Components

### `backend/migrations/<ts>_items_inventory.js`

1. **Rename + extend:** `ALTER TABLE weapon_types RENAME TO item_types`; add
   - `category text NOT NULL DEFAULT 'weapon'` (drop the default after backfill), CHECK in ('weapon','armor')
   - `slot text` (armor: the paper-doll slot it occupies; weapon: `main_hand`)
   - `two_handed boolean NOT NULL DEFAULT false`
   - `defense real` (armor), `resistances jsonb` (armor; `{element: fraction}`)
   - CHECK on `element IN (...ELEMENTS)` (nullable = physical)
   - **Category-conditional CHECKs** (the constraint carried over from the 3b-1 final review, now covering both categories):
     - `category='weapon'` ⇒ `kind IS NOT NULL` AND (`kind='melee'` ⇒ `reach IS NOT NULL AND arc_width IS NOT NULL`) AND (`kind='projectile'` ⇒ `range IS NOT NULL AND projectile_speed IS NOT NULL AND projectile_radius IS NOT NULL`)
     - `category='armor'` ⇒ `slot IS NOT NULL AND defense IS NOT NULL`
   - Backfill the 4 seeded rows: `category='weapon'`, `slot='main_hand'`; `halberd.two_handed=true`.
   - Seed a starter armor type (`leather-vest`: category armor, slot chest, defense 2, resistances `{}`).
2. **`player_items`**: `id uuid PK default gen_random_uuid()`, `user_id text NOT NULL`, `item_type_id int NOT NULL REFERENCES item_types ON DELETE CASCADE`, `created_at`. Index on `user_id`.
3. **`player_equipment`**: `user_id text NOT NULL`, `slot text NOT NULL`, `item_id uuid NOT NULL REFERENCES player_items ON DELETE CASCADE`, PK `(user_id, slot)`, CHECK `slot IN (...)`. Unique on `item_id` (an instance can occupy at most one slot).

### `backend/src/authority/items.js` (new; replaces/absorbs `weapons.js` catalog loading)

- `loadItemTypes(pool) -> Map<id, itemType>` — the generalized catalog (numbers coerced, `resistances` defaulted to `{}`). Supersedes `loadWeaponTypes`; `weapons.js` keeps its pure geometry helpers (`normalizeAim`, `inArc`).
- `loadInventory(pool, userId) -> { items: [{id, typeId}], equipment: { slot: itemId } }`.
- `grantStartingLoadout(pool, userId, itemTypes) -> boolean` — if the user has **no** `player_items`, insert the starter set in one transaction; idempotent (a second call is a no-op). Returns whether it granted.
- `equip(pool, userId, inv, itemId, slot, itemTypes) -> {ok, reason?}` — validates: the item exists and **belongs to this user**; the item type's `slot` matches the requested slot (weapons ⇒ `main_hand`, or `off_hand` only if not two-handed); the two-handed rule (equipping a two-handed weapon clears `off_hand`; equipping into `off_hand` is refused while a two-handed main-hand is held). Writes through to `player_equipment`. Mutates the in-memory `inv`.
- `unequip(pool, userId, inv, slot)`.
- `mitigation(inv, itemTypes) -> { defense, resistances }` — sums equipped armor `defense` and merges `resistances` (summed per element, then clamped at `RESIST_CAP` at application time).

### `backend/src/authority/damage.js` (new, pure)

- `applyDamage(target, raw, element, mit) -> number` — the **single** mitigation path used by every damage source:
  `final = max(MIN_DAMAGE, (raw - mit.defense) * (1 - min(RESIST_CAP, mit.resistances[element] ?? 0)))`, then `target.hp -= final`; returns the applied amount.
- Exports `MIN_DAMAGE`, `RESIST_CAP`, `ELEMENTS`.
- Creatures have no equipment → callers pass a zero mitigation (`{defense:0, resistances:{}}`), so creature damage is unmitigated this slice.

### `backend/src/authority/world.js`

- `PlayerState` gains `inv` (`{items, equipment}`) and a cached `mit` (recomputed on equip/unequip).
- `addPlayer(userId, spawn, inv)` — takes the loaded inventory; the active weapon is `equipment.main_hand`'s item type (falls back to the default weapon if empty/none).
- `attack(userId, ax, ay)` — unchanged dispatch, but:
  - melee: player hits go through `applyDamage(other, w.damage, w.element ?? 'physical', other.mit)` instead of `other.hp -= w.damage`;
  - projectile: the spawned projectile carries `element` (already present) and its player hits use the same helper.
- `setWeapon`/`equip{weaponId}` from 3b-1 is **removed**; replaced by `setEquipment(userId, itemId, slot)` / `clearEquipment(userId, slot)` delegating to `items.js` and recomputing `mit` + the active weapon.
- `snapshot()` — per player add `equipment` (slot→itemTypeId) so clients can render gear; keep hp/maxHp/mana/maxMana.

### `backend/src/authority/projectiles.js`

- `step` player-hit branch calls `applyDamage(pl, p.damage, p.element ?? 'physical', pl.mit)` rather than `pl.hp -= p.damage`. Creature hits stay unmitigated via `damageCreatureById`.

### `backend/src/authority/server.js`

- **Session registry:** module-level `sessionsByUser = Map<userId, ws>`. On a successful `join`, if an existing socket for that user is present and open, send it `{type:'kicked', reason:'signed_in_elsewhere'}` and `terminate()` it (its existing `close` handler performs the normal teardown), then register the new socket. Clear the entry on `close` **only if it still points at this socket** (avoid a late close from the kicked socket evicting the new session).
- `join`: `loadInventory` → `grantStartingLoadout` if empty → reload → `world.addPlayer(userId, spawn, inv)`; `joined` now carries `items` (the user's instances with their type ids) and `equipment`, plus the `itemTypes` catalog (replacing 3b-1's `weapons`).
- New messages: `equip{itemId, slot}` → `world.setEquipment(...)`; `unequip{slot}` → `world.clearEquipment(...)`. The 3b-1 `equip{weaponId}` is removed.
- `state` broadcast gains per-player `equipment`.

### `backend/src/index.js` — item-type admin CRUD

- `GET/POST/PUT/DELETE /api/item-types` mirroring the existing `/api/entity-types` routes (inline, raw pg), validating `category`, `element ∈ ELEMENTS`, `resistances` keys ⊆ ELEMENTS, and the category-conditional required fields (mirroring the DB CHECKs so the API returns 400 rather than a constraint error).
- `POST /api/players/:userId/items` — admin grant of an item type to a user (creates a `player_items` row).

### Client

- `net/WorldAuthorityClient.js`: `sendEquip(itemId, slot)` / `sendUnequip(slot)` replacing 3b-1's `sendEquip(weaponId)`; `joined`/`state` surface `items`, `equipment`, `itemTypes`; handle a `kicked` message (disconnect + surface "signed in elsewhere").
- `core/Game.js`: **remove** the number-key weapon switch; hold the inventory/equipment state; open/close an inventory panel (e.g. `i`); route equip/unequip actions to the client.
- **`InventoryPanel.jsx`** (new): paper-doll (8 slots) + item list; click-to-equip, click-to-unequip; disables `off_hand` while a two-handed main-hand is equipped; shows each item's type name and key stats from the catalog.
- **`ItemTypesAdmin.jsx`** (new): mirrors `EntityTypesAdmin.jsx`/`TileTypesAdmin.jsx`; category-driven field visibility (weapon fields vs armor fields), element dropdown from `ELEMENTS`, resistances editor (element → fraction).
- `RenderSystem`: HUD shows the equipped weapon name (from `equipment.main_hand` → catalog) instead of the 3b-1 `weaponId` lookup.

## Protocol

- Client → server: `equip{itemId, slot}`, `unequip{slot}` (replacing `equip{weaponId}`). `attack{ax,ay}` unchanged.
- Server → client:
  - `joined`: `{..., itemTypes:[...], items:[{id,typeId}], equipment:{slot:itemId}}` (replaces `weapons`).
  - `state` (20 Hz): players gain `equipment` (slot→itemTypeId).
  - `kicked{reason}`: this account signed in elsewhere; the socket is then terminated.

Anti-cheat: the client sends **ids only** — never stats, damage, defense, or resistances. The server validates ownership and slot legality on every equip. Mitigation is computed server-side from the DB-backed equipment.

## Data model summary

`item_types` (renamed from `weapon_types`, + category/slot/two_handed/defense/resistances + CHECKs), `player_items` (account-wide instances), `player_equipment` (account-wide paper-doll). No change to `world_players`, `world_creatures`, `world_chunks`.

## Error handling

- Equip with an item the user doesn't own, an unknown slot, a category/slot mismatch, or an off-hand while two-handed → refused, no state change, current equipment retained (server may reply with an `error`).
- Equipping an item already in another slot → moved (the unique constraint on `item_id` is upheld by clearing the previous slot in the same transaction).
- Empty catalog / missing starter types → `grantStartingLoadout` is a no-op and the player falls back to the default weapon (server must not crash — mirrors the 3b-1 empty-catalog degradation).
- A kicked socket's late `close` must not evict the new session's registry entry (identity check before delete).
- `resistances` containing an unknown element key → ignored at mitigation time (defensive; the API + CHECK should prevent it).
- Damage floor and resistance cap prevent both zero-damage stalemates and immunity.

## Testing

Backend (`node --test`):
- Migration/catalog: `loadItemTypes` maps weapon and armor rows, coerces numbers, defaults `resistances` to `{}`; the seeded weapons carry `category='weapon'`, `halberd.two_handed=true`.
- `applyDamage`: flat defense subtracts; resistance scales; total resistance clamped at `RESIST_CAP`; result floored at `MIN_DAMAGE`; unknown element → treated as no resistance; zero mitigation is a pass-through.
- `equip`: rejects an item another user owns; rejects a slot/category mismatch; two-handed equip clears `off_hand`; off-hand equip refused while two-handed held; equipping an already-equipped instance moves it.
- `grantStartingLoadout`: grants for a user with no items; second call is a no-op.
- `World`: melee and projectile player-damage both route through `applyDamage` (an armored target takes less than an unarmored one from the *same* attack — asserted on both paths so they cannot drift); `snapshot` includes `equipment`; the active weapon comes from `main_hand`.
- `server` integration (ws + fakePool): `equip` changes the weapon used by a subsequent attack; a second connection for the same user **kicks** the first (first receives `kicked` then closes; second stays live); the kicked socket's close does not evict the new session.

Frontend (Vitest):
- `WorldAuthorityClient.sendEquip(itemId,slot)`/`sendUnequip(slot)` frames; `kicked` handling.
- Inventory store: applying `joined`/`state` inventory+equipment; the pure two-handed/slot-legality helper used to disable off-hand in the UI.
- (Panel/paper-doll and admin rendering verified by build + browser, per the untested-render policy.)

## Global constraints

- Server owns all item state: ownership, equipment legality, mitigation, and the active weapon. The client sends item/slot **ids** only.
- **One** mitigation path (`damage.js applyDamage`) used by every damage source — the melee and projectile resolvers must not compute damage independently.
- Inventory and equipment are **account-wide** (`user_id`), independent of world.
- Exactly one live authority socket per account; a new join kicks the older (newest-wins).
- `element` is constrained to `ELEMENTS` at the DB and API layers; `resistances` keys must be within that set.
- Category-conditional CHECKs must exist at the DB level (not only in the API) so the editor cannot author an unhittable/invalid item.
- Damage is floored at `MIN_DAMAGE` and resistance capped at `RESIST_CAP`.
- The 3b-1 number-key weapon switch and `equip{weaponId}` are fully removed, not left alongside.
- No change to the 20 Hz `state` / ~5 Hz `creatures` cadences beyond the additive `equipment` field.

## Out of scope

**→ 3b-2b:** creature drop tables, ground items (`world_items`), AOI broadcast of ground items, server-authoritative pickup/drop.
**→ later:** consumables and other categories; durability, enchantments, item rarity/affixes; creature armor/resistances (`entity_types` mitigation); set bonuses; stat scaling (`strength`/`dexterity` into damage); stacking; item trading; bank/storage; weight/encumbrance.
