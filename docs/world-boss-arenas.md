# World boss arenas

Each world boss fights in its **own small world**, reached by **one universal portal** in the Vale
Crossing hub. The portal is **always open** (you can walk in at any time, boss or not) and its
destination follows the boss: the active boss's arena, else the next boss's, else a default.
No level restriction.

| Boss | Element | World | Biome |
| --- | --- | --- | --- |
| Glacius, the Frost Leviathan | ice | `Boss Arena: Glacius` | Frostvault |
| Ignis, the Magma Colossus | fire | `Boss Arena: Ignis` | Emberdepths |
| Abyssor, the Voidreaver | arcane | `Boss Arena: Abyssor` | Abyssal Rift |
| Gorgon, the Thunder Titan | lightning | `Boss Arena: Gorgon` | Storm Coast |

Gorgon keeps its Spire floor-60 role; this is only its world-boss arena.

Code: `backend/src/authority/bossArenaWorlds.js` (the one boss → arena table, matched by name,
then by element), `worldBoss.js` (planning, loading, holding), `bossArena.js` (centre),
`server.js` (universal portal resolution, eviction). Spec generator: `backend/scripts/gen-boss-arenas-spec.js`
(`node scripts/gen-boss-arenas-spec.js --check` verifies the committed JSON). Tests:
`backend/tests/boss_arena_worlds.test.js`.

## The maps

* 64×64 tiles (6400 px), chunk 32, no wandering creatures (`density: dead`, empty allowlist).
* Whole arena disk (radius 700 px around the centre 3200,3200) and the walk from the return
  portal are `road_stone` (speed 1.2, the fastest tile), painted as authored `roads`.
  The boss stands at the centre (`findArena` source `dedicated`, radius 450).
* Entry spawn at tile (32,16); return portal at tile (32,14), to `@Vale Crossing`.
* Hub side: ONE pad at tile (52,54) = pixel (5450,5250), on a paved 3×3 `road_stone` plaza joined
  to the town's east road by a spur down column 53. It stands where the Vale Crossing **tavern**
  used to be (the tavern is no longer generated for `spec_key = 'vale-crossing'`, see
  `VILLAGES_WITHOUT_TAVERN` in `mapService.js`; other villages keep theirs). The roads live in
  `vale-region.map.json` (`vale_hub` roads), because that is the hub's own spec.
* All four arena links in `boss-arenas.map.json` point at the SAME hub tile (`shared_arrival: true`
  tells the validator that is deliberate). The seeder's upsert therefore leaves **one** hub row
  (hub pad → an arena; the last link written, Gorgon, is only a *placeholder*) plus four return
  rows (arena → hub pad).

## Operator steps

Order: run the migrations first (`1714440870000`, `1714440871000`, `1714440872000` — the world boss state and
schedule), then seed the maps. The code runs without the arenas (see fallback), so deploy order
between code and seed does not matter.

```
make seed-map SPEC=vale-region KEEP_ENTRY=1    # hub plaza (re-applying it clears the hub's cached chunks)
make seed-map SPEC=boss-arenas KEEP_ENTRY=1    # the four arena worlds + their portals
# Orange Pi:
make pi-seed-map SPEC=vale-region
make pi-seed-map SPEC=boss-arenas KEEP_ENTRY=1
```

`KEEP_ENTRY=1` matters: the validator needs exactly one `is_entry` world per spec, so
`arena_glacius` carries a placeholder flag; without `KEEP_ENTRY=1` the seeder would move the
game's real entry world to the Glacius arena. Do not forget it. (Seed `vale-region` with the
usual setting for that spec.)

**Leftover rows from the old four-pad layout.** The seeder never deletes portal rows, so after
upgrading, the four old hub pads (and their landmarks) stay in the database until removed. Remove
them once, after the seeds above, then restart the backend (it caches the portal links):

```sql
DELETE FROM map_links ml
 USING worlds hub, worlds arena
 WHERE ml.edge = 'PORTAL'
   AND ml.from_world_id = hub.id AND hub.name = 'Vale Crossing'
   AND ml.to_world_id = arena.id AND arena.name LIKE 'Boss Arena: %'
   AND NOT (ml.from_x = 5450 AND ml.from_y = 5250);
```

The Vale Crossing tavern disappears when its chunks are regenerated: `seed-map` clears
`world_chunks` for the world, and the running backend must be restarted so it drops its
in-memory copy of the world.

## Fallback

If an arena world is not in the database, the boss falls back to the old region logic (an
arena found/marked in a normal world), and the server logs once per arena:
`arena world "Boss Arena: X" is not loaded (or not seeded) … Seed the arenas with: make seed-map SPEC=boss-arenas`.

## Lifecycle

* **The next boss is chosen as soon as an event ends** (and on the first tick after start-up /
  schedule restore), and kept for the whole cycle: that pick is both the arena the hub portal
  leads to while nothing is active and the boss the warning later plans, so the arena people
  wait in is the one the boss spawns in. A debug/admin `forceSpawn` of a *different* boss
  runs in that boss's arena and does not consume the pick (the portal follows the active boss
  for the duration, then returns to the cycle's pick); a forced spawn of no particular boss uses
  the pick, as before.
* Arena worlds are not kept in memory when empty. Walking in loads the world through the normal
  join path (the portal tick records a `pendingArrivals` entry for the resolved world id, which
  join-policy leg 3 *transition* accepts; the join loads the world). An arena without a boss is a
  quiet empty map (`density: dead`) and is evicted again when empty and not held. ~30 s before
  the warning (`ARENA_PRELOAD_MS`) the manager also loads the picked boss's arena through the
  server's `ensureWorld` hook (async, never blocks a tick). The warning waits up to 20 s for it;
  a spawn that still finds it missing retries every 3 s inside the same 20 s, then falls back to a
  region.
* The world is **held from eviction** while the event is planned (warning) or active, and for
  **5 minutes after the boss is slain** (`ARENA_LOOT_GRACE_MS`) so the top damagers can return
  for their reserved loot. A timeout/despawn gives no grace. After that normal eviction applies
  (also swept every 10 s, since nobody closing a socket would trigger it).
* The return portal (arena → hub) is never touched.

## The universal portal

Never sealed. When a player steps on the hub pad, the server's portal tick
(`bossArenaWorlds.universalGate()`, applied in `server.js`) resolves the destination **at that
moment**, ignoring the row's placeholder:

1. a boss is planned/active, or its post-kill window is open → **its** arena
   (`WorldBossManager.arenaDestination()`, mode `active` / `next` while only warned);
2. else the **next** boss picked for this cycle → its arena (mode `next`);
3. else (no catalog yet) the first arena of the table, `Boss Arena: Glacius` (mode `default`).

The arena's id comes from the loaded worlds, else from a cache of the `worlds` table primed at
start-up and refreshed on a miss; on a miss the player is nudged off the pad with "The arena gate
is warming up; step in again in a moment." instead of being sent to the wrong arena.
The notice on stepping through is `Entering Boss Arena: <arena>`, followed by
`(<boss> is fighting there)` when a boss is active, or `No boss is active right now; <boss> is
next.` / `… and none is planned yet.` otherwise. The pad's landmark reads "Boss Arena" (never a
single boss's name; `landmarks.js portalLabel`).

## Status frames

`getStatus()` and the slim per-world status carry `dedicated`, `arenaWorldId`, `arenaWorldName`,
`arenaOpen` (an event is live there / in its loot window), and `nextBossName`,
`nextArenaWorldName`, `nextArenaWorldId` (where the always-open portal leads right now; the id is
null while the world is not known to the server). Admin tools and the board's summon load the
boss's arena world before spawning into it.
