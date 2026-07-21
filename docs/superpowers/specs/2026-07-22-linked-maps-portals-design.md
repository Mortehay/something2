# Linked Maps & Doorway Portals — Design

**Status:** Draft for review
**Date:** 2026-07-22
**Epic:** 2 of 2 (the other, queued, is "Villages & economy")

## Goal

Let an admin build a game world out of **bounded, linkable maps**: generate a map
of chosen size, rename/regenerate it, control how many creatures live on it, and
**link maps edge-to-edge** so a **doorway** appears in the boundary wall that
**teleports** the player to the linked map. Players enter the network at a
designated entry point (later, the first village).

## Architectural context (why this shape)

The codebase has **two parallel world systems** that share no tables, routes,
networking, or rendering:

- **Chunked `worlds`** — the **live, playable** system (Node authority at
  `backend/src/authority/server.js`, WS `/authority`, client
  `WorldAuthorityClient` + `Game.initChunked`). Chunks generate on demand; a
  world is effectively **infinite** (only an unloaded chunk reads as a wall).
- **Discrete `maps`** (`maps` + `map_entities` tables, `/api/maps/*`) — bounded
  grids, but **not playable on the live server**: their play path targets the
  **paused Go engine**. Today they are admin-only previews ("World Browser").

**Decision:** build on the live **`worlds`** system. A "map" becomes a **bounded,
linkable world** the authority already knows how to serve. Teleport reuses the
existing "connect a socket to one world with a spawn point" flow. The discrete
`maps` system and its "World Browser" UI are **deprecated** (see §8).

## Scope

In scope:
1. Bounded worlds: optional `width`×`height`, a non-walkable **boundary wall**,
   and **doorway** gaps on linked edges.
2. Doorway **portals** and the runtime **teleport** (reconnect to the linked
   world at the arrival doorway).
3. Per-map **creature control**: target count + allowed creature types, with
   re-roll and terrain regenerate.
4. A new admin **Maps** tab (generate / rename / regenerate / creatures / link /
   play-test), replacing the deprecated World Browser.
5. A **player-entry** hook: a map may be flagged as the entry with a spawn point;
   player-join spawns there instead of the infinite Overworld.

Non-goals (this epic):
- Villages, guards, gold, merchant (Epic 1).
- Removing the legacy `maps` table/routes (deprecate now, delete later).
- Making the entry a *village* specifically — Epic 2 provides the entry
  mechanism; Epic 1 points it at the first village.

## 1. Data model

Extend the live `worlds` system; add one link table. Exact names:

**`worlds` new columns** (migration; all nullable/defaulted so the existing
infinite Overworld is unchanged):
- `width int NULL` — bounded extent in tiles (NULL = unbounded).
- `height int NULL` — bounded extent in tiles (NULL = unbounded).
- `creature_count int NOT NULL DEFAULT 0` — target number of creatures for a
  bounded map (ignored when `width`/`height` are NULL; the Overworld keeps its
  per-chunk roll).
- `allowed_creature_types jsonb NOT NULL DEFAULT '[]'` — array of
  `entity_types.name` strings a bounded map may spawn.
- `is_entry boolean NOT NULL DEFAULT false` — at most one world flagged; the
  player-join spawn point.
- `entry_spawn jsonb NULL` — `{x, y}` world-pixel spawn used when `is_entry`.

**`map_links`** (new table, mirrors the `map_entities` FK+cascade style):
- `id uuid PK DEFAULT gen_random_uuid()`
- `from_world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE`
- `edge text NOT NULL CHECK (edge IN ('N','E','S','W'))`
- `to_world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE`
- `UNIQUE (from_world_id, edge)` — one neighbor per edge.

Linking is **bidirectional**: the admin "link A east ↔ B" action writes both
`(A, E, B)` and `(B, W, A)` so the doorways line up. Deleting either map cascades
its link rows.

## 2. Bounded map: boundary walls + doorways

- A bounded world only materializes chunks that intersect `[0,width)×[0,height)`
  (in tiles). Outside is never generated → already non-walkable.
- At chunk generation, tiles on the **outer ring** of the bounded rectangle are
  stamped with a **non-walkable wall tile type** (reuses the existing tile-based
  collision — `ServerMap.isWalkable` reads `tile_types.walkable`; no new collision
  system). A dedicated `map_wall` tile type is seeded (walkable=false), and a
  `map_doorway` tile type is seeded (walkable=true) for the gaps.
- For each **linked** edge, a **doorway** is stamped: a run of `DOORWAY_TILES = 3`
  walkable `map_doorway` tiles centered on that edge, replacing the wall there.
  Unlinked edges remain solid wall.
- Wall/doorway stamping is a **pure function** over `(world bounds, links)` applied
  in the chunk generator (same overlay mechanism paths already use in
  `mapService.generateRegion`). It is deterministic and needs no new client
  channel — walls and doorways are ordinary tiles in the streamed chunk grid, so
  the client renders and collides with them for free.

## 3. Teleport flow

The authority ties one socket to one `worldId`, and `Game.initChunked` accepts a
spawn point — so teleport = **reconnect to the linked world at the arrival
doorway**:

1. **Detect (authority):** in the per-tick move/resolve step, if a player's tile
   is a `map_doorway` tile, resolve which edge it sits on, look up the
   `map_links` row `(currentWorld, edge)`, and compute the **arrival point** = just
   inside the linked world's opposite-edge doorway (E↔W, N↔S), offset one tile
   inward so the player doesn't immediately re-trigger.
2. **Instruct (authority→client):** send a new `transition` frame
   `{ toWorldId, arriveX, arriveY }`.
3. **Reconnect (client):** on `transition`, tear down the current
   `WorldAuthorityClient` and re-`initChunked({ worldId: toWorldId, spawnX,
   spawnY, ... })` — the exact path used for normal entry, so no menu bounce and
   no new rendering code.
4. **Cooldown:** a short per-player **re-entry cooldown** (~1.5 s) suppresses
   doorway re-triggering on arrival and prevents bounce loops.

Edge cases: a doorway whose `map_links` row is missing is inert (stays a harmless
walkable gap); a link to a deleted world is impossible (cascade removes the row).

## 4. Creatures: count + allowed types

- Bounded maps **do not** use the fixed `CREATURE_SPAWN_CHANCE = 0.01` per-chunk
  roll. Instead, a **placement pass** spawns `creature_count` creatures of random
  types drawn from `allowed_creature_types`, at random **in-bounds, walkable,
  non-doorway, non-wall** tiles, written to `world_creatures`. The infinite
  Overworld keeps its existing per-chunk roll unchanged.
- **Increase/decrease** = update `worlds.creature_count`.
- **Re-roll creatures** = delete this world's `world_creatures` rows and re-run the
  placement pass (terrain untouched).
- **Regenerate terrain** = re-run world generation with a new seed and overwrite
  the cached `world_chunks` for this world (creatures optionally re-rolled).
  Terrain-regenerate and creature-reroll are **separate admin actions** so a good
  map isn't lost by a creature tweak.
- Placement is a **pure function** `placeMapCreatures(bounds, links, count,
  allowedTypes, rngSeed) -> rows[]`, unit-tested independently.

## 5. Admin "Maps" tab

New `frontend/src/games/something2/MapsAdmin.jsx`, following the
`TileTypesAdmin.jsx` pattern (styled full-page panel, query/mutation hooks,
`react-hot-toast`). Wired as a new admin `TabButton` in `Something2.jsx` with a
color in `ADMIN_TAB_COLORS`, gated by `isAdmin`.

Capabilities:
- **List** bounded maps (name, size, creature count, entry flag, link summary).
- **Generate**: name + `width`×`height` (+ optional seed) → creates a bounded world.
- **Rename**: `PUT /api/worlds/:id` (new route — none exists today).
- **Regenerate terrain** / **Re-roll creatures**: two buttons.
- **Creatures**: count field (−/＋) + allowed-type checkboxes (from
  `entity_types` where `is_creature=true`).
- **Link editor**: for each of the 4 edges, a dropdown of other maps → creates the
  paired `map_links`; clearing it removes both rows.
- **Set as player entry** + pick spawn point.
- **Enter** to play-test (reuses `handleEnterChunkedWorld`).

New backend routes (inline `pg`, `adminGuard`, alongside the worlds block in
`backend/src/index.js`): `PUT /api/worlds/:id` (rename + bounds + creature config
+ entry flag), `POST /api/worlds/:id/regenerate`, `POST /api/worlds/:id/creatures`
(re-roll), link CRUD (`GET/POST/DELETE /api/worlds/:id/links`). New client hooks in
`useWorlds.js` (or a new `useMapsAdmin.js`).

## 6. Player entry

- `worlds.is_entry` marks the single entry map; `entry_spawn` is its spawn point.
- The client's auto-join (currently the infinite "Overworld",
  `Something2.jsx`) changes to: **if an entry world is flagged, join it at
  `entry_spawn`**; otherwise fall back to the current Overworld behavior
  (backward-compatible when nothing is flagged).
- **Epic 1 integration:** villages live inside bounded maps; the first village's
  spawn point becomes the `entry_spawn` of the entry map. Epic 2 ships the
  mechanism; Epic 1 points it at the village.

## 7. Testing strategy

- **Pure functions** (unit, like `mapService` tests): boundary-wall + doorway
  stamping given bounds+links; `placeMapCreatures` (count honored, all in-bounds &
  walkable & never in a doorway/wall, deterministic per seed).
- **Authority transition detection** (unit): player on a doorway tile with a link
  → correct `transition` frame with the mirrored arrival point; cooldown
  suppresses immediate re-trigger; missing link → no transition.
- **Routes** (like existing tile/world route tests, mock pool): rename, regenerate,
  creature re-roll, link create/delete writes both directions, entry flag.
- **Boundary collision**: a bounded world reports non-walkable outside bounds and
  at wall tiles; walkable at doorway tiles.
- **Browser pass** (per project norm): generate two maps, link them, walk through
  the doorway, confirm arrival at the opposite doorway and that creatures respect
  the count.

## 8. Deprecating the discrete `maps` / "World Browser"

- Remove the **World Browser** panel and its controls from `Something2.jsx`
  (the discrete-map list, MapPreview-for-maps, generate/entities buttons).
- Leave the `maps`/`map_entities` tables and `/api/maps/*` routes **in place but
  unused** (deprecated) — deleting them is a separate later cleanup to avoid scope
  creep and risk.
- The dead Go-engine play path (`Game.init` + `EngineClient`) is already unused by
  players; no change needed beyond removing the UI entry that reaches it.

## 9. Proposed slices (for the implementation plan)

1. **Bounded worlds** — `worlds` columns, `map_wall`/`map_doorway` tile types,
   boundary+doorway stamping in generation, in-bounds chunk limiting, collision &
   client rendering. Deliverable: a walled bounded world you can walk around
   (doorways are just walkable gaps yet).
2. **Maps admin tab + creature control** — new tab, rename/regenerate routes &
   hooks, creature count + allowed types + re-roll, deprecate World Browser.
   Deliverable: full admin management of bounded maps.
3. **Links & teleport** — `map_links`, link editor, authority doorway detection +
   `transition` frame + cooldown, client reconnect-teleport, entry-map join hook.
   Deliverable: walk through a doorway → arrive on the linked map.

## 10. Risks / open items

- **Chunk regeneration on terrain-regenerate:** `world_chunks` is a deterministic
  cache; regenerate must invalidate/overwrite this world's rows and force clients
  to refetch. Confirm the client refetch path on reconnect.
- **Entry-map singleton:** enforce "at most one `is_entry`" (clear the previous on
  set) to avoid ambiguity.
- **Bound vs chunk alignment:** `width`/`height` need not be chunk multiples;
  boundary stamping operates in tile space within partially-covered edge chunks.
- **Cross-epic seam:** the entry-as-village link is defined here but realized in
  Epic 1; keep `entry_spawn` generic (x/y) so villages just supply the point.
