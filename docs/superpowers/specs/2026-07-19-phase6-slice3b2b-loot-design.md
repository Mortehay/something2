# Phase 6 Slice 3b-2b — Loot: drops, ground items, pickup

**Date:** 2026-07-19
**Plane:** SOMET-62
**Depends on:** Slice 3b-2a (items/inventory/equipment, merged `39b9281`)

## Goal

Killing a creature drops items on the ground; players see them, walk over or press a
key to claim them, and can drop items back out of their inventory. All of it
server-authoritative: the client sends intent only and never asserts what it received.

## Why this shape

The item layer already exists (`item_types`, `player_items`, `player_equipment`,
`items.js`). What is missing is the bridge between a creature dying and an item
entering a player's inventory. That bridge is a **world entity** — a ground item —
which means it inherits the same problems creatures already solved: it needs an AOI
broadcast, it needs to load when its chunk activates, and it needs to leave memory
when its chunk goes quiet without being lost from the database.

Ground items are strictly simpler than creatures in one respect that shapes the
design: **their position never changes.** No roaming, no dirty tracking, no
confirm-before-clear flush. A ground item is INSERTed once and DELETEd once.

## Decisions (locked during brainstorming)

1. **Free-for-all ground items.** A dead creature spawns `world_items` rows at the
   corpse position, broadcast by AOI. Anyone nearby may claim them. No killer
   reservation.
2. **Drop tables are a real table** (`creature_drops`), not jsonb and not code —
   matching how `item_types` is modelled, with FK integrity in both directions.
3. **DB-persisted with a despawn TTL.** Rows survive restart and chunk unload; each
   carries `expires_at` and is swept periodically.
4. **Pickup is both** — an auto-loot toggle. When on, walking in range claims;
   when off, pressing `G` claims. Both funnel through one server-side claim path.
5. **Full round trip** — players can drop items out of their inventory.

## Data model

One migration, `1714440018000_create_loot.js`.

```sql
CREATE TABLE creature_drops (
  id             serial PRIMARY KEY,
  entity_type_id integer NOT NULL REFERENCES entity_types(id) ON DELETE CASCADE,
  item_type_id   integer NOT NULL REFERENCES item_types(id)   ON DELETE CASCADE,
  chance         numeric NOT NULL CHECK (chance > 0 AND chance <= 1),
  min_qty        integer NOT NULL DEFAULT 1 CHECK (min_qty >= 1),
  max_qty        integer NOT NULL DEFAULT 1 CHECK (max_qty >= min_qty),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX creature_drops_entity_idx ON creature_drops (entity_type_id);

CREATE TABLE world_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id     uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  item_type_id integer NOT NULL REFERENCES item_types(id) ON DELETE CASCADE,
  x            real NOT NULL,
  y            real NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX world_items_world_pos_idx ON world_items (world_id, x, y);
CREATE INDEX world_items_expires_idx   ON world_items (expires_at);
```

`down()` drops both tables. Note the 3b-2a lesson: a `down()` that cannot survive
admin-authored rows is a broken rollback. Here both tables are dropped wholesale, so
there is no partial-restore hazard — but the migration must be verified round-trip
(`up` → `down` → `up`) on a database that has rows in both tables.

Seed: one `creature_drops` row so the feature is demonstrable on a fresh database —
Wolf → dagger at `chance 0.5`, qty 1. Seeding is guarded (skip silently if either the
`Wolf` entity type or the `dagger` item type is absent, exactly as
`grantStartingLoadout` skips a missing catalog name rather than crashing).

`expires_at` is set at INSERT time to `now() + GROUND_ITEM_TTL_MS` (default
**10 minutes**, an `attachAuthority` option so tests can shorten it).

## The death-commit invariant

Today a creature death is finalized in two places, both fire-and-forget:

```js
// server.js:299 (melee) and :366 (projectile)
pool.query('DELETE FROM world_creatures WHERE id = $1', [id]).catch(() => {});
```

Both become one helper:

```js
async function commitCreatureDeath(entry, creatureId) {
  const r = await pool.query(
    'DELETE FROM world_creatures WHERE id = $1 RETURNING type, x, y', [creatureId],
  );
  if (r.rowCount !== 1) return;      // someone else already finalized this death
  await spawnDrops(entry, r.rows[0]);
}
```

**`rowCount === 1` is what licenses the drop roll.** This is the loot analogue of
3b-2a's ONE-mitigation-path rule: a single funnel that any future kill site must go
through. It buys three things at once:

- Two damage sources reporting the same creature id in one tick cannot double-drop.
- The creature's `type` and death position come back from the same statement — no
  need to change `CreatureSim`'s id-only kill returns, so the 3a/3b-1 tests that
  assert `killedCreatureIds` arrays stay untouched.
- A death that fails to persist rolls no loot, so the DB never disagrees with what
  players received.

`spawnDrops` must bridge a naming mismatch: `world_creatures.type` stores the entity
type's **name** (the existing creature load joins `entity_types et ON et.name =
wc.type`), while `creature_drops` keys on `entity_type_id` for FK integrity. The
bridge is free — `loadWorld` already SELECTs the creature types, so `entry` carries a
name→id map built at load time and the resolution costs no query. A type name absent
from that map yields no drops rather than throwing.

`spawnDrops` then selects that type's `creature_drops` rows, rolls each
independently against an injectable rng
(`opts.rng`, default `Math.random`, so tests are deterministic), and INSERTs one
`world_items` row per unit of quantity at the corpse position. Rows also go straight
into the in-memory sim so they appear in the very next AOI broadcast rather than
waiting for a chunk reload.

## Ground item sim

New module `backend/src/authority/groundItems.js`, deliberately mirroring
`CreatureSim`'s surface so the two read alike:

```js
class GroundItemSim {
  constructor(chunkSize)
  add(rows)                      // {id, item_type_id, x, y} — dedup by id
  remove(id)
  get(id)
  nearest(x, y, radius)          // -> item | null   (centre distance)
  within(x, y, radius)           // -> item[]        (auto-loot)
  pruneInactive(activeChunkKeys) // -> count dropped; no dirty concept
  removeExpired(nowMs)           // -> removed ids
  snapshotForNeighborhood(keys)  // -> [{id, typeId, x, y}]
}
```

`World` composes it as `this.groundItems = new GroundItemSim(chunkSize)`.

There is no dirty set and no confirm-before-drop: a ground item's only mutable
property is existence, and the database already records that. Pruning a chunk simply
forgets rows that the next `activateChunk` will re-SELECT.

## The claim path

One function serves both the keypress and auto-loot:

```js
async function claimItem(entry, userId, groundItemId) {
  if (entry.claiming.has(groundItemId)) return null;   // in-flight, skip
  entry.claiming.add(groundItemId);
  try {
    const r = await pool.query(
      'DELETE FROM world_items WHERE id = $1 RETURNING item_type_id', [groundItemId],
    );
    if (r.rowCount !== 1) { entry.world.groundItems.remove(groundItemId); return null; }
    const ins = await pool.query(
      'INSERT INTO player_items (user_id, item_type_id) VALUES ($1,$2) RETURNING id',
      [userId, r.rows[0].item_type_id],
    );
    entry.world.groundItems.remove(groundItemId);
    return { id: ins.rows[0].id, typeId: r.rows[0].item_type_id };
  } finally {
    entry.claiming.delete(groundItemId);
  }
}
```

**The `DELETE ... RETURNING` is the race resolution.** Two players grabbing the same
item in the same tick both issue the DELETE; Postgres serialises them and exactly one
gets `rowCount 1`. The loser is denied and the stale row is evicted from memory. This
is correct without any in-memory lock — the `claiming` set only avoids wasted queries.

On success the winner's in-memory `p.inv.items` gains the instance (so a subsequent
equip validates against it without a reload) and the client is sent
`{type:'picked', item:{id,typeId}}`.

**Failure ordering matters:** the `player_items` INSERT happens *after* the world row
is gone. If that INSERT throws, the item is destroyed rather than duplicated. Losing
one drop is the acceptable failure; duplicating it is not. The INSERT failure is
logged, not surfaced as an error frame.

## Dropping from inventory

`drop{itemId}` — the inverse, with one guard that must not be skipped:

1. Reject if the item occupies any `player_equipment` slot (`inv.equipment` values).
   Without this, the row is deleted while an equipment row still references it,
   leaving a dangling paper-doll entry.
2. `DELETE FROM player_items WHERE id = $1 AND user_id = $2 RETURNING item_type_id` —
   the `user_id` predicate is the ownership check, not a separate lookup, so a forged
   `itemId` naming someone else's item deletes nothing.
3. INSERT a `world_items` row at the dropping player's centre with a fresh TTL, add it
   to the sim, and remove the instance from `p.inv.items`.

Both `pickup` and `drop` are serialised through the existing per-socket `ws._opChain`
that 3b-2a added for `equip`, and wrapped in try/catch. An unhandled rejection in a
WebSocket handler kills the whole authority process on Node 20 — that was 3b-2a's
worst bug and this slice adds three more async handlers to the same surface.

## Lifecycle wiring (`server.js`)

- **Activate:** `activateChunk` gains, alongside the creature load,
  `SELECT id, item_type_id, x, y FROM world_items WHERE world_id=$1 AND x>=..AND x<..
  AND y>=.. AND y<.. AND expires_at > now()` over the same chunk bbox, into
  `groundItems.add(rows)`.
- **Prune:** `flushAndPrune` also calls `groundItems.pruneInactive(entry.activeChunks)`.
- **Sweep:** a fifth interval, `itemSweepMs` (default 60000):
  `DELETE FROM world_items WHERE expires_at <= now() RETURNING id`, then remove those
  ids from the sim. Cleared in `close()` — 3b-2a's hardening pass established that
  every interval must be, or the process will not exit.
- **Broadcast:** `broadcastCreatures` gains a sibling `broadcastItems`, on the same
  `creatureBroadcastEvery` (~5Hz) cadence, sending
  `{type:'items', items: snapshotForNeighborhood(keys)}` — a full neighborhood
  snapshot, consistent with the spec-accepted no-delta creature snapshot.
- **Auto-loot:** when a player's flag is on, `tick` collects `within(cx, cy,
  PICKUP_RADIUS)` and claims each. The claim is async and the tick is not — claims are
  fired through the same `claiming` guard and awaited off-tick, never blocking the
  simulation.

## Protocol additions

| Direction | Message | Notes |
|---|---|---|
| → server | `pickup{}` | claims the **nearest** ground item within `PICKUP_RADIUS` of the player centre; silent no-op if none |
| → server | `drop{itemId}` | validated: owned, not equipped |
| → server | `autoloot{on}` | `on` coerced with `=== true`; session-scoped, default **off** |
| ← client | `items` | AOI snapshot, ~5Hz |
| ← client | `picked{item}` | `{id, typeId}` appended to the client inventory store |
| ← client | `dropped{itemId}` | instance removed from the client inventory store |

Every inbound numeric or structured field is validated at the message boundary. 3b-1's
remote-DoS came from trusting `JSON.parse` output — `{"ax":1e999}` yields `Infinity`,
and non-finite values propagate silently until something never terminates. `itemId` is
checked as a string, `on` as a strict boolean.

## Constants

| Name | Value | Where |
|---|---|---|
| `PICKUP_RADIUS` | 80 | `groundItems.js`, exported |
| `GROUND_ITEM_TTL_MS` | 600000 (10 min) | `server.js` opt |
| `itemSweepMs` | 60000 | `server.js` opt |

`PICKUP_RADIUS` equals the dagger's seeded 80px reach — looting range is exactly the
shortest weapon's reach, so it never exceeds what you can hit.

Note that `player_items.user_id` is `text` (not an integer FK) and `item_types.id` is
`integer`; `world_items.id` and `player_items.id` are `uuid`. New code must match
these types or the mock-pool tests will pass while live queries fail.

## Client

- `entities/GroundItemManager.js` — render store mirroring `CreatureManager`'s
  render-only shape (`applySnapshot(list)`, `all()`); no simulation, no interpolation
  (ground items do not move).
- `RenderSystem.renderChunked` draws each as a small diamond coloured by the item
  type's category (weapon vs armor), depth-sorted with the other entities, with the
  item name drawn above when the player is within `PICKUP_RADIUS`.
- `Game`: `g` keydown (edge-triggered, playing + chunked only) → `sendPickup()`;
  `onItems` → `applySnapshot`; `picked`/`dropped` → inventory store mutation.
- Inventory panel: a **Drop** action on the selected item, and an **Auto-loot: on/off**
  toggle that sends `autoloot{on}`.
- No `color` column is added to `item_types` this slice; category colour is enough.

## Testing

Backend (`node --test`, `__setPool` mock seam):

- `groundItems.test.js` — add/dedup/remove, `nearest` picks the closest and respects
  radius, `within` returns all in range, `pruneInactive` drops out-of-neighborhood
  rows, `removeExpired`, snapshot shape.
- `loot.test.js` — drop rolls are deterministic under an injected rng; `chance 1`
  always drops and `chance 0.5` respects the rng; `min_qty`/`max_qty` produce the right
  row count; a creature type with no drop rows produces nothing; a missing entity type
  does not throw.
- **Death commit:** a second `commitCreatureDeath` for the same id (mock pool returning
  `rowCount 0`) rolls **no** drops. This is the invariant test — it must fail if the
  `rowCount` guard is removed.
- **Claim race:** two `claimItem` calls for one id against a pool whose second DELETE
  returns `rowCount 0` yield exactly one `player_items` INSERT.
- **Drop guard:** dropping an equipped item is rejected and touches no table; dropping
  another user's item deletes nothing.
- Handler safety: a rejecting pool inside `pickup`/`drop` does not produce an unhandled
  rejection (the 3b-2a crash class).

Frontend (Vitest, env `node`): `GroundItemManager` snapshot reconcile add/update/remove;
inventory store applies `picked`/`dropped`. The render layer is verified by build +
browser, as always in this project.

Live browser verification is required before merge and must specifically cover the
two-tab race: both tabs standing on one drop, both pressing `G` — exactly one receives
it, and the item disappears for both.

## Out of scope

Stacking (each drop is its own instance row), rarity tiers or weighted single-pick
tables, loot sources other than creatures (chests, gathering nodes), persisting the
auto-loot preference across sessions, `world_items` growth from deliberate
drop-spam beyond what the TTL bounds, and a `creature_drops` admin editor (rows are
seeded and API-managed this slice).

## Known follow-ups this slice does not close

- SOMET-78 — admin API endpoints remain unauthenticated. `creature_drops` will be
  editable by anyone who can reach the API, which is one more reason it must not ship
  outside dev.
- A player can drop and re-pick an item indefinitely; the TTL bounds accumulation but
  there is no rate limit on `drop`.
