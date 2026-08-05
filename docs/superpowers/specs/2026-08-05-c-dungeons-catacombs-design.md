# Dungeons and catacombs — design

Date: 2026-08-05
Status: approved, ready for planning

Sub-project C of the progression/dungeons/loot epic
(`docs/superpowers/specs/2026-08-03-progression-dungeons-loot-design.md`).
Plane: SOMET-243 (child of SOMET-240). A1 (creature levels, `934cc01`) and
A2 (player progression, `2c2cfa0`) are both merged to `main`.

## The request

An entrance somewhere on the map, sometimes guarded by a strong creature or a
pack of them, leading down into several dungeon levels of increasing
difficulty.

## Why this needed its own design, not just a task list

`map_links` cannot express a dungeon entrance as it stands. It is
`CHECK (edge IN ('N','E','S','W'))` with `UNIQUE(from_world_id, edge)`:
worlds connect edge-to-edge, at most four neighbours each, and the map-seed
tooling (`14876c4`) depends on exactly that four-edge model to embed every
world in a 2D grid and derive the World Map tab's `graph_x`/`graph_y`. A
dungeon entrance is a point *inside* a world at a tile coordinate, and its
levels stack downward rather than sideways — neither fits a compass edge, and
a dungeon level must not be forced into the overworld's grid-embedding rule.

## Decisions taken

| Question | Decision |
|---|---|
| Level origin | Hand-authored, same mechanism as overworld worlds (spec-seeded) |
| Instancing | Shared, like every world today — no per-player copies |
| Topology | Branching allowed — a level may portal to more than one next level |
| Portal model | Extend `map_links` with a `PORTAL` edge, not a new table |
| World Map visibility | Shown, as an off-grid cluster per entrance |
| Entrance guards | Structural spawn, same mechanism as village guards |
| Guard blocking | Portals gate on guard liveness — this is new: no prior blocking mechanic exists in this codebase |
| Blocked feedback | Message plus knockback, via direct position reassignment (respawn's existing mechanism), not through `resolveMove` |

## Data model

### `map_links`: the `PORTAL` edge

```sql
ALTER TABLE map_links
  ADD COLUMN from_x integer,
  ADD COLUMN from_y integer,
  ADD COLUMN to_x   integer,
  ADD COLUMN to_y   integer;

ALTER TABLE map_links DROP CONSTRAINT map_links_edge_check;
ALTER TABLE map_links ADD CONSTRAINT map_links_edge_check
  CHECK (edge IN ('N','E','S','W','PORTAL'));

-- Compass rows: from_x/from_y/to_x/to_y stay NULL, exactly as today.
-- Portal rows: all four are required.
ALTER TABLE map_links ADD CONSTRAINT map_links_portal_coords_check
  CHECK (
    (edge = 'PORTAL' AND from_x IS NOT NULL AND from_y IS NOT NULL
                     AND to_x   IS NOT NULL AND to_y   IS NOT NULL)
    OR
    (edge != 'PORTAL' AND from_x IS NULL AND from_y IS NULL
                      AND to_x   IS NULL AND to_y   IS NULL)
  );
```

**The `UNIQUE(from_world_id, edge)` constraint cannot survive branching** — one
world can now have many outgoing `PORTAL` rows. Reshaping it outright risks
the guarantee it gives compass edges today (at most one `N` per world), so it
splits into two partial unique indexes instead:

```sql
DROP INDEX ... ; -- the old combined unique constraint
CREATE UNIQUE INDEX map_links_compass_unique
  ON map_links (from_world_id, edge) WHERE edge != 'PORTAL';
CREATE UNIQUE INDEX map_links_portal_source_unique
  ON map_links (from_world_id, from_x, from_y) WHERE edge = 'PORTAL';
```

The first index is byte-for-byte the guarantee compass edges already have.
The second is the portal analogue: at most one destination wired to any given
source tile — you cannot wire two different rooms to the same staircase.

**Bidirectionality is two mirrored rows, not new logic.** `setLink` already
always writes a mirror row (`opposite(edge)`) so a compass link works both
ways from one call. A `PORTAL` link has no "opposite edge" to compute, but
the same *pattern* still applies: a two-way staircase is
`(from_world, from_x, from_y) -> (to_world, to_x, to_y)` plus its mirror,
`(to_world, to_x, to_y) -> (from_world, from_x, from_y)`. `setLink` gains a
portal-aware branch that writes both rows directly instead of computing
`opposite(edge)`.

**Arrival geometry is stored, not derived.** Compass links compute the
arrival point from the target world's width/height (`fetchLinks`'s join,
since you arrive along whichever edge you crossed). A portal's arrival tile
has no such relationship to the target world's shape, so `to_x`/`to_y` are
written directly onto the row at seed time.

### `world_creatures`: guard-blocks-portal linkage

```sql
ALTER TABLE world_creatures
  ADD COLUMN blocks_portal_id uuid REFERENCES map_links(id) ON DELETE SET NULL;
```

Nullable — only structural guards defending a specific portal set it, exactly
as `home_x`/`home_y` (A1) is only meaningful for guard-faction creatures.
`ON DELETE SET NULL` rather than CASCADE: deleting a `map_links` row (e.g. an
admin re-links a dungeon) should not delete the guard, just stop it blocking
anything.

## Level authoring

`mapSpec.js`'s `worlds[]` entries currently require `grid: [x, y]` — every
world in a spec must embed into the overworld's 2D plane or `validateMapSpec`
hard-rejects it. Dungeon-level worlds skip `grid` entirely; nothing to embed.
A world with no `grid` is valid **only if** it is reachable via at least one
`PORTAL` link, enforced by extending the existing entry-reachability BFS
(today walks only compass links) to also walk portal links. This is the same
validation the overworld already has — "every world must be reachable from
the single `is_entry` world" — just widened to a second edge kind.

`links[]` gains a portal variant:

```json
{ "kind": "portal", "from": "cellar-entrance", "from_x": 12, "from_y": 4,
  "to": "catacombs-1", "to_x": 5, "to_y": 30 }
```

Validated by target-world existence, not `EDGE_DELTA` grid-adjacency — a
portal can point anywhere, that's the entire reason it exists.

**Difficulty per level reuses A1's `level_band` unchanged.** No new
mechanism: a dungeon spec declares an increasing band per level
(`level_band: [3,5]` on level 1, `[8,11]` on level 3, and so on), same field,
same `CHECK (level_min >= 1 AND level_max >= level_min)`, same scaling code
creatures already go through.

## Guarded, blockable entrances

Guards are a **structural spawn**, generalizing `insertVillageGuards`
(`villages.js:29`) rather than inventing a second mechanism: a direct
`INSERT INTO world_creatures` with `faction='guard'`, not a random roll. Same
aggro/leash AI every other guard in the game already runs
(`authority/creatures.js`, guard-faction branch) — they engage hostiles
within their radius, they do not target players, and until now they have
never blocked anything.

**Blocking gates the portal's trigger, not the tile.** Compass-edge transfers
already work this way, just keyed differently: `planTransition`
(`server.js:38-46`) checks whether a player's tile is a *doorway* tile for
some edge (`edgeOfDoorwayTile`), looks that edge up in the world's `links`
map, and computes an arrival point. A portal needs a sibling function, not a
hook into that one — the trigger condition is coordinate equality
(`player tile == from_x, from_y`) rather than edge-doorway membership, so it
reads from its own coordinate-keyed map (portal links loaded alongside
`entry.links`) rather than sharing `planTransition`'s edge-keyed one. Same
tick-loop call site, same `cdUntil` cooldown pattern, new lookup key. That new
function gains one extra condition beyond the coordinate match: *and no
living creature has `blocks_portal_id` equal to this link's id*. The portal
unblocks the instant
the last such creature's hp reaches zero — there is no separate "pack
cleared" flag to maintain; it falls straight out of the query. This is a
deliberate choice to avoid touching the shared `resolveMove`/collision code
(`movement.js` ↔ `authority/collision.js`, already a documented two-copy
hazard in this repo) — walkability itself never changes, only whether
stepping onto the tile *does* anything.

**Feedback on a blocked attempt: a message, plus knockback.** No knockback
mechanic exists anywhere in this codebase today (checked — the one hit on
`grep -i knockback` is a defensive comment in `creatures.js` about guards
recovering from hypothetical displacement, not an implementation). Rather
than build a physics-based push through the movement system, knockback here
reuses the mechanism respawn already relies on: the authority directly
reassigns the player's `x`/`y` — a small fixed offset back from the portal
tile — the same server-authoritative "just set the position" move respawn
makes today, entirely outside `resolveMove`.

## World Map rendering

`mapGraphLayout.js`'s BFS walks only compass links today, embedding worlds
into a 2D grid. Portal-linked worlds get a **second, separate layout pass**:
for each entrance world (a grid-embedded world with an outgoing `PORTAL`
link), walk its portal-link subgraph and lay it out as its own small
off-grid cluster anchored just below/beside the entrance's grid cell —
depth-based vertical spacing (level 1 one row down, its children another row
down, siblings spread horizontally for branches). Mostly a frontend concern,
but `GET /api/world-graph` (`index.js:1657-1671`) explicitly enumerates
columns in its `links` query (`SELECT from_world_id, edge, to_world_id`) —
that needs the four new coordinate columns added to the select list, or the
new layout pass has nothing to key off. No other change to the route: the
response shape gains fields, it doesn't change shape.

## Testing

Same governing risk as A1/A2: assertions derived from the same constants as
the code. The two invariants worth literal-value coverage:

1. **The partial unique indexes hold under branching.** A spec (or a direct
   insert) attempting two `PORTAL` rows from the identical `(from_world_id,
   from_x, from_y)` must fail; two `PORTAL` rows from the *same world* at
   *different* coordinates must succeed — this is the case that would have
   failed under the old combined constraint.
2. **Blocking is exact.** A portal with a living `blocks_portal_id` guard
   does not fire; the same portal fires the tick after that guard's hp
   reaches zero; a portal with no linked guard is unaffected by unrelated
   guards elsewhere in the world (proves the linkage is the FK, not
   proximity).

Live-path coverage follows A2's pattern: boot the real `attachAuthority`
WebSocket server, walk a player onto a blocked portal, assert no world
transfer occurred and the knockback message was pushed; kill the guard;
walk onto the same portal again; assert the transfer now happens.

Frontend: `mapGraphLayout.js`'s new off-grid pass is a pure function, tested
the same way `seedPositions` already is — literal input link/world arrays in,
literal expected cluster coordinates out. No DOM, matching this project's
node-only vitest environment.

## Risks

- **This is the first blocking mechanic in the codebase.** Every other
  interaction (walls, guards, chests-to-come in B) either prevents movement
  via static tile walkability or does damage — nothing until now has made an
  action *conditionally* no-op based on live game state. The plan should
  treat the tick-loop gating check as its own carefully isolated unit, not
  bolted onto the existing portal-transfer code path without a seam.
- **Knockback's fixed offset can push a player into a wall or off a bounded
  world's edge** if placed carelessly relative to the portal tile's
  surroundings — the plan should specify the knockback direction (away from
  the portal, along the line from the guard's home position, or similar) and
  confirm it lands on a walkable tile before assigning it, falling back to
  "just don't move them" rather than teleporting into a wall.
- **Migration ordering across parallel branches**, same as every prior
  sub-project — this reserves `1714440060000`–`1714440069000` before work
  starts.
