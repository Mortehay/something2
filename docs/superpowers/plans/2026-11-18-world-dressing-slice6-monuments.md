# World dressing Slice 6 — Monuments (SOMET-776)

Spec: `docs/superpowers/specs/2026-11-17-world-dressing-design.md` § Slice 6.

## Shape

- **Catalog** `seeds/data/structureTypes.js` gains `MONUMENT_TYPES`
  (`{ name, sprite, biomes, size: [w, h], weight, poiChance }`). Seed set:
  collapsed_tower 3×3, broken_statue 2×2, wrecked_wagon 2×2,
  toppled_obelisk 2×2, giant_skull 3×3 (underground). Square footprints only:
  the model draws no particular orientation, so a 1×3 footprint could not
  match its sprite.
- **Sprites** are entity types (`MONUMENT_DECORATIONS` in
  `decorationTypes.js`, seeded by seed-catalogs): `walkable false`,
  `spawn_tiles []` so `loadDecorationDefs` never picks them, no biome flora.
- **Stamp** stored on `worlds.structures` next to ruins:
  `{ kind: 'monument', type, sprite, minRow, minCol, width, height, source: 'auto' }`.
  Every footprint cell blocks. Terrain under it is unchanged.
- **Delivery**: `generateChunkDecorations` emits, before the clump pass and
  even with no defs, one entry per footprint cell owned by the chunk: the
  FRONT cell (maxRow, maxCol) is the drawn anchor
  `{ name: sprite, row, col, blocking: true, monument: { w, h } }`, the rest
  `{ name: sprite, row, col, blocking: true, hidden: true }`. Main and ground
  passes skip footprint cells. Collision (authority overlay, ChunkedMap
  blocked set) needs no change except the authority's "no defs → no overlay"
  shortcut.
- **Seal check**: monument cells join the TERRAIN pass of `assertNavigable`.
  Each monument's front tile `(maxRow + 1, minCol + floor((w-1)/2))` is a
  required tile in generation (it is where a POI chest stands).
- **Placement**: `generateStructureSites(world, { styles, monuments, ... })`
  — ruin pass unchanged (counts ruins only), then a monument pass with its own
  seed XOR and target `min(6, floor(area / 1500))`. `siteFits` checks
  `style.biomes.includes(region)` instead of the one-style-per-biome map.
  `validSites` validates monuments against the monument catalog.
- **Art gate** (spec): `ensureStructures` places NEW monuments only of types
  whose sprite has an approved image; kept monuments are validated against
  the full catalog (an art change never moves a placed monument).
- **POI**: `isPoiRuin` reads poiChance from either catalog; the chest stands
  on the front tile; the pack is drawn from cells around the footprint, never
  on it.
- **Creatures**: `creatureTileCandidates` refuses monument cells.
- **Client**: `collectDecorations` skips `hidden` entries; an anchor is drawn
  at a world point on the footprint's screen-vertical axis whose depth equals
  the front cell's, so it sorts like an object standing on that cell.

## Known limit

A monument whose anchor chunk is not loaded is invisible while its other
cells block. Chunks stream a radius around the player wider than the screen,
so this needs a monument straddling the streaming edge; accepted.

## Tests (first)

1. mapService: footprint entries per chunk, anchor exactly once across a
   seam, hidden elsewhere; no other decoration on a footprint cell; emitted
   with empty defs.
2. navigability: a monument wall across a corridor seals in the terrain pass.
3. structureSites: monuments placed only in their biomes, deterministic,
   adding monuments never moves a ruin, idempotent with keep, front tile
   reachable.
4. collision parity: authority blocked set == /chunk blocking entries for a
   monument across a seam (no defs).
5. client: hidden entries not drawn; anchor drawable x/y/depth.
6. ruinChests DB: POI monument gets a chest on its front tile, pack off the
   footprint.

## Rollout

migrate none (jsonb) → seed-catalogs → art (provider 5, inspect, approve,
export to seeds/textures) → seed-structures → restart → browser screenshots.
