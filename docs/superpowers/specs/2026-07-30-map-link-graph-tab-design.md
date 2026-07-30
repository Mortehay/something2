# Map-Link Graph Tab — Design

**Status:** draft for review (from brainstorming, 2026-07-30)

**Sub-project B of 2.** Sub-project A (biome data model) merged to main as `5f8abc9`;
this spec depends on it only for biome colours. This is the second half of the
brainstorm that produced [[biome-data-model]], deferred by the user's
"biome-first, then graph" decision.

## Problem / context

World-to-world links are edited today as four dropdowns per world in
`frontend/src/games/something2/MapsAdmin.jsx` — N/E/S/W, each listing every other
bounded world. That surface shows one world at a time and never shows the shape of
the graph, so the only way to answer "what connects to what" is to open every world
in turn and reconstruct it by hand.

Three verified facts constrain any fix more than the request does:

- **Links are bidirectional by construction.** `setLink`
  (`backend/src/services/mapLinks.js:15-21`) writes `(from, edge, to)` *and*
  `(to, oppositeEdge(edge), from)`. One logical link is two rows, so it is **one
  line** in a diagram, not two arrows. `clearLink` deletes both sides the same way.
- **Every world has at most four links.** `map_links` has a unique constraint on
  `(from_world_id, edge)` and a `CHECK edge IN ('N','E','S','W')`
  (`backend/migrations/1714440028000_create_map_links.js:7,11`). Each node has
  exactly four compass ports.
- **Only bounded worlds can be linked.** `POST /api/worlds/:id/links` rejects
  unbounded worlds on both sides (`backend/src/index.js:1895-1897`). **4 of the 17
  live worlds are bounded**; the other 13 can never be linked — and `MapsAdmin`
  filters to bounded worlds, so those 13 are invisible everywhere in the admin today.

And one fact that rules out the obvious design: **the live topology is spatially
contradictory.** All four of `BoundedArena`'s edges point at `test2`, and all four
of `test2`'s point back — `test2` is simultaneously north, east, south and west of
`BoundedArena`. A strict grid/lattice layout cannot draw the existing data, so
position must not be the source of truth for links.

## Goal

A new admin tab that shows the world graph as nodes and links, lets an admin create,
retarget and remove links directly on it, and flags where the drawing contradicts the
compass semantics — without changing the existing Maps editor.

## Key facts (verified)

- `GET /api/worlds` (`index.js:1424`) is public and does `SELECT *`, so new columns
  flow to clients automatically. `GET /api/worlds/:id/links` (`index.js:1706`) is
  public too. A read endpoint combining them exposes nothing new.
- `POST /api/worlds/:id/links` (`index.js:1884`) and
  `DELETE /api/worlds/:id/links/:edge` (`index.js:1909`) both call `invalidateWorld`
  on **both** worlds, so a link edit wipes cached terrain for two worlds and can
  report a connected player.
- The live-world warning plumbing already exists and is tested:
  `frontend/src/games/something2/liveWarning.js` exports `liveWarningFromBody`,
  `liveWarningFromHeader` and `LIVE_WARNING_TOAST_OPTS`. POST carries `liveWarning`
  in its JSON body; DELETE replies 204 and signals via the `X-Live-World-Pending`
  header, which CORS now exposes (`b1bed7a`).
- `useBiomes()` (`frontend/src/games/something2/useBiomes.js`) already supplies
  `{ id, name, color, ... }` per biome; `worlds.biomes` is a jsonb array of biome
  names in banding order.
- Admin tabs are a flat `activeTab` switch in `Something2.jsx` (~647-677 for the
  buttons, ~844-848 for the render); each tab is one component.
- Frontend is React **19.2.5**, Vite 8, vitest 3, styled-components. vitest runs in
  plain Node — no jsdom/RTL — so component bodies are not a practical test surface;
  pure helpers are (the `biomeForm.js` / `itemTypeForm.js` / `liveWarning.js` pattern).
- `react-cytoscapejs@2.0.0` declares `react: >=15.0.0`, so it is React-19 compatible.
  `cytoscape@3.34.0`, `cytoscape-edgehandles@4.0.1` (peer: `cytoscape ^3.2.0`, no
  React peer).

## Architecture

### 1. The tab

A new admin-gated **World Map** tab in `Something2.jsx`, component
`MapGraphAdmin.jsx`. **`MapsAdmin.jsx` is not modified.** The two tabs are
independent editors over the same `map_links` rows; each refetches on focus, and
neither owns the data.

### 2. Schema + endpoints

Two nullable columns on `worlds`:

| column | type | meaning |
|---|---|---|
| `graph_x` | double precision, null | canvas x for this world's node; null = never positioned |
| `graph_y` | double precision, null | canvas y |

Migration `1714440044000_world_graph_positions.js` (the highest existing migration is
`1714440043000`). `up` adds two nullable columns — no default, no backfill, no table
rewrite, and nothing reads them until an admin drags a node. `down` drops them.
Neither direction touches `world_chunks`: positions have no effect on generation.

**`GET /api/world-graph`** (public, matching the two endpoints it composes) returns
one consistent snapshot:

```json
{
  "worlds": [{ "id", "name", "width", "height", "is_entry", "biomes", "graph_x", "graph_y" }],
  "links":  [{ "from_world_id", "edge", "to_world_id" }]
}
```

One request instead of 1 + N (18 for the current 17 worlds), and a single snapshot
avoids a torn read where a world is deleted between calls. `links` returns **all**
rows, both directions — the client collapses each mirrored pair into one line
(§5), because detecting a *missing* mirror is one of the lint checks and that is
impossible if the server pre-collapses them.

**`PUT /api/worlds/:id/graph-position`** (adminGuard) with `{ x, y }` updates only
those two columns. `PUT` rather than `PATCH` because the codebase uses no `PATCH`
anywhere, and a position is replaced whole rather than merged.

This is deliberately **not** folded into `PUT /api/worlds/:id`. That route deletes
`world_chunks`, clears the preview and overview caches and evicts or warns live
players when biomes or bounds change. Dragging a node must not be able to reach that
code path even by accident. The endpoint issues a single `UPDATE worlds SET graph_x,
graph_y` and nothing else, and a test asserts no `DELETE FROM world_chunks` occurs —
the same assertion style the biome work used.

Non-finite or missing `x`/`y` are rejected with 400 rather than coerced.

### 3. Rendering

Cytoscape with the `preset` layout, positions fed from `graph_x`/`graph_y`.

- **Linkable (bounded) worlds** are nodes on the canvas. Neutral fill so the label
  stays readable, wearing a **segmented ring**: one arc per biome in the world's
  declared banding order, coloured from `biomes.color`. No biomes = a single grey
  ring.

  Cytoscape's built-in `pie` style is deliberately **not** used: it fills the node
  body, which would put colour behind the label rather than around it. The ring is
  instead a generated SVG donut applied as `background-image` via a data URI, from a
  pure `biomeRingSvg(colors) -> string` helper — which keeps the arc geometry
  unit-testable and the node centre neutral.
- The entry world is marked (it already carries `is_entry`).
- **Unbounded worlds never reach the canvas.** They cannot hold an edge, so they sit
  in a dimmed side tray listing name and the reason ("needs width and height to
  link"). This is the first place in the admin those 13 worlds are visible at all.
- Edges are undirected lines labelled with the compass pair they occupy
  (`E↔W`, `N↔S`).

### 4. Link editing

`cytoscape-edgehandles` provides drag-from-node-to-node. On drop, the compass edge is
**inferred from the drag geometry**: with `dx`/`dy` between the two node centres,
`|dx| > |dy|` → `E` (dx > 0) or `W`, else `S` (dy > 0) or `N`. Screen y grows
downward, so "below" is `S`. The inference is a pure function and is unit-tested,
including the exact-tie case (`|dx| === |dy|`, resolved to the horizontal axis).

Nothing is written on drop. A confirmation popover shows the inferred edge with an
override dropdown, and only then issues `POST /api/worlds/:from/links`.

Two hazards the popover must handle, both of which the current dropdown UI also has
but which a drag gesture makes far easier to trigger:

- **Silent overwrite.** `setLink` is `ON CONFLICT (from_world_id, edge) DO UPDATE`,
  so linking `A.E→B` when `A.E→C` already exists **destroys A↔C and its mirror with
  no warning**. The same applies to the target's opposing edge. The popover must
  name every link that is about to be replaced — on both sides — and require explicit
  confirmation. Computing that set is pure and testable.
- **Retargeting is not atomic.** There is no move/retarget API; changing which edge a
  link uses is `DELETE` then `POST`. If the POST fails, the worlds are left
  unlinked. The UI presents it as one action but must report the partial failure
  honestly rather than showing a success toast, and must refetch so the canvas shows
  the real state.

Removing a link: select an edge and delete it, issuing
`DELETE /api/worlds/:from/links/:edge`.

### 5. Consistency lint

`mapGraphLint.js` — a pure function over `(worlds, links, positions)` returning a list
of warnings. **Warnings only, never blocking**: the current all-four-edges
`BoundedArena↔test2` topology is legal, reachable through the existing UI, and must
stay editable.

| check | why it matters |
|---|---|
| drawn direction contradicts the compass edge (`A.E→B` but B is drawn left of A) | the picture is lying about in-game travel |
| two links leave one world in the same drawn direction | ambiguous, unreadable layout |
| a link row with no mirror | one-way travel; the API never creates this, but the schema permits it |
| a world with `graph_x`/`graph_y` null | it was auto-placed, not positioned by anyone |

Mirror-pair collapsing lives here too: `(A,E,B)` and `(B,W,A)` become one line;
an unpaired row becomes a line *plus* a warning.

### 6. Initial layout

Worlds with null positions are placed **client-side**: walk the links breadth-first
from the entry world, stepping one grid cell per compass edge; anything unreachable
or contradictory is dropped into a row beneath the walked component. Deterministic,
pure, and unit-testable.

**Computed positions are not persisted.** Opening a tab must not write to the
database. `graph_x`/`graph_y` stay null until the admin actually drags something, at
which point that node's position is saved (debounced).

### 7. Live-world warnings

Both link routes invalidate two worlds and can report a connected player. The tab
reuses `liveWarning.js`: `liveWarningFromBody` for the POST response,
`liveWarningFromHeader` for the DELETE's 204 + `X-Live-World-Pending`. Because a link
edit affects **two** worlds, a single warning may be about either — the toast should
say so rather than implying only the dragged world is stale.

## Data flow

```
GET /api/world-graph ──► { worlds, links }        useBiomes() ──► colours
          │                                            │
          └──────────────┬─────────────────────────────┘
                         ▼
        mapGraphLayout.js  (pure: seed positions, infer compass from dx/dy)
        mapGraphLint.js    (pure: collapse mirrors, produce warnings)
                         │
                         ▼
                 MapGraphAdmin.jsx  ──►  Cytoscape (preset layout + edgehandles)
                         │
      ┌──────────────────┼─────────────────────────┐
      ▼                  ▼                         ▼
 drag node          drag A→B (confirm)        select edge → delete
 PUT graph-         POST /worlds/:id/links    DELETE /worlds/:id/links/:edge
 position           (invalidates BOTH)        (invalidates BOTH, 204 + header)
 (no invalidation)
```

## Testing

- **Pure helpers (the real test surface):** compass inference from `dx`/`dy`
  including the tie case and the screen-y-down convention; BFS seeding determinism
  and its fallback row; mirror-pair collapsing; each lint check, and the
  overwrite-set computation (which links a proposed edge would destroy, on both sides);
  `biomeRingSvg` arc geometry for zero, one and several biomes.
- **`PUT graph-position`:** updates only the two columns; rejects non-finite input
  with 400; **asserts no `DELETE FROM world_chunks` and no cache clear occurs** — the
  regression that would make a node drag wipe terrain.
- **`GET /api/world-graph`:** returns both link directions unmodified; shape matches
  the contract; 17-world snapshot is a single query pair, not N+1.
- **Migration:** `up` adds two nullable columns and touches nothing else; `down` is a
  true inverse.
- **Browser (required gate):** the graph renders the real topology; a drag persists
  and survives reload; creating a link that would overwrite an existing one warns and
  names it; retarget failure is reported rather than silently swallowed; a link edit
  on a world with a connected player surfaces the live warning; the unbounded tray
  lists all 13 worlds; MapsAdmin still works and both tabs agree after an edit in
  either.

## Non-goals

- **Changing `MapsAdmin.jsx`** — explicit user constraint.
- **Auto-layout algorithms.** Positions are manual by decision, so Cytoscape's layout
  engines stay unused apart from `preset`.
- **Creating, renaming or deleting worlds** from this tab.
- **Editing links for unbounded worlds** — the API rejects them; the tray is
  informational.
- **Making the topology spatially consistent.** The lint reports contradictions; it
  never refuses or auto-corrects them.
- **A move/retarget API.** Retarget stays delete-then-create against the existing
  endpoints.

## Open items (confirm during planning)

1. **Tray scope.** The unbounded tray is read-only here. Offering "make this world
   bounded" inline would need width/height input and belongs to MapsAdmin; proposed:
   link to the Maps tab instead.
2. **Refetch policy between the two tabs.** Both edit `map_links`. Proposed: refetch
   on tab focus and after every mutation; no live push.

## Suggested slicing (for the plan)

- **A. Migration + `PUT graph-position`** — columns, endpoint, no-invalidation test.
- **B. `GET /api/world-graph`** — aggregate read + contract test.
- **C. Pure helpers** — `mapGraphLayout.js` (seed, compass inference) and
  `mapGraphLint.js` (collapse, warnings, overwrite set) with their unit tests.
- **D. Canvas** — Cytoscape mount, preset positions, `biomeRingSvg` node ring,
  unbounded tray.
- **E. Editing** — edgehandles drag, confirm popover with the overwrite set, delete,
  retarget, position persistence, live-warning surfacing.
- **F. Tab wiring** — `Something2.jsx`.
- **G. Browser verification.**
