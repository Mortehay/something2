# Creature Respawn — Design

**Ticket:** SOMET-309
**Date:** 2026-08-14
**Status:** approved, ready for implementation planning

## Problem

A world's creature population is a finite pool that only drains.

`commitCreatureDeath` (`backend/src/authority/loot.js:75`) issues
`DELETE FROM world_creatures WHERE id = $1` when a creature dies. Nothing ever
puts one back. `populateWorld` — the only code in the codebase that creates
hostile creatures — is reachable from exactly two places: the seeder
(`backend/scripts/seed-map.js:505`) and the admin re-roll route
(`backend/src/index.js:2630`). There is no timer, no cron, and no on-join
repopulation.

SOMET-301 raised the starting pool from 3,726 to 48,131 creatures across 86
worlds. That buys time; it does not change the shape. A determined group still
empties a world, and it stays empty until an operator clicks re-roll.

## Goal

A world that players fight in refills itself, without operator action, and
without a creature ever materialising on top of a player.

## Non-goals

- **Guard respawn.** Village, portal, and vault guards have their own
  lifecycles (vault guards already respawn via the chest sweep). A guard that
  dies permanently may or may not be a bug; it is not this one.
- **Rebalancing density or level bands.** SOMET-301 set those. This spec
  restores a world to the target it already has.
- **Making empty-by-design worlds populated.** 13 worlds seed zero creatures
  because they have no `allowed_creature_types` or no matching hostile
  `entity_types` rows. That is SOMET-315 and is not fixed here — a world with
  no legal creature type still respawns nothing, correctly.

## Constraints discovered during investigation

These shaped the design and are recorded so the implementer does not
re-litigate them.

1. **`populateWorld` is wipe-and-refill, not top-up.** It opens with
   `DELETE FROM world_creatures WHERE world_id = $1 AND type <> $2 AND
   blocks_portal_id IS NULL AND home_x IS NULL`, then places a complete fresh
   set. It cannot be called incrementally: doing so while players are in the
   world would teleport every surviving creature. Respawn needs its own
   placement path.

2. **`scaleCreature(base, level)` derives hp, damage and defense** from the
   `entity_types` row plus a level (`backend/src/services/creatureLevel.js`,
   used at `mapService.js:710` and `:767`). A respawn queue therefore does not
   need to store combat stats — storing `type` and `level` is sufficient, and
   has the additional benefit that a catalog rebalance applies to everything
   that respawns after it.

3. **`commitCreatureDeath`'s `DELETE` already returns `type, x, y, level`** —
   exactly the four values the queue needs. The death-path change is a wider
   `RETURNING` clause and one `INSERT`, not a restructuring.

4. **`home_x IS NOT NULL` is the structural guard marker.** Village, portal,
   and vault guards all leash to a post via `home_x`/`home_y`; scattered and
   packed hostiles never set it. `populateWorld` already relies on exactly this
   to spare guards from its wipe (see its header comment, and
   `seed_map_vault_chests_db.test.js`). The respawn enqueue uses the same
   marker, so the two agree by construction on what a "wild" creature is.

5. **`itemSweepMs` defaults to 60000** (`server.js:328`). Piggybacking the
   creature sweep on `itemSweepTimer`, as the chest sweep does, would make a
   30-second respawn take 30–90 seconds. Creature respawn gets its own timer.

6. **Worlds are only in memory while occupied.** `loadWorld` populates the
   `worlds` Map on join, and a socket's close handler deletes the entry
   (`server.js:2109`). Nothing else evicts, so a background sweep must never
   load a world itself — it would leak a permanently-loaded empty world. This
   is stated explicitly in `respawnDueFieldChests`' header comment and applies
   here unchanged.

## Design

### Component 1 — `creature_respawns` table

New migration, `backend/migrations/1714440330000_creature_respawns.js`:

```sql
CREATE TABLE creature_respawns (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id   uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  type       text NOT NULL,
  x          real NOT NULL,
  y          real NOT NULL,
  level      integer NOT NULL,
  respawn_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX creature_respawns_due_index ON creature_respawns (respawn_at);
CREATE INDEX creature_respawns_world_id_index ON creature_respawns (world_id);
```

`ON DELETE CASCADE` on `world_id` matches `world_creatures` — deleting a world
must not strand queue rows.

No column is added to `world_creatures`. A pending respawn is a row in this
table; a live creature is a row in that one; nothing is in both.

**Timestamp collision hazard:** this repo has had two migration-timestamp
collisions between parallel branches (see the `migration-timestamp-collision`
note). This shipped as `1714440300000` and was renamed to `1714440330000`
during final review: `main` moved on to `ba0101f` and now carries
`1714440320000_entry_spawn_is_village_spawn.js`, which is not an ancestor of
this branch. Sorting before it would make `migrate:up` refuse this migration on
any database that had already applied 320000 unless run with
`--no-check-order`. Re-check before merging that no branch has claimed
`1714440330000` either.

### Component 2 — enqueue on death

In `commitCreatureDeath` (`backend/src/authority/loot.js`), widen the existing
`DELETE`'s `RETURNING` and add one guarded `INSERT`:

```js
const r = await client.query(
  'DELETE FROM world_creatures WHERE id = $1 '
  + 'RETURNING type, x, y, level, home_x, blocks_portal_id', [creatureId],
);
```

then, after the `rowCount !== 1` gate and inside the same transaction:

```js
// Wild creatures only. home_x is the structural marker every guard kind
// shares -- village, portal and vault guards all leash to a post via
// home_x/home_y, and populateWorld's wipe spares them on exactly this
// column. Guards have their own lifecycles (a vault guard is respawned by
// the chest sweep) and must not be duplicated by this queue.
if (dead.home_x === null && dead.blocks_portal_id === null) {
  await client.query(
    `INSERT INTO creature_respawns (world_id, type, x, y, level, respawn_at)
     VALUES ($1,$2,$3,$4,$5, now() + ($6::int * interval '1 millisecond'))`,
    [entry.worldId, dead.type, dead.x, dead.y, dead.level, RESPAWN_DELAY_MS],
  );
}
```

This sits inside the transaction that already commits the death, the XP award
and the drop roll together. That is deliberate: the existing header comment
establishes that all three "stand or fall together", and a kill that pays XP
and drops loot but fails to schedule its replacement would be a silent,
permanent population leak — precisely the bug this ticket exists to fix.

`now() + interval` is computed by Postgres, not in JS, matching how
`chestLoot.js:96` sets `respawn_at`. One clock governs due-ness.

### Component 3 — the sweep

New module `backend/src/services/creatureRespawn.js`, exporting
`respawnDueCreatures(client, { getWorld, getPlayers, onSpawn })`.

It mirrors `respawnDueFieldChests` (`backend/src/services/chests.js:211`)
deliberately, rather than inventing a second sweep idiom. The four properties
carried over:

- **`getWorld` is injected** and serves only loaded worlds, returning `null`
  otherwise. A row whose world is not loaded stays due and retries on a later
  pass. The sweep never loads a world itself (constraint 6).
- **Per-row `try`/`catch`.** One bad row — a creature type deleted from the
  catalog, a DB hiccup — must not abort the pass. Every other due row still
  gets its turn.
- **`onSpawn` callback** hands the caller exactly what the sweep just wrote, so
  a live world can patch its in-memory sim without a re-read.
- **A `_creatureRespawnSweep` test seam** on the server's return object, so
  tests advance the sweep deterministically instead of racing wall-clock.

Per row:

1. Resolve the `entity_types` row for `type` (`id, name, hp, defense,
   resistances`). If the type no longer exists, delete the queue row and
   continue — the catalog no longer supports it and retrying forever would
   pin a permanently-failing row at the head of every sweep.
2. `getWorld(world_id)`; if `null`, leave the row due and continue.
3. Choose a position (Component 4).
4. In **one transaction**: `DELETE FROM creature_respawns WHERE id = $1`, then
   `INSERT INTO world_creatures (...)`. Doing both in one transaction is what
   makes a crash mid-sweep unable to either drop the creature or duplicate it.
   The `DELETE` is gated on `rowCount === 1` for the same reason
   `commitCreatureDeath` gates its own: two concurrent sweeps claiming the
   same row must produce exactly one creature.
5. `await onSpawn({ worldId, creatureId })`.

Combat stats come from `scaleCreature({ hp: t.hp || 10, damage:
CREATURE_BASE_DAMAGE, defense: Number(t.defense ?? 0) || 0 }, level)` — the
same call `placeMapCreatures` makes, so a respawned creature is
indistinguishable from a seeded one of the same type and level.

### Component 4 — placement

The recorded `x, y` is the preferred position: a creature returns to where it
died.

It is rejected if any connected player in that world is within
**`RESPAWN_MIN_PLAYER_DISTANCE = 1000` world px** (10 tiles, at
`MAP_TILE_SIZE = 100`). On rejection, fall back to
`placeMapCreatures(world, 1, [entityTypeRow], rngSeed)`, which already performs
rejection sampling against village safe zones, `safe_road_radius` and
`safe_rects`. If that also fails to find a legal tile, leave the row due and
retry next sweep.

Relocating rather than deferring is deliberate. Deferring would mean a player
standing where they killed something blocks its replacement — so the more
someone farms one spot, the less it gives them, which is the opposite of this
ticket's goal.

Player positions are read from the live sim via an injected
`getPlayers(worldId)`, not from the database. The DB's character
position lags the sim by up to a sync interval, and a stale position is exactly
the input that would let a creature spawn in someone's face.

### Component 5 — top-up at world load

`loadWorld` ENQUEUES the world's deficit (Component 6) and does not drain it.
It runs no sweep pass of its own.

This changed during review, and the reason is an ordering fact rather than a
preference: `loadWorld` completes before the joining player is registered in
`entry.world.players` (the `join` handler does that), so a sweep run from
inside it would see `getPlayers()` returning `[]` and `isClearOfPlayers` would
be vacuously true for every row — the one guarantee this feature makes
(nothing spawns on top of a player) would not hold for exactly the rows the
backstop exists to place.

The rows are enqueued `respawn_at = now()`, so the regular 10-second sweep
timer delivers them on its next tick, by which point the join has completed and
the distance rule is real. **Consequence, stated honestly:** a player entering
a drained world does not find it repopulated on arrival — it fills in around
them up to ~10 seconds later. That is the price of the distance guarantee being
enforceable at all.

### Component 6 — deficit backstop

A per-death queue only knows about deaths that happen after it ships. The
48,131 creatures alive today have no queue rows, and any world drained before
this lands would stay drained forever.

So, in the same `loadWorld` pass (which, per Component 5, enqueues only —
nothing drains from there): compare the world's live wild-creature count
against its density target and enqueue the difference as immediately-due rows
at positions chosen by `placeMapCreatures`, for the 10-second sweep timer to
deliver.

```sql
SELECT count(*) FROM world_creatures
 WHERE world_id = $1 AND home_x IS NULL AND blocks_portal_id IS NULL
```

against `resolveDensity(row.density, row.width, row.height).scatterCount`,
minus the rows already pending in `creature_respawns` for that world (so a
world with 40 kills in flight does not double-fill).

Note the two sides are not like for like: `worldPopulation.js` writes both
scattered creatures and pack members with `home_x IS NULL`, so the `count(*)`
includes packs while `scatterCount` does not. The backstop therefore restores a
floor BELOW the seeded total by roughly the world's pack budget (up to ~72 at
`swarm`), and a world must fall that far before it fires at all. That is
deliberate under-delivery rather than an exact refill — see the pack paragraph
below.

This makes the system self-healing rather than merely forward-looking: a
population lost to any cause at all, including causes not yet known, comes
back. It runs at most once per world load and is a single indexed `count(*)`
when the world is already full.

Pack creatures are deliberately excluded from the target: `resolveDensity`'s
pack counts are random per-populate, `worlds.creature_count` records only the
scattered figure, and treating packs as a floor would make the backstop
oscillate. The backstop restores the scatter baseline; packs are a
seeding-time flourish that does not regenerate.

### Constants

| Name | Value | Rationale |
|---|---|---|
| `RESPAWN_DELAY_MS` | `30000` | The "fast" end the user chose: an area clears, and about half a minute later it is live again. |
| `CREATURE_SWEEP_MS` | `10000` | Bounds respawn precision to 30–40s. Its own timer, because `itemSweepMs` is 60000 (constraint 5). |
| `RESPAWN_MIN_PLAYER_DISTANCE` | `1000` | 10 tiles. The viewport shows roughly 15×15 tiles, so this keeps a spawn out of the middle of someone's screen without pushing it off the map. |

All three are overridable through the same `opts` mechanism `itemSweepMs` and
`groundItemTtlMs` already use, so tests can drive them deterministically.

## Accepted consequences

**Same-spot respawn on a 30-second timer is farmable.** A player can stand near
where they killed something and fight a stream of replacements. Given the
ticket's goal is "enough creatures for players", this is the intended
behaviour, not an oversight. If it later proves too generous, the lever is
`RESPAWN_DELAY_MS`, and the anti-camping fix would be a per-world or per-region
rate cap — deliberately not built now (YAGNI).

**A world nobody visits never respawns anything.** Both the sweep and the
backstop act only on loaded worlds. This is correct — an unobserved world's
population is unobservable — and it is what keeps 80-odd idle worlds off the
tick budget. The consequence is that `worlds.creature_count` and the admin
overview can show a stale low figure for an idle drained world until someone
enters it.

**Respawns do not preserve pack structure.** A pack killed together comes back
as individuals at their individual death sites, on individual timers. Packs are
a placement-time concept with no runtime representation, so preserving them
would mean inventing one.

## Testing

**Unit, no database** (`node:test`, mirroring `densityTiers.test.js`):

- `respawnDueCreatures` skips a row whose world is not loaded and leaves it due.
- It deletes, rather than retries, a row whose `type` is gone from the catalog.
- Placement rejects the recorded position when a player is within 1000px and
  accepts it at 1001px. Both distances are written as literals, never
  recomputed from `RESPAWN_MIN_PLAYER_DISTANCE` — a test that derives its
  expectation from the constant it is testing passes for any value of that
  constant.
- One failing row does not prevent later rows in the same pass from spawning.

**Database-backed** (`_db.test.js`, requires `TEST_DATABASE_URL`):

- Killing a wild creature leaves exactly one `creature_respawns` row with
  matching `type`/`x`/`y`/`level`.
- Killing a village guard, a portal guard and a vault guard leaves **zero**
  rows. This is the test that would have caught treating `type <> 'Village
  Guard'` as the guard filter.
- A due row produces exactly one `world_creatures` row and zero remaining queue
  rows.
- Two concurrent sweeps over the same due row produce exactly one creature.
- The backstop enqueues `target - live - pending`, and enqueues nothing for a
  world already at target.

**Browser verification** (mandatory on this project — a green suite has missed
live defects repeatedly, see the `browser-verification-lessons` note):

Kill a creature in a bounded world, note the position and the wall-clock time,
and confirm a replacement of the same type appears within roughly 40 seconds.
Then stand on the death position and confirm the replacement appears elsewhere
rather than on top of the character. Screenshot both.

## Files

| Action | Path |
|---|---|
| Create | `backend/migrations/1714440330000_creature_respawns.js` |
| Create | `backend/src/services/creatureRespawn.js` |
| Create | `backend/tests/creature_respawn.test.js` |
| Create | `backend/tests/creature_respawn_db.test.js` |
| Modify | `backend/src/authority/loot.js` (`RETURNING` + enqueue) |
| Modify | `backend/src/authority/server.js` (sweep timer, `loadWorld` top-up, `_creatureRespawnSweep` seam) |

## Open questions

None. Every decision above is settled; the implementation plan can proceed.
