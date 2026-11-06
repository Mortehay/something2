# World boss arenas

Each world boss fights in its **own small world**, reached by a portal from the Vale Crossing
hub. The portal works only while that boss is active. No level restriction.

| Boss | Element | World | Biome |
| --- | --- | --- | --- |
| Glacius, the Frost Leviathan | ice | `Boss Arena: Glacius` | Frostvault |
| Ignis, the Magma Colossus | fire | `Boss Arena: Ignis` | Emberdepths |
| Abyssor, the Voidreaver | arcane | `Boss Arena: Abyssor` | Abyssal Rift |
| Gorgon, the Thunder Titan | lightning | `Boss Arena: Gorgon` | Storm Coast |

Gorgon keeps its Spire floor-60 role; this is only its world-boss arena.

Code: `backend/src/authority/bossArenaWorlds.js` (the one boss → arena table, matched by name,
then by element), `worldBoss.js` (planning, loading, holding), `bossArena.js` (centre),
`server.js` (portal gate, eviction). Spec generator: `backend/scripts/gen-boss-arenas-spec.js`
(`node scripts/gen-boss-arenas-spec.js --check` verifies the committed JSON). Tests:
`backend/tests/boss_arena_worlds.test.js`.

## The maps

* 64×64 tiles (6400 px), chunk 32, no wandering creatures (`density: dead`, empty allowlist).
* Whole arena disk (radius 700 px around the centre 3200,3200) and the walk from the return
  portal are `road_stone` (speed 1.2, the fastest tile), painted as authored `roads`.
  The boss stands at the centre (`findArena` source `dedicated`, radius 450).
* Entry spawn at tile (32,16); return portal at tile (32,14), to `@Vale Crossing`.
* Hub side: four pads in a tight group on `road_stone` spurs just east of the village gate
  (≈280–450 px): tiles (44,51) Glacius, (44,53) Ignis, (48,51) Abyssor, (48,53) Gorgon. The
  spurs live in `vale-region.map.json` (`vale_hub` roads), because that is the hub's own spec.

## Operator steps

Order: run the migrations first (`1714440870000`, `1714440871000`, `1714440872000` — the world boss state and
schedule), then seed the maps. The code runs without the arenas (see fallback), so deploy order
between code and seed does not matter.

```
make seed-map SPEC=vale-region                 # hub spurs (only needed once, if not yet applied)
make seed-map SPEC=boss-arenas KEEP_ENTRY=1    # the four arena worlds + their portals
# Orange Pi:
make pi-seed-map SPEC=vale-region
make pi-seed-map SPEC=boss-arenas KEEP_ENTRY=1
```

`KEEP_ENTRY=1` matters: the validator needs exactly one `is_entry` world per spec, so
`arena_glacius` carries a placeholder flag; without `KEEP_ENTRY=1` the seeder would move the
game's real entry world to the Glacius arena. Do not forget it. (Seed `vale-region` with the
usual setting for that spec.)

I could not seed a live database from this work; nothing is applied until the steps above are run.

## Fallback

If an arena world is not in the database, the boss falls back to the old region logic (an
arena found/marked in a normal world), and the server logs once per arena:
`arena world "Boss Arena: X" is not loaded (or not seeded) … Seed the arenas with: make seed-map SPEC=boss-arenas`.

## Lifecycle

* Arena worlds are not kept in memory when empty. ~30 s before the warning (`ARENA_PRELOAD_MS`)
  the manager picks the boss and loads its arena through the server's `ensureWorld` hook
  (async, never blocks a tick). The warning waits up to 20 s for it; a spawn that still finds
  it missing retries every 3 s inside the same 20 s, then falls back to a region.
* The world is **held from eviction** while the event is planned (warning) or active, and for
  **5 minutes after the boss is slain** (`ARENA_LOOT_GRACE_MS`) so the top damagers can return
  for their reserved loot. A timeout/despawn gives no grace. After that normal eviction applies
  (also swept every 10 s, since nobody closing a socket would trigger it).
* The return portal (arena → hub) is never sealed.

## Portal gate

The server's portal tick refuses a hub portal into `Boss Arena: X` unless X's boss is active
there (or inside the 5-minute post-kill window). Refusal commits nothing: no teleport, no
cooldown spam (800 ms re-trigger), the player is nudged 60 px off the pad, and the notice
"The arena gate is sealed: <boss> has not risen." is throttled to once per 6 s per player.
The decision is the pure `portalGate()` in `bossArenaWorlds.js`.

## Status frames

`getStatus()` and the slim per-world status carry `dedicated`, `arenaWorldId`, `arenaWorldName`,
`arenaOpen`, so clients can say where to go and whether the gate is open. Admin tools and the
board's summon load the boss's arena world before spawning into it.
