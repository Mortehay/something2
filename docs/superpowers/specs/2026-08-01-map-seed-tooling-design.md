# Map seed tooling & the map-planner skill

Date: 2026-08-01
Status: approved, ready for planning

## Problem

There is no way to seed, clear, or re-seed maps.

Every seed in this project lives inside a one-shot migration — `tile_types`
(`1714440002000`), `decoration_types` (`1714440042000`), `biomes`
(`1714440043000`) — so none of them can be re-run. Changing a starter biome
today means writing a new migration. There is no seed for *worlds* at all: every
world in the database was created by hand through the admin UI, which is why the
world list contains `test1`, `test2`, `test2 (2)`, `losTest2`…`losTest10`.

The only reset is `make nuke`, which also destroys MinIO sprites and the
sprite-gen model cache — far too blunt for "give me a fresh set of maps".

And maps are currently a flat, unstructured pile. There is no notion of an
adventure: no entry, no progression, no deliberate branching.

## The constraint that shapes everything

`map_links` (migration `1714440028000`) declares:

```
edge  CHECK (edge IN ('N','E','S','W'))
UNIQUE (from_world_id, edge)
```

and `setLink` in `backend/src/services/mapLinks.js` writes the mirror edge
`(to, oppositeEdge(edge), from)` on every insert.

Three consequences:

1. **A world has at most four neighbours**, one per compass direction.
2. **Links are bidirectional**, always. There are no one-way passages.
3. **An adventure map must embed in a 2D grid.** It is not an arbitrary tree.
   Any topology that cannot be laid out on a grid without two links leaving the
   same world by the same edge is not representable.

The World Map admin tab already lints for this and reports drift like
"BoundedArena links N to test2 (2), but it is drawn E" and "BoundedArena has two
links drawn E" against the current hand-made worlds.

`N` is `-y`: `edgeOfDoorwayTile` in `backend/src/services/mapService.js:724`
defines `N` as `gRow === 0`, the top row. The spec's grid axes must match this or
every generated map arrives through the wrong doorway.

## Architecture

Two deliverables. The second drives the first, so the first ships first.

- **A — seed tooling:** a spec format, a validator, an idempotent applier, and
  Makefile targets.
- **B — the `map-planner` skill:** `.claude/skills/map-planner/SKILL.md`,
  encoding the topology rules and driving A.

### The core idea: grid coordinates make a map correct by construction

Every world in a spec carries `grid: [x, y]`. That single field does two jobs:

**It validates the links.** `edge` must equal the grid delta between the two
worlds:

| edge | delta      |
|------|------------|
| `N`  | `y - 1`    |
| `S`  | `y + 1`    |
| `E`  | `x + 1`    |
| `W`  | `x - 1`    |

A spec whose edges contradict its own layout is rejected before a single row is
written.

**It seeds `graph_x` / `graph_y`.** Those columns (migration `1714440044000`)
are the World Map tab's canvas coordinates. Deriving them from the same grid
means the drawn diagram agrees with the links by construction, so the
consistency warnings above **cannot** occur for a seeded map. This is the same
discipline as the chunked world's "seams match by construction".

### Spec format — `backend/seeds/maps/<name>.map.json`

```jsonc
{
  "name": "hub-vale",
  "topology": "hub",
  "worlds": [
    {
      "key": "hub",
      "name": "Vale Crossing",
      "grid": [0, 0],
      "seed": 4021,
      "width": 96, "height": 96, "chunk_size": 64,
      "biomes": ["Meadow"], "biome_cell": 32,
      "creature_count": 2,
      "allowed_creature_types": ["Slime"],
      "is_entry": true,
      "entry_spawn": { "x": 48, "y": 48 },
      "village": {
        "min_row": 30, "min_col": 30, "width": 20, "height": 20,
        "gate_edge": "S", "spawn_x": 48, "spawn_y": 52
      }
    }
  ],
  "links": [ { "from": "hub", "edge": "E", "to": "dunes" } ]
}
```

- `key` is spec-local and stable; `name` is the database's unique key. Links
  reference keys, so renaming a world cannot break them.
- `seed` is pinned. The same spec always yields the same terrain.
- `village` is optional and, when present, produces one row in `villages`.
- Field names match the `PUT /api/worlds/:id` body (`backend/src/index.js:1461`)
  so the applier and the admin UI cannot drift apart in meaning.

### Validation

A pure function over the parsed spec, run before any write. It rejects:

- duplicate `key`s, duplicate `name`s
- two worlds occupying the same grid cell
- a link whose `edge` disagrees with the grid delta
- a link between non-adjacent cells (delta magnitude ≠ 1)
- more than one link leaving the same world by the same edge
- zero or more than one `is_entry`
- a `biomes` entry absent from the `biomes` table
- an `allowed_creature_types` entry absent from `entity_types`
- any world unreachable from the entry

The four-spoke ceiling for hub topology needs no special rule: it falls out of
"one link per edge", which is `UNIQUE(from_world_id, edge)`.

Validation is deliberately separate from application so it can be unit-tested
without a database.

### Application

`backend/scripts/seed-map.js`, host-side, matching the existing
`make admin-password` → `node backend/scripts/set-admin-password.js` pattern.

Idempotent by `worlds.name`: upsert each world, then apply links through the
existing `setLink` (which already handles the mirror edge), then upsert villages.
Re-running an unchanged spec is a no-op. The whole apply runs in one transaction
— a spec that fails halfway must not leave a half-built map.

`is_entry` is exclusive in the database (`index.js:1542` clears the flag on every
other world), so the applier sets it last, after all worlds exist.

### Makefile targets

```
make clear-maps                 # destructive, typed confirmation
make seed-catalogs              # tile_types, biomes, decoration_types
make seed-map SPEC=hub-vale     # apply one spec, idempotent
make reseed-map SPEC=hub-vale   # clear-maps + seed-catalogs + seed-map
make list-maps                  # available specs, and what is in the database
```

`seed-catalogs` **upserts by name; it never deletes.** A tile type or biome you
added by hand in the admin UI survives it. This matters because the admin UI is
the intended way to author catalog entries — the seed files are a floor, not a
replacement. `seed-map` omitting `SPEC` is an error, not a "seed everything".

Three example specs ship, one per topology — these are the requested variants:

| Spec | Topology | Shape |
|---|---|---|
| `spine-descent` | spine | critical path entry→end, with opt-in dead-end branches |
| `hub-vale` | hub | central village hub, up to four themed spokes |
| `loop-catacombs` | loop | branches that rejoin; several routes to the end |

**`clear-maps` destroys more than maps.** Cascading from `worlds` it removes
`world_chunks`, `world_creatures`, `world_items`, `world_players`, `map_links`,
`villages`, `merchant_stock` — and **`player_binds`**, every player's respawn
point. Accounts, `player_items` and `player_equipment` survive, as do all
catalogs (`tile_types`, `biomes`, `entity_types`, `item_types`,
`decoration_types`, `vfx_effects`) — `clear-maps` never touches them. The
confirmation prompt must name `player_binds` explicitly; a developer who reads
"clear maps" will not otherwise expect players to lose their bind.

### Catalog seeds

`biomes` and `decoration_types` already export their data
(`exports.STARTER_BIOMES`, `exports.NEW_DECORATIONS`), and
`backend/tests/biomes_seed.test.js:3` already imports `STARTER_BIOMES` **from the
migration** — evidence that duplicating this data is a known hazard. So: move the
arrays to `backend/seeds/data/{biomes,decorationTypes}.js` and have both the
migration and the new seeder import them. One source of truth, the existing test
keeps working with only its import path changed, and no migration behaviour
changes (migrations only ever run once).

`tile_types` cannot get the same treatment cleanly: its seed data is raw SQL
inside `1714440002000_create_tile_types.js`, and *further* tiles are inserted by
`1714440027000_bounded_worlds.js` (`map_wall`, `map_doorway`) and
`1714440029000_villages_and_binds.js` (`wooden_wall`, `village_gate`) — three
migrations, no exported constant. Consolidate them into one
`backend/seeds/data/tileTypes.js` which becomes the authoritative source going
forward, leave the three migrations untouched, and pin the relationship with a
test asserting the seed file is a **superset** of every tile name those
migrations insert. The seeder upserts by name, so it wins on a fresh database.

### The skill

`.claude/skills/map-planner/SKILL.md`, triggered by "plan a map", "new adventure
map", or `/map-planner`. It carries:

- the grid-embedding rule and **why** — the four-edge cap, the bidirectional
  mirror, and the World Map lint
- the three topologies, their shapes, and their limits
- difficulty pacing: `creature_count` and `allowed_creature_types` escalate with
  distance from the entry
- biome coherence: contiguous regions, not scattered per-world picks
- village placement: hub topology needs one in the hub, because it is the bind
  point; spine topology wants one near the entry
- a hard sequence: **write the spec → run the validator → `make seed-map`**.
  Never hand-edit the database, and never apply an unvalidated spec.

## Testing

Backend tests run under `node:test` (`node --test`), not vitest.

- **Validator** — pure, no database. A valid fixture per topology that must pass,
  and deliberately broken fixtures that must each fail for the stated reason:
  edge contradicting the grid, two worlds in one cell, a five-spoke hub, an
  orphaned branch, zero entries, two entries, a link between non-adjacent cells,
  an unknown biome name.
- **Applier idempotency** — apply a spec twice against a real database and assert
  the resulting rows are identical, including link rows (the mirror edge makes
  double-application a genuine risk).
- **Transaction rollback** — apply a spec that fails partway and assert no
  partial map remains.
- **Catalog superset** — every tile name inserted by the three tile-seeding
  migrations appears in `backend/seeds/data/tileTypes.js`.
- **Browser** — seed each of the three example specs, open the World Map tab and
  confirm zero consistency warnings, then walk through one doorway transition to
  confirm arrival geometry is correct in a generated map.

## Out of scope

- Pre-generating terrain. Chunks are generated lazily from `worlds.seed`;
  seeding writes only world, link and village rows.
- A map-editing UI. The World Map tab stays a viewer.
- Migrating the existing hand-made worlds (`test1`, `losTest*`, …) into specs.
  `clear-maps` deletes them; nothing converts them.
- One-way passages, or more than four neighbours. Both need a schema change.
