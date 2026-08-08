# P5 — Map Content: Multi-Level Dungeons and New Surface Worlds

**Plane item:** SOMET-251 (Backlog)
**Umbrella:** `docs/superpowers/specs/2026-08-06-bestiary-program-design.md` — the 32 lines, 9
rungs, depth tiers/bands, and the 32-biome table are all fixed there. This spec instantiates
that structure into world content; it does not redesign it.
**Depends on:** P1 (SOMET-246, Done) — `populateWorld`, density tiers, one creature-population
path. P4 (SOMET-250, Done, merged to main) — all 288 creatures + the 4 retuned legacy creatures
exist and are seeded. Both dependencies are satisfied. P3 (SOMET-247, Done) — verified live: 32
biomes exist in the database.

---

## Goal

Author ~58 new worlds against today's 20: one continuous 48-level dungeon descent through all
14 underground and 8 abyssal lines, plus 10 new surface worlds covering the 5 new surface
biomes. This is the sub-project that finally gives the bestiary and the density/level-band
mechanism somewhere to live at scale, and the first real exercise of the `PORTAL` link type
(SOMET-243) and guarded entrances (`blocks_portal_id`) against real content.

Content only, generated programmatically (mirroring P4's line×rung→288-creatures pattern
instead of hand-typing 58 worlds). **No schema changes, no new migration** — `density`,
`level_band`, and `PORTAL` links all already exist; this is pure content on top of them.

---

## A pre-existing problem this spec must not make worse

The 20 worlds live today are exactly the 3 shipped example specs
(`spine-descent`/`hub-vale`/`loop-catacombs`, 8+5+7=20), each applied independently from its own
grid origin `[0,0]`. They **already collide** on the World Map: `Catacomb Threshold`, `Vale
Crossing`, and `Old Trailhead` all sit at `graph_x=0, graph_y=0` today (verified live,
2026-08-08). Fixing that collision is out of scope here — those are example/dev-only specs, not
part of this ticket's acceptance criteria — but P5 must not add a fourth overlapping cluster.
The grid layout below (see "Grid layout") picks coordinates that guarantee no new collision,
without needing to touch `seed-map.js` or `mapSpec.js`.

---

## Architecture: one generated spec, mirroring P4's generator pattern

A one-off script (`backend/scripts/dungeon/gen-p5-map-content.js`, run once, its *output*
committed) derives every world and link from three already-fixed inputs:

- **The umbrella's line table** — 14 underground lines + 8 abyssal lines (biome, primary
  element, depth tier), 5 new surface lines (biome, primary element, depth tier).
- **A per-dungeon assignment table** (below) — which lines/biomes belong to which of the 8
  dungeons, in depth-tier order.
- **The existing topology rules** from `.claude/skills/map-planner/SKILL.md` — spine/hub/loop
  shapes, the compass-grid embedding, `level_band`/`density` escalation-by-hop-distance, the
  validator at `backend/tests/map_spec_fixtures.test.js`.

Output is one file, `backend/seeds/maps/p5-descent.map.json`, in the exact shape the 3 existing
specs use (`name`, `topology`, `worlds[]`, `links[]`) — the generator produces a spec, not a
direct DB write, so it goes through the same `node --test tests/map_spec_fixtures.test.js` →
`make seed-map SPEC=p5-descent` workflow as any hand-authored spec, and a human can read the
generated JSON before it's applied.

### The 8-dungeon chain

22 underground/abyssal lines grouped into 8 dungeons, ordered by depth tier so the chain reads
as one continuous descent:

| # | dungeon | lines (biomes) | tier span |
|---|---|---|---|
| D1 | The Catacombs | Undead (Catacombs), Cave (Cavern) | I–II |
| D2 | The Underdeep | Fungal (Fungal Deep), Gloom (Gloomfen) | II |
| D3 | The Ossuary Depths | Bonelord (Ossuary), Drowned (Sunken Cistern) | II–III |
| D4 | The Emberhive | Ember (Emberdepths), Hive (Hive Warrens) | II–III |
| D5 | The Frozen Vaults | Rime (Frostvault), Blight (Blightworks), Construct (Deepvault) | II–III |
| D6 | The Crystal Foundry | Crystal (Crystal Hollows), Stoneborn (Sunken Foundry) | III |
| D7 | The Umbral Gate | Umbral (Umbral Warren), Demonic (Infernal Gate), Plague (Pestilent Deep) | III–IV |
| D8 | The Abyss | Void (Abyssal Rift), Chaos (Shattered Vault), Fallen (Fallen Sanctum), Nightmare (Dreaming Dark), Titan (Grave of Titans), Eldritch (The Maw) | IV |

D8 carries 6 lines instead of 2-3 — it's the terminal dungeon, the highest-tier content, and the
umbrella's own abyssal table has no natural sub-grouping the way underground does, so it reads
as one large "endgame" dungeon rather than being arbitrarily split.

Each dungeon is internally its own **spine, hub, or loop** of ~6 rooms (topology assigned
round-robin across the 8 so all three shapes get real coverage, not just spine), following
`map-planner`'s existing rules verbatim: dead-end branches off the critical path, a village in
the hub for hub-topology dungeons, the undirected-cycle check for loop-topology ones. A room's
`biomes: []` list draws 1-2 of its dungeon's assigned lines' biomes, same pattern as the 3
shipped examples (a room isn't always single-biome).

Dungeons chain **D1 → D2 → ... → D8** via a `PORTAL` link: the last room of dungeon *N*
portals into the first room of dungeon *N+1*. Within a dungeon, rooms use ordinary compass
(`N`/`E`/`S`/`W`) links exactly as `spine-descent`/`hub-vale`/`loop-catacombs` already do —
`PORTAL` is reserved for the 7 inter-dungeon jumps plus the one surface-to-D1 entrance, which is
exactly the "guarded entrance" use case `blocks_portal_id` exists for: each dungeon's entry room
gets a portal guard (a creature from that dungeon's own line roster) standing on the `PORTAL`'s
arrival tile, so descending past it requires clearing that guard first.

### Escalation across the whole chain, not per-dungeon

`level_band` and `density` escalate by **BFS hop-distance from the single entry, across the
entire connected graph** — same rule `map_spec_fixtures.test.js` already enforces for
`spine-descent`, just applied over ~48 hops instead of ~8. Concretely:

- `level_band` floor and ceiling both scale linearly with hop-distance from 1 (entry) to 50
  (deepest room of D8), clamped into each room's dungeon-tier band range from the umbrella table
  (e.g. a D1 room can't roll above tier I-II's range even if its raw hop-interpolated number
  would suggest otherwise — the tier table is the outer bound, hop-distance is the fine-grained
  ramp within it).
- `density` steps through `sparse → normal → dense → horde → swarm` in six roughly-even hop
  buckets across the chain, so D1 opens sparse/normal and D8's rooms are dense/horde/swarm,
  matching "this is where hordes actually get authored" from the umbrella.
- Branch rooms (dead-end spurs) get the **same** band/density as their attachment point's hop
  distance, not their own (a branch is a detour, not deeper content) — consistent with how
  `spine-descent`'s `cache`/`elite` branches off `pass` share `pass`'s general depth rather than
  escalating further.

This satisfies the validator's three checks (floor non-decreasing by hop, deepest ceiling ≥ 2×
entry's, most worlds declare a band) by construction, since it's the same rule the validator
already checks against `spine-descent` scaled up, not a new rule invented for this spec.

### 10 new surface worlds

The 5 new surface lines/biomes (Highlands, Verdant Jungle, Storm Coast, Sunken Ruins, Ashfields)
get 2 standalone worlds each — not chained to each other or to the dungeon, reached the same way
today's 5 surface worlds are. Each pair shares the biome but varies `density`/`level_band`
lightly (one slightly harder than the other) so a biome isn't flatly uniform. `allowed_creature_types`
draws from that biome's own line at the Swarm/Skirmisher/Line rungs — surface worlds are
shallow-tier content, not places to meet a Champion or Apex.

### Grid layout (collision avoidance)

The 3 existing specs occupy grid cells roughly in `x: [-1, 4], y: [-1, 1]`. P5's spec places:

- The dungeon chain starting at grid `[20, 0]`, running east (`+x`) through D1's rooms, each
  subsequent dungeon's local room-cluster offset further east by a fixed margin (e.g. `+8` cells
  per dungeon) so no two dungeons' local compass-grids overlap — `PORTAL` links don't require
  grid adjacency (they carry their own `from_x/from_y/to_x/to_y` tile coordinates, not a compass
  edge), so dungeons can sit in disjoint grid regions and still connect.
- The 10 surface worlds starting at grid `[20, 20]`, one row per biome, far enough south of the
  dungeon chain's `y` range to guarantee no overlap.

`x >= 20` for every new world guarantees zero collision with the existing `x: [-1,4]` cluster,
with generous headroom.

### `is_entry` handling

`mapSpec.js` requires exactly one `is_entry: true` world **per spec file** — this is a hard
validator rule, and `seed-map.js` applies it globally (`UPDATE worlds SET is_entry = false WHERE
is_entry = true AND id <> $1`), so applying *any* valid spec flips the database's one global
spawn point. P5 must not silently move where new players spawn onto brand-new, unfinished-art
content.

Handling: the generated spec declares `is_entry: true` on D1's first room (the natural "front
door" of the new content, needed to satisfy the validator) as part of the spec file itself. The
seed procedure (Task in the implementation plan) then immediately re-flags the world that was
`is_entry` **before** this apply back to `is_entry: true` via the existing admin API
(`PUT /api/worlds/:id`) as an explicit, separate post-seed step — not left to chance, and
recorded in the seeding task's evidence. This is a one-line correction, not a design compromise:
the spec is still valid on its own terms, and the live game's spawn point is explicitly restored
afterward.

### World Map legibility at ~78 nodes

The ticket's own open question: whether the graph tab stays legible at this scale, since the
off-grid portal-cluster layout was only ever verified against 8 dungeon worlds and only at the
unit level. This spec does not change the graph rendering — `GRID_SPACING`, the Cytoscape layout,
and the graph tab itself are all out of scope here (P5 is content, not a graph-rendering
change). Instead this is an explicit **acceptance criterion**: after seeding, open the World Map
tab in a real browser and confirm the ~78 nodes render without pathological overlap or an
unusable layout. If it turns out to be illegible, that becomes its own follow-up ticket (a graph
tab UI defect) rather than something this content spec tries to preseed a fix for blind.

---

## Testing

- `node --test tests/map_spec_fixtures.test.js` — the existing validator, unmodified, must pass
  against the generated `p5-descent.map.json` exactly as it does the 3 existing specs (this is
  the primary correctness gate: valid grid embedding, valid topology shape, valid escalation,
  exactly one global entry per spec, no `creature_count` field, biome/creature names all real).
- A new unit test file for the generator itself (`backend/tests/p5_map_gen.test.js`, mirroring
  `bestiary_derive.test.js`'s pattern from P4) covering the escalation formula in isolation:
  hop-distance → level_band/density mapping never decreases, branch rooms inherit their
  attachment point's depth, dungeon-tier clamping is respected at both ends of a tier's range.
- Human-gated live seed step (same posture as P4 Task 7): `make seed-map SPEC=p5-descent`
  against the shared dev database, run only with explicit user go-ahead, followed by the
  `is_entry` restoration step above and a browser check of the World Map tab.

## Acceptance criteria

- [ ] `backend/seeds/maps/p5-descent.map.json` exists, generated (not hand-typed), and passes
      `map_spec_fixtures.test.js` unmodified.
- [ ] 8 dungeons, ~48 rooms total, chained D1→D8 via `PORTAL` links with a guard on each
      inter-dungeon entrance.
- [ ] 10 new surface worlds, 2 per new surface biome, standalone.
- [ ] `level_band`/`density` escalate monotonically by hop-distance across the whole 48-room
      chain (not reset per dungeon), clamped within each room's dungeon-tier range.
- [ ] Zero grid collision with the 3 existing example specs.
- [ ] The live game's pre-existing spawn point is explicitly restored after seeding (not
      silently left on new content).
- [ ] Live-seeded against the shared dev database (human-gated), and the World Map tab verified
      legible in a real browser at the new scale.
- [ ] No new migration, no schema change.

## Risks

**Placeholder art.** Every new world's creatures/tiles render as flat color boxes until sprite
generation runs (same standing risk as P3/P4, not new here).

**48-hop escalation is a bigger surface than the validator has ever been exercised against**
(previously max 8 hops, `spine-descent`). The generator unit tests above are what give
confidence the formula holds at this scale before the live seed step, rather than discovering a
validator edge case only after `make seed-map` aborts mid-command.

**The World Map graph tab has never been checked at anywhere near 78 nodes.** Flagged explicitly
above as an acceptance criterion rather than assumed away.
